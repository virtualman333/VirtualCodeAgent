/**
 * 「本仓库的颜色/样式全部由 `src/ui.ts` 的 `esc()` 产出」—— 给这句话配一条检查。
 *
 * 为什么
 * ------
 * 这句话一直写在 `src/ui.ts` 的注释里，但**没有任何东西在扛**。于是同一件事在仓库里
 * 有了四份实现：
 *
 *   src/main.ts            red / blue（`\x1b[31m` 拼字符串）
 *   src/agent/runner.ts    red / blue（同上）
 *   src/workspace.ts       green（同上）
 *   src/ui.ts              esc() —— 唯一那份
 *
 * main.ts 里那份后来被清掉了，走的时候还留了段注释：「ANSI 处理一旦在 ui.ts 里统一
 * 改动（比如加 NO_COLOR 支持），这两份副本不会跟着变」—— 话说对了，但**只清了
 * main.ts 那一处**，runner.ts 与 workspace.ts 原样留着。这是本仓库第二次栽在
 * 「修掉的那一半，旁边还有第二个写者」上。
 *
 * 副本的代价不是多几行：`displayWidth` / `wrapToWidth` / 跨行续样式全靠 `SGR_RE`
 * 认出这些序列，而「以后要在 ui.ts 里统一改 ANSI 处理」这件事——加 NO_COLOR、
 * 换主题、改成 24 位色——一旦发生，副本一律不跟，**而且不报错**。
 *
 * 这条锁怎么判
 * ------------
 * 1. **行为**：先从 ui.ts 真调一次 red / green / blue / cyan，断言它们产出的就是
 *    `\x1b[<code>m…\x1b[0m`。这是「单一来源确实存在」的前提 —— 没有它，
 *    下面那半条「源码里没有第二份」会因为「一份都没有」而恒真。
 * 2. **结构**：扫全仓 `.ts` 源码，**剥掉注释之后**不得再出现裸转义序列
 *    （`\x1b[`、`\u001b[`、`\033[` 这几种写法），ui.ts 自己除外。
 * 3. **扫描面自证**：文件数不能塌、ui.ts 里的转义序列数不能变成 0 ——
 *    否则「全仓没有」会是一句因为什么都没扫而成立的空话。
 *
 * 为什么排除 `tests/`：这里面的裸转义是**测试数据**（`ui.test.ts` 要拿序列喂
 * `stripAnsi` / `displayWidth` / `wrapToWidth`，`help.test.ts` 要验对齐），
 * 它们是消费者不是生产者。排除它是刻意写下来的，不是漏了 ——
 * 登记在 `./source-utils.ts` 的 `EXCLUDED_SOURCE_DIRS` 里（两条锁共用一份，
 * 免得「为什么排除 tests」这件事写两遍各自漂移）。
 *
 * 扫描面本身也**不再是手抄的目录清单**：原来写的是 `SCAN_ROOTS = ["src",
 * "electron/src", "vscode/src", "web/src"]`，于是 `web/vite.config.ts` 这种
 * 「不在清单里的源码」永远扫不到。现在走 `sourceSurface()` 现算。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { blue, bold, cyan, green, gray, red, yellow } from "../src/ui.js";
import { EXCLUDED_SOURCE_DIRS, REPO_ROOT, sourceSurface, stripComments } from "./source-utils.js";

const ROOT = REPO_ROOT;

/** 唯一允许产出裸转义序列的地方 */
const SOURCE_OF_TRUTH = "src/ui.ts";

/** 现算的扫描面（`.ts`；`.vue` 里不拼转义序列） */
const SURFACE = sourceSurface(/\.ts$/);

/**
 * 裸转义序列的几种写法。
 *
 * 注意 `\x1b[` 在源码里是以**反斜杠 + x + 1 + b** 四个字符存在的（字符串字面量里的转义），
 * 所以这里匹配的是那四个字符，不是真正的 ESC 字节。
 *
 * `\\?` 是要连**正则字面量**那种形态一起认：`/\x1b\[31m/` 里的 `[` 前面多一个反斜杠
 * （`\x1b\[` 与 `\x1b[` 在源码文本上不是一个东西）。它同样是「在 ui.ts 之外自己维护
 * SGR 的形态」—— 本仓库就有一处正则该这么写（ui.ts 的 `SGR_RE`），而 `stripAnsi` /
 * `displayWidth` / `wrapToWidth` 全建立在「形态只有这一种」之上。
 */
