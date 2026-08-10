"""控制台入口 - 编码 Agent 的交互式 CLI"""

from __future__ import annotations

import os
import sys

from rich.console import Console
from rich.panel import Panel
from rich.markdown import Markdown
from rich.live import Live
from rich.spinner import Spinner
from rich.table import Table
from rich import box
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage

from .config import Config
from .state import create_initial_state, AgentState
from .graph.workflow import create_coding_agent

# ============================================================
# 控制台 UI
# ============================================================

console = Console()


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


def show_help() -> None:
    """显示帮助信息"""
    help_text = """
[bold]可用命令:[/bold]
  [cyan]/help[/cyan]      - 显示此帮助信息
  [cyan]/clear[/cyan]     - 清除对话历史
  [cyan]/workspace[/cyan] - 显示工作空间信息
  [cyan]/config[/cyan]    - 显示当前配置
  [cyan]/exit[/cyan]      - 退出程序

[bold]输入编程任务描述，Agent 将自动完成。[/bold]
例如:
  • 在当前目录创建一个 hello.py 文件
  • 列出所有 Python 文件
  • 运行 pytest 测试
  • 帮我写一个 Flask REST API
"""
    console.print(Panel(help_text, title="帮助", border_style="cyan"))


def show_workspace_info(workspace_dir: str) -> None:
    """显示工作空间信息"""
    table = Table(title="工作空间信息", box=box.ROUNDED)
    table.add_column("属性", style="cyan")
    table.add_column("值", style="white")

    table.add_row("路径", os.path.abspath(workspace_dir))
    table.add_row("存在", "是" if os.path.exists(workspace_dir) else "否")

    if os.path.exists(workspace_dir):
        items = os.listdir(workspace_dir)
        table.add_row("文件数", str(len(items)))
        for item in items[:10]:
            table.add_row("  -", item)
        if len(items) > 10:
            table.add_row("  ...", f"还有 {len(items) - 10} 项")

    console.print(table)


def show_config_info() -> None:
    """显示配置信息"""
    console.print("[bold]当前配置:[/bold]")
    Config.display()


def format_tool_call(name: str, args: dict, result: str) -> Panel:
    """格式化工具调用为 Panel"""
    args_str = ", ".join(f"{k}={v!r}" for k, v in args.items())
    # 截断过长结果
    result_display = result[:500] + "..." if len(result) > 500 else result

    content = f"[bold yellow]调用:[/bold yellow] {name}({args_str})\n"
    content += f"[dim]{result_display}[/dim]"

    return Panel(content, title=f"[Tool] {name}", border_style="yellow")


# ============================================================
# 主循环
# ============================================================


def run_agent(agent_instance, state: AgentState, user_input: str) -> None:
    """
    运行 Agent 并流式显示结果。

    解析 LangGraph 的每个步骤输出，实时显示:
    - LLM 思考 → 蓝色边框
    - 工具调用 → 黄色边框
    - 最终回复 → 绿色边框
    """
    # 添加用户消息
    user_msg = HumanMessage(content=user_input)
    state["messages"].append(user_msg)

    try:
        with console.status("[bold green]Agent 思考中...[/bold green]", spinner="dots"):
            # 使用 stream 获取中间步骤
            steps = list(agent_instance.stream(state))

        # 分析每个步骤
        for step in steps:
            for node_name, node_output in step.items():
                if node_name == "agent":
                    messages = node_output.get("messages", [])
                    for msg in messages:
                        if isinstance(msg, AIMessage):
                            if msg.tool_calls:
                                # 显示工具调用意图
                                for tc in msg.tool_calls:
                                    console.print(
                                        f"  [dim]→ 计划调用工具: {tc['name']}[/dim]"
                                    )
                            elif msg.content:
                                # 纯文本回复
                                pass  # 在 respond 节点统一显示

                elif node_name == "tools":
                    messages = node_output.get("messages", [])
                    for msg in messages:
                        if isinstance(msg, ToolMessage):
                            console.print(
                                Panel(
                                    f"[dim]{msg.content[:400]}[/dim]",
                                    title=f"[bold yellow]🔧 {msg.name}[/bold yellow]",
                                    border_style="yellow",
                                )
                            )

                elif node_name == "respond":
                    final = node_output.get("final_response", "")
                    if final:
                        console.print(
                            Panel(
                                Markdown(final),
                                title="[bold green]Agent[/bold green]",
                                border_style="green",
                            )
                        )

    except Exception as e:
        console.print(f"[red bold]Error:[/red bold] {e}")


def main() -> None:
    """主入口"""

    # 1. 验证配置
    if not Config.validate():
        console.print(
            "[red]请复制 .env.example 为 .env 并填入你的 API Key[/red]"
        )
        sys.exit(1)

    # 2. 创建工作空间目录
    workspace_dir = os.path.abspath(Config.WORKSPACE_DIR)
    os.makedirs(workspace_dir, exist_ok=True)

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

    console.print(
        Panel(
            "输入编程任务（如 '创建一个 hello.py'），Agent 将自动完成。\n"
            "输入 [cyan]/help[/cyan] 查看可用命令。",
            title="[bold]开始使用[/bold]",
            border_style="green",
        )
    )
    console.print()

    # 6. 主事件循环
    while True:
        try:
            user_input = console.input("[bold cyan]你[/bold cyan]: ").strip()
        except (KeyboardInterrupt, EOFError):
            console.print("\n[yellow]再见![/yellow]")
            break

        if not user_input:
            continue

        # 处理命令
        if user_input.startswith("/"):
            cmd = user_input.lower()
            if cmd == "/exit":
                console.print("[yellow]再见![/yellow]")
                break
            elif cmd == "/help":
                show_help()
            elif cmd == "/clear":
                state = create_initial_state(workspace_dir)
                console.print("[green]对话历史已清除[/green]")
            elif cmd == "/workspace":
                show_workspace_info(workspace_dir)
            elif cmd == "/config":
                show_config_info()
            else:
                console.print(f"[red]未知命令: {user_input}[/red]")
            console.print()
            continue

        # 运行 Agent
        run_agent(agent, state, user_input)
        console.print()


if __name__ == "__main__":
    main()
