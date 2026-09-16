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
 * 显示宽度：CJK / 全角字符算 2 列，常见绘文字（emoji）也算 2 列，其余算 1 列，
 * ANSI 序列不计。
 *
 * 只为了把控制台里的框与列对齐 —— 不是完整的 Unicode 东亚洲宽度表。
 *
 * 明确**不覆盖**的部分（终端各家的渲染并不一致，宁可算 1 也不乱猜）：
 *   - `U+2600–U+27BF` 那一批（`⚡` `✅` `❌` `⚠`）：有 emoji 呈现也有文本呈现，
 *     不同终端宽度不同；本仓库目前只把它们用在 `print` 的自然句子里，不进框。
 *   - 零宽的组合附加符（如肤色修饰符 `U+1F3FB–U+1F3FF`）会被算成 2 列 ——
 *     它们不出现于本仓库的输出。
 * 这两条各自有一条测试钉住，免得将来被当成「忘了写」而随手改掉。
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
      (c >= 0x1f300 && c <= 0x1f64f) || // 绘文字：📋 在这段
      (c >= 0x1f680 && c <= 0x1f6ff) || // 交通与地图符号：🔌 在这段
      (c >= 0x1f900 && c <= 0x1f9ff) ||
      (c >= 0x1fa70 && c <= 0x1faff) ||
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

/**
 * 按**显示宽度**截断，超出部分换成 `…`。
 *
 * 不能写成 `s.length > max ? s.slice(0, max) + "…"`（本仓库踩过）：
 * 长度按码元算、宽度按列算，一个汉字占 2 列却是 1 个码元，
 * 于是中文行会「判定没超、实际超了一倍宽」，把终端里的对齐整个顶歪。
 * 这里两边都用 displayWidth，逐字符累加。
 */
export function clipToWidth(s: string, max: number): string {
  const text = String(s ?? "").replace(/\s+/g, " ").trim();
  // 上限小于 2 列时截断没有可表达的意义（1 列连省略号加一个字符都放不下），
  // 退回兜底值而不是吐出一个光秃秃的「…」—— 那等于把内容整条吃掉。
  const raw = Number.isFinite(max) ? Math.trunc(max) : 80;
  const limit = raw >= 2 ? raw : 80;
  if (displayWidth(text) <= limit) return text;
  let width = 0;
  let out = "";
  for (const ch of text) {
    width += displayWidth(ch);
    // 留一列给省略号本身，否则截断后反而比 max 还宽
    if (width > limit - 1) break;
    out += ch;
  }
  return out + "…";
}

// ============================================================
// 面板
// ============================================================

/**
 * 画一个带标题的方框。
 *
 * **宽度一律按显示宽度算，不按码元。** 这里踩过：原先用的是
 * `stripAnsi(l).length`，中文一个字占 2 列却只占 1 个码元，于是「判定没超、
 * 实际超了一倍宽」—— 方框右边框会随着每行中文的多少忽左忽右（实测：上下边框
 * 34 列，正文行 34~50 列），而且**不报任何错**。同文件的 `renderHelp` 早就在用
 * `displayWidth`，只有这里漏了。
 *
 * 宽度还必须同时容得下**正文行**和**标题行** —— 二者的边框开销不一样：
 *   正文 `│ ` + 内容 + ` │`      两侧共 4 列
 *   标题 `┌─ ` + 标题 + ` ` + 补线 + `┐`  共 5 列
 * 原先把标题也按 4 列算，于是标题那行永远比正文宽 1 列。
 */
export function panel(content: string, title?: string, borderStyle: "green" | "blue" | "yellow" | "magenta" | "red" = "blue"): void {
  const borderColor =
    borderStyle === "green" ? green :
    borderStyle === "yellow" ? yellow :
    borderStyle === "magenta" ? magenta :
    borderStyle === "red" ? red : blue;

  const termWidth = (process.stdout.columns ?? 80) || 80;
  const lines = String(content ?? "").split("\n");
  const titleText = title ? String(title) : "";

  const contentW = lines.reduce((m, l) => Math.max(m, displayWidth(l)), 0);
  const titleW = titleText ? displayWidth(titleText) : 0;
  const required = Math.max(contentW + 4, titleText ? titleW + 5 : 0, 20);
  // 上限只用来兜住异常宽的终端；真到了装不下的程度，宁可折行也不要一个参差的框
  const width = Math.min(required, Math.min(termWidth, 100));
  const inner = Math.max(0, width - 4);

  if (titleText) {
    const pad = Math.max(0, width - titleW - 5);
    print(borderColor(`┌─ ${bold(titleText)} ${"─".repeat(pad)}┐`));
  } else {
    print(borderColor(`┌${"─".repeat(Math.max(0, width - 2))}┐`));
  }

  for (const raw of lines) {
    // 终端比内容还窄时才截（上限算进去了）：给一个带 `…` 的整齐框，
    // 好过一个折得看不出边在哪、还不报错的框。正常宽度下这根分支不会走到。
    const line = displayWidth(raw) > inner ? clipToWidth(raw, inner) : raw;
    print(`│ ${line}${" ".repeat(Math.max(0, inner - displayWidth(line)))} │`);
  }

  print(borderColor(`└${"─".repeat(Math.max(0, width - 2))}┘`));
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
