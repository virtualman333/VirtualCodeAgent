/**
 * Electron 主进程
 *
 * 职责:
 *  - 创建 BrowserWindow 加载 VCA 前端 (桌面布局: dist-electron/index.html)
 *  - 内置启动 VCA 后端服务 (spawn `node dist/server.js`), 监听 PORT
 *  - 暴露原生能力给前端 (打开文件 / 系统菜单 / 主题)
 *  - 单实例锁 / 窗口管理 / 托盘 / 退出确认
 */
import { app, BrowserWindow, ipcMain, Menu, Tray, dialog, shell, nativeTheme, nativeImage } from "electron";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";

// CJS 编译下 __dirname 已可用
const ROOT = path.resolve(__dirname, "..", "..");

// ============================================================
// 配置
// ============================================================

const PORT = Number(process.env.PORT || 3001);
const isDev = !app.isPackaged && !!process.env.VCA_ELECTRON_DEV;
const FRONTEND_URL =
  process.env.VCA_WEB_DEV_URL || (isDev ? "http://localhost:5173" : "");

let mainWindow: BrowserWindow | null = null;
let serverProc: ChildProcess | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// ============================================================
// 单实例锁
// ============================================================

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ============================================================
// 启动内嵌后端服务
// ============================================================

async function waitForPort(port: number, host = "127.0.0.1", timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ port, host }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, 800);
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function startBackend(): Promise<boolean> {
  const logFile = path.join(ROOT, "electron.log");
  const log = (msg: string): void => {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
  };
  log(`[startBackend] ENTER, PORT=${PORT}`);

  if (await waitForPort(PORT, "127.0.0.1", 400)) {
    log(`[startBackend] 端口 ${PORT} 已占用, 复用`);
    return true;
  }

  // 打包后 server.js 在 resources/server; 开发模式在 ROOT/dist
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "server", "server.js")]
    : [
        path.join(ROOT, "dist", "server.js"),
        path.join(ROOT, "dist-electron", "server.js"),
      ];
  log(`[startBackend] 候选: ${JSON.stringify(candidates)}`);
  const serverEntry = candidates.find((p) => fs.existsSync(p));
  if (!serverEntry) {
    log(`[startBackend] 找不到 server 入口`);
    dialog.showErrorBox(
      "VCA 启动失败",
      `找不到后端入口, 已尝试:\n${candidates.join("\n")}\n请先运行 npm run build`
    );
    return false;
  }
  log(`[startBackend] 启动后端: ${serverEntry}, execPath=${process.execPath}`);

  // Electron 主进程: 用内置 Node 跑后端 (设 ELECTRON_RUN_AS_NODE=1)
  serverProc = spawn(process.execPath, [serverEntry], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProc.stdout?.on("data", (d) => {
    const s = d.toString();
    log(`[server] ${s}`);
    process.stdout.write(`[server] ${s}`);
  });
  serverProc.stderr?.on("data", (d) => {
    const s = d.toString();
    log(`[server-err] ${s}`);
    process.stderr.write(`[server-err] ${s}`);
  });
  serverProc.on("exit", (code) => {
    log(`[server] exit, code=${code}`);
    serverProc = null;
    if (!isQuitting && mainWindow) {
      mainWindow.webContents.send("vca:backend-crashed", { code });
    }
  });
  serverProc.on("error", (err) => {
    log(`[server] spawn error: ${err.message}`);
  });

  const ok = await waitForPort(PORT);
  log(`[startBackend] waitForPort=${ok}`);
  return ok;
}

