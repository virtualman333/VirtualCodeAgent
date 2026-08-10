"""Agent 工具集 — 7 个核心工具"""

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

__all__ = [
    "read_file",
    "glob_files",
    "grep_content",
    "edit_file",
    "write_file",
    "bash",
    "ask_user",
]

# 所有工具注册给 LangGraph 使用
ALL_TOOLS = [
    read_file,
    glob_files,
    grep_content,
    edit_file,
    write_file,
    bash,
    ask_user,
]

# 可执行工具 (不含 ask_user，它需要特殊拦截)
EXECUTABLE_TOOLS = [
    read_file,
    glob_files,
    grep_content,
    edit_file,
    write_file,
    bash,
]
