"""文件系统信箱 - 多 Agent 通信层

参考 Claude Code 的 "文件系统即上下文" 设计:
后台 SubAgent 完成工作后，将结果写入文件系统的消息目录 (信箱)，
主 Agent 无需复杂的消息队列，直接读取文件即可获得结果。

信箱目录结构 (~/.vca/agents/):
```
~/.vca/agents/
├── <agent_id>/
│   ├── status.json   # 状态 + 结果元信息
│   └── result.txt    # 精简结果文本
```

特性:
- 主 Agent 重启后仍能通过信箱恢复子代理结果
- 内存中的 SubAgent 状态与文件系统信箱双向同步
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .types import SubAgent

# 信箱根目录 (用户级，跨工作空间)
_MAILBOX_DIR = Path.home() / ".vca" / "agents"


def _agent_dir(agent_id: str) -> Path:
    return _MAILBOX_DIR / agent_id


def ensure_dirs() -> None:
    """确保信箱根目录存在"""
    _MAILBOX_DIR.mkdir(parents=True, exist_ok=True)


def save(agent: SubAgent) -> None:
    """
    将子代理状态与结果写入文件系统信箱。

    - status.json: 完整状态 (含结果摘要)
    - result.txt:  纯文本结果 (方便外部工具直接读取)
    """
    try:
        ensure_dirs()
        adir = _agent_dir(agent.id)
        adir.mkdir(parents=True, exist_ok=True)

        # status.json
        (adir / "status.json").write_text(
            json.dumps(agent.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        # result.txt (始终覆盖，保持最新)
        (adir / "result.txt").write_text(
            agent.result or "",
            encoding="utf-8",
        )
    except Exception:
        # 信箱写入失败不影响主流程
        pass


def load(agent_id: str) -> SubAgent | None:
    """从文件系统信箱恢复子代理状态"""
    adir = _agent_dir(agent_id)
    status_file = adir / "status.json"
    if not status_file.exists():
        return None
    try:
        data = json.loads(status_file.read_text(encoding="utf-8"))
        return SubAgent.from_dict(data)
    except Exception:
        return None


def list_agents() -> list[SubAgent]:
    """列出信箱中所有子代理 (按创建时间倒序)"""
    ensure_dirs()
    agents: list[SubAgent] = []
    if not _MAILBOX_DIR.is_dir():
        return agents

    for entry in _MAILBOX_DIR.iterdir():
        if not entry.is_dir():
            continue
        status_file = entry / "status.json"
        if not status_file.exists():
            continue
        try:
            data = json.loads(status_file.read_text(encoding="utf-8"))
            agents.append(SubAgent.from_dict(data))
        except Exception:
            continue

    agents.sort(key=lambda a: a.created_at, reverse=True)
    return agents


def remove(agent_id: str) -> bool:
    """删除信箱中的子代理记录"""
    adir = _agent_dir(agent_id)
    if not adir.exists():
        return False
    try:
        for f in adir.iterdir():
            try:
                f.unlink()
            except OSError:
                pass
        adir.rmdir()
        return True
    except Exception:
        return False


def mailbox_size() -> int:
    """信箱中已完成的子代理数量"""
    ensure_dirs()
    count = 0
    if not _MAILBOX_DIR.is_dir():
        return 0
    for entry in _MAILBOX_DIR.iterdir():
        if entry.is_dir() and (entry / "status.json").exists():
            count += 1
    return count
