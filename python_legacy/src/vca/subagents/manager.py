"""SubAgent 管理器 - 子代理生命周期管理

职责:
- 创建子代理 (独立 system prompt / 对话历史 / 工具池 / 工作目录)
- 同步模式: 在当前线程运行并返回结果
- 后台模式: 独立线程异步运行, 结果写入文件系统信箱
- 多个无依赖子任务可并行运行 (各自独立线程)
- 复用主 Agent 的 MCP 工具 (避免重复连接)
"""

from __future__ import annotations

import os
import platform
import sys
import threading
import time
import uuid
from typing import Any

from langchain_core.messages import SystemMessage, HumanMessage

from .. import workspace_ctx
from ..state import create_initial_state
from . import mailbox
from .types import SubAgent

# 子代理环境信息模板
_SUB_ENV_INFO = """## 当前运行环境
- 操作系统: {os}
- Shell: {shell}
- Python: {python}
- 工作目录: {workspace_dir}
"""


def _build_system_prompt(task: str, instructions: str, workspace_dir: str) -> str:
    """构建子代理的独立 system prompt"""
    env_info = _SUB_ENV_INFO.format(
        os=f"{platform.system()} {platform.release()} ({platform.machine()})",
        shell=os.environ.get("SHELL", os.environ.get("COMSPEC", "unknown")),
        python=sys.version.split()[0],
        workspace_dir=workspace_dir,
    )

    lines = [
        "你是一个专注于特定子任务的 SubAgent，由主 Agent 创建并指挥。",
        "",
        "## 你的任务",
        task,
        "",
        "## 工作规则",
        "1. 只专注于完成上面分配的子任务，不要做超出任务范围的事",
        "2. 独立完成工作：自己读文件、改代码、跑命令，不要假设主 Agent 会帮你",
        "3. 遇到可以自行判断的小问题直接解决，不要反复确认",
        "4. 工作空间根目录是子任务的唯一操作范围，不要访问无关目录",
        "5. 完成后用中文简要汇报，内容应包含：",
        "   - 做了什么（关键文件/命令）",
        "   - 结果如何（成功/失败/验证方式）",
        "   - 主 Agent 后续可能需要的关键信息（文件路径、端口、接口等）",
        "6. 汇报务必精简，主 Agent 只需要与主线任务相关的必要信息",
        "",
        "## 可用的工具",
        "使用工具独立完成子任务。工具清单与说明由系统提供，按需调用。",
        "",
        env_info,
        "请用中文回复。",
    ]

    if instructions and instructions.strip():
        lines.insert(3, f"## 主 Agent 补充指令\n{instructions.strip()}")

    return "\n".join(lines)


def _filter_tools(tool_names: str) -> list[Any]:
    """
    根据工具名列表过滤工具池。

    - 空字符串: 使用全部默认工具 (不含 ask_user)
    - 逗号分隔的工具名: 只保留指定工具
    - ask_user 始终排除 (后台子代理无法向用户提问)
    """
    # 延迟导入，避免与 tools/__init__ 循环依赖
    from ..tools import ALL_TOOLS

    default_names = [t.name for t in ALL_TOOLS if t.name != "ask_user"]
    all_names = {t.name for t in ALL_TOOLS}

    if not tool_names or not tool_names.strip():
        names = default_names
    else:
        names = [n.strip() for n in tool_names.split(",") if n.strip()]
        names = [n for n in names if n in all_names and n != "ask_user"]

    if not names:
        names = default_names

    return [t for t in ALL_TOOLS if t.name in names]


