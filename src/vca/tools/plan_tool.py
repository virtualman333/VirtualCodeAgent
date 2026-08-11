"""Plan/Todo 工具 - 让 Agent 制定并跟踪任务计划 (仿 Claude Code 的 TodoWrite)

Agent 的工作流:
1. `todo_create` 在任务开始时列出待办步骤
2. `todo_update` 在每步开始/完成时更新状态
3. 计划状态通过工具返回值 (ToolMessage) 进入消息历史, LLM 每轮都能看到当前进度
4. 控制台通过 get_current_plan() 实时展示计划面板
"""

from __future__ import annotations

from typing import Annotated

from langchain_core.tools import tool

# ---- 状态常量 ----
STATUS_PENDING = "pending"
STATUS_IN_PROGRESS = "in_progress"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"

_VALID_STATUS = {STATUS_PENDING, STATUS_IN_PROGRESS, STATUS_COMPLETED, STATUS_FAILED}

_STATUS_ICONS = {
    STATUS_PENDING: "🔲",
    STATUS_IN_PROGRESS: "🔄",
    STATUS_COMPLETED: "✅",
    STATUS_FAILED: "❌",
}


# ============================================================
# 计划存储 (模块级全局, 控制台单线程环境足够)
# ============================================================

_current_plan: list[dict] = []


def get_current_plan() -> list[dict]:
    """获取当前计划 (供控制台 / 渲染使用)"""
    return list(_current_plan)


def _set_plan(plan: list[dict]) -> None:
    """替换整个计划"""
    global _current_plan
    _current_plan = plan


def _format_plan(plan: list[dict]) -> str:
    """格式化计划为输出文本 (仿 CC TodoWrite)"""
    if not plan:
        return "**当前无计划**"
    lines = ["**任务计划:**"]
    for i, step in enumerate(plan, 1):
        icon = _STATUS_ICONS.get(step.get("status", STATUS_PENDING), "🔲")
        lines.append(f"{i}. {icon} {step.get('description', '')}")
    return "\n".join(lines)


def _update_step(index: int, status: str) -> str | None:
    """更新指定步骤状态, 返回错误信息或 None"""
    if not (1 <= index <= len(_current_plan)):
        return f"[ERROR] 步骤 {index} 不存在 (共 {len(_current_plan)} 步)"
    if status not in _VALID_STATUS:
        return f"[ERROR] 无效状态 '{status}'，可用: {', '.join(sorted(_VALID_STATUS))}"
    _current_plan[index - 1]["status"] = status
    return None


# ============================================================
# 工具定义
# ============================================================

@tool
def todo_create(todos: Annotated[list[str], "任务计划步骤列表，每项描述一个待办步骤"]) -> str:
    """
    创建/替换当前任务计划 (Todo List)。

    在开始执行多步任务前必须调用，将任务分解为清晰的待办步骤。
    之后每完成一步用 todo_update 更新状态。

    Args:
        todos: 计划步骤列表，例如 ["创建项目结构", "实现核心功能", "编写测试"]

    Returns:
        格式化后的完整计划 (包含当前状态)
    """
    plan = [{"description": t, "status": STATUS_PENDING} for t in todos]
    _set_plan(plan)
    return _format_plan(plan)


@tool
def todo_update(
    index: Annotated[int, "要更新的步骤编号 (从 1 开始)"],
    status: Annotated[str, "新状态: pending / in_progress / completed / failed"],
) -> str:
    """
    更新任务计划中某一步的状态。

    每个步骤开始执行前设为 in_progress，完成后设为 completed，
    执行失败设为 failed。

    Args:
        index: 步骤编号 (从 1 开始)
        status: 新状态 (pending / in_progress / completed / failed)

    Returns:
        更新后的完整计划
    """
    err = _update_step(index, status)
    if err:
        return err
    return _format_plan(_current_plan)


@tool
def todo_list() -> str:
    """
    查看当前任务计划的完整状态。

    在任何时候调用以查看还有哪些步骤待完成、哪些已完成。

    Returns:
        当前计划及每步状态
    """
    return _format_plan(_current_plan)


# 工具注册
PLAN_TOOLS = [todo_create, todo_update, todo_list]
