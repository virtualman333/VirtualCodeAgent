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
 *
 * 背景三：`stripComments` 是**所有**读源码的锁的地基，而它上面那些锁还共享第二样东西 ——
 * **扫哪些文件**。那个口径此前被手抄了三份（`version.test.ts` 的 `SOURCE_DIRS`、
 * `ansi-source.test.ts` 的 `SCAN_ROOTS`、本文件那条总闸的 `DIRS`，三份内容还不一样），
 * 于是「新加的源码目录」永远扫不到。现在统一收敛到本文件的 `sourceSurface()`：
 * **默认全扫 + 排除表**（要排除必须写明理由），新目录默认进扫描面。
 *
 * 背景四（本节末尾新增）：`stripComments` 还有**第三样**共享的东西 —— `/` 到底是正则还是
 * 除号的那张关键字表。它手工维护、无人核对（14 条里只有 `return` 有测试），而且实测它判错
 * 的那一侧（除号被读成正则）**会吞掉后面那行的注释**，症状正是背景一与背景二那两条。
 * 现在那张表每条都有活样例、表外的关键字都要写明理由（宇宙从 `typescript` 现算），
 * 判错方向的两侧都用棘轮表钉住。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

import {
  REGEX_AFTER_PUNCT,
  REGEX_AFTER_WORD,
  REPO_ROOT,
  sourceSurface,
  stripComments,
} from "./source-utils.js";

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
  // 反向对照：`a < b` 之后真的写正则时要照常认出来（别为了躲闭合标签把正则全禁了）。
  // ⚠ 这里必须用**带引号**的正则：写成 `/x/` 时 `<` 在不在标点表里输出都一样（`/x/` 当除号
  // 读也不会吃掉注释），那条断言从来没在钉 `<` —— 是条假锁。换成 `RX` 之后，`<` 一被删就红。
  assert.equal(
    stripComments('const ok = a < /[\'"]/.source.length;\n// 注释\nnext;\n'),
    'const ok = a < /[\'"]/.source.length;\n\nnext;\n'
  );
});

