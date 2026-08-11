"""历史会话 UI 辅助"""

from __future__ import annotations

import os
from pathlib import Path

from rich import box
from rich.table import Table

from . import storage
from .state import AgentState
from .ui import console


def _find_window_no(session_id: str | None) -> int:
    """根据 session_id 计算窗口序号（历史列表位置+1）"""
    sessions = storage.list_sessions()
    if not session_id:
        return len(sessions) + 1
    for i, s in enumerate(sessions):
        if s.get("id") == session_id:
            return i + 1
    return len(sessions) + 1


def _shorten_path(path: str, limit: int = 40) -> str:
    """缩短路径显示"""
    home = str(Path.home())
    if path.startswith(home):
        return "~" + path[len(home):]
    if len(path) > limit:
        return "..." + path[-(limit - 3):]
    return path


def _show_history() -> None:
    """显示历史会话列表"""
    sessions = storage.list_sessions()
    if not sessions:
        console.print("[dim]暂无历史对话记录[/dim]")
        return

    table = Table(title="对话历史记录", box=box.ROUNDED)
    table.add_column("#", style="cyan", width=3)
    table.add_column("时间", style="dim", width=18)
    table.add_column("标题", style="white", width=40)
    table.add_column("消息数", justify="right", width=8)
    table.add_column("工作空间", style="dim")

    for i, s in enumerate(sessions, 1):
        table.add_row(
            str(i),
            s.get("updated_at", ""),
            s.get("title", "")[:40],
            str(s.get("message_count", 0)),
            _shorten_path(s.get("workspace", "")),
        )

    console.print(table)
    console.print(
        f"[dim]共 {len(sessions)} 条记录 | 使用 /load <编号> 恢复 | "
        "删除需手动清理 ~/.vca/sessions/[/dim]"
    )


def _apply_loaded_session(state: AgentState, loaded: dict, title: str, count: int) -> None:
    """将加载的会话应用到 state"""
    state["messages"] = loaded.get("messages", [])
    old_ws = loaded.get("workspace_dir", "")
    if old_ws and os.path.isdir(old_ws):
        state["workspace_dir"] = old_ws
    console.print(
        f"[green]✓ 已恢复会话: {title} ({count} 条消息)[/green]"
    )


def _load_session_by_index(
    index_str: str, state: AgentState, workspace_dir: str, current_sid: str | None
) -> None:
    """按编号加载历史会话"""
    sessions = storage.list_sessions()
    try:
        idx = int(index_str) - 1
        if idx < 0 or idx >= len(sessions):
            console.print(f"[red]无效编号，请输入 1-{len(sessions)}[/red]")
            return
    except ValueError:
        console.print(f"[red]无效编号: {index_str}[/red]")
        return

    sid = sessions[idx]["id"]
    loaded = storage.load_session(sid)
    if not loaded:
        console.print(f"[red]会话加载失败: {sid}[/red]")
        return

    # 当前对话先保存
    if current_sid or state.get("messages", []):
        storage.auto_save(state, current_sid)

    _apply_loaded_session(
        state, loaded,
        title=sessions[idx].get("title", "未命名"),
        count=sessions[idx].get("message_count", 0),
    )


def _load_last_session(state: AgentState) -> str | None:
    """加载最近一次会话，返回 session_id"""
    sessions = storage.list_sessions(1)
    if not sessions:
        console.print("[dim]暂无历史对话记录[/dim]")
        return None

    sid = sessions[0]["id"]
    loaded = storage.load_session(sid)
    if not loaded:
        console.print("[red]会话加载失败[/red]")
        return None

    _apply_loaded_session(
        state, loaded,
        title=sessions[0].get("title", "未命名"),
        count=sessions[0].get("message_count", 0),
    )
    return sid
