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
import { test } from "node:test";

import { clipToWidth, displayWidth, padRight } from "../src/ui.js";

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