test("★ stripComments: 全仓源码剥完后不得残留注释行 —— 失步会在这里现形", () => {
  // 这是本文件两条背景（URL / 正则）的**总闸**：任何新形态的词法让扫描器失步，
  // 症状都是「某处的注释漏了出来」，这一条都会红 —— 不必事先枚举触发形态。
  //
  // 扫描面也现算了：这里原来抄着**第三份**目录清单（`DIRS = ["src", "web/src",
  // "electron/src", "vscode/src"]`，与前两份还不完全一样），于是「不在清单里的源码」
  // 永远进不来 —— 连这条最该覆盖全仓的总闸自己都漏。
  const surface = sourceSurface(/\.(ts|vue)$/);
  assert.deepEqual(surface.problems, [], `扫描面自身不自洽：\n  ${surface.problems.join("\n  ")}`);
  const files = surface.files;

  // 「有没有可检查的对象」要钉住，否则扫描目录改名后这条锁退化成永远为真
  assert.ok(files.length > 10, `只扫到 ${files.length} 个源文件 —— 目录改了？这条锁必须跟着改`);

  // 两个已实测中招的文件必须还在扫描范围内：它们带的是**触发形态**本身，
  // 少了它们这条锁就只剩空跑（触发形态消失 = 再也证明不了扫描器扛得住）。
  for (const must of ["src/ui.ts", "vscode/src/panel.ts"]) {
    assert.ok(
      files.includes(must),
      `扫描范围内少了 ${must}（正则字面量里带引号/反引号的触发文件）—— 改名了就更新这条锁`
    );
  }

  const offenders: string[] = [];
  for (const rel of files) {
    const lines = residualComments(stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8")));
    for (const l of lines) offenders.push(`${rel} → ${l.trim().slice(0, 70)}`);
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

// ---------------------------------------------------------------------------
// 扫描面本身：`sourceSurface` 是上面那条总闸（以及 version / ansi 两条锁）的地基。
// 地基要能**自证**：塌了、腐烂了、空了都必须自己喊出来，而不是让上层对着空集合判绿。
// ---------------------------------------------------------------------------

/** 造一个临时仓库树：key 是相对路径，值是内容（`node_modules` 用来验产物目录） */
function fixture(tree: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vca-surface-"));
  for (const [rel, body] of Object.entries(tree)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

test("★ sourceSurface: 新加的源码目录自动进扫描面（手抄清单正是在这里漏的）", () => {
  const root = fixture({
    "src/a.ts": "export const a = 1;\n",
    "tools/deep/b.ts": "export const b = 1;\n",
    "tests/c.ts": "// 测试\n",
    "node_modules/dep/index.ts": "export const dep = 1;\n",
    "docs/readme.md": "# 不是源码\n",
  });
  try {
    const s = sourceSurface(/\.ts$/, { root, excluded: { tests: "测试数据" } });

    assert.deepEqual(s.problems, [], "这个树是自洽的，不该有 problems");
    // 核心：`tools/` 谁都没登记过，它是「现算」出来的 —— 手抄清单时代它会静默消失
    assert.deepEqual(s.roots, ["src", "tools"], `现算的源码根不对：${s.roots.join(", ")}`);
    assert.deepEqual(s.files, ["src/a.ts", "tools/deep/b.ts"]);

    // 产物目录不算源码
    assert.ok(!s.files.some((f) => f.startsWith("node_modules/")), "node_modules 不该进扫描面");
    // 非源码后缀不算
    assert.ok(!s.files.some((f) => f.endsWith(".md")), ".md 不该进扫描面");
    // 排除表生效
    assert.ok(!s.files.some((f) => f.startsWith("tests/")), "排除表没生效");

    // 反向对照（关键）：**把同一棵树按手抄清单的口径算一遍**（只认 `["src"]`），
    // 掉出去的就是手抄时代会静默漏掉的那些。跑的是同一份 fixture，所以它证明的是
    // 「结论来自清单口径」，而不是「扫描器本来就这样」。
    const handCopied = ["src"];
    const missed = s.files.filter((f) => !handCopied.some((d) => f.startsWith(`${d}/`)));
    assert.deepEqual(missed, ["tools/deep/b.ts"], "手抄口径应当漏掉 tools/deep/b.ts —— 它正是本轮的靶子");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("★ sourceSurface: 排除表腐烂 / 扫描面塌陷都要自己喊出来", () => {
  const root = fixture({ "src/a.ts": "export const a = 1;\n", "lib/b.ts": "export const b = 1;\n" });
  try {
    // ① 排除表里写了个「底下没有源码」的目录 —— 假条目，必须报
    const rotten = sourceSurface(/\.ts$/, { root, excluded: { tests: "其实没有这个目录" } });
    assert.equal(rotten.problems.length, 1, `应当只报一条：${rotten.problems.join(" | ")}`);
    assert.match(rotten.problems[0], /tests\//, "腐烂报告要点出具体目录");

    // ② 排除表整个是空的 → 没有假条目，扫描面照常（说明①报的是「腐烂」而不是「排除了东西」）
    const none = sourceSurface(/\.ts$/, { root, excluded: {} });
    assert.deepEqual(none.problems, []);
    assert.deepEqual(none.roots, ["lib", "src"], "没有排除表时两处源码都该在");

    // ③ 扫描面塌到零个文件 → 必须报，否则上层「全仓没有第二份」恒真
    const noSrc = fixture({ "docs/a.md": "x\n" });
    try {
      const empty = sourceSurface(/\.ts$/, { root: noSrc, excluded: {} });
      assert.equal(empty.problems.length, 1, `应当只报一条：${empty.problems.join(" | ")}`);
      assert.match(empty.problems[0], /扫描面是空的/);
    } finally {
      fs.rmSync(noSrc, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sourceSurface: 传进来的正则带 `g` 也不会漏文件（test() 会来回翻转）", () => {
  // 这是本仓库那类「静默少一半」缺陷的同一个形状：`/\.ts$/g` 的 `test()` 交替返回
  // true / false，扫描面会丢一半文件，而**没有任何东西会报错**。
  const root = fixture({ "src/a.ts": "1\n", "src/b.ts": "2\n", "src/c.ts": "3\n" });
  try {
    const plain = sourceSurface(/\.ts$/, { root, excluded: {} });
    const global = sourceSurface(/\.ts$/g, { root, excluded: {} });
    assert.deepEqual(global.files, plain.files, "带 g 的正则让扫描面丢文件了");
    assert.equal(plain.files.length, 3, "三条都该被扫到");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// `/` 的上下文面：`/` 是正则还是除号，靠 `source-utils.ts` 里那张**手工维护**的关键字表判定。
// 它的老毛病不是「写错了」，而是**没有任何东西扛着它**：14 条里只有 `return` 有测试，
// 其余 13 条没人证明被用到，表外新来的关键字也没人提醒。表烂了会出什么事：`/` 被判成除号 →
// 正则里的引号让扫描器失步 → 那一行之后的注释全都不剥 → 注释里的反面示例又被当成实现
// （本文件开头那两条背景原地复活）。
//
// 所以本节给这张表三样东西：
//   ① 每条登记项一个**活样例** —— 经 TS 解析器认证语法合法，且把它从表里删掉后该样例必须翻红；
//   ② 关键字宇宙**现算**（来自 `typescript` 的 `SyntaxKind`），表外的每个词都要写明理由；
//   ③ 判错方向的两侧都钉住 —— 除号被读成正则的形态用棘轮表列全。
// ---------------------------------------------------------------------------

/** 每个样例里那个「带引号的正则」：扫描器一旦判错方向就会在引号处失步并吞掉后面的一切 */
const RX = "/['\"]/";

/**
 * 关键字 → 一个**语法合法**的片段，且 `RX` 紧跟在它后面。
 *
 * 样例只喂词法扫描器、不执行 —— 所以「`delete /re/.lastIndex` 在严格模式下会抛」这类语义
 * 问题不在本节范围内；这里钉的是**这个词后面能不能出现正则字面量**这条词法事实。
 */
const KEYWORD_SAMPLES: Record<string, string> = {
  return: `function f(){ return ${RX}.test(s); }`,
  typeof: `const t = typeof ${RX};`,
  instanceof: `const b = x instanceof ${RX}.constructor;`,
  in: `if ('a' in ${RX}) {}`,
  of: `for (const c of ${RX}.source) {}`,
  new: `const r = new ${RX}.constructor();`,
  delete: `delete ${RX}.lastIndex;`,
  void: `const v = void ${RX};`,
  do: `do ${RX}.test(a); while (b);`,
  else: `if (a) b; else ${RX}.test(c);`,
  yield: `function* g(){ yield ${RX}; }`,
  await: `async function f2(){ await ${RX}; }`,
  case: `switch (x) { case ${RX}.test(y): break; }`,
  throw: `throw ${RX};`,
};

/** 样例后面接的一行注释与一段代码：判错的症状就是「这行注释没被剥掉」 */
const TAIL = "\n// 尾注释\nconst after = 1;\n";

/** 现算标点宇宙：可打印 ASCII 里的非字母数字字符（不是手抄的清单） */
function punctUniverse(): string[] {
  const out: string[] = [];
  for (let c = 0x21; c <= 0x7e; c++) {
    const ch = String.fromCharCode(c);
    if (!/[A-Za-z0-9]/.test(ch)) out.push(ch);
  }
  return out;
}

/**
 * 标点表外的字符 —— 每个都要写明「为什么它后面不可能是正则位置」。
 *
 * 与关键字那边一样，这里钉的是**有没有漏**：`REGEX_AFTER_PUNCT` 是遍历用的表，删掉一个字符
 * 只会让循环少跑一圈（静默通过），所以宇宙必须从 ASCII 现算，再做减法。
 */
const EXCUSED_PUNCT: Record<string, string> = {
  '"': "字符串定界符：它后面是字符串内容，不是表达式位置",
  "'": "字符串定界符：它后面是字符串内容，不是表达式位置",
  "`": "模板串定界符：同上",
  "#": "私有名（`#x`）与 shebang（`#!`）的开头",
  $: "标识符字符（`$x`）",
  _: "标识符字符（`_x`）",
  "@": "装饰器（`@Injectable()`）的开头，后面跟标识符",
  "\\": "转义序列的一部分（`\\u0041`），本身不结束也不开始表达式",
  ".": "成员访问：它后面的词是**属性名**（`obj.of` 里的 `of` 不是关键字，本轮为此单独加了一条判据）",
  ")": "能结束一个表达式 —— 后面跟 `/` 只能是除号",
  "]": "能结束一个表达式（下标访问）—— 后面跟 `/` 只能是除号",
  "/": "`a / /re/` 语法上合法，但把它放进表里会让 `x = re / 2; // 注释` 这类除法被读成正则（闭合斜杠恰好是后面那行注释的第一个 `/`，实测会漏剥）—— 代价大于收益，明确列为边界",
};

function stripSample(
  sample: string,
  opts: { afterWord?: Set<string>; afterPunct?: string } = {}
): string {
  return stripComments(sample + TAIL, opts);
}

/** TS 自己的解析器给样例背书；`null` = 这个 TS 版本不给 `parseDiagnostics`（那就不该假装验过） */
function parseDiagnostics(src: string): string[] | null {
  const sf = ts.createSourceFile("sample.ts", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS) as unknown as {
    parseDiagnostics?: { messageText: unknown }[];
  };
  const d = sf.parseDiagnostics;
  return Array.isArray(d) ? d.map((x) => String(x.messageText)) : null;
}

test("★ 关键字表与样例会双向对齐（漏登 / 腐烂都报）", () => {
  const samples = Object.keys(KEYWORD_SAMPLES).sort();
  const table = [...REGEX_AFTER_WORD].sort();
  assert.deepEqual(
    samples,
    table,
    "样例表与关键字表对不上：少一条 = 新加的关键字没人管，多一条 = 样例腐烂"
  );
  // 「两边都空」会让上面那条恒真
  assert.ok(table.length >= 14, `关键字表只剩 ${table.length} 条 —— 表塌了，上面那条就成了空话`);

  for (const [kw, sample] of Object.entries(KEYWORD_SAMPLES)) {
    // 样例必须真的**踩在这个关键字上**：`/` 前面紧邻的那个词就是它。
    // 否则删掉这条关键字时样例可能被别的词救活 —— 那条登记项就没在钉自己。
    const m = /([A-Za-z]+)\s+\/\[/.exec(sample);
    assert.ok(m, `${kw}: 样例里找不到「关键字 + 正则」的形态：${sample}`);
    assert.equal(m[1], kw, `${kw}: 样例里正则前面那个词是 ${m[1]}，不是 ${kw}`);
  }
});

test("★ 关键字样例会经 TS 解析器认证语法合法（不是编出来的片段）", () => {
  // 反向对照：先证明这个 API 真的会给诊断 —— 否则「样例都合法」可能只是拿不到诊断
  const control = parseDiagnostics("const = ;");
  assert.ok(control, "拿不到 parseDiagnostics（typescript 版本变了？）—— 这条锁会静默全绿");
  assert.ok(control.length >= 1, "对照组 `const = ;` 没报语法错 —— API 没在干活");

  for (const [kw, sample] of Object.entries(KEYWORD_SAMPLES)) {
    const diags = parseDiagnostics(sample);
    assert.ok(diags, `${kw}: 拿不到诊断`);
    assert.deepEqual(diags, [], `${kw} 的样例不是合法 TS：${sample}`);
  }
});

test("★ 每条关键字登记项都要能被删红 —— 否则它没在钉任何东西", () => {
  for (const [kw, sample] of Object.entries(KEYWORD_SAMPLES)) {
    // 正方向：表里有它 → 正则被认出来 → 注释被剥掉、后面的代码还在
    const ok = stripSample(sample);
    assert.deepEqual(residualComments(ok), [], `${kw}: 正则没被认出来，注释漏成了代码`);
    assert.ok(ok.includes("const after = 1;"), `${kw}: 样例之后的代码被吞了`);

    // 反方向：把这一条从表里删掉再跑一遍，必须出事。这就是把「按原本的方式改坏它，
    // 这条断言会不会红」写进常规自测 —— 永远为真的常量断言在这里过不去。
    const missing = new Set([...REGEX_AFTER_WORD].filter((w) => w !== kw));
    const bad = stripSample(sample, { afterWord: missing });
    assert.ok(
      residualComments(bad).length > 0,
      `${kw}: 从表里删掉它之后样例照样全绿 —— 这条登记项是摆设`
    );
  }
});

test("★ 标点表：表里的每个字符都要能被删红，表外的每个字符都要有理由", () => {
  // 注意这里**不能**只循环 `REGEX_AFTER_PUNCT` —— 循环遍历登记表，「表里少了一条」永远
  // 测不出来（删掉一个字符，循环只是少跑一圈，静默通过）。所以宇宙要**现算**：
  // 可打印 ASCII 里的非字母数字字符，表外的每一个都得在例外表里写明理由。
  const universe = punctUniverse();
  assert.ok(universe.length >= 30, `标点宇宙只剩 ${universe.length} 个 —— 生成方式变了？`);
  const table = REGEX_AFTER_PUNCT.split("");

  assert.deepEqual(table.filter((c) => !universe.includes(c)), [], "标点表里有打印不出来的字符");
  assert.deepEqual(
    universe.filter((c) => !table.includes(c) && !(c in EXCUSED_PUNCT)),
    [],
    "这些标点既不在表里、也没有登记理由 —— 表里少一条会在这里现形"
  );
  assert.deepEqual(
    Object.keys(EXCUSED_PUNCT).filter((c) => !universe.includes(c)),
    [],
    "例外表里有宇宙外的字符（腐烂）"
  );
  assert.deepEqual(
    Object.keys(EXCUSED_PUNCT).filter((c) => table.includes(c)),
    [],
    "同一个字符既在表里又在例外表里"
  );
  for (const [ch, reason] of Object.entries(EXCUSED_PUNCT)) {
    assert.ok(reason.length >= 6, `${JSON.stringify(ch)} 的理由太短，等于没写`);
  }
  assert.ok(Object.keys(EXCUSED_PUNCT).length >= 8, "例外表太小 —— 上面那条对账可能只是空跑");

  // 反向对照：把 `)` 从例外表里拿掉，那条对账必须点它的名
  const probe = Object.keys(EXCUSED_PUNCT).filter((c) => c !== ")");
  assert.deepEqual(
    universe.filter((c) => !table.includes(c) && !probe.includes(c)),
    [")"],
    "这条对账抓不住「表里少一个标点」—— 它挡不住任何人"
  );

  for (const ch of table) {
    const sample = `const y = a ${ch}${RX}.test(b);`;
    const ok = stripSample(sample);
    assert.deepEqual(
      residualComments(ok),
      [],
      `${JSON.stringify(ch)} 之后的正则没被认出来 —— 注释漏成了代码`
    );

    const missing = table.filter((c) => c !== ch).join("");
    const bad = stripSample(sample, { afterPunct: missing });
    assert.ok(
      residualComments(bad).length > 0,
      `${JSON.stringify(ch)} 从标点表里删掉后样例照样全绿 —— 这个字符是摆设`
    );
  }
});

// ---------------------------------------------------------------------------
// 关键字宇宙：**现算**，不是手抄。
// 这条对账要回答的问题是：「表里没有的关键字，凭什么可以没有？」
// 手抄的答案只能靠人记得，现算的答案会在 TypeScript 多一个关键字时自己变红。
// ---------------------------------------------------------------------------

/** 现算 JS/TS 的关键字宇宙 —— TypeScript 加一个关键字（`satisfies`/`using`/`accessor` 都这么来的）它就会变 */
function keywordUniverse(): string[] {
  const names = Object.keys(ts.SyntaxKind).filter((n) => /^[A-Za-z]+Keyword$/.test(n));
  // `FirstKeyword` / `LastKeyword` 这些是枚举里的**区间哨兵**，不是关键字
  return [
    ...new Set(
      names.filter((n) => !/^(First|Last)/.test(n)).map((n) => n.slice(0, -"Keyword".length).toLowerCase())
    ),
  ].sort();
}

/**
 * 表外的关键字放哪儿 —— 按**理由**分组，理由只写一次。
 *
 * 分组名 → 成员清单（而不是成员 → 分组名）：分组名只出现一处，写错名字不会有第二份抄件
 * 把这个错误盖住；而「有分组没理由」和「有理由没分组」两个方向都会红。
 */
const EXCUSED_GROUPS: Record<string, string[]> = {
  mustParen: ["if", "while", "for", "switch", "catch", "with"],
  declHead: [
    "const", "let", "var", "function", "class", "interface", "type", "enum", "namespace", "module",
    "declare", "abstract", "implements", "import", "export", "from", "as", "assert", "asserts",
    "satisfies", "keyof", "infer", "readonly", "is", "unique", "intrinsic", "out", "using",
  ],
  control: ["break", "continue", "debugger", "finally", "try"],
  selfExpr: ["this", "super", "true", "false", "null", "undefined"],
  typeName: ["any", "bigint", "boolean", "never", "number", "object", "string", "symbol", "unknown"],
  contextualIdent: ["async", "get", "set", "global", "defer", "require", "constructor", "package"],
  modifier: ["private", "protected", "public", "static", "override", "accessor"],
  grammaticalUnused: ["extends", "default"],
};

const EXCUSED_REASONS: Record<string, string> = {
  mustParen: "语法上后面必须跟 `(`（条件/循环/异常的头）",
  declHead: "声明头或类型位置：后面跟名字、类型或字面量名，不是表达式",
  control: "控制流关键字：后面是 `;`、`{` 或标签",
  selfExpr: "本身就是 PrimaryExpression —— 它已经能结束一个表达式，后面跟 `/` 只能是除号",
  typeName: "TS 的类型名：只出现在类型位置，同时本身是合法标识符",
  contextualIdent: "上下文关键字：在多数位置它就是普通标识符，后面跟 `/` 多半是变量做除法",
  modifier: "类成员修饰符：后面跟成员名或类型",
  grammaticalUnused:
    "语法上后面能跟正则（`class A extends /re/.constructor`、`export default /re/`），但现实中没有" +
    "代码这么写；放进表里会把 `mod.default / a / b` 这类除法读成正则（`.default` 是本仓库常见的属性名）",
};

const EXCUSED_KEYWORDS: ReadonlySet<string> = new Set(Object.values(EXCUSED_GROUPS).flat());

test("★ 关键字宇宙现算：表外的每一个关键字都要有理由，且理由表双向自洽", () => {
  const universe = keywordUniverse();

  // 自证一：宇宙不能塌（塌了「表外的词都有理由」就恒真）
  assert.ok(universe.length >= 60, `关键字宇宙只剩 ${universe.length} 个 —— SyntaxKind 的命名变了？`);
  // 自证二：别用 `FirstKeyword..LastKeyword` 的**数值区间**现算 —— 反向映射的那个槽位被
  // `FirstKeyword` 这个名字占了，`break` 会被**静默丢掉**（实测）。所以按名字取，并钉住这一点。
  for (const must of ["break", "return", "typeof", "satisfies", "using", "accessor"]) {
    assert.ok(universe.includes(must), `现算的关键字宇宙里没有 ${must}`);
  }
  const sentinels = Object.keys(ts.SyntaxKind).filter((n) => /^(First|Last)[A-Za-z]*Keyword$/.test(n));
  assert.ok(
    sentinels.length >= 4 && sentinels.length <= 8,
    `区间哨兵的条数变了（${sentinels.join(", ")}）—— 上面那行过滤条件要跟着看`
  );

  const table = new Set(REGEX_AFTER_WORD);
  // 双向一：表不许塞私货
  assert.deepEqual(
    [...table].filter((w) => !universe.includes(w)),
    [],
    "关键字表里有不属于 SyntaxKind 关键字的词"
  );
  // 双向二：表外的每个关键字都要有理由 —— **这条就是拦住「新关键字没人知道」的那条锁**
  assert.deepEqual(
    universe.filter((w) => !table.has(w) && !EXCUSED_KEYWORDS.has(w)),
    [],
    "这些关键字既不在表里、也没有登记理由（TypeScript 新增关键字 / 漏登记会在这里现形）"
  );
  // 登记表自洽：不许有非关键字、不许和表重叠、不许一个词进两个组
  assert.deepEqual(
    [...EXCUSED_KEYWORDS].filter((w) => !universe.includes(w)),
    [],
    "例外表里有根本不是关键字的词（腐烂）"
  );
  assert.deepEqual([...EXCUSED_KEYWORDS].filter((w) => table.has(w)), [], "同一个词既在表里又在例外表里");
  const seen = new Map<string, string>();
  for (const [group, members] of Object.entries(EXCUSED_GROUPS)) {
    for (const m of members) {
      const prev = seen.get(m);
      assert.equal(prev, undefined, `${m} 同时出现在 ${prev} 与 ${group} 两个分组里`);
      seen.set(m, group);
    }
  }
  // 理由表双向：每个分组都要有理由，每条理由都要有分组
  assert.deepEqual(
    Object.keys(EXCUSED_GROUPS).sort(),
    Object.keys(EXCUSED_REASONS).sort(),
    "分组与理由对不上：分组名写错，或写了理由没人用（表会腐烂）"
  );
  for (const [group, reason] of Object.entries(EXCUSED_REASONS)) {
    assert.ok(reason.length >= 12, `${group} 的理由太短，等于没写`);
  }
  assert.ok(EXCUSED_KEYWORDS.size >= 50, `例外表只剩 ${EXCUSED_KEYWORDS.size} 条 —— 上面那条对账成了空跑`);

  // 反向对照：把 `satisfies`（TS 4.9 才有的关键字）从例外表里拿掉，那条对账必须点它的名 ——
  // 证明它真能拦住「语言多了一个关键字而没人管」。
  const probe = new Set([...EXCUSED_KEYWORDS].filter((w) => w !== "satisfies"));
  assert.deepEqual(
    universe.filter((w) => !table.has(w) && !probe.has(w)),
    ["satisfies"],
    "这条对账抓不住「新关键字没登记」—— 它挡不住任何人"
  );
});

// ---------------------------------------------------------------------------
// 判错方向的另一侧：**除号被读成正则**。
// `regexAllowed` 的注释里原来断言「判错只会是把正则当除号」，实测**不成立** ——
// 表里的词当属性名时（`obj.of / 2;`），`regexEnd` 会把后面那行注释的第一个 `/` 当成闭合斜杠，
// 剩下的半个 `//` 再也认不出是注释，**这一行的注释整段漏成了代码**（也就是本文件开头那两条
// 背景的症状）。本轮补了一条文法上精确的判据：`.` 后面的词是**属性名**，不是关键字。
// ---------------------------------------------------------------------------

test("★ 除号方向的已知边界：会漏剥的形态只有这几种（棘轮）", () => {
  // 判据：剥完与原串一字不差 = 有注释没被剥掉。每一条都带注释，所以「没漏」必须表现为
  // 「注释真的不见了」，不能只看「字符串变了没有」。
  const CASES: [string, boolean][] = [
    ["const x = a / b; // 尾注释\n", false],
    ["const x = a / b; /* 块注释 */\n", false],
    // 属性名：`of` 在表里，但它前面是 `.` —— 这条本轮修好，是这次修复的靶子
    ["const x = obj.of / 2; // 尾注释\n", false],
    ["const x = obj.of / 2; /* 块注释 */\n", false],
    ["const x = obj.of / 2 / 3; // 尾注释\n", false],
    ["const x = obj.models.in / 2; // 尾注释\n", false],
    // 上下文关键字**当变量名**用：`of` / `await` / `yield` 在脚本里本来就是合法标识符，
    // 要判这次到底是关键字还是变量需要作用域信息 —— 这不是一份词法扫描器能回答的问题。
    // 这一条明确留着：触发前提是「有人拿它当变量名、同一行做除法、后面还跟注释」，全仓没有。
    ["const of = 1; const y = of / 2; // 尾注释\n", true],
    ["const of = 1; const y = of / 2; /* 块注释 */\n", true],
    ["const of = 1; const y = of / 2 / 3; // 尾注释\n", false],
    ["const await = 1; const y = await / 2; // 尾注释\n", true],
  ];

  for (const [src, expectedLeak] of CASES) {
    const out = stripComments(src);
    const leaked = out === src;
    assert.equal(
      leaked,
      expectedLeak,
      `形态 「${src.trim()}」 的表现变了：${leaked ? "开始漏剥" : "不再漏剥"} —— ` +
        (leaked
          ? "扫描器变差了（多了一种会吞代码的形态）"
          : "修好了那就把上面这张表的期望改成 false（这张表是棘轮，两个方向都该有人来看一眼）")
    );
    if (!expectedLeak) {
      assert.ok(!out.includes("注释"), `「${src.trim()}」的注释没被剥掉：${JSON.stringify(out)}`);
    }
  }

  // 反向对照：把表撑到「连变量名都算关键字」，`obj.of / 2; // 尾注释` 仍不许漏 ——
  // 说明挡住它的是那条 `.` 判据本身，而不是「表里恰好怎么写的」。
  const fat = new Set([...REGEX_AFTER_WORD, "a", "b", "x", "y", "obj", "models", "const"]);
  const wide = stripComments("const x = obj.of / 2; // 尾注释\n", { afterWord: fat });
  assert.ok(!wide.includes("尾注释"), "属性名之后的除号被读成了正则 —— `.` 那条判据没在干活");
});
