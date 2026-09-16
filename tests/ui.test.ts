/**
 * 控制台 UI 工具的测试 —— 目前只覆盖 `clipToWidth`（按显示宽度截断）。
 *
 * 为什么单独给它一个文件：这个仓库踩过一次「把显示宽度当字符串下标」的坑
 * （对齐断言里用 `indexOf` 去比 `padRight` 补出来的列，中文那行天然对不上，
 * 测试自己把自己骗了）。截断也有同一个陷阱：`s.slice(0, 80)` 按**码元**切，
 * 一个汉字占 2 列却只占 1 个码元，于是中文行会「判定没超、实际超了一倍宽」，
 * 在终端里把对齐整个顶歪 —— 而且不报任何错。
 *
 * 所以这里断言的判据统一是 `displayWidth`，不是 `length`。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { blue, bold, clipToWidth, cyan, dim, displayWidth, padRight, panel, renderInline, renderMarkdown, renderMarkdownTable, stripAnsi, yellow } from "../src/ui.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("clipToWidth: 没超就原样返回，不掺省略号", () => {
  assert.equal(clipToWidth("hello", 10), "hello");
  assert.equal(clipToWidth("hello", 5), "hello", "刚好等于上限也算没超");
  assert.equal(clipToWidth("中文", 4), "中文");
});

test("clipToWidth: 超了才截，且结果宽度不超过上限", () => {
  const out = clipToWidth("abcdefghij", 4);
  assert.equal(out, "abc…");
  assert.ok(displayWidth(out) <= 4, `实际宽度 ${displayWidth(out)} 超过 4`);
});

test("clipToWidth: 中文按 2 列算 —— 不能用 slice 按码元切", () => {
  // 5 个汉字 = 10 列；上限 5 列 → 只能放 2 个汉字（4 列）+ 省略号（1 列）
  const out = clipToWidth("中文字符串", 5);
  assert.equal(out, "中文…");
  assert.ok(displayWidth(out) <= 5, `实际宽度 ${displayWidth(out)} 超过 5`);
  // 反证：按码元切的写法会给出 4 个汉字 = 8 列，超上限一倍
  assert.notEqual(out, "中文字符…");
});

test("clipToWidth: 给省略号留了列 —— 截断后不会反而更宽", () => {
  for (const max of [2, 3, 4, 7, 11, 20]) {
    const out = clipToWidth("中".repeat(50), max);
    assert.ok(
      displayWidth(out) <= max,
      `上限 ${max} 时给出宽度 ${displayWidth(out)}：${out}`
    );
  }
});

test("clipToWidth: 一行化 —— 换行与连续空白先压成单空格", () => {
  assert.equal(clipToWidth("a\nb", 10), "a b");
  assert.equal(clipToWidth("a\t\tb", 10), "a b");
  assert.equal(clipToWidth("  两边空白  ", 10), "两边空白");
});

test("clipToWidth: 坏输入不抛，且不会把内容整条吃掉", () => {
  assert.equal(clipToWidth(null as unknown as string, 10), "");
  assert.equal(clipToWidth(undefined as unknown as string, 10), "");
  // 上限非法 / 小到没有表达意义时退回兜底值 —— 不能吐出一个光秃秃的「…」
  assert.equal(clipToWidth("abc", NaN), "abc", "上限非法时用兜底值");
  assert.equal(clipToWidth("abc", -5), "abc");
  assert.equal(clipToWidth("abc", 0), "abc");
  assert.equal(clipToWidth("abc", 1), "abc", "1 列连省略号加一个字符都放不下");
});

test("对照：padRight 与 clipToWidth 用的是同一套宽度口径", () => {
  // 两个函数若各算一套宽度，一条被 padRight 补过再 clipToWidth 截的文本就会歪
  const s = "中文abc";
  const padded = padRight(s, 10);
  assert.equal(displayWidth(padded), 10);
  assert.equal(clipToWidth(padded, 10), "中文abc", "补出来的空格在截断时被压掉了，但不该改变内容");
});

// ============================================================
// panel —— 方框里每一行都必须等宽
// ============================================================
//
// 上一个是「截断按码元切」，这里是同一个陷阱的第二种形态：**补白按码元算**。
// 原先 panel 用的是 `stripAnsi(line).length`，而同文件的 renderHelp 早就在用
// `displayWidth` —— 于是启动时那个「就绪」面板（工作空间路径、/help 说明全是
// 中文）右边框随着每行的中文数量忽左忽右，而且不报任何错。
//
// 断言口径：把 panel 的输出抓下来，量**每一行的显示宽度**，要求只有唯一值。
// 不去写死「应该是 50 列」—— 那样改一次宽度就要改一次测试。

interface CapturedStdout {
  write: (chunk: string) => boolean;
  columns?: number;
}

/**
 * 抓 panel 写出的所有行。
 * `cols` 模拟终端列数（面板据此决定宽度上限与是否截断）。
 */
