/**
 * 输入历史（↑/↓ 翻回敲过的内容）的测试。
 *
 * 这里没有 readline、也没有终端 —— 被测的是「文件 ↔ 内存」的转换与去重规则，
 * 全是纯函数 + 一个临时文件，所以能在 CI / 无 TTY 环境里跑。
 *
 * 重点锁住的是**方向**：文件里最早在前、内存里最新在前。这是本模块唯一
 * 容易写反的地方，而写反的症状很隐蔽 —— 历史能用，只是顺序反了：
 * ↑ 先翻到最老的那条，而且超上限时丢掉的会是最新的那条。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  HISTORY_MAX,
  SHOW_DEFAULT,
  clearHistory,
  formatHistory,
  normalizeEntry,
  parseHistory,
  parseInputArg,
  pushHistory,
  readHistory,
  selectHistory,
  writeHistory,
} from "../src/input-history.js";

function tmpFile(name = "input_history"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-hist-"));
  return path.join(dir, name);
}

// ============================================================
// normalizeEntry
// ============================================================

test("normalizeEntry: 多行粘贴压成单行（readline 一次只给一行）", () => {
  assert.equal(normalizeEntry("第一行\n第二行"), "第一行 第二行");
  assert.equal(normalizeEntry("a\r\nb"), "a b");
  assert.equal(normalizeEntry("  两边空白  "), "两边空白");
});

test("normalizeEntry: 空 / null / undefined 都归一为「无内容」", () => {
  for (const v of ["", "   ", "\n", "\r\n", null, undefined]) {
    assert.equal(normalizeEntry(v), "", `${JSON.stringify(v)} 应归一为空`);
  }
});

// ============================================================
// parseHistory —— 文件 → 内存
// ============================================================

test("★ parseHistory: 文件里最早在前，内存里最新在前", () => {
  const text = ["最早", "中间", "最新"].join("\n") + "\n";
  assert.deepEqual(parseHistory(text), ["最新", "中间", "最早"]);
});

test("★ parseHistory: 读 prompt_toolkit 写出的真实文件（`+` 前缀 + `#` 时间戳 + 空行）", () => {
  // 逐字节照抄 ~/.vca/input_history 里的真实形态（Python 版留下的）：
  // 每条是 `+<内容>`，条目之间是「空行 + `# 时间戳` + 空行」。
  // ⚠ 断言里必须有「一条都不以 `+` 开头」—— 少了 `+` 的前缀剥离，
  // ↑ 翻出来的每条历史前面都会挂一个 `+`（本仓库实测 21/21 条如此）。
  const text = [
    "",
    "# 2026-08-11 10:27:28.049413",
    "+/help",
    "",
    "# 2026-08-11 10:27:37.040194",
    "+/help ",
    "",
    "# 2026-08-11 10:37:52.890992",
    "+hi",
    "",
    "# 2026-08-11 10:38:12.383480",
    "+你是谁？",
    "",
  ].join("\n");
  const parsed = parseHistory(text);
  assert.deepEqual(parsed, ["你是谁？", "hi", "/help", "/help"]);
  assert.deepEqual(
    parsed.filter((e) => e.startsWith("+")),
    [],
    "`+` 只是 prompt_toolkit 的标记，不能留在内容里"
  );
});

test("★ parseHistory: prompt_toolkit 的多行条目（连续多行 `+`）合成一条", () => {
  // prompt_toolkit 存多行输入时是每行都加一个 `+`，中间没有分隔行
  const text = ["# 2026-08-11 10:27:28.049413", "+第一行", "+第二行", "", "+单行", ""].join("\n");
  assert.deepEqual(parseHistory(text), ["单行", "第一行 第二行"]);
});

test("★ parseHistory: `+# 日期` 是用户真敲过的输入，不能因为剥了前缀就像注释而被吃掉", () => {
  // 顺序陷阱：先判注释再剥 `+` 的话，这条真实输入会被当成时间戳注释
  const text = ["+# 2026-01-01 的计划", "# 2026-01-01 10:00:00.000000", "+普通一条"].join("\n");
  assert.deepEqual(parseHistory(text), ["普通一条", "# 2026-01-01 的计划"]);
});

test("★ parseHistory: 用户真的敲过 `# 注释` 时不能被当成时间戳吃掉", () => {
  const text = ["# 这是个真注释", "# 2026-08-11 10:27:28.049413", "# 123 也算注释吗"].join("\n");
  // 第 1、3 行不是 `# 日期` 形态 → 是真实输入；第 2 行是时间戳 → 跳过
  assert.deepEqual(parseHistory(text), ["# 123 也算注释吗", "# 这是个真注释"]);
});

test("parseHistory: 空行与纯空白行不产生条目", () => {
  assert.deepEqual(parseHistory("\n\n   \n"), []);
  assert.deepEqual(parseHistory(""), []);
  assert.deepEqual(parseHistory(null), []);
  // 只有分隔符、没有任何条目的文件也必须是空的
  assert.deepEqual(parseHistory("\n# 2026-08-11 10:27:28.049413\n\n"), []);
  assert.deepEqual(parseHistory("+\n+\n"), []);
});

test("parseHistory: 超过上限时保留最新的那批（不是最旧的）", () => {
  // 文件里最早在前，所以最早的排在最上面、最新的在最后
  const text = Array.from({ length: HISTORY_MAX + 20 }, (_, i) => `cmd-${i}`).join("\n");
  const parsed = parseHistory(text);
  assert.equal(parsed.length, HISTORY_MAX);
  assert.equal(parsed[0], `cmd-${HISTORY_MAX + 19}`, "内存第一条必须是最新的");
  assert.equal(parsed[parsed.length - 1], `cmd-20`, "最旧的 20 条应被丢掉");
});

// ============================================================
// formatHistory —— 内存 → 文件
// ============================================================

test("★ formatHistory: 内存最新在前 → 文件最早在前，每条带 `+` 前缀、空行分隔", () => {
  assert.equal(formatHistory(["最新", "中间", "最早"]), "+最早\n\n+中间\n\n+最新\n");
});

test("★ formatHistory: 每条都带 `+` 前缀，且条目之间有非 `+` 行", () => {
  const text = formatHistory(["a", "b c", "+86 138"]);
  const nonEmpty = text.split("\n").filter((l) => l !== "");
  for (const line of nonEmpty) {
    assert.ok(line.startsWith("+"), `「${line}」缺 + 前缀 —— prompt_toolkit 会把整行当分隔符丢掉`);
  }
  // 用户自己敲的 `+86…` 落盘成 `++86…` 是对的：读回来剥一层正好还原。
  // 不这么写，Python 版读到它只会当成一个空的分隔行。
  assert.ok(text.includes("++86 138"), "以 `+` 开头的输入必须再补一层前缀");
  // 相邻两条之间必须有一个空行 —— 否则 prompt_toolkit 会把它们并成一条
  assert.equal(text, "++86 138\n\n+b c\n\n+a\n");
});

test("formatHistory: 空列表写出空串（不留一个孤零零的换行）", () => {
  assert.equal(formatHistory([]), "");
  assert.equal(formatHistory(["", "   "]), "", "全空白的条目要被过滤掉");
});

test("★ 往返一致：formatHistory → parseHistory 不改变内容与顺序", () => {
  const mem = ["/cd E:\\agent\\VirtualCodeAgent", "帮我看看这个报错的根因", "/model deepseek"];
  assert.deepEqual(parseHistory(formatHistory(mem)), mem);
});

test("★ 往返幂等：已经写出去的文件再读再写，字节完全不变", () => {
  const mem = ["a", "b", "c", "d"];
  const once = formatHistory(mem);
  const twice = formatHistory(parseHistory(once));
  assert.equal(twice, once, "第二次写出的内容必须与第一次逐字节相同");
});

test("★ 往返一致：prompt_toolkit 的文件 → 内存 → 文件，再读回来还是同一批", () => {
  // 这是缺陷 A 的锁：不剥 `+` 的话第一批就是 `+/help` 这种，再往返一次会
  // 变成 `++/help`，越走越歪 —— 断言「两轮之后内容不变」能一次抓住。
  const ptkText = [
    "",
    "# 2026-08-11 10:27:28.049413",
    "+/help",
    "",
    "# 2026-08-11 10:37:52.890992",
    "+hi",
    "",
  ].join("\n");
  const first = parseHistory(ptkText);
  const second = parseHistory(formatHistory(first));
  assert.deepEqual(second, first);
  assert.deepEqual(second, ["hi", "/help"]);
});

// ============================================================
// 与 Python 版共用同一个文件 —— 跨语言格式契约
// ============================================================
//
// 「两边能互相读回来」是 README 与模块头注释都写着的承诺，而它以前是假的：
// TS 版既没剥 `+` 前缀、也不写分隔行。判断这件事只有一种办法 ——
// **用 prompt_toolkit 自己的读取算法跑一遍**。下面这个函数逐行照抄自
// prompt_toolkit/history.py 的 FileHistory.load_history_strings()
// （src/prompt_toolkit/history.py，3.0 起未变），只把 Python 语法转成 JS。
// 改这个函数就等于改契约 —— 它不是「我们的实现」，是**对方的实现**。

/** prompt_toolkit FileHistory 的读取算法（照抄官方实现，勿改） */
function ptLoadHistoryStrings(text: string): string[] {
  const strings: string[] = [];
  let lines: string[] = [];
  const add = (): void => {
    if (lines.length) {
      // Join and drop trailing newline.
      strings.push(lines.join("").slice(0, -1));
    }
    lines = [];
  };
  for (const raw of text.split("\n").slice(0, -1)) {
    // 复刻 `for line_bytes in f`：每行**保留**结尾的换行符
    const line = raw + "\n";
    if (line.startsWith("+")) lines.push(line.slice(1));
    else add();
  }
  add();
  return strings.reverse(); // 官方返回 reversed(strings)：最新在前
}

