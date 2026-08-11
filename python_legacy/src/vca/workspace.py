"""工作空间选择与切换"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from rich.panel import Panel
from rich.prompt import Confirm, Prompt

from .config import Config
from .ui import console, show_banner


def _format_path(path: str) -> str:
    """格式化路径显示：子目录用相对路径，否则用 ~ 缩写"""
    cwd = os.getcwd()
    try:
        rel = os.path.relpath(path, cwd)
        if not rel.startswith(".."):
            return f"[dim]./{rel}[/dim]"
    except ValueError:
        pass

    home = str(Path.home())
    if path.startswith(home):
        return f"[dim]~{path[len(home):]}[/dim]"

    return f"[dim]{path}[/dim]"


def _prompt_manual_path() -> str | None:
    """手动输入路径，返回绝对路径或 None(取消)"""
    while True:
        try:
            manual = Prompt.ask("请输入工作空间路径").strip()
        except (KeyboardInterrupt, EOFError):
            console.print()
            return None

        if not manual:
            continue

        expanded = os.path.expanduser(manual)
        if not os.path.isabs(expanded):
            expanded = os.path.abspath(expanded)

        if os.path.exists(expanded) and os.path.isdir(expanded):
            return expanded

        # 目录不存在，询问是否创建
        if Confirm.ask(
            f"目录 [yellow]{expanded}[/yellow] 不存在，是否创建？",
            default=True,
        ):
            os.makedirs(expanded, exist_ok=True)
            return expanded


def select_workspace(cli_path: str | None = None) -> tuple[str, bool]:
    """
    交互式选择工作空间。

    Returns:
        (工作空间绝对路径, 是否用户显式选择)
        explicit=True  用户明确指定了路径 (CLI参数/手动输入/历史/当前目录)
        explicit=False 使用了默认工作空间
    """
    # 命令行指定了路径 → 直接使用 (显式)
    if cli_path:
        resolved = Config.resolve_workspace(cli_path)
        Config.add_workspace_to_history(resolved)
        return resolved, True

    # 交互式选择
    console.clear()
    show_banner()

    history = Config.get_workspace_history()
    default_ws = os.path.abspath(Config.WORKSPACE_DIR)
    option_map: dict[str, str] = {}

    console.print()
    console.print(
        Panel(
            "[bold]请选择工作空间[/bold]\n\n"
            "工作空间是 Agent 操作文件、运行命令的根目录。\n"
            "可以选择现有项目目录，或使用默认工作空间。",
            title="📂 工作空间",
            border_style="cyan",
        )
    )
    console.print()

    # --- 历史记录 ---
    if history:
        console.print("[bold]最近使用:[/bold]")
        for i, p in enumerate(history, 1):
            key = str(i)
            option_map[key] = p
            console.print(f"  [cyan]{key}[/cyan]. {_format_path(p)}")
        console.print()

    # --- 固定选项 ---
    idx = len(history) + 1

    key_cwd = str(idx)
    option_map[key_cwd] = os.getcwd()
    console.print(f"  [cyan]{key_cwd}[/cyan]. 当前目录: {_format_path(os.getcwd())}")
    idx += 1

    key_default = str(idx)
    option_map[key_default] = default_ws
    console.print(f"  [cyan]{key_default}[/cyan]. 默认工作空间: {_format_path(default_ws)}")
    idx += 1

    key_manual = str(idx)
    console.print(f"  [cyan]{key_manual}[/cyan]. 手动输入路径")
    console.print()

    # --- 用户选择 ---
    default_choice = "1" if option_map else str(idx - 1)
    while True:
        try:
            choice = Prompt.ask("输入编号", default=default_choice).strip()
        except (KeyboardInterrupt, EOFError):
            console.print("\n[yellow]已取消[/yellow]")
            sys.exit(0)

        mapped = option_map.get(choice)

        if mapped:
            resolved = Config.resolve_workspace(mapped)
            Config.add_workspace_to_history(resolved)
            console.print(f"\n[green]✓ 工作空间: {resolved}[/green]\n")
            # 选"默认工作空间"视为非显式 (可被上次会话工作空间覆盖)
            return resolved, choice == key_default

        if choice == key_manual:
            manual_path = _prompt_manual_path()
            if manual_path:
                Config.add_workspace_to_history(manual_path)
                console.print(f"\n[green]✓ 工作空间: {manual_path}[/green]\n")
                return manual_path, True

        console.print(f"[red]无效选项: {choice}[/red]")


def switch_workspace(command: str, current_ws: str) -> str | None:
    """解析 /cd 命令，切换工作空间。返回新路径，或 None(不变/取消)。"""
    parts = command.split(maxsplit=1)
    if len(parts) < 2:
        console.print("[yellow]用法: /cd <路径>[/yellow]")
        return None

    target = parts[1].strip()

    # 特殊值
    specials = {
        "~": str(Path.home()),
        ".": os.getcwd(),
        "..": os.path.dirname(current_ws),
    }
    resolved = specials.get(target, target)

    if not os.path.isabs(resolved):
        resolved = os.path.abspath(resolved)

    if not os.path.exists(resolved):
        console.print(f"[red]目录不存在: {resolved}[/red]")
        if Confirm.ask("是否创建此目录？", default=True):
            os.makedirs(resolved, exist_ok=True)
        else:
            return None
    elif not os.path.isdir(resolved):
        console.print(f"[red]路径不是目录: {resolved}[/red]")
        return None

    Config.add_workspace_to_history(resolved)
    console.print(f"[green]✓ 工作空间已切换: {resolved}[/green]")
    return resolved
