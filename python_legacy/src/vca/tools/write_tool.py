"""Write 工具 - 创建新文件或完全重写"""

from __future__ import annotations

import os
from langchain_core.tools import tool

from ..workspace_ctx import resolve_path


@tool
def write_file(path: str, content: str) -> str:
    """
    创建新文件或完全重写现有文件。

    如果目录不存在会自动递归创建。
    如果文件已存在，会完全覆盖其内容。

    对比 Edit:
    - Write: 全量替换，适合创建新文件或大幅修改
    - Edit: 精确替换片段，适合小范围修改

    Args:
        path: 文件路径
        content: 文件内容

    Returns:
        操作结果
    """
    abs_path = _resolve_path(path)
    is_new = not os.path.exists(abs_path)

    try:
        # 确保目录存在
        parent = os.path.dirname(abs_path)
        if parent:
            os.makedirs(parent, exist_ok=True)

        with open(abs_path, "w", encoding="utf-8") as f:
            f.write(content)

        lines = content.count("\n") + 1
        size = len(content)

        if is_new:
            return f"[OK] Write: 新建文件 {path}  ({lines} 行, {size} 字符)"
        else:
            return f"[OK] Write: 覆盖文件 {path}  ({lines} 行, {size} 字符)"

    except Exception as e:
        return f"[ERROR] Write 失败: {type(e).__name__}: {e}"


def _resolve_path(path: str) -> str:
    """智能路径解析 (基于当前线程的逻辑工作目录)"""
    return resolve_path(path)