test("★ 跨语言契约：TS 写出的文件，prompt_toolkit 读回完全相同的条目", () => {
  const mem = [
    "/cd E:\\agent\\VirtualCodeAgent",
    "帮我看看这个报错的根因",
    "hi",
    "/help",
    "+86 13800000000",
    "# 2026-01-01 的计划",
  ];
  const asSeenByPython = ptLoadHistoryStrings(formatHistory(mem));
  assert.deepEqual(asSeenByPython, mem, "Python 版读回来的必须与内存里逐条相同");
});

test("★ 跨语言契约：条数不能缩水（少了分隔行会被并成一条多行历史）", () => {
  // 实测过：缺分隔行时 21 条会被 Python 读成 1 条 21 行的巨型条目 ——
  // 不报错，用户只觉得历史「没了」。条数是最先塌的那一环，单独锁一条。
  const mem = Array.from({ length: 21 }, (_, i) => `cmd-${i}`);
  const asSeenByPython = ptLoadHistoryStrings(formatHistory(mem));
  assert.equal(asSeenByPython.length, mem.length, "21 条进去必须 21 条出来");
  assert.deepEqual(asSeenByPython, mem);
});

test("★ 跨语言契约：prompt_toolkit 写出的文件，TS 读出来的内容里不带 `+`", () => {
  const ptkText = ["", "# 2026-08-11 10:27:28.049413", "+/help", "", "# 2026-08-11 10:37:52.890992", "+hi", ""].join("\n");
  // 先确认这份样本本身是 prompt_toolkit 认得的样子（否则下面的断言没有意义）
  assert.deepEqual(ptLoadHistoryStrings(ptkText), ["hi", "/help"]);
  assert.deepEqual(parseHistory(ptkText), ["hi", "/help"], "两个实现读同一份文件必须得到同一个结果");
});

