/**
 * AgentSession - 会话级封装 (Web 服务与 VS Code 扩展共用)
 *
 * 每个会话一个实例:
 * - 独立的消息状态 (AgentState)
 * - chat() 流式运行 (事件通过 emit 回调发出)
 * - ask_user 暂停等待 answer()
 * - cancel() 取消
 * - 每次运行结束自动保存会话
 */
import fs from "node:fs";
import path from "node:path";

import { createCodingAgent } from "./graph.js";
import { createInitialState, type AgentState } from "./state.js";
import { runAgentForWeb, type WebEvent } from "./web_runner.js";
import { saveSession, generateSessionId, loadSession } from "../storage.js";
import { Config, type ModelConfig } from "../config.js";
import { setWorkspace } from "../workspace_ctx.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

/**
 * 内置增强提示词: 让 LLM 将用户的粗略输入优化为
 * 结构清晰、信息完整、可直接发送给编码 Agent 的高质量提示词。
 */
const ENHANCE_SYSTEM_PROMPT = `你是一个提示词优化器。用户会给你一段粗略的请求，请将其优化为结构清晰、信息完整、可直接发送给编码 Agent 的高质量提示词。

优化规则:
1. 保留用户原始意图，不添加用户未提及的新需求
2. 补充关键上下文信息（如涉及的代码/文件、期望的输出形式）——以合理的建议方式补全，不凭空假设
3. 用简洁明确、面向编程任务的语言重写，去除口语化和模糊表达
4. 如果输入本身已经清晰完整，只需轻度润色，不要过度扩写

输出要求:
- 直接输出优化后的提示词正文
- 不要加任何前缀说明（如"已优化"）、不要用 markdown 代码块包裹`;

export class AgentSession {
  state: AgentState;
  /** 会话唯一 ID (前端 tab 用) */
  id: string;
  /** 会话标题 (自动从首条消息提取) */
  title: string;
  /** 当前使用的模型名 (对应 Config.getModels() 中的 name) */
  modelName: string;
  /** 环境专属工具 (如 VS Code API 工具，仅扩展入口注入) */
  private extraTools: StructuredToolInterface[];
  private waitingResolve: ((answer: string | null) => void) | null = null;
  private cancelled = false;
  private running = false;

