"""SubAgent 数据模型"""

from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict
from typing import Any

# 子代理状态
STATUS_PENDING = "pending"
STATUS_RUNNING = "running"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"


@dataclass
class SubAgent:
    """一个独立运行的子代理"""

    id: str                       # 唯一 ID
    name: str                     # 名称
    task: str                     # 任务描述 (HumanMessage)
    system_prompt: str            # 独立 system prompt
    workspace_dir: str            # 隔离的工作目录
    tool_names: list[str]         # 独立工具池 (工具名列表)
    mode: str                     # sync | background
    status: str = STATUS_PENDING  # pending | running | completed | failed
    result: str = ""              # 精简结果 (返回给主 Agent)
    error: str = ""               # 失败原因
    created_at: float = field(default_factory=time.time)
    finished_at: float = 0.0

    # 运行时对象 (不序列化)
    thread: Any = field(default=None, repr=False, compare=False)
    state: Any = field(default=None, repr=False, compare=False)

    def to_dict(self) -> dict:
        """序列化为 dict (用于文件系统信箱持久化)"""
        return {
            "id": self.id,
            "name": self.name,
            "task": self.task,
            "system_prompt": self.system_prompt,
            "workspace_dir": self.workspace_dir,
            "tool_names": self.tool_names,
            "mode": self.mode,
            "status": self.status,
            "result": self.result,
            "error": self.error,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SubAgent":
        """从 dict 还原 (仅还原可序列化字段)"""
        known = {
            "id", "name", "task", "system_prompt", "workspace_dir",
            "tool_names", "mode", "status", "result", "error",
            "created_at", "finished_at",
        }
        return cls(**{k: v for k, v in data.items() if k in known})

    @property
    def is_finished(self) -> bool:
        return self.status in (STATUS_COMPLETED, STATUS_FAILED)

    def status_line(self) -> str:
        """格式化状态摘要"""
        status_icon = {
            STATUS_PENDING: "⏳",
            STATUS_RUNNING: "🔄",
            STATUS_COMPLETED: "✅",
            STATUS_FAILED: "❌",
        }.get(self.status, "❓")
        return f"{status_icon} {self.id} ({self.name}) [{self.status}]"
