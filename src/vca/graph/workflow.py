"""LangGraph 工作流 - 基于 ReAct 模式的编码 Agent"""

from __future__ import annotations

import os
import platform
import sys
import time
from typing import Literal

from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode
from langchain_openai import ChatOpenAI
from langchain_core.messages import AIMessage, SystemMessage, BaseMessage, HumanMessage, ToolMessage

from ..state import AgentState
from ..config import Config
from ..tools import ALL_TOOLS
from ..mcp.manager import mcp_manager
from .. import workspace_ctx

# ============================================================
# 系统提示词模板
# ============================================================

_ENV_INFO = f"""## 当前运行环境
- 操作系统: {platform.system()} {platform.release()} ({platform.machine()})
- Shell: {os.environ.get('SHELL', os.environ.get('COMSPEC', 'unknown'))}
- Python: {sys.version}
- 工作目录: {{workspace_dir}}
"""

_SYSTEM_PROMPT_TEMPLATE = """你是一个控制台编码 Agent，帮助用户完成编程任务。

{env_info}

## 工具箱

📖 阅读与理解:
- `read_file`     — 读文件，支持行号范围、PDF、图片、Notebook
- `glob_files`    — 按文件名模式搜索 (如 src/**/*.tsx)
- `grep_content`  — 按文件内容/正则搜索 (如 TODO|FIXME)

✏️ 编写与修改:
- `edit_file`     — 精确替换文件中的文本片段 (必须唯一匹配)
- `write_file`    — 创建新文件或完全重写
- `bash`          — Shell 命令 (git commit、npm install 等)

▶️ 执行与验证:
- `bash`          — 万能工具: 跑测试、构建、lint、git 操作等

💬 用户交互:
- `ask_user`      — 向用户提问，用于澄清模糊需求或确认关键决策

🎯 专业技能 (Skills):
- `list_skills`   — 列出可用的专业技能 (如 web-scraping、docker 等)
- `load_skill`    — 加载指定技能到上下文 (需要专业领域知识时使用)

🔌 外部工具 (MCP):
- 已连接的 MCP servers 提供的工具，调用方式与内置工具相同
- 可用 `/mcp` 命令查看已连接的 MCP servers

## 工作规则
1. 在执行文件操作前，先用 Glob/Grep 了解项目结构
2. 写代码: 大文件用 Write，小改动用 Edit
3. 搜索代码: 找文件名用 Glob，找内容用 Grep
4. 修改代码: 先用 Read 确认内容 → 再用 Edit 精确替换
5. 写入文件后，用 Bash 运行测试/构建验证结果
6. 遇到错误时分析原因并尝试修复
7. 遇到模棱两可的需求时，用 ask_user 向用户确认，不要自行猜测
8. 每个响应只调用一个工具，或一次性完成不依赖前序结果的工具链
9. 用 ask_user 时提供清晰的选项让用户选择，而不是开放式提问
10. 根据环境信息使用正确的命令 (Windows 用 dir/tasklist/del, Linux 用 ls/ps/rm 等)

## 工作空间使用规范（防污染）
- 临时脚本 / 调试脚本 / 一次性日志：**必须**写到 `{workspace_dir}/.vca/scratch/` 子目录
  - 该目录若不存在，先 `mkdir -p .vca/scratch` 创建
- 禁止在仓库根目录直接写临时文件（如 `_split.py`、`_c_*.txt`、`_g_*.txt`、`_dump.txt` 等）
- 完成任务后清理自己产生的临时产物（`rm .vca/scratch/<本次任务相关文件>`），不要残留
- 正式产物 / 业务代码不在此限制内，按用户要求正常写

请用中文回复用户。"""


def make_system_prompt(workspace_dir: str) -> str:
    """根据运行时环境动态生成 system prompt"""
    env_info = _ENV_INFO.format(workspace_dir=workspace_dir)
    return _SYSTEM_PROMPT_TEMPLATE.format(
        env_info=env_info,
        workspace_dir=workspace_dir,
    )


# ============================================================
# 上下文裁剪 (滑动窗口)
# ============================================================

# token 估算系数: 中文 ~1.5 字符/token, 英文 ~4 字符/token, 混合取 2.5
_CHARS_PER_TOKEN = 2.5


