/**
 * VS Code 扩展构建 - 用 esbuild 将扩展 + Agent 引擎 bundle 为单个 CJS 文件
 *
 * 步骤:
 * 1. 复制 web/dist (Vue 构建产物) → vscode/dist/web (扩展包自包含)
 * 2. esbuild bundle vscode/src/extension.ts → vscode/dist/extension.js
 *
 * 用法:
 *   node scripts/build-extension.mjs           # 一次性构建
 *   node scripts/build-extension.mjs --watch   # watch 模式, 改代码自动重建 (调试用)
 */
import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extDist = path.join(root, "vscode", "dist");
const webDist = path.join(root, "web", "dist");
const extWebDir = path.join(extDist, "web");
const outfile = path.join(extDist, "extension.js");

const isWatch = process.argv.includes("--watch");

// ---- 1. 复制前端产物 ----
if (!fs.existsSync(path.join(webDist, "index.html"))) {
  console.error("[build-extension] web/dist 不存在，请先执行: cd web && npm install && npm run build");
  process.exit(1);
}
fs.rmSync(extWebDir, { recursive: true, force: true });
fs.cpSync(webDist, extWebDir, { recursive: true });
console.log(`[build-extension] 前端产物已复制 → vscode/dist/web`);

// ---- 2. esbuild bundle ----
const buildOptions = {
  entryPoints: [path.join(root, "vscode", "src", "extension.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "warning",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  loader: {
    ".node": "empty",
  },
};

if (isWatch) {
  const ctx = await context(buildOptions);
  await ctx.watch({
    onRebuild(err) {
      if (err) {
        console.error(`[build-extension] 重新构建失败: ${err.message}`);
      } else {
        console.log("[build-extension] 重新构建完成 → vscode/dist/extension.js");
      }
    },
  });
  console.log("[build-extension] watch 模式已启动，修改代码后自动重建 extension.js");
} else {
  await build(buildOptions);
  const size = (fs.statSync(outfile).size / 1024).toFixed(0);
  console.log(`[build-extension] 构建完成 → vscode/dist/extension.js (${size} KB)`);
}
