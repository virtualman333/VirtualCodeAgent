"""控制台入口 - 编码 Agent 的交互式 CLI"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from rich.console import Console
from rich.panel import Panel
from rich.markdown import Markdown
from rich.table import Table
from rich.prompt import Prompt, Confirm
from rich import box
from rich.text import Text
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage

from .config import Config
from .state import create_initial_state, AgentState
from .graph.workflow import create_coding_agent

# ============================================================
# 控制台
# ============================================================

console = Console()


# ============================================================
# 解析命令行参数
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
# 工作空间选择
# ============================================================

def select_workspace(cli_path: str | None = None) -> str:
    """
    交互式选择工作空间。
    
    优先级:
    1. 命令行参数指定的路径
    2. 用户交互选择
    """
    # 命令行指定了路径 → 直接使用
    if cli_path:
        resolved = Config.resolve_workspace(cli_path)
        Config.add_workspace_to_history(resolved)
        return resolved

    # 交互式选择
    console.clear()
    show_banner()

    history = Config.get_workspace_history()
    default_ws = os.path.abspath(Config.WORKSPACE_DIR)

    # 构建选项
    options: list[tuple[str, str, str]] = []
    # 选项编号 -> 路径
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
            display = _format_path(p)
            option_map[key] = p
            console.print(f"  [cyan]{key}[/cyan]. {display}")
        console.print()

    # --- 固定选项 ---
    idx = len(history) + 1

    # 当前目录
    cwd = os.getcwd()
    key_cwd = str(idx)
    option_map[key_cwd] = cwd
    console.print(f"  [cyan]{key_cwd}[/cyan]. 当前目录: {_format_path(cwd)}")
    idx += 1

    # 默认 workspace
    key_default = str(idx)
    option_map[key_default] = default_ws
    console.print(f"  [cyan]{key_default}[/cyan]. 默认工作空间: {_format_path(default_ws)}")
    idx += 1

    # 手动输入
    key_manual = str(idx)
    console.print(f"  [cyan]{key_manual}[/cyan]. 手动输入路径")
    console.print()

    # --- 用户选择 ---
    default_choice = "1" if option_map else str(idx - 1)
    while True:
        try:
            choice = Prompt.ask(
                "输入编号",
                default=default_choice,
            ).strip()
        except (KeyboardInterrupt, EOFError):
            console.print("\n[yellow]已取消[/yellow]")
            sys.exit(0)

        mapped = option_map.get(choice)

        if mapped:
            resolved = Config.resolve_workspace(mapped)
            Config.add_workspace_to_history(resolved)
            console.print(f"\n[green]✓ 工作空间: {resolved}[/green]")
            console.print()
            return resolved

        if choice == key_manual:
            while True:
                try:
                    manual = Prompt.ask("请输入工作空间路径").strip()
                except (KeyboardInterrupt, EOFError):
                    console.print()
                    break

                if not manual:
                    continue

                expanded = os.path.expanduser(manual)
                if not os.path.isabs(expanded):
                    expanded = os.path.abspath(expanded)

                if os.path.exists(expanded) and os.path.isdir(expanded):
                    Config.add_workspace_to_history(expanded)
                    console.print(f"\n[green]✓ 工作空间: {expanded}[/green]")
                    console.print()
                    return expanded
                else:
                    if Confirm.ask(
                        f"目录 [yellow]{expanded}[/yellow] 不存在，是否创建？",
                        default=True,
                    ):
                        os.makedirs(expanded, exist_ok=True)
                        Config.add_workspace_to_history(expanded)
                        console.print(f"\n[green]✓ 已创建并选择: {expanded}[/green]")
                        console.print()
                        return expanded

        console.print(f"[red]无效选项: {choice}[/red]")


def _format_path(path: str) -> str:
    """格式化路径显示：如果是子目录用相对路径，否则用缩写"""
    cwd = os.getcwd()
    try:
        rel = os.path.relpath(path, cwd)
        if not rel.startswith(".."):
            return f"[dim]./{rel}[/dim]"
    except ValueError:
        pass

    # 尝试用 ~ 缩写
    home = str(Path.home())
    if path.startswith(home):
        return f"[dim]~{path[len(home):]}[/dim]"

    return f"[dim]{path}[/dim]"


# ============================================================
# UI 辅助
# ============================================================

def show_banner() -> None:
    """显示欢迎横幅"""
    banner = """