function drawPanel(content: string, title: string | undefined, cols: number): string[] {
  const out = process.stdout as unknown as CapturedStdout;
  const hadColumns = Object.getOwnPropertyDescriptor(out, "columns");
  const origWrite = out.write;
  const chunks: string[] = [];

  Object.defineProperty(out, "columns", { value: cols, configurable: true, writable: true });
  out.write = (chunk: string): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    panel(content, title, "green");
  } finally {
    out.write = origWrite;
    if (hadColumns) Object.defineProperty(out, "columns", hadColumns);
    else delete out.columns;
  }

  const text = chunks.join("");
  assert.ok(text.endsWith("\n"), "panel 的每一行都应以换行结尾（否则光标会停在框线上）");
  const lines = text.slice(0, -1).split("\n");
  assert.ok(lines.length >= 2, `panel 至少该有上下两条边框，实际只写了 ${lines.length} 行`);
  return lines;
}

/** 行宽不一致时的诊断信息 —— 直接看出是哪一行把框顶歪了 */
function widthReport(lines: string[]): string {
  return lines.map((l, i) => `  ${i} | ${String(displayWidth(l)).padStart(4)} | ${stripAnsi(l)}`).join("\n");
}

function distinctWidths(lines: string[]): number[] {
  return [...new Set(lines.map((l) => displayWidth(l)))];
}

test("★ panel: 每一行显示宽度相同（中文不能把右边框顶歪）", () => {
  // 内容照抄 main.ts 里那个真实启动面板
  const lines = drawPanel(
    "工作空间: /tmp/proj\n" +
      "当前窗口: #1\n\n" +
      "输入编程任务，Agent 将自动完成。\n" +
      "输入 /help 查看可用命令，/cd <路径> 切换项目。\n" +
      "↑/↓ 翻回敲过的内容，Tab 补全命令与路径。",
    "就绪",
    120
  );
  assert.deepEqual(distinctWidths(lines), [displayWidth(lines[0])], `面板行宽不一致：\n${widthReport(lines)}`);
  assert.equal(lines.length, 8, "6 行正文 + 上下两条边框");
});

test("★ panel: 终端够宽时一行内容都不能少（宽度算小了会静默截断）", () => {
  // 这条防的是「宽度算小」：内容宽度量少了 → width 变小 → inner 比正文还窄 →
  // 于是本该完整显示的行被 clipToWidth 截掉一截加省略号。**行仍然是等宽的**，
  // 上面那些断言一条都不会红 —— 用户只是发现自己的路径少了半截。
  const content = "工作空间: /tmp/proj\n输入 /help 查看可用命令，/cd <路径> 切换项目。";
  const lines = drawPanel(content, "就绪", 120);
  for (const raw of content.split("\n")) {
    assert.ok(
      lines.some((l) => stripAnsi(l).includes(raw)),
      `面板里找不到完整的一行「${raw}」—— 宽度被算小了，内容被截断吃掉\n${widthReport(lines)}`
    );
  }
  assert.equal(lines.some((l) => l.includes("…")), false, "终端 120 列装得下，不该出现截断标记");
});

test("★ panel: 有标题时标题行与正文行同宽（两处边框开销差 1 列）", () => {
  // 正文 `│ ` + 内容 + ` │` → 4 列开销；标题 `┌─ ` + 标题 + ` ` + 补线 + `┐` → 5 列。
  // 把标题也按 4 列算，标题那行就永远宽 1 列 —— 这正是修复前的样子。
  const cases: Array<[string, string]> = [
    ["短", "很长的标题在这里"], // 宽度由标题决定
    ["正文比标题长得多得多得多得多得多", "标题"], // 宽度由正文决定
    ["一样长吧", "一样长"], // 两者接近
  ];
  for (const [content, title] of cases) {
    const lines = drawPanel(content, title, 120);
    assert.deepEqual(
      distinctWidths(lines),
      [displayWidth(lines[0])],
      `内容「${content}」+ 标题「${title}」时行宽不一致：\n${widthReport(lines)}`
    );
  }
});

