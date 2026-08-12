/**
 * LangGraph 工作流 - 基于 ReAct 模式的编码 Agent
 *
 * 节点:
 * - agent:   调用 LLM 决定下一步 (带工具绑定)
 * - tools:   执行工具调用 (ToolNode)
 * - ask_user:拦截 ask_user 工具，暂停等待用户回答
 * - respond: 提取最终回复
 *
 * 路由: agent → (tools | ask_user | respond)
 */
import { StateGraph, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import { StateAnnotation, type AgentState, type LlmUsage } from "./state.js";
import { buildSystemPrompt } from "./prompts.js";
import { Config, type ModelConfig } from "../config.js";
import { ALL_TOOLS, EXECUTABLE_TOOLS } from "../tools/index.js";
import { mcpManager } from "../mcp/manager.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { setWorkspace } from "../workspace_ctx.js";

// ============================================================
// 系统提示词
// ============================================================

export function makeSystemPrompt(workspaceDir: string): string {
  return buildSystemPrompt(workspaceDir);
}

// ============================================================
// 上下文裁剪 (滑动窗口 + LLM 语义摘要)
// ============================================================

const CHARS_PER_TOKEN = 2.5;

function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / CHARS_PER_TOKEN));
}

function messageTokens(msg: BaseMessage): number {
  let base = estimateTokens(String(msg.content ?? ""));
  if (msg instanceof ToolMessage) {
    base += 20;
  } else if (msg instanceof AIMessage && msg.tool_calls?.length) {
    base += estimateTokens(JSON.stringify(msg.tool_calls)) + 50;
  }
  return base;
}

export function extractUsage(response: AIMessage): LlmUsage {
  const um = (
    response as unknown as {
      usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    }
  ).usage_metadata;
  if (um && (um.total_tokens || um.input_tokens)) {
    return {
      input_tokens: um.input_tokens ?? 0,
      output_tokens: um.output_tokens ?? 0,
      total_tokens: um.total_tokens ?? 0,
      duration_ms: 0,
    };
  }
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0, duration_ms: 0 };
}

function messagesToText(messages: BaseMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    let role = msg.constructor.name.replace("Message", "");
    const roleZh: Record<string, string> = { Human: "用户", AI: "Agent", Tool: "工具", System: "系统" };
    role = roleZh[role] ?? role;

    let content = String(msg.content ?? "");
    if (msg instanceof ToolMessage) {
      const name = msg.name ?? "";
      if (content.length > 400) content = content.slice(0, 400) + "...(截断)";
      lines.push(`[${role}:${name}] ${content}`);
    } else if (msg instanceof AIMessage && msg.tool_calls?.length) {
      const tools = msg.tool_calls.map((tc) => tc.name).join(", ");
      if (content.trim()) {
        lines.push(`[${role}] ${content.slice(0, 200)} → 调用工具: ${tools}`);
      } else {
        lines.push(`[${role}] 调用工具: ${tools}`);
      }
    } else {
      if (content.length > 300) content = content.slice(0, 300) + "...(截断)";
      lines.push(`[${role}] ${content}`);
    }
  }
  return lines.join("\n");
}

async function summarizeHistory(
  dropped: BaseMessage[],
  priorSummary: string,
  summaryLlm: ChatOpenAI
): Promise<string> {
  let transcript = messagesToText(dropped);
  if (estimateTokens(transcript) > 15000) {
    transcript = transcript.slice(0, 15000 * 3);
  }

  const prompt = `请用中文对以下对话历史生成一段简洁的语义摘要。

规则:
- 提取关键信息: 用户问了什么，你做了什么，产生了什么结果
- 保留具体的文件名、路径、命令等关键参数
- 忽略工具执行的冗长原始输出，只提炼结论
- 控制在 300 字以内
- 如果已有之前的摘要，请合并

${priorSummary}

--- 需要摘要的对话 ---
${transcript}
--- 结束 ---

请直接输出摘要，不要加 "以下是摘要" 等前缀。`;

  try {
    const response = await summaryLlm.invoke(prompt);
    return String(response.content ?? "").trim();
  } catch (e) {
    console.log(`[VCA] LLM 摘要生成失败 (${(e as Error).constructor.name})，使用规则提取替代`);
    const parts: string[] = [];
    for (const msg of dropped) {
      if (msg instanceof HumanMessage) {
        parts.push(`用户: ${String(msg.content).slice(0, 80)}`);
      } else if (msg instanceof AIMessage && !msg.tool_calls?.length && msg.content) {
        parts.push(`Agent: ${String(msg.content).slice(0, 120)}`);
      }
    }
    return parts.slice(0, 20).join("\n");
  }
}

