/**
 * SubAgent 的**纯逻辑层 + 结构锁**。
 *
 * 为什么值得写这么多：这一层出的错全都**不报错**。白名单少踢一个 `ask_user`，
 * 子代理会挂在一个永远不会来的回答上（界面表现为整轮任务卡死）；漏踢 `spawn_subagent`，
 * 子代理能无限套娃（成本与并发都不受控）；预设里写错一个工具名，子代理会**安静地**
 * 少一份能力，然后凭记忆编答案。没有一条会在运行时报出来。
 *
 * 前半段测判断（白名单 / 派发计划 / 呈现），后半段是结构锁：那些「只有写对才成立、
 * 写错了也能跑」的地方 —— 源码锁 + `executableOf` 的行为锁。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  BLOCKED_TOOLS,
  BUILTIN_PRESETS,
  DEFAULT_SUBAGENT_NAME,
  STATUS_COMPLETED,
  STATUS_FAILED,
  STATUS_RUNNING,
  buildSubagentSystemPrompt,
  durationText,
  findPreset,
  formatAgentLine,
  formatPresetLines,
  makeAgentId,
  resolveSpawnPlan,
  resolveSubagentWorkspace,
  resolveToolWhitelist,
  statusIcon,
  summarize,
  type SubAgentRun,
} from "../src/agent/subagents.js";
import { executableOf, NON_EXECUTABLE_TOOLS } from "../src/tools/executable.js";
import { REPO_ROOT, stripComments } from "./source-utils.js";

// ============================================================
// 「真实工具宇宙」现算 —— 不手抄一份名单
// ============================================================

/**
 * 仓库里真实注册的工具名。
 *
 * 从 `src/tools/*.ts` 与 `src/skills/manager.ts` 里现算（工具定义的唯一形态是
 * `tool(fn, { name: "xxx", ... })`）。**不能**改成 import `tools/index.js` 再读
 * `ALL_TOOLS` —— 那条路会经 `skills/manager.ts` import 到 `config.ts`，
 * 后者在 import 时就可能写下真实的 `~/.vca/config.json`（README 里明写过这条）。
 */
function toolNamesInRepo(): string[] {
  const files = fs
    .readdirSync(path.join(REPO_ROOT, "src", "tools"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(REPO_ROOT, "src", "tools", f))
    .concat([path.join(REPO_ROOT, "src", "skills", "manager.ts")]);

  const names = new Set<string>();
  for (const f of files) {
    for (const m of stripComments(fs.readFileSync(f, "utf-8")).matchAll(
      /\bname:\s*"([a-z][a-z0-9_]*)"/g
    )) {
      names.add(m[1]);
    }
  }
  return [...names].sort();
}

const REPO_TOOLS = toolNamesInRepo();
const SRC = (rel: string): string =>
  stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8"));

test("工具宇宙现算成功（空集合会让下面几条「都真实存在」变成空话）", () => {
  assert.ok(REPO_TOOLS.length >= 14, `只算出 ${REPO_TOOLS.length} 个工具名：${REPO_TOOLS.join(", ")}`);
  for (const known of ["read_file", "write_file", "bash", "ask_user", "spawn_subagent"]) {
    assert.ok(REPO_TOOLS.includes(known), `现算的工具表里缺 ${known} —— 扫描规则失效了？`);
  }
});

test("★ BLOCKED_TOOLS 里每个名字都真实存在（写错一个字母 = 那条封锁静默失效）", () => {
  const ghosts = BLOCKED_TOOLS.filter((n) => !REPO_TOOLS.includes(n));
  assert.deepEqual(
    ghosts,
    [],
    `这些名字在仓库里根本没有对应的工具 —— 封锁的是一条不存在的工具，等于没封：${ghosts.join(", ")}`
  );
  assert.ok(BLOCKED_TOOLS.includes("ask_user"), "子代理必须拿不到 ask_user（没有人可以问它）");
  assert.ok(BLOCKED_TOOLS.includes("spawn_subagent"), "子代理不许再派子代理");
});

test("★ 每个预设的工具名都真实存在（否则预设是空头承诺）", () => {
  const bad: string[] = [];
  for (const p of BUILTIN_PRESETS) {
    for (const t of p.tools) {
      if (!REPO_TOOLS.includes(t)) bad.push(`${p.name} → ${t}`);
    }
  }
  assert.deepEqual(bad, [], `预设里写了不存在的工具：${bad.join(", ")}`);
});

test("预设里不许出现被封锁的工具（不靠运行时兜底，静态就该干净）", () => {
  for (const p of BUILTIN_PRESETS) {
    for (const t of p.tools) {
      assert.equal(BLOCKED_TOOLS.includes(t), false, `预设 ${p.name} 里写了被封锁的 ${t}`);
    }
  }
});

test("预设名字不重复，且都非空", () => {
  const names = BUILTIN_PRESETS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, `预设名有重复: ${names.join(", ")}`);
  for (const p of BUILTIN_PRESETS) {
    assert.ok(p.name.trim().length > 0, "预设名不能为空");
    assert.ok(p.description.trim().length > 0, `预设 ${p.name} 缺说明`);
  }
});