test("panel: 无标题时上下边框与正文同宽", () => {
  const lines = drawPanel("abc\n中文内容", undefined, 120);
  assert.deepEqual(distinctWidths(lines), [displayWidth(lines[0])], widthReport(lines));
  assert.match(stripAnsi(lines[0]), /^┌─+┐$/, "无标题的上边框不该带标题槽");
  assert.match(stripAnsi(lines[lines.length - 1]), /^└─+┘$/);
});

test("panel: 标题带绘文字时仍然等宽（📋 占 2 列）", () => {
  // 标题要长到能越过 20 列的宽度下限，否则两个标题都会被下限截平，比不出差别
  const withEmoji = drawPanel("内容", bold(blue("📋 剪贴板规则导出与导入")), 120);
  assert.deepEqual(distinctWidths(withEmoji), [displayWidth(withEmoji[0])], widthReport(withEmoji));
  // 与纯文本标题对照：宽度必须真的多了绘文字那 2 列 + 一个空格，否则说明没量进去
  const plainTitle = drawPanel("内容", "剪贴板规则导出与导入", 120);
  assert.equal(displayWidth(withEmoji[0]) - displayWidth(plainTitle[0]), 3, "📋（2 列）+ 一个空格（1 列）");
});

test("panel: 终端比内容窄时按显示宽度截断，且不超终端宽度", () => {
  const lines = drawPanel("中".repeat(100), "标题", 40);
  for (const l of lines) {
    assert.ok(displayWidth(l) <= 40, `超出终端宽度 40：${displayWidth(l)} | ${stripAnsi(l)}`);
  }
  // 超宽内容必须被截断：折行会让框的下边框跑到屏幕外面，比截断更难看出问题
  assert.ok(lines.some((l) => l.includes("…")), "超宽内容应被截断");
  assert.deepEqual(distinctWidths(lines), [displayWidth(lines[0])], widthReport(lines));
});

test("panel: 空内容 / 空标题也给一个合法方框，不抛", () => {
  for (const title of [undefined, "标题"]) {
    const lines = drawPanel("", title, 120);
    assert.equal(lines.length, 3, `应是上框 + 1 行正文 + 下框，实际 ${lines.length} 行`);
    assert.deepEqual(distinctWidths(lines), [displayWidth(lines[0])], widthReport(lines));
    assert.match(stripAnsi(lines[2]), /^└─+┘$/);
  }
});

test("panel: content 传 null / undefined 不抛（旧实现是 content.split 直接 TypeError）", () => {
  assert.doesNotThrow(() => drawPanel(null as unknown as string, undefined, 120));
  assert.doesNotThrow(() => drawPanel(undefined as unknown as string, undefined, 120));
});

test("★ 反证：按码元长度补白会给出不等宽的行（这就是修复前的形态）", () => {
  const lines = drawPanel("工作空间: /tmp/proj\n当前窗口: #1", "就绪", 120);
  const width = displayWidth(lines[0]);
  const line = "当前窗口: #1";
  // 复刻修复前的写法：宽度按 stripAnsi(...).length 算
  const naive = `│ ${line}${" ".repeat(Math.max(0, width - 4 - stripAnsi(line).length))} │`;
  assert.notEqual(
    displayWidth(naive),
    width,
    "按码元补白竟然也同宽 —— 说明这条反证挑的行不含中文，测试要重写"
  );
  // 换成显示宽度补白才对得上
  const fixed = `│ ${line}${" ".repeat(Math.max(0, width - 4 - displayWidth(line)))} │`;
  assert.equal(displayWidth(fixed), width);
});

test("displayWidth: 常用绘文字算 2 列（📋 / 🔌 用在面板标题上）", () => {
  assert.equal(displayWidth("📋"), 2);
  assert.equal(displayWidth("🔌"), 2);
  assert.equal(displayWidth("📋 任务计划"), 11, "2 + 1 空格 + 4 个汉字 × 2");
});

