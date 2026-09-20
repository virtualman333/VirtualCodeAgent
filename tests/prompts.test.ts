/**
 * 系统提示词里的工具清单 —— 从注册表现算
 *
 * 改这一版的原因：`prompts.ts` 里那句「当前内置工具为: read_file / … / todo_*」
 * 是**手抄的**，并且写着「Skills/MCP 支持将陆续接入 TS 版」。两句话都已经过期：
 *
 *   - 漏了 `spawn_subagent` / `get_subagent_result` / `list_subagent_runs`
 *   - 漏了 `list_skills` / `load_skill`
 *   - 而 Skills 与 MCP **早就接入了**（`src/skills/manager.ts` / `src/mcp/manager.ts`
 *     都是真实现，工具也真的进了 `ALL_TOOLS`）
 *
 * 于是模型在系统提示词里读到的是一份**比真实工具少一半**的清单，还以为自己不能派子代理、
 * 也没有技能。手抄清单漏了，没有任何东西会响 —— 这份测试就是那个「会响的东西」。
 *
 * ⚠ 为什么这里不 import `src/tools/index.js`：它经 `skills/manager` 会碰到 `config.ts`
 * 的磁盘副作用（模块顶层会往真实 `~/.vca/config.json` 补写），而 `tests/subagents.test.ts`
 * 早就为了同一个原因写明「不能改成 import tools/index.js 再读」。所以工具名依旧从
 * **源码**现算 —— 但只认 `tools/index.ts` 自己 import 的那几个文件（`command_guard.ts`
 * 里也有 `name: "mkfs"`，那是命令黑名单，扫全目录会把它当成工具）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildSystemPrompt } from "../src/agent/prompts.js";
import { REPO_ROOT, stripComments } from "./source-utils.js";

const SRC = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8");

/** 空工作区：`memory()` 读不到 AGENTS.md，提示词里就不会混进仓库自己的文档 */
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "vca-prompts-"));

/**
 * 注册进 `tools/index.ts` 的那些文件 —— **现算**，不手抄。
 * 只跟 `./xxx.js` 与 `../skills/xxx.js` 两种 import；`executable.js` 不是工具。
 */
function registeredToolFiles(): string[] {
  const index = stripComments(SRC("src/tools/index.ts"));
  const files = new Set<string>();
  for (const m of index.matchAll(/from\s+"\.\/([a-z_]+)\.js"/g)) {
    if (m[1] === "executable") continue;
    files.add(`src/tools/${m[1]}.ts`);
  }
  for (const m of index.matchAll(/from\s+"\.\.\/skills\/([a-z_]+)\.js"/g)) {
    files.add(`src/skills/${m[1]}.ts`);
  }
  return [...files].sort();
}

/** 这些文件里真正带 `name: "xxx"` 的工具名 */
function definedToolNames(): string[] {
  const names = new Set<string>();
  for (const rel of registeredToolFiles()) {
    const src = stripComments(SRC(rel));
    for (const m of src.matchAll(/name:\s*"([a-z][a-z0-9_]*)"/g)) names.add(m[1]);
  }
  return [...names].sort();
}

/** 从一段源码里抓出所有 `"小写标识符"` 字面量（数组定义用） */
function quotedIdents(src: string): string[] {
  return [...new Set([...src.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]))];
}

/** 切出一段 `const X ... ];` 的区间 */
function blockOf(src: string, marker: string): string {
  const at = src.indexOf(marker);
  assert.ok(at > 0, `切不出 ${marker} —— 它改名了还是被挪走了？`);
  const end = src.indexOf("];", at);
  assert.ok(end > at, `切不出 ${marker} 的结尾`);
  return src.slice(at, end);
}

// ---------------- 解析面自证 ----------------
test("解析面自证：从源码里认得出全部 15 个工具", () => {
  const files = registeredToolFiles();
  assert.ok(files.length >= 8, `只认出 ${files.length} 个工具文件：${files.join(", ")}`);
  const names = definedToolNames();
  // 15 是手写的下限，不是从被测常量里读的 —— 它防的是「解析面塌成空集」，
  // 那种情况下下面每条「都出现了」的断言都会恒真。
  assert.ok(names.length >= 15, `只从源码里认出 ${names.length} 个工具名：${names.join(", ")}`);
});

// ---------------- 正向：注册表里的每个工具都要在提示词里露面 ----------------
test("★ 注册表里的每个工具，都必须在系统提示词里出现", () => {
  const names = definedToolNames();
  const prompt = buildSystemPrompt(WORKSPACE, names);
  const missing = names.filter((n) => !prompt.includes(n));
  assert.deepEqual(
    missing,
    [],
    `这些工具在系统提示词里一个字都没提：${missing.join(", ")} —— 模型不会用自己没听说过的东西`
  );
});

test("★ 提示词里提到的每个反引号标识符，都必须是真工具名", () => {
  const names = definedToolNames();
  const prompt = buildSystemPrompt(WORKSPACE, names);
  const mentioned = [...new Set([...prompt.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]))];
  assert.ok(mentioned.length >= 15, `提示词里只认出 ${mentioned.length} 个反引号标识符 —— 解析面塌了`);
  const ghosts = mentioned.filter((m) => !names.includes(m));
  assert.deepEqual(
    ghosts,
    [],
    `提示词里点名了不存在的工具：${ghosts.join(", ")} —— 模型会去调一个调不通的名字`
  );
});