def _estimate_tokens(text: str) -> int:
    """粗略估算 token 数"""
    return max(1, int(len(text) / _CHARS_PER_TOKEN))


def _message_tokens(msg: BaseMessage) -> int:
    """估算一条消息的 token 数"""
    base = _estimate_tokens(str(msg.content))
    if isinstance(msg, ToolMessage):
        base += 20
    elif isinstance(msg, AIMessage) and msg.tool_calls:
        base += _estimate_tokens(str(msg.tool_calls)) + 50
    return base


def _extract_token_usage(response) -> dict:
    """
    从 LLM 响应中提取 token 使用量，兼容不同格式:
    - response_metadata.token_usage (OpenAI 格式)
    - usage_metadata (LangChain 新格式)
    """
    usage: dict = {}
    # 新版 langchain: usage_metadata
    um = getattr(response, "usage_metadata", None)
    if um:
        usage = {
            "input_tokens": um.get("input_tokens", 0),
            "output_tokens": um.get("output_tokens", 0),
            "total_tokens": um.get("total_tokens", 0),
        }
        if usage.get("total_tokens") or usage.get("input_tokens"):
            return usage

    # 旧版兼容: response_metadata.token_usage
    rm = getattr(response, "response_metadata", {}) or {}
    tu = rm.get("token_usage") or {}
    if tu:
        return {
            "input_tokens": tu.get("prompt_tokens", 0),
            "output_tokens": tu.get("completion_tokens", 0),
            "total_tokens": tu.get("total_tokens", 0),
        }
    return usage


def _messages_to_text(messages: list[BaseMessage]) -> str:
    """将消息列表转为可读文本，供 LLM 摘要"""
    lines: list[str] = []
    for msg in messages:
        role = type(msg).__name__.replace("Message", "")
        role_zh = {"Human": "用户", "AI": "Agent", "Tool": "工具", "System": "系统"}.get(
            role, role
        )
        content = str(msg.content)
        if isinstance(msg, ToolMessage):
            name = getattr(msg, "name", "")
            if len(content) > 400:
                content = content[:400] + "...(截断)"
            lines.append(f"[{role_zh}:{name}] {content}")
        elif isinstance(msg, AIMessage) and msg.tool_calls:
            tools = [tc.get("name", "?") for tc in msg.tool_calls]
            if content.strip():
                lines.append(f"[{role_zh}] {content[:200]} → 调用工具: {', '.join(tools)}")
            else:
                lines.append(f"[{role_zh}] 调用工具: {', '.join(tools)}")
        else:
            if len(content) > 300:
                content = content[:300] + "...(截断)"
            lines.append(f"[{role_zh}] {content}")
    return "\n".join(lines)


# ============================================================
# CodingAgent
# ============================================================