// ============================================================
// 主窗口
// ============================================================

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: "VCA - Virtual Code Agent",
    backgroundColor: "#fafafa",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay:
      process.platform === "win32"
        ? { color: "#ffffff", symbolColor: "#333", height: 36 }
        : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 加载前端
  if (FRONTEND_URL) {
    // dev: vite mpa 模式 /index.html → web 入口; 桌面端用 /index-electron.html
    const entryUrl = `${FRONTEND_URL.replace(/\/+$/, "")}/index-electron.html`;
    console.log(`[electron] 加载前端 (dev): ${entryUrl}`);
    await mainWindow.loadURL(entryUrl);
  } else {
    const indexPath = path.join(ROOT, "dist-electron", "index-electron.html");
    console.log(`[electron] 加载前端 (prod): ${indexPath}`);
    await mainWindow.loadFile(indexPath);
  }

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // 关闭时: 默认最小化到托盘 (生产模式); Cmd/Ctrl+Q 真正退出
  mainWindow.on("close", (e) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      mainWindow?.hide();
      return;
    }
    app.quit();
  });

  // 外部链接默认用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow?.webContents.send("vca:init", {
      port: PORT,
      platform: process.platform,
      version: app.getVersion(),
    });
  });
}

// ============================================================
// 托盘
// ============================================================

function buildTray(): void {
  // 图标在开发模式可能缺失, 容错处理
  const iconPath = path.join(__dirname, "..", "assets", "tray.png");
  try {
    tray = new Tray(fs.existsSync(iconPath) ? iconPath : nativeImage.createEmpty());
  } catch {
    return;
  }
  const menu = Menu.buildFromTemplate([
    {
      label: "显示主窗口",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip("VCA - Virtual Code Agent");
  tray.setContextMenu(menu);
  tray.on("click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

// ============================================================
// IPC
// ============================================================

ipcMain.handle("vca:open-path", async (_e, payload: { path: string; line?: number }) => {
  const p = String(payload?.path ?? "");
  if (!p) return { ok: false, error: "empty path" };
  try {
    if (payload?.line && payload.line > 0 && fs.existsSync(p) && fs.statSync(p).isFile()) {
      // 文件类型用系统默认应用 (保留 line 信息可被识别为 vscode://)
      const uri = process.platform === "win32"
        ? `vscode://file/${encodeURI(p.replace(/\\/g, "/"))}:${payload.line}:1`
        : `vscode://file${p}:${payload.line}:1`;
      await shell.openExternal(uri);
      return { ok: true };
    }
    const errMsg = await shell.openPath(p);
    return errMsg ? { ok: false, error: errMsg } : { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

ipcMain.handle("vca:show-in-folder", async (_e, p: string) => {
  if (!p) return { ok: false };
  shell.showItemInFolder(p);
  return { ok: true };
});

ipcMain.handle("vca:get-theme", () => {
  return { shouldUseDarkColors: nativeTheme.shouldUseDarkColors };
});

ipcMain.handle("vca:quit", () => {
  isQuitting = true;
  app.quit();
});

ipcMain.handle("vca:minimize", () => {
  mainWindow?.minimize();
});

// ============================================================
// 应用菜单 (跨平台基础)
// ============================================================

function buildAppMenu(): void {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    { role: "fileMenu" as const },
    { role: "editMenu" as const },
    {
      label: "视图",
      submenu: [
        { role: "reload" as const },
        { role: "forceReload" as const },
        { type: "separator" as const },
        { role: "toggleDevTools" as const },
        { type: "separator" as const },
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "关于 VCA",
          click: () => {
            dialog.showMessageBox(mainWindow!, {
              type: "info",
              title: "关于 VCA",
              message: `VCA - Virtual Code Agent\nv${app.getVersion()}\nNode ${process.versions.node} | Electron ${process.versions.electron}`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ============================================================
// 启动流程
// ============================================================

app.whenReady().then(async () => {
  fs.appendFileSync(path.join(ROOT, "electron.log"), `${new Date().toISOString()} [whenReady] ENTER\n`);
  buildAppMenu();

  const ok = await startBackend();
  if (!ok) {
    fs.appendFileSync(path.join(ROOT, "electron.log"), `[whenReady] startBackend 失败\n`);
    dialog.showErrorBox("VCA 启动失败", `后端服务未能在端口 ${PORT} 上监听, 请检查日志`);
    app.quit();
    return;
  }
  fs.appendFileSync(path.join(ROOT, "electron.log"), `[whenReady] createWindow\n`);

  await createWindow();
  buildTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  if (serverProc && !serverProc.killed) {
    try {
      serverProc.kill();
    } catch {
      /* ignore */
    }
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});