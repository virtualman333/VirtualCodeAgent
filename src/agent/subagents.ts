/**
 * SubAgent —— 子代理的**纯逻辑层**（不 import config / graph / ui，可在测试里裸跑）。
 *
 * 为什么单拆一个模块
 * ------------------
 * Python 版（`python_legacy/src/vca/subagents/`，755 行）里最值得搬的不是线程与信箱，
 * 是**判断本身**：给一组工具名，哪些该留下、哪些必须踢掉、踢掉之后回落到什么。
 * 这些判断如果和 `CodingAgent` / LLM 调用揉在一起，就永远测不了 —— 而它们恰好是
 * 最容易出错、后果又最难发现的部分（白名单少踢一个 `ask_user`，子代理会挂在那里
 * 等一个永远不会来的回答；没踢 `spawn_subagent`，子代理能无限套娃）。
 *
 * 所以这里只做三件可测的事：
 *   1. **工具白名单**：`resolveToolWhitelist()` —— 校验、去重、强制排除、回落。
 *   2. **独立 system prompt**：`buildSubagentSystemPrompt()` —— 子代理只知道自己的任务。
 *   3. **文本呈现**：`summarize()` / `formatAgentLine()` —— `/agents` 与工具回包共用的那一份。
 *
 * 运行（创建 CodingAgent、跑循环）在 `subagent_manager.ts`。
 *
 * ⚠ 这里只 import 两个叶子模块（`node:path` 与 `paths.js`）—— `paths.js` 是刻意拆出来的
 * 无副作用模块（见它的文件头：import `config.js` 会顺手往真实磁盘补写 `~/.vca/config.json`）。
 * 别在这里 import `tools/index.js` 或 `graph.js`：那会绕成
 * `graph → tools/index → tools/subagent → subagent_manager → graph` 的循环。
 */
import path from "node:path";

import { expandUser } from "../paths.js";

// ============================================================
// 工具白名单
// ============================================================

/**
 * 子代理**永远拿不到**的工具。两条理由，都不许放开：
 *
 * - `ask_user`：子代理是主 Agent 派出去干活的，它没有人可问（主 Agent 正在等它的返回值）。
 *   留着它，子代理会在一次「向用户提问」上永久挂起 —— 界面表现为整轮任务卡死。
 * - `spawn_subagent` / `get_subagent_result` / `list_subagent_runs`：子代理再派子代理
 *   就没有底了（成本与并发都不受控）。子代理自己也不知道有这些东西存在。
 *
 * `BLOCKED_TOOLS` 是**兜底**，不是「默认值」：无论用户怎么在 `tools` 参数里写，
 * 这两条都过不去（`resolveToolWhitelist` 最后无条件减掉它们）。
 */
export const BLOCKED_TOOLS: readonly string[] = [
  "ask_user",
  "spawn_subagent",
  "get_subagent_result",
  "list_subagent_runs",
];

/**
 * 内置子代理预设。
 *
 * 每个预设只改两件事：**工具池**与**给它的任务前缀**。名称与描述会被 `/agents` 直接列给
 * 用户看，也是 `tools` 参数的合法取值（写预设名等于写它的工具池）。
 */
export interface SubAgentSpec {
  /** 预设名（也是 `tools` 参数可以直接写的东西） */
  name: string;
  /** 一行说明，给 `/agents` 与 `spawn_subagent` 的 schema 用 */
  description: string;
  /** 工具白名单（空数组 = 默认全集，减去 BLOCKED_TOOLS） */
  tools: string[];
}

export const BUILTIN_PRESETS: readonly SubAgentSpec[] = [
  {
    name: "explorer",
    description: "只读调研：找文件、读代码、查用法，不改任何东西",
    tools: ["read_file", "glob_files", "grep_content", "bash"],
  },
  {
    name: "editor",
    description: "按明确要求改代码：读写文件 + 跑命令，不做探索性调研",
    tools: ["read_file", "write_file", "edit_file", "glob_files", "grep_content", "bash"],
  },
  {
    name: "tester",
    description: "跑测试并定位失败原因：以 bash 为主，只读源码",
    tools: ["bash", "read_file", "glob_files", "grep_content"],
  },
];

/** 预设名 → 预设。名称比较不做大小写折叠：写错一个字母就该被报出来，不该近似命中 */
export function findPreset(name: string): SubAgentSpec | undefined {
  const key = String(name ?? "").trim();
  return BUILTIN_PRESETS.find((p) => p.name === key);
}

