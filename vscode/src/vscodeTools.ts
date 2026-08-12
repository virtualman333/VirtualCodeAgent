/**
 * VS Code API 工具集 - 仅在 VS Code 扩展入口可用
 *
 * 这些工具直接调用 vscode 模块 API，让 Agent 能:
 * - 打开/切换编辑器、读取活动编辑器内容
 * - 读取选区文本、应用编辑器修改 (带撤销栈)
 * - 显示通知、执行 VS Code 命令、显示输入框
 *
 * 注意: 依赖 'vscode' 模块 (esbuild external)，只能在扩展进程运行，
 * 浏览器 (server.ts) 与 CLI (main.ts) 入口不注入这些工具。
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

// ============================================================
// 工具实现
// ============================================================

/** 打开文件 (可定位行号)，并聚焦到该编辑器 */
const openFileTool = tool(
  async ({ path: filePath, line }: { path: string; line?: number }) => {
    try {
      const uri = vscode.Uri.file(path.resolve(filePath));
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (line && line > 0) {
        const ln = line - 1;
        editor.selection = new vscode.Selection(ln, 0, ln, 0);
        editor.revealRange(new vscode.Range(ln, 0, ln, 0), vscode.TextEditorRevealType.InCenter);
      }
      const label = line ? ` (定位到第 ${line} 行)` : "";
      return `[OK] 已在编辑器中打开: ${filePath}${label}`;
    } catch (e) {
      return `[ERROR] 打开文件失败: ${(e as Error).message}`;
    }
  },
  {
    name: "vscode_open_file",
    description:
      "[VS Code] 在编辑器中打开指定文件并聚焦。可用 line 参数定位到具体行号。适合用户查看修改结果、导航到代码位置。",
    schema: z.object({
      path: z.string().describe("要打开的文件的绝对或相对路径"),
      line: z.number().int().positive().optional().describe("定位到的行号 (1-based)"),
    }),
  }
);

/** 读取当前活动编辑器内容 (可只读部分行) */
const readActiveEditorTool = tool(
  async ({ start_line, end_line }: { start_line?: number; end_line?: number }) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return "[ERROR] 没有活动编辑器";
    const doc = editor.document;
    const totalLines = doc.lineCount;

    let start = start_line && start_line > 0 ? start_line - 1 : 0;
    let end = end_line ? Math.min(end_line - 1, totalLines - 1) : totalLines - 1;
    if (start > end) [start, end] = [end, start];

    const lines: string[] = [];
    for (let i = start; i <= end && i < totalLines; i++) {
      lines.push(`${String(i + 1).padStart(6)}|${doc.lineAt(i).text}`);
    }
    const fname = path.basename(doc.uri.fsPath || "(未保存)");
    return `[OK] 活动编辑器: ${fname} (L${start + 1}-${end + 1} / 共 ${totalLines} 行)\n${lines.join("\n")}`;
  },
  {
    name: "vscode_read_active_editor",
    description:
      "[VS Code] 读取当前活动编辑器中打开的文件内容。可指定行号范围。注意: 读取的是用户当前打开的编辑器，不是按路径读文件。",
    schema: z.object({
      start_line: z.number().int().positive().optional().describe("起始行号 (1-based)"),
      end_line: z.number().int().positive().optional().describe("结束行号 (1-based, 含)"),
    }),
  }
);

/** 读取当前选区文本 */
const getSelectionTool = tool(
  async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return "[ERROR] 没有活动编辑器";
    const selection = editor.selection;
    const text = editor.document.getText(selection);
    if (!text.trim()) return "[INFO] 当前没有选中文本 (请先在编辑器中选中代码)";
    const filePath = editor.document.uri.fsPath;
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    const lines = text.split("\n").map((l, i) => `${String(startLine + i).padStart(6)}|${l}`);
    return (
      `[OK] 当前选区: ${path.basename(filePath)} L${startLine}-L${endLine} (${text.length} 字符)\n` +
      lines.join("\n")
    );
  },
  {
    name: "vscode_get_selection",
    description:
      "[VS Code] 读取当前编辑器中的选中文本及来源文件路径。适合 Agent 针对用户选中的代码片段进行分析、修改建议。",
    schema: z.object({}),
  }
);

