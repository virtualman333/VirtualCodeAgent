"""控制台 UI 组件 - 横幅/帮助/信息展示"""

from __future__ import annotations

import os
from pathlib import Path

from rich import box
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from .config import Config
from .mcp.manager import mcp_manager
from .skills.manager import get_all_skills

# 全局控制台
console = Console()


# ============================================================
# 横幅 / 帮助
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
  [cyan]/new[/cyan]         - 开启新对话窗口（当前对话自动保存）
  [cyan]/history[/cyan]     - 查看对话历史记录
  [cyan]/load[/cyan]        - 恢复上一次对话
  [cyan]/load[/cyan] <编号>  - 恢复指定历史对话
  [cyan]/save[/cyan]        - 手动保存当前对话
  [cyan]/skills[/cyan]      - 查看可用的专业技能
  [cyan]/mcp[/cyan]         - 查看 MCP server 连接状态
  [cyan]/agents[/cyan]      - 查看所有 SubAgent（子代理）状态
  [cyan]/config[/cyan]      - 显示当前配置
  [cyan]/exit[/cyan]        - 退出程序

[bold]输入编程任务描述，Agent 将自动完成。[/bold]
例如:
  • 在当前目录创建一个 hello.py 文件
  • 列出所有 Python 文件
  • 运行 pytest 测试
  • 帮我写一个 Flask REST API

[dim]对话记录自动保存在 ~/.vca/sessions/ 目录[/dim]
"""
    console.print(Panel(help_text, title="帮助", border_style="cyan"))


# ============================================================
# 工作空间信息
# ============================================================

_PROJECT_MARKERS = {
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


def _detect_project_type(path: str) -> list[str]:
    """通过标志文件检测项目类型"""
    return [
        label
        for filename, label in _PROJECT_MARKERS.items()
        if os.path.exists(os.path.join(path, filename))
    ]


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


def show_config_info(workspace_dir: str) -> None:
    """显示配置信息"""
    from .config import CONFIG_FILE

    table = Table(title="当前配置", box=box.ROUNDED)
    table.add_column("配置项", style="cyan")
    table.add_column("值", style="white")
    table.add_column("说明", style="dim")

    rows = [
        ("OPENAI_API_KEY", _mask_key(Config.OPENAI_API_KEY), "API 密钥 (首次使用必须填写)"),
        ("OPENAI_BASE_URL", Config.OPENAI_BASE_URL, "OpenAI 兼容接口地址"),
        ("OPENAI_MODEL", Config.OPENAI_MODEL, "模型名称"),
        ("WORKSPACE_DIR", os.path.abspath(Config.WORKSPACE_DIR), "默认工作空间"),
        ("MAX_TOOL_ITERATIONS", str(Config.MAX_TOOL_ITERATIONS), "工具最大迭代次数"),
        ("MAX_CONTEXT_TOKENS", str(Config.MAX_CONTEXT_TOKENS), "上下文裁剪阈值"),
    ]
    for name, value, desc in rows:
        table.add_row(name, value, desc)

    console.print(table)
    console.print(f"[dim]配置文件: {CONFIG_FILE}[/dim]")
    console.print(
        "[dim]修改方法: 编辑配置文件后重启，或使用 /config set <KEY> <VALUE>[/dim]"
    )


def _mask_key(key: str) -> str:
    """掩码显示 API Key"""
    if not key:
        return "[red](未设置)[/red]"
    if len(key) <= 8:
        return "*" * len(key)
    return key[:4] + "****" + key[-4:]


# ============================================================
# Skills / MCP / SubAgent
# ============================================================

def _show_skills() -> None:
    """显示可用 Skills"""
    skills = get_all_skills()
    if not skills:
        console.print("[dim]暂无可用 Skills[/dim]")
        console.print(
            "[dim]创建方法: 在 ~/.vca/skills/ 或项目 .vca/skills/ 目录下\n"
            "添加 <skill_name>/SKILL.md 文件即可[/dim]"
        )
        return

    table = Table(title=f"可用的专业技能 ({len(skills)})", box=box.ROUNDED)
    table.add_column("名称", style="cyan")
    table.add_column("描述", style="white")
    table.add_column("来源", style="dim")

    for s in skills:
        source = "用户级" if ".vca" in str(s.path) and "home" not in str(s.path) else "项目级"
        table.add_row(s.name, s.description or "(无描述)", source)

    console.print(table)
    console.print("[dim]Agent 可用 list_skills / load_skill 工具加载技能[/dim]")


def _show_mcp() -> None:
    """显示 MCP 连接状态"""
    console.print(Text(mcp_manager.status_text()))


def _show_agents() -> None:
    """显示所有 SubAgent 的状态"""
    from .subagents import mailbox
    from .subagents.manager import get_manager
    from .subagents.types import STATUS_COMPLETED, STATUS_FAILED

    mgr = get_manager()
    mem = mgr.list()
    disk = mailbox.list_agents()

    seen: set[str] = set()
    merged = []
    for a in mem + disk:
        if a.id in seen:
            continue
        seen.add(a.id)
        merged.append(a)

    if not merged:
        console.print("[dim]暂无 SubAgent[/dim]")
        console.print(
            "[dim]主 Agent 可使用 create_agent 工具创建子代理来处理子任务，"
            "实现任务分派、并行执行与上下文隔离。[/dim]"
        )
        return

    status_style = {
        "pending": "yellow",
        "running": "cyan",
        "completed": "green",
        "failed": "red",
    }

    table = Table(title=f"SubAgent 列表 ({len(merged)})", box=box.ROUNDED)
    table.add_column("ID", style="cyan", width=18)
    table.add_column("名称", style="white", width=16)
    table.add_column("状态", justify="center", width=10)
    table.add_column("模式", justify="center", width=10)
    table.add_column("耗时", justify="right", width=8)
    table.add_column("工作目录", style="dim", width=28)

    for a in merged:
        dur = f"{a.finished_at - a.created_at:.0f}s" if a.finished_at else "-"
        ws = a.workspace_dir
        if len(ws) > 28:
            ws = "..." + ws[-25:]
        table.add_row(
            a.id,
            a.name[:16],
            f"[{status_style.get(a.status, 'white')}]{a.status}[/]",
            a.mode,
            dur,
            ws,
        )

    console.print(table)

    for a in merged:
        if a.status == STATUS_FAILED and a.error:
            console.print(f"[red]✗ {a.id} 失败: {a.error[:120]}[/red]")
        elif a.is_finished and a.result:
            brief = a.result.replace("\n", " ")[:100]
            console.print(f"[dim]  {a.id} 结果: {brief}[/dim]")
    console.print(
        "[dim]主 Agent 可通过 get_agent_result 获取结果，delete_agent 清理记录。[/dim]"
    )
