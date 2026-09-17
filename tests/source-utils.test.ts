/**
 * `stripComments` 自己的测试 —— 它是所有「读源码做断言」的锁的地基，地基塌了锁就全是假的。
 *
 * 背景一：原先 `tests/` 下三份拷贝都用「把 `//` 之后一直删到行尾」那条裸正则，它会连
 * 字符串里的 `//` 一起删（URL 的 `://`、模板串里拼 scheme 的 `}//`），
 * 后果不是「锁松了一点」，而是**锁对最该抓的形态判绿**：
 *   - `ws:// 字面量只在 ws-url.ts 里拼`
 *   - `读 location.host 的地方只有一处`
 * 这两条锁的注入实验里，`App.vue` 里塞回 `const url = `ws://${location.host}/ws`` 时它们
 * 一条都不红（实测）。所以这里把每一条边界都钉住。
 *
 * 背景二（本轮修的）：同一个「把代码当字符串」的坑还有第二条路 —— **正则字面量**。
 * 正则里可以出现引号/反引号，扫描器会误入字符串状态并一路吞下去，于是**从那一行起注释
 * 不再被剥掉**。实测 `src/ui.ts` 残留 30 条注释、`vscode/src/panel.ts` 残留 2 条。
 * 后果就是本文件开头那条：注释里的反面示例被当成实现 —— 连栽过的假红又回来了
 * （见本文件「失步」那一节，用一行纯注释实测复现）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/** 剥完之后还「像注释」的行 —— 失步的指纹（说明有东西被当成字符串吞了） */
function residualComments(stripped: string): string[] {
  return stripped.split("\n").filter((l) => /^\s*(\/\/|\*|\/\*)/.test(l));
}

test("★ stripComments: 正则字面量里的引号/反引号不算字符串 —— 否则从这行起注释不再被剥", () => {
  // 三种真实形态（都取自本仓库）：字符类里带反引号、带双引号、带单引号
  const SHAPES: [string, string][] = [
    ["字符类带反引号（src/ui.ts:488 那种）", "const re = /`[^`]+`|\\*\\*[^*]+\\*\\*/g;"],
    ["字符类带双引号", 'const re = /["\']/;'],
    ["转义字符类带引号", 'const re = /\\bversion\\s*:\\s*["\'`]/;'],
  ];
  for (const [name, decl] of SHAPES) {
    const src = `${decl}\n// 这行必须被剥掉\nconst after = 1;\n`;
    const out = stripComments(src);
    assert.deepEqual(
      residualComments(out),
      [],
      `${name}: 剥完还残留注释 —— 扫描器在正则的引号处失步了，这一行之后的注释全都没剥掉`
    );
    assert.ok(out.includes("const after = 1;"), `${name}: 正则之后的代码被吞了`);
    assert.ok(out.includes("const re = /"), `${name}: 正则字面量本身不该被丢`);
  }

  // 字符类里的 `/` 不结束正则。这一条只能用**构造**出来的形态钉住：
  // 输出是「照抄的区间」与「丢掉的注释」拼起来的，少掉字符类判断后那次提前闭合
  // 多半只是把同一段字符切成两块再原样拼回去 —— 一字不差，抓不到。
  // 只有让提前闭合的**落点**正好是 `//`（类里连着两个 `/`）才会露馅：第二个 `/`
  // 被读成行注释开头，这一行的 `;` 与闭合斜杠整段消失（代码被丢，不只是注释没剥）。
  assert.equal(
    stripComments("const re = /[///]/g;\n// 注释\nconst after = 1;\n"),
    "const re = /[///]/g;\n\nconst after = 1;\n",
    "字符类里的 `/` 被判成了正则的结束 —— 紧跟在它后面的 `/` 又被当成注释开头"
  );
});

