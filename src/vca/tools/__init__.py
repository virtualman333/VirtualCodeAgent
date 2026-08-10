"""Agent 工具集 — 内置工具 + 动态扩展"""

# 📖 阅读与理解
from .read_tool import read_file

# 🔍 搜索
from .search_tools import glob_files, grep_content

# ✏️ 编写与修改
from .edit_tool import edit_file
from .write_tool import write_file

# ▶️ 执行与验证
from .bash_tool import bash

# 💬 用户交互
from .ask_user_tool import ask_user

# 🎯 Skills (可插拔专业技能)
from ..skills.manager import list_skills, load_skill

# 🤝 多 Agent (SubAgent 编排)
from ..subagents.tools import create_agent, get_agent_result, list_agents, delete_agent

__all__ = [
    "read_file",
    "glob_files",
    "grep_content",
    "edit_file",
    "write_file",
    "bash",
    "ask_user",
    "list_skills",
    "load_skill",
    "create_agent",
    "get_agent_result",
    "list_agents",
    "delete_agent",
]

# 内置工具 (固定注册)
BUILTIN_TOOLS = [
    read_file,
    glob_files,
    grep_content,
    edit_file,
    write_file,
    bash,
    ask_user,
]

# Skill 工具
SKILL_TOOLS = [list_skills, load_skill]

# 多 Agent 工具
AGENT_TOOLS = [create_agent, get_agent_result, list_agents, delete_agent]

# 全部工具注册给 LangGraph 使用 (MCP 工具由工作流动态追加)
ALL_TOOLS = BUILTIN_TOOLS + SKILL_TOOLS + AGENT_TOOLS

# 可执行工具 (不含 ask_user，它需要特殊拦截)
EXECUTABLE_TOOLS = [t for t in ALL_TOOLS if t.name != "ask_user"]
