/**
 * webdist-agreement.test.ts —— 前端产物目录：一个来源，五处消费方
 *
 * 为什么需要这份测试
 * ------------------
 * `web/vite.config.ts` 里 `build.outDir` 决定前端产物落在哪儿，而**读**它的地方有四处，
 * 各写一遍路径。此前它们不一致：
 *
 *   | 写 / 读                                  | 路径            |
 *   |------------------------------------------|-----------------|
 *   | web/vite.config.ts（唯一的写方）          | dist-electron/  |
 *   | src/server.ts（README §B，:3001）         | web/dist/       |
 *   | scripts/build-extension.mjs               | web/dist/       |
 *   | scripts/build-vsix.mjs                    | web/dist/       |
 *   | electron-builder.json extraResources      | web/dist/       |
 *   | electron/src/main.ts（生产加载 index）    | dist-electron/  |
 *
 * 于是按 README §B 原样操作（`npm run build:web` → `npm run serve` → localhost:3001），
 * 端出来的是**另一个目录里遗留的旧前端**：实测本机 `web/dist` 的时间是 8/19，
 * 而真产物是 9/18；干净克隆里 `web/dist` 被 .gitignore 排除、根本不存在，
 * 于是首页白屏而服务照常打印「服务已启动」。
 *
 * 本文件把「五处是否指向同一个目录」变成会响的检查：目录名**从 vite 配置现算**，
 * 不手抄 —— 手抄一份期望值，下次改 outDir 时这条锁自己就失效了。
 *
 * ⚠ 判据的边界（如实写下来）：这里做的是**源码文本级**的路径一致性，
 *   不是「跑一遍构建看文件落在哪」。vite 的 outDir 允许写表达式，本仓写的是字面量；
 *   一旦它变成运行时才算得出来的东西，这条锁会先报「解析不到」而不是默默放过。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "./source-utils.js";

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** 从 vite 配置里现算产物目录（相对仓库根的 posix 路径），这是唯一来源 */
function outDirFromVite(src: string): string {
  const m = /build\s*:\s*\{[\s\S]*?outDir\s*:\s*"([^"]+)"/.exec(src);
  assert.ok(m, "在 web/vite.config.ts 里解析不到 build.outDir 的字符串字面量 —— 判据需要更新");
  // outDir 相对 vite 的 root（web/）解析
  const abs = path.resolve(path.join(REPO_ROOT, "web"), m[1]);
  return path.relative(REPO_ROOT, abs).split(path.sep).join("/");
}

/** 从一段 `path.resolve(...)` / `path.join(...)` 里把所有字符串字面量拼成路径 */
function joinedLiterals(expr: string): string {
  const lits = [...expr.matchAll(/"([^"]*)"/g)].map((x) => x[1]).filter((s) => s.length > 0);
  return lits.join("/");
}

/**
 * 在源码里找「某个变量被赋成路径」的那一处，返回其右侧表达式。
 * 找不到就抛 —— 静默返回空串会让后面的断言变成空话。
 */
function assignmentRhs(src: string, varName: string, where: string): string {
  const re = new RegExp(`(?:const|let)\\s+${varName}\\s*=\\s*([^;\\n]+(?:\\n[^;\\n]*)*?);`, "m");
  const m = re.exec(src);
  assert.ok(m, `${where}: 找不到 ${varName} 的赋值 —— 这条对账失去了抓手`);
  return m[0];
}

