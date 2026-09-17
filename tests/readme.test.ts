/**
 * README 里写给用户看的「事实」，必须和仓库里的东西对得上。
 *
 * 本轮踩到的：`## 三种运行形态` 这一节的标题写「三」，
 * 可它下面明明白白列着 A. 控制台 CLI / B. Web 面板 / C. VS Code 扩展 /
 * D. 桌面端（Electron）—— **四个**；而文件开头那句又写着「四种形态」。
 * 同一份文档里两句话互相矛盾，而且没有任何东西会当场报出来：
 * 当初加桌面端的人改了开场白，漏了小节标题，就这样错了一整轮。
 *
 * 这里钉住三件「写死在 README 里、又确实会漂移」的事：
 *   1. 形态的数量 —— 小节标题里的数字、开场白里的数字、实际小节数，三者必须相等；
 *   2. 每个形态给出的入口（`npm run X` / `*.bat`）必须真的存在；
 *   3. 目录结构里写出来的文件名必须真的存在。
 *
 * 2 和 3 是**正向**的：只要求「写了就必须有」。所以新增一个 npm script、
 * 新增一个测试文件都不需要回来改 README —— 免得变成「每加一个文件就要动文档」
 * 那种迟早会被绕开的负担。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
