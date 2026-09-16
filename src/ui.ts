/**
 * 控制台 UI - ANSI 颜色 + 面板 + Markdown 简易渲染
 */
import readline from "node:readline";

const RESET = "\x1b[0m";
const esc = (code: string) => (s: string) => `\x1b[${code}m${s}${RESET}`;

export const dim = esc("2");
export const bold = esc("1");
export const italic = esc("3");
export const underline = esc("4");
export const red = esc("31");
export const green = esc("32");
export const yellow = esc("33");
export const blue = esc("34");
export const magenta = esc("35");
export const cyan = esc("36");
export const gray = esc("90");

export function print(text = ""): void {
  process.stdout.write(text + "\n");
}

export function stripAnsi(s: string): string {
  // 简单去除 ANSI 序列 (用于宽度计算)
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * 显示宽度：CJK / 全角字符算 2 列，其余算 1 列，ANSI 序列不计。
 * 只为了把 help 里的命令列对齐 —— 不是完整的 Unicode 东亚洲宽度表。
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0x303e) ||
      (c >= 0x3041 && c <= 0x33ff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0xa000 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

/** 按显示宽度右侧补空格（padEnd 按码元算，中文列会歪） */
export function padRight(s: string, width: number): string {
  const gap = width - displayWidth(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

// ============================================================
// 面板
// ============================================================

export function panel(content: string, title?: string, borderStyle: "green" | "blue" | "yellow" | "magenta" | "red" = "blue"): void {
  const borderColor =
    borderStyle === "green" ? green :
    borderStyle === "yellow" ? yellow :
    borderStyle === "magenta" ? magenta :
    borderStyle === "red" ? red : blue;

  const termWidth = (process.stdout.columns ?? 80) || 80;
  const lines = content.split("\n");
  const maxLen = Math.max(...lines.map((l) => stripAnsi(l).length), title?.length ?? 0);
  const width = Math.min(Math.max(maxLen + 4, 20), Math.min(termWidth, 100));

  if (title) {
    const pad = Math.max(0, width - stripAnsi(title).length - 4);
    print(borderColor(`┌─ ${bold(title)} ${"─".repeat(pad)}┐`));
  } else {
    print(borderColor(`┌${"─".repeat(width - 2)}┐`));
  }
  for (const line of lines) {
    const len = stripAnsi(line).length;
    const pad = Math.max(0, width - 4 - len);
    print(`│ ${line}${" ".repeat(pad)} │`);
  }
  print(borderColor(`└${"─".repeat(width - 2)}┘`));
}

// ============================================================
// Markdown 简易渲染
// ============================================================

/** 简单 Markdown 高亮: 标题加粗、代码块 dim、行内代码 cyan */
export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  let inCodeBlock = false;
  const out: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      out.push(dim(line));
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      out.push(bold(cyan(line.replace(/^#{1,6}\s/, ""))));
      continue;
    }
    // 行内代码 + 加粗
    let rendered = line.replace(/`([^`]+)`/g, (_, code: string) => cyan(code));
    rendered = rendered.replace(/\*\*([^*]+)\*\*/g, (_, t: string) => bold(t));
    out.push(rendered);
  }
  return out.join("\n");
}

// ============================================================
// 交互式输入
// ============================================================

export interface PromptOptions {
  /** 供 ↑/↓ 翻回的历史，**最新在前**（与 Node readline 的约定一致） */
  history?: readonly string[];
  /** Tab 补全回调，签名与 Node readline 的 completer 相同 */
  completer?: (line: string) => [string[], string];
}

/**
 * 提示用户输入。Ctrl+C / EOF 返回 null。
 * 每次创建独立的 readline 接口，避免与 agent 运行时的 SIGINT 冲突。
 */
export function promptUser(
  query: string,
  opts: PromptOptions = {}
): Promise<string | null> {
  return new Promise((resolve) => {
    const history = opts.history ?? [];
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      // ⚠ 这里必须给**副本**：Node 的 readline 不复制传入的数组，而是拿同一个
      // 引用当历史（实测 `rl.history === 传入的数组` 为 true），新输入直接
      // unshift 进去。历史由 main.ts 自己记录并落盘，不希望被它顺手改动。
      // 每次 prompt 只取一行输入，快照完全够用。
      history: [...history],
      // 0 在 Node 里等于「关掉历史」，所以没有历史时也得给 1
      historySize: Math.max(history.length, 1),
      completer: opts.completer,
    });
    let settled = false;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      try {
        rl.close();
      } catch {
        /* ignore */
      }
      resolve(v);
    };

    rl.on("SIGINT", () => {
      process.stdout.write("\n");
      done(null);
    });

    rl.question(query, (answer) => {
      done(answer);
    });
  });
}