interface TrimResult {
  messages: BaseMessage[];
  summary_history: string;
}

async function trimContext(
  state: AgentState,
  messages: BaseMessage[],
  maxTokens: number,
  keepTurns: number,
  summaryLlm: ChatOpenAI
): Promise<TrimResult> {
  const sysMsg = messages.length > 0 && messages[0] instanceof SystemMessage ? messages[0] : null;
  let body = sysMsg ? messages.slice(1) : [...messages];
  if (body.length === 0) return { messages, summary_history: state.summary_history };

  // Step 1: 压缩长工具结果 (>15000 字符, 保留头尾)
  body = body.map((msg) => {
    if (msg instanceof ToolMessage && String(msg.content ?? "").length > 15000) {
      const content = String(msg.content);
      const head = content.slice(0, 12000);
      const tail = content.slice(-3000);
      return new ToolMessage({
        content: `${head}\n\n... (原始输出 ${content.length} 字符, 中间已省略) ...\n\n${tail}`,
        tool_call_id: msg.tool_call_id,
        name: msg.name,
      });
    }
    return msg;
  });

  const prior = state.summary_history ?? "";
  let total = (sysMsg ? messageTokens(sysMsg) : 0) + body.reduce((s, m) => s + messageTokens(m), 0);
  if (prior) total += estimateTokens(prior);

  const insertSummary = (msgs: BaseMessage[]): BaseMessage[] => {
    if (!prior) return msgs;
    return [new SystemMessage({ content: `📋 [历史摘要]\n${prior}` }), ...msgs];
  };

  if (total <= maxTokens) {
    return { messages: insertSummary(sysMsg ? [sysMsg, ...body] : body), summary_history: prior };
  }

  // Step 2: 按用户轮次裁剪
  const turnBoundaries: number[] = [];
  body.forEach((msg, i) => {
    if (msg instanceof HumanMessage) turnBoundaries.push(i);
  });

  if (turnBoundaries.length <= keepTurns) {
    // 轮次不多 → 说明是工具结果太大，激进压缩 (仍保留头尾)
    body = body.map((msg) => {
      if (msg instanceof ToolMessage && String(msg.content ?? "").length > 8000) {
        const content = String(msg.content);
        const head = content.slice(0, 6000);
        const tail = content.slice(-2000);
        return new ToolMessage({
          content: `${head}\n\n... (原始输出 ${content.length} 字符, 中间已省略) ...\n\n${tail}`,
          tool_call_id: msg.tool_call_id,
          name: msg.name,
        });
      }
      return msg;
    });
    return { messages: insertSummary(sysMsg ? [sysMsg, ...body] : body), summary_history: prior };
  }

  // 保留最后 keepTurns 轮
  const trimIdx = turnBoundaries[turnBoundaries.length - keepTurns];
  const dropped = body.slice(0, trimIdx);
  const kept = body.slice(trimIdx);

  // Step 3: LLM 生成语义摘要并累积
  const newSummary = await summarizeHistory(dropped, prior, summaryLlm);
  const summaryMsg = new SystemMessage({ content: `📋 [历史摘要]\n${newSummary}` });
  const result = sysMsg ? [sysMsg, summaryMsg, ...kept] : [summaryMsg, ...kept];

  return { messages: result, summary_history: newSummary };
}

