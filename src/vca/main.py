"""控制台入口 - 编码 Agent 的交互式 CLI 主入口"""

from __future__ import annotations

import argparse
import os
import sys

from langchain_core.messages import SystemMessage
from rich.panel import Panel

from . import storage
from .agent_runner import run_agent
from .config import Config
from .graph.workflow import create_coding_agent
from .history import (
    _find_window_no,
    _load_last_session,
    _load_session_by_index,
    _show_history,
)
from .state import create_initial_state
from .ui import (
    console,
    _show_agents,
    _show_mcp,
    _show_skills,
    show_banner,
    show_config_info,
    show_help,
    show_workspace_info,
)
from .workspace import select_workspace, switch_workspace

# ============================================================
# 命令行参数
# ============================================================

def parse_args() -> argparse.Namespace:
    """解析命令行参数"""
    parser = argparse.ArgumentParser(
        prog="vca",
        description="Virtual Code Agent - 基于 LangGraph 的控制台编码助手",
    )
    parser.add_argument(
        "workspace",
        nargs="?",
        default=None,
        help="工作空间/项目目录路径（如 /path/to/my-project）",
    )
    parser.add_argument(
        "-w", "--workspace",
        dest="workspace_flag",
        default=None,
        help="工作空间路径（与位置参数等价）",
    )
    parser.add_argument(
        "--list-workspaces",
        action="store_true",
        help="列出最近使用过的工作空间",
    )
    return parser.parse_args()


# ============================================================
# 初始化流程
# ============================================================

def _init_agent() -> None:
    """初始化 Agent"""
    console.print("[dim]正在初始化 Agent...[/dim]")
    try:
        return create_coding_agent()
    except Exception as e:
        console.print(f"[red]Agent 初始化失败: {e}[/red]")
        sys.exit(1)


def _restore_session(state, workspace_dir: str, ws_explicit: bool) -> tuple[str | None, str]:
    """自动恢复上次会话，返回 (session_id, workspace_dir)"""
    session_id: str | None = None
    last_session = storage.get_last_session()
    if not last_session or not last_session.get("messages"):
        return session_id, workspace_dir

    last_ws = last_session.get("workspace_dir", "")
    # 仅当用户未显式选择工作空间时，才沿用上次会话的工作空间
    if not ws_explicit and last_ws and os.path.isdir(last_ws):
        workspace_dir = last_ws
    state["workspace_dir"] = workspace_dir
    state["messages"] = last_session.get("messages", [])

    sessions = storage.list_sessions(1)
    if sessions:
        session_id = sessions[0]["id"]

    console.print(
        f"[green]↺ 已自动恢复上次对话[/green] "
        f"[dim]「{last_session.get('title', '未命名')}」"
        f"({len(last_session['messages'])} 条消息) | 工作空间: {workspace_dir}[/dim]"
    )
    return session_id, workspace_dir


def _refresh_system_prompt(state, workspace_dir: str) -> None:
    """切换工作空间后重新注入 system prompt"""
    from .graph.workflow import make_system_prompt

    for msg in state["messages"]:
        if isinstance(msg, SystemMessage) and "工作空间" in msg.content:
            state["messages"].remove(msg)
            break
    state["messages"].insert(
        0, SystemMessage(content=make_system_prompt(workspace_dir))
    )


# ============================================================
# 命令分发
# ============================================================

def _format_todo_list(plan: list[dict]) -> str:
    """将 plan 数据结构格式化为文本 (供 /todo 命令渲染)"""
    from .tools.plan_tool import _STATUS_ICONS

    lines = ["**任务计划:**"]
    for i, step in enumerate(plan, 1):
        icon = _STATUS_ICONS.get(step.get("status", "pending"), "🔲")
        lines.append(f"{i}. {icon} {step.get('description', '')}")
    return "\n".join(lines)


_EDITABLE_KEYS = {
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
    "WORKSPACE_DIR", "MAX_TOOL_ITERATIONS", "MAX_CONTEXT_TOKENS",
}


def _set_config_value(key: str, value: str) -> None:
    """通过 /config set 修改配置"""
    if key not in _EDITABLE_KEYS:
        console.print(
            f"[red]无效配置项: {key}[/red]\n"
            f"[dim]可用: {', '.join(sorted(_EDITABLE_KEYS))}[/dim]"
        )
        return

    try:
        if key in ("MAX_TOOL_ITERATIONS", "MAX_CONTEXT_TOKENS"):
            value = str(int(value))  # 数值校验
        Config.set(key, value)
        console.print(f"[green]✓ 已更新 {key}: {value}[/green]")
        console.print("[dim]部分配置需重启后完全生效[/dim]")
    except ValueError:
        console.print(f"[red]{key} 需要整数值[/red]")


