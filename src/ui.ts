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

/**
 * SGR 转义序列 —— 本仓库的颜色/样式全部由上面的 `esc()` 产出，形态只有这一种。
 *
 * 宽度计算、截断、Markdown 渲染都要按它切段：**转义序列占 0 列**，
 * 而且永远不能被切开（切一半就是半个 `\x1b[3`，终端会把它当成正文吞掉后面的字符）。
 */
const SGR_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  // 简单去除 ANSI 序列 (用于宽度计算)
  return s.replace(SGR_RE, "");
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

  // 逐**段**拼接，不是逐字符：转义序列整段保留（占 0 列），可见字符才计宽度。
  //
  // 为什么不能直接 `for (const ch of text)`：那样转义序列的每个字符
  // （`\x1b` `[` `3` `6` `m`）都会各算 1 列、还会被拆开。实测旧实现：
  //   clipToWidth(cyan("a".repeat(10)), 6) → "\x1b[36m…"
  // 10 个字符**全被吃掉**，只留一个青色省略号；更糟的是窄框下 break 会落在
  // 序列中间（`"\x1b[1m\x1b[3…"`），把半个序列写进终端 —— 终端会把它当正文，
  // 吞掉后面几个字符。本仓库的 Markdown 渲染**每行都带颜色**，所以 `panel`
  // 在窄终端里截断时必然踩到。
  let width = 0;
  let out = "";
  let sawAnsi = false;
  let last = 0;

  // 塞一个不含转义序列的片段；返回 true 表示预算已满、该收尾了
  const takeVisible = (plain: string): boolean => {
    for (const ch of plain) {
      const w = displayWidth(ch);
      // 留一列给省略号本身，否则截断后反而比 max 还宽
      if (width + w > limit - 1) return true;
      width += w;
      out += ch;
    }
    return false;
  };

  for (const m of text.matchAll(SGR_RE)) {
    const at = m.index ?? 0;
    if (takeVisible(text.slice(last, at))) return out + (sawAnsi ? RESET : "") + "…";
    out += m[0]; // 整段保留，宽度 0
    sawAnsi = true;
    last = at + m[0].length;
  }
  if (takeVisible(text.slice(last))) return out + (sawAnsi ? RESET : "") + "…";
  // 到这里说明可见宽度没超预算 —— 与开头的判断矛盾，只可能是宽度表变了。
  // 不抛：宁可多给一个省略号，也不要让一句话把整个面板打断。
  return out + "…";
}

// ============================================================
// 面板
// ============================================================

/**
 * 终端可用宽度（列），上限 100。
 *
 * 「上限 100」**只此一处**定义：`panel` 画框、`renderMarkdown` 给表格排宽都要用，
 * 各写一份的话（踩过），表格会按 120 列排、方框按 100 列画 —— 表格右边那截
 * 直接跑到框外面去，而且不报错。
 */
function termWidth(): number {
  return Math.min((process.stdout.columns ?? 80) || 80, 100);
}

/** 面板**内容**的可用宽度（扣掉 `│ ` 与 ` │` 共 4 列）—— 表格据此决定要不要换行 */
function panelInnerWidth(): number {
  return Math.max(0, termWidth() - 4);
}

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

  const lines = String(content ?? "").split("\n");
  const titleText = title ? String(title) : "";

  const contentW = lines.reduce((m, l) => Math.max(m, displayWidth(l)), 0);
  const titleW = titleText ? displayWidth(titleText) : 0;
  const required = Math.max(contentW + 4, titleText ? titleW + 5 : 0, 20);
  // 上限只用来兜住异常宽的终端；真到了装不下的程度，宁可折行也不要一个参差的框
  const width = Math.min(required, termWidth());
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

/** 是不是表格行：**必须以 `|` 开头、以 `|` 结尾**。`ps aux | grep node` 不满足，所以不会被当成表 */
function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.length >= 2 && t.startsWith("|") && t.endsWith("|");
}

/** 分隔行：`|---|:--:|` 这类。必须**成对**出现才能确认「这是一张表」 */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  return isTableRow(t) && /^[|\s:-]+$/.test(t) && t.includes("-");
}

/** 按 `|` 切格；`\|` 是转义过的竖线，先占位再切，免得把一格切成两格 */
function splitTableRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return body
    .replace(/\\\|/g, "\u0000")
    .split("|")
    .map((c) => c.replace(/\u0000/g, "|").trim());
}

type ColAlign = "left" | "center" | "right";

