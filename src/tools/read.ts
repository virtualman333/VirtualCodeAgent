/**
 * Read 工具 - 读文件，支持行号范围、自动分块
 */
import fs from "node:fs";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getWorkspace } from "../workspace_ctx.js";

// 单块最大字符数 (超过则触发自动分块)
const CHUNK_MAX_CHARS = 8000;

interface Chunk {
  start: number;
  end: number;
  chars: number;
}

function resolvePath(p: string): string {
  if (path.isAbsolute(p) && fs.existsSync(p)) return p;
  if (fs.existsSync(p)) return path.resolve(p);
  const ws = getWorkspace();
  const alt = path.join(ws, p);
  if (fs.existsSync(alt)) return alt;
  const alt2 = path.join(ws, "workspace", p);
  if (fs.existsSync(alt2)) return alt2;
  return path.resolve(p);
}

function buildChunks(lines: string[]): Chunk[] {
  const chunks: Chunk[] = [];
  let curStart = 1;
  let curChars = 0;
  for (let idx = 1; idx <= lines.length; idx++) {
    curChars += lines[idx - 1].length;
    if (curChars > CHUNK_MAX_CHARS) {
      chunks.push({ start: curStart, end: idx - 1, chars: curChars - lines[idx - 1].length });
      curStart = idx;
      curChars = lines[idx - 1].length;
    }
  }
  chunks.push({ start: curStart, end: lines.length, chars: curChars });
  return chunks;
}

function buildChunkIndex(filePath: string, lines: string[], totalChars: number): string {
  const chunks = buildChunks(lines);
  const out = [
    `[INFO] ${filePath} 较大 (${totalChars.toLocaleString()} 字符, ${lines.length} 行)。`,
    `已自动分为 ${chunks.length} 块。请用 read_file(path=..., chunk=N) 分块读取。`,
    "",
    "分块索引:",
  ];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    out.push(
      `  Chunk ${String(i + 1).padStart(3)}: L${String(c.start).padStart(6)}-L${String(c.end).padEnd(6)} (${String(c.chars).padStart(6)} 字符)`
    );
  }
  out.push("");
  out.push("示例: read_file(path=..., chunk=1)");
  return out.join("\n");
}

function readText(
  filePath: string,
  startLine: number | null,
  endLine: number | null,
  chunk: number | null
): string {
  const abs = resolvePath(filePath);
  const raw = fs.readFileSync(abs, "utf-8");
  const lines = raw.split(/\r?\n/);
  const totalLines = lines.length;

  // ---- 模式 1: 显式指定 chunk ----
  if (chunk !== null) {
    const chunks = buildChunks(lines);
    if (chunk < 1 || chunk > chunks.length) {
      return `[ERROR] chunk ${chunk} 不存在，共 ${chunks.length} 块 (1-${chunks.length})`;
    }
    const c = chunks[chunk - 1];
    const selected = lines.slice(c.start - 1, c.end);
    const outLines = selected.map((line, i) => {
      const lineNo = c.start + i;
      return `${String(lineNo).padStart(6)}|${line.replace(/\r$/, "")}`;
    });
    const header = `[OK] ${filePath}  Chunk ${chunk}/${chunks.length} (L${c.start}-L${c.end} / 共 ${totalLines} 行, ${c.chars} 字符)`;
    return header + "\n" + outLines.join("\n");
  }

  // ---- 模式 2: 行号范围 ----
  if (startLine || endLine) {
    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(totalLines, endLine ?? totalLines);
    if (start > totalLines) {
      return `[INFO] 文件只有 ${totalLines} 行，起始行 ${startLine} 超出范围`;
    }
    const selected = lines.slice(start - 1, end);
    const outLines = selected.map((line, i) => {
      const lineNo = start + i;
      return `${String(lineNo).padStart(6)}|${line.replace(/\r$/, "")}`;
    });
    return `[OK] ${filePath}  (L${start}-L${end} / 共 ${totalLines} 行)\n` + outLines.join("\n");
  }

  // ---- 模式 3: 全文件 + 自动分块检测 ----
  const totalChars = raw.length;
  if (totalChars <= CHUNK_MAX_CHARS) {
    const outLines = lines.map((line, i) => {
      return `${String(i + 1).padStart(6)}|${line.replace(/\r$/, "")}`;
    });
    return `[OK] ${filePath}  (共 ${totalLines} 行, ${totalChars} 字符)\n` + outLines.join("\n");
  }

  // 大文件: 返回分块索引
  return buildChunkIndex(filePath, lines, totalChars);
}