// ============================================================
// 工具白名单
// ============================================================

const AVAILABLE = ["read_file", "write_file", "edit_file", "bash", "ask_user", "spawn_subagent"];

test("tools 省略 → 默认全集（可用工具减掉被封的）", () => {
  for (const raw of [undefined, null, "", "   "]) {
    const r = resolveToolWhitelist(raw, AVAILABLE);
    assert.deepEqual(r.tools, ["read_file", "write_file", "edit_file", "bash"]);
    assert.equal(r.usedDefault, true);
    assert.equal(r.fellBack, false);
    assert.deepEqual(r.rejected, []);
  }
});

test("tools 写预设名 → 用它的工具池，并记下命中的预设", () => {
  const r = resolveToolWhitelist("explorer", AVAILABLE);
  assert.equal(r.preset, "explorer");
  assert.equal(r.usedDefault, false);
  assert.deepEqual(r.tools, ["read_file", "bash"], "explorer 的池子里只有 read_file/glob/grep/bash，取交集后应当剩这两个");
});

test("tools 写逗号分隔的工具名 → 保序去重", () => {
  const r = resolveToolWhitelist(" bash , read_file , bash ,, write_file ", AVAILABLE);
  assert.deepEqual(r.tools, ["bash", "read_file", "write_file"]);
  assert.deepEqual(r.rejected, []);
  assert.equal(r.usedDefault, false);
});

test("认不得的名字进 rejected，认得的一个不少", () => {
  const r = resolveToolWhitelist("bash,nope,read_file", AVAILABLE);
  assert.deepEqual(r.tools, ["bash", "read_file"]);
  assert.deepEqual(r.rejected, ["nope"]);
});

test("★ 被封锁的工具名即使出现在 available 里也必须被拒（否则封锁就只是「默认值」）", () => {
  // 反向对照：把 resolveToolWhitelist 里那段 BLOCKED_TOOLS 判定删掉，这条必然变红
  // （ask_user 本来就在 AVAILABLE 里，删掉判定它就会溜进白名单）。已经手工验过一次。
  const r = resolveToolWhitelist("ask_user, read_file, spawn_subagent", AVAILABLE);
  assert.deepEqual(r.tools, ["read_file"]);
  assert.deepEqual(r.rejected, ["ask_user", "spawn_subagent"]);
});

test("★ 传了名字但一个都没剩 → 回落默认全集，不返回空数组", () => {
  // 返回空数组的后果是 `CodingAgent` 没有任何工具，子代理开始凭记忆编答案 ——
  // 比报错更难发现，所以这里钉死「一定回落到能干活的状态」。
  const r = resolveToolWhitelist("ask_user,nope", AVAILABLE);
  assert.equal(r.fellBack, true);
  assert.deepEqual(r.tools, ["read_file", "write_file", "edit_file", "bash"]);
  assert.deepEqual(r.rejected, ["ask_user", "nope"]);
  assert.equal(r.usedDefault, false, "回落不等于「没传」——调用方要靠这个区分并给出警告");
});

test("findPreset 精确匹配，不做大小写折叠", () => {
  assert.equal(findPreset("explorer")?.name, "explorer");
  assert.equal(findPreset("  explorer  ")?.name, "explorer");
  assert.equal(findPreset("Explorer"), undefined, "写错一个字母就该被报出来，不该近似命中");
  assert.equal(findPreset(""), undefined);
});

