"""Glob & Grep 搜索工具"""

from __future__ import annotations

import os
import re
import fnmatch
from pathlib import Path
from langchain_core.tools import tool

from ..workspace_ctx import get_workspace

# ---- 排除目录 ----
_EXCLUDE_DIRS = {
    ".git",
    "__pycache__",
    "node_modules",
    ".venv",
    "venv",
    "env",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".next",
    ".nuxt",
    "dist",
    "build",
    "target",
    ".idea",
    ".vscode",
}


def _should_skip_dir(dirname: str) -> bool:
    return dirname in _EXCLUDE_DIRS or dirname.startswith(".")


# ============================================================
# Glob - 按文件名模式搜索
# ============================================================


@tool
def glob_files(pattern: str, path: str = ".") -> str:
    """
    按文件名模式递归搜索文件。

    支持模式:
    - ** 到多级子目录
    - * 匹配任意字符
    - ? 匹配单个字符
    - [abc] 匹配集合中的字符
    - '*.py' 'src/**/*.tsx' '**/test_*.py'

    Args:
        pattern: 文件名匹配模式，如 "src/**/*.tsx"
        path: 搜索的起始目录，默认为当前目录

    Returns:
        匹配的文件路径列表 (按字母排序)
    """
    base = _resolve_base(path)

    if not os.path.isdir(base):
        return f"[ERROR] 目录不存在: {path}"

    matches = []
    for root, dirs, files in os.walk(base):
        # 排除隐藏/infrastructure 目录
        dirs[:] = [d for d in dirs if not _should_skip_dir(d)]
        root_rel = os.path.relpath(root, base)
        if root_rel == ".":
            root_rel = ""

        for fname in files:
            rel_path = os.path.join(root_rel, fname) if root_rel else fname
            if fnmatch.fnmatch(rel_path, pattern):
                matches.append(rel_path)

    if not matches:
        return f"[OK] Glob: 未找到匹配 '{pattern}' 的文件 (搜索于 {os.path.abspath(base)})"

    result_lines = [f"[OK] Glob: 找到 {len(matches)} 个匹配 '{pattern}' 的文件:"]
    for m in sorted(matches)[:200]:
        result_lines.append(f"  {m}")
    if len(matches) > 200:
        result_lines.append(f"  ... 还有 {len(matches) - 200} 个结果未显示")

    return "\n".join(result_lines)


# ============================================================
# Grep - 按文件内容/正则搜索
# ============================================================


@tool
def grep_content(
    pattern: str,
    path: str = ".",
    glob: str | None = None,
    ignore_case: bool = False,
    max_results: int = 100,
) -> str:
    """
    在文件内容中搜索匹配正则表达式的行。

    类似于 ripgrep / grep -r。搜索所有文本文件中的匹配行。

    Args:
        pattern: 正则表达式，如 "def main", "TODO|FIXME", "import.*from"
        path: 搜索的目录或文件路径
        glob: 文件名过滤，如 "*.py", "*.{ts,tsx}"。仅在搜索目录时生效
        ignore_case: 是否忽略大小写，默认 False
        max_results: 最多返回的匹配数，默认 100

    Returns:
        匹配行，每行格式为 "文件路径:行号:内容"
    """
    base = _resolve_base(path)

    # 单个文件
    if os.path.isfile(base):
        return _grep_single_file(base, pattern, ignore_case, max_results)

    # 目录搜索
    if not os.path.isdir(base):
        return f"[ERROR] 路径不存在: {path}"

    try:
        regex = re.compile(pattern, re.IGNORECASE if ignore_case else 0)
    except re.error as e:
        return f"[ERROR] 正则表达式无效: {e}"

    results = []
    scanned = 0
    truncated = False

    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if not _should_skip_dir(d)]

        for fname in sorted(files):
            if glob:
                if not fnmatch.fnmatch(fname, glob):
                    continue

            fpath = os.path.join(root, fname)
            rel_path = os.path.relpath(fpath, base)

            # 跳过二进制/过大文件
            if _is_binary(fpath):
                continue
            try:
                if os.path.getsize(fpath) > 5 * 1024 * 1024:
                    continue
            except OSError:
                continue

            scanned += 1
            try:
                with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                    for line_no, line in enumerate(f, 1):
                        if regex.search(line):
                            results.append(f"{rel_path}:{line_no}: {line.rstrip()}")
                            if len(results) >= max_results:
                                truncated = True
                                break
            except Exception:
                continue

            if truncated:
                break

        if truncated:
            break

    if not results:
        glob_info = f" (文件过滤: {glob})" if glob else ""
        return f"[OK] Grep: 未找到匹配 '{pattern}' 的内容 (扫描 {scanned} 个文件{glob_info})"

    out = [f"[OK] Grep: 找到 {len(results)} 个匹配 '{pattern}' (共扫描 {scanned} 个文件)"]
    out.extend(results)
    if truncated:
        out.append(f"... 结果已截断，仅显示前 {max_results} 条")
    return "\n".join(out)


def _grep_single_file(
    fpath: str, pattern: str, ignore_case: bool, max_results: int
) -> str:
    """在单个文件中搜索"""
    try:
        regex = re.compile(pattern, re.IGNORECASE if ignore_case else 0)
    except re.error as e:
        return f"[ERROR] 正则表达式无效: {e}"

    results = []
    try:
        with open(fpath, "r", encoding="utf-8", errors="replace") as f:
            for line_no, line in enumerate(f, 1):
                if regex.search(line):
                    results.append(f"{line_no}: {line.rstrip()}")
                    if len(results) >= max_results:
                        results.append("... (结果已截断)")
                        break
    except Exception as e:
        return f"[ERROR] 读取文件失败: {e}"

    if not results:
        return f"[OK] Grep: 未找到匹配 '{pattern}' 的内容 (文件: {fpath})"

    return f"[OK] Grep: 在 {fpath} 中找到 {len(results)} 个匹配:\n" + "\n".join(
        results
    )


# ============================================================
# 辅助函数
# ============================================================


def _resolve_base(path: str) -> str:
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

    return os.path.join(base, path)


def _is_binary(filepath: str) -> bool:
    """简单二进制检测：读取前 1024 字节，检查 null 字节"""
    try:
        with open(filepath, "rb") as f:
            chunk = f.read(1024)
            return b"\x00" in chunk
    except Exception:
        return True