test("★ 跨语言契约：TS 自己的旧文件（裸行，无 `+`）仍要能读回来", () => {
  // 本模块早期版本写出去的就是这种文件，用户机器上可能还躺着 —— 得兼容。
  // （prompt_toolkit 只会拿这种行当分隔符，所以「宽松读、严格写」不打架。）
  assert.deepEqual(parseHistory("旧一\n旧二\n"), ["旧二", "旧一"]);
  assert.equal(ptLoadHistoryStrings("旧一\n旧二\n").length, 0, "Python 版读不了裸行格式 —— 所以新写的必须是 `+` 形态");
});

// ============================================================
// readHistory / writeHistory
// ============================================================

test("readHistory: 文件不存在时返回空数组而不是抛异常", () => {
  assert.deepEqual(readHistory(path.join(os.tmpdir(), "vca-not-exist-xyz", "input_history")), []);
});

test("readHistory: 内容损坏（不是文本）时不抛异常", () => {
  const file = tmpFile();
  fs.writeFileSync(file, Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0a, 0x00]));
  assert.doesNotThrow(() => readHistory(file));
});

test("★ writeHistory → readHistory 往返一致（含中文与 Windows 反斜杠路径）", () => {
  const file = tmpFile();
  const mem = ["/cd E:\\agent\\VirtualCodeAgent", "把 README 里的 npm 命令都核对一遍"];
  writeHistory(file, mem);
  assert.deepEqual(readHistory(file), mem);
});