// ============================================================
// 标识、精简、提示词、呈现
// ============================================================

test("makeAgentId：形状固定、时间取自传入的时刻、rand 决定后缀", () => {
  const now = new Date(2026, 8, 18, 14, 30, 12);
  const id = makeAgentId(now, () => 0);
  assert.equal(id, "sub_143012_000000");
  assert.match(makeAgentId(now, () => 0.999999999), /^sub_143012_[0-9a-z]{6}$/);

  const a = makeAgentId(now, () => 0.1);
  const b = makeAgentId(now, () => 0.9);
  assert.notEqual(a, b, "同一秒起两个不许撞号");
  // 只比 `sub_` 与时间那两段（后缀本来就该不同）—— 按下标切会把后缀头两个字符也算进去
  assert.deepEqual(a.split("_").slice(0, 2), b.split("_").slice(0, 2), "时间前缀应当一致");
  assert.deepEqual(a.split("_").slice(0, 2), ["sub", "143012"]);
});

test("summarize：短的不动、空的给一句人话", () => {
  assert.equal(summarize("一切正常"), "一切正常");
  assert.equal(summarize("  "), "(子代理没有返回内容)");
});

test("★ summarize：太长的留头留尾，并如实报出省了多少", () => {
  // 只留头会丢掉结尾的结论（结论几乎总在最后），只留尾则看不到它做了什么。
  const raw = "HEAD" + "x".repeat(6000) + "TAIL";
  const out = summarize(raw, 2000);
  assert.ok(out.startsWith("HEAD"), "开头被丢了 —— 主代理看不到子代理干了什么");
  assert.ok(out.endsWith("TAIL"), "结尾被丢了 —— 主代理看不到结论");
  assert.ok(out.includes(String(raw.length)), `没有报出原文长度（共 ${raw.length} 字符）`);
  assert.ok(out.length < 2000 + 120, `精简后 ${out.length} 字符，超出预算太多`);
  assert.ok(out.length > 1000, `精简后只剩 ${out.length} 字符，省过头了`);
});

test("buildSubagentSystemPrompt：任务原文、工作目录、三项汇报都必须出现", () => {
  const prompt = buildSubagentSystemPrompt({
    task: "把 src/a.ts 里的 parse() 补上单元测试",
    workspaceDir: "E:\\proj",
    environment: "win32 x64",
  });
  assert.ok(prompt.includes("把 src/a.ts 里的 parse() 补上单元测试"), "任务原文被改写或丢了");
  assert.ok(prompt.includes("E:\\proj"), "没告诉它工作目录");
  for (const key of ["做了什么", "结果如何", "主 Agent 后续可能需要知道的"]) {
    assert.ok(prompt.includes(key), `汇报格式缺了「${key}」这一项`);
  }
  assert.ok(prompt.includes("没有用户可问"), "没告诉它别问用户 —— 它会尝试提问然后永远卡住");
  assert.ok(prompt.includes("win32 x64"), "没带上运行环境");
});

test("buildSubagentSystemPrompt：没给补充指令时不出现那一节", () => {
  const bare = buildSubagentSystemPrompt({ task: "t", workspaceDir: "/w" });
  assert.equal(bare.includes("主 Agent 的补充指令"), false, "空指令也生成了一个空小节");
  const withIns = buildSubagentSystemPrompt({ task: "t", workspaceDir: "/w", instructions: "只看 admin/" });
  assert.ok(withIns.includes("只看 admin/"));
  assert.ok(withIns.includes("主 Agent 的补充指令"));
});

test("statusIcon / durationText / formatAgentLine", () => {
  assert.equal(statusIcon(STATUS_RUNNING), "🔄");
  assert.equal(statusIcon(STATUS_COMPLETED), "✅");
  assert.equal(statusIcon(STATUS_FAILED), "❌");
  assert.equal(statusIcon("whatever"), "❓", "认不得的状态不该伪装成已知状态");

  assert.equal(durationText({ created_at: 1000, finished_at: 0 }), "", "还没跑完不该报 0.0s");
  assert.equal(durationText({ created_at: 1000, finished_at: 1000 }), "0.0s");
  assert.equal(durationText({ created_at: 1000, finished_at: 24500 }), "23.5s");

  const run: SubAgentRun = {
    id: "sub_143012_abc123",
    name: "explorer",
    task: "查一下",
    workspace_dir: "E:\\proj",
    tools: ["read_file"],
    rejected: [],
    fellBack: false,
    status: STATUS_COMPLETED,
    result: "ok",
    error: "",
    created_at: 1000,
    finished_at: 5000,
    tool_calls: 7,
  };
  const line = formatAgentLine(run);
  for (const bit of ["sub_143012_abc123", "explorer", STATUS_COMPLETED, "7", "4.0s"]) {
    assert.ok(line.includes(bit), `摘要行缺了 ${bit}: ${line}`);
  }
});