class SubAgentManager:
    """子代理生命周期管理器 (进程内单例)"""

    def __init__(self) -> None:
        self._agents: dict[str, SubAgent] = {}
        self._lock = threading.RLock()
        # 主 Agent 引用 (用于复用其 MCP 工具)
        self._parent: Any = None

    # --------------------------------------------------------
    # 主 Agent 绑定
    # --------------------------------------------------------

    def attach(self, agent: Any) -> None:
        """绑定主 Agent (其 MCP 工具可被子代理复用)"""
        self._parent = agent

    def _parent_mcp_tools(self) -> list[Any]:
        """获取主 Agent 已连接的 MCP 工具"""
        try:
            if self._parent is not None:
                tools = getattr(self._parent, "_mcp_tools", []) or []
                return list(tools)
        except Exception:
            pass
        return []

    # --------------------------------------------------------
    # 注册 / 查询
    # --------------------------------------------------------

    def _register(self, agent: SubAgent) -> None:
        with self._lock:
            self._agents[agent.id] = agent

    def get(self, agent_id: str) -> SubAgent | None:
        with self._lock:
            return self._agents.get(agent_id)

    def list(self) -> list[SubAgent]:
        with self._lock:
            return list(self._agents.values())

    def remove(self, agent_id: str) -> bool:
        with self._lock:
            agent = self._agents.pop(agent_id, None)
        # 同步清理文件系统信箱
        mailbox.remove(agent_id)
        return agent is not None

    # --------------------------------------------------------
    # 创建子代理
    # --------------------------------------------------------

    def create(
        self,
        task: str,
        name: str = "",
        instructions: str = "",
        wait: bool = False,
        tools: str = "",
        workspace: str = "",
    ) -> str:
        """
        创建一个子代理并运行。

        Args:
            task: 子任务描述 (必填)
            name: 子代理名称
            instructions: 主 Agent 补充指令
            wait: True = 同步等待结果; False = 后台运行立即返回 agent_id
            tools: 工具池过滤 (逗号分隔的工具名), 空 = 全部默认工具
            workspace: 子代理工作目录, 空 = 继承主 Agent 工作空间

        Returns:
            给主 Agent 的文本反馈
        """
        if not task or not task.strip():
            return "[ERROR] create_agent 需要一个 task 参数来描述子任务"

        # 确定工作目录 (继承父工作空间)
        base_ws = ""
        try:
            if self._parent is not None:
                base_ws = getattr(self._parent, "workspace_dir", "") or ""
        except Exception:
            pass
        if not base_ws:
            base_ws = workspace_ctx.get_workspace() or "."

        sub_workspace = workspace.strip() if workspace and workspace.strip() else base_ws
        sub_workspace = os.path.abspath(sub_workspace)
        if not os.path.isdir(sub_workspace):
            try:
                os.makedirs(sub_workspace, exist_ok=True)
            except Exception:
                sub_workspace = os.path.abspath(base_ws)

        agent_id = self._new_id()
        display_name = name.strip() or agent_id

        agent = SubAgent(
            id=agent_id,
            name=display_name,
            task=task.strip(),
            system_prompt=_build_system_prompt(task.strip(), instructions, sub_workspace),
            workspace_dir=sub_workspace,
            tool_names=[t.name for t in _filter_tools(tools)],
            mode="sync" if wait else "background",
        )
        self._register(agent)

        if wait:
            self._run_sync(agent)
            return (
                f"[OK] SubAgent '{display_name}' ({agent_id}) 已完成。\n"
                f"───── 子任务结果 ─────\n"
                f"{agent.result or '(无结果)'}"
            )

        # 后台模式
        self._start_background(agent)
        return (
            f"[OK] 已创建 SubAgent '{display_name}' ({agent_id})，正在后台独立运行。\n"
            f"工作目录: {agent.workspace_dir}\n"
            f"工具池: {', '.join(agent.tool_names) or '(默认)'}\n"
            f"可稍后用 get_agent_result(agent_id='{agent_id}') 获取结果，"
            f"或 list_agents() 查看状态。"
        )

    def _new_id(self) -> str:
        ts = time.strftime("%H%M%S")
        suffix = uuid.uuid4().hex[:6]
        return f"sub_{ts}_{suffix}"

    # --------------------------------------------------------
    # 执行
    # --------------------------------------------------------

    def _start_background(self, agent: SubAgent) -> threading.Thread:
        """后台线程方式启动子代理 (可并行)"""
        t = threading.Thread(
            target=self._execute,
            args=(agent,),
            name=f"subagent-{agent.id}",
            daemon=True,
        )
        agent.thread = t
        t.start()
        return t

    def _run_sync(self, agent: SubAgent) -> None:
        """同步运行子代理 (阻塞当前工具调用线程)"""
        self._execute(agent)

    def _execute(self, agent: SubAgent) -> None:
        """
        执行子代理的主循环 (Agent Loop)。

        每个子代理:
        - 拥有独立的 AgentState (对话历史)
        - 拥有独立的工具池 (CodingAgent include_tools)
        - 工作在线程隔离的工作目录中
        """
        from ..graph.workflow import CodingAgent

        agent.status = "running"
        agent.result = ""
        agent.error = ""

        # 记录进入前的工作目录 (同步模式下执行后需要恢复，避免影响父线程)
        prev_workspace = workspace_ctx.get_workspace()

        # 设置线程隔离的工作目录 (bash/read/write 等工具按此目录解析)
        workspace_ctx.set_workspace(agent.workspace_dir)

        try:
            agent_inst = CodingAgent(
                include_tools=_filter_tools(",".join(agent.tool_names)),
                mcp_tools=self._parent_mcp_tools(),
            )

            # 独立的对话历史: 自己的 system prompt + 任务
            state = create_initial_state(agent.workspace_dir)
            state["messages"] = [
                SystemMessage(content=agent.system_prompt),
                HumanMessage(content=agent.task),
            ]
            agent.state = state

            final = agent_inst.graph.invoke(state)

            final_text = final.get("final_response", "") or "(无输出)"
            agent.result = final_text.strip()
            agent.status = "completed"
        except Exception as exc:
            agent.status = "failed"
            agent.error = f"{type(exc).__name__}: {exc}"
            agent.result = f"[ERROR] SubAgent 执行失败: {agent.error}"
        finally:
            agent.finished_at = time.time()
            # 写入文件系统信箱 (后台 Agent 结果传递)
            mailbox.save(agent)
            # 恢复之前的工作目录上下文
            if prev_workspace:
                workspace_ctx.set_workspace(prev_workspace)
            else:
                workspace_ctx.reset_workspace()

    # --------------------------------------------------------
    # 结果查询
    # --------------------------------------------------------

    def wait_result(self, agent_id: str, timeout: int = 60) -> SubAgent:
        """
        等待子代理完成并返回最新状态。

        先从内存取 (运行中的代理), 内存没有则从文件系统信箱恢复。
        等待期间最多阻塞 timeout 秒。
        """
        deadline = time.time() + max(0, timeout)
        agent = self.get(agent_id)

        if agent is None:
            # 尝试从文件系统信箱恢复 (主 Agent 重启后的场景)
            restored = mailbox.load(agent_id)
            if restored is None:
                return SubAgent(
                    id=agent_id, name=agent_id, task="", system_prompt="",
                    workspace_dir="", tool_names=[], mode="sync",
                    status="failed",
                    error=f"SubAgent '{agent_id}' 不存在",
                )
            # 恢复回内存 (便于后续继续查询)
            self._register(restored)
            agent = restored

        # 等待完成
        while not agent.is_finished and time.time() < deadline:
            time.sleep(0.5)
            fresh = self.get(agent_id)
            if fresh is not None:
                agent = fresh

        return agent

    # --------------------------------------------------------
    # 汇总
    # --------------------------------------------------------

    def overview(self) -> str:
        """生成所有子代理的状态概览"""
        mem = self.list()
        disk = mailbox.list_agents()

        # 合并内存 + 磁盘 (去重)
        seen: set[str] = set()
        merged: list[SubAgent] = []
        for a in mem + disk:
            if a.id in seen:
                continue
            seen.add(a.id)
            merged.append(a)

        if not merged:
            return "[INFO] 当前没有任何 SubAgent"

        lines = [f"[OK] 共 {len(merged)} 个 SubAgent:"]
        for a in merged:
            dur = ""
            if a.finished_at:
                dur = f" (耗时 {a.finished_at - a.created_at:.1f}s)"
            lines.append(f"  - {a.status_line()}{dur}")
            if a.result and a.status in ("completed", "failed"):
                brief = a.result.replace("\n", " ")[:120]
                lines.append(f"      结果: {brief}")
            if a.error:
                lines.append(f"      错误: {a.error}")
        return "\n".join(lines)


# 进程内单例
_manager: SubAgentManager | None = None
_manager_lock = threading.Lock()


def get_manager() -> SubAgentManager:
    """获取全局 SubAgentManager 单例"""
    global _manager
    if _manager is None:
        with _manager_lock:
            if _manager is None:
                _manager = SubAgentManager()
    return _manager
