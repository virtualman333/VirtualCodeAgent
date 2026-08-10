"""LangGraph 工作流 - 基于 ReAct 模式的编码 Agent"""

from __future__ import annotations

from typing import Literal

from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode
from langchain_openai import ChatOpenAI
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from ..state import AgentState
from ..config import Config
from ..tools import ALL_TOOLS

# ============================================================
# 系统提示词
# ============================================================

SYSTEM_PROMPT = """你是一个控制台编码 Agent，帮助用户完成编程任务。

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

## 工作规则
1. 在执行文件操作前，先用 Glob/Grep 了解项目结构
2. 写代码: 大文件用 Write，小改动用 Edit
3. 搜索代码: 找文件名用 Glob，找内容用 Grep
4. 修改代码: 先用 Read 确认内容 → 再用 Edit 精确替换
5. 写入文件后，用 Bash 运行测试/构建验证结果
6. 遇到错误时分析原因并尝试修复
7. 每个响应只调用一个工具，或一次性完成不依赖前序结果的工具链

## 工作空间
{workspace_dir}

请用中文回复用户。"""
# ============================================================


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

        # 将工具绑定到 LLM
        self.llm_with_tools = self.llm.bind_tools(ALL_TOOLS)

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
            system_msg = SystemMessage(
                content=SYSTEM_PROMPT.format(workspace_dir=workspace)
            )
            messages = [system_msg] + list(messages)

        # 调用 LLM
        response = self.llm_with_tools.invoke(messages)

        return {"messages": [response]}

    def _should_continue(self, state: AgentState) -> Literal["tools", "respond"]:
        """
        条件边: 判断是继续调用工具还是结束。

        - 如果最后一条消息包含 tool_calls -> 执行工具
        - 否则 -> 直接响应
        """
        last_message = state["messages"][-1]

        if isinstance(last_message, AIMessage) and last_message.tool_calls:
            return "tools"
        return "respond"

    def _tool_node(self, state: AgentState) -> dict:
        """
        工具执行节点: 使用 ToolNode 执行 LLM 请求的工具调用。
        """
        tool_node = ToolNode(ALL_TOOLS)
        result = tool_node.invoke(state)
        return result

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
        workflow.add_node("respond", self._respond_node)

        # 设置入口
        workflow.set_entry_point("agent")

        # agent -> tools 或 respond
        workflow.add_conditional_edges(
            "agent",
            self._should_continue,
            {
                "tools": "tools",
                "respond": "respond",
            },
        )

        # tools -> agent (循环)
        workflow.add_edge("tools", "agent")

        # respond -> END
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
