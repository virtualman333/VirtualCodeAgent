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
import { test } from "node:test";

import {
  HISTORY_MAX,
  formatHistory,
  normalizeEntry,
  parseHistory,
  pushHistory,
  readHistory,
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

test("parseHistory: 跳过 prompt_toolkit 的 `# 时间戳` 注释行", () => {
  // 这是 ~/.vca/input_history 里的真实形态（Python 版留下的），
  // 开头还有一个空行 —— 都要能正确跳过
  const text = [
    "",
    "# 2026-08-11 10:27:28.049413",
    "/help",
    "",
    "# 2026-08-11 10:27:37.040194",
    "/help ",
    "",
  ].join("\n");
  assert.deepEqual(parseHistory(text), ["/help", "/help"]);
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

test("★ formatHistory: 内存最新在前 → 文件最早在前", () => {
  assert.equal(formatHistory(["最新", "中间", "最早"]), "最早\n中间\n最新\n");
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
