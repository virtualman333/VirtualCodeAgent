/**
 * Agent 工具集 — 内置工具注册
 */
import type { StructuredToolInterface } from "@langchain/core/tools";
import { readFile } from "./read.js";
import { globFiles, grepContent } from "./search.js";
import { editFile } from "./edit.js";
import { writeFile } from "./write.js";
import { bash } from "./bash.js";
import { askUser } from "./ask_user.js";
import { todoCreate, todoUpdate, todoList } from "./plan.js";
import { spawnSubagent, getSubagentResult, listSubagentRuns } from "./subagent.js";
import { SKILL_TOOLS } from "../skills/manager.js";

export type { PlanStep } from "./plan.js";
export { getCurrentPlan, formatPlan, STATUS_ICONS } from "./plan.js";

export const BUILTIN_TOOLS: StructuredToolInterface[] = [
  readFile,
  globFiles,
  grepContent,
  editFile,
  writeFile,
  bash,
  askUser,
];

export const PLAN_TOOLS: StructuredToolInterface[] = [todoCreate, todoUpdate, todoList];

/**
 * 派发子代理的工具。**只有主代理能拿到** —— 子代理的白名单在 `resolveToolWhitelist`
 * 里被 `BLOCKED_TOOLS` 无条件减掉（否则子代理能无限套娃，成本与并发都不受控）。
 * 这里把它们放进 `ALL_TOOLS` 是**故意的**：主代理必须看得见、调得到。
 */
export const SUBAGENT_TOOLS: StructuredToolInterface[] = [
  spawnSubagent,
  getSubagentResult,
  listSubagentRuns,
];

/** 全部内置工具 (内置 + 计划 + Skills + 子代理; MCP 工具由 CodingAgent 动态追加) */
export const ALL_TOOLS: StructuredToolInterface[] = [
  ...BUILTIN_TOOLS,
  ...PLAN_TOOLS,
  ...SKILL_TOOLS,
  ...SUBAGENT_TOOLS,
];

/**
 * 工具体系的总装。**判定本身不在这里**：
 *
 * - 「哪些能进 `ToolNode`」在 `./executable.js`（零 import 的叶子模块，可脱离
 *   `config.ts` 被测试 —— 本文件经 `skills/manager.ts` 会碰到 config）；
 * - 「子代理为什么永远拿不到 `ask_user` / `spawn_subagent`」在
 *   `../agent/subagents.js` 的 `BLOCKED_TOOLS`。
 */
import { executableOf } from "./executable.js";

export { executableOf, NON_EXECUTABLE_TOOLS } from "./executable.js";

/** 可执行工具 (不含 ask_user，它需要特殊拦截) */
export const EXECUTABLE_TOOLS: StructuredToolInterface[] = executableOf(ALL_TOOLS);
