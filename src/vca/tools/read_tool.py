"""Read 工具 - 读文件，支持行号范围、PDF、图片、Notebook"""

from __future__ import annotations

import os
import json
from pathlib import Path
from langchain_core.tools import tool

# ---- 可选依赖 ----
try:
    from PIL import Image

    HAS_PIL = True
except ImportError:
    HAS_PIL = False

try:
    from PyPDF2 import PdfReader

    HAS_PYPDF2 = True
except ImportError:
    HAS_PYPDF2 = False


def _read_text(path: str, start_line: int | None, end_line: int | None) -> str:
    """读取纯文本文件，支持行号范围"""
    abs_path = _resolve_path(path)

    with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()

    total_lines = len(lines)

    # 规范化行号
    start = max(1, start_line or 1)
    end = min(total_lines, end_line or total_lines)

    if start > total_lines:
        return f"[INFO] 文件只有 {total_lines} 行，起始行 {start_line} 超出范围"

    selected = lines[start - 1 : end]

    # 添加行号
    out_lines = []
    for i, line in enumerate(selected, start=start):
        out_lines.append(f"{i:>6}|{line.rstrip()}")

    header = f"[OK] {path}  (L{start}-L{end} / 共 {total_lines} 行)"
    return header + "\n" + "\n".join(out_lines)


def _read_pdf(path: str) -> str:
    """读取 PDF 文件内容"""
    if not HAS_PYPDF2:
        return "[ERROR] 读取 PDF 需要安装 PyPDF2: pip install PyPDF2"

    abs_path = _resolve_path(path)
    reader = PdfReader(abs_path)

    out_lines = [f"[OK] PDF: {path}  ({len(reader.pages)} 页)"]
    for i, page in enumerate(reader.pages, 1):
        text = page.extract_text()
        if text:
            out_lines.append(f"\n--- 第 {i} 页 ---\n{text.strip()}")

    return "\n".join(out_lines)


def _read_image(path: str) -> str:
    """读取图片信息（尺寸、模式等）"""
    if not HAS_PIL:
        return "[ERROR] 读取图片需要安装 Pillow: pip install Pillow"

    abs_path = _resolve_path(path)
    img = Image.open(abs_path)

    info_lines = [
        f"[OK] 图片: {path}",
        f"  格式:     {img.format}",
        f"  尺寸:     {img.size[0]} × {img.size[1]} px",
        f"  模式:     {img.mode}",
        f"  文件大小: {os.path.getsize(abs_path):,} bytes",
    ]

    # EXIF 信息 (JPEG/TIFF)
    exif = img.getexif()
    if exif:
        for tag_id, value in exif.items():
            from PIL.ExifTags import TAGS
            tag_name = TAGS.get(tag_id, tag_id)
            info_lines.append(f"  EXIF {tag_name}: {value}")
            if len(info_lines) > 20:
                info_lines.append("  ... (EXIF 信息过长，已截断)")
                break

    return "\n".join(info_lines)


def _read_notebook(path: str) -> str:
    """读取 Jupyter Notebook (.ipynb) 内容"""
    abs_path = _resolve_path(path)

    with open(abs_path, "r", encoding="utf-8") as f:
        nb = json.load(f)

    nb_format = nb.get("nbformat", "unknown")
    nb_version = nb.get("nbformat_minor", 0)
    cells = nb.get("cells", [])

    out_lines = [
        f"[OK] Notebook: {path}  (格式: {nb_format}.{nb_version}, {len(cells)} 个单元格)"
    ]

    for i, cell in enumerate(cells, 1):
        cell_type = cell.get("cell_type", "unknown")
        source = "".join(cell.get("source", []))

        # 截断过长内容
        if len(source) > 2000:
            source = source[:2000] + f"\n... (截断, 共 {len(''.join(cell.get('source', [])))} 字符)"

        out_lines.append(f"\n--- 单元格 {i} [{cell_type}] ---")
        out_lines.append(source)

    return "\n".join(out_lines)


def _resolve_path(path: str) -> str:
    """智能路径解析：绝对路径 > 相对路径 > workspace/ 下查找"""
    if os.path.isabs(path) and os.path.exists(path):
        return path
    if os.path.exists(path):
        return os.path.abspath(path)

    # workspace 目录下查找
    alt = os.path.join(os.getcwd(), "workspace", path)
    if os.path.exists(alt):
        return alt

    # 不存在 - 直接返回原始 path 让调用方报错
    return os.path.abspath(path)


@tool
def read_file(
    path: str,
    start_line: int | None = None,
    end_line: int | None = None,
) -> str:
    """
    读取文件内容，支持多种格式和行号范围。

    支持的格式:
    - 纯文本 (.py, .js, .ts, .json, .md, .txt 等) — 可指定行号范围
    - PDF (.pdf) — 提取所有页面文本
    - 图片 (.png, .jpg, .jpeg, .gif, .webp, .bmp) — 返回元信息
    - Notebook (.ipynb) — 提取所有单元格源码

    Args:
        path: 文件路径
        start_line: 起始行号 (1-based)，仅在文本模式下生效
        end_line: 结束行号 (1-based, 含), 仅在文本模式下生效

    Returns:
        文件内容或元信息
    """
    if not os.path.exists(path):
        alt = os.path.join(os.getcwd(), "workspace", path)
        if os.path.exists(alt):
            path = alt
        else:
            return f"[ERROR] 文件不存在: {path}\n试试先用 Glob 查找文件位置"

    # 文件大小检查
    file_size = os.path.getsize(path)
    if file_size > 10 * 1024 * 1024:  # 10MB 硬上限
        return f"[ERROR] 文件过大 (>10MB): {path} ({file_size:,} bytes)"

    suffix = Path(path).suffix.lower()

    try:
        # 图片
        if suffix in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".ico"}:
            return _read_image(path)

        # PDF
        if suffix == ".pdf":
            return _read_pdf(path)

        # Notebook
        if suffix == ".ipynb":
            return _read_notebook(path)

        # 默认: 文本文件
        if file_size > 1024 * 1024 and not start_line and not end_line:
            return (
                f"[INFO] 文件较大 ({file_size:,} bytes)，建议指定行号范围读取。\n"
                f"例如: read_file(path='{path}', start_line=1, end_line=100)\n\n"
                f"前 50 行预览:\n"
                + _read_text(path, 1, 50)
            )

        return _read_text(path, start_line, end_line)

    except UnicodeDecodeError:
        return (
            f"[ERROR] 无法以文本方式读取 {path}\n"
            f"文件大小: {file_size:,} bytes，可能为二进制文件"
        )
    except Exception as e:
        return f"[ERROR] 读取文件失败: {type(e).__name__}: {e}"
