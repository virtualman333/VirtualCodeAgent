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
import { Config } from "../config.js";
import { setWorkspace } from "../workspace_ctx.js";

export class AgentSession {
  state: AgentState;
  private waitingResolve: ((answer: string | null) => void) | null = null;
  private cancelled = false;
  private running = false;

  constructor(workspaceDir: string) {
    this.state = createInitialState(workspaceDir);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * 运行一轮 Agent 任务。流式事件通过 emit 回调发出。
   * ask_user 挂起时等待 answer()/cancel() 后自动恢复。
   */
  async chat(content: string, emit: (e: WebEvent) => void): Promise<void> {
    if (this.running) {
      emit({ type: "info", text: "Agent 正在执行中，请稍候" });
      return;
    }
    this.running = true;
    this.cancelled = false;
    this.waitingResolve = null;

    try {
      const agent = await createCodingAgent();
      emit({ type: "info", text: "任务开始执行..." });
      await runAgentForWeb({
        agent,
        state: this.state,
        userInput: content,
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