test("writeHistory: 目录不存在时自己建出来", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vca-hist-")), "deep", "input_history");
  writeHistory(file, ["x"]);
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(readHistory(file), ["x"]);
});

test("writeHistory: 目标不可写时不抛异常（历史存不下来不该拦住使用）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-hist-"));
  const asFile = path.join(dir, "occupied");
  fs.writeFileSync(asFile, "x");
  // 把文件当目录写 → 底层必然报错
  assert.doesNotThrow(() => writeHistory(path.join(asFile, "input_history"), ["x"]));
});

// ============================================================
// pushHistory
// ============================================================

test("★ pushHistory: 最新一条进队首", () => {
  const h = ["旧"];
  assert.equal(pushHistory(h, "新"), true);
  assert.deepEqual(h, ["新", "旧"]);
});

test("pushHistory: 空行不记（按住回车不该把历史刷满）", () => {
  const h: string[] = [];
  for (const v of ["", "   ", "\n"]) assert.equal(pushHistory(h, v), false, `「${v}」不该被记`);
  assert.deepEqual(h, []);
});

test("★ pushHistory: 与上一条完全相同不记，隔了一条的重复照记", () => {
  const h: string[] = [];
  pushHistory(h, "ls");
  assert.equal(pushHistory(h, "ls"), false, "连续重复应被折叠");
  assert.deepEqual(h, ["ls"]);

  pushHistory(h, "pwd");
  assert.equal(pushHistory(h, "ls"), true, "隔了一条的重复是常见的，要记");
  assert.deepEqual(h, ["ls", "pwd", "ls"]);
});

test("★ pushHistory: 超过上限丢最旧的、留最新的", () => {
  const h: string[] = [];
  for (let i = 0; i < 5; i++) pushHistory(h, `cmd-${i}`, 3);
  assert.deepEqual(h, ["cmd-4", "cmd-3", "cmd-2"]);
});

test("pushHistory: 默认上限是 HISTORY_MAX，且第 MAX+1 条不会把数组撑爆", () => {
  const h: string[] = [];
  for (let i = 0; i < HISTORY_MAX + 5; i++) pushHistory(h, `cmd-${i}`);
  assert.equal(h.length, HISTORY_MAX);
  assert.equal(h[0], `cmd-${HISTORY_MAX + 4}`);
  assert.equal(h[h.length - 1], "cmd-5");
});

test("pushHistory: 多行输入被压成单行后再存入", () => {
  const h: string[] = [];
  pushHistory(h, "第一行\n第二行");
  assert.deepEqual(h, ["第一行 第二行"]);
});

test("pushHistory: 归一化后与上一条相同也算重复（多个空格不该绕过去重）", () => {
  const h: string[] = [];
  pushHistory(h, "ls -la");
  assert.equal(pushHistory(h, "  ls -la  "), false);
  assert.deepEqual(h, ["ls -la"]);
});

