/**
 * AgentHost - 扩展侧 RPC 桥接层 (多会话)
 *
 * 复用核心引擎 (AgentSession / runAgentForWeb)，把流式事件
 * 通过 emit 回调发送到 Webview。
 * 支持多个独立会话 (多 tab 并行执行)。
 */
import { AgentSession } from "../../src/agent/session.js";
import type { WebEvent } from "../../src/agent/web_runner.js";
import {
  getSettingsView,
  saveGeneralSettings,
  saveMcpConfig,
  reconnectMcp,
  reloadConfig,
} from "../../src/settings.js";
import { VSCODE_TOOLS } from "./vscodeTools.js";

export class AgentHost {
  private sessions = new Map<string, AgentSession>();
  private rawEmit: (e: WebEvent) => void;
  private emitWrapped: (e: WebEvent) => void;

  constructor(
    workspaceDir: string,
    emit: (e: WebEvent) => void,
    private onRunningChange?: (running: boolean) => void
  ) {
    this.rawEmit = emit;
    // 包装 emit: 拦截 running 事件回调状态变化，并上报工作空间
    this.emitWrapped = (e: WebEvent) => {
      if (e.type === "running") {
        this.onRunningChange?.(Boolean(e.value));
      }
      if (e.type === "workspace") {
        this.onWorkspace?.(String(e.path ?? ""));
      }
      this.rawEmit(e);
    };

    // 连接即创建首个会话 (默认 tab)
    const first = this.createSession(workspaceDir);
    this.emitWrapped({ type: "workspace", path: first.state.workspace_dir });
    this.emitWrapped({ type: "models", models: first.getModels(), current: first.modelName });
    this.emitWrapped({ type: "model", name: first.modelName });
    this.emitWrapped({ type: "context", ...first.getContextInfo() });
    this.emitWrapped({ type: "session_id", id: first.id });
  }

  get workspaceDir(): string {
    const first = [...this.sessions.values()][0];
    return first?.state.workspace_dir ?? "";
  }

  /** 工作空间变化回调 (扩展侧监听) */
  onWorkspace: ((dir: string) => void) | null = null;

  /** 取消所有会话任务 (面板销毁时调用) */
  cancel(): void {
    for (const s of this.sessions.values()) s.cancel();
  }

  /**
   * 从扩展侧注入用户消息 (如"发送选中文本到 Agent")。
   * 发送到当前(首个)会话。
   */
  externalInput(content: string): void {
    const text = String(content ?? "").trim();
    if (!text) return;
    const first = [...this.sessions.values()][0];
    if (first) {
      this.rawEmit({ type: "external", content: text, sessionId: first.id });
    }
  }

  private createSession(workspaceDir: string, id?: string): AgentSession {
    const s = new AgentSession(workspaceDir, VSCODE_TOOLS, id);
    this.sessions.set(s.id, s);
    return s;
  }

  private getSession(payload: Record<string, unknown>): AgentSession | null {
    const sid = String(payload.session_id ?? "");
    return this.sessions.get(sid) ?? null;
  }

