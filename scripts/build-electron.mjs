/**
 * Electron 主进程 / preload 构建
 *
 * 产物: electron/dist/{main.js, preload.js}
 * esbuild target=electron (renderer 端代码由 vite 处理)
 */
import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "electron", "dist");

const isWatch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: [
    { in: path.join(root, "electron", "src", "main.ts"), out: "main" },
    { in: path.join(root, "electron", "src", "preload.ts"), out: "preload" },
  ],
  outdir: outDir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["electron"],
  sourcemap: true,
  logLevel: "warning",
};

if (isWatch) {
  const ctx = await context(buildOptions);
  await ctx.watch({
    onRebuild(err) {
      if (err) console.error(`[build-electron] 重建失败: ${err.message}`);
      else console.log("[build-electron] 重建完成 → electron/dist");
    },
  });
  console.log("[build-electron] watch 模式启动");
} else {
  await build(buildOptions);
  console.log(`[build-electron] 构建完成 → electron/dist`);
}