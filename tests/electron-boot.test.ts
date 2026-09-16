/**
 * Electron 桌面形态的启动链路测试 —— 地址怎么拼、端口从哪来、版本号从哪来。
 *
 * 为什么需要它
 * ------------
 * 桌面形态的打包路径**从来没跑通过**，四处同一个成因：那条路径没人走过。
 *
 * 1. 根 `package.json` 没有 `main` —— Electron 默认去找 `index.js`，装了也起不来；
 * 2. `electron/dist/main.js` 是 esbuild 的 **CJS** 产物，而根 package.json 是
 *    `"type": "module"` → 按 ESM 加载，第一行 `require("electron")` 就抛
 *    `ReferenceError: require is not defined in ES module scope`（本机实测复现）；
 * 3. 渲染层收到主进程报的 `{port, version}` 之后**什么都没做**（回调体写着「此处留空」）
 *    —— 地址照 `location.host` 拼，而打包后页面是 `file://`、host 是空串，
 *    拼出来是 `ws:///ws`（Node 解析成主机名 `ws`；浏览器按规范判为非法 URL），连不上；
 * 4. 侧栏版本号写死 `v0.2.0`，而当时已经是 0.3.0 —— 界面一直在显示错的那个。
 *
 * 1、3、4 在开发模式下都不会露头：`electron:run` 走 Vite（host = localhost:5173，
 * `/ws` 被代理到 3001），而侧栏那个错版本号没人会去核对。**「开发时好好的」又一次
 * 把「装完之后静默失效」盖住了。**
 *
 * 这一节把不依赖浏览器/Electron 的部分全部钉住：地址拼装是纯函数（真调用），
 * 其余用源码不变量盯着「是否只剩一处实现」「入口字段是否指向真实产物」。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { resolveWsUrl } from "../web/src/ws-url.js";
import { stripComments } from "./source-utils.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), "utf-8");

/**
 * 读源码做断言前先剥注释 —— 本仓库踩过：注释里写的「不能这么写」的反面示例
 * 会被 `includes` / 正则当成实现，于是锁在**已经修好**的代码上变红。
 *
 * 实现已收敛到 `./source-utils.ts` 一处：那里还要处理「字符串里的 `//` 不是注释」
 * （旧的三份拷贝把 `ws://` 当行注释吃掉，导致本节的两条锁对最该抓的形态判绿）。
 */

// ============================================================
// 1. 地址拼装（纯函数，真调用）
// ============================================================

test("resolveWsUrl: 页面有 host 时用同源 /ws（浏览器与 Electron 开发模式）", () => {
  assert.equal(
    resolveWsUrl({ protocol: "http:", host: "localhost:3001" }),
    "ws://localhost:3001/ws"
  );
  assert.equal(
    resolveWsUrl({ protocol: "http:", host: "127.0.0.1:5173" }),
    "ws://127.0.0.1:5173/ws",
    "Electron 开发模式页面来自 Vite，仍按同源拼（由 Vite 代理到后端）"
  );
  assert.equal(
    resolveWsUrl({ protocol: "https:", host: "vca.example.com" }),
    "wss://vca.example.com/ws",
    "https 页面必须用 wss，否则浏览器直接拒连"
  );
});

test("resolveWsUrl: 页面没有 host（Electron 打包后是 file://）时用主进程报的端口", () => {
  assert.equal(
    resolveWsUrl({ protocol: "file:", host: "", backendPort: 3001 }),
    "ws://127.0.0.1:3001/ws"
  );
  assert.equal(
    resolveWsUrl({ protocol: "file:", host: "", backendPort: 4567 }),
    "ws://127.0.0.1:4567/ws",
    "端口要真的是主进程报的那个，不能写死 3001"
  );
});

test("resolveWsUrl: 拿不到端口时返回 null —— 绝不拼出 `ws:///ws`", () => {
  const WHY =
    "`ws:///ws` 这个地址连不到任何东西：Node 把它解析成主机名 `ws`、路径 `/`，" +
    "浏览器按 WHATWG 规范（ws 属 special scheme，host 不许为空）判为非法 URL。" +
    "拼不出来就得说拼不出来，交给 WebSocket 去猜只会得到一条看不懂的报错。";

  for (const bad of [undefined, null, 0, -1, 65536, NaN, "abc"] as unknown[]) {
    const out = resolveWsUrl({ protocol: "file:", host: "", backendPort: bad as number | null });
    assert.equal(out, null, `backendPort=${JSON.stringify(bad)} 时应返回 null（${WHY}）`);
  }
  assert.equal(resolveWsUrl({ protocol: "file:", host: "" }), null, `没传端口时应返回 null（${WHY}）`);
  assert.notEqual(resolveWsUrl({ protocol: "file:", host: "", backendPort: 3001 }), "ws:///ws");
});

