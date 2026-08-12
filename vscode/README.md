# VCA Coding Agent

Virtual Code Agent - LangGraph.js 驱动的编码 Agent，在 VS Code 内直接对话完成任务。

## 功能

- 内置工具: 读文件 / 搜索 (glob/grep) / 编辑 / 写入 / 执行命令 / 提问 / 任务计划
- 深度思考折叠展示、工具调用实时流式显示
- AskUser 交互弹窗 (多选/自定义/跳过)
- Skills 专业技能 (SKILL.md) 与 MCP 外部工具支持
- 会话自动保存，多窗口随时恢复

## 使用

1. 在 VS Code 中打开命令面板 (Ctrl+Shift+P)
2. 输入 `VCA: 打开 Coding Agent 聊天面板` 并回车
3. 输入编程任务，Agent 自动完成

首次使用需配置 API Key (编辑 `~/.vca/config.json`):

```json
{
  "OPENAI_API_KEY": "sk-...",
  "OPENAI_BASE_URL": "https://api.openai.com/v1",
  "OPENAI_MODEL": "gpt-4o-mini"
}
```

## 配置 MCP

在 `~/.vca/mcp.json` 或项目 `.vca/mcp.json` 配置:

```json
{
  "servers": {
    "fetch": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"]
    }
  }
}
```

## 开发

```bash
cd web && npm install && npm run build   # 构建前端
node scripts/build-extension.mjs          # 构建扩展 (bundle + 复制前端)
# VS Code 中按 F5 调试运行扩展
```

打包 .vsix: 在 `vscode/` 目录执行 `npx vsce package`