export const readFile = tool(
  async (input: { path: string; start_line?: number; end_line?: number; chunk?: number }) => {
    const filePath = input.path;
    if (!fs.existsSync(filePath)) {
      const ws = getWorkspace();
      const alt = path.join(ws, filePath);
      if (fs.existsSync(alt)) {
        input.path = alt;
      } else if (fs.existsSync(path.join(ws, "workspace", filePath))) {
        input.path = path.join(ws, "workspace", filePath);
      } else {
        return `[ERROR] 文件不存在: ${filePath}\n试试先用 Glob 查找文件位置`;
      }
    }

    const abs = resolvePath(input.path);
    if (!fs.existsSync(abs)) return `[ERROR] 文件不存在: ${input.path}`;

    // 文件大小检查
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      return `[ERROR] 读取文件失败: ${input.path}`;
    }
    if (size > 10 * 1024 * 1024) {
      return `[ERROR] 文件过大 (>10MB): ${input.path} (${size.toLocaleString()} bytes)`;
    }

    const suffix = path.extname(abs).toLowerCase();

    try {
      // 图片: 返回元信息
      const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".ico"]);
      if (IMAGE_EXTS.has(suffix)) {
        return `[OK] 图片: ${input.path}\n  文件大小: ${size.toLocaleString()} bytes\n(TS 版暂不解析图片 EXIF/尺寸，需要时后续接入图像模型)`;
      }

      // PDF / Notebook: 暂不支持 (后续接入)
      if (suffix === ".pdf") {
        return `[ERROR] TS 版暂不支持读取 PDF，请用 bash 提取文本或转换为文本文件`;
      }
      if (suffix === ".ipynb") {
        return readNotebook(abs, input.path);
      }

      // 默认: 文本文件 (自动分块)
      return readText(input.path, input.start_line ?? null, input.end_line ?? null, input.chunk ?? null);
    } catch (e) {
      return `[ERROR] 读取文件失败: ${(e as Error).constructor.name}: ${(e as Error).message}`;
    }
  },
  {
    name: "read_file",
    description:
      "读取文件内容，支持文本格式和行号范围。大文件（>8000字符）会自动分块并返回分块索引，用 chunk=N 精准读取第 N 块，无需猜测行号。chunk 与 start_line/end_line 互斥，chunk 优先。",
    schema: z.object({
      path: z.string().describe("文件路径"),
      start_line: z.number().int().optional().describe("起始行号 (1-based)，仅文本模式生效"),
      end_line: z.number().int().optional().describe("结束行号 (1-based, 含)，仅文本模式生效"),
      chunk: z.number().int().optional().describe("块号 (1-based)，读取自动分好的第 N 块（大文件推荐）"),
    }),
  }
);

function readNotebook(abs: string, displayPath: string): string {
  const raw = fs.readFileSync(abs, "utf-8");
  const nb = JSON.parse(raw);
  const cells: Array<{ cell_type?: string; source?: unknown }> = nb.cells ?? [];
  const out = [`[OK] Notebook: ${displayPath}  (格式: ${nb.nbformat ?? "unknown"}.${nb.nbformat_minor ?? 0}, ${cells.length} 个单元格)`];
  cells.forEach((cell, i) => {
    let source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? "");
    if (source.length > 2000) source = source.slice(0, 2000) + `\n... (截断, 共 ${source.length} 字符)`;
    out.push(`\n--- 单元格 ${i + 1} [${cell.cell_type ?? "unknown"}] ---`);
    out.push(source);
  });
  return out.join("\n");
}
