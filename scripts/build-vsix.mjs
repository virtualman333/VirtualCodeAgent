#!/usr/bin/env node
/**
 * VCA - 一条命令把源码打成可安装的 VSIX（跨平台，零额外依赖）
 *
 * 用法:
 *   node scripts/build-vsix.mjs              # 完整构建并打包
 *   node scripts/build-vsix.mjs --skip-web   # 复用 web/dist，跳过前端构建
 *   node scripts/build-vsix.mjs --skip-ext   # 复用 vscode/dist，跳过扩展构建
 *   node scripts/build-vsix.mjs --no-package # 只构建，不打包（调试用）
 *
 * 为什么要有这个脚本:
 *   这条链路原先只存在于 `build-vsix.bat` 里，于是「从干净 clone 打出 VSIX」
 *   在 Windows 之外根本走不通（`publish.mjs` 还要 `cmd /c build-vsix.bat`）；
 *   而 README 给出的另一条路 —— 在 `vscode/` 目录直接 `npx vsce package` ——
 *   在干净 clone 上**必然失败**：扩展入口 `vscode/dist/extension.js` 是构建产物，
 *   不随源码入库，vsce 只会甩一句
 *       ERROR  Extension entrypoint(s) missing.
 *   所以这里把「入口在不在、会不会被打包进去」提成一等公民的预检
 *   （`preflightVscode`，tests/vsix-chain.test.ts 直接对着它做正反两向验证），
 *   再构建、再打包，最后核验产物**真的落盘**才打印成功 ——
 *   而不是跑完命令就宣布完成。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 相对仓库根的可读路径（日志里不出现绝对路径，便于跨机器比对） */
function rel(from, abs) {
  return path.relative(from, abs).split(path.sep).join("/");
}

/** 读 `vscode/.vscodeignore`：剥掉空行与注释，只留有效 pattern */
export function readVscodeignore(vscodeDir) {
  const file = path.join(vscodeDir, ".vscodeignore");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** 单段 glob（`*` 不跨 `/`，`?` 匹配一个非 `/` 字符） */
function globMatch(glob, s) {
  const re = glob
    .split("")
    .map((c) => {
      if (c === "*") return "[^/]*";
      if (c === "?") return "[^/]";
      return /[.+^${}()|[\]\\]/.test(c) ? "\\" + c : c;
    })
    .join("");
  return new RegExp(`^${re}$`).test(s);
}

/**
 * `.vscodeignore` 的匹配语义（gitignore 子集，够本仓库用）。
 * 只有三条规则，逐条都在 tests/vsix-chain.test.ts 里有正反样例：
 *   1. `dir/**`    —— dir 下的一切；
 *   2. `**\/tail`   —— 任意层级的同名项；
 *   3. 无斜杠     —— 任意层级上的同名项（gitignore 语义）；
 * 带斜杠且不以 `**` 开头的按「锚在仓库根」处理（`dist/*.map`）。
 */
export function matchIgnore(pattern, relPath) {
  const p = pattern.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!p) return false;
  if (p.endsWith("/**")) {
    const base = p.slice(0, -3);
    return relPath === base || relPath.startsWith(base + "/");
  }
  if (p.startsWith("**/")) {
    const tail = p.slice(3);
    return relPath.split("/").some((seg) => globMatch(tail, seg));
  }
  if (p.includes("/")) return globMatch(p, relPath);
  return relPath.split("/").some((seg) => globMatch(p, seg));
}

/**
 * 打包前的预检：**在跑 vsce 之前**就回答「打出来的包里有没有入口」。
 *
 * 返回 `{ ok, problems, name, version, main, entry, relEntry }`。
 * `problems` 每项是 `{ code, message }`，code 供测试精确断言，message 供人看。
 */
export function preflightVscode(rootDir = ROOT) {
  const vscodeDir = path.join(rootDir, "vscode");
  const manifestPath = path.join(vscodeDir, "package.json");
  const problems = [];
  const empty = { ok: false, problems, name: null, version: null, main: null, entry: null, relEntry: null };

  if (!fs.existsSync(manifestPath)) {
    problems.push({
      code: "vscode-manifest-missing",
      message: `找不到扩展清单 ${rel(rootDir, manifestPath)}，这个目录不是 VS Code 扩展`,
    });
    return empty;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    problems.push({
      code: "vscode-manifest-invalid",
      message: `扩展清单不是合法 JSON：${e.message}`,
    });
    return empty;
  }

  const main = typeof manifest.main === "string" ? manifest.main : "";
  if (!main) {
    problems.push({
      code: "vscode-main-missing",
      message: "扩展清单里没有 main 字段，VS Code 不知道从哪里加载扩展",
    });
    return { ...empty, name: manifest.name ?? null, version: manifest.version ?? null };
  }

  const entry = path.resolve(vscodeDir, main);
  const relEntry = rel(vscodeDir, entry);

  if (!fs.existsSync(entry)) {
    problems.push({
      code: "vscode-entry-missing",
      message:
        `扩展入口不存在: vscode/${relEntry}\n` +
        "    它是构建产物，不随源码入库（干净 clone 里必然没有）。" +
        "先跑 `npm run vsix`（会自动构建），或 `npm run electron:build`。",
    });
  }

  const hit = readVscodeignore(vscodeDir).find((p) => matchIgnore(p, relEntry));
  if (hit) {
    problems.push({
      code: "vscode-entry-ignored",
      message: `扩展入口 vscode/${relEntry} 被 .vscodeignore 的 \`${hit}\` 排除了，打出来的 VSIX 里不会有它`,
    });
  }

  return {
    ok: problems.length === 0,
    problems,
    name: manifest.name ?? null,
    version: manifest.version ?? null,
    main,
    entry,
    relEntry,
  };
}

