/**
 * Agent 流式运行与渲染 - 单次任务的完整执行展示
 */
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import type { AgentState, PendingQuestion } from "./state.js";
import type { CodingAgent } from "./graph.js";
import {
  print,
  panel,
  renderMarkdown,
  promptUser,
  dim,
  italic,
  yellow,
  cyan,
  magenta,
  green,
  bold,
} from "../ui.js";
import { isInterrupted, setInterrupted, handleInterrupt, readInterruptCommand } from "../interrupt.js";
import { formatPlan, STATUS_ICONS } from "../tools/index.js";

const THINKING_COLLAPSED_MAX = 300;

// ============================================================
// 格式化辅助
// ============================================================

function truncateThinking(text: string): string {
  if (!text) return "(无推理内容)";
  const compact = text.replace(/\n/g, " ").trim();
  return compact.length > THINKING_COLLAPSED_MAX
    ? compact.slice(0, THINKING_COLLAPSED_MAX) + "..."
    : compact;
}

function formatToolArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      let val = typeof v === "string" ? v : JSON.stringify(v);
      if (val.length > 60) val = val.slice(0, 57) + "...";
      return `${k}=${JSON.stringify(val)}`;
    })
    .join(", ");
}

function fmtNum(n: number): string {
  return Math.round(n || 0).toLocaleString();
}

function fmtDuration(ms: number): string {
  if (!ms || isNaN(ms)) return "-";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ============================================================
// 渲染函数
// ============================================================

function renderAgentStep(nodeOutput: Partial<AgentState>, verbose: boolean): void {
  for (const msg of nodeOutput.messages ?? []) {
    if (!(msg instanceof AIMessage)) continue;

    const thinkingText = String(msg.content ?? "");

    if (thinkingText.trim()) {
      if (verbose) {
        print();
        panel(renderMarkdown(thinkingText), bold(yellow("🧠 深度思考")), "yellow");
      } else {
        const collapsed = truncateThinking(thinkingText);
        print(`  ${yellow("🧠")} ${dim(italic(collapsed))} ${dim("(输入 /verbose 展开)")}`);
      }
    }

    if (msg.tool_calls?.length) {
      msg.tool_calls.forEach((tc, i) => {
        const argsStr = formatToolArgs((tc.args ?? {}) as Record<string, unknown>);
        print(`  ${cyan(`[${i + 1}]`)} ${bold(cyan(`→ ${tc.name}`))}(${argsStr})`);
      });
    }
  }
}

function renderPlanTool(msg: ToolMessage): void {
  const content = String(msg.content ?? "");
  const planLines: string[] = [];
  for (const line of content.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith("**") || l.startsWith("[") || l.includes("不存在") || l.includes("无效")) continue;
    if (l.length > 2 && (l[1] === "." || /^\d{1,2}\./.test(l))) {
      planLines.push(l);
    }
  }
  if (planLines.length === 0) return;

  const colored = planLines.map((line) => {
    if (line.includes("✅")) return green(line);
    if (line.includes("🔄")) return cyan(line);
    if (line.includes("❌")) return red(line);
    return dim(line);
  });
  panel(colored.join("\n"), bold(blue("📋 任务计划")), "blue");
}

function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}
function blue(s: string): string {
  return `\x1b[34m${s}\x1b[0m`;
}

// ============================================================
// AskUser 交互
// ============================================================

async function renderAskUser(pending: PendingQuestion): Promise<string | null> {
  const { header, question, options, is_multi } = pending;

  print();
  panel(bold(question), bold(magenta(`💬 ${header}`)), "magenta");

  if (options.length > 0) {
    print();
    options.forEach((opt, i) => print(`  ${cyan(String(i + 1))}. ${opt}`));
    const customIdx = options.length + 1;
    const skipIdx = options.length + 2;
    print(`  ${cyan(String(customIdx))}. 自定义回答`);
    print(`  ${cyan(String(skipIdx))}. 跳过`);
    print();
    if (is_multi) print(dim("多选: 可用逗号分隔编号，如 1,3,4"));

    while (true) {
      const choice = (await promptUser("请选择 (默认 1): ")) ?? "";
      const ans = choice.trim() || "1";
      if (ans === String(skipIdx)) return "[用户选择跳过]";
      if (ans === String(customIdx)) return askUserFreeInput();

      // 多选解析
      if (is_multi && ans.includes(",")) {
        const selected = ans
          .split(",")
          .map((part) => {
            const idx = parseInt(part.trim(), 10) - 1;
            return idx >= 0 && idx < options.length ? options[idx] : null;
          })
          .filter((v): v is string => v !== null);
        if (selected.length > 0) return "用户选择了: " + selected.join(", ");
      }

      const idx = parseInt(ans, 10) - 1;
      if (idx >= 0 && idx < options.length) {
        return `用户选择了: ${options[idx]}`;
      }
      print(red(`无效选项，请输入 1-${skipIdx}`));
    }
  }

  return askUserFreeInput();
}

