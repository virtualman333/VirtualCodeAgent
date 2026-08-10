# Virtual Code Agent

基于 LangGraph 的控制台编码助手，通过自然语言与 Agent 交互，自动完成文件读取、编辑、搜索和命令执行等编程任务。

## 特性

- **自然语言交互** - 用自然语言描述编程任务，Agent 自动规划并执行
- **LangGraph 工作流** - 基于 LangGraph 的图状态机编排，支持多轮推理与工具调用
- **丰富的内置工具** - 文件读写/编辑、bash 命令执行、文件搜索（grep/find）、用户交互提问
- **工作空间管理** - 支持多项目切换，自动记录历史工作空间
- **对话持久化** - 自动保存/恢复会话，支持历史对话回溯
- **深度思考可视化** - 可折叠/展开 LLM 推理过程，支持精简与详细两种展示模式
- **多 Agent 编排 (SubAgent)** - 通过 `create_agent` 创建独立子代理处理子任务，支持后台异步与并行执行，子代理拥有独立对话历史、工具池和隔离环境
- **文件系统信箱** - 后台子代理结果通过文件系统消息目录传递，贯彻 "文件系统即上下文" 设计思想
- **MCP 集成** - 通过 `mcp.json` 配置接入任意 MCP (Model Context Protocol) Server，自动发现并加载外部工具（stdio / http / sse / websocket 多种传输方式）
- **专业技能 (Skills)** - 可插拔的专业领域技能系统，通过 `list_skills` / `load_skill` 按需加载 SKILL.md 中的领域知识与工作流，支持用户级与项目级技能目录
- **美观的终端 UI** - 基于 Rich 库，提供 Panel、Table、Markdown 渲染等

## 项目结构

```
├── run.py                          # 启动入口
├── pyproject.toml                  # 项目配置与依赖
├── requirements.txt                # 依赖列表
└── src/
    └── vca/
        ├── __init__.py             # 包信息
        ├── __main__.py             # python -m vca 入口
        ├── config.py               # 配置管理（环境变量、工作空间历史）
        ├── state.py                # Agent 状态定义（TypedDict + reducer）
        ├── storage.py              # 会话持久化存储
        ├── workspace_ctx.py        # 线程隔离的工作目录上下文（多 Agent 环境隔离）
        ├── main.py                 # CLI 主入口与交互循环
        ├── graph/
        │   ├── __init__.py
        │   └── workflow.py         # LangGraph 工作流定义
        ├── subagents/              # 多 Agent 编排
        │   ├── __init__.py
        │   ├── types.py            # SubAgent 数据模型
        │   ├── mailbox.py          # 文件系统信箱（Agent 间通信）
        │   ├── manager.py          # 子代理生命周期管理（同步/后台/并行）
        │   └── tools.py            # AgentTool 工具集（create_agent 等）
        ├── mcp/                    # MCP 集成
        │   ├── __init__.py
        │   └── manager.py          # MCP Server 连接与动态工具收集
        ├── skills/                 # 专业技能（可插拔）
        │   ├── __init__.py
        │   └── manager.py          # Skill 发现、解析与加载
        └── tools/
            ├── __init__.py
            ├── read_tool.py        # 文件读取工具
            ├── write_tool.py       # 文件写入工具
            ├── edit_tool.py        # 文件编辑工具
            ├── search_tools.py     # 搜索工具（grep/find）
            ├── bash_tool.py        # Bash 命令执行工具
            └── ask_user_tool.py    # 用户交互提问工具
```

## 快速开始

### 环境要求

- Python >= 3.11

### 安装

```bash
# 克隆项目
git clone <repo-url>
cd VirtualCodeAgent

# 创建虚拟环境（推荐）
python -m venv venv
# Windows
venv\Scripts\activate
# Linux/Mac
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt
```

### 配置

在项目根目录创建 `.env` 文件，填入 API 配置：

```env
OPENAI_API_KEY=your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini

# 可选：默认工作空间目录
WORKSPACE_DIR=./workspace
MAX_TOOL_ITERATIONS=10
```

支持任何兼容 OpenAI API 的服务（如 Azure OpenAI、本地 LLM 等），只需修改 `OPENAI_BASE_URL` 和 `OPENAI_MODEL`。

