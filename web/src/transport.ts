/**
 * 前端传输层 - 支持两种运行环境:
 *
 * 1. 浏览器 (npm run server + http://localhost:3001) → WebSocket
 * 2. VS Code Webview (扩展内嵌) → vscode.postMessage RPC
 */

import { resolveWsUrl } from "./ws-url";

export type { WsUrlInput } from "./ws-url";
export { resolveWsUrl } from "./ws-url";

export interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

export interface Transport {
  send: (payload: Record<string, unknown>) => void;
  close: () => void;
  /** 当前是否已连接 */
  readonly connected: boolean;
  /** 连接状态变化回调 (仅 WS 模式) */
  onStatus?: (connected: boolean) => void;
}

export function isVscodeEnv(): boolean {
  return (
    typeof (window as unknown as { acquireVsCodeApi?: unknown }).acquireVsCodeApi ===
    "function"
  );
}

/** 主进程通过 `vca:init` 报上来的启动信息（preload 注入在 `window.vca` 上） */
export interface DesktopInit {
  port: number;
  platform: string;
  version: string;
}

interface VcaBridge {
  isElectron?: boolean;
  onInit?(cb: (info: DesktopInit) => void): () => void;
}

export function isElectronEnv(): boolean {
  return typeof (window as unknown as { vca?: VcaBridge }).vca?.isElectron === true;
}

/**
 * 订阅主进程的启动信息；Electron 之外是空操作。
 *
 * preload 在**自己加载时**就把这条事件挂上了，并把收到的那份留着补发 ——
 * 所以这里注册得比主进程发送晚也照样拿得到（主进程是在 `did-finish-load` 才发的，
 * 页面脚本早于它跑完，靠 on/off 的时序去赌是不牢的）。
 */
export function onDesktopInit(cb: (info: DesktopInit) => void): () => void {
  const b = (window as unknown as { vca?: VcaBridge }).vca;
  return b?.onInit ? b.onInit(cb) : () => {};
}

/**
 * 按当前页面决定连哪儿 —— 读 `location.host` 的地方只有这一处。
 *
 * `desktopPort` 只在页面**没有 host** 时才会被调用（Electron 打包后等主进程报端口）。
 */
export async function resolveBackendWsUrl(
  desktopPort?: () => Promise<number | null>
): Promise<string | null> {
  const host = location.host;
  if (host) return resolveWsUrl({ protocol: location.protocol, host });
  const port = desktopPort ? await desktopPort() : null;
  return resolveWsUrl({ protocol: location.protocol, host: "", backendPort: port });
}


/**
 * Electron 下用 IPC 打开文件 (VS Code 走 vscode 协议; 其他平台走系统默认)
 * Web/VS Code 模式直接 send ws/postMessage `open_file`, 由 server 或扩展处理
 */
export async function openFileInExternalEditor(
  filePath: string,
  line?: number,
  sendWs?: (p: Record<string, unknown>) => void
): Promise<void> {
  const w = window as unknown as { vca?: { openPath(p: string, l?: number): Promise<{ ok: boolean; error?: string }> } };
  if (w.vca?.openPath) {
    await w.vca.openPath(filePath, line);
    return;
  }
  // Fallback: 通过 ws 通知 server (server 当前不处理, 仍保留接口供将来扩展)
  sendWs?.({ type: "open_file", path: filePath, line: line ?? 0 });
}

// ============================================================
// VS Code Webview transport
// ============================================================

export function createVscodeTransport(
  onEvent: (e: ServerEvent) => void
): Transport {
  const api = (
    window as unknown as {
      acquireVsCodeApi(): { postMessage(msg: unknown): void };
    }
  ).acquireVsCodeApi();

  window.addEventListener("message", (ev: MessageEvent) => {
    const data = ev.data as ServerEvent;
    if (data && typeof data === "object" && data.type) {
      onEvent(data);
    }
  });

  return {
    connected: true,
    send: (payload) => api.postMessage({ type: "rpc", payload }),
    close: () => {},
  };
}

// ============================================================
// WebSocket transport
// ============================================================

export function createWsTransport(
  url: string,
  onEvent: (e: ServerEvent) => void,
  onStatus: (connected: boolean) => void
): Transport {
  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => onStatus(true);
    ws.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data as string) as ServerEvent);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (!closed && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 3000);
      }
    };
    ws.onerror = () => ws?.close();
  };

  connect();

  return {
    connected: false,
    send: (payload) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    },
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