const RAW_SGR = /\\x1[bB]\\?\[|\\u001[bB]\\?\[|\\033\\?\[/g;

test("ui.ts 的 color helper 真的产出 SGR（单一来源存在，后面的排除才有意义）", () => {
  assert.equal(red("x"), "\x1b[31mx\x1b[0m");
  assert.equal(green("x"), "\x1b[32mx\x1b[0m");
  assert.equal(yellow("x"), "\x1b[33mx\x1b[0m");
  assert.equal(blue("x"), "\x1b[34mx\x1b[0m");
  assert.equal(cyan("x"), "\x1b[36mx\x1b[0m");
  assert.equal(gray("x"), "\x1b[90mx\x1b[0m");
  // 复合样式（panel 的标题就是这么拼的）也必须是「每层一开一关」
  assert.equal(bold(blue("x")), "\x1b[1m\x1b[34mx\x1b[0m\x1b[0m");
});

test("全仓源码里没有第二份裸 SGR —— 颜色只能从 ui.ts 出", () => {
  // 扫描面自证先行（第 3 条自证在下面：ui.ts 里必须还有转义序列）
  assert.deepEqual(SURFACE.problems, [], `扫描面自身不自洽：\n  ${SURFACE.problems.join("\n  ")}`);
  const files = SURFACE.files;

  // 扫描面自证：文件数塌了就说明根目录改了，这条锁会变成一句空话
  assert.ok(files.length >= 20, `扫到的 .ts 文件太少（${files.length} 个），扫描面塌了`);
  assert.ok(files.includes(SOURCE_OF_TRUTH), `扫描面里应当包含 ${SOURCE_OF_TRUTH}`);
  assert.ok(
    files.includes("web/vite.config.ts"),
    "现算的扫描面连 web/vite.config.ts 都没包进来 —— 手抄清单那个洞又回来了"
  );

  const offenders: string[] = [];
  let truthCount = 0;

  // 探测器自证：先拿一段确定的样本确认它现在还认得出「源码里拼出来的转义序列」。
  // 少了这条，探测正则哪天写坏（比如把字符类吃错），整条锁会对所有文件判绿。
  assert.equal((`const R = "\\x1b[0m";`.match(RAW_SGR) || []).length, 1,
    "探测正则失效了 —— 连写死的样本都认不出来，下面「全仓没有」是一句空话");
  assert.equal((`const R = /\\x1b\\[[0-9;]*m/;`.match(RAW_SGR) || []).length, 1,
    "探测正则认不出正则字面量里的形态（`\\x1b\\[` 那一支）");

  for (const rel of files) {
    const raw = fs.readFileSync(path.join(ROOT, rel), "utf-8");
    // 必须先剥注释再数：本仓库的既定风格就是「在注释里写下反面示例」
    // （ui.ts 与 runner.ts 的注释里都恰好提到了 `\x1b[`），拿原文去数会当场假红。
    const code = stripComments(raw);
    const n = (code.match(RAW_SGR) || []).length;
    if (n === 0) continue;
    if (rel === SOURCE_OF_TRUTH) { truthCount += n; continue; }
    offenders.push(`${rel} (${n} 处)`);
  }

  assert.deepEqual(offenders, [],
    `颜色/样式只能由 ${SOURCE_OF_TRUTH} 的 esc() 产出，这些地方自己拼了转义序列：\n  ` +
    offenders.join("\n  ") +
    `\n改成从 ui.ts import 同名 helper（red / green / blue / cyan / yellow / dim / bold …）。`);

  // 另一半自证：ui.ts 里确实还有转义序列（实测 4 处：RESET、esc 的拼装、SGR_RE、
  // 折行时那个「行尾空白 + 转义」的正则）。少了这条，「全仓没有」在「连 ui.ts 也
  // 不产出」的情况下同样成立 —— 那时这条锁什么也没在守。
  assert.ok(truthCount >= 3,
    `${SOURCE_OF_TRUTH} 里的转义序列只剩 ${truthCount} 处（实测应有 4 处）—— ` +
    `要么探测正则失效了，要么单一来源自己没了，这条锁失去意义`);
});

test("测试目录被排除是刻意的：那里的裸转义是测试数据", () => {
  // 这条不是在测被测代码，是在钉住上面那条锁的**排除项**：
  // 如果哪天有人把 tests/ 也扫进去，ui.test.ts / help.test.ts 会立刻假红，
  // 而那时最省事的「修法」是把锁删掉。写在测试里，改动者能看见理由。
  assert.ok(EXCLUDED_SOURCE_DIRS.tests, "tests/ 不在排除表里了 —— 上面那条锁的排除项被改掉了");
  assert.ok(
    !SURFACE.files.some((f) => f.startsWith("tests/")),
    "扫描面里出现了 tests/ 下的文件，排除表没生效"
  );
  const uiTest = fs.readFileSync(path.join(ROOT, "tests", "ui.test.ts"), "utf-8");
  assert.ok((uiTest.match(RAW_SGR) || []).length > 0,
    "tests/ui.test.ts 里本该有裸转义作为测试数据；没有了的话，把 tests/ 排除的理由要重写");
});