### 运行

```bash
# 直接运行
python run.py

# 指定工作空间
python run.py /path/to/your-project

# 或使用 -w 参数
python run.py -w /path/to/your-project

# 列出最近使用的工作空间
python run.py --list-workspaces
```

## 使用指南

### 基本用法

启动后，直接在提示符下输入编程任务描述，Agent 将自动完成：

```
my-project > 在当前目录创建一个 hello.py，打印 "Hello, World!"
my-project > 列出所有 Python 文件和它们的大小
my-project > 帮我写一个简单的 Flask API，包含 /health 端点
my-project > 运行 pytest 并修复失败的测试
```

### 内置命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/clear` | 清除当前对话历史 |
| `/workspace` | 显示工作空间详情 |
| `/cd <路径>` | 切换工作空间目录 |
| `/verbose` | 切换深度思考展开/折叠模式 |
| `/history` | 查看对话历史记录 |
| `/load` | 恢复上一次对话 |
| `/load <编号>` | 恢复指定编号的历史对话 |
| `/agents` | 查看所有 SubAgent（子代理）状态 |
| `/config` | 显示当前配置 |
| `/save` | 手动保存当前对话 |
| `/exit` | 退出程序 |

### 工作空间

工作空间是 Agent 操作文件、运行命令的根目录。启动时会提供交互式选择：

1. **历史工作空间** - 快速回访之前的项目
2. **当前目录** - 使用终端当前所在目录
3. **默认工作空间** - `./workspace`
4. **手动输入** - 输入任意路径（不存在可自动创建）

在 Agent 运行过程中，也可使用 `/cd` 命令随时切换工作空间。

## 架构概览

### LangGraph 工作流

```
User Input → agent (LLM 推理) → tools (工具执行) → respond (生成回复)
                ↑                      │
                └──────────────────────┘
                   (循环，直到任务完成)
```

- **agent 节点** - LLM 推理，决定下一步行动（调用工具或生成最终回复）
- **tools 节点** - 执行工具调用，收集结果
- **respond 节点** - 汇总结果，生成用户友好的回复

### Agent 状态

`AgentState` 是一个 `TypedDict`，包含：

- `messages` - 消息历史（自动累积，使用 `add` reducer）
- `plan` - 当前执行计划（分步骤）
- `tool_results` - 工具执行结果
- `iteration` - 迭代计数器（防止无限循环）
- `workspace_dir` - 当前工作空间路径
- `pending_question` - 挂起的用户问题（AskUser 功能）

## 多 Agent 编排 (SubAgent)

主 Agent 通过 **AgentTool** 创建若干独立的 Agent Loop（SubAgent）来处理子任务，
实现从"个体户"到"团队作业"的进化——主 Agent 扮演"包工头"，将任务下发给"员工"。

### 核心优势

- **独立上下文** - 每个 SubAgent 拥有独立的 system prompt、对话历史、工具池与隔离的工作目录，全部针对具体子任务设置，更专业、更安全
- **防上下文污染** - SubAgent 只把与主线任务相关的精简结果返回给主 Agent，大段中间过程不会进入主线上下文
- **后台异步** - SubAgent 可在后台线程独立运行，不影响主 Agent 继续处理主线任务
- **并行执行** - 相互无依赖的子任务可通过多个后台 SubAgent 并行完成

### AgentTool 工具

| 工具 | 说明 |
|------|------|
| `create_agent(task, name?, instructions?, wait?, tools?, workspace?)` | 创建并启动子代理。`wait=True` 同步等待结果；`wait=False`（默认）后台运行并返回 `agent_id` |
| `get_agent_result(agent_id, timeout?)` | 获取子代理结果。未完成时阻塞等待，最长 `timeout` 秒 |
| `list_agents()` | 列出所有子代理及其状态 |
| `delete_agent(agent_id)` | 删除子代理记录（内存 + 信箱） |

编排示例（由主 Agent 的 LLM 自行决定）：

```text
任务: 同时分析项目的前端和后端结构
→ create_agent(task="分析 src/frontend 目录结构并总结技术栈", name="前端分析", wait=False)
→ create_agent(task="分析 src/backend 目录结构并总结 API 设计", name="后端分析", wait=False)
→ get_agent_result(agent_id="sub_xxx_1")  → 得到精简结果
→ get_agent_result(agent_id="sub_xxx_2")
```

