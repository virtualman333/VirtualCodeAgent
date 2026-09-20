import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";

export default defineConfig({
  plugins: [vue()],
  appType: "mpa", // 多页面应用: / 走 index.html, /electron.html 走 index-electron.html
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    /**
     * **唯一来源**：前端产物目录就由这一行决定。
     * 消费方（别的目录下不能各写一份）：
     *   src/server.ts                 → WEB_DIST（npm run serve / README §B）
     *   scripts/build-extension.mjs   → 复制进 vscode/dist/web
     *   scripts/build-vsix.mjs        → 打进 .vsix
     *   electron/src/main.ts          → 生产模式加载 index-electron.html
     *   electron-builder.json         → extraResources（给被 spawn 的 server 进程读）
     * 这几处是否还对得上，由 tests/webdist-agreement.test.ts 盯着。
     */
    outDir: "../dist-electron",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // 浏览器端 (npm run server, http://localhost:3001) 用 web/index.html
        web: path.resolve(__dirname, "index.html"),
        // Electron 桌面端用 web/index-electron.html
        electron: path.resolve(__dirname, "index-electron.html"),
      },
    },
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/ws": { target: "ws://localhost:3001", ws: true, changeOrigin: true },
    },
  },
});