// ============================================================
// parseInputArg —— /input 那个参数到底什么意思
// ============================================================
//
// 参数语义最容易在命令实现里再判一遍，然后两处慢慢分家（`/input 0` 一处当条数、
// 一处当关键字）。锁定这些边界的价值就在这里：它是唯一一处判定。

test("parseInputArg: 空参数 → 列默认条数、不过滤", () => {
  assert.deepEqual(parseInputArg(""), { kind: "list", limit: SHOW_DEFAULT, filter: "" });
  assert.deepEqual(parseInputArg("   "), { kind: "list", limit: SHOW_DEFAULT, filter: "" });
  assert.deepEqual(parseInputArg(null), { kind: "list", limit: SHOW_DEFAULT, filter: "" });
  assert.deepEqual(parseInputArg(undefined), { kind: "list", limit: SHOW_DEFAULT, filter: "" });
});

test("parseInputArg: 正整数是条数（两边空白不计）", () => {
  assert.deepEqual(parseInputArg("20"), { kind: "list", limit: 20, filter: "" });
  assert.deepEqual(parseInputArg("  35  "), { kind: "list", limit: 35, filter: "" });
});

test("parseInputArg: 条数被夹到 1..HISTORY_MAX（不是静默放行）", () => {
  // 「/input 0」的意图显然是条数，不是想找含 0 的历史
  assert.equal((parseInputArg("0") as { limit: number }).limit, 1);
  assert.equal((parseInputArg("9999") as { limit: number }).limit, HISTORY_MAX);
});

test("parseInputArg: clear 是清空（大小写、空白都不计较）", () => {
  assert.deepEqual(parseInputArg("clear"), { kind: "clear" });
  assert.deepEqual(parseInputArg("CLEAR"), { kind: "clear" });
  assert.deepEqual(parseInputArg("  Clear  "), { kind: "clear" });
});

test("parseInputArg: clear 后面的东西就不再是 clear 了", () => {
  assert.equal((parseInputArg("clearx") as { filter: string }).filter, "clearx");
  assert.equal((parseInputArg("clear now") as { filter: string }).filter, "clear now");
});

test("parseInputArg: 其余一律当关键字（含负数、小数、空格、中文）", () => {
  for (const k of ["redis", "redis 超时", "-3", "1e3", "20 30", "缓存"]) {
    const a = parseInputArg(k) as { kind: string; filter: string; limit: number };
    assert.equal(a.kind, "list", `${k} 应视为列表`);
    assert.equal(a.filter, k);
    assert.equal(a.limit, SHOW_DEFAULT, `${k} 当关键字时用默认条数`);
  }
});

// ============================================================
// selectHistory —— 从历史里挑出要显示的那一段
// ============================================================
//
// 顺序必须是「最新在前」：列表里的 1 要和 ↑ 的第一次翻页对上，
// 否则用户看着序号 1 去按 ↑ 得到的是别的东西。

const FIVE = ["e5", "e4", "e3", "e2", "e1"];

test("selectHistory: 顺序与 ↑ 一致（最新在前），不重排", () => {
  const sel = selectHistory(FIVE, { limit: 20 });
  assert.deepEqual(sel.shown, FIVE);
  assert.equal(sel.total, 5);
  assert.equal(sel.matched, 5);
});

test("selectHistory: 条数只截断不改序，并如实报告总数", () => {
  const sel = selectHistory(FIVE, { limit: 2 });
  assert.deepEqual(sel.shown, ["e5", "e4"]);
  assert.equal(sel.total, 5);
  assert.equal(sel.matched, 5, "matched 是命中数，不是显示数 —— 两件事");
});

