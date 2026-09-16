/**
 * Electron 主进程 / preload 构建
 *
 * 产物: electron/dist/{main.cjs, preload.cjs}（后缀由下面 outExtension 决定，见注释）
 * esbuild target=node18 + format=cjs (renderer 端代码由 vite 处理)
 */
import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "electron", "dist");

const isWatch = process.argv.includes("--watch");

const buildOptions = {
  // 产物后缀必须是 `.cjs`：根 package.json 是 `"type": "module"`，而这里是 esbuild 的
  // **CJS**（下面 format: "cjs"）。叫 `.js` 的话 Node/Electron 会按 ESM 加载，第一行
  // `require("electron")` 就抛 `ReferenceError: require is not defined in ES module scope`
  // —— 主进程根本起不来（`node electron/dist/main.js` 实测复现）。
  //
  // 注意 esbuild 的坑：`out` 只是**基名**，扩展名按输入 loader 自己补 —— 写
  // `out: "main.cjs"` 得到的是 `main.cjs.js`。要拿到 `.cjs` 得用 outExtension。
  entryPoints: [
    { in: path.join(root, "electron", "src", "main.ts"), out: "main" },
    { in: path.join(root, "electron", "src", "preload.ts"), out: "preload" },
  ],
  outExtension: { ".js": ".cjs" },
  outdir: outDir,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["electron"],
  sourcemap: true,
  logLevel: "warning",
  plugins: [
    {
      name: "rebuild-notifier",
      setup(buildApi) {
        buildApi.onEnd((result) => {
          if (!isWatch) return;
          if (result.errors.length > 0) {
            console.error(
              `[build-electron] 重建失败: ${result.errors.map((e) => e.text).join("\n")}`
            );
          } else {
            console.log("[build-electron] 重建完成 → electron/dist");
          }
        });
      },
    },
  ],
};

if (isWatch) {
  const ctx = await context(buildOptions);
  await ctx.watch();
  console.log("[build-electron] watch 模式启动");
} else {
  await build(buildOptions);
  console.log(`[build-electron] 构建完成 → electron/dist`);
}