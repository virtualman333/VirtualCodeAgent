/**
 * Agent 状态定义 - LangGraph 的状态管理
 */
import { Annotation } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

export interface PlanStep {
  description: string;
  status: string; // pending | in_progress | done | failed
}

export interface PendingQuestion {
  header: string;
  question: string;
  options: string[];
  is_multi: boolean;
  tool_call_id: string;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  duration_ms: number;
}

export interface ToolUsage {
  count: number;
  duration_ms: number;
}

export interface AgentState {
  messages: BaseMessage[];
  plan: PlanStep[];
  current_step: number;
  tool_results: Record<string, unknown>[];
  iteration: number;
  final_response: string;
  workspace_dir: string;
  pending_question: PendingQuestion | null;
  summary_history: string;
  llm_usage: LlmUsage | null;
  tool_usage: ToolUsage | null;
  session_id?: string;
}

/**
 * LangGraph 状态注解。
 * - messages 使用 concat reducer 累积
 * - 其他字段默认覆盖
 */
const overwrite = <T>(defaultValue: () => T) => ({
  reducer: (_current: T, updated: T) => updated,
  default: defaultValue,
});

export const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  plan: Annotation<PlanStep[]>(overwrite<PlanStep[]>(() => [])),
  current_step: Annotation<number>(overwrite<number>(() => 0)),
  tool_results: Annotation<Record<string, unknown>[]>(overwrite<Record<string, unknown>[]>(() => [])),
  iteration: Annotation<number>(overwrite<number>(() => 0)),
  final_response: Annotation<string>(overwrite<string>(() => "")),
  workspace_dir: Annotation<string>(overwrite<string>(() => "")),
  pending_question: Annotation<PendingQuestion | null>(overwrite<PendingQuestion | null>(() => null)),
  summary_history: Annotation<string>(overwrite<string>(() => "")),
  llm_usage: Annotation<LlmUsage | null>(overwrite<LlmUsage | null>(() => null)),
  tool_usage: Annotation<ToolUsage | null>(overwrite<ToolUsage | null>(() => null)),
});

export function createInitialState(workspaceDir: string): AgentState {
  return {
    messages: [],
    plan: [],
    current_step: 0,
    tool_results: [],
    iteration: 0,
    final_response: "",
    workspace_dir: workspaceDir,
    pending_question: null,
    summary_history: "",
    llm_usage: null,
    tool_usage: null,
    session_id: undefined,
  };
}
