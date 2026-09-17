/**
 * `/agents` 这条命令的界面契约。
 *
 * 它此前只打印两句「TS 版还没有 SubAgent、用 /todo 看计划」—— 与 `/skills`、`/mcp`
 * 是同一个病：**能力已经接进来了，界面还在说没有**。用户看到那句就不会去用它，
 * 也不会去调它的工具白名单，功能等于白做。
 *
 * 这里钉住的是「界面必须从真实来源读」这件事：预设清单、运行记录、宿主状态
 * 三样都不许手写结论。手写的清单改不动也测不了，而这份清单**一定会**漂移
 * （预设是代码里的常量，界面是另一处字符串）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { COMMANDS } from "../src/help.js";
import { REPO_ROOT, stripComments } from "./source-utils.js";

const ROOT = REPO_ROOT;
const MAIN_CODE = stripComments(fs.readFileSync(path.join(ROOT, "src", "main.ts"), "utf-8"));
const HELP_CODE = stripComments(fs.readFileSync(path.join(ROOT, "src", "help.ts"), "utf-8"));
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf-8");

/**
 * 抠出 `handleCommand` 里某个 case 的分支体。
 * 结束在下一个同级 case 或 default —— 否则会把后面几条命令的代码也算进来。
 */
function caseBody(code: string, name: string): string {
  const at = code.indexOf(`case "${name}"`);
  assert.ok(at >= 0, `找不到 case "${name}" —— 这条锁需要跟着改`);
  const rest = code.slice(at + 1);
  const stops = [rest.indexOf('\n    case "'), rest.indexOf("\n    default:")].filter((i) => i >= 0);
  const end = stops.length ? Math.min(...stops) : rest.length;
  const body = code.slice(at, at + 1 + end);
  // 正则/切片一旦失灵就会「空字符串也算通过」，这条断言防的就是那种假绿
  assert.ok(body.length > 40, `case "${name}" 的分支体只切出 ${body.length} 字符，切片逻辑大概失效了`);
  return body;
}

test("★ `/agents` 不许再说「还没有 / 尚未接入」（那句话会让用户永远不去用它）", () => {
  const body = caseBody(MAIN_CODE, "/agents");
  for (const lie of ["尚未接入", "还没有 SubAgent", "见 python_legacy"]) {
    assert.equal(body.includes(lie), false, `/agents 分支里还留着这句谎话: ${lie}`);
  }
  // 帮助文本与 README 的命令表是同一件事的另一处写法，同样不许留
  const spec = COMMANDS.find((c) => c.name === "/agents");
  assert.ok(spec, "help.ts 里没有 /agents 这一条");
  assert.equal(spec.desc.includes("尚未接入"), false, `help.ts 里 /agents 的说明还是旧的: ${spec.desc}`);
  const row = README.split("\n").find((l) => l.startsWith("| `/agents`"));
  assert.ok(row, "README 的命令表里应当有 /agents 一行");
  assert.equal(row.includes("尚未接入"), false, `README 里 /agents 一行还是旧的: ${row}`);
});

test("★ `/agents` 必须从真实来源读预设与运行记录，不手写结论", () => {
  const body = caseBody(MAIN_CODE, "/agents");
  assert.match(body, /getSubagentManager\(\)/, "没有去读真实的子代理管理器");
  assert.match(body, /formatPresetLines\(\)/, "预设清单是手写的 —— 它必然与 BUILTIN_PRESETS 漂移");
  assert.match(body, /\.listRuns\(\)/, "没有列出本次会话的运行记录");
});

test("★ `/agents` 必须区分「宿主已登记」与「没登记」（没登记时派发一定失败）", () => {
  const body = caseBody(MAIN_CODE, "/agents");
  assert.match(
    body,
    /hasHost\(\)/,
    "没检查宿主状态 —— 子代理派不出去时，用户从这条命令上完全看不出原因"
  );
});

test("★ `/new` 与 `/clear` 必须清空子代理运行记录（记录是按会话的）", () => {
  for (const cmd of ["/new", "/clear"]) {
    assert.match(
      caseBody(MAIN_CODE, cmd),
      /getSubagentManager\(\)\.clear\(\)/,
      `${cmd} 没有清子代理记录 —— 新窗口里还列着上个窗口派过的子代理，会指错对象`
    );
  }
});

test("★ 每一次 createCodingAgent 都必须紧跟一次宿主登记（加调用点就会红）", () => {
  // 漂移形态：将来多一个 Agent 创建点（比如某个子命令里自己建一个），忘了登记 ——
  // 那个 Agent 派子代理时会直接失败，而失败信息是「还没拿到工具池」，看不出是谁建的。
  const created = MAIN_CODE.match(/createCodingAgent\(/g) ?? [];
  const registered = MAIN_CODE.match(/setSubagentHost\(/g) ?? [];
  assert.ok(created.length >= 2, `只找到 ${created.length} 处 createCodingAgent，入口应当有 2 处`);
  assert.equal(
    registered.length,
    created.length,
    `createCodingAgent 有 ${created.length} 处、setSubagentHost 有 ${registered.length} 处，` +
      "每一个创建点都要登记宿主（否则那个 Agent 派子代理会失败）"
  );
});

test("help.ts 的 /agents 说明与其它命令同规范（非空、不含换行）", () => {
  const spec = COMMANDS.find((c) => c.name === "/agents")!;
  assert.ok(spec.desc.trim().length > 0);
  assert.equal(spec.desc.includes("\n"), false, "说明会顶歪帮助表的对齐");
  assert.equal(HELP_CODE.includes('case "/agents"'), false, "命令清单是纯数据模块，不该出现 case 分支");
});