/** 从分隔行读对齐方式：`:--` 左、`:-:` 居中、`--:` 右，默认左 */
function parseAligns(sep: readonly string[]): ColAlign[] {
  return sep.map((s) => {
    const left = s.startsWith(":");
    const right = s.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

/** 按**显示宽度**补空格到指定列宽。`padEnd` 按码元算，中文列会歪 */
function padCell(text: string, width: number, align: ColAlign): string {
  const gap = width - displayWidth(text);
  if (gap <= 0) return text;
  if (align === "right") return " ".repeat(gap) + text;
  if (align === "center") {
    const l = Math.floor(gap / 2);
    return " ".repeat(l) + text + " ".repeat(gap - l);
  }
  return text + " ".repeat(gap);
}

/**
 * 单元格里出现字面 `|` 时必须**再转义回去**写成 `\|`，否则这条输出读不回来。
 *
 * 踩过：`| a \| b | 或 |` 渲染出来的那一行是 `| a | b  | 或   |` —— 看着对齐，
 * 但格内那个裸 `|` 已经不是「内容」而是「列分隔符」了：粘回 Markdown 再解析，
 * 2 列变 3 列，「或」被挤到不存在的列里**静默丢掉**（实测）。
 * 本函数的契约写明了「输出仍是合法 Markdown 表格」，那就得连这一条也守住。
 *
 * 必须在**算列宽之前**转义：先算宽再转义的话，`\|` 比 `|` 多占 1 列、
 * 补的白少了一格，列当场就歪；而且第二遍渲染时宽度会再变一次，永远不收敛。
 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/**
 * 单元格最小列宽。
 *
 * 3 是两头夹出来的：分隔行的 `---` 是 GFM 的下限，再窄就不是表了；
 * 而 `clipToWidth` 对 < 2 的上限会退回兜底值 80（那条分支是为了「1 列连省略号
 * 都放不下」），列宽给到 1 或 2，截断会整个失效、或者只剩一个光秃秃的「…」，
 * 等于把这一列吃掉。取 3，`ab…` 刚好还留得下两个字。
 */
const MIN_CELL = 3;

/**
 * 把「按内容算出来的绝对列宽」压进 `maxWidth` 以内。
 *
 * 削法是**从当前最宽的那列往下削**（水位线），不是按内容占比等比缩。
 * 等比缩看着合理，实测很难看：`17/8/62` 三列在 40 列预算下缩成 `5/3/22`，
 * `onUpdate`（8 列）这种**本来装得下**的短内容也被截成 `onUpd…`，
 * 而真正撑爆的那一列照样放不下 —— 两头都亏。从最宽的削，最后各列宽度接近，
 * 短内容能保住（同一组数据给到 `11/8/11`，`onUpdate` 与 `function` 都完整）。
 *
 * @param natural 按内容算出的自然列宽
 * @param maxWidth 结果每行的显示宽度上限；`<= 0` 表示不设上限
 * @returns 每列宽度；装得下（或不设上限）时是 `natural` 的副本；
 *          连每列 `MIN_CELL` 都放不下时返回 `null` —— 由调用方原样输出。
 *          硬压到装下只会得到一张竖线错位、内容全成省略号的「表」，那不叫渲染。
 */
function fitWidths(natural: readonly number[], maxWidth: number, cols: number): number[] | null {
  const sum = natural.reduce((a, b) => a + b, 0);
  // 每行的固定开销：`| ` + ` |` 两组共 4 列，格与格之间每个 ` | ` 3 列
  const overhead = 3 * cols + 1;
  if (!(maxWidth > 0) || sum + overhead <= maxWidth) return [...natural];

  const budget = maxWidth - overhead;
  if (budget < MIN_CELL * cols) return null;

  const out = [...natural];
  let used = sum;
  // 每次只削 1 列 —— 这样 used 必然**恰好**落到 budget（不会削过头再补回来），
  // 也就不需要「余量再分配」那半段逻辑。列数 × 列宽的量级，不心疼。
  while (used > budget) {
    let k = -1;
    for (let i = 0; i < cols; i++) if (out[i] > MIN_CELL && (k < 0 || out[i] > out[k])) k = i;
    // 走不到：budget ≥ MIN_CELL × cols 时，全列都被压到 MIN_CELL 就意味着
    // used = budget，循环已经退出了。留着是防将来有人改掉上面那个判断。
    if (k < 0) return null;
    out[k]--;
    used--;
  }
  return out;
}

/**
 * 把一块 Markdown 表格渲染成**列对齐**的文本表格。
 *
 * 为什么要做：模型回答里表格很常见（对比、参数清单、排期），但 Markdown 表格的
 * 原始文本是按**码元**对齐的 —— 中文一个字占 2 列却只占 1 个码元，加上本文件
 * 渲染时还会往里插 ANSI 序列（占 0 列），于是整张表的竖线每行都落在不同列
 * （实测同一张表四行，竖线分别在 0,7,14,21 / 0,13,22,31 / 0,9,19,26 列）。
 * 而 `panel` 的右边框是按显示宽度算的，两者一叠加，表就彻底散了。
 *
 * 输出**仍然是合法的 Markdown 表格**（还是 `|` 与 `-`，只是补齐了空格）：从终端里
 * 复制出去粘回 Markdown 文件依然是一张表。换成 `┼─` 这类绘制字符好看，但粘出去
 * 就只剩花纹了。**「粘回来还是同一张表」是契约，不是愿望** —— 单元格里出现
 * 字面竖线时会转义成 `\|`，见 `escapeCell`。
 *
 * @param lines 表格的原始行（含表头与分隔行），**只含这张表**
 * @param maxWidth 结果每行的显示宽度上限；`0`（默认）表示不设上限、按绝对列宽排。
 *                 面板里要传 `panelInnerWidth()`，否则超宽的表会顶穿右边框
 *                 （`panel` 只能按行**截断**，越界的那几列会被整段吃掉）。
 * @returns 渲染后的行；不是合法表格、或宽度实在装不下时返回 `null`，
 *          由调用方原样输出，不做猜测
 */
export function renderMarkdownTable(lines: readonly string[], maxWidth = 0): string[] | null {
  const rows = lines.map((l) => l.trimEnd());
  if (rows.length < 2) return null;
  if (!isTableRow(rows[0]) || !isTableSeparator(rows[1])) return null;
  if (!rows.slice(2).every(isTableRow)) return null;

  const header = splitTableRow(rows[0]);
  const sep = splitTableRow(rows[1]);
  // 分隔行的格数与表头不一致就不是一张表（宁可原样输出，也别猜哪列该到哪）
  if (header.length === 0 || header.length !== sep.length) return null;

  const cols = header.length;
  const body = rows.slice(2).map(splitTableRow);
  // 列宽按**渲染后**的显示宽度算：单元格里的 `code` / 加粗会变成 ANSI 序列，
  // 序列占 0 列但占码元 —— 量错了列就白对。
  const cells: string[][] = [header, ...body].map((row) =>
    Array.from({ length: cols }, (_, i) => escapeCell(renderInline(row[i] ?? "")))
  );
  const natural = Array.from({ length: cols }, (_, i) =>
    Math.max(...cells.map((row) => displayWidth(row[i])))
  );
  const widths = fitWidths(natural, maxWidth, cols);
  if (!widths) return null;
  const aligns = parseAligns(sep);

  // 截断必须在**补空格之前**：先 padCell 再 clip 会连补出来的白一起截掉，
  // 列宽又回到不一致；而且 padCell 补的白本身就是「宽度」，不能算进内容。
  const fit = (row: readonly string[]): string[] =>
    row.map((c, i) => (displayWidth(c) > widths[i] ? clipToWidth(c, widths[i]) : c));
  const draw = (row: readonly string[]): string =>
    "| " + row.map((c, i) => padCell(c, widths[i], aligns[i])).join(" | ") + " |";

  return [
    draw(fit(cells[0]).map((c) => bold(c))),
    "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|",
    ...cells.slice(1).map((row) => draw(fit(row))),
  ];
}

/**
 * 行内代码 + 加粗：**一次扫描**，用同一条正则的交替分支，谁先出现就处理谁。
 *
 * 不能写成两次 replace（踩过）：第一次替换会把 ANSI 序列写进中间结果，
 * 第二次的正则再扫一遍时，就把**行内代码里的字面星号**也当成加粗标记了 ——
 * `` 用 `**p**` 表示加粗 `` 里的 `**p**` 会变成「加粗的 p」，
 * 而它明明写在反引号里、本该原样显示；`` `a**b**c` `` 同理。
 *
 * 表格单元格也走这里：同一段 Markdown 在正文里是什么样，在表格里就该是什么样，
 * 各写一份的话两边必然漂移。
 */
export function renderInline(line: string): string {
  return line.replace(
    /`[^`]+`|\*\*[^*]+\*\*/g,
    (m: string) => (m.startsWith("`") ? cyan(m.slice(1, -1)) : bold(m.slice(2, -2)))
  );
}

/**
 * 简单 Markdown 高亮: 标题加粗、代码块 dim、行内代码 cyan、表格列对齐。
 *
 * `maxWidth` 是表格的显示宽度上限，默认取 `panelInnerWidth()`（两个调用点都是
 * `panel(renderMarkdown(x), title)`，所以默认值直接按面板内容宽算）。
 * 传 `Infinity` 表示不设上限 —— 纯文本消费（测试、比对）用得上。
 */
export function renderMarkdown(text: string, maxWidth: number = panelInnerWidth()): string {
  const lines = text.split("\n");
  let inCodeBlock = false;
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
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
    // 表格：整块吃掉一起渲染，不能一行一行过 —— 列宽要看完所有行才知道。
    // 判据是「本行像表格行」**且**下一位是分隔行：只认竖线的话，
    // 正好以 `|` 结尾的命令行（`... | tee out.log |`）会被整块吃成表格。
    if (isTableRow(line)) {
      let end = i + 2;
      while (end < lines.length && isTableRow(lines[end].trimEnd())) end++;
      const table = renderMarkdownTable(
        lines.slice(i, end).map((l) => l.trimEnd()),
        maxWidth
      );
      if (table) {
        out.push(...table);
        i = end - 1;
        continue;
      }
    }
    out.push(renderInline(line));
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
