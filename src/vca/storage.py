"""对话记录存储 — 自动保存/恢复会话"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

from langchain_core.messages import (
    BaseMessage,
    HumanMessage,
    AIMessage,
    SystemMessage,
    ToolMessage,
)

# ---- 路径常量 ----
_BASE_DIR = Path.home() / ".vca"
_SESSIONS_DIR = _BASE_DIR / "sessions"
_INDEX_FILE = _BASE_DIR / "session_index.json"

# ---- 时区 ----
_TZ = timezone(timedelta(hours=8))  # UTC+8


def _ensure_dirs() -> None:
    _SESSIONS_DIR.mkdir(parents=True, exist_ok=True)


# ============================================================
# 序列化 / 反序列化
# ============================================================

def _message_to_dict(msg: BaseMessage) -> dict:
    """将 LangChain 消息转为可 JSON 序列化的 dict"""
    out: dict = {"type": type(msg).__name__}
    if isinstance(msg, HumanMessage):
        out["content"] = msg.content
    elif isinstance(msg, AIMessage):
        out["content"] = msg.content
        # 仅当有 tool_calls 时才写入，避免 null 导致反序列化校验失败
        if getattr(msg, "tool_calls", None):
            out["tool_calls"] = list(msg.tool_calls)
    elif isinstance(msg, SystemMessage):
        out["content"] = msg.content
    elif isinstance(msg, ToolMessage):
        out["content"] = msg.content
        out["tool_call_id"] = msg.tool_call_id
        out["name"] = getattr(msg, "name", "")
    return out


def _dict_to_message(data: dict) -> BaseMessage:
    """从 dict 还原为 LangChain 消息"""
    msg_type = data.get("type", "")
    content = data.get("content", "")
    if msg_type == "HumanMessage":
        return HumanMessage(content=content)
    elif msg_type == "AIMessage":
        tool_calls = data.get("tool_calls")
        # tool_calls 为 None 时不要传参，否则新版 langchain 校验失败
        if tool_calls:
            return AIMessage(content=content, tool_calls=tool_calls)
        return AIMessage(content=content)
    elif msg_type == "SystemMessage":
        return SystemMessage(content=content)
    elif msg_type == "ToolMessage":
        return ToolMessage(
            content=content,
            tool_call_id=data.get("tool_call_id", ""),
            name=data.get("name", ""),
        )
    # fallback
    return HumanMessage(content=str(data))


def _serialize_messages(messages: list[BaseMessage]) -> list[dict]:
    """序列化消息列表"""
    return [_message_to_dict(m) for m in messages if not _is_internal_message(m)]


def _deserialize_messages(data: list[dict]) -> list[BaseMessage]:
    """反序列化消息列表"""
    return [_dict_to_message(d) for d in data]


def _is_internal_message(msg: BaseMessage) -> bool:
    """过滤内部消息 (ask_user 占位等)"""
    if isinstance(msg, ToolMessage):
        if msg.content == "[AWAITING_USER_INPUT]":
            return True
    return False


# ============================================================
# 索引管理
# ============================================================

def _read_index() -> list[dict]:
    """读取会话索引"""
    _ensure_dirs()
    try:
        if _INDEX_FILE.exists():
            return json.loads(_INDEX_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return []


def _write_index(index: list[dict]) -> None:
    """写入会话索引"""
    _ensure_dirs()
    _INDEX_FILE.write_text(
        json.dumps(index, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _update_index(
    session_id: str, title: str, workspace: str, message_count: int
) -> None:
    """更新索引中的一条记录 (不存在则新增)"""
    now = datetime.now(_TZ).strftime("%Y-%m-%d %H:%M")
    entry = {
        "id": session_id,
        "title": title,
        "workspace": workspace,
        "message_count": message_count,
        "updated_at": now,
    }

    index = _read_index()
    for i, item in enumerate(index):
        if item.get("id") == session_id:
            entry["created_at"] = item.get("created_at", now)
            entry["title"] = item.get("title") or title  # 保留已有标题
            index[i] = entry
            _write_index(index)
            return

    entry["created_at"] = now
    index.insert(0, entry)
    # 只保留最近 50 条
    _write_index(index[:50])


def _remove_from_index(session_id: str) -> None:
    """从索引中删除一条记录"""
    index = _read_index()
    index = [item for item in index if item.get("id") != session_id]
    _write_index(index)


# ============================================================
# 保存 / 加载 / 管理
# ============================================================

def save_session(
    session_id: str,
    messages: list[BaseMessage],
    workspace_dir: str,
    title: str = "",
) -> str:
    """
    保存会话到磁盘。

    Args:
        session_id: 会话 ID
        messages: 消息历史
        workspace_dir: 工作空间路径
        title: 会话标题 (留空则从第一条用户消息提取)

    Returns:
        session_id
    """
    _ensure_dirs()

    # 过滤掉内部消息
    clean = [m for m in messages if not _is_internal_message(m)]

    if not title:
        # 从第一条 HumanMessage 提取标题
        for m in clean:
            if isinstance(m, HumanMessage) and m.content:
                title = m.content[:60].replace("\n", " ")
                break
        title = title or "未命名会话"

    # 序列化
    data = _serialize_messages(clean)

    filepath = _SESSIONS_DIR / f"{session_id}.json"
    filepath.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    _update_index(session_id, title, workspace_dir, len(clean))

    return session_id


def load_session(session_id: str) -> dict | None:
    """
    加载指定会话。

    Returns:
        {"messages": [...], "workspace_dir": "...", "title": "..."}
        或 None (会话不存在)
    """
    _ensure_dirs()
    filepath = _SESSIONS_DIR / f"{session_id}.json"
    if not filepath.exists():
        return None

    try:
        data = json.loads(filepath.read_text(encoding="utf-8"))
        messages = _deserialize_messages(data)

        # 从索引中查找元信息
        workspace = ""
        title = ""
        index = _read_index()
        for item in index:
            if item.get("id") == session_id:
                workspace = item.get("workspace", "")
                title = item.get("title", "")
                break

        return {
            "messages": messages,
            "workspace_dir": workspace,
            "title": title,
        }
    except Exception as e:
        return None


def list_sessions(max_count: int = 20) -> list[dict]:
    """列出最近的会话记录"""
    index = _read_index()
    return index[:max_count]


def delete_session(session_id: str) -> bool:
    """删除指定会话 (文件 + 索引)"""
    _ensure_dirs()
    filepath = _SESSIONS_DIR / f"{session_id}.json"
    deleted = False
    if filepath.exists():
        filepath.unlink()
        deleted = True
    _remove_from_index(session_id)
    return deleted


def generate_session_id() -> str:
    """生成新的 session ID (时间戳)"""
    return datetime.now(_TZ).strftime("%Y%m%d_%H%M%S_") + f"{int(time.time() * 1000) % 100000:05d}"


def get_last_session() -> dict | None:
    """获取最近的会话"""
    sessions = list_sessions(1)
    if not sessions:
        return None
    return load_session(sessions[0]["id"])


def auto_save(
    state,
    session_id: str | None = None,
) -> str:
    """
    自动保存当前状态。

    Args:
        state: AgentState
        session_id: 已有会话 ID，为 None 则新建

    Returns:
        使用的 session_id
    """
    if session_id is None:
        session_id = generate_session_id()

    save_session(
        session_id=session_id,
        messages=state.get("messages", []),
        workspace_dir=state.get("workspace_dir", ""),
    )
    return session_id
