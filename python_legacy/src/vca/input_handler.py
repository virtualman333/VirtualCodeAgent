"""交互输入模块 - 基于 prompt_toolkit 的 Tab 补全/历史记录/自动建议"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

from prompt_toolkit import PromptSession
from prompt_toolkit.auto_suggest import AutoSuggestFromHistory
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.history import FileHistory
from prompt_toolkit.styles import Style

from .config import VCA_DIR

# ============================================================
# 命令定义
# ============================================================

# 内置命令 (无参数)
COMMANDS = [
    "help", "clear", "workspace", "verbose",
    "new", "history", "save", "skills", "mcp",
    "todo", "agents", "config", "exit",
]

# 带参数的命令
ARG_COMMANDS = {
    "cd": "<路径> - 切换工作空间，如 /cd ~/my-project",
    "load": "<编号> - 恢复历史会话，如 /load 3",
    "config": "set <KEY> <VALUE> - 修改配置，如 /config set OPENAI_MODEL gpt-4o",
}

# 可编辑配置项
CONFIG_KEYS = [
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
    "WORKSPACE_DIR", "MAX_TOOL_ITERATIONS", "MAX_CONTEXT_TOKENS",
]


# ============================================================
# 历史记录
# ============================================================

_HISTORY_FILE = VCA_DIR / "input_history"


def _get_history() -> FileHistory:
    """获取文件历史记录"""
    VCA_DIR.mkdir(parents=True, exist_ok=True)
    return FileHistory(str(_HISTORY_FILE))


# ============================================================
# 补全器
# ============================================================

class VCACompleter(Completer):
    """自定义补全器: 命令 / 命令参数 / 工作空间路径"""

    def __init__(self, get_workspace: Callable[[], str]) -> None:
        self._get_workspace = get_workspace

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor

        # 1. Tab 为空 / 非命令 → 补全命令 (以 / 开头)
        if not text.startswith("/"):
            # 空输入或普通文本: 只建议命令
            if not text:
                for cmd in COMMANDS:
                    yield Completion("/" + cmd, start_position=0, display_meta="命令")
                return

            # 输入了部分命令文本 (如 "help" → 建议 /help)
            prefix = text
            for cmd in COMMANDS:
                if cmd.startswith(prefix) or prefix.startswith(cmd):
                    yield Completion("/" + cmd, start_position=-len(prefix), display_meta="命令")
            return

        # 2. 以 / 开头 → 补全命令
        rest = text[1:]
        parts = rest.split()

        # 仅输入了 "/" → 补全所有命令
        if len(parts) == 0:
            for cmd in COMMANDS:
                yield Completion("/" + cmd, start_position=-1, display_meta="命令")
            return

        cmd_part = parts[0]

        # split() 会吞掉尾随空格, 所以单独检测原始文本
        has_trailing_space = text.endswith(" ")
        has_arg = len(parts) > 1 or has_trailing_space
        # 命令名匹配: 包括无参命令 (COMMANDS) 和带参命令 (ARG_COMMANDS)
        cmd_matched = cmd_part in COMMANDS or cmd_part in ARG_COMMANDS

        if has_arg and cmd_matched:
            # 3. 完整命令 + 已有参数位置 → 补全参数
            arg_prefix = parts[1] if len(parts) > 1 else ""

            if cmd_part == "cd":
                # 补全目录路径
                yield from self._complete_path(arg_prefix, document.cursor_position)
            elif cmd_part == "load":
                # 补全历史会话编号
                from . import storage
                sessions = storage.list_sessions()
                for i, s in enumerate(sessions, 1):
                    label = f"{i} · {s.get('title', '')[:20]}"
                    num = str(i)
                    if num.startswith(arg_prefix):
                        yield Completion(
                            num,
                            start_position=-len(arg_prefix),
                            display_meta=label,
                        )
            elif cmd_part == "config" and (arg_prefix == "set" or arg_prefix.startswith("set ")):
                # /config set <KEY> [VALUE] → 补全配置项
                set_parts = rest.split()
                if len(set_parts) >= 3 or arg_prefix == "set":
                    key_part = set_parts[2] if len(set_parts) >= 3 else ""
                    for key in CONFIG_KEYS:
                        if key.startswith(key_part):
                            yield Completion(
                                key,
                                start_position=-len(key_part),
                                display_meta="配置项",
                            )
        elif cmd_matched:
            # 完整命令, 无参数位置 → 提示参数说明
            for cmd, meta in ARG_COMMANDS.items():
                if cmd == cmd_part:
                    yield Completion("", start_position=0, display_meta=f"参数: {meta}")
        else:
            # 命令名输入中 → 补全命令 (含带参命令, 去重)
            all_commands = list(dict.fromkeys(list(COMMANDS) + list(ARG_COMMANDS.keys())))
            for cmd in all_commands:
                if cmd.startswith(cmd_part):
                    meta = ARG_COMMANDS.get(cmd, "命令")
                    yield Completion(
                        "/" + cmd,
                        start_position=-len("/" + cmd_part),
                        display_meta=meta,
                    )

    def _complete_path(self, prefix: str, cursor_pos: int) -> None:
        """补全文件系统路径"""
        base = self._get_workspace() or os.getcwd()

        # 处理 ~ 展开
        if prefix.startswith("~"):
            expanded_prefix = os.path.expanduser(prefix)
        else:
            expanded_prefix = prefix

        # 找到补全的基础目录
        if expanded_prefix:
            dir_part = os.path.dirname(expanded_prefix)
            file_part = os.path.basename(expanded_prefix)
        else:
            dir_part = ""
            file_part = ""

        search_dir = os.path.join(base, dir_part) if dir_part else base
        if not os.path.isdir(search_dir):
            search_dir = base
            file_part = expanded_prefix

        try:
            items = sorted(os.listdir(search_dir))
        except OSError:
            return

        # 支持绝对路径 (用户输入 / 或 C:\ 时)
        if os.path.isabs(expanded_prefix):
            search_dir = dir_part or os.path.abspath(os.sep)
            if search_dir and not os.path.isdir(search_dir):
                return
            try:
                items = sorted(os.listdir(search_dir))
            except OSError:
                return

        for item in items:
            if not item.startswith(file_part):
                continue
            full = os.path.join(search_dir, item)
            display = item
            if os.path.isdir(full):
                display += os.sep
                completion = display
            else:
                completion = display

            # 展示相对路径
            rel = os.path.relpath(full, base)
            yield Completion(
                completion,
                start_position=-len(file_part),
                display_meta="目录" if os.path.isdir(full) else "文件",
            )


# ============================================================
# 输入会话
# ============================================================

_STYLE = Style.from_dict(
    {
        "completion-menu.completion": "bg:#008888 #ffffff",
        "completion-menu.completion.current": "bg:#00aaaa #000000",
        "completion-menu.meta.completion": "bg:#004444 #ffffff",
        "completion-menu.meta.completion.current": "bg:#00aaaa #000000",
    }
)


def create_input_session(get_workspace: Callable[[], str]) -> PromptSession:
    """创建带补全/历史/自动建议的输入会话"""
    return PromptSession(
        history=_get_history(),
        completer=VCACompleter(get_workspace),
        complete_while_typing=False,   # 只在按 Tab 时补全
        auto_suggest=AutoSuggestFromHistory(),  # → 灰色建议上次输入
        enable_history_search=True,    # ↑/↓ 历史搜索
        style=_STYLE,
        mouse_support=False,
    )


def format_prompt(workspace_dir: str, window_no: int, verbose: bool):
    """
    格式化输入提示符。

    注意: 这里用的是 prompt_toolkit 的 HTML 格式化文本,
    不是 Rich 的 [...] markup — 两者语法不同, 混用会显示原始标签。
    """
    from prompt_toolkit.formatted_text import HTML

    ws_name = os.path.basename(workspace_dir) or workspace_dir
    mode = " <ansibrightyellow>D</ansibrightyellow>" if verbose else ""
    return HTML(
        f"<ansicyan><b>{ws_name}</b></ansicyan>"
        f" <ansibrightblack>#{window_no}</ansibrightblack>{mode} > "
    )