// ============================================================
// 节点定义
// ============================================================

type RouteTarget = "tools" | "ask_user" | "respond";

function shouldContinue(state: AgentState): RouteTarget {
  const last = state.messages[state.messages.length - 1];
  if (last instanceof AIMessage && last.tool_calls?.length) {
    if (last.tool_calls.some((tc) => tc.name === "ask_user")) return "ask_user";
    return "tools";
  }
  return "respond";
}

// ============================================================
// CodingAgent
// ============================================================

export class CodingAgent {
  llm: ChatOpenAI;
  summaryLlm: ChatOpenAI;
  llmWithTools: ReturnType<ChatOpenAI["bindTools"]>;
  executableToolNode: ToolNode;
  graph: ReturnType<typeof buildGraph>;
  workspace_dir = "";
  allTools: StructuredToolInterface[];
  mcpTools: StructuredToolInterface[];
  modelConfig: ModelConfig;

  constructor(
    modelConfig: ModelConfig,
    mcpTools: StructuredToolInterface[] = [],
    extraTools: StructuredToolInterface[] = []
  ) {
    this.modelConfig = modelConfig;
    Config.validate();

    const { model, base_url, api_key } = modelConfig;

    this.llm = new ChatOpenAI({
      model,
      apiKey: api_key,
      configuration: { baseURL: base_url },
      temperature: 0.2,
    });

    this.summaryLlm = new ChatOpenAI({
      model,
      apiKey: api_key,
      configuration: { baseURL: base_url },
      temperature: 0.0,
    });

    // 动态工具池: 内置 + Skills + MCP + 环境专属工具 (如 VS Code API)
    this.mcpTools = mcpTools;
    this.allTools = [...ALL_TOOLS, ...mcpTools, ...extraTools];
    const executable = [...EXECUTABLE_TOOLS, ...mcpTools, ...extraTools];

    this.llmWithTools = this.llm.bindTools(this.allTools);
    this.executableToolNode = new ToolNode(executable);
    this.graph = buildGraph(this);
  }

  /**
   * 流式运行，返回异步生成器 (streamMode: updates)
   * 每个元素: { nodeName: partialState }
   */
  async *stream(state: AgentState): AsyncGenerator<Record<string, Partial<AgentState>>> {
    const updates = await this.graph.stream(
      state as unknown as typeof StateAnnotation.State,
      { streamMode: "updates" }
    );
    for await (const step of updates) {
      yield step as unknown as Record<string, Partial<AgentState>>;
    }
  }

  async invoke(state: AgentState): Promise<AgentState> {
    const result = await this.graph.invoke(
      state as unknown as typeof StateAnnotation.State
    );
    return result as unknown as AgentState;
  }
}

