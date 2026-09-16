/**
 * 后端 WebSocket 地址的拼装 —— **只在这里拼**。
 *
 * 为什么单独成文件：这段判断要能被测试直接跑（`web/` 没有自己的 tsc 配置，
 * 这里也刻意一句 DOM API 都不碰）。读 `location` 的那半边在 `transport.ts`。
 */

/** 拼地址要的三个量 */
export interface WsUrlInput {
  /** 页面协议（`location.protocol`）；`file:` 表示 Electron 打包后从磁盘加载 */
  protocol: string;
  /** 页面 host（`location.host`）；空串表示页面不是从 http(s) 来的 */
  host: string;
  /** 主进程报过来的后端端口；只有「没有 host」时才用得上 */
  backendPort?: number | null;
}

/**
 * 拼出后端 WebSocket 地址；拼不出来时返回 `null`。
 *
 * - 有 host（浏览器；Electron 开发模式下页面来自 Vite）→ 同源 `/ws`
 * - 没有 host（Electron 打包后页面是 `file://`，`location.host` 是空串）→
 *   只能用主进程报过来的端口，连 `127.0.0.1`
 * - 两者都没有 → `null`，**不拼一个 `ws:///ws` 出来**
 *
 * 最后一条是踩过的：原先这里是 `${protocol}//${location.host}/ws`，而打包后
 * `location.host` 是空串 → 地址成了 `ws:///ws`。本机 Node 把它解析成
 * **主机名 `ws`、路径 `/`**；浏览器按 WHATWG 规范（`ws` 属 special scheme，
 * host 不允许为空）直接判为非法 URL。两种解释都到不了后端 —— 而**开发模式下
 * Vite 会把 /ws 代理到 3001**，这个问题被整个盖住了，只有打包后才炸。
 */
export function resolveWsUrl({ protocol, host, backendPort }: WsUrlInput): string | null {
  const scheme = protocol === "https:" ? "wss:" : "ws:";
  if (host) return `${scheme}//${host}/ws`;
  const port = Number(backendPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return `${scheme}//127.0.0.1:${port}/ws`;
}