test("selectHistory: 过滤是子串、不区分大小写", () => {
  const all = ["Redis 超时", "改样式", "redis 缓存策略", "加一个命令"];
  assert.deepEqual(selectHistory(all, { limit: 20, filter: "redis" }).shown, [
    "Redis 超时",
    "redis 缓存策略",
  ]);
  assert.deepEqual(selectHistory(all, { limit: 20, filter: "REDIS" }).shown, [
    "Redis 超时",
    "redis 缓存策略",
  ]);
  // 子串而不是前缀：记得住的往往是中间那个词
  assert.deepEqual(selectHistory(all, { limit: 20, filter: "缓存" }).shown, ["redis 缓存策略"]);
});

test("selectHistory: 过滤后条数不够时如实给出 matched（界面靠它说「还有 N 条」）", () => {
  const all = ["redis a", "redis b", "redis c", "其它"];
  const sel = selectHistory(all, { limit: 2, filter: "redis" });
  assert.deepEqual(sel.shown, ["redis a", "redis b"]);
  assert.equal(sel.matched, 3);
  assert.equal(sel.total, 4);
});

test("selectHistory: 过滤关键字两边空白不计；匹配不到就是空", () => {
  assert.equal(selectHistory(FIVE, { filter: "  e3  " }).filter, "e3");
  assert.equal(selectHistory(["abc"], { filter: "  " }).matched, 1, "全空白 = 不过滤");
  const none = selectHistory(FIVE, { filter: "zzz" });
  assert.deepEqual(none.shown, []);
  assert.equal(none.matched, 0);
  assert.equal(none.total, 5);
});

test("selectHistory: 空历史与坏输入都不抛（列表为空 ≠ 出错）", () => {
  for (const bad of [[], null as unknown as string[], undefined as unknown as string[]]) {
    const sel = selectHistory(bad, { limit: 5 });
    assert.deepEqual(sel.shown, []);
    assert.equal(sel.total, 0);
  }
});

test("selectHistory: 条数非法时退回默认值，不显示空列表", () => {
  assert.equal(selectHistory(FIVE, { limit: NaN }).shown.length, 5 > SHOW_DEFAULT ? SHOW_DEFAULT : 5);
  assert.equal(selectHistory(FIVE, {}).shown.length, 5, "不给条数 → 默认值，够用就全给");
});

test("selectHistory: 是纯函数 —— 不改动传进来的数组", () => {
  const arr = [...FIVE];
  const snapshot = [...arr];
  selectHistory(arr, { limit: 2, filter: "e" });
  assert.deepEqual(arr, snapshot);
});

test("selectHistory: skip 剔掉「当前这一行」（主循环先记历史再执行命令）", () => {
  const all = ["/input", "上一条", "上上条"];
  const sel = selectHistory(all, { limit: 10, skip: "/input" });
  assert.deepEqual(sel.shown, ["上一条", "上上条"]);
  assert.equal(sel.total, 2, "total 也要跟着剔 —— 头部写着「N / total 条」，两处口径必须一致");
  assert.equal(sel.matched, 2);
});

test("selectHistory: skip 只比对第一条，不误伤历史里真实存在的同名输入", () => {
  const all = ["/input", "/input", "别的"];
  const sel = selectHistory(all, { limit: 10, skip: "/input" });
  assert.deepEqual(sel.shown, ["/input", "别的"], "历史里第二条真的是 /input，就该显示出来");
});

test("selectHistory: skip 对不上就别剔（不能因为传了就无脑切掉第一条）", () => {
  const all = ["别的", "再别的"];
  const sel = selectHistory(all, { limit: 10, skip: "/input" });
  assert.deepEqual(sel.shown, ["别的", "再别的"]);
  assert.equal(sel.total, 2);
});

test("selectHistory: 整份历史只有当前这一行 → 剔完就是空（新装机器上的第一次 /input）", () => {
  const sel = selectHistory(["/input"], { limit: 10, skip: "/input" });
  assert.deepEqual(sel.shown, []);
  assert.equal(sel.total, 0, "这才是「还没有输入历史」该走的分支");
});

// ============================================================
// clearHistory —— 内存与文件必须一起清
// ============================================================

test("clearHistory: 就地清空并返回同一个数组（调用方拿它去写文件才不会分家）", () => {
  const arr = ["a", "b", "c"];
  const out = clearHistory(arr);
  assert.equal(out, arr, "必须是同一个引用 —— 否则「清内存」和「清文件」会各拿一份");
  assert.deepEqual(arr, []);
});