def _handle_command(
    cmd: str,
    user_input: str,
    state,
    session_id: str | None,
    workspace_dir: str,
    verbose: bool,
    window_no: int,
) -> tuple[str | None, str, bool, int]:
    """处理斜杠命令。返回 (session_id, workspace_dir, verbose, window_no)"""
    if cmd == "/exit":
        if session_id or state.get("messages", []):
            sid = storage.auto_save(state, session_id)
            console.print(f"[dim]对话已自动保存 ({sid})[/dim]")
        console.print("[yellow]再见![/yellow]")
        sys.exit(0)

    elif cmd == "/help":
        show_help(verbose=verbose)

    elif cmd == "/new":
        if session_id or state.get("messages", []):
            sid = storage.auto_save(state, session_id)
            console.print(f"[dim]当前对话已保存 ({sid})[/dim]")
        state["messages"] = []
        state["pending_question"] = None
        session_id = None
        window_no = len(storage.list_sessions()) + 1
        console.print(
            f"[green]✓ 已开启新对话窗口 #{window_no}[/green] "
            f"[dim](输入 /load 可切回历史窗口)[/dim]"
        )

    elif cmd == "/clear":
        state["messages"] = []
        state["pending_question"] = None
        session_id = None
        console.print("[green]对话历史已清除[/green]")

    elif cmd == "/workspace":
        show_workspace_info(workspace_dir, verbose=True)

    elif cmd == "/verbose":
        verbose = not verbose
        mode_label = "[green]详细模式[/green]" if verbose else "[dim]精简模式[/dim]"
        console.print(f"{mode_label}: 深度思考已{'展开' if verbose else '折叠'}")

    elif cmd == "/cd":
        new_ws = switch_workspace(user_input, workspace_dir)
        if new_ws:
            workspace_dir = new_ws
            state["workspace_dir"] = new_ws
            _refresh_system_prompt(state, new_ws)

    elif cmd == "/config":
        # 支持 /config set <KEY> <VALUE> 修改配置
        parts = user_input.split()
        if len(parts) >= 4 and parts[1] == "set":
            key, value = parts[2], " ".join(parts[3:])
            _set_config_value(key, value)
        else:
            show_config_info(workspace_dir)

    elif cmd == "/skills":
        _show_skills()

    elif cmd == "/mcp":
        _show_mcp()

    elif cmd == "/todo":
        from .tools.plan_tool import get_current_plan

        plan = get_current_plan()
        if not plan:
            console.print("[dim]当前无计划 (Agent 在多步任务时会自动创建)[/dim]")
        else:
            from .agent_runner import _render_plan_tool
            _render_plan_tool(
                type("M", (), {"content": _format_todo_list(plan), "name": "todo_list"})(),
                verbose,
            )

    elif cmd == "/agents":
        _show_agents()

    elif cmd == "/history":
        _show_history()

    elif cmd == "/save":
        session_id = storage.auto_save(state, session_id)
        console.print(f"[green]✓ 对话已保存 ({session_id})[/green]")

    elif cmd == "/load":
        parts = user_input.split(maxsplit=1)
        index_str = parts[1].strip() if len(parts) > 1 else ""
        if index_str:
            _load_session_by_index(index_str, state, workspace_dir, session_id)
        else:
            sid = _load_last_session(state)
            if sid:
                session_id = sid
                workspace_dir = state["workspace_dir"]
        window_no = _find_window_no(session_id)

    else:
        console.print(f"[red]未知命令: {user_input}[/red]")

    return session_id, workspace_dir, verbose, window_no


# ============================================================
# 主入口
# ============================================================

def main() -> None:
    """主入口"""
    args = parse_args()

    # 仅列出历史记录
    if args.list_workspaces:
        history = Config.get_workspace_history()
        if history:
            console.print("[bold]最近使用的工作空间:[/bold]")
            for i, p in enumerate(history, 1):
                console.print(f"  {i}. {p}")
        else:
            console.print("[dim]暂无历史记录[/dim]")
        return

    # 1. 验证配置
    if not Config.validate():
        from .config import CONFIG_FILE
        console.print(f"[red]请在配置文件中填入你的 API Key: {CONFIG_FILE}[/red]")
        sys.exit(1)

    # 2. 选择工作空间
    cli_path = args.workspace or args.workspace_flag
    workspace_dir, ws_explicit = select_workspace(cli_path)

    # 3. 创建 Agent
    agent = _init_agent()

    # 4. 初始状态 + 自动恢复
    state = create_initial_state(workspace_dir)
    session_id, workspace_dir = _restore_session(state, workspace_dir, ws_explicit)

    # 5. 显示界面
    console.clear()
    show_banner()

    verbose = False
    window_no = len(storage.list_sessions()) + 1

    console.print(
        Panel(
            f"工作空间: [cyan]{workspace_dir}[/cyan]\n"
            f"当前窗口: [bold magenta]#{window_no}[/bold magenta]\n\n"
            "输入编程任务，Agent 将自动完成。\n"
            "输入 [cyan]/help[/cyan] 查看可用命令，[cyan]/cd <路径>[/cyan] 切换项目。\n"
            "[cyan]/new[/cyan] 开启新对话窗口。",
            title="[bold]就绪[/bold]",
            border_style="green",
        )
    )
    console.print()

    # 6. 主事件循环
    while True:
        ws_name = os.path.basename(workspace_dir) or workspace_dir
        prompt = f"[bold cyan]{ws_name}[/bold cyan] [dim]#{window_no}[/dim] > "

        try:
            user_input = console.input(prompt).strip()
        except (KeyboardInterrupt, EOFError):
            if session_id or state.get("messages", []):
                sid = storage.auto_save(state, session_id)
                console.print(f"\n[dim]对话已自动保存 ({sid})[/dim]")
            console.print("[yellow]再见![/yellow]")
            break

        if not user_input:
            continue

        # 处理命令
        if user_input.startswith("/"):
            cmd = user_input.lower().split()[0]
            session_id, workspace_dir, verbose, window_no = _handle_command(
                cmd, user_input, state, session_id, workspace_dir, verbose, window_no
            )
            console.print()
            continue

        # 运行 Agent
        run_agent(agent, state, user_input, verbose=verbose)
        # 每次交互后自动保存
        session_id = storage.auto_save(state, session_id)
        console.print()


if __name__ == "__main__":
    main()
