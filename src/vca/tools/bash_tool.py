"""Bash 工具 - 万能 Shell 命令执行"""

from __future__ import annotations

import os
import subprocess
import shutil
from langchain_core.tools import tool

# ---- 安全警告命令 ----
_RISKY_COMMANDS = {
    "rm -rf /",
    "del /f /s C:\\",
    "format ",
    ":(){ :|:& };:",  # fork bomb
    "chmod 777 /",
    "sudo rm -rf",
    "dd if=",
    "mkfs.",
}


def _is_risky(command: str) -> bool:
    """检查是否为危险命令"""
    lower = command.lower().strip()
    for risky in _RISKY_COMMANDS:
        if risky.lower() in lower:
            return True
    return False


@tool
def bash(command: str, timeout: int = 120, description: str = "") -> str:
    """
    执行 Shell 命令并返回结果。这是运行测试、构建、lint、git 操作、
    包安装等任务的万能工具。

    使用场景:
    - 运行命令: git log, git diff, git status
    - 文件统计: find, wc, tree, du
    - 包管理: npm install, pip install, cargo build
    - 测试运行: pytest, npm test, cargo test
    - 代码检查: pylint, eslint, mypy
    - Git 操作: git commit, git add, git branch
    - 系统信息: python --version, node --version, uname

    安全限制:
    - 危险命令 (如 rm -rf /) 会被拦截
    - 默认超时 120 秒

    Args:
        command: 要执行的 shell 命令
        timeout: 超时时间 (秒)，默认 120
        description: 命令用途描述（可选）

    Returns:
        命令的标准输出和错误输出，含退出码
    """
    if _is_risky(command):
        return (
            f"[BLOCKED] 危险命令被拦截: {command}\n"
            f"如确实需要执行，请手动在终端中运行。"
        )

    # 检查命令是否存在
    cmd_name = command.split()[0] if command.split() else ""
    if shutil.which(cmd_name) is None and not cmd_name.startswith((".", "/", "\\")):
        # 允许 cd, echo, dir 等 shell 内置命令
        pass

    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=os.getcwd(),
            env=os.environ.copy(),
        )

        parts = []
        if description:
            parts.append(f"[OK] BASH: {description}")

        if result.stdout:
            # 截断过长的输出
            stdout = result.stdout
            if len(stdout) > 10000:
                stdout = stdout[:10000] + f"\n... (输出截断，共 {len(result.stdout):,} 字符)"
            parts.append(stdout.rstrip())

        if result.stderr:
            stderr = result.stderr
            if len(stderr) > 2000:
                stderr = stderr[:2000] + f"\n... (stderr 截断，共 {len(result.stderr):,} 字符)"
            parts.append(f"[STDERR]\n{stderr.rstrip()}")

        if result.returncode != 0:
            parts.append(f"[EXIT CODE: {result.returncode}]")

        if not parts:
            parts.append("(无输出)")

        prefix = f"[OK] BASH" if result.returncode == 0 else f"[ERR] BASH"
        return f"{prefix}: {description or command}\n" + "\n".join(
            parts[1:] if description else parts
        )

    except subprocess.TimeoutExpired:
        return f"[ERROR] BASH 超时 ({timeout}s): {command}"
    except Exception as e:
        return f"[ERROR] BASH 执行失败: {type(e).__name__}: {e}"
