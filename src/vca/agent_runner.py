"""Agent 流式运行与渲染 - 单次任务的完整执行展示"""

from __future__ import annotations

import json

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from rich.markdown import Markdown
from rich.panel import Panel
from rich.prompt import Prompt
from rich.text import Text

from .state import AgentState
from .ui import console

# 深度思考折叠时的占位长度
_THINKING_COLLAPSED_MAX = 300


# ============================================================
# 格式化辅助
# ============================================================

def _truncate_thinking(text: str) -> str:
    """将思考文本压缩为一行折叠摘要"""
    if not text:
        return "(无推理内容)"
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


def _fmt_num(n) -> str:
    """格式化数字: 千分位"""
    try:
        return f"{int(n):,}"
    except (TypeError, ValueError):
        return "0"


def _fmt_duration(ms: float) -> str:
    """格式化耗时: <1000ms 显示 ms, 否则显示 s"""
    try:
        ms = float(ms)
    except (TypeError, ValueError):
        return "-"
    if ms < 1000:
        return f"{ms:.0f}ms"
    return f"{ms / 1000:.1f}s"


def _parse_tool_call(tc: dict) -> tuple[str, dict]:
    """解析工具调用 (兼容不同格式), 返回 (name, args)"""
    name = tc.get("name", tc.get("function", {}).get("name", "?"))
    args = tc.get("args", tc.get("function", {}).get("arguments", {}))
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except Exception:
            args = {}
    return name, args if isinstance(args, dict) else {}


# ============================================================
# 渲染函数
# ============================================================

def _render_agent_step(node_output: dict, verbose: bool) -> None:
    """渲染 agent 节点的 LLM 推理输出"""
    for msg in node_output.get("messages", []):
        if not isinstance(msg, AIMessage):
            continue

        thinking_text = msg.content or ""

        if thinking_text.strip():
            if verbose:
                console.print()
                console.print(
                    Panel(
                        Markdown(thinking_text),
                        title="[bold yellow]🧠 深度思考[/bold yellow]",
                        border_style="yellow",
                        padding=(1, 2),
                    )
                )
            else:
                collapsed = _truncate_thinking(thinking_text)
                console.print(
                    Text.assemble(
                        "  ", ("🧠", "yellow"),
                        " ", (collapsed, "dim italic"),
                        " ", ("(输入 /verbose 展开)", "dim"),
                    )
                )

        if msg.tool_calls:
            for i, tc in enumerate(msg.tool_calls, 1):
                name, args = _parse_tool_call(tc)
                args_str = _format_tool_args(args)
                console.print(
                    f"  [cyan][{i}][/cyan] [bold]→ {name}[/bold]({args_str})"
                )


def _render_ask_user(pending: dict) -> str | None:
    """
    渲染 ask_user 交互式问题，收集用户回答。
    返回用户回答文本，或 None(用户取消)。
    """
    header = pending.get("header", "确认")
    question = pending.get("question", "")
    options = pending.get("options", [])
    is_multi = pending.get("is_multi", False)

    console.print()
    console.print(
        Panel(
            f"[bold]{question}[/bold]",
            title=f"[bold magenta]💬 {header}[/bold magenta]",
            border_style="magenta",
        )
    )

    # --- 有预设选项 → 编号选择 ---
    if options:
        console.print()
        for i, opt in enumerate(options, 1):
            console.print(f"  [cyan]{i}[/cyan]. {opt}")

        custom_idx = len(options) + 1
        skip_idx = len(options) + 2
        console.print(f"  [cyan]{custom_idx}[/cyan]. 自定义回答")
        console.print(f"  [cyan]{skip_idx}[/cyan]. 跳过")
        console.print()

        if is_multi:
            console.print("[dim]多选: 可用逗号分隔编号，如 1,3,4[/dim]")

        while True:
            try:
                choice = Prompt.ask("请选择", default="1").strip()
            except (KeyboardInterrupt, EOFError):
                return None

            if choice == str(skip_idx):
                return "[用户选择跳过]"
            if choice == str(custom_idx):
                return _ask_user_free_input()

            # 多选解析
            if is_multi and "," in choice:
                selected = []
                for part in choice.split(","):
                    part = part.strip()
                    try:
                        idx = int(part) - 1
                        if 0 <= idx < len(options):
                            selected.append(options[idx])
                    except ValueError:
                        pass
                if selected:
                    return "用户选择了: " + ", ".join(selected)

            # 单选
            try:
                idx = int(choice) - 1
                if 0 <= idx < len(options):
                    return f"用户选择了: {options[idx]}"
            except ValueError:
                pass

            console.print(f"[red]无效选项，请输入 1-{skip_idx}[/red]")

    # --- 无预设选项 → 自由输入 ---
    return _ask_user_free_input()


