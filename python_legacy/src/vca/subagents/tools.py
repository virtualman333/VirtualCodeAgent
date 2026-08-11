"""AgentTool 工具集 - 主 Agent 通过它们创建与管理 SubAgent

注册给主 Agent LLM 的工具:
- create_agent:        创建并启动子代理 (同步或后台)
- get_agent_result:    获取子代理执行结果 (可等待)
- list_agents:         列出所有子代理状态
- delete_agent:        删除子代理记录
"""

from __future__ import annotations

import time

from langchain_core.tools import tool

from .manager import get_manager
from . import mailbox


@tool
def create_agent(
    task: str,
    name: str = "",
    instructions: str = "",
    wait: bool = False,
    tools: str = "",
    workspace: str = "",
) -> str:
    """
    创建一个独立的 SubAgent 来处理子任务，实现任务分派与并行执行。

    每个 SubAgent 拥有独立的对话历史、system prompt、工具池和隔离的工作目录，
    适合将大任务拆解为多个可独立完成的子任务并行处理。

    两种运行模式:
    - 后台模式 (wait=False, 默认): 立即返回 agent_id，SubAgent 在后台线程独立运行，
      不会阻塞你处理主线任务。之后用 get_agent_result 获取结果。
      对于相互独立的多个子任务，可以连续创建多个后台 SubAgent 并行执行。
    - 同步模式 (wait=True): 阻塞等待该 SubAgent 完成，直接返回其精简结果。
      适用于子任务结果立即影响后续决策的场景。

    编排建议:
    - 将长 prompt / 大段上下文拆给子代理，只取回精简结果，避免污染主线上下文
    - 有依赖关系的任务用同步模式串行；无依赖的任务用后台模式并行
    - 子任务应尽可能独立、边界清晰，避免多个子代理写同一文件

    Args:
        task: 子任务描述。应足够详细，使子代理无需向主 Agent 提问即可独立完成
        name: 子代理名称（用于区分，可省略）
        instructions: 补充指令，进一步约束子代理的行为或输出格式
        wait: True=同步等待并返回结果；False=后台运行立即返回 agent_id
        tools: 子代理工具池过滤，逗号分隔的工具名（如 "read_file,write_file,bash"）。
               留空使用全部默认工具。ask_user 始终不可用。
        workspace: 子代理的工作目录。留空继承当前工作空间。
                   SubAgent 的所有文件操作和命令都基于该目录，实现环境隔离。

    Returns:
        后台模式: agent_id 与运行信息
        同步模式: 子任务的精简结果
    """
    return get_manager().create(
        task=task,
        name=name,
        instructions=instructions,
        wait=wait,
        tools=tools,
        workspace=workspace,
    )


@tool
def get_agent_result(agent_id: str, timeout: int = 60) -> str:
    """
    获取 SubAgent 的执行结果。

    - 已完成: 立即返回精简结果
    - 仍在运行: 阻塞等待，最多等待 timeout 秒
    - 不存在: 尝试从文件系统信箱恢复（重启后依然有效）

    Args:
        agent_id: 创建 SubAgent 时返回的 ID
        timeout: 最长等待秒数，默认 60

    Returns:
        子代理的精简结果或状态说明
    """
    agent = get_manager().wait_result(agent_id, timeout=timeout)

    if agent.is_finished:
        lines = [
            f"[OK] SubAgent '{agent.name}' ({agent.id}) 状态: {agent.status}",
        ]
        if agent.result:
            lines.append(f"结果:\n{agent.result}")
        if agent.error:
            lines.append(f"错误: {agent.error}")
        return "\n".join(lines)

    return (
        f"[INFO] SubAgent '{agent.name}' ({agent.id}) 仍在运行中。\n"
        f"可再次调用 get_agent_result 获取最新结果。"
    )


@tool
def list_agents() -> str:
    """
    列出所有已创建的 SubAgent 及其状态。

    包含当前内存中运行的代理和文件系统信箱中已完成的代理。
    状态: pending(等待) / running(运行中) / completed(完成) / failed(失败)

    Returns:
        子代理列表（ID、名称、状态、耗时、结果摘要）
    """
    return get_manager().overview()


@tool
def delete_agent(agent_id: str) -> str:
    """
    删除一个 SubAgent 的记录（内存 + 文件系统信箱）。

    仅清理记录，不会中断仍在运行的子代理，也不会删除它产生的文件。

    Args:
        agent_id: 要删除的 SubAgent ID

    Returns:
        删除结果
    """
    removed = get_manager().remove(agent_id)
    if removed:
        return f"[OK] 已删除 SubAgent '{agent_id}'"
    # 尝试只清理信箱
    if mailbox.remove(agent_id):
        return f"[OK] 已删除 SubAgent '{agent_id}' 的信箱记录"
    return f"[ERROR] SubAgent '{agent_id}' 不存在"


# 注册给主 Agent 的工具列表
AGENT_TOOLS = [create_agent, get_agent_result, list_agents, delete_agent]
