/**
 * MCP 设置的读写路径 —— `settings.ts`（此前零覆盖）。
 *
 * 读配置是**两个文件的合并**：`~/.vca/mcp.json` 打底，`<workspace>/.vca/mcp.json` 覆盖。
 * 而保存此前是「把界面上看到的整个数组，覆盖写进项目级那一个文件」。于是：
 *
 *   - 在设置页删掉一个来自 `~/.vca/mcp.json` 的 server → 那个文件没被动过，
 *     下次读取它又回来了：接口返回 `ok: true`，**界面上却删不掉**；
 *   - 改一个来自用户级文件的 server → 项目级多出一份影子副本，用户级那份还在，
 *     换个工作空间打开设置又看到旧的。
 *
 * 根因是「写入路径 ≠ 读取路径」。这一节把两条路径钉成同一条：每条按**来源**回写。
 *
 * ⚠ 本文件会改 `~/.vca/mcp.json`，所以在 import 之前先把 HOME 指到临时目录 ——
 * `VCA_DIR` 是模块级常量，晚一步就指向真人的家目录了。第一条测试就是这件事的自证。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const T = fs.mkdtempSync(path.join(os.tmpdir(), "vca-mcp-settings-"));
process.env.USERPROFILE = path.join(T, "home");
process.env.HOME = process.env.USERPROFILE;
fs.mkdirSync(path.join(T, "home", ".vca"), { recursive: true });

// 这两个 import 必须走动态形式：config.ts 在模块初始化时就算好了 VCA_DIR
const { VCA_DIR } = await import("../src/config.js");
const { setWorkspace } = await import("../src/workspace_ctx.js");
const { mcpManager } = await import("../src/mcp/manager.js");
const { getMcpSettings, saveMcpConfig } = await import("../src/settings.js");

const WS = path.join(T, "ws");
const HOME_MCP = path.join(T, "home", ".vca", "mcp.json");
const WS_MCP = path.join(WS, ".vca", "mcp.json");

setWorkspace(WS);

/** 造一份「两个文件都有内容」的现场 */
function reset(home: Record<string, unknown>, project: Record<string, unknown>): void {
  fs.rmSync(path.join(WS, ".vca"), { recursive: true, force: true });
  fs.mkdirSync(path.join(WS, ".vca"), { recursive: true });
  fs.mkdirSync(path.join(T, "home", ".vca"), { recursive: true });
  fs.writeFileSync(HOME_MCP, JSON.stringify({ servers: home }, null, 2), "utf-8");
  fs.writeFileSync(WS_MCP, JSON.stringify({ servers: project }, null, 2), "utf-8");
}

const stdio = (command: string) => ({ transport: "stdio", command, args: [] });
const names = () => getMcpSettings().servers.map((s) => s.name).sort();
const sourceOf = (n: string) => getMcpSettings().servers.find((s) => s.name === n)?.source_file;
const readServers = (file: string) =>
  Object.keys((JSON.parse(fs.readFileSync(file, "utf-8")) as { servers?: Record<string, unknown> }).servers ?? {});

test("自证：HOME 已经指到临时目录，不会碰到真人的 ~/.vca", () => {
  assert.ok(
    path.resolve(VCA_DIR).startsWith(path.resolve(T)),
    `VCA_DIR 跑到临时目录外面去了：${VCA_DIR} —— 下面的用例会改真人的 mcp.json，先停下`
  );
  assert.equal(mcpManager.configFiles().length, 2, "读取面必须是「用户级 + 项目级」两个文件");
  assert.equal(mcpManager.configFiles()[1], WS_MCP, "第二个（优先级最高的）应当是项目级文件");
});

test("读取：两个文件合并，同名由项目级覆盖", () => {
  reset({ fetch: stdio("user-npx"), shared: stdio("user-cmd") }, { github: stdio("proj-npx"), shared: stdio("proj-cmd") });

  const got = names();
  assert.equal(got.length, 3, `解析面不该为空或塌掉，实际 ${JSON.stringify(got)}`);
  assert.deepEqual(got, ["fetch", "github", "shared"], "两个文件的条目都要在");

  const shared = getMcpSettings().servers.find((s) => s.name === "shared");
  assert.equal(shared?.command, "proj-cmd", "同名时项目级覆盖用户级");
});

test("每条都带 source_file：说得出它是从哪个文件读来的", () => {
  reset({ fetch: stdio("user-npx"), shared: stdio("user-cmd") }, { github: stdio("proj-npx"), shared: stdio("proj-cmd") });

  assert.equal(sourceOf("fetch"), HOME_MCP, "只有用户级文件里有它");
  assert.equal(sourceOf("github"), WS_MCP, "只有项目级文件里有它");
  assert.equal(sourceOf("shared"), WS_MCP, "被项目级盖住的，来源算项目级");
});