test("displayWidth: 明确不覆盖 U+2600–U+27BF —— ⚡ 仍然按 1 列算", () => {
  // 这批符号既有 emoji 呈现也有文本呈现，各家终端宽度不一致。本仓库只把它们
  // 放在自然句子里（banner 的 ⚡），所以宁可算 1 也不乱猜。这条是钉子：
  // 谁要改都得先承认 ⚡ 会进方框 —— 那时该做的是改用法，不是改宽度表。
  assert.equal(displayWidth("⚡"), 1);
  assert.equal(displayWidth("✅"), 1);
  assert.equal(displayWidth("⚠"), 1);
  assert.equal(displayWidth("  ⚡ Virtual Code Agent (VCA)"), 28);
});

test("★ 结构锁: panel 的宽度只走 displayWidth，不得回到 stripAnsi(...).length", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "ui.ts"), "utf-8");
  const start = src.indexOf("export function panel(");
  assert.ok(start >= 0, "找不到 panel —— 改名了？这条锁需要跟着改");
  const next = src.indexOf("export function", start + 1);
  const body = src.slice(start, next > start ? next : undefined);

  assert.equal(
    /stripAnsi\([^)]*\)\s*\.length/.test(body),
    false,
    "panel 里又出现按码元算宽度了 —— 中文行会把右边框顶歪（上面那几条会红）"
  );
  assert.ok(
    (body.match(/displayWidth\(/g) ?? []).length >= 3,
    "panel 里量宽度的调用少于 3 处 —— 可能有一处又改回按码元算了"
  );
  assert.ok(body.includes("clipToWidth("), "panel 不再截断超宽行 —— 窄终端里框会被折行顶散");
});

// ============================================================
// ANSI 安全 —— 带颜色的字符串不能当纯文本做宽度运算
// ============================================================
//
// 上面那一整套「按显示宽度」的口径，在**带颜色的行**上会整体失效：转义序列
// 被当成一个个可见字符。这不是离题 —— `renderMarkdown` 输出给 `panel` 的
// 内容**每一行都带颜色**（标题 cyan+bold、行内代码 cyan、加粗 bold），
// 所以面板在窄终端里截断时必然踩到。实测修复前三种表现：
//   ① `clipToWidth(cyan("a"×10), 6)` → `"\x1b[36m…"`
//      —— 10 个字符**全被吃掉**，只留一个青色省略号
//   ② 窄框下 break 落进序列内部 → `"\x1b[1m\x1b[3…"`
//      —— 半个序列写进终端，终端把它当正文，会吞掉后面几个字符
//   ③ 截断丢掉原文的 RESET → 颜色泄漏到省略号、框线乃至下一行
//
// 断言口径统一是：**把完整的 SGR 序列全部剥掉后，不得残留 `\x1b`**。
// 残留即说明某个序列被切开了。（这条比「比对期望字符串」更抗重构 ——
// 只要序列完整、宽度不超，中间怎么拼接都算通过。）