class CodingAgent:
    """基于 LangGraph ReAct 模式的编码 Agent"""

    # 上下文上限 (token), 可通过 MAX_CONTEXT_TOKENS 环境变量覆盖
    _MAX_CONTEXT_TOKENS: int = int(
        os.getenv("MAX_CONTEXT_TOKENS", str(100 * 1024))
    )

    def __init__(
        self,
        include_tools: list | None = None,
        mcp_tools: list | None = None,
    ) -> None:
        """
        初始化 Agent。

        Args:
            include_tools: 指定工具池子集 (SubAgent 独立工具池)。
                           None = 使用全部内置 + Skill + 多 Agent 工具。
            mcp_tools: 外部提供的 MCP 工具 (SubAgent 复用主 Agent 的连接)。
                       None = 主动连接 MCP。
        """
        # 初始化 LLM (主模型，带工具绑定)
        self.llm = ChatOpenAI(
            model=Config.OPENAI_MODEL,
            base_url=Config.OPENAI_BASE_URL,
            api_key=Config.OPENAI_API_KEY,
            temperature=0.2,
        )

        # 摘要 LLM (用同一模型，无工具)
        self._summary_llm = ChatOpenAI(
            model=Config.OPENAI_MODEL,
            base_url=Config.OPENAI_BASE_URL,
            api_key=Config.OPENAI_API_KEY,
            temperature=0.0,
        )

        # 当前工作空间 (随 /cd 与各轮次更新, 供 SubAgent 继承)
        self.workspace_dir: str = ""

        # 动态工具组合: 内置 + Skills + 多Agent + MCP (MCP 连接失败不影响启动)
        self.mcp_status: dict[str, str] = {}
        if mcp_tools is None:
            # 主 Agent: 主动连接 MCP
            try:
                self.mcp_status = mcp_manager.connect()
            except Exception as exc:
                print(f"[VCA] MCP 连接失败: {type(exc).__name__}: {exc}")
            self._mcp_tools = list(mcp_manager.tools)
            # 注册到 SubAgent 管理器 (供子代理复用 MCP 工具)
            try:
                from ..subagents.manager import get_manager
                get_manager().attach(self)
            except Exception:
                pass
        else:
            # SubAgent: 复用主 Agent 的 MCP 工具
            self._mcp_tools = list(mcp_tools)

        if include_tools is not None:
            # SubAgent 独立工具池: 指定工具 + 复用 MCP 工具
            self._all_tools = list(include_tools) + list(self._mcp_tools)
        else:
            self._all_tools = ALL_TOOLS + list(self._mcp_tools)
        self._executable_tools = [t for t in self._all_tools if t.name != "ask_user"]

        # 绑定工具到 LLM
        self.llm_with_tools = self.llm.bind_tools(self._all_tools)

        # 可执行工具节点 (不含 ask_user，它需要特殊处理)
        self._executable_tool_node = ToolNode(self._executable_tools)

        # 构建工作流图
        self.graph = self._build_graph()

    # --------------------------------------------------------
    # 上下文裁剪  (含 LLM 语义摘要)
    # --------------------------------------------------------

    def _summarize_history(self, dropped: list[BaseMessage], prior_summary: str = "") -> str:
        """
        调用 LLM 对被裁剪的消息生成语义摘要。

        Args:
            dropped: 被裁剪掉的消息列表
            prior_summary: 之前累积的摘要 (多次裁剪时合并)

        Returns:
            一段简洁的语义摘要
        """
        transcript = _messages_to_text(dropped)

        # 限制摘要输入的 token 量 (防止摘要请求本身就超限)
        if _estimate_tokens(transcript) > 15000:
            transcript = transcript[:15000 * 3]  # ~15000 tokens worth of chars

        prompt = f"""请用中文对以下对话历史生成一段简洁的语义摘要。

规则:
- 提取关键信息: 用户问了什么，你做了什么，产生了什么结果
- 保留具体的文件名、路径、命令等关键参数
- 忽略工具执行的冗长原始输出，只提炼结论
- 控制在 300 字以内
- 如果已有之前的摘要，请合并

{prior_summary}

--- 需要摘要的对话 ---
{transcript}
--- 结束 ---

请直接输出摘要，不要加 "以下是摘要" 等前缀。"""

        try:
            response = self._summary_llm.invoke(prompt)
            summary = str(response.content).strip()
            return summary
        except Exception as exc:
            # 摘要失败时降级为规则提取
            print(f"[VCA] LLM 摘要生成失败 ({type(exc).__name__})，使用规则提取替代")
            parts: list[str] = []
            for msg in dropped:
                if isinstance(msg, HumanMessage):
                    parts.append(f"用户: {str(msg.content)[:80]}")
                elif isinstance(msg, AIMessage) and not msg.tool_calls and msg.content:
                    parts.append(f"Agent: {str(msg.content)[:120]}")
            return "\n".join(parts[:20])

    def _trim_context(self, state: AgentState, max_tokens: int, keep_turns: int = 8) -> list[BaseMessage]:
        """
        上下文裁剪 含 LLM 语义摘要。

        规则:
        1. system prompt 始终保留
        2. 压缩长工具结果 (>600 字符)
        3. 仍超限则按 user 对话轮次裁剪，保留最近 keep_turns 轮
        4. 被裁剪的轮次 → LLM 生成语义摘要 → 累积到 state.summary_history
        5. 如果有累积摘要，注入为一条 SystemMessage

        Returns:
            裁剪后的消息列表
        """
        messages = state["messages"]
        if not messages:
            return messages

        sys_msg = messages[0] if isinstance(messages[0], SystemMessage) else None
        body = messages[1:] if sys_msg else messages
        if not body:
            return messages

        # Step 1: 压缩工具结果
        for i, msg in enumerate(body):
            if isinstance(msg, ToolMessage) and len(str(msg.content)) > 600:
                old_content = str(msg.content)
                body[i] = ToolMessage(
                    content=old_content[:500] + f"\n... (原始输出 {len(old_content)} 字符已被截断)",
                    tool_call_id=msg.tool_call_id,
                    name=getattr(msg, "name", ""),
                )

        # Step 2: 估算总 token
        total = (_message_tokens(sys_msg) if sys_msg else 0) + sum(_message_tokens(m) for m in body)
        prior = state.get("summary_history", "")
        if prior:
            total += _estimate_tokens(prior)
        if total <= max_tokens:
            # 没超限
            result = [sys_msg] + body if sys_msg else body
            if prior:
                result.insert(1 if sys_msg else 0, SystemMessage(content=f"📋 [历史摘要]\n{prior}"))
            return result

        # Step 3: 按用户轮次裁剪
        turn_boundaries: list[int] = []
        for i, msg in enumerate(body):
            if isinstance(msg, HumanMessage):
                turn_boundaries.append(i)

        if len(turn_boundaries) <= keep_turns:
            # 轮次不多 说明是工具结果太大，激进压缩
            for i, msg in enumerate(body):
                if isinstance(msg, ToolMessage) and len(str(msg.content)) > 300:
                    old_content = str(msg.content)
                    body[i] = ToolMessage(
                        content=old_content[:200] + f"\n... (原始 {len(old_content)} 字符被截断)",
                        tool_call_id=msg.tool_call_id,
                        name=getattr(msg, "name", ""),
                    )
            result = [sys_msg] + body if sys_msg else body
            if prior:
                result.insert(1 if sys_msg else 0, SystemMessage(content=f"📋 [历史摘要]\n{prior}"))
            return result

        # 保留最后 keep_turns 轮
        trim_idx = turn_boundaries[-(keep_turns)]
        dropped = body[:trim_idx]
        kept = body[trim_idx:]

        # Step 4: LLM 生成语义摘要
        new_summary = self._summarize_history(dropped, prior_summary=prior)
        # 累积到 state (下次裁剪时会合并)
        state["summary_history"] = new_summary

        # 注入摘要
        kept.insert(0, SystemMessage(content=f"📋 [历史摘要]\n{new_summary}"))

        return ([sys_msg] if sys_msg else []) + kept

    # --------------------------------------------------------
    # 节点定义
    # --------------------------------------------------------

    def _agent_node(self, state: AgentState) -> dict:
        """
        Agent 节点: 调用 LLM 决定下一步行动。
        """
        messages = state["messages"]
        workspace = state["workspace_dir"]

        # 记录当前工作空间 + 同步当前线程的逻辑工作目录 (多 Agent 环境隔离的关键)
        self.workspace_dir = workspace
        workspace_ctx.set_workspace(workspace)

        if not messages or not isinstance(messages[0], SystemMessage):
            system_msg = SystemMessage(content=make_system_prompt(workspace))
            messages = [system_msg] + list(messages)

        # 上下文裁剪
        trimmed = self._trim_context(
            state,
            max_tokens=self._MAX_CONTEXT_TOKENS,
            keep_turns=8,
        )

        # 调用 LLM 并统计 token 与耗时
        start_time = time.perf_counter()
        response = self.llm_with_tools.invoke(trimmed)
        elapsed_ms = (time.perf_counter() - start_time) * 1000

        usage = _extract_token_usage(response)
        usage["duration_ms"] = elapsed_ms

        return {"messages": [response], "llm_usage": usage}

    # --------------------------------------------------------
    # 条件路由 (保持不变)
    # --------------------------------------------------------

    def _should_continue(self, state: AgentState) -> Literal["tools", "ask_user", "respond"]:
        """
        条件边: 判断下一步走向。

        - ask_user 工具调用 → 走 ask_user 节点 (暂停等用户回答)
        - 其他工具调用 → 走 tools 节点
        - 无工具调用 → 走 respond 节点 (结束)
        """
        last_message = state["messages"][-1]

        if isinstance(last_message, AIMessage) and last_message.tool_calls:
            for tc in last_message.tool_calls:
                if tc.get("name") == "ask_user":
                    return "ask_user"
            return "tools"
        return "respond"

    def _tool_node(self, state: AgentState) -> dict:
        """
        工具执行节点: 执行 LLM 请求的工具调用 (不含 ask_user)。
        """
        # 确保工具在正确的逻辑工作目录下执行
        ws = state.get("workspace_dir")
        if ws:
            self.workspace_dir = ws
            workspace_ctx.set_workspace(ws)

        # 记录工具执行耗时
        start_time = time.perf_counter()
        result = self._executable_tool_node.invoke(state)
        elapsed_ms = (time.perf_counter() - start_time) * 1000

        tool_count = len(result.get("messages", []))
        result["tool_usage"] = {
            "count": tool_count,
            "duration_ms": elapsed_ms,
        }
        return result

    def _ask_user_node(self, state: AgentState) -> dict:
        """
        AskUser 节点: 拦截 ask_user 调用，将问题信息存入状态，
        等待主循环中的用户交互。

        不在这里弹出 UI —— 只记录数据，由 main.py 的 run_agent 处理。
        """
        last_message = state["messages"][-1]
        if not isinstance(last_message, AIMessage) or not last_message.tool_calls:
            return {"pending_question": None}

        for tc in last_message.tool_calls:
            if tc.get("name") != "ask_user":
                continue

            args = tc.get("args", {})
            question = args.get("question", "")
            header = args.get("header", "确认")
            options_raw = str(args.get("options", "")).strip()

            # 解析 options: "A|B|C" 或 "[可多选] A|B|C"
            is_multi = False
            if options_raw.startswith("[可多选]") or options_raw.startswith("[多选]"):
                is_multi = True
                options_raw = options_raw.split("]", 1)[-1].strip()
            elif options_raw.startswith("[multi]"):
                is_multi = True
                options_raw = options_raw[7:].strip()

            option_list = [o.strip() for o in options_raw.split("|") if o.strip()]

            return {
                "pending_question": {
                    "header": header,
                    "question": question,
                    "options": option_list,
                    "is_multi": is_multi,
                    "tool_call_id": tc.get("id", ""),
                },
                # 同时添加一条占位消息，让 stream 循环能进入下一个节点
                "messages": [
                    ToolMessage(
                        content="[AWAITING_USER_INPUT]",
                        tool_call_id=tc.get("id", ""),
                        name="ask_user",
                    )
                ],
            }

        return {"pending_question": None}

    def _respond_node(self, state: AgentState) -> dict:
        """
        响应节点: 提取 LLM 的最终回复，并更新迭代计数。
        """
        last_message = state["messages"][-1]
        final_text = ""
        if isinstance(last_message, AIMessage):
            final_text = last_message.content if last_message.content else "(空响应)"

        return {
            "final_response": final_text,
            "iteration": state.get("iteration", 0) + 1,
        }

    # --------------------------------------------------------
    # 构建图
    # --------------------------------------------------------

    def _build_graph(self) -> StateGraph:
        """构建 LangGraph 状态图"""
        workflow = StateGraph(AgentState)

        # 添加节点
        workflow.add_node("agent", self._agent_node)
        workflow.add_node("tools", self._tool_node)
        workflow.add_node("ask_user", self._ask_user_node)
        workflow.add_node("respond", self._respond_node)

        # 设置入口
        workflow.set_entry_point("agent")

        # agent → tools / ask_user / respond (三路分支)
        workflow.add_conditional_edges(
            "agent",
            self._should_continue,
            {
                "tools": "tools",
                "ask_user": "ask_user",
                "respond": "respond",
            },
        )

        # tools → agent (循环)
        workflow.add_edge("tools", "agent")

        # ask_user → respond (暂停后直接结束，由主循环处理用户回答后再重新进入)
        workflow.add_edge("ask_user", "respond")

        # respond → END
        workflow.add_edge("respond", END)

        return workflow.compile()

    # --------------------------------------------------------
    # 公共接口
    # --------------------------------------------------------

    def get_graph(self) -> StateGraph:
        """获取编译后的图"""
        return self.graph

    def invoke(self, state: AgentState) -> dict:
        """运行一次完整对话"""
        return self.graph.invoke(state)

    async def ainvoke(self, state: AgentState) -> dict:
        """异步运行一次完整对话"""
        return await self.graph.ainvoke(state)

    def stream(self, state: AgentState) -> any:
        """流式运行，返回中间步骤"""
        return self.graph.stream(state)


def create_coding_agent() -> CodingAgent:
    """工厂函数: 创建编码 Agent 实例"""
    Config.validate()
    return CodingAgent()
