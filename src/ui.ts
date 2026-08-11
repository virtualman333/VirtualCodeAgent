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

/**
 * 提示用户输入。Ctrl+C / EOF 返回 null。
 * 每次创建独立的 readline 接口，避免与 agent 运行时的 SIGINT 冲突。
 */
export function promptUser(query: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
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
