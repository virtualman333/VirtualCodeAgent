"""AskUser 工具 - 让 LLM 向用户提问"""

from __future__ import annotations

from langchain_core.tools import tool


@tool
def ask_user(
    question: str,
    header: str = "",
    options: str = "",
) -> str:
    """
    向用户提问以澄清模糊信息或确认关键决策。

    当你遇到以下情况时使用此工具：
    - 用户的指令模糊，有多种可能的理解方式
    - 需要确认文件路径、命名约定、技术选型等
    - 执行不可逆操作前需要用户确认
    - 遇到需要用户做出选择的场景（如选择哪个依赖版本）
    - 不确定用户期望的结果格式或风格

    不要滥用：只在确实需要时才提问，能自行判断的就不问。

    Args:
        question: 向用户提出的具体问题（尽量清晰具体）
        header: 问题的简短标题（可选，如 "确认路径"、"选择模式"）
        options: 预设选项，用 | 分隔。如 "React|Vue|Angular" 提供单选，
                 如 "[可多选] Git|Linter|TypeScript|Docker" 提供多选。
                 留空则允许用户自由输入。

    Returns:
        用户的回答文本
    """
    # 这个函数体永远不会被真正执行 —— 由工作流特殊节点拦截
    # 保留这个函数体作为 fallback 和文档
    return "[AWAITING_USER_INPUT]"
