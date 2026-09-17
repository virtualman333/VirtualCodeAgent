/**
 * SubAgent 运行器 —— 把 `subagents.ts` 的裁决真正跑起来。
 *
 * 与 Python 版（`python_legacy/src/vca/subagents/manager.py`，395 行）的关键差异：
 *
 * 1. **同步派发**。`spawn_subagent` 一直等到子代理跑完才返回，不是「先返回 id、稍后再取」。
 *    Python 版配了后台线程 + 文件信箱（`mailbox.py`），那是为了「进程重启后还能恢复」，
 *    代价是主 Agent 要反复轮询、还要处理「跑完了但结果丢了」。这里不做：主 Agent 正在等
 *    一个工具返回值，中间没有用户交互，阻塞它没有任何损失，而轮询与信箱都是纯负担。
 * 2. **工作目录用 `AsyncLocalStorage` 隔离**（见 `workspace_ctx.ts` 的文件头），不是全局变量。
 * 3. **子代理不进主对话历史**：它有自己的一份 `AgentState`，只有精简后的结果回给主代理。
 *    否则子代理读的每个文件、跑的每条命令都会永久占住主代理的上下文额度。
 * 4. **安全边界由构造保证**：交给 `CodingAgent` 的白名单里根本没有 `ask_user` /
 *    `spawn_subagent`，所以不是「拦住它别调」，而是**它看不见**。
 */
import fs from "node:fs";

import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";

import { getWorkspace, runWithWorkspace } from "../workspace_ctx.js";
import {
  STATUS_COMPLETED,
  STATUS_FAILED,
  STATUS_RUNNING,
  buildSubagentSystemPrompt,
  resolveSpawnPlan,
  summarize,
  type SpawnOptions,
  type SubAgentRun,
} from "./subagents.js";
import { createInitialState } from "./state.js";

/**
 * 子代理自己的工具循环上限（主代理用的是 `Config.MAX_TOOL_ITERATIONS`）。
 *
 * 比主代理小：子代理只干一件子任务，用不到 10 轮；而每多一轮都是真金白银，
 * 且它跑飞的时候没有人在旁边按 Ctrl+C。超了会由 LangGraph 抛递归上限错误 ——
 * 那是**有信息量**的失败（`status = failed` + 原因），比静默截断好。
 */
export const SUBAGENT_MAX_ITERATIONS = 6;

/** 传给 LangGraph 的步数上限（每轮工具循环 2 步，再留收尾） */
export const SUBAGENT_RECURSION_LIMIT = SUBAGENT_MAX_ITERATIONS * 2 + 10;

/**
 * 主代理交给子代理的那点信息。刻意只留这两样 —— 子代理不需要主代理的对话历史、
 * 计划、用量统计，给了只会诱导它去「猜上下文」而不是自己去看代码。
 */
export interface SubagentHost {
  /** 主代理的完整工具池：子代理的白名单只能从里面挑（挑不到的名字进 `rejected`） */
  allTools: ReadonlyArray<{ name: string }>;
  /** 主代理当前用的模型 —— 子代理跟着用同一个（`/model` 切了下一轮就同步跟上） */
  modelConfig: { name: string };
}

function environmentText(): string {
  return `${process.platform} ${process.arch} · Node ${process.versions.node} · bash 可用`;
}

export class SubAgentManager {
  private host: SubagentHost | null = null;
  private readonly runs = new Map<string, SubAgentRun>();

  /**
   * 登记主代理的工具池与模型。main.ts 在**每次创建 Agent 之后**调用
   * （它每轮都会按 `cs.modelName` 重建 Agent，所以这里跟着更新，
   * 不然 `/model` 切了模型、子代理还在用旧的）。
   */
  setHost(host: SubagentHost): void {
    this.host = host;
  }

  hasHost(): boolean {
    return this.host !== null;
  }

  /** 清空运行记录（`/new` 开新对话时调；记录是按会话的，不该跨会话串） */
  clear(): void {
    this.runs.clear();
  }

  /** 本次会话跑过的全部子代理，按派发顺序 */
  listRuns(): SubAgentRun[] {
    return [...this.runs.values()];
  }

  getRun(id: string): SubAgentRun | undefined {
    return this.runs.get(String(id ?? "").trim());
  }

  /**
   * 派一个子代理，等它跑完再返回。
   *
   * 失败**不抛出**：折成 `status = failed` 的 run 交给调用方（工具把它变成一句
   * `[ERROR] ...` 回给主代理）。抛出去会让整轮 ReAct 循环炸掉，而子代理失败本来是
   * 主代理可以自己补救的事（换个工具、自己动手）。
   */
  async spawn(opts: SpawnOptions): Promise<SubAgentRun> {
    if (!this.host) {
      throw new Error(
        "SubAgent 还没有拿到主代理的工具池 —— main.ts 创建 Agent 之后要调用 setSubagentHost()"
      );
    }

    const plan = resolveSpawnPlan(opts, {
      available: this.host.allTools.map((t) => t.name),
      workspace: getWorkspace(),
      now: new Date(),
      rand: Math.random,
    });

    const run: SubAgentRun = {
      id: plan.id,
      name: plan.name,
      task: plan.task,
      workspace_dir: plan.workspaceDir,
      tools: plan.tools,
      rejected: plan.rejected,
      fellBack: plan.fellBack,
      status: STATUS_RUNNING,
      result: "",
      error: "",
      created_at: Date.now(),
      finished_at: 0,
      tool_calls: 0,
    };
    this.runs.set(run.id, run);

    try {
      fs.mkdirSync(plan.workspaceDir, { recursive: true });

      // 动态 import：`graph.ts` 静态 import 了 `tools/index.ts`，而 `tools/subagent.ts`
      // 又 import 本模块 —— 静态引入会绕成一个环。放在这里既断开环，又不额外付代价
      // （spawn 本来就是 async）。
      const { createCodingAgent } = await import("./graph.js");
      const sub = await createCodingAgent(this.host.modelConfig.name, [], plan.tools);

      const state = createInitialState(plan.workspaceDir);
      state.messages = [
        new SystemMessage({
          content: buildSubagentSystemPrompt({
            task: plan.task,
            instructions: plan.instructions,
            workspaceDir: plan.workspaceDir,
            environment: environmentText(),
          }),
        }),
        new HumanMessage({ content: plan.task }),
      ];

      // 整个执行过程挂在 ALS 上：子代理内部任何深度的 `getWorkspace()` 都是它自己的目录，
      // 主代理的并发工具调用不受影响（`runWithWorkspace` 还负责跑完把模块级变量还原）。
      const final = await runWithWorkspace(plan.workspaceDir, () =>
        sub.invoke(state, SUBAGENT_RECURSION_LIMIT)
      );

      run.tool_calls = final.messages.filter((m) => m instanceof ToolMessage).length;
      run.result = summarize(String(final.final_response ?? ""));
      run.status = STATUS_COMPLETED;
    } catch (e) {
      run.status = STATUS_FAILED;
      run.error = (e as Error)?.message || String(e);
    } finally {
      run.finished_at = Date.now();
    }

    return run;
  }
}

let manager: SubAgentManager | null = null;

export function getSubagentManager(): SubAgentManager {
  if (!manager) manager = new SubAgentManager();
  return manager;
}

/** 只给测试用：丢掉单例（含全部运行记录） */
export function resetSubagentManager(): void {
  manager = null;
}

/** main.ts 的入口：把刚创建好的 Agent 登记成子代理的宿主 */
export function setSubagentHost(host: SubagentHost): void {
  getSubagentManager().setHost(host);
}
