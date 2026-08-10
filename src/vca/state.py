"""Agent 状态定义 - LangGraph 的状态管理"""

from __future__ import annotations

from typing import Annotated, Any, TypedDict
from operator import add
from langchain_core.messages import BaseMessage


class PlanStep(TypedDict):
    """计划中的一个步骤"""
    description: str
    tool_name: str | None
    tool_args: dict[str, Any] | None
    status: str  # pending | running | done | failed


class AgentState(TypedDict):
    """
    LangGraph Agent 的全局状态。

    通过 TypedDict + Annotated 定义 reducer:
    - messages 使用 add 合并，实现消息累积
    - 其他字段直接覆盖 (默认 reducer)
    """
    # 消息历史 (自动累积)
    messages: Annotated[list[BaseMessage], add]

    # 当前执行计划
    plan: list[PlanStep]

    # 当前步骤索引
    current_step: int

    # 工具执行结果
    tool_results: list[dict[str, Any]]

    # 迭代计数器 (防止无限循环)
    iteration: int

    # 最终响应
    final_response: str

    # 工作空间路径
    workspace_dir: str

    # --- AskUser 挂起字段 ---
    # 当 LLM 调用 ask_user 时，挂起问题详情
    # 格式: {"header": "...", "question": "...", "options": "...", "is_multi": bool, "tool_call_id": "..."}
    # None 表示无挂起问题
    pending_question: dict[str, Any] | None

    # --- 上下文裁剪摘要 ---
    # 当对话超长被裁剪时，LLM 生成的语义摘要（累积）
    summary_history: str


def create_initial_state(workspace_dir: str) -> AgentState:
    """创建初始状态"""
    return AgentState(
        messages=[],
        plan=[],
        current_step=0,
        tool_results=[],
        iteration=0,
        final_response="",
        workspace_dir=workspace_dir,
        pending_question=None,
        summary_history="",
    )