### 隔离环境

每个 SubAgent 通过 `workspace_ctx`（线程级 `contextvars`）拥有独立的工作目录，
`bash` / `read_file` / `write_file` / `edit_file` / `glob_files` / `grep_content`
等工具均按当前线程的逻辑工作目录解析路径，多个 Agent 并行时互不干扰。

### 文件系统信箱

参考 Claude Code 的 "文件系统即上下文" 设计，后台 SubAgent 完成后将结果写入
文件系统的消息目录（信箱），主 Agent 无需复杂的消息队列即可读取：

```
~/.vca/agents/<agent_id>/
├── status.json   # 状态 + 结果元信息
└── result.txt    # 精简结果文本
```

- 主 Agent 重启后仍可通过 `get_agent_result` 从信箱恢复结果
- CLI 中可用 `/agents` 命令查看所有子代理状态

### 与 Skill 的联动

- **Skill 包 Agent**：Skill 的 prompt 里写好编排策略，指挥 LLM 启动多个并行 SubAgent
- **Agent 包 Skill**：把数千 tokens 的长 Skill prompt 交给隔离子代理执行（Fork），
  仅返回精简结果，不污染主线对话

## MCP 集成

通过 [Model Context Protocol](https://modelcontextprotocol.io) 接入外部工具与服务。
在项目根目录（或用户目录 `~/.vca/`）放置 `mcp.json` 即可声明要连接的 MCP Server，
启动时 `mcp/manager.py` 会自动读取配置、建立连接并收集所有可用工具，注入到 Agent 的工具集中。

### 配置文件格式

```json
{
  "servers": {
    "fetch": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"]
    },
    "http_server": {
      "transport": "http",
      "url": "http://localhost:8000/mcp"
    }
  }
}
```

支持的传输方式：`stdio` / `http` / `sse` / `websocket`。
每个 MCP 工具在调用时按需创建/销毁 session，无需维护长连接。

### 使用

- 启动后 Agent 会自动获得 MCP Server 提供的工具，无需额外命令
- 用 `/config` 命令可查看当前已加载的 MCP 工具
- 新增/修改 `mcp.json` 后重启程序即可生效

## 专业技能 (Skills)

Skills 是可插拔的专业领域技能包，每个 Skill 是一个包含 `SKILL.md` 的目录，
其中写明该领域的知识、工作流程与注意事项。Agent 通过 `list_skills` 发现可用技能，
用 `load_skill` 将技能内容加载到上下文后，即可按专业流程完成任务。

### 技能目录

Skill 从以下位置自动发现（按优先级合并，同名后者覆盖前者）：

- **用户级**：`~/.vca/skills/<skill_name>/`
- **项目级**：`<工作空间>/.vca/skills/<skill_name>/` 与 `<工作空间>/skills/<skill_name>/`

### SKILL.md 结构

```markdown
---
name: web-scraping
description: 网页抓取与解析的专业技能
---

# Web Scraping

## 工作流程
1. 分析目标页面结构 ...
2. 选择合适的解析方式 ...
## 注意事项
- 遵守 robots.txt ...
```

### 使用

- `list_skills()` - 列出所有可用技能（名称 + 描述）
- `load_skill(skill_name)` - 加载指定技能到上下文，获得其完整工作流与注意事项
- 需要专业领域知识（如特定框架、协议、工具链）时，先 `list_skills` 再 `load_skill`

## 依赖

| 包 | 用途 |
|----|------|
| langgraph | 图状态机编排 |
| langchain-core | 消息与工具集成 |
| langchain-openai | OpenAI 兼容 LLM |
| langchain-mcp-adapters | MCP 工具转换为 LangChain 工具 |
| mcp | MCP (Model Context Protocol) 客户端 |
| python-dotenv | 环境变量加载 |
| rich | 终端 UI 渲染 |
| colorama | 跨平台终端颜色 |
| Pillow | 图片处理 |
| PyPDF2 | PDF 读取 |
| PyYAML | Skill 元数据解析 |

## 开发

```bash
# 安装开发依赖
pip install -e ".[dev]"

# 运行测试
pytest
```

## License

MIT
