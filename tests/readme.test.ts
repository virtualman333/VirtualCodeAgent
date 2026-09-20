/**
 * README 里写给用户看的「事实」，必须和仓库里的东西对得上。
 *
 * 本轮踩到的：`## 三种运行形态` 这一节的标题写「三」，
 * 可它下面明明白白列着 A. 控制台 CLI / B. Web 面板 / C. VS Code 扩展 /
 * D. 桌面端（Electron）—— **四个**；而文件开头那句又写着「四种形态」。
 * 同一份文档里两句话互相矛盾，而且没有任何东西会当场报出来：
 * 当初加桌面端的人改了开场白，漏了小节标题，就这样错了一整轮。
 *
 * 这里钉住五件「写死在 README 里、又确实会漂移」的事：
 *   1. 形态的数量 —— 小节标题里的数字、开场白里的数字、实际小节数，三者必须相等；
 *   2. 每个形态给出的入口（`npm run X` / `*.bat`）必须真的存在；
 *   3. 目录结构里写出来的文件名必须真的存在；
 *   4. 写死的数字（回归集条数、Tab 候选上限、历史上限……）必须对上一个**现算真值**；
 *   5. 承诺「都照常放行」的那几条命令，必须真的在回归集里。
 *
 * 2 / 3 / 5 是**正向**的：只要求「写了就必须有」。所以新增一个 npm script、
 * 新增一个测试文件都不需要回来改 README —— 免得变成「每加一个文件就要动文档」
 * 那种迟早会被绕开的负担。
 *
 * 4 的扫描面是**减法**而不是「遍历登记表」：README 里每一处 `N 条` 要么被某条登记项
 * 认领、要么在 `PROSE_EXCUSED` 里写明理由。代价是「新写一句带 N 条的话」要顺手登记
 * 一格 —— 这正是它还会有用的原因：遍历登记表的话，「README 里多了一个没人扛的数字」
 * 只会让循环少跑一圈，**静默通过**（本仓库已经栽过这个形状）。真正的实测性叙述
 * （「实测 21 条读成 1 条」）进例外表就够，理由写清即可。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { MAX_HITS } from "../src/completer.js";
import { HISTORY_MAX, SHOW_DEFAULT } from "../src/input-history.js";
import { LIST_DEFAULT, MAX_INDEXED_SESSIONS } from "../src/session-store.js";
import { BENIGN } from "./benign-commands.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf-8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const webPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "package.json"), "utf-8"));

/** 跑 npm script 时真正可用的名字：根 + 前端各算各的（README 里两条都写了） */
const SCRIPTS = new Set([...Object.keys(pkg.scripts || {}), ...Object.keys(webPkg.scripts || {})]);

const CN_DIGIT: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
const CN = "[一二三四五六七八九十]+";