test("★ 删掉一个来自用户级文件的 server：保存后真的没了", () => {
  reset({ fetch: stdio("user-npx") }, { github: stdio("proj-npx") });
  assert.deepEqual(names(), ["fetch", "github"], "起始状态");

  // 界面上把 fetch 删掉、只留 github —— 前端传的就是这份完整列表
  const r = saveMcpConfig([{ name: "github", transport: "stdio", command: "proj-npx", args: [] }]);
  assert.equal(r.ok, true, `保存失败：${r.error}`);

  assert.deepEqual(names(), ["github"], "用户级文件里那条必须跟着消失（否则界面上「删不掉」）");
  assert.deepEqual(mcpManager.loadConfig().map((s) => s.name), ["github"], "manager 那一层也要一致");
  assert.deepEqual(readServers(HOME_MCP), [], "用户级文件里不该留残骸");
});

test("★ 改一个来自用户级文件的 server：写回用户级，不在项目级留影子", () => {
  reset({ fetch: stdio("user-npx") }, { github: stdio("proj-npx") });

  const r = saveMcpConfig([
    { name: "fetch", transport: "stdio", command: "uvx", args: ["--from", "x"] },
    { name: "github", transport: "stdio", command: "proj-npx", args: [] },
  ]);
  assert.equal(r.ok, true, `保存失败：${r.error}`);

  const homeServers = JSON.parse(fs.readFileSync(HOME_MCP, "utf-8")) as {
    servers: Record<string, { command?: string }>;
  };
  assert.equal(homeServers.servers.fetch?.command, "uvx", "改在哪来的那条，就写回哪个文件");
  assert.deepEqual(readServers(WS_MCP), ["github"], "项目级不许出现 fetch 的影子副本");
  assert.equal(sourceOf("fetch"), HOME_MCP, "来源没变");
});

test("新加的 server 落到项目级（优先级最高的那个文件）", () => {
  reset({ fetch: stdio("user-npx") }, {});

  const r = saveMcpConfig([
    { name: "fetch", transport: "stdio", command: "user-npx", args: [] },
    { name: "brand-new", transport: "stdio", command: "npx", args: [] },
  ]);
  assert.equal(r.ok, true, `保存失败：${r.error}`);

  assert.deepEqual(readServers(WS_MCP), ["brand-new"], "新条目进项目级");
  assert.deepEqual(readServers(HOME_MCP), ["fetch"], "用户级那份不动");
  assert.equal(sourceOf("brand-new"), WS_MCP);
});

test("校验不过就一个文件都不写（不能写了一半）", () => {
  reset({ fetch: stdio("user-npx") }, { github: stdio("proj-npx") });
  const before = [fs.readFileSync(HOME_MCP, "utf-8"), fs.readFileSync(WS_MCP, "utf-8")];

  const badHttp = saveMcpConfig([{ name: "need-url", transport: "http" }]);
  assert.equal(badHttp.ok, false, "http/sse 缺 url 必须拒绝");
  assert.ok(String(badHttp.error).includes("need-url"), `错误信息要点名是哪个 server：${badHttp.error}`);

  const badStdio = saveMcpConfig([{ name: "need-cmd", transport: "stdio" }]);
  assert.equal(badStdio.ok, false, "stdio 缺 command 必须拒绝");
  assert.ok(String(badStdio.error).includes("need-cmd"), `错误信息要点名：${badStdio.error}`);

  assert.equal(fs.readFileSync(HOME_MCP, "utf-8"), before[0], "被拒绝的保存不该动用户级文件");
  assert.equal(fs.readFileSync(WS_MCP, "utf-8"), before[1], "被拒绝的保存不该动项目级文件");
});

test("名字两侧的空格要去掉；空名字直接略过", () => {
  reset({}, {});

  const r = saveMcpConfig([
    { name: "  spaced  ", transport: "stdio", command: "npx", args: [] },
    { name: "", transport: "stdio", command: "npx", args: [] },
    { name: "   ", transport: "stdio", command: "npx", args: [] },
  ]);
  assert.equal(r.ok, true, `保存失败：${r.error}`);

  const keys = readServers(WS_MCP);
  assert.deepEqual(keys, ["spaced"], `写出来的键名要对得上（" fetch " 这种带空格的名字读回来是两条）`);
  assert.deepEqual(names(), ["spaced"]);
});

test("保存完立刻读回来的就是保存的那一套（读写同一份）", () => {
  reset({ a: stdio("user-a") }, { b: stdio("proj-b") });

  const want = [
    { name: "a", transport: "stdio", command: "user-a2", args: [] },
    { name: "c", transport: "sse", url: "https://example.com/sse" },
  ];
  assert.equal(saveMcpConfig(want).ok, true);

  const view = getMcpSettings().servers;
  assert.deepEqual(view.map((s) => s.name).sort(), ["a", "c"], "删掉的 b 要没了，新加的 c 要进来");
  assert.deepEqual(mcpManager.loadConfig().map((s) => s.name).sort(), ["a", "c"], "两条路径看到的是同一套");
  const c = view.find((s) => s.name === "c");
  assert.equal(c?.transport, "sse");
  assert.equal(c?.url, "https://example.com/sse", "sse 的 url 要原样留住");
});