export function buildGraph(agent: CodingAgent) {
  // agent 节点
  const agentNode = async (state: AgentState): Promise<Partial<AgentState>> => {
    const workspace = state.workspace_dir;
    agent.workspace_dir = workspace;
    setWorkspace(workspace);

    let messages = state.messages;
    if (messages.length === 0 || !(messages[0] instanceof SystemMessage)) {
      messages = [new SystemMessage({ content: makeSystemPrompt(workspace) }), ...messages];
    }

    // 上下文裁剪 (含 LLM 摘要)
    const trimmed = await trimContext(
      state,
      messages,
      Config.MAX_CONTEXT_TOKENS,
      8,
      agent.summaryLlm
    );

    const start = performance.now();
    const response = await agent.llmWithTools.invoke(trimmed.messages);
    const elapsedMs = performance.now() - start;

    const usage = extractUsage(response);
    usage.duration_ms = elapsedMs;

    return {
      messages: [response],
      llm_usage: usage,
      summary_history: trimmed.summary_history,
    };
  };

  // tools 节点 (记录耗时)
  const toolNode = async (state: AgentState): Promise<Partial<AgentState>> => {
    const ws = state.workspace_dir;
    if (ws) {
      agent.workspace_dir = ws;
      setWorkspace(ws);
    }

    const start = performance.now();
    const result = await agent.executableToolNode.invoke(state);
    const elapsedMs = performance.now() - start;

    const toolCount = result.messages.filter((m: BaseMessage) => m instanceof ToolMessage).length;
    return {
      messages: result.messages,
      tool_usage: { count: toolCount, duration_ms: elapsedMs },
    };
  };

  // ask_user 节点
  const askUserNode = (state: AgentState): Partial<AgentState> => {
    const last = state.messages[state.messages.length - 1];
    if (!(last instanceof AIMessage) || !last.tool_calls) {
      return { pending_question: null };
    }

    for (const tc of last.tool_calls) {
      if (tc.name !== "ask_user") continue;

      const args = (tc.args ?? {}) as Record<string, unknown>;
      const question = String(args.question ?? "");
      const header = String(args.header ?? "确认");
      let optionsRaw = String(args.options ?? "").trim();

      let isMulti = false;
      if (optionsRaw.startsWith("[可多选]") || optionsRaw.startsWith("[多选]")) {
        isMulti = true;
        optionsRaw = optionsRaw.split("]")[1].trim();
      } else if (optionsRaw.startsWith("[multi]")) {
        isMulti = true;
        optionsRaw = optionsRaw.slice(7).trim();
      }

      const optionList = optionsRaw
        .split("|")
        .map((o) => o.trim())
        .filter(Boolean);

      return {
        pending_question: {
          header,
          question,
          options: optionList,
          is_multi: isMulti,
          tool_call_id: tc.id ?? "",
        },
        // 占位 ToolMessage, 让图能继续流转到 respond
        messages: [
          new ToolMessage({
            content: "[AWAITING_USER_INPUT]",
            tool_call_id: tc.id ?? "",
            name: "ask_user",
          }),
        ],
      };
    }
    return { pending_question: null };
  };

  // respond 节点
  const respondNode = (state: AgentState): Partial<AgentState> => {
    const last = state.messages[state.messages.length - 1];
    let finalText = "";
    if (last instanceof AIMessage) {
      finalText = String(last.content ?? "") || "(空响应)";
    }
    return { final_response: finalText, iteration: state.iteration + 1 };
  };

  // 构建图 (LangGraph 类型累积式 builder: 每次调用返回带节点类型的新实例)
  const workflow = new StateGraph(StateAnnotation)
    .addNode({
      agent: agentNode,
      tools: toolNode,
      ask_user: askUserNode,
      respond: respondNode,
    })
    .addEdge(START, "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      ask_user: "ask_user",
      respond: "respond",
    })
    .addEdge("tools", "agent")
    .addEdge("ask_user", "respond")
    .addEdge("respond", END);

  return workflow.compile();
}

let cachedMcpTools: StructuredToolInterface[] | null = null;
let connectingMcp: Promise<StructuredToolInterface[]> | null = null;

/** 连接 MCP (仅一次, 缓存工具列表) */
async function connectMcpOnce(): Promise<StructuredToolInterface[]> {
  if (cachedMcpTools) return cachedMcpTools;
  if (!connectingMcp) {
    connectingMcp = (async () => {
      try {
        await mcpManager.connect();
      } catch (e) {
        console.log(`[VCA] MCP 连接失败: ${(e as Error).message}`);
      }
      cachedMcpTools = mcpManager.tools;
      return cachedMcpTools;
    })();
  }
  return connectingMcp;
}

export async function createCodingAgent(
  modelName?: string | null,
  extraTools: StructuredToolInterface[] = []
): Promise<CodingAgent> {
  Config.validate();
  const mcpTools = await connectMcpOnce();
  const modelConfig = Config.getModelConfig(modelName ?? null);
  return new CodingAgent(modelConfig, mcpTools, extraTools);
}
