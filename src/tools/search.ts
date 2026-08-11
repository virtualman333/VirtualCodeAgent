/**
 * Glob & Grep 搜索工具
 */
import fs from "node:fs";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getWorkspace } from "../workspace_ctx.js";

// ---- 排除目录 ----
const EXCLUDE_DIRS = new Set([
  ".git", "__pycache__", "node_modules", ".venv", "venv", "env", ".tox",
  ".mypy_cache", ".pytest_cache", ".next", ".nuxt", "dist", "build",
  "target", ".idea", ".vscode", ".vca",
]);

function shouldSkipDir(dirname: string): boolean {
  return EXCLUDE_DIRS.has(dirname) || dirname.startsWith(".");
}

// glob 模式匹配，正确处理 ** 通配符:
// 1. "**" 加 "/" 前缀 (如 **/X) 也应匹配根目录的 X (0 级目录)
// 2. 不含 "**" 的模式按路径段匹配，避免 "*" 跨目录
export function matchGlob(relPath: string, pattern: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  const pat = pattern.replace(/\\/g, "/");

  // **/ 前缀: 也应匹配根目录 (0 级目录)
  if (pat.startsWith("**/")) {
    const basePattern = pat.slice(3);
    if (basicMatch(norm, basePattern)) return true;
    return basicMatch(norm, pat);
  }

  // 不含 ** 的模式: 按路径段逐段匹配
  if (!pat.includes("**")) {
    const patParts = pat.split("/");
    const pathParts = norm.split("/");
    if (pathParts.length !== patParts.length) return false;
    return patParts.every((pt, i) => basicMatch(pathParts[i], pt));
  }

  // 含中间 ** (如 src/**/*.tsx): 递归匹配
  return globToRegExp(pat).test(norm);
}

function basicMatch(name: string, pattern: string): boolean {
  return globToRegExp(pattern, { basename: !pattern.includes("/") }).test(name);
}

/** 将 glob 模式转为 RegExp (支持 * ? [abc] {a,b}) */
export function globToRegExp(pattern: string, opts: { basename?: boolean } = {}): RegExp {
  let re = pattern
    .replace(/\*\*/g, "\u0000") // 临时保护 **
    .replace(/\./g, "\\.")
    .replace(/\?/g, "[^/]")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\{([^}]+)\}/g, (_, group: string) => `(${group.split(",").join("|")})`)
    .replace(/\[!/g, "[^")
    .replace(/\[/g, "[")
    .replace(/\]/g, "]");
  re = `^${re}$`;
  return new RegExp(re);
}

function resolveBase(p: string): string {
  if (path.isAbsolute(p) && fs.existsSync(p)) return p;
  if (fs.existsSync(p)) return path.resolve(p);
  const ws = getWorkspace();
  const alt = path.join(ws, p);
  if (fs.existsSync(alt)) return alt;
  const alt2 = path.join(ws, "workspace", p);
  if (fs.existsSync(alt2)) return alt2;
  return path.join(ws, p);
}

// ============================================================
// Glob - 按文件名模式搜索
// ============================================================

export const globFiles = tool(
  async ({ pattern, path: basePath }: { pattern: string; path?: string }) => {
    const base = resolveBase(basePath || ".");

    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
      return `[ERROR] 目录不存在: ${basePath}`;
    }

    const matches: string[] = [];
    walk(base, (relPath) => {
      if (matchGlob(relPath, pattern)) matches.push(relPath);
    });

    if (matches.length === 0) {
      return `[OK] Glob: 未找到匹配 '${pattern}' 的文件 (搜索于 ${path.resolve(base)})`;
    }

    const lines = [`[OK] Glob: 找到 ${matches.length} 个匹配 '${pattern}' 的文件:`];
    for (const m of matches.sort().slice(0, 200)) lines.push(`  ${m}`);
    if (matches.length > 200) lines.push(`  ... 还有 ${matches.length - 200} 个结果未显示`);
    return lines.join("\n");
  },
  {
    name: "glob_files",
    description:
      "按文件名模式递归搜索文件。支持 ** 到多级子目录、* 匹配任意字符、? 匹配单个字符、[abc] 字符集、{a,b} 分支。如 '*.py'、'src/**/*.tsx'、'**/test_*.py'",
    schema: z.object({
      pattern: z.string().describe("文件名匹配模式，如 'src/**/*.tsx'"),
      path: z.string().optional().describe("搜索的起始目录，默认为当前目录"),
    }),
  }
);