test("clearHistory: 清空后再落盘，文件里真的什么都不剩（而不是剩个换行）", () => {
  const file = tmpFile();
  writeHistory(file, ["a", "b"]);
  const mem = readHistory(file);
  assert.equal(mem.length, 2);

  clearHistory(mem);
  writeHistory(file, mem);

  assert.equal(readHistory(file).length, 0, "重启后不能又冒出来");
  assert.equal(fs.readFileSync(file, "utf-8"), "", "文件应为空串 —— 一个换行也让 formatHistory 写不出内容");
});

// ============================================================
// /input 命令的接线（结构锁）
// ============================================================
//
// 为什么这里读源码而不是跑行为：接线在 main() 里，需要真终端才能跑。子进程层
// （tests/cli-spawn.test.ts 那一节）能验**结果**，但验不了**接线方式** ——
// 而下面这几种坏写法都能跑出看起来正常的结果，出问题时却已经在别处了。

const MAIN_SRC = (() => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return fs
    .readFileSync(path.join(root, "src", "main.ts"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, " ") // 剥块注释：注释里常引用旧代码，会把断言骗过去
    // 剥行注释必须带 m 标志，否则 `^` 只在整串开头匹配，等于没剥 —— 上面的
    // `// 参数语义只在 input-history.ts 定义一次（parseInputArg）` 正是这种情形
    .replace(/(^|[^:])\/\/[^\n]*/gm, "$1 "); // `[^:]` 避开 http://
})();

/** 截出 `/input` 那个 case 的源码正文（到下一条 case 为止） */
function inputCaseSource(): string {
  const start = MAIN_SRC.indexOf('case "/input"');
  assert.ok(start >= 0, "main.ts 里找不到 /input 的 case");
  const end = MAIN_SRC.indexOf('case "/save"', start);
  assert.ok(end > start, "找不到 /input 后面的下一条 case，截取范围不可信");
  return MAIN_SRC.slice(start, end);
}

test("结构锁：/input 读 cs.inputHistory，不重新读文件（那是第二份真相）", () => {
  const src = inputCaseSource();
  assert.match(src, /cs\.inputHistory/, "/input 必须读 ↑ 正在用的那一份");
  assert.doesNotMatch(
    src,
    /readHistory\s*\(/,
    "命令里不许重新读文件 —— 内存里刚敲的那条还没落盘，读出来是另一份"
  );
});

test("结构锁：参数语义与筛选都不自己实现（各自只有一处定义）", () => {
  const src = inputCaseSource();
  assert.match(src, /const action = parseInputArg\s*\(/, "参数语义必须复用 parseInputArg");
  assert.match(src, /selectHistory\s*\(/, "筛选必须复用 selectHistory");
  assert.match(src, /clearHistory\s*\(/, "清空必须复用 clearHistory（由它保证原地清空）");
  // 分支只能落在**解析结果**上。自己从原文里认 clear（正则或小写比对）是
  // 「同一件事写两遍」的开端：parseInputArg 里改一次，命令里那份不会跟着变。
  assert.match(src, /action\.kind === "clear"/, "清空分支应读 action.kind");
  assert.doesNotMatch(src, /\/clear\/i/, "不许用正则从原文里认 clear");
  assert.doesNotMatch(src, /\.trim\(\)\s*\.toLowerCase\(\)/, "不许自己把原文归一化后比对");
  assert.doesNotMatch(src, /\.filter\s*\(/, "不许在命令里自己过滤历史");
});

test("结构锁：清空必须先清内存、再落盘（反了写下去的是清空前的数组）", () => {
  const src = inputCaseSource();
  assert.match(src, /writeHistory\s*\(\s*INPUT_HISTORY_FILE/, "清空后必须把结果写回文件");
  assert.ok(
    src.indexOf("clearHistory(") < src.indexOf("writeHistory("),
    "顺序必须是先清内存再落盘"
  );
});
