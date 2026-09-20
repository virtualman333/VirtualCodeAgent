/**
 * artifacts-untracked.test.ts —— 构建产物不许进版本库
 *
 * 为什么需要这份测试
 * ------------------
 * `dist-electron/` 是 `web/vite.config.ts` 的 `build.outDir`（前端产物），
 * `tests/source-utils.ts` 的 `ARTIFACT_DIRS` 里也写得明明白白 ——「别人装的、或者构建出来的，
 * 永远不属于源码」。可它有 **14 个文件被 git 跟踪着**：`.gitignore` 里从来没有
 * `dist-electron/` 这一条。于是每跑一次 `npm run build:web` 工作区就脏一次，
 * `git add -A` 顺手把产物收进下一个 commit。
 *
 * 而「补一条 .gitignore」**单独解决不了**它：gitignore 只影响**未跟踪**的文件，已经跟进的
 * 照样继续跟。所以这份检查盯的不是 `.gitignore` 的文本，而是 `git ls-files` 的**实际结果**
 * —— 那才是「它在不在版本库里」的真值。两条断言缺一不可：
 *   ① 覆盖：每个产物目录都被 .gitignore 写着（挡住**以后**进来的）；
 *   ② 脱钩：产物目录下没有被跟踪的文件（抓**已经**进去的）。
 *
 * 顺带覆盖 `release/` —— `electron-builder.json` 的 `directories.output`。它也没被忽略，
 * 跑一次 `npm run electron:dist` 就会多出几百 MB 的安装包等着被 `git add -A` 收走。
 *
 * 还有一处同源问题：`electron/src/main.ts` 的开发候选里曾经有
 * `dist-electron/server.js` —— 那是把「前端产物目录」当成「后端产物目录」的残留，
 * 它永远为假（后端是 tsc 出到 `dist/`），却会被印进启动失败对话框里。
 *
 * ⚠ 判据的边界（如实写下来）：第 ② 条是 `git ls-files` 在**当下**的快照，不是时间机器。
 *   它保证「此刻版本库里没有产物」，不保证「以后也没人强行 `git add -f`」。
 *   真挡住靠的是第 ① 条 + 有人跑完整份检查；这也是本仓库一贯的做法（能被看见才叫检查）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ARTIFACT_DIRS, REPO_ROOT } from "./source-utils.js";

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

/**
 * git 永远不会（也不可能）跟踪自己的目录，所以它不需要 .gitignore 条目。
 * **只放这一个**，并且下面断言这个豁免名单不会被悄悄加长 —— 豁免名单是这类检查最容易
 * 腐烂的地方：加一个名字，检查就少管一件事，而没有任何东西会响。
 */
const NEVER_TRACKED = new Set([".git"]);

/**
 * 从 .gitignore 文本里解析出被忽略的**顶层名字**。
 * 只认「一个名字、可带首尾斜杠」这种形态；`!` 反选与注释跳过；带通配/多段的规则不参与
 * （它们不是「整目录被忽略」的说法）。按 gitignore 语义，裸名字同时匹配文件与目录，
 * 所以这里不区分两者 —— 这里要回答的只是「这个名字被忽略了吗」。
 */
function ignoredTopNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const m = /^\/?([^/*?[\]\s]+)\/?$/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

/** ARTIFACT_DIRS 里哪些目录**没有**被 .gitignore 覆盖（`.git` 除外，见 NEVER_TRACKED） */
function uncoveredArtifactDirs(text: string, dirs: Iterable<string> = ARTIFACT_DIRS): string[] {
  const ignored = ignoredTopNames(text);
  return [...dirs].filter((d) => !NEVER_TRACKED.has(d) && !ignored.has(d)).sort();
}

/** 被跟踪的文件清单里，落在产物目录下的那些 */
function trackedArtifactFiles(files: string[], dirs: Iterable<string> = ARTIFACT_DIRS): string[] {
  const heads = new Set(dirs);
  return files
    .map((f) => f.split("\\").join("/"))
    .filter((f) => heads.has(f.split("/")[0]))
    .sort();
}

/** 现取被跟踪文件清单。取不到就**失败**，绝不静默跳过 —— 跳过的检查比没有更坏 */
function trackedFiles(): string[] {
  const r = spawnSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(
    r.status,
    0,
    "跑不了 `git ls-files`，这条检查读不到真值，因此不算通过。" +
      `（status=${r.status}，stderr=${String(r.stderr).trim().slice(0, 200)}）` +
      " 本仓库的测试要从 git 工作区里跑（git clone 或 git init 过）；" +
      "从源码 tarball 直接跑测试请改用 clone。"
  );
  return String(r.stdout).split("\n").map((s) => s.trim()).filter(Boolean);
}

describe("构建产物不许进版本库", () => {
  it("扫描面自证：产物清单与 .gitignore 都解析得出东西", () => {
    assert.ok(ARTIFACT_DIRS.size >= 5, `ARTIFACT_DIRS 只有 ${ARTIFACT_DIRS.size} 条 —— 扫描面塌了`);
    assert.ok(ARTIFACT_DIRS.has("dist-electron"), "ARTIFACT_DIRS 里没有 dist-electron（本测试的起因）");
    assert.ok(ARTIFACT_DIRS.has("dist"), "ARTIFACT_DIRS 里没有 dist");
    const gi = read(".gitignore");
    const names = ignoredTopNames(gi);
    assert.ok(names.size >= 5, `.gitignore 只解析出 ${names.size} 条顶层忽略名 —— 解析面塌了`);
    assert.ok(names.has("node_modules"), ".gitignore 里解析不到 node_modules（已知它写着，解析器坏了）");
    // 豁免名单不许悄悄变长
    assert.deepEqual([...NEVER_TRACKED], [".git"], "NEVER_TRACKED 被人加长了 —— 豁免一个目录就少管一件事");
  });

  it("① 每个产物目录都被 .gitignore 覆盖", () => {
    const missing = uncoveredArtifactDirs(read(".gitignore"));
    assert.deepEqual(
      missing,
      [],
      `这些产物目录没有被 .gitignore 覆盖：${missing.join("、")} —— ` +
        "跑一次构建/打包，产物就会出现在 `git status` 里等着被 `git add -A` 收走"
    );
  });

  it("② 产物目录下没有被 git 跟踪的文件（补 .gitignore 不会让已跟踪的脱钩）", () => {
    const files = trackedFiles();
    assert.ok(files.length >= 50, `只读到 ${files.length} 个被跟踪文件 —— 扫描面塌了，这条会变成空话`);
    assert.ok(files.includes(".gitignore"), "被跟踪清单里没有 .gitignore（读到的不是本仓库）");
    const bad = trackedArtifactFiles(files);
    assert.deepEqual(
      bad,
      [],
      `这些构建产物正躺在版本库里：${bad.slice(0, 8).join("、")}${bad.length > 8 ? ` …共 ${bad.length} 个` : ""} —— ` +
        "`git rm -r --cached <目录>` 让它们脱钩（磁盘文件不动），并把目录写进 .gitignore"
    );
  });

  it("判据自证：合成的输入必须被判出来，干净输入必须放行", () => {
    // ① 的判据
    assert.deepEqual(
      uncoveredArtifactDirs("node_modules/\ndist\n", ["node_modules", "dist", "release"]),
      ["release"],
      "覆盖判据漏了没被忽略的目录"
    );
    assert.deepEqual(
      uncoveredArtifactDirs("# 注释\n!.gitignore\ndist-electron/\n", [".git", "dist-electron"]),
      [],
      "覆盖判据把注释/反选当成了规则，或把 .git 也算了进去"
    );
    // ② 的判据
    assert.deepEqual(
      trackedArtifactFiles(["dist-electron/index.html", "src/main.ts", ".gitignore"]),
      ["dist-electron/index.html"],
      "跟踪判据没抓出产物里的文件（那这条就是恒真的）"
    );
    assert.deepEqual(
      trackedArtifactFiles(["distill/x.ts", "dist2/y.ts", "src/dist.ts"]),
      [],
      "跟踪判据按前缀而不是按目录段匹配 —— 会把 distill/ 这类正常目录判红"
    );
  });
});

describe("后端的产物目录只有一个（别把两个目录当成同一个）", () => {
  /**
   * 取 `electron/src/main.ts` 里开发模式那条候选数组的字面量。
   * 取不到就抛 —— 静默返回空数组会让下面的断言变成空话。
   */
  function devCandidates(): string[] {
    const src = read("electron/src/main.ts");
    const m = /: \[([^\]]*?)\]/.exec(
      // 只看 `app.isPackaged ? [...] : [...]` 的后半段
      src.slice(src.indexOf("app.isPackaged"), src.indexOf("candidates.find"))
    );
    assert.ok(m, "在 electron/src/main.ts 里解析不到开发候选数组 —— 判据需要更新");
    return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  }

  it("开发候选里没有 dist-electron（那是前端 vite 的 outDir，永远不会有 server.js）", () => {
    const cands = devCandidates();
    assert.ok(cands.length >= 1, `只解析出 ${cands.length} 条候选 —— 解析面塌了`);
    const wrong = cands.filter((c) => c.includes("dist-electron"));
    assert.deepEqual(
      wrong,
      [],
      `开发候选里混进了前端产物目录：${wrong.join("、")} —— 后端是 tsc 出到 dist/ 的，` +
        "这条候选每次启动都白跑一次 existsSync，还会被印进启动失败对话框让用户去找一个不存在的文件"
    );
    assert.ok(
      cands.some((c) => c === "dist" || c.endsWith("/dist")),
      `开发候选里没有 dist/ 这条（实际 ${JSON.stringify(cands)}）—— 后端入口找不到了`
    );
  });

  it("前端产物目录名从 vite 配置现算，不手抄", () => {
    // 与 webdist-agreement.test.ts 同一份来源：这里只确认「dist-electron 确实是前端 outDir」，
    // 万一以后 outDir 改了，上面那条断言的前提就变了，必须先在这里响。
    const vite = read("web/vite.config.ts");
    const m = /outDir\s*:\s*"([^"]+)"/.exec(vite);
    assert.ok(m, "在 web/vite.config.ts 里解析不到 build.outDir —— 判据需要更新");
    const outDir = path.relative(REPO_ROOT, path.resolve(path.join(REPO_ROOT, "web"), m[1]))
      .split(path.sep).join("/");
    assert.equal(
      outDir,
      "dist-electron",
      `前端产物目录变成了 ${outDir} —— 「后端候选里不该有 dist-electron」这条断言的前提变了`
    );
  });
});