test("stripComments: 除号不会被误判成正则（反向对照）", () => {
  // 判错方向必须是「把正则当除号」而不是反过来 —— 后者会把后面的代码当字符串吞掉。
  // 这里逐条写**精确输出**：只断言「注释没了」是不够的（除号被当成正则时，
  // 注释内容会原地漏成代码而不再占一行的开头，那种坏法躲得过行首判据）。
  const CASES: [string, string][] = [
    ["const x = a / b;\n// 注释\nconst after = 1;\n", "const x = a / b;\n\nconst after = 1;\n"],
    ["const x = (a + b) / 2;\n// 注释\nconst after = 1;\n", "const x = (a + b) / 2;\n\nconst after = 1;\n"],
    ["const x = obj.n / list[0];\n// 注释\nconst after = 1;\n", "const x = obj.n / list[0];\n\nconst after = 1;\n"],
    // 行尾注释这种「同一行里还有第二个 `/`」的形态最容易把除号读成正则
    ["const x = 1 / 2; // 行尾注释\nconst after = 1;\n", "const x = 1 / 2; \nconst after = 1;\n"],
  ];
  for (const [src, want] of CASES) {
    assert.equal(stripComments(src), want, `除号被当成正则了：${src.split("\n")[0]}`);
  }
  // 关键字之后的正则仍要认出来：`return /re/` 不是除法
  assert.equal(
    stripComments('function f() { return /["\']/.test(s); }\n// 注释\nconst after = 1;\n'),
    'function f() { return /["\']/.test(s); }\n\nconst after = 1;\n'
  );
});

test("★ stripComments: 正则必须在本行内闭合 —— 判错最多影响一行", () => {
  // 真实触发形态就在 `.vue` 文件里：**闭合标签** `</span>`。`<` 在「允许出现正则」的
  // 字符集里（`a < b` 之后接正则确实合法），于是每个闭合标签都是一次正则尝试。
  // 少了换行处的判负，这次尝试会一路咬到**几行之后**的下一个 `/` —— 中间那段 CSS 注释
  // （`/* … */`）就整段漏成代码。实测 `web/src/components/PlanList.vue`、
  // `web/src/components/SettingsPanel.vue` 都会中招，这就是全仓那条总闸能红的原因。
  const VUE = "<span/>\n</b>\n/* 顶部行 */\n</c>\n";
  assert.equal(
    stripComments(VUE),
    "<span/>\n</b>\n\n</c>\n",
    "跨行的 `/` 被判成了正则，把几行之后的注释吞成了正则内容"
  );
  // 反向对照：`a < b` 之后真的写正则时要照常认出来（别为了躲闭合标签把正则全禁了）
  assert.equal(
    stripComments("const ok = a < /x/.source.length;\n// 注释\nnext;\n"),
    "const ok = a < /x/.source.length;\n\nnext;\n"
  );
});

test("★ stripComments: 全仓源码剥完后不得残留注释行 —— 失步会在这里现形", () => {
  // 这是本文件两条背景（URL / 正则）的**总闸**：任何新形态的词法让扫描器失步，
  // 症状都是「某处的注释漏了出来」，这一条都会红 —— 不必事先枚举触发形态。
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const DIRS = ["src", "web/src", "electron/src", "vscode/src"];
  const files: string[] = [];
  for (const d of DIRS) {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (e.isFile() && /\.(ts|vue)$/.test(e.name)) files.push(path.join(e.parentPath, e.name));
    }
  }
  // 「有没有可检查的对象」要钉住，否则扫描目录改名后这条锁退化成永远为真
  assert.ok(files.length > 10, `只扫到 ${files.length} 个源文件 —— 目录改了？这条锁必须跟着改`);

  // 两个已实测中招的文件必须还在扫描范围内：它们带的是**触发形态**本身，
  // 少了它们这条锁就只剩空跑（触发形态消失 = 再也证明不了扫描器扛得住）。
  const rel = files.map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
  for (const must of ["src/ui.ts", "vscode/src/panel.ts"]) {
    assert.ok(
      rel.includes(must),
      `扫描范围内少了 ${must}（正则字面量里带引号/反引号的触发文件）—— 改名了就更新这条锁`
    );
  }

  const offenders: string[] = [];
  for (const f of files) {
    const lines = residualComments(stripComments(fs.readFileSync(f, "utf-8")));
    for (const l of lines) offenders.push(`${path.relative(ROOT, f).replace(/\\/g, "/")} → ${l.trim().slice(0, 70)}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "剥完仍残留注释行 —— 扫描器在某个词法处失步，这一行之后的注释统统没被剥掉，" +
      `读源码的锁会重新把注释当成实现：\n  ${offenders.slice(0, 10).join("\n  ")}`
  );

  // 反向对照：判据本身要能识别残留注释，否则上面那条永远为真
  assert.deepEqual(
    residualComments("a;\n// 漏出来的注释\n* 块注释尾巴\n"),
    ["// 漏出来的注释", "* 块注释尾巴"],
    "residualComments 自己认不出残留注释 —— 上面那条锁是假的"
  );
});
