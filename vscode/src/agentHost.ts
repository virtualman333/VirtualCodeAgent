/**
 * AgentHost - 扩展侧 RPC 桥接层
 *
 * 复用核心引擎 (AgentSession / runAgentForWeb)，把流式事件
 * 通过 emit 回调发送到 Webview。
 */
import { AgentSession } from "../../src/agent/session.js";
import type { WebEvent } from "../../src/agent/web_runner.js";
import { VSCODE_TOOLS } from "./vscodeTools.js";

export class AgentHost {
  private session: AgentSession;
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

    // VS Code 专属工具仅在此入口注入 (浏览器/CLI 不包含)
    this.session = new AgentSession(workspaceDir, VSCODE_TOOLS);

    // 上报当前工作空间 (前端侧边栏显示 + 扩展侧记录)
    this.emitWrapped({ type: "workspace", path: this.session.state.workspace_dir });
    // 上报模型列表 + 当前模型
    this.emitWrapped({ type: "models", models: this.session.getModels(), current: this.session.modelName });
    this.emitWrapped({ type: "model", name: this.session.modelName });
  }

  get workspaceDir(): string {
    return this.session.state.workspace_dir;
  }

  /** 工作空间变化回调 (扩展侧监听) */
  onWorkspace: ((dir: string) => void) | null = null;

  /** 取消当前任务 (面板销毁时调用) */
  cancel(): void {
    this.session.cancel();
  }

  /**
   * 从扩展侧注入用户消息 (如"发送选中文本到 Agent")。
   * 前端收到 external 事件后作为用户消息发送。
   */
  externalInput(content: string): void {
    const text = String(content ?? "").trim();
    if (!text) return;
    this.rawEmit({ type: "external", content: text });
  }

  /** 处理来自 Webview 的 RPC 消息 */
  async handle(payload: Record<string, unknown>): Promise<void> {
    const type = String(payload.type ?? "");
    try {
      switch (type) {
        case "chat": {
          const content = String(payload.content ?? "").trim();
          if (content) await this.session.chat(content, this.emitWrapped);
          break;
        }
        case "answer": {
          const content = String(payload.content ?? "").trim();
          this.session.answer(content ? `用户回答: ${content}` : "[用户选择跳过]");
          break;
        }
        case "answer_option": {
          const option = String(payload.content ?? "").trim();
          this.session.answer(option ? `用户选择了: ${option}` : "[用户选择跳过]");
          break;
        }
        case "skip_question":
          this.session.answer("[用户选择跳过]");
          break;
        case "cancel":
          this.session.cancel();
          break;
        case "ping":
          this.emitWrapped({ type: "info", text: "pong" });
          break;
        case "set_model": {
          const name = String(payload.name ?? "");
          if (this.session.setModel(name)) {
            this.emitWrapped({ type: "model", name: this.session.modelName });
            this.emitWrapped({ type: "info", text: `已切换模型: ${this.session.modelName}` });
          } else {
            this.emitWrapped({ type: "info", text: `未找到模型: ${name}` });
          }
          break;
        }
        case "get_models": {
          this.emitWrapped({
            type: "models",
            models: this.session.getModels(),
            current: this.session.modelName,
          });
          break;
        }
        case "workspace": {
          const dir = String(payload.path ?? "");
          if (dir) {
            const ok = this.session.setWorkspace(dir);
            if (ok) {
              this.emitWrapped({ type: "workspace", path: this.session.state.workspace_dir });
              this.emitWrapped({ type: "info", text: `已切换工作空间: ${this.session.state.workspace_dir}` });
            } else {
              this.emitWrapped({ type: "info", text: `切换失败: ${dir}` });
            }
          }
          break;
        }
        default:
          this.emitWrapped({ type: "info", text: `未知消息类型: ${type}` });
      }
    } catch (e) {
      this.emitWrapped({ type: "info", text: `[ERROR] ${(e as Error).message}` });
    }
  }
}