function walk(base: string, onFile: (rel: string) => void): void {
  const entries = fs.readdirSync(base, { withFileTypes: true });
  for (const ent of entries) {
    const abs = path.join(base, ent.name);
    const rel = path.relative(base, abs).replace(/\\/g, "/");
    if (ent.isDirectory()) {
      if (shouldSkipDir(ent.name)) continue;
      walk(abs, onFile);
    } else if (ent.isFile()) {
      onFile(rel);
    }
  }
}

// ============================================================
// Grep - 按文件内容/正则搜索
// ============================================================

function isBinary(filepath: string): boolean {
  try {
    const fd = fs.openSync(filepath, "r");
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).includes(0);
  } catch {
    return true;
  }
}

export const grepContent = tool(
  async (input: {
    pattern: string;
    path?: string;
    glob?: string;
    ignore_case?: boolean;
    max_results?: number;
  }) => {
    const base = resolveBase(input.path || ".");
    const pattern = input.pattern;
    const ignoreCase = input.ignore_case ?? false;
    const maxResults = input.max_results ?? 100;
    const globFilter = input.glob;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignoreCase ? "i" : "");
    } catch (e) {
      return `[ERROR] 正则表达式无效: ${(e as Error).message}`;
    }

    const results: string[] = [];
    let scanned = 0;
    let truncated = false;

    const scanFile = (fpath: string, rel: string): void => {
      let size = 0;
      try {
        size = fs.statSync(fpath).size;
      } catch {
        return;
      }
      if (size > 5 * 1024 * 1024 || isBinary(fpath)) return;
      scanned += 1;
      try {
        const content = fs.readFileSync(fpath, "utf-8");
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`);
            if (results.length >= maxResults) {
              truncated = true;
              return;
            }
          }
        }
      } catch {
        /* 跳过无法读取的文件 */
      }
    };

    if (fs.existsSync(base) && fs.statSync(base).isFile()) {
      scanFile(base, path.basename(base));
    } else if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      const entries = fs.readdirSync(base, { withFileTypes: true });
      const walkDir = (dir: string, onFile: (abs: string, rel: string) => void): void => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, ent.name);
          const rel = path.relative(base, abs).replace(/\\/g, "/");
          if (ent.isDirectory()) {
            if (shouldSkipDir(ent.name)) continue;
            walkDir(abs, onFile);
          } else if (ent.isFile()) {
            onFile(abs, rel);
          }
        }
      };
      walkDir(base, (abs, rel) => {
        if (truncated) return;
        if (globFilter && !matchGlob(path.basename(abs), globFilter)) return;
        scanFile(abs, rel);
      });
    } else {
      return `[ERROR] 路径不存在: ${input.path}`;
    }

    if (results.length === 0) {
      const globInfo = globFilter ? ` (文件过滤: ${globFilter})` : "";
      return `[OK] Grep: 未找到匹配 '${pattern}' 的内容 (扫描 ${scanned} 个文件${globInfo})`;
    }

    const out = [`[OK] Grep: 找到 ${results.length} 个匹配 '${pattern}' (共扫描 ${scanned} 个文件)`];
    out.push(...results);
    if (truncated) out.push(`... 结果已截断，仅显示前 ${maxResults} 条`);
    return out.join("\n");
  },
  {
    name: "grep_content",
    description:
      "在文件内容中搜索匹配正则表达式的行。类似于 ripgrep / grep -r。搜索所有文本文件中的匹配行。",
    schema: z.object({
      pattern: z.string().describe("正则表达式，如 'def main'、'TODO|FIXME'"),
      path: z.string().optional().describe("搜索的目录或文件路径"),
      glob: z.string().optional().describe("文件名过滤，如 '*.py'、'*.{ts,tsx}'。仅在搜索目录时生效"),
      ignore_case: z.boolean().optional().describe("是否忽略大小写，默认 False"),
      max_results: z.number().optional().describe("最多返回的匹配数，默认 100"),
    }),
  }
);
