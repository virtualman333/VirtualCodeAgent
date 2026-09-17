/**
 * SubAgent 工具 —— 主代理用它们把一件子任务派出去、再看结果。
 *
 * 关于「为什么是同步的」
 * --------------------
 * `spawn_subagent` 会阻塞到子代理跑完。这不是偷懒：主代理此刻正在等一个工具返回值，
 * 中途没有任何用户交互可做，先把 id 返回来再轮询只是把等待搬了个地方，还多出
 * 「跑完了但结果没取回」这个失败模式。所以 `get_subagent_result` 不需要 `timeout` 参数 ——
 * 加一个永远用不上的参数比不加更糟（**不会响的检查比没有检查更坏**）。
 *
 * 那为什么还要 `get_subagent_result` / `list_subagent_runs`？
 * 因为主代理可能一次派好几个（`ToolNode` 会并发跑同一批工具调用），回来一堆结果，
 * 之后再想把某个 id 的完整汇报捞出来，只能靠这两个工具。
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { getSubagentManager } from "../agent/subagent_manager.js";
import { BUILTIN_PRESETS, STATUS_FAILED, formatAgentLine } from "../agent/subagents.js";

const PRESET_NAMES = BUILTIN_PRESETS.map((p) => p.name).join(" / ");

/** 一行里显示任务摘要时的截断长度 */
const TASK_PREVIEW = 60;

function clip(text: string, max: number): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export const spawnSubagent = tool(
  async (args) => {
    const task = String(args.task ?? "").trim();
    if (!task) return "[ERROR] task 不能为空 —— 说清楚要子代理做什么";

    const manager = getSubagentManager();
    let run;
    try {
      run = await manager.spawn({ ...args, task });
    } catch (e) {
      return `[ERROR] 派发子代理失败: ${(e as Error).message}`;
    }

    const head = [formatAgentLine(run), `工作目录: ${run.workspace_dir}`];
    if (run.tools.length) head.push(`工具白名单: ${run.tools.join(", ")}`);
    // 这两个警告必须露出来：不加的话「我明明写了 write_file」和「子代理悄悄只能读」
    // 在主代理眼里长得一模一样 —— 它会误判成「子代理不愿意改文件」。
    if (run.rejected.length) {
      head.push(`⚠ 这些工具名没生效（未注册，或禁止子代理使用）: ${run.rejected.join(", ")}`);
    }
    if (run.fellBack) {
      head.push(`⚠ tools="${args.tools}" 一个都没匹配上，已回落到默认工具池`);
    }

    if (run.status === STATUS_FAILED) {
      head.push(`失败原因: ${run.error}`);
      return head.join("\n");
    }

    return [...head, "", "--- 子代理汇报 ---", run.result].join("\n");
  },
  {
    name: "spawn_subagent",
    description:
      "派一个子代理去独立完成一件子任务，**等它跑完再返回**（同步阻塞，不是后台任务）。" +
      "适用：需要大量读文件/搜索才能得出结论的调研、可以一口气做完的独立改动、" +
      "或者几件互不依赖的事要一次派出去（同一轮里多次调用会并发执行）。" +
      "不适用：一句话就能问清楚的事、需要用户拍板的决策（子代理没有提问能力）、" +
      "以及需要接着上一步结果才能决定的活。子代理看不到本次对话历史，所以 task 要自包含。",
    schema: z.object({
      task: z.string().describe("子任务描述。必须自包含 —— 子代理看不到当前对话，写清目标、范围与验收标准"),
      name: z.string().optional().describe("子代理名字（只用于显示，如 'auth-调研'）。省略则用预设名或 worker"),
      instructions: z
        .string()
        .optional()
        .describe("补充指令（可选），会追加在任务后面，如「只看 src/admin/ 下的代码」"),
      tools: z
        .string()
        .optional()
        .describe(
          `工具白名单：可写预设名（${PRESET_NAMES}），或用逗号分隔的工具名（如 'read_file,glob_files,grep_content'）。` +
            "省略 = 默认工具池。ask_user 与派发类工具永远不可用"
        ),
      workspace: z
        .string()
        .optional()
        .describe("子代理的工作目录（可选）。省略 = 与主代理同一个；相对路径按主代理目录解析"),
    }),
  }
);

export const getSubagentResult = tool(
  async ({ agent_id }) => {
    const run = getSubagentManager().getRun(String(agent_id ?? ""));
    if (!run) {
      return `[ERROR] 找不到子代理 ${agent_id} —— 用 list_subagent_runs 看本次会话跑过哪些`;
    }

    const lines = [formatAgentLine(run), `工作目录: ${run.workspace_dir}`, `任务: ${run.task}`];
    if (run.status === STATUS_FAILED) {
      lines.push(`失败原因: ${run.error}`);
    } else {
      lines.push(`字数: 汇报 ${run.result.length} 字符`);
      lines.push("", "--- 子代理汇报 ---", run.result);
    }
    return lines.join("\n");
  },
  {
    name: "get_subagent_result",
    description:
      "按 id 重新取某个子代理的完整汇报。子代理是同步执行的，所以这里的汇报一定是最终结果，" +
      "不会等 —— 用于一批子代理跑完后回头细看某一个。id 从 spawn_subagent 的返回值或 list_subagent_runs 里拿。",
    schema: z.object({
      agent_id: z.string().describe("子代理 id，形如 sub_143012_a1b2c3"),
    }),
  }
);

export const listSubagentRuns = tool(
  async () => {
    const runs = getSubagentManager().listRuns();
    if (runs.length === 0) {
      return "本次会话还没有派过子代理。用 spawn_subagent 派一个（它会等子代理跑完）。";
    }
    const lines = [`本次会话共 ${runs.length} 个子代理（按派发顺序）:`];
    for (const r of runs) {
      lines.push(`- ${formatAgentLine(r)}  任务: ${clip(r.task, TASK_PREVIEW)}`);
    }
    lines.push("用 get_subagent_result <id> 看某个子代理的完整汇报");
    return lines.join("\n");
  },
  {
    name: "list_subagent_runs",
    description:
      "列出本次会话派过的所有子代理及其状态/工具调用次数/耗时。用于「刚才派了几个、有没有失败」这类自查，" +
      "以及找回某个子代理的 id。注意它只覆盖本次会话，重启后清空。",
    schema: z.object({}),
  }
);