[bold cyan]╔══════════════════════════════════════════════════╗
║                                                  ║
║    ██╗   ██╗ ██████╗ █████╗                       ║
║    ██║   ██║██╔════╝██╔══██╗                      ║
║    ██║   ██║██║     ███████║                      ║
║    ╚██╗ ██╔╝██║     ██╔══██║                      ║
║     ╚████╔╝ ╚██████╗██║  ██║                      ║
║      ╚═══╝   ╚═════╝╚═╝  ╚═╝                      ║
║                                                  ║
║    [bold]Virtual Code Agent[/bold] - 基于 LangGraph 的控制台编码助手  ║
║                                                  ║
╚══════════════════════════════════════════════════╝[/bold cyan]
"""
    console.print(banner)
    console.print(f"[dim]版本: 0.1.0 | 模型: {Config.OPENAI_MODEL}[/dim]")
    console.print()


def show_help(verbose: bool = False) -> None:
    """显示帮助信息"""
    verbose_status = "[green]● 详细[/green]" if verbose else "[dim]○ 精简[/dim]"
    help_text = f"""
[bold]可用命令:[/bold]
  [cyan]/help[/cyan]        - 显示此帮助信息
  [cyan]/clear[/cyan]       - 清除对话历史
  [cyan]/workspace[/cyan]   - 显示工作空间详情
  [cyan]/cd[/cyan] <路径>    - 切换工作空间目录
  [cyan]/verbose[/cyan]     - 切换深度思考展开/折叠  {verbose_status}
  [cyan]/config[/cyan]      - 显示当前配置
  [cyan]/exit[/cyan]        - 退出程序

[bold]输入编程任务描述，Agent 将自动完成。[/bold]
例如:
  • 在当前目录创建一个 hello.py 文件
  • 列出所有 Python 文件
  • 运行 pytest 测试
  • 帮我写一个 Flask REST API