/** `tools` 参数的解析结果 —— 调用方据此决定要不要给用户/LLM 一句解释 */
export interface WhitelistResolution {
  /** 最终生效的工具名（已减掉 BLOCKED_TOOLS） */
  tools: string[];
  /** 传了名字但不在可用工具里 / 被 BLOCKED 掉的 */
  rejected: string[];
  /** 空 = 走默认全集 */
  usedDefault: boolean;
  /** 传了名字但一个都没剩，于是回落到默认 */
  fellBack: boolean;
  /** 命中的预设名（如果 `tools` 写的是预设名） */
  preset?: string;
}

/**
 * 把 `tools` 参数解析成最终工具白名单。
 *
 * 规则（每条都有测试）：
 * - 空 / 只有空白 → 默认全集（可用工具减去 `BLOCKED_TOOLS`），`usedDefault = true`；
 * - 先看整体是不是**预设名**（`explorer` / `editor` / `tester`），是就用它的工具池；
 * - 否则按逗号切成名字：认得以外的名字进 `rejected`，`BLOCKED_TOOLS` 里的也进 `rejected`；
 * - 过滤后一个都不剩 → 回落到默认全集，并且 `fellBack = true`
 *   （**不是**返回空数组：空数组会让 `CodingAgent` 变成没有任何工具，
 *   子代理会开始「凭记忆编答案」，比报错更难发现）；
 * - 去重，保持**首次出现**的顺序（顺序会影响 LLM 看到的工具列表，不该随输入抖动）。
 */
export function resolveToolWhitelist(
  raw: string | undefined | null,
  available: readonly string[]
): WhitelistResolution {
  const usable = available.filter((n) => !BLOCKED_TOOLS.includes(n));
  const text = String(raw ?? "").trim();

  if (!text) {
    return { tools: [...usable], rejected: [], usedDefault: true, fellBack: false };
  }

  const preset = findPreset(text);
  const source = preset ? preset.tools : text.split(",");

  const rejected: string[] = [];
  const tools: string[] = [];
  for (const item of source) {
    const name = String(item ?? "").trim();
    if (!name) continue;
    if (BLOCKED_TOOLS.includes(name)) {
      rejected.push(name);
      continue;
    }
    if (!available.includes(name)) {
      rejected.push(name);
      continue;
    }
    if (!tools.includes(name)) tools.push(name);
  }

  if (tools.length === 0) {
    return {
      tools: [...usable],
      rejected,
      usedDefault: false,
      fellBack: true,
      preset: preset?.name,
    };
  }
  return { tools, rejected, usedDefault: false, fellBack: false, preset: preset?.name };
}

// ============================================================
// 独立 system prompt
// ============================================================

export interface SubagentPromptOptions {
  /** 子任务描述（必填） */
  task: string;
  /** 主 Agent 的补充指令（可选） */
  instructions?: string;
  /** 子代理的工作目录（绝对路径） */
  workspaceDir: string;
  /** 运行环境描述，如 "win32 x64 / bash 5.2" —— 由调用方给，便于测试 */
  environment?: string;
}

/**
 * 子代理的独立 system prompt。
 *
 * 与主 Agent 的 prompt 是**故意的两套**：子代理不需要知道仓库的规矩、不该想着
 * 「要不要问用户」、也不该顺手做任务范围外的事。它需要的是「只干这件事 + 干完
 * 按固定格式汇报」—— 因为它的输出会被塞回主 Agent 的上下文，啰嗦一句都要占额度。
 *
 * 结构固定为：任务 → 补充指令（若有）→ 工作规则 → 环境 → 汇报格式。
 * 测试钉的是「任务原文、工作目录、汇报三项（做了什么/结果/后续需要知道的）都必须出现」。
 */
