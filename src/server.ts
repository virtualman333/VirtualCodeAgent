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
import {
  getSettingsView,
  saveGeneralSettings,
  saveMcpConfig,
  reconnectMcp,
  reloadConfig,
} from "./settings.js";

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
  // 每个连接持有多个独立会话 (多 tab 并行)
  const sessions = new Map<string, AgentSession>();

  const emitTo = (sid: string) => (e: WebEvent): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ...e, sessionId: sid }));
    }
  };

  const createSession = (id?: string): AgentSession => {
    const s = new AgentSession(Config.WORKSPACE_DIR, [], id);
    sessions.set(s.id, s);
    return s;
  };

  const getSession = (msg: Record<string, unknown>): AgentSession | null => {
    const sid = String(msg.session_id ?? "");
    return sessions.get(sid) ?? null;
  };

  // 全局信息 (任一 session 均可)
  const emitGlobalInfo = (): void => {
    if (!Config.OPENAI_API_KEY) {
      emitTo("")({ type: "info", text: `[WARN] OPENAI_API_KEY 未设置，请编辑: ${CONFIG_FILE}` });
    }
  };

  // 连接即创建首个会话 (默认 tab)
  const first = createSession();
  emitTo(first.id)({
    type: "info",
    text: `已连接。模型: ${first.getModel().name} | 工作空间: ${Config.WORKSPACE_DIR}`,
  });
  emitTo(first.id)({ type: "workspace", path: first.state.workspace_dir });
  emitTo(first.id)({ type: "models", models: first.getModels(), current: first.modelName });
  emitTo(first.id)({ type: "model", name: first.modelName });
  emitTo(first.id)({ type: "context", ...first.getContextInfo() });
  emitTo(first.id)({ type: "session_id", id: first.id });
  emitGlobalInfo();

  ws.on("message", async (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const type = String(msg.type ?? "");

    // ---- 会话管理 ----
    if (type === "new_session") {
      const s = createSession();
      emitTo(s.id)({ type: "session_created", id: s.id, title: s.title });
      emitTo(s.id)({ type: "workspace", path: s.state.workspace_dir });
      emitTo(s.id)({ type: "models", models: s.getModels(), current: s.modelName });
      emitTo(s.id)({ type: "model", name: s.modelName });
      emitTo(s.id)({ type: "context", ...s.getContextInfo() });
      return;
    }
    if (type === "close_session") {
      const s = getSession(msg);
      if (s) {
        s.cancel();
        sessions.delete(s.id);
        emitTo(s.id)({ type: "session_closed", id: s.id });
      }
      return;
    }

    // ---- 设置 (全局, 不依赖会话) ----
    if (type === "get_settings") {
      const sid = String(msg.session_id ?? first.id);
      emitTo(sid)({ type: "settings", settings: getSettingsView() });
      return;
    }
    if (type === "save_general_settings") {
      const result = saveGeneralSettings((msg.updates as Record<string, unknown>) ?? {});
      emitTo(first.id)({
        type: "settings_result",
        section: "general",
        ok: result.ok,
        error: result.error,
        settings: getSettingsView(),
      });
      return;
    }
    if (type === "save_mcp_config") {
      const servers = Array.isArray(msg.servers) ? msg.servers : [];
      const result = saveMcpConfig(servers as Parameters<typeof saveMcpConfig>[0]);
      if (result.ok) {
        const status = await reconnectMcp();
        emitTo(first.id)({ type: "settings_result", section: "mcp", ok: true, mcp_status: status, settings: getSettingsView() });
      } else {
        emitTo(first.id)({ type: "settings_result", section: "mcp", ok: false, error: result.error });
      }
      return;
    }
    if (type === "reconnect_mcp") {
      const status = await reconnectMcp();
      emitTo(first.id)({ type: "settings_result", section: "mcp", ok: true, mcp_status: status, settings: getSettingsView() });
      return;
    }
    if (type === "reload_config") {
      const result = reloadConfig();
      emitTo(first.id)({
        type: "settings_result",
        section: "config",
        ok: result.ok,
        error: result.error,
        settings: result.ok ? getSettingsView() : undefined,
      });
      return;
    }

    const session = getSession(msg);
    if (!session) return; // 无效会话 ID 忽略
    const emit = emitTo(session.id);

    if (type === "chat") {
      const content = String(msg.content ?? "").trim();
      const images = Array.isArray(msg.images)
        ? (msg.images as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      if (content || images.length > 0) await session.chat(content, images, emit);
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
      emit({ type: "models", models: session.getModels(), current: session.modelName });
    } else if (type === "get_context") {
      emit({ type: "context", ...session.getContextInfo() });
    } else if (type === "enhance") {
      const input = String(msg.input ?? "").trim();
      if (!input) {
        emit({ type: "enhance_result", error: "输入为空" });
      } else {
        try {
          const enhanced = await session.enhanceInput(input);
          emit({ type: "enhance_result", text: enhanced });
        } catch (e) {
          emit({ type: "enhance_result", error: (e as Error).message });
        }
      }
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
    for (const s of sessions.values()) s.cancel();
    sessions.clear();
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
