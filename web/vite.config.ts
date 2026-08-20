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