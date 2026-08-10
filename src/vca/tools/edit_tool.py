"""Edit 工具 - 精确替换文件中的文本片段"""

from __future__ import annotations

import os
from langchain_core.tools import tool

from ..workspace_ctx import get_workspace


@tool
def edit_file(path: str, old_string: str, new_string: str) -> str:
    """
    精确替换文件中的文本片段。

    工作原理: 在文件中查找 old_string，将其替换为 new_string。
    - old_string 必须在文件中唯一存在（或使用 replace_all 替换全部出现）。
    - 保留原始缩进格式。
    - 替换后不会修改不相邻的行。

    常用于: 修改函数实现、修改变量名、添加/删除代码行等。

    Args:
        path: 要编辑的文件路径
        old_string: 要被替换的原始文本（必须与文件内容完全匹配，包括缩进）
        new_string: 替换后的新文本。使用空字符串 "" 可删除匹配行

    Returns:
        操作结果，包括修改位置信息
    """
    abs_path = _resolve_path(path)

    if not os.path.exists(abs_path):
        return f"[ERROR] 文件不存在: {path}"

    # 读取原始内容
    try:
        with open(abs_path, "r", encoding="utf-8") as f:
            original = f.read()
    except Exception as e:
        return f"[ERROR] 读取文件失败: {e}"

    # 空 old_string 无意义
    if not old_string:
        return "[ERROR] old_string 不能为空"

    # 检查唯一性
    count = original.count(old_string)
    if count == 0:
        return (
            f"[ERROR] 未找到匹配文本。请确认 old_string 与文件内容完全一致（含缩进）。\n"
            f"提示: 先用 Read 工具读取文件内容，确保 old_string 精确匹配。"
        )
    if count > 1:
        return (
            f"[ERROR] old_string 在文件中出现了 {count} 次，不唯一。\n"
            f"请提供更多上下文使匹配唯一，或用其他工具处理。"
        )

    # 执行替换
    modified = original.replace(old_string, new_string, 1)

    # 计算修改位置
    idx = original.index(old_string)
    before = original[:idx]
    start_line = before.count("\n") + 1
    end_line = start_line + old_string.count("\n")

    # 写入
    try:
        with open(abs_path, "w", encoding="utf-8") as f:
            f.write(modified)
    except Exception as e:
        return f"[ERROR] 写入文件失败: {e}"

    # 生成结果摘要
    added = len(new_string) - len(old_string)
    if added >= 0:
        size_info = f"+{added}"
    else:
        size_info = f"{added}"

    if end_line == start_line:
        line_info = f"第 {start_line} 行"
    else:
        line_info = f"第 {start_line}-{end_line} 行"

    # 预览
    preview_max = 200
    if len(new_string) <= preview_max:
        preview = new_string.strip()
    else:
        preview = new_string[:preview_max] + f"\n... (共 {len(new_string)} 字符)"

    return (
        f"[OK] Edit: {path} {line_info}  ({size_info} 字符)\n"
        f"────────────────────────────────────────\n"
        f"{preview}\n"
        f"────────────────────────────────────────"
    )


def _resolve_path(path: str) -> str:
    """智能路径解析 (基于当前线程的逻辑工作目录)"""
    if os.path.isabs(path) and os.path.exists(path):
        return path
    if os.path.exists(path):
        return os.path.abspath(path)

    base = get_workspace() or os.getcwd()

    alt = os.path.join(base, path)
    if os.path.exists(alt):
        return alt

    alt = os.path.join(base, "workspace", path)
    if os.path.exists(alt):
        return alt

    # 文件尚未存在时（如 write/create），返回绝对路径
    return os.path.join(base, path)
