/**
 * Electron preload — 在沙箱化的 renderer 中安全地暴露原生能力
 *
 * 通过 contextBridge 注入到 window.vca
 */
import { contextBridge, ipcRenderer } from "electron";

export interface InitPayload {
  port: number;
  platform: NodeJS.Platform;
  version: string;
}

/**
 * 最早挂上的那一份监听：主进程可能在页面脚本注册回调**之前**就发了 `vca:init`
 * （它是在窗口 `did-finish-load` 时发的），所以这里先把 payload 收着。
 * 收到多次（每次加载都会发）没关系，读它的人只关心端口与版本，重复到达是幂等的。
 */
let cachedInit: InitPayload | null = null;
ipcRenderer.on("vca:init", (_e, payload: InitPayload) => {
  cachedInit = payload;
});

const api = {
  isElectron: true as const,

  /**
   * 初始化数据 (端口/平台/版本)
   *
   * 谁后注册谁就立刻拿到一份补发 —— 否则「谁先谁后」会决定桌面版能不能连上后端：
   * 渲染层是拿这个端口拼 ws 地址的（打包后页面是 file://，没有 `location.host` 可用）。
   */
  onInit(cb: (payload: InitPayload) => void): () => void {
    const fn = (_e: unknown, payload: InitPayload): void => cb(payload);
    ipcRenderer.on("vca:init", fn);
    if (cachedInit) cb(cachedInit);
    return () => ipcRenderer.off("vca:init", fn);
  },

  /** 后端进程崩溃事件 */
  onBackendCrashed(cb: (info: { code: number | null }) => void): () => void {
    const fn = (_e: unknown, payload: { code: number | null }): void => cb(payload);
    ipcRenderer.on("vca:backend-crashed", fn);
    return () => ipcRenderer.off("vca:backend-crashed", fn);
  },

  /** 用系统默认应用打开文件 (line 信息会以 vscode:// 协议传给 VS Code) */
  async openPath(path: string, line?: number): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke("vca:open-path", { path, line });
  },

  /** 在文件管理器中显示文件 */
  async showInFolder(path: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke("vca:show-in-folder", path);
  },

  /** 获取当前系统主题 */
  async getTheme(): Promise<{ shouldUseDarkColors: boolean }> {
    return ipcRenderer.invoke("vca:get-theme");
  },

  /** 真正退出 (绕过托盘拦截) */
  quit(): void {
    ipcRenderer.invoke("vca:quit");
  },

  /** 最小化窗口 */
  minimize(): void {
    ipcRenderer.invoke("vca:minimize");
  },
};

contextBridge.exposeInMainWorld("vca", api);

export type VcaApi = typeof api;