  /** 处理来自 Webview 的 RPC 消息 */
  async handle(payload: Record<string, unknown>): Promise<void> {
    const type = String(payload.type ?? "");
    try {
      // ---- 初始化握手: 前端 webview 就绪后主动拉取初始状态 ----
      // (扩展侧构造时同步 emit 的事件可能因 webview 尚未加载而丢失)
      if (type === "init") {
        const s = [...this.sessions.values()][0];
        if (s) {
          this.emitWrapped({ type: "session_id", id: s.id, sessionId: s.id });
          this.emitWrapped({ type: "workspace", path: s.state.workspace_dir, sessionId: s.id });
          this.emitWrapped({ type: "models", models: s.getModels(), current: s.modelName, sessionId: s.id });
          this.emitWrapped({ type: "model", name: s.modelName, sessionId: s.id });
          this.emitWrapped({ type: "context", ...s.getContextInfo(), sessionId: s.id });
        }
        return;
      }

      // ---- 会话管理 ----
      if (type === "new_session") {
        const s = this.createSession(this.workspaceDir);
        this.emitWrapped({ type: "session_created", id: s.id, title: s.title, sessionId: s.id });
        this.emitWrapped({ type: "workspace", path: s.state.workspace_dir, sessionId: s.id });
        this.emitWrapped({ type: "models", models: s.getModels(), current: s.modelName, sessionId: s.id });
        this.emitWrapped({ type: "model", name: s.modelName, sessionId: s.id });
        this.emitWrapped({ type: "context", ...s.getContextInfo(), sessionId: s.id });
        return;
      }
      if (type === "close_session") {
        const s = this.getSession(payload);
        if (s) {
          s.cancel();
          this.sessions.delete(s.id);
          this.emitWrapped({ type: "session_closed", id: s.id, sessionId: s.id });
        }
        return;
      }

      // ---- 设置 (全局, 用首个会话 emit) ----
      const targetId = [...this.sessions.values()][0]?.id ?? "";
      const emitGlobal = (e: WebEvent): void => this.emitWrapped({ ...e, sessionId: targetId });

      if (type === "get_settings") {
        emitGlobal({ type: "settings", settings: getSettingsView() });
        return;
      }
      if (type === "save_general_settings") {
        const result = saveGeneralSettings((payload.updates as Record<string, unknown>) ?? {});
        emitGlobal({
          type: "settings_result",
          section: "general",
          ok: result.ok,
          error: result.error,
          settings: getSettingsView(),
        });
        return;
      }
      if (type === "save_mcp_config") {
        const servers = Array.isArray(payload.servers) ? payload.servers : [];
        const result = saveMcpConfig(servers as Parameters<typeof saveMcpConfig>[0]);
        if (result.ok) {
          const status = await reconnectMcp();
          emitGlobal({ type: "settings_result", section: "mcp", ok: true, mcp_status: status, settings: getSettingsView() });
        } else {
          emitGlobal({ type: "settings_result", section: "mcp", ok: false, error: result.error });
        }
        return;
      }
      if (type === "reconnect_mcp") {
        const status = await reconnectMcp();
        emitGlobal({ type: "settings_result", section: "mcp", ok: true, mcp_status: status, settings: getSettingsView() });
        return;
      }
      if (type === "reload_config") {
        const result = reloadConfig();
        emitGlobal({
          type: "settings_result",
          section: "config",
          ok: result.ok,
          error: result.error,
          settings: result.ok ? getSettingsView() : undefined,
        });
        return;
      }

      const session = this.getSession(payload);
      if (!session) return;
      const emit = (e: WebEvent): void => this.emitWrapped({ ...e, sessionId: session.id });

      switch (type) {
        case "chat": {
          const content = String(payload.content ?? "").trim();
          const images = Array.isArray(payload.images)
            ? (payload.images as unknown[]).filter((x): x is string => typeof x === "string")
            : [];
          if (content || images.length > 0) await session.chat(content, images, emit);
          break;
        }
        case "answer": {
          const content = String(payload.content ?? "").trim();
          session.answer(content ? `用户回答: ${content}` : "[用户选择跳过]");
          break;
        }
        case "answer_option": {
          const option = String(payload.content ?? "").trim();
          session.answer(option ? `用户选择了: ${option}` : "[用户选择跳过]");
          break;
        }
        case "skip_question":
          session.answer("[用户选择跳过]");
          break;
        case "cancel":
          session.cancel();
          break;
        case "ping":
          emit({ type: "info", text: "pong" });
          break;
        case "set_model": {
          const name = String(payload.name ?? "");
          if (session.setModel(name)) {
            emit({ type: "model", name: session.modelName });
            emit({ type: "info", text: `已切换模型: ${session.modelName}` });
          } else {
            emit({ type: "info", text: `未找到模型: ${name}` });
          }
          break;
        }
        case "get_models": {
          emit({ type: "models", models: session.getModels(), current: session.modelName });
          break;
        }
        case "get_context": {
          emit({ type: "context", ...session.getContextInfo() });
          break;
        }
        case "enhance": {
          const input = String(payload.input ?? "").trim();
          if (!input) {
            emit({ type: "enhance_result", error: "输入为空" });
          } else {
            try {
              const enhanced = await session.enhanceInput(input);
              emit({ type: "enhance_result", text: enhanced });
            } catch (e) {
              emit({ type: "enhance_result", error: (e as Error).message });
            }
          }
          break;
        }
        case "workspace": {
          const dir = String(payload.path ?? "");
          if (dir) {
            const ok = session.setWorkspace(dir);
            if (ok) {
              emit({ type: "workspace", path: session.state.workspace_dir });
              emit({ type: "info", text: `已切换工作空间: ${session.state.workspace_dir}` });
            } else {
              emit({ type: "info", text: `切换失败: ${dir}` });
            }
          }
          break;
        }
        default:
          emit({ type: "info", text: `未知消息类型: ${type}` });
      }
    } catch (e) {
      this.emitWrapped({ type: "info", text: `[ERROR] ${(e as Error).message}` });
    }
  }
}
