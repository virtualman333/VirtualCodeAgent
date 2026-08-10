"""配置管理 - 从环境变量加载 LLM 和 Agent 配置"""

import os
import sys
import json
from pathlib import Path
from dotenv import load_dotenv


def _get_base_dir() -> Path:
    """
    获取配置文件的基准目录:
    - PyInstaller 打包后 (sys.frozen): 可执行文件所在目录
    - 源码运行: 项目根目录 (pyproject.toml / .env 所在目录)
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


# 基准目录 (exe 同目录 或 项目根目录)
BASE_DIR = _get_base_dir()

# 加载 .env 配置文件:
# 优先级: 已存在的环境变量 > 基准目录(exe 同目录/项目根目录) > 当前工作目录
load_dotenv(BASE_DIR / ".env")
load_dotenv()

# 历史记录文件路径
_HISTORY_FILE = Path.home() / ".vca_workspace_history.json"


def _load_history() -> list[str]:
    """加载历史工作空间记录"""
    try:
        if _HISTORY_FILE.exists():
            data = json.loads(_HISTORY_FILE.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return [p for p in data if os.path.isdir(p)][:10]
    except Exception:
        pass
    return []


def _save_history(paths: list[str]) -> None:
    """保存工作空间历史记录"""
    try:
        # 去重、去无效、只保留最近10条
        clean = []
        seen = set()
        for p in paths:
            if os.path.isdir(p) and p not in seen:
                clean.append(p)
                seen.add(p)
        _HISTORY_FILE.write_text(
            json.dumps(clean[:10], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass


class Config:
    """全局配置单例"""

    # LLM 配置
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")
    OPENAI_BASE_URL: str = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    OPENAI_MODEL: str = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

    # Agent 配置
    WORKSPACE_DIR: str = os.getenv("WORKSPACE_DIR", "./workspace")
    MAX_TOOL_ITERATIONS: int = int(os.getenv("MAX_TOOL_ITERATIONS", "10"))

    @classmethod
    def validate(cls) -> bool:
        """验证必要配置是否存在"""
        if not cls.OPENAI_API_KEY:
            print("[WARN] OPENAI_API_KEY 未设置，请检查 .env 文件")
            return False
        return True

    @classmethod
    def display(cls, workspace_dir: str | None = None) -> None:
        """打印当前配置（隐藏敏感信息）"""
        ws = workspace_dir or cls.WORKSPACE_DIR
        print(f"Model:        {cls.OPENAI_MODEL}")
        print(f"Base URL:     {cls.OPENAI_BASE_URL}")
        print(f"Workspace:    {os.path.abspath(ws)}")
        print(f"Max Iter:     {cls.MAX_TOOL_ITERATIONS}")

    @classmethod
    def resolve_workspace(cls, path: str) -> str:
        """解析并验证工作空间路径，返回绝对路径"""
        abs_path = os.path.abspath(path)
        if not os.path.exists(abs_path):
            os.makedirs(abs_path, exist_ok=True)
        return abs_path

    @classmethod
    def get_workspace_history(cls) -> list[str]:
        """获取最近使用过的工作空间列表"""
        return _load_history()

    @classmethod
    def add_workspace_to_history(cls, path: str) -> None:
        """将路径加入历史记录"""
        abs_path = os.path.abspath(path)
        history = _load_history()
        # 移到最前
        if abs_path in history:
            history.remove(abs_path)
        history.insert(0, abs_path)
        _save_history(history)
