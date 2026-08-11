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

/** 全部内置工具 (内置 + 计划 + Skills; MCP 工具由 CodingAgent 动态追加) */
export const ALL_TOOLS: StructuredToolInterface[] = [...BUILTIN_TOOLS, ...PLAN_TOOLS, ...SKILL_TOOLS];

/** 可执行工具 (不含 ask_user，它需要特殊拦截) */
export const EXECUTABLE_TOOLS: StructuredToolInterface[] = ALL_TOOLS.filter((t) => t.name !== "ask_user");
