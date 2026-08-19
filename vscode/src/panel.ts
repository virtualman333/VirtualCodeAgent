/**
 * ChatViewProvider - VS Code 侧边栏 Webview 视图
 *
 * 活动栏点击 VCA 图标 → 侧边栏打开聊天面板。
 * 加载 web/dist (Vue 构建产物) 作为聊天 UI，
 * 通过 postMessage RPC 与 AgentHost 通信。
 */
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import { AgentHost } from "./agentHost.js";
import type { WebEvent } from "../../src/agent/web_runner.js";

/** web/dist 目录 (构建时已复制到 vscode/dist/web, 扩展包自包含) */
function getWebDistDir(): string {
  return path.resolve(__dirname, "web");
}

/** 在 VS Code 中打开文件 (可定位到行号) */
async function openFileInVscode(filePath: string, line?: number): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (line && line > 0) {
      const ln = line - 1;
      const range = new vscode.Range(ln, 0, ln, 0);
      editor.selection = new vscode.Selection(ln, 0, ln, 0);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
  } catch {
    vscode.window.showWarningMessage(`无法打开文件: ${filePath}`);
  }
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "vca.chatView";

  /** 当前 provider 实例 (供命令访问) */
  static currentProvider: ChatViewProvider | undefined;

  private host: AgentHost | null = null;
  private currentWebview: vscode.Webview | null = null;

  /** 面板尚未打开时暂存的外部输入 (命令触发) */
  private pendingExternal: string | null = null;
  /** 最近已发送的外部输入 (幂等保护, 防止重复注入) */
  private lastExternalSent: string | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * 侧边栏视图被创建/重新显示时调用。
   * 注意: 视图隐藏后重新聚焦可能触发多次 resolve，host 需要复用保持会话状态。
   */
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    ChatViewProvider.currentProvider = this;

    const webview = webviewView.webview;
    this.currentWebview = webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(getWebDistDir())],
    };

    webview.html = this.buildHtml(webview);

    // 首次 resolve 时创建 AgentHost (复用同一会话)
    if (!this.host) {
      const workspaceDir =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
      this.host = new AgentHost(workspaceDir, (e: WebEvent) => {
        if (this.currentWebview) {
          void this.currentWebview.postMessage(e);
        }
      });
      // 工作空间变化 → 更新视图标题
      this.host.onWorkspace = (dir: string) => {
        webviewView.title = `聊天 · ${path.basename(dir)}`;
      };
    }

    webview.onDidReceiveMessage(
      async (msg) => {
        if (!msg || msg.type !== "rpc" || !msg.payload || typeof msg.payload !== "object") {
          return;
        }
        const payload = msg.payload as Record<string, unknown>;
        if (String(payload.type ?? "") === "open_file") {
          await openFileInVscode(String(payload.path ?? ""), Number(payload.line ?? 0) || undefined);
          return;
        }
        await this.host?.handle(payload);
      },
      undefined,
      this.context.subscriptions
    );

    webviewView.onDidDispose(() => {
      if (this.currentWebview === webview) {
        this.currentWebview = null;
        this.host?.cancel();
      }
    });

    // 有暂存的外部输入 → 发送给前端
    if (this.pendingExternal) {
      const content = this.pendingExternal;
      this.pendingExternal = null;
      this.lastExternalSent = content;
      setTimeout(() => this.sendToWebview({ type: "external", content }), 300);
    }
  }

  /** 向当前 webview 发送事件 (WebEvent) */
  sendToWebview(e: WebEvent): void {
    if (this.currentWebview) {
      void this.currentWebview.postMessage(e);
    }
  }

  /** 注入外部用户输入 (命令触发: 发送选中文本等)。面板未打开时暂存。 */
  sendExternal(content: string): void {
    const text = String(content ?? "").trim();
    if (!text) return;
    // 幂等: 避免命令重试与 pending 消费双重触发
    if (this.lastExternalSent === text) return;
    if (this.currentWebview) {
      this.lastExternalSent = text;
      this.sendToWebview({ type: "external", content: text });
    } else {
      this.pendingExternal = text;
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    // 前端热更新: 设置了 VCA_WEB_DEV_URL 时, webview 直接加载 Vite dev server
    const devUrl = (process.env.VCA_WEB_DEV_URL ?? "").trim().replace(/\/+$/, "");
    if (devUrl) {
      return this.buildDevHtml(devUrl);
    }

    const distDir = getWebDistDir();
    const indexPath = path.join(distDir, "index.html");
    if (!fs.existsSync(indexPath)) {
      return `<html><body style="background:#0f1117;color:#dde3ee;font-family:system-ui;padding:40px;line-height:1.8">
        <h2>VCA 前端未构建</h2>
        <p>请先执行:</p>
        <pre style="background:#1a1f2c;padding:12px;border-radius:8px">cd web && npm install && npm run build</pre>
        </body></html>`;
    }

    let html = fs.readFileSync(indexPath, "utf-8");

    // 将 /assets/ 资源引用转换为 webview URI
    html = html.replace(/(src|href)="(\/assets\/[^"]+)"/g, (_m, attr: string, rel: string) => {
      const abs = path.join(distDir, rel);
      const uri = webview.asWebviewUri(vscode.Uri.file(abs));
      return `${attr}="${uri}"`;
    });

    // CSP: 允许 webview 源 + 内联样式 (Vite 产物)
    const csp = [
      `default-src 'none'`,
      `script-src ${webview.cspSource} 'unsafe-inline'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
    ].join("; ");
    html = html.replace(
      "<head>",
      `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`
    );

    return html;
  }

  /** 前端热更新: 直接加载 Vite dev server 入口, 改 web 源码即时 HMR */
  private buildDevHtml(devUrl: string): string {
    const wsUrl = devUrl.replace(/^http/, "ws");
    const csp = [
      `default-src 'none'`,
      `script-src ${devUrl} 'unsafe-inline'`,
      `style-src ${devUrl} 'unsafe-inline'`,
      `img-src ${devUrl} data:`,
      `font-src ${devUrl} data:`,
      `connect-src ${devUrl} ${wsUrl}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>VCA - Virtual Code Agent (dev)</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="${devUrl}/@vite/client"></script>
  <script type="module" src="${devUrl}/src/main.ts"></script>
</body>
</html>`;
  }
}
