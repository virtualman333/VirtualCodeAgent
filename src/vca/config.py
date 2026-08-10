"""配置管理 - 从环境变量加载 LLM 和 Agent 配置"""

import os
from dotenv import load_dotenv

load_dotenv()


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
    def display(cls) -> None:
        """打印当前配置（隐藏敏感信息）"""
        print(f"Model: {cls.OPENAI_MODEL}")
        print(f"Base URL: {cls.OPENAI_BASE_URL}")
        print(f"Workspace: {os.path.abspath(cls.WORKSPACE_DIR)}")
        print(f"Max Iterations: {cls.MAX_TOOL_ITERATIONS}")
