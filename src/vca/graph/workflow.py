"""LangGraph 工作流 - 基于 ReAct 模式的编码 Agent"""

from __future__ import annotations

import os
import platform
import sys
from typing import Literal

from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode
from langchain_openai import ChatOpenAI
from langchain_core.messages import AIMessage, SystemMessage

from ..state import AgentState
from ..config import Config
from ..tools import ALL_TOOLS, EXECUTABLE_TOOLS

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

请用中文回复用户。"""


def make_system_prompt(workspace_dir: str) -> str:
    """根据运行时环境动态生成 system prompt"""
    env_info = _ENV_INFO.format(workspace_dir=workspace_dir)
    return _SYSTEM_PROMPT_TEMPLATE.format(env_info=env_info)


class CodingAgent:
    """基于 LangGraph ReAct 模式的编码 Agent"""

    def __init__(self) -> None:
        # 初始化 LLM
        self.llm = ChatOpenAI(
            model=Config.OPENAI_MODEL,
            base_url=Config.OPENAI_BASE_URL,
            api_key=Config.OPENAI_API_KEY,
            temperature=0.2,
        )

        # 将全部工具绑定到 LLM (含 ask_user)
        self.llm_with_tools = self.llm.bind_tools(ALL_TOOLS)

        # 可执行工具 (不含 ask_user，它需要特殊处理)
        self._executable_tool_node = ToolNode(EXECUTABLE_TOOLS)

        # 构建工作流图
        self.graph = self._build_graph()

    # --------------------------------------------------------
    # 节点定义
    # --------------------------------------------------------

    def _agent_node(self, state: AgentState) -> dict:
        """
        Agent 节点: 调用 LLM 决定下一步行动。
        LLM 可以:
        - 调用工具 (返回 tool_calls)
        - 直接回复 (返回纯文本)
        """
        messages = state["messages"]
        workspace = state["workspace_dir"]

        # 确保 system prompt 存在
        if not messages or not isinstance(messages[0], SystemMessage):
            system_msg = SystemMessage(content=make_system_prompt(workspace))
            messages = [system_msg] + list(messages)

        # 调用 LLM
        response = self.llm_with_tools.invoke(messages)

        return {"messages": [response]}

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
        result = self._executable_tool_node.invoke(state)
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
