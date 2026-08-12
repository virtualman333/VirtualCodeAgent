/**
 * VCA Coding Agent - VS Code 扩展入口
 */
import * as vscode from "vscode";
import { ChatViewProvider } from "./panel.js";

export function activate(context: vscode.ExtensionContext): void {
  console.log("[VCA] 扩展已激活");

  // 侧边栏 Webview 视图 (活动栏图标)
  const provider = new ChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // 状态栏入口
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = "$(zap) VCA";
  statusBar.tooltip = "Virtual Code Agent - 打开聊天面板";
  statusBar.command = "vca.openChat";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // 命令: 聚焦侧边栏聊天视图
  const openChat = vscode.commands.registerCommand("vca.openChat", () => {
    void vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
  });
  context.subscriptions.push(openChat);

  // 命令: 发送当前选中文本到 Agent
  const sendSelection = vscode.commands.registerCommand("vca.sendSelection", () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("没有打开的编辑器");
      return;
    }
    const text = editor.document.getText(editor.selection);
    if (!text.trim()) {
      vscode.window.showInformationMessage("请先在编辑器中选中文本");
      return;
    }
    const filePath = editor.document.uri.fsPath;
    const line = editor.selection.start.line + 1;
    const content = `分析选中的代码:\n\`\`\`\n${text}\n\`\`\`\n(来源: ${filePath}:${line})`;

    const p = ChatViewProvider.currentProvider;
    if (p) {
      p.sendExternal(content);
      void vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    } else {
      void vscode.commands.executeCommand("vca.openChat");
      // provider 未创建 → 先打开视图，resolve 后通过 pendingExternal 补发
      // 延迟重试: resolveWebviewView 中会消费 pendingExternal
      setTimeout(() => {
        ChatViewProvider.currentProvider?.sendExternal(content);
      }, 1500);
    }
  });
  context.subscriptions.push(sendSelection);
}

export function deactivate(): void {
  // 视图销毁时自动清理
}