test("反向对照: 有 host 时 **不** 用 backendPort", () => {
  // 这条是上一条同源规则的对照。若实现改成「有端口就优先用端口」，开发模式会绕开
  // Vite 代理直连 3001 —— 代理里的 changeOrigin / ws 升级就整个失效了，
  // 而它平时看着仍然是通的（因为 3001 上确实有服务），所以必须是显式规则。
  assert.equal(
    resolveWsUrl({ protocol: "http:", host: "localhost:5173", backendPort: 3001 }),
    "ws://localhost:5173/ws"
  );
});

// ============================================================
// 2. 地址拼装只有一处实现
// ============================================================

/** `web/src` 下所有源文件（含 .vue） */
function webSources(): string[] {
  const dir = path.join(ROOT, "web", "src");
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|vue)$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

test("★ 结构锁: 读 location.host 的地方只有 transport.ts 一处", () => {
  const files = webSources();
  assert.ok(files.length > 10, `只扫到 ${files.length} 个 web 源文件 —— 路径变了？`);

  const readers: string[] = [];
  for (const f of files) {
    const body = stripComments(fs.readFileSync(f, "utf-8"));
    const hits = body.match(/location\.host/g)?.length ?? 0;
    if (hits > 0) readers.push(`${path.relative(ROOT, f).replace(/\\/g, "/")}×${hits}`);
  }
  assert.deepEqual(
    readers,
    ["web/src/transport.ts×1"],
    `读 location.host 的地方必须收敛到 transport.ts 的 resolveBackendWsUrl 一处（实际：${readers.join(", ")}）。` +
      "各写一份的话，「打包后没有 host」这条分支只会在其中一处被想到 —— 另一处照旧拼出 `ws:///ws`。"
  );
});

