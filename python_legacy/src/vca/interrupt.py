"""Agent 执行期间的输入中断 - 打断后交互菜单

设计 (Claude Code / Copilot CLI 模式):
- Agent 流式执行期间按 Ctrl+C 立即打断
- 打断后弹出交互菜单: 继续 / 输入新指令 / 取消
- 输入的新指令注入上下文后重新驱动 Agent
"""

from __future__ import annotations

from enum import Enum

from prompt_toolkit import PromptSession
from prompt_toolkit.formatted_text import HTML

from .ui import console


class InterruptChoice(Enum):
    RESUME = "resume"         # 继续执行
    COMMAND = "command"       # 输入新指令后继续
    CANCEL = "cancel"         # 取消 (结束当前任务)


def handle_interrupt() -> InterruptChoice:
    """
    处理打断后的用户选择。

    Returns:
        InterruptChoice.RESUME   - 继续执行
        InterruptChoice.COMMAND  - 输入新指令后继续
        InterruptChoice.CANCEL   - 取消任务
    """
    console.print()
    console.print("[yellow]⚠ 已打断当前执行[/yellow]")
    console.print()

    session = PromptSession(enable_history_search=False)

    while True:
        try:
            choice = session.prompt(
                HTML(
                    "<ansiyellow><b>⏸ 选择操作</b></ansiyellow> "
                    "(<ansibrightblack>1</ansibrightblack>继续 "
                    "<ansibrightblack>2</ansibrightblack>输入指令 "
                    "<ansibrightblack>3</ansibrightblack>取消): "
                )
            ).strip().lower()
        except (KeyboardInterrupt, EOFError):
            return InterruptChoice.CANCEL

        if choice in ("1", "continue", "c", ""):
            return InterruptChoice.RESUME
        if choice in ("2", "command", "in", "i"):
            return InterruptChoice.COMMAND
        if choice in ("3", "cancel", "stop", "quit", "exit", "x"):
            return InterruptChoice.CANCEL
        console.print("[red]无效选择[/red] (1=继续 2=输入指令 3=取消)")


def read_interrupt_command() -> str | None:
    """
    读取用户输入的指令。

    Returns:
        指令文本, 或 None (用户取消)
    """
    session = PromptSession(enable_history_search=False)
    try:
        text = session.prompt(
            HTML("<ansiyellow><b>✍ 输入指令</b></ansiyellow>: ")
        ).strip()
    except (KeyboardInterrupt, EOFError):
        return None

    if not text:
        console.print("[dim]空指令, 忽略[/dim]")
        return None
    return text