export function buildSubagentSystemPrompt(opts: SubagentPromptOptions): string {
  const task = String(opts.task ?? "").trim();
  const workspaceDir = String(opts.workspaceDir ?? "").trim();
  const instructions = String(opts.instructions ?? "").trim();
  const environment = String(opts.environment ?? "").trim();

  const lines: string[] = [
    "你是一个 SubAgent，由主 Agent 创建，只负责下面这一件子任务。",
    "",
    "## 你的任务",
    task,
    "",
  ];

  if (instructions) {
    lines.push("## 主 Agent 的补充指令", instructions, "");
  }

  lines.push(
    "## 工作规则",
    "1. 只做上面这一件子任务，不做任何超出范围的事（不顺手重构、不顺手加特性）。",
    "2. 自己动手：读文件、改代码、跑命令都由你独立完成 —— 主 Agent 在等你，不会帮你。",
    "3. 遇到能自己判断的小问题直接决定；**没有用户可问**，别把问题抛回来。",
    `4. 工作目录是 ${workspaceDir || "(未指定)"}，相对路径都相对它解析；不要访问无关目录。`,
    "5. 完成后按下面的格式汇报，不要复述过程、不要贴大段代码。",
    "",
  );

  if (environment) {
    lines.push("## 当前运行环境", environment, "");
  }

  lines.push(
    "## 汇报格式（必须按这三项，每项一两行）",
    "- 做了什么：关键文件 / 关键命令",
    "- 结果如何：成功还是失败，怎么验证的",
    "- 主 Agent 后续可能需要知道的：文件路径 / 端口 / 接口 / 遗留问题",
    "",
    "请用中文回复。",
  );

  return lines.join("\n");
}

// ============================================================
// 标识与呈现
// ============================================================

/** 运行状态 */
export const STATUS_RUNNING = "running";
export const STATUS_COMPLETED = "completed";
export const STATUS_FAILED = "failed";

export interface SubAgentRun {
  id: string;
  name: string;
  task: string;
  workspace_dir: string;
  tools: string[];
  /** 调用方写了、但没生效的工具名（未注册，或属于 `BLOCKED_TOOLS`） */
  rejected: string[];
  /** 白名单一个都没匹配上，已回落到默认工具池（`tools` 只是 `rejected` 的伴随信息，不会自证） */
  fellBack: boolean;
  status: string;
  /** 给主 Agent 的精简结果 */
  result: string;
  /** 失败原因（status = failed 时有值） */
  error: string;
  created_at: number;
  finished_at: number;
  /** 工具调用次数（子代理跑了多少步的可观测证据） */
  tool_calls: number;
}

/**
 * 生成子代理 ID。
 *
 * 形状故意保持 Python 版的 `sub_HHMMSS_xxxxxx`（时间在前、随机后缀在后）：
 * 一眼能看出是几点跑的，又不会因为同一秒起两个而撞号。`now` 与 `rand` 可注入，
 * 便于测试钉住形状（不然只能断言「以 sub_ 开头」，那种断言挡不住回归）。
 *
 * `rand` 返回 0..1 的浮点数（同 `Math.random`）。
 */
export function makeAgentId(now: Date, rand: () => number): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // 6 位 36 进制（约 21.7 亿种），够用且比 hex 短
  const suffix = Math.floor(rand() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return `sub_${stamp}_${suffix}`;
}

/**
 * 精简结果文本 —— **给主 Agent 看的那一份**。
 *
 * 子代理原样吐回来可能是几万字符（它自己也会贴代码），塞进主 Agent 的上下文
 * 既贵又没用。这里只做一件事：太长就**留头留尾**，并在中间写明被省掉了多少 ——
 * 只留头会让主 Agent 看不到结尾的结论（结论几乎总在最后），只留尾则看不到它做了什么。
 */
export function summarize(text: string, max = 2000): string {
  const s = String(text ?? "").trim();
  if (!s) return "(子代理没有返回内容)";
  if (s.length <= max) return s;

  const headLen = Math.floor((max - 80) * 0.45);
  const tailLen = max - 80 - headLen;
  return (
    s.slice(0, headLen) +
    `\n... (共 ${s.length} 字符，中间省略 ${s.length - headLen - tailLen} 字符) ...\n` +
    s.slice(s.length - tailLen)
  );
}

const STATUS_ICONS: Record<string, string> = {
  [STATUS_RUNNING]: "🔄",
  [STATUS_COMPLETED]: "✅",
  [STATUS_FAILED]: "❌",
};

export function statusIcon(status: string): string {
  return STATUS_ICONS[status] ?? "❓";
}

/** 耗时（秒，一位小数）；还没结束返回空串而不是 0.0（0.0 会被读成「瞬间完成」） */
export function durationText(run: Pick<SubAgentRun, "created_at" | "finished_at">): string {
  if (!run.finished_at || run.finished_at < run.created_at) return "";
  return `${((run.finished_at - run.created_at) / 1000).toFixed(1)}s`;
}