describe("前端产物目录 · 一个来源五处消费方", () => {
  const viteSrc = read("web/vite.config.ts");
  const OUT_DIR = outDirFromVite(viteSrc);
  const OUT_NAME = OUT_DIR.split("/").pop() as string;

  it("自证：vite 的 outDir 解析出来了，而且是个真目录名", () => {
    // 注意：outDir 允许是单段名（本仓就是 `../dist-electron` → 仓库根的 dist-electron），
    // 所以不能拿「必须含 /」当自证 —— 那是拿判据的形状当结论。
    assert.ok(OUT_DIR.length > 0, "outDir 解析成空串");
    assert.ok(!path.isAbsolute(OUT_DIR), `outDir 应当是相对仓库根的路径，实际 ${OUT_DIR}`);
    assert.ok(!OUT_DIR.startsWith(".."), `outDir 跑到仓库外面了：${OUT_DIR}`);
    const last = OUT_DIR.split("/").pop() as string;
    assert.ok(last.length > 2, `末级目录名不可信：${last}`);
    assert.ok(!last.includes("."), `末级看起来是文件名而不是目录：${last}`);
  });

  it("写方在 web/ 外面时，vite 必须显式 emptyOutDir（否则旧产物会攒在包里）", () => {
    if (!OUT_DIR.startsWith("web/")) {
      assert.match(viteSrc, /emptyOutDir\s*:\s*true/, "outDir 在 vite root 之外，必须显式 emptyOutDir: true");
    }
  });

  it("src/server.ts 的 WEB_DIST 指向同一个目录", () => {
    const src = read("src/server.ts");
    const rhs = assignmentRhs(src, "WEB_DIST", "src/server.ts");
    const joined = joinedLiterals(rhs);
    assert.ok(
      joined.endsWith(OUT_NAME),
      `server.ts 的 WEB_DIST 末级是 ${joined || "(解析不出)"}，vite 输出到 ${OUT_NAME}\n${rhs}`
    );
    assert.ok(
      !joined.includes("web/dist"),
      `server.ts 又指回 web/dist 了（那里 vite 不写东西）\n${rhs}`
    );
  });

  it("scripts/build-extension.mjs 复制的是同一个目录", () => {
    const src = read("scripts/build-extension.mjs");
    const rhs = assignmentRhs(src, "webDist", "build-extension.mjs");
    const joined = joinedLiterals(rhs);
    assert.ok(joined.endsWith(OUT_NAME), `build-extension.mjs 的 webDist 末级是 ${joined}，应为 ${OUT_NAME}\n${rhs}`);
  });

  it("scripts/build-vsix.mjs 打包的是同一个目录", () => {
    const src = read("scripts/build-vsix.mjs");
    const rhs = assignmentRhs(src, "webDist", "build-vsix.mjs");
    const joined = joinedLiterals(rhs);
    assert.ok(joined.endsWith(OUT_NAME), `build-vsix.mjs 的 webDist 末级是 ${joined}，应为 ${OUT_NAME}\n${rhs}`);
  });

  it("electron/src/main.ts 生产模式加载同一目录下的 index-electron.html", () => {
    const src = read("electron/src/main.ts");
    const m = /path\.join\(\s*ROOT\s*,\s*"([^"]+)"\s*,\s*"(index-electron\.html)"\s*\)/.exec(src);
    assert.ok(m, "在 electron/src/main.ts 里找不到生产模式的 index 路径 —— 这条对账失去了抓手");
    assert.equal(m[1], OUT_NAME, `main.ts 生产加载的是 ${m[1]}/，vite 输出到 ${OUT_NAME}/`);
  });

  it("electron-builder 的 extraResources 映射到同一个名字（打包后 server 才找得到）", () => {
    const cfg = JSON.parse(read("electron-builder.json")) as {
      extraResources: Array<{ from: string; to: string; filter?: string[] }>;
    };
    const entry = cfg.extraResources.find((e) => !e.filter);
    assert.ok(entry, "extraResources 里找不到前端那条（带 filter 的是 server 那条）");
    assert.equal(entry!.from, OUT_NAME, `extraResources.from = ${entry!.from}，vite 输出到 ${OUT_NAME}`);
    // 打包后 server.js 在 resources/server/，它按 `__dirname/..` 找前端 → to 必须同名
    assert.equal(
      entry!.to,
      OUT_NAME,
      `extraResources.to = ${entry!.to}，而 server 进程按 <resources>/${OUT_NAME} 找 —— 名字不一致就是打包版白屏`
    );
  });

  it("反向对照：判据读的是源码，不是把期望值写死", () => {
    // 把一段合成的「旧写法」喂给同一个解析器，必须解析出 web/dist ——
    // 如果它无论输入什么都返回 dist-electron，上面几条全是空话。
    const synthetic = 'const webDist = path.join(root, "web", "dist");';
    const rhs = assignmentRhs(synthetic, "webDist", "合成样本");
    const joined = joinedLiterals(rhs);
    assert.equal(joined, "web/dist", `合成样本应当解析成 web/dist，实际 ${joined}`);
    assert.ok(!joined.endsWith(OUT_NAME), "合成样本被判成与现网一致 —— 判据恒真");
  });
});