test("★ 「Skills/MCP 将陆续接入」这句假话不许再回来", () => {
  const prompt = buildSystemPrompt(WORKSPACE, definedToolNames());
  assert.doesNotMatch(
    prompt,
    /将陆续接入/,
    "这句话是假的：skills 与 MCP 都已接入，工具也真的进了 ALL_TOOLS"
  );
  assert.match(prompt, /list_skills/, "Skills 工具没告诉模型");
  assert.match(prompt, /spawn_subagent/, "子代理工具没告诉模型");
});

test("★ 空清单必须自己喊出来，不许静默给模型一只空工具箱", () => {
  const prompt = buildSystemPrompt(WORKSPACE, []);
  assert.match(
    prompt,
    /工具清单为空/,
    "调用方没传注册表时提示词一个字都不说 —— 静默空清单正是这一版要修的东西"
  );
});

test("★ 工具清单那一节真的是现算出来的（分组行必须在）", () => {
  const prompt = buildSystemPrompt(WORKSPACE, definedToolNames());
  for (const title of ["阅读与理解", "编写与修改", "执行与验证", "用户交互", "计划管理", "专业技能", "子代理"]) {
    assert.ok(
      prompt.includes(`- ${title}: `),
      `清单里没有「${title}」这一行 —— 现算清单被谁删了？
      手写说明恰好覆盖了全部工具名，所以「每个工具都出现」那条抓不到这种删法`
    );
  }
  assert.doesNotMatch(prompt, /尚未归类/, "有工具没被分组表认领");
  assert.doesNotMatch(prompt, /注册表里没有/, "分组表里指着一个不存在的工具名");
});

// ---------------- 两向对账：分组表 ⇄ 注册表 ----------------
test("★ TOOL_GROUPS 与注册表两向对账（腐烂 / 漏归类都要红）", () => {
  const names = definedToolNames();
  const src = stripComments(SRC("src/agent/prompts.ts"));
  const grouped = quotedIdents(blockOf(src, "const TOOL_GROUPS"));
  assert.ok(grouped.length >= 15, `分组表只认出 ${grouped.length} 个名字 —— 解析面塌了`);
  assert.deepEqual(
    grouped.filter((g) => !names.includes(g)),
    [],
    "分组表里这些名字不是真工具 —— 多半是工具改了名，而这张表还指着旧名字"
  );
  assert.deepEqual(
    names.filter((n) => !grouped.includes(n)),
    [],
    "注册表里这些工具没人归类 —— 它们会落到提示词的「尚未归类」那行"
  );
});

// ---------------- 白名单里的名字也得是真的 ----------------
test("★ BLOCKED_TOOLS 里的名字必须都是真工具（拦一个不存在的名字等于没拦）", () => {
  const names = definedToolNames();
  const sub = stripComments(SRC("src/agent/subagents.ts"));
  const blocked = quotedIdents(blockOf(sub, "export const BLOCKED_TOOLS"));
  assert.ok(blocked.length >= 4, `BLOCKED_TOOLS 只认出 ${blocked.length} 个名字 —— 解析面塌了`);
  assert.deepEqual(
    blocked.filter((b) => !names.includes(b)),
    [],
    "BLOCKED_TOOLS 里这些名字不是真工具 —— 子代理白名单会静默失效（它按名字减，减不掉就等于没拦）"
  );
});

test("BUILTIN_PRESETS 的工具名必须都是真工具", () => {
  const names = definedToolNames();
  const sub = stripComments(SRC("src/agent/subagents.ts"));
  const presets = quotedIdents(blockOf(sub, "export const BUILTIN_PRESETS"));
  assert.ok(presets.length >= 5, `preset 表只认出 ${presets.length} 个名字 —— 解析面塌了`);
  // preset 名（explorer / editor / tester）与它引用的工具名混在一起，
  // 所以判据是「**工具形态**的名字必须存在」—— 预设名本身不是工具，用不在名单里就跳过。
  const toolish = presets.filter((p) => /_/.test(p));
  assert.ok(toolish.length >= 4, `preset 里只认出 ${toolish.length} 个工具形态的名字`);
  assert.deepEqual(
    toolish.filter((p) => !names.includes(p)),
    [],
    "preset 里引用了不存在的工具名"
  );
});

// ---------------- 结构锁：接线不许断 ----------------
test("★ 结构锁: graph.ts 把注册表现算的结果传进 buildSystemPrompt", () => {
  const g = stripComments(SRC("src/agent/graph.ts"));
  assert.match(
    g,
    /buildSystemPrompt\(\s*workspaceDir\s*,\s*ALL_TOOLS\.map\(/,
    "makeSystemPrompt 没把 ALL_TOOLS 传进去 —— 工具清单会退回手抄或变空"
  );
  assert.doesNotMatch(
    g,
    /buildSystemPrompt\(\s*workspaceDir\s*\)/,
    "buildSystemPrompt 又变成不传工具名了"
  );
});

test("★ 结构锁: prompts.ts 不许再自己手抄工具清单", () => {
  const p = stripComments(SRC("src/agent/prompts.ts"));
  assert.doesNotMatch(p, /当前内置工具为/, "那句手抄的工具清单又回来了");
  assert.doesNotMatch(p, /skillsMcp/, "旧的 skillsMcp() 又回来了");
  assert.match(p, /function toolCatalog\(/, "现算入口 toolCatalog 不见了");
  assert.match(p, /工具清单为空/, "空清单的自白没了 —— 解析面塌了也没人知道");
});