/** 本地 vsce 的 JS 入口（不走 shell、不联网、不依赖 npx 能不能解析到） */
function resolveVsce(rootDir) {
  const js = path.join(rootDir, "node_modules", "@vscode", "vsce", "vsce");
  return fs.existsSync(js) ? js : null;
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.error) {
    console.error(`[build-vsix] 执行失败: ${cmd} ${args.join(" ")}\n  ${res.error.message}`);
    process.exit(1);
  }
  return res.status ?? 1;
}

export function parseArgs(argv) {
  const opt = { skipWeb: false, skipExt: false, package: true };
  for (const a of argv) {
    switch (a) {
      case "--skip-web":
        opt.skipWeb = true;
        break;
      case "--skip-ext":
        opt.skipExt = true;
        break;
      case "--no-package":
        opt.package = false;
        break;
      case "-h":
      case "--help":
        console.log(
          fs
            .readFileSync(fileURLToPath(import.meta.url), "utf-8")
            .split("*/")[0]
            .replace(/^\/\*\*|^ \* ?/gm, "")
            .replace(/\*\/$/, "")
        );
        process.exit(0);
        break;
      default:
        console.error(`[build-vsix] 未知参数: ${a}\n用法: node scripts/build-vsix.mjs [--skip-web] [--skip-ext] [--no-package]`);
        process.exit(1);
    }
  }
  return opt;
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  // 前端产物目录 = web/vite.config.ts 的 build.outDir（唯一来源）
  const webDist = path.join(ROOT, "dist-electron");
  const webIndex = path.join(webDist, "index.html");
  const extEntry = path.join(ROOT, "vscode", "dist", "extension.js");

  // ---- 1. 前端（扩展包自包含，缺了它扩展面板是白屏） ----
  if (opt.skipWeb) {
    console.log("[1/4] 跳过前端构建 (--skip-web)");
  } else {
    console.log("[1/4] 构建前端...");
    const code = run("npm", ["run", "build"], {
      cwd: path.join(ROOT, "web"),
      shell: process.platform === "win32",
    });
    if (code !== 0) {
      console.error("[build-vsix] 前端构建失败");
      process.exit(1);
    }
  }
  if (!fs.existsSync(webIndex)) {
    console.error(
      `[build-vsix] 缺少前端产物 ${webIndex}。\n` +
        "    先跑一次 `npm run build:web`，或去掉 --skip-web 让本脚本代劳。"
    );
    process.exit(1);
  }

  // ---- 2. 扩展（唯一的构建实现仍是 scripts/build-extension.mjs，这里只负责调它） ----
  if (opt.skipExt) {
    console.log("[2/4] 跳过扩展构建 (--skip-ext)");
  } else {
    console.log("[2/4] 构建扩展...");
    const code = run(process.execPath, [path.join(ROOT, "scripts", "build-extension.mjs")]);
    if (code !== 0) {
      console.error("[build-vsix] 扩展构建失败");
      process.exit(1);
    }
  }

  if (!opt.package) {
    console.log("[3/4] 跳过打包 (--no-package)");
    console.log("[4/4] 完成：已构建，未打包");
    return;
  }

  // ---- 3. 打包前预检 + 打包 ----
  console.log("[3/4] 预检并打包 VSIX...");
  const pre = preflightVscode(ROOT);
  if (!pre.ok) {
    console.error("[build-vsix] 预检未通过 —— 打出来的包不会可用：");
    for (const p of pre.problems) console.error(`  ✗ [${p.code}] ${p.message}`);
    process.exit(1);
  }
  console.log(`  扩展入口就位: vscode/${pre.relEntry}  (v${pre.version})`);

  const vsceJs = resolveVsce(ROOT);
  if (!vsceJs) {
    console.error(
      "[build-vsix] 找不到 @vscode/vsce（node_modules/@vscode/vsce/vsce）。\n" +
        "    它已在 package.json 的 dependencies 里，先跑 `npm install`。"
    );
    process.exit(1);
  }

  const outFile = path.join(ROOT, "vscode", `${pre.name}-${pre.version}.vsix`);
  fs.rmSync(outFile, { force: true });
  const code = run(
    process.execPath,
    [vsceJs, "package", "--allow-missing-repository", "--no-dependencies", "--out", outFile],
    { cwd: path.join(ROOT, "vscode") }
  );
  if (code !== 0) {
    console.error("[build-vsix] vsce 打包失败");
    process.exit(code);
  }

  // ---- 4. 核验产物真的落盘（命令退出码不是证据） ----
  if (!fs.existsSync(outFile)) {
    console.error(`[build-vsix] vsce 报了成功，但产物不在: ${outFile}`);
    process.exit(1);
  }
  const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
  if (fs.statSync(outFile).size < 10 * 1024) {
    console.error(`[build-vsix] 产物只有 ${kb} KB，多半少了前端产物或扩展入口，别装它`);
    process.exit(1);
  }
  console.log(`[4/4] 完成 → ${rel(ROOT, outFile)} (${kb} KB)`);
  console.log("    安装：VS Code 扩展面板 → 右上角 ⋯ → 从 VSIX 安装");
}

// 被 import 时不执行（测试只借它的 preflight / matchIgnore）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