/** 剥掉完整的 SGR 序列后仍残留转义字符 = 某个序列被拦腰切开 */
function hasTornAnsi(s: string): boolean {
  return s.replace(/\x1b\[[0-9;]*m/g, "").includes("\x1b");
}

test("clipToWidth: 没超上限时原样返回 —— 不给带颜色的行补多余的 RESET", () => {
  const s = cyan("ab");
  assert.equal(clipToWidth(s, 10), s, "没超就不该动内容（补 RESET 会让调用方拿到不一样的串）");
});

test("★ clipToWidth: 带颜色的长行不能把内容整条吃掉", () => {
  const out = clipToWidth(cyan("a".repeat(10)), 6);
  assert.equal(stripAnsi(out), "aaaaa…", "5 个字符 + 省略号（上限 6 列，给省略号留 1 列）");
  assert.ok(displayWidth(out) <= 6, `实际宽度 ${displayWidth(out)} 超过 6`);
  assert.equal(hasTornAnsi(out), false, `转义序列被切开：${JSON.stringify(out)}`);
});

test("★ 反证：逐字符算宽度的旧写法会把带颜色的行整条吃掉", () => {
  // 复刻修复前的实现：对整个字符串 `for (const ch of s)`，转义序列的每个
  // 字符（`\x1b` `[` `3` `6` `m`）都各算 1 列。这条不红就说明反证挑的样本不对。
  const naive = (s: string, max: number): string => {
    let width = 0;
    let out = "";
    for (const ch of s) {
      width += displayWidth(ch);
      if (width > max - 1) break;
      out += ch;
    }
    return out + "…";
  };
  const bad = naive(cyan("a".repeat(10)), 6);
  assert.equal(stripAnsi(bad), "…", "旧写法确实把 10 个字符全吃掉了（这就是修复前的形态）");
  assert.notEqual(stripAnsi(clipToWidth(cyan("a".repeat(10)), 6)), "…", "新实现必须留下内容");
});

test("★ clipToWidth: 各种截断点都不切开转义序列", () => {
  const samples = [
    cyan("a".repeat(20)),
    bold(cyan("中文标题很长的样子")),
    yellow("x".repeat(30)) + "混合" + cyan("y".repeat(30)),
  ];
  for (const s of samples) {
    for (const max of [2, 3, 5, 8, 13, 21]) {
      const out = clipToWidth(s, max);
      assert.equal(hasTornAnsi(out), false, `上限 ${max} 时切坏了序列：${JSON.stringify(out)}`);
      assert.ok(displayWidth(out) <= max, `上限 ${max} 时给出宽度 ${displayWidth(out)}`);
    }
  }
});

test("clipToWidth: 截断点前补 RESET —— 颜色不泄漏给省略号与框线", () => {
  const out = clipToWidth(yellow("x".repeat(30)), 7);
  assert.equal(stripAnsi(out), "xxxxxx…");
  assert.ok(
    out.includes("\x1b[0m…"),
    `截断点的省略号没有收尾 —— 终端里颜色会一直渗到方框边框和下一行：${JSON.stringify(out)}`
  );
  assert.equal(hasTornAnsi(out), false);
});

test("★ panel: 窄终端里截断带颜色的行，不切坏序列、不泄漏颜色", () => {
  // 端到端：panel(renderMarkdown(...)) 是真实调用形态，Markdown 那侧每行都带颜色
  const md = renderMarkdown("## " + "中文很长的标题内容".repeat(8));
  assert.ok(md.includes("\x1b["), "renderMarkdown 的标题行应当带颜色，否则这条测不到 ANSI");
  const lines = drawPanel(md, "标题", 30);
  for (const l of lines) {
    assert.equal(hasTornAnsi(l), false, `转义序列被切开：${JSON.stringify(l)}`);
    assert.ok(displayWidth(l) <= 30, `超出终端宽度 30：${displayWidth(l)} | ${stripAnsi(l)}`);
  }
  assert.deepEqual(distinctWidths(lines), [displayWidth(lines[0])], widthReport(lines));
  assert.ok(lines.some((l) => l.includes("…")), "超宽内容应被截断（否则这条没走到截断分支）");
});

// ============================================================
// renderMarkdown —— 行内代码与加粗不能互相污染
// ============================================================
//
// 原先分两次 replace：先渲染行内代码，再匹配加粗。第一次已经把 ANSI 序列
// 写进了中间结果，第二次的正则照样会扫到 —— 于是**行内代码里的字面星号**
// 被当成加粗标记。（写「加粗怎么写」的说明里，`**` 正是最常见的示例字符。）

test("★ renderMarkdown: 反引号里的字面星号不加粗", () => {
  const out = renderMarkdown("用 `**p**` 表示加粗");
  assert.equal(out, `用 ${cyan("**p**")} 表示加粗`);
  assert.equal(out.includes("\x1b[1m"), false, "行内代码里的 ** 被当成加粗标记了");
});

test("renderMarkdown: 行内代码里的 ** 也不加粗（命令 / 路径里常见）", () => {
  const out = renderMarkdown("`npm run a**b**c` 这句不该有加粗");
  assert.equal(out, `${cyan("npm run a**b**c")} 这句不该有加粗`);
  assert.equal(out.includes("\x1b[1m"), false);
});

test("renderMarkdown: 真正的加粗与行内代码各归各", () => {
  const out = renderMarkdown("**真的加粗** 与 `code` 各归各");
  assert.equal(out, `${bold("真的加粗")} 与 ${cyan("code")} 各归各`);
});

test("renderMarkdown: 标题 / 代码块 / 普通行的基本形态不变", () => {
  assert.equal(renderMarkdown("## 标题"), bold(cyan("标题")));
  assert.equal(
    renderMarkdown("```\nlet a = 1;\n```"),
    dim("let a = 1;"),
    "代码块整块 dim，且围栏行本身不输出"
  );
  assert.equal(renderMarkdown("普通一行"), "普通一行");
  assert.equal(renderMarkdown(""), "");
});

// ============================================================
// renderMarkdown —— 表格
// ============================================================
//
// 此前 `|` 表格整块原样输出。实测过的原状：同一张四行表，竖线分别落在
// 0,7,14,21 / 0,13,22,31 / 0,9,19,26 列 —— Markdown 原文按**码元**补空格，
// 而中文一个字占 2 列，面板的右边框又按显示宽度算，两者叠加，表就散了。

/** 一行里每个 `|` 所在的列（按显示宽度累计，ANSI 不计） */
function barCols(line: string): number[] {
  const cols: number[] = [];
  let w = 0;
  for (const ch of stripAnsi(line)) {
    if (ch === "|") cols.push(w);
    w += displayWidth(ch);
  }
  return cols;
}

const TABLE_MD = [
  "| 项目 | 类型 | 说明 |",
  "|---|---|---|",
  "| foo | string | 第一个参数，必填 |",
  "| barbazlong | number | 第二个 |",
  "| 中文名 | boolean | 可选 |",
].join("\n");

test("★ renderMarkdown: 表格里中文列也对齐（每行竖线落在同一列）", () => {
  const lines = renderMarkdown(TABLE_MD).split("\n");
  const first = barCols(lines[0]);
  assert.ok(first.length >= 4, `没渲染成表格：${JSON.stringify(lines[0])}`);
  for (const l of lines) {
    assert.deepEqual(barCols(l), first, `竖线没对齐：${JSON.stringify(stripAnsi(l))}`);
  }
  // 竖线对齐了但行尾多一截空格，在面板里看仍然歪 —— 宽度也要一致
  assert.deepEqual(distinctWidths(lines), [displayWidth(lines[0])], widthReport(lines));
});

test("renderMarkdown: 表格分隔行按列宽重画，不是原样打出 `---`", () => {
  const lines = renderMarkdown(TABLE_MD).split("\n");
  // 原样透传的话，这一行会与 Markdown 原文逐字相同（`|---|---|---|`）——
  // 而列宽是 10 / 7 / 16，分隔线必须跟着变长才对得上。
  assert.notEqual(
    stripAnsi(lines[1]),
    "|---|---|---|",
    "分隔行原样输出了，没按列宽重画"
  );
  assert.deepEqual(barCols(lines[1]), barCols(lines[0]), "分隔行的竖线没跟表头对齐");
  assert.ok(stripAnsi(lines[1]).includes("-----"), `分隔行应当按列宽补长：${JSON.stringify(stripAnsi(lines[1]))}`);
  // 表头加粗：一眼能分出表头与数据行
  assert.ok(lines[0].includes("\x1b[1m"), "表头应当加粗");
});

test("★ renderMarkdownTable: 输出仍是合法表格 —— 已经对齐，再渲染一遍不再变", () => {
  const once = renderMarkdown(TABLE_MD);
  // 去掉颜色再喂回去：等价于「从终端复制出来粘回 Markdown 文件」
  const twice = renderMarkdownTable(stripAnsi(once).split("\n"));
  assert.notEqual(twice, null, "自己渲染出来的表格自己认不出来");
  assert.equal(stripAnsi(twice!.join("\n")), stripAnsi(once), "已经对齐的表格再渲染一遍内容变了");
});

test("renderMarkdown: 分隔行格数与表头不一致时不当表格（宁可原样输出）", () => {
  const md = "| a | b |\n|---|---|---|\n| 1 | 2 |";
  assert.equal(renderMarkdown(md), md, "列数对不上的表格应当原样输出，而不是猜哪列到哪");
  assert.equal(renderMarkdownTable(["| a | b |", "|---|---|---|"]), null);
  assert.equal(renderMarkdownTable(["| a | b |"]), null, "只有表头、没有分隔行不算表");
  assert.equal(renderMarkdownTable([]), null, "空输入不崩");
});

test("★ renderMarkdown: 带竖线的命令行不会被当成表格吃掉", () => {
  // 真实场景：`ps aux | grep node |` 这类命令经常以 `|` 收尾，挨着的两条又常常
  // 一条带 `-`（`-5` / `--oneline`）。判据一旦放宽成「以竖线开头结尾」就够了，
  // 这两行会被拼成一张两列表格 —— 命令变成表头，参数变成数据。
  const md = [
    "| 字段 | 含义 |",
    "|---|---|",
    "| pid | 进程号 |",
    "",
    "ps aux | grep node |",
    "git log --oneline -5 | head |",
  ].join("\n");
  const out = renderMarkdown(md).split("\n");
  assert.equal(out[out.length - 1], "git log --oneline -5 | head |", "命令行被当成表格吃掉了");
  assert.equal(out[out.length - 2], "ps aux | grep node |", "命令行被当成表格吃掉 / 被并进表格了");
  assert.equal(out[out.length - 3], "", "表格后的空行不该被吃掉");

  // 分隔行的判据必须是「只有 | 空格 : - 这几种字符」。
  // 只要求「像表格行 + 含 -」的话，上面那两行就会通过 —— 这条断言盯的就是这个边界。
  assert.equal(
    renderMarkdownTable(["ps aux | grep node |", "git log --oneline -5 | head |"]),
    null,
    "两行命令行被当成了表格（分隔行判据太松）"
  );
  assert.equal(renderMarkdownTable(["| a | b |", "| x-y | z |"]), null, "带字母的行不算分隔行");

  // 没有分隔行就压根不是表格
  const md2 = ["ps aux | grep node |", "第二行普通文本 | 也带竖线 |"].join("\n");
  assert.equal(renderMarkdown(md2), md2, "没有分隔行就不该有表格");
});

test("renderMarkdown: 代码块里的表格原样保留（不渲染）", () => {
  const md = ["```", "| a | b |", "|---|---|", "| 1 | 2 |", "```"].join("\n");
  const lines = renderMarkdown(md).split("\n");
  assert.deepEqual(lines, [dim("| a | b |"), dim("|---|---|"), dim("| 1 | 2 |")]);
});

test("renderMarkdown: 表格支持 :-- / :-: / --: 三种对齐", () => {
  const md = ["| 左边列 | 中间列 | 右边列 |", "|:---|:--:|---:|", "| a | b | c |"].join("\n");
  const lines = renderMarkdown(md).split("\n");
  // 列宽都是 6：左对齐右边补空格、居中两侧各 2 与 3、右对齐左边补 5
  assert.equal(stripAnsi(lines[2]), "| a      |   b    |      c |", `对齐没生效：${JSON.stringify(stripAnsi(lines[2]))}`);
  assert.deepEqual(distinctWidths(lines), [displayWidth(lines[0])], widthReport(lines));
});

test("★ renderMarkdown: 表格单元格的行内代码 / 加粗与正文同一套规则", () => {
  const md = ["| 项 | 值 |", "|---|---|", "| `npm run x` | **必填** |"].join("\n");
  const row = stripAnsi(renderMarkdown(md)).split("\n")[2];
  assert.equal(row.includes("`"), false, "单元格里的行内代码没被渲染成颜色");
  const colored = renderMarkdown(md).split("\n")[2];
  assert.ok(colored.includes(cyan("npm run x")), "单元格里的行内代码应当是青色（与正文同一套规则）");
  assert.ok(colored.includes(bold("必填")), "单元格里的加粗应当加粗");
});

test("renderMarkdown: 表格里的 \\| 是转义过的竖线，不该把一格切成两格", () => {
  const md = ["| 表达式 | 含义 |", "|---|---|", "| a \\| b | 或 |"].join("\n");
  const lines = renderMarkdown(md).split("\n");
  const bare = stripAnsi(lines[2]);
  assert.ok(bare.includes("a | b"), `转义的竖线应当还原成竖线本身：${JSON.stringify(bare)}`);
  // 表头 3 个边界竖线，数据行只该多出「格内那一个字面竖线」= 4。
  // 不处理转义的话这里会等于 3，同时格数从 2 变 3 —— 「或」会被挤到不存在的列里静默丢掉。
  assert.equal(
    barCols(bare).length,
    barCols(stripAnsi(lines[0])).length + 1,
    `格数变了：转义的竖线被当成列分隔符 —— ${JSON.stringify(bare)}`
  );
});

test("renderMarkdown: 空单元格与尾随空格不破坏对齐", () => {
  const md = ["| a | b |  |", "|---|---|---|", "|  | 2 | 3 |", "| 1 |  |  |"].join("\n");
  const lines = renderMarkdown(md).split("\n");
  assert.deepEqual(distinctWidths(lines), [displayWidth(lines[0])], widthReport(lines));
  assert.deepEqual(barCols(lines[3]), barCols(lines[0]));
});

// ============================================================
// 结构锁 —— 扫源码前必须先剥注释
// ============================================================
//
// 这一节读 `src/ui.ts` 的源码文本。踩过的坑：`clipToWidth` 里那条
// 「为什么不能直接 `for (const ch of text)`」的**注释**，被锁当成了实现 ——
// 于是锁在已经修好的代码上红了。在注释里写反面示例是好事，锁必须绕开它。

/** 剥掉注释再扫（只够本文件用：ui.ts 的字符串里没有 `//`） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** 取某个导出函数的函数体源码，已剥注释 */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `找不到 ${signature} —— 改名了？这条锁需要跟着改`);
  const next = src.indexOf("\nexport function", start + 1);
  return stripComments(src.slice(start, next > start ? next : undefined));
}