/** 「## N种运行形态」这一节（正文到下一个 `## ` 为止） */
function formsSection(): { num: number; label: string; body: string } {
  const m = new RegExp(`^## (${CN})种运行形态$`, "m").exec(README);
  assert.ok(m, "README 里应当有一节「## N种运行形态」");
  const start = m.index;
  const rest = README.slice(start + m[0].length);
  const nextIdx = rest.search(/^## /m);
  return {
    num: CN_DIGIT[m[1]],
    label: m[1],
    body: nextIdx >= 0 ? rest.slice(0, nextIdx) : rest,
  };
}

/** 这一节里的 `### X. 名字` 小节 */
function forms(body: string): { letter: string; name: string; text: string }[] {
  const marks = [...body.matchAll(/^### ([A-Z])\. (.+)$/gm)];
  return marks.map((mm, i) => ({
    letter: mm[1],
    name: mm[2].trim(),
    text: body.slice(mm.index, i + 1 < marks.length ? marks[i + 1].index : body.length),
  }));
}

/** 仓库里所有文件名（跳过依赖与产物目录）—— 用来核对 README 里写的名字是否真存在 */
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-electron", ".git", "release"]);
function allBasenames(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else {
        out.add(e.name);
      }
    }
  };
  walk(ROOT);
  return out;
}

test("形态数量：小节标题、开场白、实际小节三处必须一致", () => {
  const sec = formsSection();
  const list = forms(sec.body);

  // 先防「空集恒真」：解析不出东西的话，下面的断言全都是白过的
  assert.ok(list.length >= 3, `至少要列出三种形态，实际只解析出 ${list.length} 个 ### 小节`);

  const tagline = README.split("\n").find((l) => l.startsWith("> ")) || "";
  const tagNum = new RegExp(`(${CN})种形态`).exec(tagline);
  assert.ok(tagNum, `开场白里应当写明有几种形态，实际是：${tagline.slice(0, 60)}…`);
  assert.equal(
    CN_DIGIT[tagNum![1]], list.length,
    `开场白说「${tagNum![1]}种形态」，可这一节实际列了 ${list.length} 种`
  );
  assert.equal(
    sec.num, list.length,
    `小节标题写着「${sec.label}种运行形态」，可它下面列出了 ${list.length} 种`
  );

  // 编号得 A 起连续，不跳号（跳号多半是删了一种形态忘了重排）
  assert.deepEqual(
    list.map((f) => f.letter),
    list.map((_, i) => String.fromCharCode(65 + i)),
    "形态编号必须从 A 起连续"
  );
});

test("每个形态给出的入口都真实存在", () => {
  const list = forms(formsSection().body);
  let checked = 0;
  for (const f of list) {
    for (const m of f.text.matchAll(/npm run ([a-z][\w:.-]*)/g)) {
      assert.ok(
        SCRIPTS.has(m[1]),
        `形态「${f.name}」里写着 \`npm run ${m[1]}\`，可 package.json / web/package.json 里都没有这个脚本`
      );
      checked++;
    }
    for (const m of f.text.matchAll(/\b([\w-]+\.bat)\b/g)) {
      assert.ok(
        fs.existsSync(path.join(ROOT, m[1])),
        `形态「${f.name}」里写着 \`${m[1]}\`，可仓库里没有这个文件`
      );
      checked++;
    }
  }
  // 正则要是哪天匹配不上，这条锁就变成空转 —— 用下限把它顶住
  assert.ok(checked >= 4, `只核对了 ${checked} 个入口，正则多半没匹配上`);
});

test("目录结构里写出来的文件名都真实存在", () => {
  const block = /## 目录结构\s*\n+```[^\n]*\n([\s\S]*?)```/.exec(README);
  assert.ok(block, "README 里应当有一节带代码块的「## 目录结构」");

  // 只看树的左边那一列：`#` 后面是注解，那里出现的文件名不算承诺
  const names = new Set<string>();
  for (const line of block![1].split("\n")) {
    const tree = line.split("#")[0];
    for (const m of tree.matchAll(/\b([\w-]+\.(?:ts|mjs|js|vue|md|json|bat))\b/g)) names.add(m[1]);
  }
  assert.ok(names.size >= 5, `只在目录结构里解析出 ${names.size} 个文件名，正则多半没匹配上`);

  const have = allBasenames();
  for (const n of names) {
    assert.ok(have.has(n), `目录结构里写了 ${n}，可仓库里找不到这个文件`);
  }
});

// ---------------------------------------------------------------------------
// README 里**写死的数字** 与 「承诺照常放行」的命令
// ---------------------------------------------------------------------------
//
// 上面三条钉的是**结构**层面的事实。README 里还有一类更容易漂的东西：一个具体的数字、
// 几条具体的命令。它们写错了不会自相矛盾，所以漂了以后长得完全正常。
//
// 实测：README 写着「一份 40 条的良性回归集」，而 `tests/benign-commands.ts` 里已经是 73 条。
// 唯一的守护是 `BENIGN.length >= 20` —— 那是一条**空跑哨兵**（防的是这一节被削空），
// 它本来就不该、也不可能盯住 README 里的具体数字。清单从 40 涨到 73，README 一个字节没动，
// 没有任何东西会响。
//
// 三条判据：
//   ① 登记表里每个数字在 README 里必须**恰好命中一次** —— 0 次是解析面腐烂，
//      多次是正则太松（会在不相关的那个数字上判绿）；
//   ② README 承诺放行的命令，必须真的在回归集里；
//   ③ 扫描面做减法，见文件头。
// ---------------------------------------------------------------------------

/** 写进 README、又确实会漂的数字 —— 真值一律现算，README 只负责显示它 */
const README_COUNTS: Array<{ name: string; re: RegExp; truth: () => number; why: string }> = [
  {
    name: "良性回归集的条数",
    re: /一份 (\d+) 条的良性回归集/,
    truth: () => BENIGN.length,
    why: "它告诉阅读者这套护栏被多少条真实命令钉着；清单涨了它不涨，就是拿「40 条」当现状讲",
  },
  {
    name: "Tab 补全的候选上限",
    re: /候选最多 (\d+) 条/,
    truth: () => MAX_HITS,
    why: "README 用它解释「在盘符根目录按一下 Tab 不该把整屏刷掉」",
  },
  {
    name: "输入历史上限",
    re: /规则：最多 (\d+) 条/,
    truth: () => HISTORY_MAX,
    why: "历史文件与 Python 版共用一个文件，上限改了不写出来，老用户会以为自己的历史丢了",
  },
  {
    name: "`/input` 参数的夹取上界",
    re: /夹到 1~(\d+)/,
    truth: () => HISTORY_MAX,
    why: "同一个上限在 README 里的第二处写法 —— 写法不同更容易各改各的，必须同源",
  },
  {
    name: "`/input` 默认显示条数",
    re: /列最近 (\d+) 条/,
    truth: () => SHOW_DEFAULT,
    why: "README 顺带解释了「为什么是这个数」（一屏看完）；数字变了那个理由就不成立",
  },
  {
    name: "`/history` 默认显示个数",
    re: /列最近 (\d+) 个/,
    truth: () => LIST_DEFAULT,
    why: "它与 `/load <序号>` 的序号是同一份窗口 —— 写错了用户会按序号载到别的会话",
  },
  {
    name: "会话索引的条数上限",
    re: /索引里最多留 (\d+) 条记录/,
    truth: () => MAX_INDEXED_SESSIONS,
    why: "这个数决定了「什么时候会有会话滚出索引」；改了它 README 与代码就对不上了",
  },
  {
    name: "`/history` 参数的夹取上界",
    re: /只看最近 N 个（1 ~ (\d+)）/,
    truth: () => MAX_INDEXED_SESSIONS,
    why: "同一个上限在 README 里的第二处写法（`/input` 那一对也是两条）—— 必须同源",
  },
];

/** `N 条` 里那些**不是当前规模**的出现处 —— 实测性叙述 / 示例输出，锁它们等于锁历史 */
const PROSE_EXCUSED: Array<{ re: RegExp; why: string }> = [
  { re: /实测 21 条读成 1 条 21 行的巨型条目/, why: "记录的是当年那次把多行历史拼成一条的实测数据，不是当前值" },
  { re: /实测 21\/21 条如此/, why: "同上：历史实测数据" },
  { re: /输入历史 · 匹配「redis」 2 \/ 5 条/, why: "终端示例输出里的示意数字" },
  { re: /（14 条里只有 `return` 有测试）/, why: "叙述的是这张关键字表**当年**的状态；它当前的大小由 source-utils.test.ts 的宇宙减法钉着" },
  { re: /硬砍成 \d+ 条/, why: "讲的是会话索引**改之前**那个上限（50），是历史叙述；当前值由「索引里最多留 N 条记录」那条登记项现算" },
  { re: /从第 21 条会话起/, why: "讲的是**改之前**那个默认值（`listSessions()` 默认只给 20 条）算出来的后果，是历史叙述；现在的默认是「全部」，真值由 session-store.test.ts 现算" },
];

test("README 写死的数字：都要对上一个现算真值，且解析面不许腐烂", () => {
  assert.ok(README_COUNTS.length >= 4, `数字登记表只剩 ${README_COUNTS.length} 条`);
  for (const c of README_COUNTS) {
    const hits = [...README.matchAll(new RegExp(c.re.source, "g"))];
    assert.equal(
      hits.length, 1,
      `「${c.name}」的正则在 README 里命中 ${hits.length} 次（必须恰好 1 次）—— 0 次是解析面腐烂，多次是正则太松`
    );
    const truth = c.truth();
    assert.ok(Number.isFinite(truth), `「${c.name}」的现算真值不是数：${truth}`);
    assert.ok(c.why.trim().length >= 8, `「${c.name}」缺登记理由`);
    assert.equal(Number(hits[0][1]), truth, `README 里「${c.name}」写着 ${hits[0][1]}，现算真值是 ${truth}`);
  }
});

test("README 承诺「都照常放行」的命令，必须真的在回归集里", () => {
  // 那段是 README 替护栏许的诺。诺言里的命令必须真被回归集验过 —— 否则
  // 从回归集里删掉那一行不会有任何东西会响，而文档还在说「实测放行」。
  const para = /反过来也钉死了：[\s\S]*?都照常放行。/.exec(README);
  assert.ok(para, "README 里应当有「正常清理与只读命令一条都不许拦」那一段");
  const cmds = [...para![0].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.ok(cmds.length >= 4, `只在那段解析出 ${cmds.length} 条命令，正则多半没匹配上`);
  for (const c of cmds) {
    assert.ok(
      BENIGN.includes(c),
      `README 承诺放行 \`${c}\`，可回归集里没有这一条 —— 这个诺没有任何东西在验`
    );
  }
});

test("`N 条` 的扫描面做减法：没被登记、也没写明理由的出现处要报出来", () => {
  const family = [...README.matchAll(/\d+\s*条/g)];
  assert.ok(family.length >= 3, `只在 README 里找到 ${family.length} 处「N 条」，正则多半没匹配上`);

  const spansOf = (re: RegExp): Array<[number, number]> =>
    [...README.matchAll(new RegExp(re.source, "g"))].map((m) => [m.index!, m.index! + m[0].length]);
  const spans = [...README_COUNTS.flatMap((c) => spansOf(c.re)), ...PROSE_EXCUSED.flatMap((e) => spansOf(e.re))];
  const covered = (i: number): boolean => spans.some(([s, e]) => i >= s && i < e);

  // ① 例外表先查腐烂：README 改了措辞之后，一条都命中不了的理由就是在骗后来人。
  //    必须排在下面那条**前面** —— 理由烂掉的同时，它原本认领的那几处 `N 条` 会变成
  //    「没人扛」，而那条报的是**症状**；先报原因才知道该改哪一行（实测过：顺序反了的话，
  //    这条断言永远轮不到自己说话，等于不存在）。
  for (const e of PROSE_EXCUSED) {
    assert.ok(new RegExp(e.re.source).test(README), `例外表里这条理由一条都没命中，已经腐烂：${e.re}`);
    assert.ok(e.why.trim().length >= 8, `例外表里缺理由：${e.re}`);
  }

  // ② 再做减法：剩下的每一处都必须有人认领
  const unowned = family
    .filter((m) => !covered(m.index!))
    .map((m) => `第 ${README.slice(0, m.index!).split("\n").length} 行 「${m[0].trim()}」`);
  assert.deepEqual(unowned, [], "这些「N 条」既没被登记表认领，也没写明为什么不锁");
});
