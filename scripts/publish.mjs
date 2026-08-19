#!/usr/bin/env node
/**
 * VCA - 发布 VS Code 扩展到插件市场
 *
 * 支持:
 *   - VS Code Marketplace (vsce publish)
 *   - Open VSX (ovsx publish, --ovsx)
 *
 * 用法:
 *   node scripts/publish.mjs [选项]
 *
 * 选项:
 *   --version <x.y.z>    指定发布版本 (默认自动递增 patch)
 *   --patch              递增 patch 版本 (默认行为)
 *   --minor              递增 minor 版本
 *   --major              递增 major 版本
 *   --skip-build         跳过构建, 直接发布已有产物
 *   --pat <token>        指定 VS Code Market PAT (或环境变量 VSCE_PAT)
 *   --ovsx               同时发布到 Open VSX (需要 OVSX_TOKEN)
 *   --ovsx-only          只发布 Open VSX
 *   --dry-run            只构建/改版本, 不真正发布
 *
 * 前置要求:
 *   1. 在 VS Code 市场注册 publisher "vca"
 *   2. 在 https://dev.azure.com 创建 PAT (Marketplace: Manage)
 *   3. 设置环境变量 VSCE_PAT=你的令牌 (或 --pat 传入)
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vscodeDir = path.join(rootDir, "vscode");
const pkgPath = path.join(vscodeDir, "package.json");
const VSIX_PATTERN = /\.vsix$/;

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
const opt = { version: null, patch: false, minor: false, major: false, skipBuild: false, pat: null, ovsx: false, ovsxOnly: false, dryRun: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  switch (a) {
    case "--version": opt.version = args[++i]; break;
    case "--patch": opt.patch = true; break;
    case "--minor": opt.minor = true; break;
    case "--major": opt.major = true; break;
    case "--skip-build": opt.skipBuild = true; break;
    case "--pat": opt.pat = args[++i]; break;
    case "--ovsx": opt.ovsx = true; break;
    case "--ovsx-only": opt.ovsxOnly = true; break;
    case "--dry-run": opt.dryRun = true; break;
    case "-h": case "--help":
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*|^ \* ?/gm, "").replace(/\*\/$/, ""));
      process.exit(0);
    default:
      console.error(`[ERROR] 未知参数: ${a}\n运行 node scripts/publish.mjs --help 查看用法`);
      process.exit(1);
  }
}

// ---------- 工具函数 ----------
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (res.error) { console.error(`[ERROR] 执行失败: ${cmd} ${args.join(" ")}`, res.error.message); process.exit(1); }
  if (res.status !== 0) { console.error(`[ERROR] 命令退出码 ${res.status}: ${cmd} ${args.join(" ")}`); process.exit(res.status); }
  return res;
}

function getPkg() { return JSON.parse(readFileSync(pkgPath, "utf8")); }
function savePkg(pkg) { writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n"); }

function bumpVersion(v, mode) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) { console.error(`[ERROR] 无法解析版本号: ${v}`); process.exit(1); }
  let [, major, minor, patch] = m.map(Number);
  if (mode === "major") { major++; minor = 0; patch = 0; }
  else if (mode === "minor") { minor++; patch = 0; }
  else { patch++; }
  return `${major}.${minor}.${patch}`;
}

// ---------- 检查环境 ----------
for (const cmd of ["node", "npm", "npx"]) {
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
  if (r.error || r.status !== 0) { console.error(`[ERROR] 未找到 ${cmd}, 请安装 Node.js 18+`); process.exit(1); }
}

// ---------- 构建 ----------
if (!opt.skipBuild) {
  console.log("\n[1/4] 构建扩展 (复用 build-vsix.bat)...");
  const bat = path.join(rootDir, "build-vsix.bat");
  run("cmd", ["/c", bat], { cwd: rootDir });
} else {
  console.log("\n[1/4] 跳过构建 (--skip-build)");
}

const extJs = path.join(vscodeDir, "dist", "extension.js");
if (!existsSync(extJs)) {
  console.error("[ERROR] 未找到 vscode/dist/extension.js, 请先构建 (去掉 --skip-build)");
  process.exit(1);
}

// ---------- 版本 ----------
console.log("\n[2/4] 处理版本号...");
const pkg = getPkg();
const oldVersion = pkg.version;
let newVersion = oldVersion;
if (opt.version) {
  if (!/^\d+\.\d+\.\d+$/.test(opt.version)) { console.error(`[ERROR] 非法版本号: ${opt.version}`); process.exit(1); }
  newVersion = opt.version;
} else {
  const mode = opt.major ? "major" : opt.minor ? "minor" : "patch";
  newVersion = bumpVersion(oldVersion, mode);
}
if (opt.dryRun) {
  console.log(`  版本: ${oldVersion} -> ${newVersion} (dry-run, 不写回)`);
  console.log("\n[3/4] [DRY-RUN] 跳过发布");
  console.log(`[4/4] 完成 (dry-run): 版本 ${newVersion}`);
  process.exit(0);
}

if (newVersion !== oldVersion) {
  pkg.version = newVersion;
  savePkg(pkg);
  console.log(`  版本: ${oldVersion} -> ${newVersion}`);
} else {
  console.log(`  版本: ${newVersion} (未变化)`);
}

// ---------- 发布 ----------
const vscePat = opt.pat || process.env.VSCE_PAT;
const ovsxToken = process.env.OVSX_TOKEN;
const needVsce = !opt.ovsxOnly;
const needOvsx = opt.ovsx || opt.ovsxOnly;

if (needVsce && !vscePat) {
  console.error(`
[ERROR] 缺少 VS Code Marketplace PAT。

请按以下步骤操作:
  1. 打开 https://dev.azure.com 并用你的账号登录
  2. 右上角头像 -> Personal Access Tokens -> + New Token
  3. Organization: All accessible organizations
  4. Scopes 选择: Marketplace -> Acquire (管理)
  5. 生成后, 设置环境变量:
       set VSCE_PAT=你的token
     或使用 --pat 参数传入
`);
  process.exit(1);
}

console.log("\n[3/4] 发布到 VS Code Marketplace...");
if (needVsce) {
  run("npx", ["vsce", "publish", "-p", vscePat, "--allow-missing-repository", "--no-dependencies"], { cwd: vscodeDir });
} else {
  console.log("  跳过 (--ovsx-only)");
}

if (needOvsx) {
  console.log("\n[4/4] 发布到 Open VSX...");
  if (!ovsxToken) {
    console.error("[ERROR] 缺少 OVSX_TOKEN 环境变量, 无法发布到 Open VSX");
    process.exit(1);
  }
  run("npx", ["ovsx", "publish", "-p", ovsxToken], { cwd: vscodeDir });
} else {
  console.log("\n[4/4] 完成 (未启用 Open VSX, 可加 --ovsx)");
}

// ---------- 清理本地 VSIX (避免版本混乱) ----------
const { readdirSync, rmSync } = await import("node:fs");
for (const f of readdirSync(vscodeDir)) {
  if (VSIX_PATTERN.test(f)) {
    const fp = path.join(vscodeDir, f);
    console.log(`  清理本地包: ${f}`);
    rmSync(fp);
  }
}

console.log(`\n✅ 发布成功! 版本 ${newVersion}`);
