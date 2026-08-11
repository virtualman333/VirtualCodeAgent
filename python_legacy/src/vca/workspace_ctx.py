"""线程隔离的工作目录上下文 - 支持多 Agent 环境隔离

多个 Agent (主 Agent + SubAgent) 可能同时运行在不同的工作目录中。
由于 Python 进程只有一个当前目录 (os.getcwd)，直接 os.chdir 会互相干扰。

本模块利用 contextvars 提供线程/协程隔离的"逻辑工作目录":
- 每个线程拥有独立的上下文副本，互不干扰
- bash/read/write/edit/search 等工具读取当前线程的工作目录
- 未设置时回退到 os.getcwd() (主 Agent 默认行为不变)
"""

from __future__ import annotations

import contextvars
import os

# 当前线程的逻辑工作目录; None 表示回退到 os.getcwd()
_current_workspace: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "vca_workspace",
    default=None,
)


def set_workspace(path: str) -> None:
    """设置当前线程/协程的逻辑工作目录"""
    _current_workspace.set(os.path.abspath(path))


def get_workspace() -> str | None:
    """获取当前线程/协程的逻辑工作目录; 未设置返回 None"""
    return _current_workspace.get()


def reset_workspace() -> None:
    """清除当前线程/协程的逻辑工作目录 (回退到 os.getcwd())"""
    _current_workspace.set(None)


def resolve_path(path: str) -> str:
    """
    将相对路径解析为绝对路径。

    解析顺序:
    1. 绝对路径 → 直接返回
    2. 已存在的相对路径 → 基于逻辑工作目录解析
    3. 其他 → 基于逻辑工作目录拼接

    Args:
        path: 待解析路径

    Returns:
        绝对路径
    """
    if os.path.isabs(path):
        return path
    base = get_workspace() or os.getcwd()
    return os.path.join(base, path)
