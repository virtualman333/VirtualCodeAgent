/**
 * Edit 工具 - 精确替换文件中的文本片段
 */
import fs from "node:fs";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getWorkspace } from "../workspace_ctx.js";

function resolvePath(p: string): string {
  if (path.isAbsolute(p) && fs.existsSync(p)) return p;
  if (fs.existsSync(p)) return path.resolve(p);
  const ws = getWorkspace();
  const alt = path.join(ws, p);
  if (fs.existsSync(alt)) return alt;
  const alt2 = path.join(ws, "workspace", p);
  if (fs.existsSync(alt2)) return alt2;
  return path.join(ws, p);
}

export const editFile = tool(
  async (input: { path: string; old_string: string; new_string: string }) => {
    const { path: filePath, old_string, new_string } = input;
    const abs = resolvePath(filePath);

    if (!fs.existsSync(abs)) return `[ERROR] 文件不存在: ${filePath}`;

    let original: string;
    try {
      original = fs.readFileSync(abs, "utf-8");
    } catch (e) {
      return `[ERROR] 读取文件失败: ${(e as Error).message}`;
    }

    if (!old_string) return "[ERROR] old_string 不能为空";

    const count = countOccurrences(original, old_string);
    if (count === 0) {
      return (
        `[ERROR] 未找到匹配文本。请确认 old_string 与文件内容完全一致（含缩进）。\n` +
        `提示: 先用 Read 工具读取文件内容，确保 old_string 精确匹配。`
      );
    }
    if (count > 1) {
      return (
        `[ERROR] old_string 在文件中出现了 ${count} 次，不唯一。\n` +
        `请提供更多上下文使匹配唯一，或用其他工具处理。`
      );
    }

    const idx = original.indexOf(old_string);
    const modified = original.slice(0, idx) + new_string + original.slice(idx + old_string.length);

    try {
      fs.writeFileSync(abs, modified, "utf-8");
    } catch (e) {
      return `[ERROR] 写入文件失败: ${(e as Error).message}`;
    }

    const before = original.slice(0, idx);
    const startLine = countOccurrences(before, "\n") + 1;
    const endLine = startLine + countOccurrences(old_string, "\n");
    const added = new_string.length - old_string.length;
    const sizeInfo = added >= 0 ? `+${added}` : `${added}`;
    const lineInfo = endLine === startLine ? `第 ${startLine} 行` : `第 ${startLine}-${endLine} 行`;

    let preview = new_string.trim();
    if (new_string.length > 200) {
      preview = new_string.slice(0, 200) + `\n... (共 ${new_string.length} 字符)`;
    }

    return (
      `[OK] Edit: ${filePath} ${lineInfo}  (${sizeInfo} 字符)\n` +
      `────────────────────────────────────────\n` +
      `${preview}\n` +
      `────────────────────────────────────────`
    );
  },
  {
    name: "edit_file",
    description:
      "精确替换文件中的文本片段。old_string 必须在文件中唯一存在（含缩进精确匹配）。替换后不会修改不相邻的行。常用于修改函数实现、修改变量名、添加/删除代码行。new_string 用空字符串可删除匹配行。",
    schema: z.object({
      path: z.string().describe("要编辑的文件路径"),
      old_string: z.string().describe("要被替换的原始文本（必须与文件内容完全匹配，包括缩进）"),
      new_string: z.string().describe("替换后的新文本。使用空字符串 \"\" 可删除匹配行"),
    }),
  }
);

function countOccurrences(text: string, sub: string): number {
  let count = 0;
  let idx = text.indexOf(sub);
  while (idx !== -1) {
    count++;
    idx = text.indexOf(sub, idx + sub.length);
  }
  return count;
}
