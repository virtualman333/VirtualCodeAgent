/**
 * Write 工具 - 创建新文件或完全重写
 */
import fs from "node:fs";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { resolvePath } from "../workspace_ctx.js";

export const writeFile = tool(
  async (input: { path: string; content: string }) => {
    const abs = resolvePath(input.path);
    const isNew = !fs.existsSync(abs);

    try {
      const parent = path.dirname(abs);
      if (parent) fs.mkdirSync(parent, { recursive: true });
      fs.writeFileSync(abs, input.content, "utf-8");

      const lines = countOccurrences(input.content, "\n") + 1;
      const size = input.content.length;

      if (isNew) {
        return `[OK] Write: 新建文件 ${input.path}  (${lines} 行, ${size} 字符)`;
      }
      return `[OK] Write: 覆盖文件 ${input.path}  (${lines} 行, ${size} 字符)`;
    } catch (e) {
      return `[ERROR] Write 失败: ${(e as Error).constructor.name}: ${(e as Error).message}`;
    }
  },
  {
    name: "write_file",
    description:
      "创建新文件或完全重写现有文件。如果目录不存在会自动递归创建。如果文件已存在，会完全覆盖其内容。对比 Edit: Write 全量替换适合创建新文件或大幅修改，Edit 精确替换片段适合小范围修改。",
    schema: z.object({
      path: z.string().describe("文件路径"),
      content: z.string().describe("文件内容"),
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