def _ask_user_free_input() -> str | None:
    """收集用户的自由文本回答"""
    console.print("[dim]请输入你的回答 (直接回车跳过):[/dim]")
    try:
        answer = Prompt.ask(">").strip()
    except (KeyboardInterrupt, EOFError):
        return None
    return f"用户回答: {answer}" if answer else "[用户选择跳过]"


# ============================================================
# 主运行函数
# ============================================================

def run_agent(
    agent_instance,
    state: AgentState,
    user_input: str,
    verbose: bool = False,
) -> None:
    """
    运行 Agent 并流式显示每步结果。

    - 每步 LLM 推理 / 工具调用 / 最终回答都实时输出
    - verbose=False: 深度思考折叠为一行
    - verbose=True:  深度思考完整展开
    - 支持 ask_user 暂停/恢复
    """
    state["messages"].append(HumanMessage(content=user_input))

    # --- 外层循环: 处理 ask_user 暂停/恢复 ---
    while True:
        total_tools = 0     # 工具调用总次数
        has_respond = False
        # Token 汇总
        sum_input = 0
        sum_output = 0
        sum_total = 0
        sum_llm_ms = 0.0
        sum_tool_ms = 0.0

        try:
            for step in agent_instance.stream(state):
                for node_name, node_output in step.items():

                    # --- agent 节点 (LLM 推理) ---
                    if node_name == "agent":
                        _render_agent_step(node_output, verbose)

                        # 同步 LLM 回复回外部 state。
                        # LangGraph stream() 不会把内部累积的消息写回传入的 dict，
                        # 必须手动同步，否则下次问答会丢失本轮的 Agent 回复 → 上下文丢失。
                        for msg in node_output.get("messages", []):
                            if isinstance(msg, AIMessage):
                                state["messages"].append(msg)

                        # 累计 token (任务结束后统一汇总)
                        usage = node_output.get("llm_usage") or {}
                        if usage:
                            sum_input += usage.get("input_tokens", 0) or 0
                            sum_output += usage.get("output_tokens", 0) or 0
                            sum_total += usage.get("total_tokens", 0) or 0
                            sum_llm_ms += usage.get("duration_ms", 0) or 0

                    # --- tools 节点 (执行结果, 不显示) ---
                    elif node_name == "tools":
                        for msg in node_output.get("messages", []):
                            if isinstance(msg, ToolMessage):
                                if msg.content != "[AWAITING_USER_INPUT]":
                                    total_tools += 1
                                state["messages"].append(msg)

                        tool_usage = node_output.get("tool_usage") or {}
                        if tool_usage:
                            sum_tool_ms += tool_usage.get("duration_ms", 0) or 0

                    # --- ask_user 节点 ---
                    elif node_name == "ask_user":
                        # 手动同步挂起问题到 state
                        pq = node_output.get("pending_question")
                        if pq:
                            state["pending_question"] = pq
                            console.print(
                                Text.assemble(
                                    "  ", ("💬", "magenta"),
                                    (" Agent 需要确认: ", "bold magenta"),
                                )
                            )

                    # --- respond 节点: 最终回答 ---
                    elif node_name == "respond":
                        final = node_output.get("final_response", "")
                        pending = state.get("pending_question")
                        if final and not pending:
                            console.print()
                            console.print(
                                Panel(
                                    Markdown(final),
                                    title="[bold green]✓ 最终回答[/bold green]",
                                    border_style="green",
                                    padding=(1, 3),
                                )
                            )
                            has_respond = True

                # 每步后检查 ask_user 挂起
                if state.get("pending_question"):
                    break

        except Exception as e:
            console.print("[red bold]Error:[/red bold]")
            console.print(Text(str(e)))
            return

        # --- 汇总 (任务完成后的总 Token 消耗 + 耗时) ---
        if sum_total > 0:
            console.print()
            total_dur = _fmt_duration(sum_llm_ms + sum_tool_ms)
            parts = [
                ("📊 总消耗: ", "cyan"),
                (f"Token {_fmt_num(sum_input)}↑ / {_fmt_num(sum_output)}↓"
                 f" / 共 {_fmt_num(sum_total)}", "cyan"),
            ]
            if total_tools:
                parts.append((f" | 工具 {total_tools} 次", "yellow"))
            parts.append((f" | 总耗时 {total_dur}", "magenta"))
            console.print(Text.assemble(*parts))
        elif total_tools > 0:
            console.print(f"[dim]共 {total_tools} 次工具调用[/dim]")

        # --- 检测 ask_user 挂起 ---
        pending = state.get("pending_question")
        if not pending:
            console.print()
            break

        # 弹出交互式问题
        answer = _render_ask_user(pending)
        if answer is None:
            state["pending_question"] = None
            console.print("[dim]用户取消了提问[/dim]")
            console.print()
            break

        # 注入回答，继续外层循环
        state["messages"].append(
            ToolMessage(
                content=answer,
                tool_call_id=pending["tool_call_id"],
                name="ask_user",
            )
        )
        state["pending_question"] = None
        console.print()