test("★ 结构锁: 行内代码与加粗（renderInline，正文与表格共用）只扫一次", () => {
  const body = functionBody(
    fs.readFileSync(path.join(ROOT, "src", "ui.ts"), "utf-8"),
    "export function renderInline("
  );
  const WHY = "上一次 replace 插入的 ANSI 会被下一次当成正文（反引号里的 ** 会被加粗）";

  // 唯一的正向判据：两个分支必须在同一条正则的交替里。
  // **不数 `.replace(` 的个数** —— 标题分支自己也要 replace 一次，数量不是重点。
  assert.ok(
    body.includes("`[^`]+`|\\*\\*[^*]+\\*\\*"),
    `行内代码与加粗必须写在同一条正则的交替分支里：${WHY}`
  );
  // 反向：一旦有人改回两次 replace，源码里就会出现「只匹配加粗」或「只匹配行内代码」的独立正则
  assert.equal(body.includes("**([^*]+)**"), false, `又出现只匹配加粗的独立正则 —— ${WHY}`);
  assert.equal(body.includes("`([^`]+)`"), false, `又出现只匹配行内代码的独立正则 —— ${WHY}`);
});

test("★ 结构锁: 行内渲染只有一份，renderMarkdown 不得自己再写一份", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "ui.ts"), "utf-8");
  const body = functionBody(src, "export function renderMarkdown(");

  // 表格单元格与正文必须共用同一条规则。各写一份的话，同一段 Markdown
  // 在正文里是青色、在表格里就是原文 —— 而两边都不会报错。
  assert.equal(
    body.includes("`[^`]+`"),
    false,
    "renderMarkdown 里又出现了行内渲染正则 —— 它应该只调 renderInline"
  );
  assert.ok(body.includes("renderInline("), "renderMarkdown 必须通过 renderInline 渲染普通行");
  // 表格那侧同理：列宽必须由 renderMarkdownTable 统一算，不能在这里另算一遍
  assert.ok(body.includes("renderMarkdownTable("), "表格分支必须调 renderMarkdownTable");
});

