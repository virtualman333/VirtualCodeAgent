/**
 * Plan/Todo 工具 - 让 Agent 制定并跟踪任务计划 (仿 Claude Code 的 TodoWrite)
 *
 * Agent 工作流:
 * 1. todo_create 在任务开始时列出待办步骤
 * 2. todo_update 在每步开始/完成时更新状态
 * 3. 计划状态通过工具返回值进入消息历史，LLM 每轮都能看到当前进度
 * 4. 控制台通过 getCurrentPlan() 实时展示计划面板
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// ---- 状态常量 ----
export const STATUS_PENDING = "pending";
export const STATUS_IN_PROGRESS = "in_progress";
export const STATUS_COMPLETED = "completed";
export const STATUS_FAILED = "failed";

const VALID_STATUS = new Set([STATUS_PENDING, STATUS_IN_PROGRESS, STATUS_COMPLETED, STATUS_FAILED]);

export const STATUS_ICONS: Record<string, string> = {
  [STATUS_PENDING]: "🔲",
  [STATUS_IN_PROGRESS]: "🔄",
  [STATUS_COMPLETED]: "✅",
  [STATUS_FAILED]: "❌",
};

export interface PlanStep {
  description: string;
  status: string;
}

// ---- 计划存储 (模块级全局) ----
let currentPlan: PlanStep[] = [];

export function getCurrentPlan(): PlanStep[] {
  return currentPlan.map((s) => ({ ...s }));
}

function setPlan(plan: PlanStep[]): void {
  currentPlan = plan;
}

export function formatPlan(plan: PlanStep[]): string {
  if (plan.length === 0) return "**当前无计划**";
  const lines = ["**任务计划:**"];
  plan.forEach((step, i) => {
    const icon = STATUS_ICONS[step.status] ?? "🔲";
    lines.push(`${i + 1}. ${icon} ${step.description}`);
  });
  return lines.join("\n");
}

// ============================================================
// 工具定义
// ============================================================

export const todoCreate = tool(
  async ({ todos }: { todos: string[] }) => {
    const plan = todos.map((t) => ({ description: t, status: STATUS_PENDING }));
    setPlan(plan);
    return formatPlan(plan);
  },
  {
    name: "todo_create",
    description:
      "创建/替换当前任务计划 (Todo List)。在开始执行多步任务前必须调用，将任务分解为清晰的待办步骤。之后每完成一步用 todo_update 更新状态。",
    schema: z.object({
      todos: z.array(z.string()).describe("计划步骤列表，例如 ['创建项目结构', '实现核心功能', '编写测试']"),
    }),
  }
);

export const todoUpdate = tool(
  async ({ index, status }: { index: number; status: string }) => {
    if (index < 1 || index > currentPlan.length) {
      return `[ERROR] 步骤 ${index} 不存在 (共 ${currentPlan.length} 步)`;
    }
    if (!VALID_STATUS.has(status)) {
      return `[ERROR] 无效状态 '${status}'，可用: ${[...VALID_STATUS].join(", ")}`;
    }
    currentPlan[index - 1].status = status;
    return formatPlan(currentPlan);
  },
  {
    name: "todo_update",
    description:
      "更新任务计划中某一步的状态。每个步骤开始执行前设为 in_progress，完成后设为 completed，执行失败设为 failed。",
    schema: z.object({
      index: z.number().int().describe("要更新的步骤编号 (从 1 开始)"),
      status: z.string().describe("新状态: pending / in_progress / completed / failed"),
    }),
  }
);

export const todoList = tool(
  async () => {
    return formatPlan(currentPlan);
  },
  {
    name: "todo_list",
    description: "查看当前任务计划的完整状态。在任何时候调用以查看还有哪些步骤待完成、哪些已完成。",
    schema: z.object({}),
  }
);
