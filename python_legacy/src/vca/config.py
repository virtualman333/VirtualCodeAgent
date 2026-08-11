"""配置管理 - 基于 ~/.vca/config.json 的配置文件"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

# ============================================================
# 路径常量
# ============================================================

# VCA 数据目录 (~/.vca/)
VCA_DIR = Path.home() / ".vca"

# 配置文件
CONFIG_FILE = VCA_DIR / "config.json"

# 历史工作空间文件 (保留在数据目录内)
HISTORY_FILE = VCA_DIR / "workspace_history.json"

# 会话目录
SESSIONS_DIR = VCA_DIR / "sessions"

# 用户级 skills / mcp 配置目录
SKILLS_DIR = VCA_DIR / "skills"
MCP_CONFIG_FILE = VCA_DIR / "mcp.json"


# ============================================================
# 默认配置
# ============================================================

DEFAULT_CONFIG: dict[str, Any] = {
    # LLM 配置
    "OPENAI_API_KEY": "",
    "OPENAI_BASE_URL": "https://api.openai.com/v1",
    "OPENAI_MODEL": "gpt-4o-mini",
    # Agent 配置
    "WORKSPACE_DIR": "~/.vca/workspace",
    "MAX_TOOL_ITERATIONS": 10,
    # 上下文上限 (token)
    "MAX_CONTEXT_TOKENS": 100000,
}


def _ensure_dirs() -> None:
    """确保数据目录结构存在"""
    for d in (VCA_DIR, SESSIONS_DIR, SKILLS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def _load_file() -> dict[str, Any]:
    """读取配置文件 (不存在返回空 dict)"""
    try:
        if CONFIG_FILE.exists():
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _save_file(data: dict[str, Any]) -> None:
    """写入配置文件"""
    _ensure_dirs()
    CONFIG_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def ensure_config() -> dict[str, Any]:
    """确保配置存在, 首次运行自动生成默认配置并返回合并结果"""
    _ensure_dirs()
    config = _load_file()

    if not config:
        config = dict(DEFAULT_CONFIG)
        _save_file(config)
        print(f"[INFO] 已生成默认配置文件: {CONFIG_FILE}")
        print("[INFO] 请编辑该文件填入你的 OPENAI_API_KEY")

    # 合并缺失的默认项 (配置升级时自动补齐)
    merged = dict(DEFAULT_CONFIG)
    merged.update({k: v for k, v in config.items() if k in DEFAULT_CONFIG})
    if merged != config:
        _save_file(merged)
        config = merged

    return config


# ============================================================
# 历史工作空间
# ============================================================

def _load_history() -> list[str]:
    """加载历史工作空间记录"""
    try:
        if HISTORY_FILE.exists():
            data = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return [p for p in data if os.path.isdir(p)][:10]
    except Exception:
        pass
    return []


def _save_history(paths: list[str]) -> None:
    """保存历史工作空间记录"""
    try:
        clean = []
        seen = set()
        for p in paths:
            if os.path.isdir(p) and p not in seen:
                clean.append(p)
                seen.add(p)
        HISTORY_FILE.write_text(
            json.dumps(clean[:10], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass


# ============================================================
# 配置对象
# ============================================================

class Config:
    """全局配置 (从 ~/.vca/config.json 加载)"""

    _config: dict[str, Any] = {}

    # LLM 配置 (加载时赋值)
    OPENAI_API_KEY: str = ""
    OPENAI_BASE_URL: str = "https://api.openai.com/v1"
    OPENAI_MODEL: str = "gpt-4o-mini"

    # Agent 配置
    WORKSPACE_DIR: str = "~/.vca/workspace"
    MAX_TOOL_ITERATIONS: int = 10
    MAX_CONTEXT_TOKENS: int = 100000

    # ---- 加载 ----
    @classmethod
    def load(cls) -> None:
        """加载配置 (首次运行自动生成)"""
        cls._config = ensure_config()
        cls.OPENAI_API_KEY = str(cls._config.get("OPENAI_API_KEY", ""))
        cls.OPENAI_BASE_URL = str(
            cls._config.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
        )
        cls.OPENAI_MODEL = str(cls._config.get("OPENAI_MODEL", "gpt-4o-mini"))
        cls.WORKSPACE_DIR = os.path.expanduser(
            str(cls._config.get("WORKSPACE_DIR", "~/.vca/workspace"))
        )
        cls.MAX_TOOL_ITERATIONS = int(cls._config.get("MAX_TOOL_ITERATIONS", 10))
        cls.MAX_CONTEXT_TOKENS = int(cls._config.get("MAX_CONTEXT_TOKENS", 100000))

    # ---- 读写 ----
    @classmethod
    def get(cls, key: str, default: Any = None) -> Any:
        return cls._config.get(key, default)

    @classmethod
    def set(cls, key: str, value: Any) -> None:
        """更新配置项并保存到文件"""
        cls._config[key] = value
        _save_file(cls._config)
        # 同步类属性
        if key in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
                   "WORKSPACE_DIR", "MAX_TOOL_ITERATIONS", "MAX_CONTEXT_TOKENS"):
            cls.load()

    # ---- 校验 / 展示 ----
    @classmethod
    def validate(cls) -> bool:
        """验证必要配置是否存在"""
        if not cls.OPENAI_API_KEY:
            print("[WARN] OPENAI_API_KEY 未设置")
            print(f"[WARN] 请编辑配置文件: {CONFIG_FILE}")
            return False
        return True

    @classmethod
    def display(cls, workspace_dir: str | None = None) -> None:
        """打印当前配置（隐藏敏感信息）"""
        ws = workspace_dir or cls.WORKSPACE_DIR
        print(f"配置文件:   {CONFIG_FILE}")
        print(f"Model:       {cls.OPENAI_MODEL}")
        print(f"Base URL:    {cls.OPENAI_BASE_URL}")
        print(f"Workspace:   {os.path.abspath(ws)}")
        print(f"Max Iter:    {cls.MAX_TOOL_ITERATIONS}")
        print(f"Max Tokens:  {cls.MAX_CONTEXT_TOKENS}")

    # ---- 工作空间 ----
    @classmethod
    def resolve_workspace(cls, path: str) -> str:
        """解析并验证工作空间路径，返回绝对路径"""
        abs_path = os.path.abspath(os.path.expanduser(path))
        if not os.path.exists(abs_path):
            os.makedirs(abs_path, exist_ok=True)
        return abs_path

    @classmethod
    def get_workspace_history(cls) -> list[str]:
        return _load_history()

    @classmethod
    def add_workspace_to_history(cls, path: str) -> None:
        """将路径加入历史记录"""
        abs_path = os.path.abspath(path)
        history = _load_history()
        if abs_path in history:
            history.remove(abs_path)
        history.insert(0, abs_path)
        _save_history(history)


# 模块加载时自动初始化
Config.load()