"""
    console.print(Panel(help_text, title="帮助", border_style="cyan"))


def show_workspace_info(workspace_dir: str, verbose: bool = False) -> None:
    """显示工作空间详细信息"""
    abs_path = os.path.abspath(workspace_dir)

    table = Table(title="工作空间信息", box=box.ROUNDED)
    table.add_column("属性", style="cyan", width=14)
    table.add_column("值", style="white")

    table.add_row("路径", abs_path)
    table.add_row("存在", "是" if os.path.exists(abs_path) else "否")
    table.add_row("目录", "是" if os.path.isdir(abs_path) else "否")

    if os.path.isdir(abs_path):
        try:
            items = sorted(os.listdir(abs_path))
            dirs = [i for i in items if os.path.isdir(os.path.join(abs_path, i))]
            files = [i for i in items if os.path.isfile(os.path.join(abs_path, i))]
            table.add_row("子目录数", str(len(dirs)))
            table.add_row("文件数", str(len(files)))

            # 检测项目类型
            indicators = _detect_project_type(abs_path)
            if indicators:
                table.add_row("项目类型", ", ".join(indicators))

            if verbose and items:
                table.add_row("", "")
                table.add_row("[bold]内容列表[/bold]", "")
                for item in items[:20]:
                    full = os.path.join(abs_path, item)
                    icon = "📁" if os.path.isdir(full) else "📄"
                    table.add_row(f"  {icon}", item)
                if len(items) > 20:
                    table.add_row("  ...", f"还有 {len(items) - 20} 项")
        except PermissionError:
            table.add_row("内容", "[red]无权限访问[/red]")

    console.print(table)


def _detect_project_type(path: str) -> list[str]:
    """通过标志文件检测项目类型"""
    indicators = []
    markers = {
        "pyproject.toml": "Python",
        "setup.py": "Python",
        "requirements.txt": "Python",
        "package.json": "Node.js",
        "Cargo.toml": "Rust",
        "go.mod": "Go",
        "CMakeLists.txt": "CMake",
        ".git": "Git",
        "Makefile": "Make",
        "Dockerfile": "Docker",
    }
    for filename, label in markers.items():
        if os.path.exists(os.path.join(path, filename)):
            indicators.append(label)
    return indicators


def show_config_info(workspace_dir: str) -> None:
    """显示配置信息"""
    console.print("[bold]当前配置:[/bold]")
    Config.display(workspace_dir)


# ============================================================
# 工作空间切换
# ============================================================

def switch_workspace(command: str, current_ws: str) -> str | None:
    """
    解析 /cd 命令，切换工作空间。
    返回新路径，或 None（不变/取消）。
    """
    # 解析 /cd <path>
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
        "-": "",  # 回到上一个，暂不实现
    }
    resolved = specials.get(target)
    if resolved is None:
        resolved = target

    # 处理相对路径
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


# ============================================================
# Agent 运行 — 带进度时间线和折叠思考
# ============================================================

# 深度思考折叠时的占位长度
_THINKING_COLLAPSED_MAX = 120


def _truncate_thinking(text: str) -> str:
    """将思考文本压缩为一行折叠摘要"""
    if not text:
        return "(无推理内容)"
    # 去空白、取第一句
    compact = text.replace("\n", " ").strip()
    if len(compact) > _THINKING_COLLAPSED_MAX:
        compact = compact[:_THINKING_COLLAPSED_MAX] + "..."
    return compact


def _format_tool_args(args: dict) -> str:
    """格式化工具参数为简洁字符串"""
    parts = []
    for k, v in args.items():
        if isinstance(v, str) and len(v) > 60:
            v = v[:57] + "..."
        parts.append(f"{k}={v!r}")
    return ", ".join(parts)


def run_agent(
    agent_instance,
    state: AgentState,
    user_input: str,
    verbose: bool = False,
) -> None:
    """
    运行 Agent 并显示带进度时间线的结果。

    显示逻辑:
    - 默认 (verbose=False): 深度思考折叠为一行 [展开查看]
    - 详细 (verbose=True):  深度思考完整展开
    - 工具调用始终显示，结果按状态截断
    """
    user_msg = HumanMessage(content=user_input)
    state["messages"].append(user_msg)

    try:
        with console.status("[bold green]Agent 推理中...[/bold green]", spinner="dots"):
            steps = list(agent_instance.stream(state))
    except Exception as e:
        console.print(f"[red bold]Error:[/red bold] {e}")
        return

    # ---------- 解析步骤 ----------
    round_num = 0          # 工具循环轮次
    tool_count = 0         # 本轮工具计数
    last_thinking = ""     # 上一轮 agent 节点的思考文本

    for step_idx, step in enumerate(steps):
        for node_name, node_output in step.items():

            # --- agent 节点 (LLM 推理) ---
            if node_name == "agent":
                messages = node_output.get("messages", [])
                for msg in messages:
                    if not isinstance(msg, AIMessage):
                        continue

                    # 有工具调用 → 标记新一轮
                    if msg.tool_calls:
                        round_num += 1
                        tool_count = 0
                        # 显示轮次标题
                        console.print()
                        console.print(
                            f"[bold blue]── 第 {round_num} 轮 ──[/bold blue]"
                        )

                    # LLM 推理内容 (tool_calls 之前或之后的文本)
                    thinking_text = msg.content or ""
                    if msg.tool_calls and msg.content:
                        thinking_text = msg.content

                    if thinking_text.strip():
                        last_thinking = thinking_text
                        if verbose:
                            # 展开模式: 完整显示
                            console.print(
                                Panel(
                                    Markdown(thinking_text),
                                    title="[bold yellow]🧠 深度思考[/bold yellow]",
                                    border_style="yellow",
                                    padding=(1, 2),
                                )
                            )
                        else:
                            # 折叠模式: 一行摘要
                            collapsed = _truncate_thinking(thinking_text)
                            console.print(
                                f"  [yellow]🧠[/yellow] [dim italic]{collapsed}[/dim] "
                                f"[dim](输入 /verbose 展开)[/dim]"
                            )

                    # 计划调用的工具
                    if msg.tool_calls:
                        for tc in msg.tool_calls:
                            tool_count += 1
                            args_str = _format_tool_args(tc.get("args", {}))
                            console.print(
                                f"  [cyan][{tool_count}][/cyan] [bold]→ {tc['name']}[/bold]({args_str})"
                            )

            # --- tools 节点 (工具执行结果) ---
            elif node_name == "tools":
                messages = node_output.get("messages", [])
                for msg in messages:
                    if not isinstance(msg, ToolMessage):
                        continue

                    content = msg.content or "(无输出)"
                    # 判断结果状态
                    if content.startswith("[OK]"):
                        status_icon = "✓"
                        status_color = "green"
                    elif content.startswith("[ERROR]") or content.startswith("[BLOCKED]"):
                        status_icon = "✗"
                        status_color = "red"
                    elif content.startswith("[INFO]"):
                        status_icon = "ℹ"
                        status_color = "yellow"
                    elif content.startswith("[ERR]"):
                        status_icon = "✗"
                        status_color = "red"
                    else:
                        status_icon = "✓"
                        status_color = "green"

                    # 结果内容: verbose 模式全量, 默认截断
                    result_preview = content
                    if not verbose and len(result_preview) > 600:
                        result_preview = (
                            result_preview[:600]
                            + f"\n... (共 {len(content)} 字符, 输入 /verbose 查看完整)"
                        )

                    console.print(
                        Panel(
                            f"[dim]{result_preview}[/dim]",
                            title=f"[bold {status_color}]{status_icon} {msg.name}[/bold {status_color}]",
                            border_style=status_color,
                            padding=(1, 2),
                        )
                    )

            # --- respond 节点 (最终回复) ---
            elif node_name == "respond":
                final = node_output.get("final_response", "")
                if final:
                    console.print()
                    response_panel = Panel(
                        Markdown(final),
                        title="[bold green]✓ 最终回答[/bold green]",
                        border_style="green",
                        padding=(1, 3),
                    )
                    console.print(response_panel)

    # 打印步骤统计
    if round_num > 0:
        total_tools = sum(
            1
            for step in steps
            for node_id, output in step.items()
            if node_id == "tools"
            for _msg in output.get("messages", [])
        )
        console.print(
            f"[dim]共 {round_num} 轮推理, {total_tools} 次工具调用[/dim]"
        )
    console.print()


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
        console.print(
            "[red]请复制 .env.example 为 .env 并填入你的 API Key[/red]"
        )
        sys.exit(1)

    # 2. 选择工作空间
    cli_path = args.workspace or args.workspace_flag
    workspace_dir = select_workspace(cli_path)

    # 3. 创建 Agent
    console.print("[dim]正在初始化 Agent...[/dim]")
    try:
        agent = create_coding_agent()
    except Exception as e:
        console.print(f"[red]Agent 初始化失败: {e}[/red]")
        sys.exit(1)

    # 4. 创建初始状态
    state = create_initial_state(workspace_dir)

    # 5. 显示界面
    console.clear()
    show_banner()

    # 显示模式标志
    verbose = False

    console.print(
        Panel(
            f"工作空间: [cyan]{workspace_dir}[/cyan]\n\n"
            "输入编程任务，Agent 将自动完成。\n"
            "输入 [cyan]/help[/cyan] 查看可用命令，[cyan]/cd <路径>[/cyan] 切换项目。",
            title="[bold]就绪[/bold]",
            border_style="green",
        )
    )
    console.print()

    # 6. 主事件循环
    while True:
        # 动态提示符: 显示工作空间简称 + 模式标记
        ws_name = os.path.basename(workspace_dir) or workspace_dir
        mode_tag = "" if verbose else ""
        prompt = f"[bold cyan]{ws_name}[/bold cyan] > "

        try:
            user_input = console.input(prompt).strip()
        except (KeyboardInterrupt, EOFError):
            console.print("\n[yellow]再见![/yellow]")
            break

        if not user_input:
            continue

        # 处理命令
        if user_input.startswith("/"):
            cmd = user_input.lower().split()[0]
            if cmd == "/exit":
                console.print("[yellow]再见![/yellow]")
                break
            elif cmd == "/help":
                show_help(verbose=verbose)
            elif cmd == "/clear":
                state = create_initial_state(workspace_dir)
                console.print("[green]对话历史已清除[/green]")
            elif cmd == "/workspace":
                show_workspace_info(workspace_dir, verbose=True)
            elif cmd == "/verbose":
                verbose = not verbose
                mode_label = "[green]详细模式[/green]" if verbose else "[dim]精简模式[/dim]"
                if verbose:
                    console.print(f"{mode_label}: 深度思考已展开，工具输出完整显示")
                else:
                    console.print(f"{mode_label}: 深度思考已折叠，工具输出截断预览")
            elif cmd == "/cd":
                new_ws = switch_workspace(user_input, workspace_dir)
                if new_ws:
                    workspace_dir = new_ws
                    state["workspace_dir"] = new_ws
                    # 重新注入 system prompt
                    from .graph.workflow import SYSTEM_PROMPT
                    for msg in state["messages"]:
                        if isinstance(msg, SystemMessage) and "工作空间" in msg.content:
                            state["messages"].remove(msg)
                            break
                    state["messages"].insert(
                        0,
                        SystemMessage(content=SYSTEM_PROMPT.format(workspace_dir=new_ws)),
                    )
            elif cmd == "/config":
                show_config_info(workspace_dir)
            else:
                console.print(f"[red]未知命令: {user_input}[/red]")
            console.print()
            continue

        # 运行 Agent
        run_agent(agent, state, user_input, verbose=verbose)
        console.print()


if __name__ == "__main__":
    main()