/** 对已打开文件应用精确替换 (通过 WorkspaceEdit，带撤销栈) */
const applyEditTool = tool(
  async ({ path: filePath, old_string, new_string }: { path: string; old_string: string; new_string: string }) => {
    try {
      const uri = vscode.Uri.file(path.resolve(filePath));
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();

      const idx = text.indexOf(old_string);
      if (idx === -1) return "[ERROR] 未找到匹配文本 (old_string 必须与文件内容完全一致)";
      if (text.indexOf(old_string, idx + old_string.length) !== -1) {
        return "[ERROR] old_string 在文件中不唯一，请提供更多上下文";
      }

      const startPos = doc.positionAt(idx);
      const endPos = doc.positionAt(idx + old_string.length);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(startPos, endPos), new_string);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) return "[ERROR] 编辑应用失败 (文件可能是只读的)";

      const startLine = startPos.line + 1;
      const endLine = endPos.line + 1;
      const delta = new_string.length - old_string.length;
      return `[OK] 已在编辑器应用修改: ${filePath} L${startLine}-${endLine} (${delta >= 0 ? "+" : ""}${delta} 字符, 可 Ctrl+Z 撤销)`;
    } catch (e) {
      return `[ERROR] 编辑失败: ${(e as Error).message}`;
    }
  },
  {
    name: "vscode_apply_edit",
    description:
      "[VS Code] 对已打开的文件应用精确文本替换。与内置 edit_file 不同: 该工具通过 VS Code WorkspaceEdit 应用修改，用户可 Ctrl+Z 撤销，并自动触发文件变更事件。",
    schema: z.object({
      path: z.string().describe("要修改的文件路径"),
      old_string: z.string().describe("要被替换的原始文本 (必须与文件内容完全匹配)"),
      new_string: z.string().describe("替换后的新文本"),
    }),
  }
);

/** 显示通知消息 */
const showMessageTool = tool(
  async ({ kind, message }: { kind?: string; message: string }) => {
    const k = kind ?? "info";
    if (k === "warning") {
      await vscode.window.showWarningMessage(message);
    } else if (k === "error") {
      await vscode.window.showErrorMessage(message);
    } else {
      await vscode.window.showInformationMessage(message);
    }
    return `[OK] 已向用户显示${k === "warning" ? "警告" : k === "error" ? "错误" : "信息"}通知`;
  },
  {
    name: "vscode_show_message",
    description:
      "[VS Code] 在 VS Code 右下角弹出通知消息 (info/warning/error)。适合任务完成提醒、需要用户注意的重要信息。",
    schema: z.object({
      kind: z.string().optional().describe("通知类型: info / warning / error，默认 info"),
      message: z.string().describe("要显示的消息内容"),
    }),
  }
);

/** 执行 VS Code 命令 */
const executeCommandTool = tool(
  async ({ command }: { command: string }) => {
    try {
      const result = await vscode.commands.executeCommand(command);
      return `[OK] 已执行命令: ${command}\n${result !== undefined ? `返回值: ${JSON.stringify(result).slice(0, 500)}` : ""}`;
    } catch (e) {
      return `[ERROR] 命令执行失败: ${(e as Error).message}`;
    }
  },
  {
    name: "vscode_execute_command",
    description:
      "[VS Code] 执行 VS Code 内置命令，如 'workbench.action.focusFilesExplorer'、'editor.action.formatDocument'、'workbench.action.closeActiveEditor' 等。仅当需要操作 VS Code UI 时使用。",
    schema: z.object({
      command: z.string().describe("VS Code 命令 ID"),
    }),
  }
);

/** 显示输入框获取用户输入 */
const showInputBoxTool = tool(
  async ({ prompt, placeHolder, value }: { prompt?: string; placeHolder?: string; value?: string }) => {
    const result = await vscode.window.showInputBox({
      prompt: prompt ?? "请输入:",
      placeHolder: placeHolder ?? "",
      value: value ?? "",
      ignoreFocusOut: true,
    });
    if (result === undefined) return "[INFO] 用户取消了输入";
    return result ? `用户输入: ${result}` : "[INFO] 用户输入为空";
  },
  {
    name: "vscode_show_input_box",
    description:
      "[VS Code] 显示输入框让用户输入文本。与内置 ask_user 不同: 该工具用 VS Code 原生输入框，适合收集单行短文本。",
    schema: z.object({
      prompt: z.string().optional().describe("输入框提示文字"),
      placeHolder: z.string().optional().describe("占位文本"),
      value: z.string().optional().describe("预填值"),
    }),
  }
);

// ============================================================
// 导出
// ============================================================

/** VS Code 专属工具集 (仅扩展入口注入) */
export const VSCODE_TOOLS: StructuredToolInterface[] = [
  openFileTool,
  readActiveEditorTool,
  getSelectionTool,
  applyEditTool,
  showMessageTool,
  executeCommandTool,
  showInputBoxTool,
];