async function askUserFreeInput(): Promise<string | null> {
  print(dim("请输入你的回答 (直接回车跳过):"));
  const answer = await promptUser("> ");
  if (answer === null) return null;
  return answer.trim() ? `用户回答: ${answer.trim()}` : "[用户选择跳过]";
}

// ============================================================
// 主运行函数
// ============================================================

export async function runAgent(
  agent: CodingAgent,
  state: AgentState,
  userInput: string,
  verbose = false
): Promise<void> {
  state.messages.push(new HumanMessage({ content: userInput }));
  state.pending_question = null;

  // --- 外层循环: 处理 ask_user 暂停/恢复 + 打断 ---
  while (true) {
    let totalTools = 0;
    let hasRespond = false;
    let sumInput = 0;
    let sumOutput = 0;
    let sumTotal = 0;
    let sumLlmMs = 0;
    let sumToolMs = 0;

    try {
      for await (const step of agent.stream(state)) {
        for (const [nodeName, nodeOutput] of Object.entries(step)) {
          // --- agent 节点 (LLM 推理) ---
          if (nodeName === "agent") {
            renderAgentStep(nodeOutput, verbose);
            for (const msg of nodeOutput.messages ?? []) {
              if (msg instanceof AIMessage) state.messages.push(msg);
            }
            const usage = nodeOutput.llm_usage;
            if (usage) {
              sumInput += usage.input_tokens ?? 0;
              sumOutput += usage.output_tokens ?? 0;
              sumTotal += usage.total_tokens ?? 0;
              sumLlmMs += usage.duration_ms ?? 0;
            }
          }
          // --- tools 节点 (执行结果, 不显示; plan 工具除外) ---
          else if (nodeName === "tools") {
            for (const msg of nodeOutput.messages ?? []) {
              if (!(msg instanceof ToolMessage)) continue;
              if (msg.content !== "[AWAITING_USER_INPUT]") totalTools += 1;
              state.messages.push(msg);
              if (msg.name && msg.name.startsWith("todo_")) {
                renderPlanTool(msg);
              }
            }
            if (nodeOutput.tool_usage) {
              sumToolMs += nodeOutput.tool_usage.duration_ms ?? 0;
            }
          }
          // --- ask_user 节点 ---
          else if (nodeName === "ask_user") {
            const pq = nodeOutput.pending_question;
            if (pq) {
              state.pending_question = pq;
              print(`  ${magenta("💬")} ${bold(magenta("Agent 需要确认: "))}`);
            }
          }
          // --- respond 节点: 最终回答 ---
          else if (nodeName === "respond") {
            const final = nodeOutput.final_response;
            const pending = state.pending_question;
            if (final && !pending) {
              print();
              panel(renderMarkdown(final), bold(green("✓ 最终回答")), "green");
              hasRespond = true;
            }
          }
        }

        // 打断检查
        if (isInterrupted()) {
          setInterrupted(false);
          const choice = await handleInterrupt();
          if (choice === "command") {
            const cmd = await readInterruptCommand();
            if (cmd) {
              state.messages.push(new HumanMessage({ content: `[打断后指令] ${cmd}` }));
              print(dim("已注入指令, 继续执行..."));
              continue;
            }
            print(dim("继续执行..."));
          } else if (choice === "resume") {
            print(dim("继续执行..."));
          } else {
            print(dim("任务已取消"));
            print();
            return;
          }
        }

        // 每步后检查 ask_user 挂起
        if (state.pending_question) break;
      }
    } catch (e) {
      print(`${red(bold("Error:"))} ${(e as Error).message}`);
      return;
    }

    // --- 汇总 (任务完成后的总 Token 消耗 + 耗时) ---
    if (sumTotal > 0) {
      print();
      const totalDur = fmtDuration(sumLlmMs + sumToolMs);
      const parts: string[] = [];
      parts.push(cyan(`📊 总消耗: Token ${fmtNum(sumInput)}↑ / ${fmtNum(sumOutput)}↓ / 共 ${fmtNum(sumTotal)}`));
      if (totalTools > 0) parts.push(yellow(`| 工具 ${totalTools} 次`));
      parts.push(magenta(`| 总耗时 ${totalDur}`));
      print(parts.join(" "));
    } else if (totalTools > 0) {
      print(dim(`共 ${totalTools} 次工具调用`));
    }

    // --- 检测 ask_user 挂起 ---
    const pending = state.pending_question;
    if (!pending) {
      print();
      break;
    }

    // 弹出交互式问题
    const answer = await renderAskUser(pending);
    if (answer === null) {
      state.pending_question = null;
      print(dim("用户取消了提问"));
      print();
      break;
    }

    // 注入回答, 继续外层循环
    state.messages.push(
      new ToolMessage({
        content: answer,
        tool_call_id: pending.tool_call_id,
        name: "ask_user",
      })
    );
    state.pending_question = null;
    print();
  }
}

export { STATUS_ICONS, formatPlan };