  constructor(workspaceDir: string, extraTools: StructuredToolInterface[] = [], id?: string) {
    this.state = createInitialState(workspaceDir);
    this.modelName = Config.getDefaultModelName();
    this.extraTools = extraTools;
    this.id = id ?? generateSessionId();
    this.title = "新对话";
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 当前模型配置 */
  getModel(): ModelConfig {
    return Config.getModelConfig(this.modelName);
  }

  /** 所有可选模型 (供前端下拉) */
  getModels(): ModelConfig[] {
    return Config.getModels();
  }

  /** 切换模型 (返回是否成功) */
  setModel(name: string): boolean {
    const model = Config.getModelConfig(name);
    if (!model) return false;
    this.modelName = model.name;
    return true;
  }

  // ============================================================
  // 上下文统计 & 增强提示词
  // ============================================================

  /** 估算当前上下文字符数与 token 数 (不含系统提示词) */
  private estimateContext(): { chars: number; tokens: number } {
    let chars = 0;
    const messages = this.state.messages as unknown as Array<{ content: unknown }>;
    for (const m of messages) {
      const c = m.content;
      if (typeof c === "string") chars += c.length;
      else if (Array.isArray(c)) {
        for (const p of c) {
          if (typeof p === "string") chars += p.length;
          else if (p && typeof p === "object") {
            const text = (p as { text?: unknown }).text;
            if (typeof text === "string") chars += text.length;
            // 图片 part 粗略按 800 token 计
            else if ("image_url" in p) chars += 2000;
          }
        }
      }
    }
    return { chars, tokens: Math.floor(chars / 2.5) + messages.length * 20 };
  }

  /** 返回上下文窗口信息 (供前端显示) */
  getContextInfo(): { tokens: number; max_tokens: number; messages: number; pct: number } {
    const { tokens } = this.estimateContext();
    const maxTokens = Config.MAX_CONTEXT_TOKENS;
    const pct = Math.min(100, Math.round((tokens / maxTokens) * 100));
    return {
      tokens,
      max_tokens: maxTokens,
      messages: this.state.messages.length,
      pct,
    };
  }

  /**
   * 通过内置提示词 + LLM 将用户输入增强为更高质量、更完整的提示词。
   * 返回增强后的文本 (前端填入输入框)。
   */
  async enhanceInput(input: string): Promise<string> {
    if (!input.trim()) throw new Error("输入为空");
    const cfg = Config.getModelConfig(this.modelName);
    const llm = new ChatOpenAI({
      model: cfg.model,
      apiKey: cfg.api_key,
      configuration: { baseURL: cfg.base_url },
      temperature: 0.3,
    });
    const resp = await llm.invoke([
      new SystemMessage({ content: ENHANCE_SYSTEM_PROMPT }),
      new HumanMessage({ content: input }),
    ]);
    return String(resp.content ?? "").trim();
  }

  /**
   * 运行一轮 Agent 任务。流式事件通过 emit 回调发出。
   * images: 用户附带的图片 (data URL 数组, 可选)
   * ask_user 挂起时等待 answer()/cancel() 后自动恢复。
   */
  async chat(content: string, images: string[], emit: (e: WebEvent) => void): Promise<void> {
    if (this.running) {
      emit({ type: "info", text: "Agent 正在执行中，请稍候" });
      return;
    }
    this.running = true;
    this.cancelled = false;
    this.waitingResolve = null;

    try {
      const agent = await createCodingAgent(this.modelName, this.extraTools);
      emit({ type: "model", name: this.modelName });
      emit({ type: "info", text: "任务开始执行..." });
      await runAgentForWeb({
        agent,
        state: this.state,
        userInput: content,
        images: images?.length ? images : undefined,
        send: emit,
        waitAnswer: (pending) =>
          new Promise<string | null>((resolve) => {
            this.waitingResolve = resolve;
          }),
        isCancelled: () => this.cancelled,
      });
    } catch (e) {
      emit({ type: "info", text: `[ERROR] ${(e as Error).message}` });
    } finally {
      this.running = false;
      this.waitingResolve = null;
      this.autoSave();
    }
  }

  /** 回答 ask_user 提问 (content 已格式化为最终消息文本, null = 取消) */
  answer(content: string | null): void {
    const resolve = this.waitingResolve;
    if (resolve) {
      this.waitingResolve = null;
      resolve(content);
    }
  }

  cancel(): void {
    this.cancelled = true;
    const resolve = this.waitingResolve;
    if (resolve) {
      this.waitingResolve = null;
      resolve(null);
    }
  }

  /** 切换工作空间 (相对路径基于当前工作空间解析) */
  setWorkspace(dir: string): boolean {
    try {
      const abs = path.isAbsolute(dir)
        ? dir
        : path.resolve(this.state.workspace_dir, dir);
      fs.mkdirSync(abs, { recursive: true });
      this.state.workspace_dir = abs;
      setWorkspace(abs);
      return true;
    } catch {
      return false;
    }
  }

  /** 恢复指定会话 (返回恢复的消息数) */
  restore(sessionId: string): number {
    const loaded = loadSession(sessionId);
    if (!loaded) return 0;
    this.state = {
      ...createInitialState(loaded.workspace_dir || Config.WORKSPACE_DIR),
      messages: loaded.messages,
    };
    this.state.session_id = sessionId;
    if (loaded.workspace_dir) setWorkspace(loaded.workspace_dir);
    return loaded.messages.length;
  }

  private autoSave(): void {
    try {
      if (!this.state.workspace_dir) this.state.workspace_dir = Config.WORKSPACE_DIR;
      const sid = saveSession(
        this.state.session_id ?? generateSessionId(),
        this.state.messages,
        this.state.workspace_dir
      );
      this.state.session_id = sid;
    } catch {
      /* 保存失败不影响运行 */
    }
  }
}
