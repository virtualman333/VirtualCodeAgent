# Virtual Code Agent (VCA)

> LangGraph.js 驱动的编码 Agent —— 通过对话自动完成编程任务，支持控制台、Web、VS Code 三种形态。

VCA 是一个以 TypeScript 重写的编码 Agent，底层用 [LangGraph.js](https://github.com/langchain-ai/langgraphjs) 编排 Agent 工作流，调用 OpenAI 兼容的大模型，并通过一组内置工具（读/写/搜/执行命令等）在指定工作空间内自主完成编码任务。

---

## 特性

- **多形态运行**：同一套核心 Agent，可跑在控制台 CLI、独立 Web 面板、或 VS Code 扩展里。
- **内置工具集**（`src/tools/`）：读文件、搜索（glob / grep）、编辑、写入、执行命令（bash）、提问（ask_user）、任务计划（plan）。
- **会话持久化**：对话自动保存，可随时 `/load` 恢复历史会话、切换工作空间。
- **交互式打断**：执行过程中可用 `Ctrl+C` 中断；Agent 遇到歧义时通过 `ask_user` 向用户确认。
- **多模型切换**：支持在 `config.json` 中配置多个模型并运行时切换（`/model`）。
- **可扩展（规划中）**：Skills 专业技能（SKILL.md）与 MCP 外部工具接口已在架构中预留，TS 版正在接入。

---

## 技术栈

| 层 | 选型 |
|----|------|
| 核心编排 | TypeScript + `@langchain/langgraph` |
| 模型接入 | `@langchain/openai`（OpenAI 兼容接口，可自定义 base_url / model） |
| 前端 | Vue 3 + Vite（`web/`） |
| 编辑器集成 | VS Code Extension（Webview 面板，`vscode/`） |
| 通信 | WebSocket（`ws`）连接后端 Agent 服务 |
| 构建 | `tsc` / `esbuild` / `vsce` |

---

## 目录结构

```
.
├── src/                 # TS 版核心 Agent
│   ├── agent/           # 状态图编排 (graph)、会话、提示词、runner
│   ├── tools/           # 内置工具：read / search / edit / write / bash / ask_user / plan
│   ├── mcp/             # MCP 管理器（规划中）
│   ├── skills/          # Skills 管理器（规划中）
│   ├── config.ts        # 配置加载（~/.vca/config.json）
│   ├── main.ts          # 控制台 CLI 入口
│   ├── server.ts        # HTTP + WebSocket 服务（供 Web 使用）
│   └── workspace*.ts    # 工作空间选择与管理
├── vscode/              # VS Code 扩展（聊天面板、AskUser 弹窗、工具调用流式展示）
├── web/                 # 独立 Web 聊天前端（Vue 3 + Vite）
├── scripts/             # 扩展构建脚本（build-extension.mjs）
├── build-vsix.bat       # 一键构建并打包 VSIX（Windows）
└── python_legacy/       # 早期 Python 实现（已弃用，仅作参考保留）
```

---

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 API Key

编辑 `~/.vca/config.json`（首次运行会自动创建模板）：

```json
{
  "OPENAI_API_KEY": "sk-...",
  "OPENAI_BASE_URL": "https://api.openai.com/v1",
  "OPENAI_MODEL": "gpt-4o-mini"
}
```

> 支持任意 OpenAI 兼容端点（如本地推理、第三方中转），只需改 `OPENAI_BASE_URL` 与 `OPENAI_MODEL`。

---

## 三种运行形态

### A. 控制台 CLI

```bash
npm run dev
```

常用参数：

```bash
npm run dev -- -w <工作空间路径>     # 指定工作空间
npm run dev -- -m <模型名>           # 指定模型
npm run dev -- --list-workspaces     # 列出可用工作空间
```

控制台内置命令（输入 `/help` 查看完整列表）：

| 命令 | 说明 |
|------|------|
| `/new` | 开启新对话窗口 |
| `/clear` | 清除对话历史 |
| `/cd <路径>` | 切换工作空间 |
| `/workspace` | 显示当前工作空间 |
| `/verbose` | 切换思考展开 / 折叠 |
| `/todo` | 查看当前任务计划 |
| `/config set K V` | 修改配置 |
| `/model [名称\|序号]` | 查看 / 切换模型 |
| `/save` `/load [序号]` `/history` | 保存 / 恢复 / 列出会话 |
| `/exit` | 退出 |

### B. Web 面板

先构建前端，再启动服务：

```bash
npm run build:web     # cd web && npm install && npm run build
npm run serve         # tsc && node dist/server.js
```

浏览器打开 `http://localhost:3001`（可用 `PORT` 环境变量改端口）。开发模式下也可分开跑：

```bash
npm run server        # 后端 WS 服务 (3001)
npm run web:dev       # 前端 Vite dev server (5173)，代理 /ws → 3001
```

### C. VS Code 扩展

```bash
build-vsix.bat        # 完整构建并打包 VSIX（Windows）
```

或在 `vscode/` 目录执行 `npx vsce package`。安装后在命令面板（Ctrl+Shift+P）运行
`VCA: 打开 Coding Agent 聊天面板`，输入任务即可。

> 扩展详细用法见 [`vscode/README.md`](vscode/README.md)。

---

## 配置说明

### 模型配置

`~/.vca/config.json` 支持配置多个模型，运行时用 `/model` 切换：

```json
{
  "OPENAI_API_KEY": "sk-...",
  "OPENAI_BASE_URL": "https://api.openai.com/v1",
  "OPENAI_MODEL": "gpt-4o-mini",
  "MODELS": [
    { "name": "default", "model": "gpt-4o-mini", "base_url": "https://api.openai.com/v1" },
    { "name": "deepseek", "model": "deepseek-chat", "base_url": "https://api.deepseek.com/v1" }
  ]
}
```

### MCP 配置（规划中）

架构已预留 MCP 管理器（`src/mcp/`），TS 版接入进行中。配置约定沿用项目级 `.vca/mcp.json` 或用户级 `~/.vca/mcp.json`：

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

---

## 开发

```bash
npm run typecheck     # 类型检查 (tsc --noEmit)
npm run build         # 编译 TS → dist/
npm run start         # 运行编译后的 CLI (node dist/main.js)
```

调试 VS Code 扩展：构建前端与扩展后，在 VS Code 中按 **F5** 启动扩展开发宿主。

---

## 版本

- 当前核心版本：**0.2.0**（TypeScript 重写版）
- VS Code 扩展已打包：`vscode/vca-coding-agent-0.1.2.vsix`
- `python_legacy/` 为早期 Python 实现，已弃用，仅保留作参考。

---

## License

见 [`vscode/LICENSE`](vscode/LICENSE)。
