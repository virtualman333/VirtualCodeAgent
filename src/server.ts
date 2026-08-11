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
import { CodingAgent } from "./agent/graph.js";
import { createInitialState, type AgentState } from "./agent/state.js";
import { runAgentForWeb, type WebEvent } from "./agent/web_runner.js";
import { setWorkspace } from "./workspace_ctx.js";
import { loadSession, saveSession, generateSessionId } from "./storage.js";

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
// WebSocket 会话管理
// ============================================================

interface ClientSession {
  state: AgentState;
  waitingResolve: ((answer: string | null) => void) | null;
  cancelled: boolean;
  running: boolean;
}

const clients = new Map<WebSocket, ClientSession>();

function send(ws: WebSocket, event: WebEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

async function handleChat(ws: WebSocket, sess: ClientSession, content: string): Promise<void> {
  if (sess.running) {
    send(ws, { type: "info", text: "Agent 正在执行中，请先等待完成" });
    return;
  }
  sess.running = true;
  sess.cancelled = false;

  const agent = new CodingAgent();

  send(ws, { type: "info", text: "任务开始执行..." });

  await runAgentForWeb({
    agent,
    state: sess.state,
    userInput: content,
    send: (e) => send(ws, e),
    waitAnswer: (pending) =>
      new Promise<string | null>((resolve) => {
        sess.waitingResolve = resolve;
      }),
    isCancelled: () => sess.cancelled,
  });

  // 自动保存会话
  try {
    if (!sess.state.workspace_dir) sess.state.workspace_dir = Config.WORKSPACE_DIR;
    const sid = saveSession(
      sess.state.session_id ?? generateSessionId(),
      sess.state.messages,
      sess.state.workspace_dir
    );
    sess.state.session_id = sid;
  } catch {
    /* 保存失败不影响运行 */
  }

  sess.running = false;
  sess.waitingResolve = null;
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
  // 每个连接对应一个独立会话
  const sess: ClientSession = {
    state: createInitialState(Config.WORKSPACE_DIR),
    waitingResolve: null,
    cancelled: false,
    running: false,
  };
  clients.set(ws, sess);

  send(ws, {
    type: "info",
    text: `已连接。模型: ${Config.OPENAI_MODEL} | 工作空间: ${Config.WORKSPACE_DIR}`,
  });
  if (!Config.OPENAI_API_KEY) {
    send(ws, { type: "info", text: `[WARN] OPENAI_API_KEY 未设置，请编辑: ${CONFIG_FILE}` });
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
      if (content) {
        await handleChat(ws, sess, content);
      }
    } else if (type === "answer") {
      // 回答 ask_user 提问
      if (sess.waitingResolve) {
        const content = String(msg.content ?? "").trim();
        const resolve = sess.waitingResolve;
        sess.waitingResolve = null;
        resolve(content ? `用户回答: ${content}` : "[用户选择跳过]");
      }
    } else if (type === "answer_option") {
      if (sess.waitingResolve) {
        const option = String(msg.content ?? "").trim();
        const resolve = sess.waitingResolve;
        sess.waitingResolve = null;
        resolve(option ? `用户选择了: ${option}` : "[用户选择跳过]");
      }
    } else if (type === "skip_question") {
      if (sess.waitingResolve) {
        const resolve = sess.waitingResolve;
        sess.waitingResolve = null;
        resolve("[用户选择跳过]");
      }
    } else if (type === "cancel") {
      sess.cancelled = true;
      if (sess.waitingResolve) {
        const resolve = sess.waitingResolve;
        sess.waitingResolve = null;
        resolve(null);
      }
    } else if (type === "restore") {
      // 恢复最近会话 (可选)
      const last = loadSession(String(msg.session_id ?? ""));
      if (last) {
        sess.state = {
          ...createInitialState(last.workspace_dir || Config.WORKSPACE_DIR),
          messages: last.messages,
        };
        send(ws, {
          type: "info",
          text: `已恢复会话「${last.title}」(${last.messages.length} 条消息)`,
        });
      } else {
        send(ws, { type: "info", text: "会话不存在" });
      }
    } else if (type === "workspace") {
      const dir = String(msg.path ?? "");
      if (dir) {
        const abs = path.resolve(Config.WORKSPACE_DIR, dir);
        try {
          fs.mkdirSync(abs, { recursive: true });
          sess.state.workspace_dir = abs;
          setWorkspace(abs);
          send(ws, { type: "info", text: `已切换工作空间: ${abs}` });
        } catch (e) {
          send(ws, { type: "info", text: `切换失败: ${(e as Error).message}` });
        }
      }
    }
  });

  ws.on("close", () => {
    sess.cancelled = true;
    clients.delete(ws);
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
