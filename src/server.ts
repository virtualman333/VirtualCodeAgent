/**
 * Web 服务器 - HTTP 静态文件 + WebSocket Agent 服务
 *
 * - 开发模式: 前端用 Vite dev server (5173), 通过代理 /ws → 3001
 * - 生产模式: 本服务直接 serve web/dist, 访问 http://localhost:3001
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

import { Config, CONFIG_FILE } from "./config.js";
import { AgentSession } from "./agent/session.js";
import type { WebEvent } from "./agent/web_runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.resolve(__dirname, "..", "web", "dist");
const PORT = Number(process.env.PORT || 3001);

// ============================================================
// 静态文件服务
// ============================================================

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  let urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  // 防目录穿越
  const filePath = path.normalize(path.join(WEB_DIST, urlPath));
  if (!filePath.startsWith(WEB_DIST)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    // SPA fallback
    const index = path.join(WEB_DIST, "index.html");
    if (fs.existsSync(index)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(index));
      return;
    }
    res.writeHead(404).end("Not Found. 请先构建前端: cd web && npm run build");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  res.end(fs.readFileSync(filePath));
}

// ============================================================
// 主入口
// ============================================================

const server = http.createServer((req, res) => {
  // API 探测
  if (req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        model: Config.OPENAI_MODEL,
        workspace: Config.WORKSPACE_DIR,
        frontend: fs.existsSync(path.join(WEB_DIST, "index.html")),
      })
    );
    return;
  }
  if (req.url === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ config_file: CONFIG_FILE, has_key: !!Config.OPENAI_API_KEY }));
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const session = new AgentSession(Config.WORKSPACE_DIR);
  const emit = (e: WebEvent): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
  };

  emit({
    type: "info",
    text: `已连接。模型: ${session.getModel().name} | 工作空间: ${Config.WORKSPACE_DIR}`,
  });
  emit({ type: "workspace", path: session.state.workspace_dir });
  // 推送模型列表 + 当前模型
  emit({
    type: "models",
    models: session.getModels(),
    current: session.modelName,
  });
  emit({ type: "model", name: session.modelName });
  if (!Config.OPENAI_API_KEY) {
    emit({ type: "info", text: `[WARN] OPENAI_API_KEY 未设置，请编辑: ${CONFIG_FILE}` });
  }

  ws.on("message", async (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const type = String(msg.type ?? "");

    if (type === "chat") {
      const content = String(msg.content ?? "").trim();
      if (content) await session.chat(content, emit);
    } else if (type === "answer") {
      const content = String(msg.content ?? "").trim();
      session.answer(content ? `用户回答: ${content}` : "[用户选择跳过]");
    } else if (type === "answer_option") {
      const option = String(msg.content ?? "").trim();
      session.answer(option ? `用户选择了: ${option}` : "[用户选择跳过]");
    } else if (type === "skip_question") {
      session.answer("[用户选择跳过]");
    } else if (type === "cancel") {
      session.cancel();
    } else if (type === "set_model") {
      const name = String(msg.name ?? "");
      if (session.setModel(name)) {
        emit({ type: "model", name: session.modelName });
        emit({ type: "info", text: `已切换模型: ${session.modelName}` });
      } else {
        emit({ type: "info", text: `未找到模型: ${name}` });
      }
    } else if (type === "get_models") {
      emit({
        type: "models",
        models: session.getModels(),
        current: session.modelName,
      });
    } else if (type === "restore") {
      const count = session.restore(String(msg.session_id ?? ""));
      emit({ type: "info", text: count > 0 ? `已恢复会话 (${count} 条消息)` : "会话不存在" });
    } else if (type === "workspace") {
      const dir = String(msg.path ?? "");
      if (dir) {
        const ok = session.setWorkspace(dir);
        if (ok) {
          emit({ type: "workspace", path: session.state.workspace_dir });
          emit({ type: "info", text: `已切换工作空间: ${session.state.workspace_dir}` });
        } else {
          emit({ type: "info", text: `切换失败: ${dir}` });
        }
      }
    }
  });

  ws.on("close", () => {
    session.cancel();
  });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[VCA-Web] 端口 ${PORT} 已被占用!`);
    console.error(`[VCA-Web] 可能已有 VCA 服务在运行，或残留进程未退出。`);
    console.error(`[VCA-Web] 处理方法:`);
    console.error(`   1. 检查是否已有服务: netstat -ano | findstr :${PORT}`);
    console.error(`   2. 结束占用进程:     taskkill /f /pid <PID>`);
    console.error(`   3. 或换端口启动:     set PORT=3002 && npm run server`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`[VCA-Web] 服务已启动: http://localhost:${PORT}`);
  console.log(`[VCA-Web] WebSocket: ws://localhost:${PORT}/ws`);
  const built = fs.existsSync(path.join(WEB_DIST, "index.html"));
  if (!built) {
    console.log(`[VCA-Web] 未检测到前端构建产物，请执行: cd web && npm install && npm run build`);
  }
});