/** `/agents` 与工具回包共用的一行摘要 */
export function formatAgentLine(run: SubAgentRun): string {
  const dur = durationText(run);
  const parts = [`${statusIcon(run.status)} ${run.id}`, `(${run.name})`, `[${run.status}]`];
  if (run.tool_calls) parts.push(`工具 ${run.tool_calls} 次`);
  if (dur) parts.push(`耗时 ${dur}`);
  return parts.join(" ");
}

/**
 * `/agents` 的预设清单（纯文本行，不含颜色 —— 上色是 ui 的事）。
 * 与 `BUILTIN_PRESETS` 同源，不手抄第二份。
 */
export function formatPresetLines(): string[] {
  return BUILTIN_PRESETS.map(
    (p) => `  ${p.name}  ${p.description}  ${p.tools.length ? `[${p.tools.join(", ")}]` : "[默认工具池]"}`
  );
}

// ============================================================
// 派发计划
// ============================================================

/**
 * `spawn_subagent` 的入参。zod 只保证「是字符串」，语义裁决（trim、空值、
 * 预设名还是工具名、落哪个目录）全在这里 —— 这样它才不依赖 LLM 与真实工具池可测。
 */
export interface SpawnOptions {
  task: string;
  name?: string;
  instructions?: string;
  tools?: string;
  workspace?: string;
}

export interface SpawnPlanContext {
  /** 主代理当前可用的工具名（子代理只能从这里挑，取不到的就是 `rejected`） */
  available: readonly string[];
  /** 主代理的工作目录 —— 子代理没给 `workspace` 时就用它 */
  workspace: string;
  now: Date;
  rand: () => number;
}

export interface SpawnPlan {
  id: string;
  name: string;
  task: string;
  /** 追加在任务后面的补充指令（空串 = 没有） */
  instructions: string;
  workspaceDir: string;
  tools: string[];
  rejected: string[];
  usedDefault: boolean;
  fellBack: boolean;
  preset?: string;
}

/**
 * 没给 `name` 时用什么名字。
 *
 * 走预设时用预设名（`explorer` 比 `worker` 信息量大得多），否则用 `worker`。
 * 名字只用于显示与 `/agents` 列表，不参与任何路径拼接 —— 所以不需要转义。
 */
export const DEFAULT_SUBAGENT_NAME = "worker";

/**
 * 把一次 `spawn_subagent` 调用摊平成一个可执行的计划。**纯函数**：
 * 不碰磁盘、不建 Agent、不调 LLM，因此每条裁决都能在测试里单独钉住。
 */
export function resolveSpawnPlan(opts: SpawnOptions, ctx: SpawnPlanContext): SpawnPlan {
  const resolution = resolveToolWhitelist(opts.tools, ctx.available);
  const rawName = String(opts.name ?? "").trim();

  return {
    id: makeAgentId(ctx.now, ctx.rand),
    name: rawName || resolution.preset || DEFAULT_SUBAGENT_NAME,
    task: String(opts.task ?? "").trim(),
    instructions: String(opts.instructions ?? "").trim(),
    workspaceDir: resolveSubagentWorkspace(String(opts.workspace ?? ""), ctx.workspace),
    tools: resolution.tools,
    rejected: resolution.rejected,
    usedDefault: resolution.usedDefault,
    fellBack: resolution.fellBack,
    preset: resolution.preset,
  };
}

/**
 * 子代理的工作目录：不给就跟主代理同一个；给了就先展开 `~`，再按主代理目录解相对路径
 * （绝对路径原样生效 —— `path.resolve` 的既有语义）。
 *
 * ⚠ 这里**刻意不检查**「必须落在主代理目录内部」。子代理手里有 `bash`，那条边界本来就拦不住
 * （一条 `cd` 就出去了），写成检查只会让人以为有沙箱 —— **不会响的检查比没有检查更坏**。
 * 真正的边界在工具白名单上（用 `explorer` 预设就没有写文件的能力）。
 */
export function resolveSubagentWorkspace(raw: string, parent: string): string {
  const expanded = expandUser(String(raw ?? "").trim());
  if (!expanded) return parent;
  return path.resolve(parent, expanded);
}
