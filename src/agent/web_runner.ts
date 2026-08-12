/**
 * Web 版 Agent 运行器 - 复用 CodingAgent，将流式事件通过回调发送到前端
 *
 * 事件类型:
 * - running:     任务开始/结束 (value: boolean)
 * - thinking:    Agent 深度思考内容
 * - tool_call:   工具调用 (含 serverId 用于前端关联结果)
 * - tool_result: 工具执行结果
 * - plan:        todo_* 工具返回的计划文本
 * - final:       最终回答
 * - ask_user:    需要用户回答 (server 层负责等待 answer)
 * - usage:       本轮任务 Token 汇总
 * - info:        提示信息
 */
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type MessageContent,
} from "@langchain/core/messages";

import type { AgentState, PendingQuestion } from "./state.js";
import type { CodingAgent } from "./graph.js";

export interface WebEvent {
  type: "thinking" | "tool_call" | "tool_result" | "plan" | "final" | "ask_user" | "usage" | "info" | "running" | "workspace" | "external" | "model" | "models" | "context" | "enhance_presets" | "enhance_result" | "session_id" | "session_list" | "session_created" | "session_closed";
  /** 事件所属会话 (多 tab 路由) */
  sessionId?: string;
  [key: string]: unknown;
}

export interface RunOptions {
  agent: CodingAgent;
  state: AgentState;
  userInput: string;
  /** 用户附带的图片 (data URL 数组) */
  images?: string[];
  send: (event: WebEvent) => void;
  /** 等待用户对 ask_user 的回答; 返回 null 表示取消 */
  waitAnswer: (pending: PendingQuestion) => Promise<string | null>;
  /** 是否被取消 (外部设置为 true 时安全停止) */
  isCancelled: () => boolean;
}

/** 构造用户消息 content (文本 + 图片多模态) */
export function buildUserContent(text: string, images: string[] = []): MessageContent {
  if (!images || images.length === 0) return text;
  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  if (text) parts.push({ type: "text", text });
  for (const img of images) {
    parts.push({ type: "image_url", image_url: { url: img } });
  }
  return parts as unknown as MessageContent;
}

function truncateForWeb(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 200)}\n\n... (输出共 ${text.length} 字符, 中间已省略) ...\n\n${text.slice(-200)}`;
}

export async function runAgentForWeb(opts: RunOptions): Promise<void> {
  const { agent, state, userInput, images, send, waitAnswer, isCancelled } = opts;

  state.messages.push(
    new HumanMessage({ content: buildUserContent(userInput, images) })
  );
  state.pending_question = null;
  send({ type: "running", value: true });

  try {
    await executeLoop(opts);
  } catch (e) {
    send({ type: "info", text: `[ERROR] ${(e as Error).message}` });
  } finally {
    send({ type: "running", value: false });
  }
}

async function executeLoop(opts: RunOptions): Promise<void> {
  const { agent, state, send, waitAnswer, isCancelled } = opts;

  // 外层循环: 处理 ask_user 暂停/恢复
  while (true) {
    let toolCount = 0;
    let sumInput = 0;
    let sumOutput = 0;
    let sumTotal = 0;
    let sumLlmMs = 0;
    let sumToolMs = 0;
    // tc.id (LLM 生成的) → serverId (发给前端关联)
    const callIdMap = new Map<string, string>();
    let callSeq = 0;
    let cancelled = false;

    try {
      for await (const step of agent.stream(state)) {
        if (isCancelled()) {
          cancelled = true;
          break;
        }

        for (const [nodeName, nodeOutput] of Object.entries(step)) {
          if (nodeName === "agent") {
            for (const msg of nodeOutput.messages ?? []) {
              if (!(msg instanceof AIMessage)) continue;
              const content = String(msg.content ?? "");
              if (content.trim()) {
                send({ type: "thinking", content });
              }
              for (const tc of msg.tool_calls ?? []) {
                callSeq += 1;
                const serverId = `tc_${callSeq}`;
                if (tc.id) callIdMap.set(tc.id, serverId);
                send({
                  type: "tool_call",
                  serverId,
                  name: tc.name,
                  args: tc.args ?? {},
                });
              }
              // 同步回 state (LangGraph stream 不写回外部 dict)
              state.messages.push(msg);
            }
            const usage = nodeOutput.llm_usage;
            if (usage) {
              sumInput += usage.input_tokens ?? 0;
              sumOutput += usage.output_tokens ?? 0;
              sumTotal += usage.total_tokens ?? 0;
              sumLlmMs += usage.duration_ms ?? 0;
            }
          } else if (nodeName === "tools") {
            for (const msg of nodeOutput.messages ?? []) {
              if (!(msg instanceof ToolMessage)) continue;
              if (msg.content !== "[AWAITING_USER_INPUT]") toolCount += 1;
              state.messages.push(msg);

              const name = msg.name ?? "";
              const content = String(msg.content ?? "");
              if (name.startsWith("todo_")) {
                send({ type: "plan", content });
              } else {
                const serverId = callIdMap.get(msg.tool_call_id) ?? `tc_${name}`;
                send({
                  type: "tool_result",
                  serverId,
                  name,
                  content: truncateForWeb(content),
                });
              }
            }
            if (nodeOutput.tool_usage) {
              sumToolMs += nodeOutput.tool_usage.duration_ms ?? 0;
            }
          } else if (nodeName === "ask_user") {
            const pq = nodeOutput.pending_question as PendingQuestion | null;
            if (pq) {
              state.pending_question = pq;
              send({
                type: "ask_user",
                header: pq.header,
                question: pq.question,
                options: pq.options,
                is_multi: pq.is_multi,
              });
            }
          } else if (nodeName === "respond") {
            const final = String(nodeOutput.final_response ?? "");
            if (final && !state.pending_question) {
              send({ type: "final", content: final });
            }
          }
        }
        if (state.pending_question) break;
      }
    } catch (e) {
      send({ type: "info", text: `[ERROR] ${(e as Error).message}` });
      return;
    }

    if (cancelled) {
      send({ type: "info", text: "任务已被用户取消" });
      return;
    }

    // Token 汇总
    if (sumTotal > 0 || toolCount > 0) {
      send({
        type: "usage",
        input_tokens: sumInput,
        output_tokens: sumOutput,
        total_tokens: sumTotal,
        tool_count: toolCount,
        llm_duration_ms: sumLlmMs,
        tool_duration_ms: sumToolMs,
      });
    }

    // ask_user 挂起 → 等待用户回答
    const pending = state.pending_question;
    if (!pending) return;

    const answer = await waitAnswer(pending);
    if (isCancelled()) {
      send({ type: "info", text: "任务已被用户取消" });
      return;
    }
    if (answer === null) {
      state.pending_question = null;
      send({ type: "info", text: "用户取消了提问" });
      return;
    }

    state.messages.push(
      new ToolMessage({
        content: answer,
        tool_call_id: pending.tool_call_id,
        name: "ask_user",
      })
    );
    state.pending_question = null;
  }
}