test("★ 结构锁: `ws://` 字面量只在 ws-url.ts 里拼", () => {
  // ⚠ 这条锁**曾经是假的**：剥注释用的是 `/\/\/[^\n]*/`（三份拷贝都有），它会把字符串里的
  // `//` 也当注释起点 —— 于是 `` `ws://${location.host}/ws` `` 剥完只剩 `ws:`，正则什么都
  // 匹配不到，注入这个缺陷时本条与上一条**一条都不红**。现已换成 `./source-utils.ts` 里
  // 的逐字符扫描（`tests/source-utils.test.ts` 钉住「不许吃掉 ws://」）。
  const offenders: string[] = [];
  for (const f of webSources()) {
    const body = stripComments(fs.readFileSync(f, "utf-8"));
    if (f.endsWith(path.join("src", "ws-url.ts"))) continue;
    // 只看「拼地址」的形态：字符串/模板串里出现带 scheme 的 ws 地址
    if (/["'`]wss?:\/\//.test(body)) {
      offenders.push(path.relative(ROOT, f).replace(/\\/g, "/"));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `又有第二处在自己拼 ws 地址：${offenders.join(", ")}。` +
      "拼接形态（`` `${protocol}//${host}/ws` ``）由上面那条 location.host 唯一处的锁负责。"
  );
});

test("★ 结构锁: 渲染层必须真的用主进程报的端口与版本", () => {
  const chat = stripComments(read("web/src/composables/useVcaChat.ts"));
  assert.ok(
    chat.includes("resolveBackendWsUrl(waitForDesktopPort)") ||
      chat.includes("resolveBackendWsUrl(isElectron ? waitForDesktopPort"),
    "Electron 分支没有把「等主进程报端口」接进地址解析 —— 打包后又会拼出没有 host 的地址"
  );
  assert.ok(
    chat.includes("onDesktopInit("),
    "useVcaChat 没有订阅 vca:init：端口与版本都拿不到"
  );
  assert.ok(
    chat.includes("desktopVersion.value = info?.version"),
    "版本号没有取自主进程报的那一份"
  );

  const desktop = stripComments(read("web/src/components/DesktopApp.vue"));
  assert.equal(
    /v\d+\.\d+\.\d+/.test(desktop),
    false,
    "DesktopApp.vue 里又出现了写死的版本号 —— 它必须来自主进程（vca:init 的 version）"
  );
  assert.ok(
    desktop.includes("desktopVersion"),
    "侧栏版本号没接上 desktopVersion，会显示不出东西"
  );
});

test("★ 结构锁: preload 在模块加载时就挂上 vca:init（谁先谁后都不丢）", () => {
  const src = stripComments(read("electron/src/preload.ts"));
  const firstOn = src.indexOf('ipcRenderer.on("vca:init"');
  assert.ok(firstOn >= 0, "preload 没有监听 vca:init");

  const apiStart = src.indexOf("const api = {");
  assert.ok(apiStart >= 0, "preload 结构变了（找不到 const api）");
  assert.ok(
    firstOn < apiStart,
    "vca:init 的监听必须在 api 暴露**之前**就挂上：主进程是在窗口 did-finish-load 时发的，" +
      "渲染层注册得晚就拿不到那份 payload（桌面版会连不上后端、版本号也空着）。" +
      "挂在这一层是 preload 能提供的最早时机。"
  );
});

test("★ 结构锁: 打包入口字段指向构建脚本真实产出的文件", () => {
  const pkg = JSON.parse(read("package.json")) as { main?: string; type?: string };
  assert.equal(pkg.type, "module", "根 package.json 的 type 变了 —— 产物后缀的取舍要跟着复核");

  // 只读代码，不读注释：注释里正举着「写 `out: "main.cjs"` 会得到 main.cjs.js」这个反例，
  // 不剥注释就会把反例当成真的 entryPoint 数进来（本文件初版就是这么误报的）。
  const build = stripComments(read("scripts/build-electron.mjs"));
  const outs = [...build.matchAll(/\bout:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(outs, ["main", "preload"], `构建脚本的产物基名变了：${outs.join(", ")}`);
  assert.ok(
    outs.every((o) => !o.includes(".")),
    "esbuild 的 `out` 只是**基名**，扩展名由它自己补 —— 在这里写 `main.cjs` 会产出 " +
      "`main.cjs.js`（实测）。要拿到 .cjs 必须用 outExtension，别在 out 里写后缀。"
  );

  const ext = /outExtension:\s*\{\s*"\.js":\s*"([^"]+)"\s*\}/.exec(build);
  assert.ok(
    ext,
    "构建脚本没有 outExtension —— 产物会是 main.js，而根 package.json 是 type: module，" +
      "Electron 按 ESM 加载这个 CJS 产物会抛 `require is not defined in ES module scope`。"
  );
  assert.equal(ext[1], ".cjs", `产物后缀必须是 .cjs（现在是 ${ext[1]}）`);

  // 构建脚本里 outdir 是 `outdir: outDir`（变量），所以先解析 outDir 的声明再要求两者绑上。
  const outdirDecl = /outDir\s*=\s*path\.join\(root,\s*"([^"]+)",\s*"([^"]+)"\)/.exec(build);
  assert.ok(
    outdirDecl,
    '构建脚本的 outDir 形态变了（不再是 path.join(root, "…", "…")）—— 这条锁的路径推导要跟着改'
  );
  assert.match(
    build,
    /\boutdir:\s*outDir\b/,
    "构建脚本的 outdir 必须指向上面那个 outDir —— 否则这条锁推导出的产物路径与实际写盘位置不符"
  );
  // 从构建脚本**推导**出它真实产出的入口文件，再要求 package.json 的 main 与之逐字相等。
  // 写成字面量 "electron/dist/main.cjs" 就是假锁：改坏构建脚本（换后缀/换目录/换基名）
  // 它照样绿。现在任一边改动都会红。
  const producedMain = [outdirDecl[1], outdirDecl[2], `${outs[0]}${ext[1]}`].join("/");

  assert.equal(
    pkg.main,
    producedMain,
    `package.json 的 main 必须指向构建脚本真实产出的文件（推导得 ${producedMain}）。` +
      "没有 main 时 Electron 会去找 `index.js`，装了也起不来；指向 `.js` 则会按 ESM 加载 CJS 产物。"
  );

  const mainSrc = stripComments(read("electron/src/main.ts"));
  assert.ok(
    mainSrc.includes(`path.join(__dirname, "${outs[1]}${ext[1]}")`),
    `主进程加载 preload 的路径必须等于构建产物名（应为 ${outs[1]}${ext[1]}；写成 preload.js 会以 ESM 加载 CJS 而崩）`
  );

  // 主进程必须把端口与版本真的发出去 —— 渲染层现在依赖这两样
  assert.ok(
    mainSrc.includes("port: PORT") && mainSrc.includes("version: app.getVersion()"),
    "vca:init 的 payload 里必须带 port 与 version（渲染层拿它拼地址、显示版本）"
  );
});
