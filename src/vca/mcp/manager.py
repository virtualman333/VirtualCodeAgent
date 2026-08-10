"""MCP 管理器 - 配置读取、连接 MCP servers、收集动态工具

利用 langchain-mcp-adapters 的 connection 机制：
每个 MCP 工具在调用时自动创建/销毁 session，无需维护长连接。

配置文件格式 (mcp.json):
{
  "servers": {
    "server_name": {
      "transport": "stdio",            // stdio | http | sse | websocket
      "command": "npx",                // stdio 必需
      "args": ["-y", "@modelcontextprotocol/server-fetch"],
      "env": {"KEY": "VALUE"}          // 可选
    },
    "http_server": {
      "transport": "http",             // http/sse 使用 url
      "url": "http://localhost:8000/mcp"
    }
  }
}

配置文件位置 (优先级从高到低):
1. 项目根:  <workspace>/.vca/mcp.json
2. 用户级:  ~/.vca/mcp.json
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from langchain_core.tools import StructuredTool
from langchain_mcp_adapters.tools import (
    convert_mcp_tool_to_langchain_tool,
    create_session,
)
from mcp.types import Tool as MCPTool


def _make_sync_compatible(tool: StructuredTool) -> StructuredTool:
    """
    给只有 coroutine 的 StructuredTool 补充同步 func。

    新版 langchain-core 的 StructuredTool 若只有 coroutine，
    同步调用会抛 "StructuredTool does not support sync invocation"。
    通过 asyncio.run 包装 coroutine 为同步函数解决。
    """
    original_coro = tool.coroutine

    async def _arun(**kwargs: Any) -> Any:
        return await original_coro(**kwargs)

    def _run(**kwargs: Any) -> Any:
        try:
            return asyncio.run(original_coro(**kwargs))
        except RuntimeError:
            # 已有 running loop (async 环境中), 走事件循环执行
            return asyncio.get_event_loop().run_until_complete(
                original_coro(**kwargs)
            )

    return StructuredTool.from_function(
        name=tool.name,
        description=tool.description,
        func=_run,
        coroutine=_arun,
        args_schema=tool.args_schema,
    )


class MCPManager:
    """管理所有 MCP server 连接与动态工具"""

    def __init__(self) -> None:
        self._tools: list[Any] = []
        self._server_status: dict[str, str] = {}
        self._connected = False

    # --------------------------------------------------------
    # 配置
    # --------------------------------------------------------

    def _load_config(self) -> dict[str, dict[str, Any]]:
        """读取 MCP 配置 (项目级优先, 合并用户级)"""
        servers: dict[str, dict[str, Any]] = {}

        candidates = [
            Path.home() / ".vca" / "mcp.json",
            Path.cwd() / ".vca" / "mcp.json",
        ]
        for path in candidates:
            if path.exists():
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                    cfg = data.get("servers", {})
                    if isinstance(cfg, dict):
                        servers.update(cfg)
                except Exception:
                    continue

        # 兼容旧格式: 无 transport 字段时默认 stdio
        for name, cfg in servers.items():
            if "transport" not in cfg and "url" not in cfg:
                cfg["transport"] = "stdio"
            if cfg.get("transport") in ("http", "sse", "websocket") and "url" not in cfg:
                # 无 url 视为无效配置
                pass

        return servers

    # --------------------------------------------------------
    # 连接与工具收集
    # --------------------------------------------------------

    async def _list_server_tools(self, cfg: dict[str, Any]) -> list[MCPTool]:
        """连接 server 并列出其工具 (短生命周期)"""
        async with create_session(cfg) as session:
            await session.initialize()
            result = await session.list_tools()
            return result.tools

    def connect(self) -> dict[str, str]:
        """
        连接所有配置的 MCP servers 并收集工具。

        Returns:
            {server_name: "ok (N tools)" | "error: ..."}
        """
        servers = self._load_config()
        if not servers:
            self._connected = True
            return {}

        status: dict[str, str] = {}
        all_tools: list[Any] = []
        multi_server = len(servers) > 1

        for name, cfg in servers.items():
            try:
                loop = asyncio.new_event_loop()
                try:
                    asyncio.set_event_loop(loop)
                    tools_list = loop.run_until_complete(self._list_server_tools(cfg))
                finally:
                    loop.close()
                    asyncio.set_event_loop(None)

                # 将 MCP 工具转换为 LangChain 工具 (调用时自动建 session)
                converted = []
                for t in tools_list:
                    lc_tool = convert_mcp_tool_to_langchain_tool(
                        session=None,
                        tool=t,
                        connection=cfg,
                        server_name=name,
                        tool_name_prefix=multi_server,
                    )
                    # 补充同步支持 (同步图需要)
                    converted.append(_make_sync_compatible(lc_tool))
                all_tools.extend(converted)
                status[name] = f"ok ({len(converted)} tools)"
            except Exception as exc:
                status[name] = f"error: {type(exc).__name__}: {exc}"

        self._tools = all_tools
        self._server_status = status
        self._connected = True
        return status

    # --------------------------------------------------------
    # 查询
    # --------------------------------------------------------

    @property
    def tools(self) -> list[Any]:
        """已收集的所有 MCP 工具"""
        return self._tools

    @property
    def is_connected(self) -> bool:
        return self._connected

    def status_text(self) -> str:
        """生成状态文本 (供 /mcp 命令显示)"""
        if not self._server_status:
            return (
                "MCP servers 未配置。\n"
                "在 ~/.vca/mcp.json 或 <项目>/.vca/mcp.json 中配置后重启生效。"
            )
        lines = ["MCP server 状态:"]
        for name, st in self._server_status.items():
            lines.append(f"  - {name}: {st}")
        if self._tools:
            names = ", ".join(t.name for t in self._tools)
            lines.append(f"共加载 {len(self._tools)} 个工具: {names}")
        return "\n".join(lines)


# 全局单例
mcp_manager = MCPManager()