test("formatPresetLines 与 BUILTIN_PRESETS 同源（不是手抄的第二份）", () => {
  const lines = formatPresetLines();
  assert.equal(lines.length, BUILTIN_PRESETS.length);
  BUILTIN_PRESETS.forEach((p, i) => {
    assert.ok(lines[i].includes(p.name), `第 ${i + 1} 行与预设 ${p.name} 对不上: ${lines[i]}`);
    assert.ok(lines[i].includes(p.description), `预设 ${p.name} 的说明没进清单`);
  });
});

// ============================================================
// 派发计划
// ============================================================

const PARENT = path.resolve("parent-dir");
const planCtx = { available: AVAILABLE, workspace: PARENT, now: new Date(2026, 8, 18, 9, 0, 0), rand: () => 0 };

test("resolveSpawnPlan：不给 workspace 就跟着主代理", () => {
  const plan = resolveSpawnPlan({ task: "  干活  " }, planCtx);
  assert.equal(plan.workspaceDir, PARENT);
  assert.equal(plan.task, "干活", "task 没有 trim");
  assert.equal(plan.id, "sub_090000_000000");
  assert.deepEqual(plan.tools, ["read_file", "write_file", "edit_file", "bash"]);
  assert.equal(plan.usedDefault, true);
});

test("resolveSpawnPlan：名字的优先级是「显式 > 预设名 > worker」", () => {
  assert.equal(resolveSpawnPlan({ task: "t" }, planCtx).name, DEFAULT_SUBAGENT_NAME);
  assert.equal(resolveSpawnPlan({ task: "t", tools: "editor" }, planCtx).name, "editor");
  assert.equal(resolveSpawnPlan({ task: "t", tools: "editor", name: " 我的改动 " }, planCtx).name, "我的改动");
});

test("resolveSpawnPlan：回落标志透传给调用方（工具靠它给警告）", () => {
  const plan = resolveSpawnPlan({ task: "t", tools: "ask_user,nope" }, planCtx);
  assert.equal(plan.fellBack, true);
  assert.deepEqual(plan.rejected, ["ask_user", "nope"]);
  assert.equal(plan.name, DEFAULT_SUBAGENT_NAME);
});

test("resolveSubagentWorkspace：空=跟着主代理；相对按主代理解析；绝对原样；~ 展开", () => {
  assert.equal(resolveSubagentWorkspace("", PARENT), PARENT);
  assert.equal(resolveSubagentWorkspace("   ", PARENT), PARENT);
  assert.equal(resolveSubagentWorkspace("sub", PARENT), path.join(PARENT, "sub"));
  assert.equal(resolveSubagentWorkspace("..", PARENT), path.dirname(PARENT));

  const abs = path.resolve("somewhere-else");
  assert.equal(resolveSubagentWorkspace(abs, PARENT), abs);

  assert.equal(resolveSubagentWorkspace("~/x", PARENT), path.join(os.homedir(), "x"));
});

test("resolveSpawnPlan 的 instructions 也 trim（没给就是空串）", () => {
  assert.equal(resolveSpawnPlan({ task: "t" }, planCtx).instructions, "");
  assert.equal(resolveSpawnPlan({ task: "t", instructions: "  只看 admin/  " }, planCtx).instructions, "只看 admin/");
});

// ============================================================
// 结构锁 + 行为锁
// ============================================================

test("executableOf：ask_user 出局，其余原样保序（含 MCP 这类外来工具）", () => {
  const pool = [
    { name: "read_file" },
    { name: "ask_user" },
    { name: "spawn_subagent" },
    { name: "mcp__foo__bar" },
  ];
  assert.deepEqual(executableOf(pool).map((t) => t.name), ["read_file", "spawn_subagent", "mcp__foo__bar"]);
  assert.deepEqual(NON_EXECUTABLE_TOOLS, ["ask_user"], "不可执行的名单变了 —— 上面那条断言要跟着改");
});