test("★ 结构锁: 表格列宽按显示宽度算，且不再有第二套 Markdown 渲染入口", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "ui.ts"), "utf-8");
  const table = functionBody(src, "export function renderMarkdownTable(");

  assert.ok(table.includes("displayWidth("), "列宽必须按 displayWidth 算（按 length 算中文列会歪）");
  assert.equal(
    /\.length\s*[-+*/)]/.test(table.replace(/rows\.length|header\.length|cols|sep\.length|lines\.length/g, "")),
    false,
    "表格里不该拿 .length 当宽度参与运算"
  );
  assert.ok(table.includes("padCell("), "补空格必须走 padCell（displayWidth 口径）");

  // 全文件只允许一个 markdown 渲染入口：renderMarkdown。
  // 新增第二个（比如给表格单独开一个）必然漂移。
  const entries = src.match(/export function render\w*\(\s*text:/g) ?? [];
  assert.deepEqual(entries, ["export function renderMarkdown(text:"], `markdown 渲染入口多了一个：${entries}`);
});

test("★ 结构锁: clipToWidth 必须按 SGR 切段，不得对整个字符串逐字符遍历", () => {
  const body = functionBody(
    fs.readFileSync(path.join(ROOT, "src", "ui.ts"), "utf-8"),
    "export function clipToWidth("
  );

  assert.equal(
    /for \(const ch of text\)/.test(body),
    false,
    "又对整个字符串逐字符遍历了 —— 转义序列会被按字符算宽度、还会被切开"
  );
  assert.ok(
    /SGR_RE|x1b/.test(body),
    "clipToWidth 里没有任何 ANSI 处理 —— 面板内容每行都带颜色，这样会把内容整条吃掉"
  );
  assert.ok(body.includes("matchAll("), "扫不出转义序列的位置，就没法保证不切开它");
});
