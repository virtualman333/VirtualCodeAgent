/**
 * `stripComments` 自己的测试 —— 它是所有「读源码做断言」的锁的地基，地基塌了锁就全是假的。
 *
 * 背景：原先 `tests/` 下三份拷贝都用「把 `//` 之后一直删到行尾」那条裸正则，它会连
 * 字符串里的 `//` 一起删（URL 的 `://`、模板串里拼 scheme 的 `}//`），
 * 后果不是「锁松了一点」，而是**锁对最该抓的形态判绿**：
 *   - `ws:// 字面量只在 ws-url.ts 里拼`
 *   - `读 location.host 的地方只有一处`
 * 这两条锁的注入实验里，`App.vue` 里塞回 `const url = `ws://${location.host}/ws`` 时它们
 * 一条都不红（实测）。所以这里把每一条边界都钉住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { stripComments } from "./source-utils.js";

test("stripComments: 注释被丢掉，字符串与模板串原样保留", () => {
  assert.equal(stripComments("a; // 行注释\nb;"), "a; \nb;", "行注释要丢，但换行要留（保住行数）");
  assert.equal(stripComments("a; /* 块 */ b;"), "a;  b;");
  assert.equal(stripComments("a; /* 跨\n行 */ b;"), "a;  b;");
  assert.equal(stripComments('const s = "// 不是注释";'), 'const s = "// 不是注释";');
  assert.equal(stripComments("const s = '/* 也不是 */';"), "const s = '/* 也不是 */';");
});

test("★ stripComments 不许吃掉 `ws://` —— 这是两条锁能生效的前提", () => {
  // 反面示例：源码里真的写了这个 URL 时，剥完必须还看得见 `ws://`
  const LIT = "const url = `ws://${location.host}/ws`;";
  assert.ok(
    stripComments(LIT).includes("ws://"),
    "`ws://` 被当成行注释吃掉了 —— `ws://` 字面量锁与 `location.host` 唯一处锁会同时失效"
  );

  // 拼接形态（没有 `ws://` 字面量，但有 `}//` 与 `/ws` 路径）也要完整保留
  const CONCAT = "const url = `${protocol}//${location.host}/ws`;";
  const stripped = stripComments(CONCAT);
  assert.ok(stripped.includes("location.host"), "`}//${location.host}` 整段被吃了");
  assert.ok(stripped.includes("/ws"), "路径 `/ws` 被吃了");

  // 但紧挨着 URL 的**真**行注释仍然要丢
  assert.equal(
    stripComments("const u = `ws://x/ws`; // 别这么写\nnext;"),
    "const u = `ws://x/ws`; \nnext;"
  );

  // http(s) 同理
  assert.ok(stripComments('const a = "https://example.com/x";').includes("https://"));
});

test("stripComments: 转义引号与未闭合的串都不会把后面的代码吃掉", () => {
  assert.equal(stripComments('const s = "a\\"//b";'), 'const s = "a\\"//b";');
  assert.equal(stripComments("const s = 'a\\\\'; // 注释\nz;"), "const s = 'a\\\\'; \nz;");
  // 未闭合的块注释吞到文件尾（与浏览器/TS 的词法一致）
  assert.equal(stripComments("a;\n/* 没关\nb;\nc;"), "a;\n");
  // 未闭合的字符串吞到文件尾（不会因为找不到闭合引号而回退成「不处理」）
  assert.equal(stripComments('a;\nconst s = "没关\nb;'), "a;\nconst s = \"没关\nb;");
});