test("★ 结构锁: 子代理的 CodingAgent 必须带白名单构造（不传 = 它拿得到 ask_user）", () => {
  const manager = SRC("src/agent/subagent_manager.ts");
  assert.match(
    manager,
    /createCodingAgent\([^)]*plan\.tools/,
    "subagent_manager 创建子代理时没有把 plan.tools 传进 createCodingAgent —— 子代理会拿到全量工具"
  );
});

test("★ 结构锁: 白名单必须同时管住「绑给 LLM 的」与「ToolNode 能执行的」", () => {
  const graph = SRC("src/agent/graph.ts");
  assert.match(graph, /this\.allTools\s*=\s*allowed\b/, "绑定给 LLM 的工具池没有走白名单");
  assert.match(
    graph,
    /bindTools\(this\.allTools\)/,
    "绑定用的是未过滤的池子 —— `this.allTools` 过滤了也白过滤"
  );
  assert.doesNotMatch(graph, /bindTools\(pool\)/, "绑给模型的是未过滤的池子");
  assert.match(
    graph,
    /executableOf\(allowed\)/,
    "可执行工具池没有走白名单 —— 白名单会变成假锁：LLM 虽然不绑定被禁的工具，但模型写出来的调用请求照样会被 ToolNode 执行"
  );
  assert.doesNotMatch(graph, /executableOf\(pool\)/, "可执行集用的是未过滤的池子");
  assert.doesNotMatch(
    graph,
    /\bEXECUTABLE_TOOLS\b/,
    "graph.ts 又直接用 EXECUTABLE_TOOLS 了 —— 那是不过白名单的全集"
  );
});

test("★ 结构锁: 三个派发工具必须真的进了主代理的工具池", () => {
  const index = SRC("src/tools/index.ts");
  assert.match(index, /\.\.\.SUBAGENT_TOOLS/, "SUBAGENT_TOOLS 没有并进 ALL_TOOLS —— 主代理看不见、调不到");
  const sub = SRC("src/tools/subagent.ts");
  for (const n of ["spawn_subagent", "get_subagent_result", "list_subagent_runs"]) {
    assert.ok(sub.includes(`name: "${n}"`), `${n} 没有定义在 tools/subagent.ts 里`);
  }
});

test("★ 结构锁: get_subagent_result 不许有 timeout 参数（同步执行时它永远不会响）", () => {
  const sub = SRC("src/tools/subagent.ts");
  const at = sub.indexOf('name: "get_subagent_result"');
  const end = sub.indexOf('name: "list_subagent_runs"', at);
  assert.ok(at > 0 && end > at, "切不出 get_subagent_result 这一段 —— 工具顺序变了？");
  assert.doesNotMatch(
    sub.slice(at, end),
    /timeout/,
    "加了一个永远不会生效的参数 —— 不会响的检查比没有检查更坏"
  );
});

test("★ 结构锁: spawn_subagent 的说明必须写明它是同步阻塞的", () => {
  const sub = SRC("src/tools/subagent.ts");
  // 说明在 `name:` 与 `schema:` 之间（`tool(fn, { name, description, schema })`）——
  // 盯的是**说给模型听的那段话**，不是实现
  const at = sub.indexOf('name: "spawn_subagent"');
  const end = sub.indexOf("schema:", at);
  assert.ok(at > 0 && end > at, "切不出 spawn_subagent 的说明段");
  assert.match(
    sub.slice(at, end),
    /同步/,
    "说明里没写「同步阻塞」—— 模型会以为它是后台任务，然后不等结果就去干别的"
  );
});

test("★ 结构锁: 白名单被拒/回落必须回报给主代理（否则它会误判子代理的能力）", () => {
  const sub = SRC("src/tools/subagent.ts");
  assert.match(sub, /run\.rejected/, "rejected 没有露出来：主代理分不清「没写对工具名」和「子代理不愿意改文件」");
  assert.match(sub, /run\.fellBack/, "fellBack 没有露出来：白名单整个失效时主代理完全不知情");
});
