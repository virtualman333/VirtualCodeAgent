# Virtual Code Agent

基于 LangGraph 的控制台编码助手，通过自然语言与 Agent 交互，自动完成文件读取、编辑、搜索和命令执行等编程任务。

## 特性

- **自然语言交互** - 用自然语言描述编程任务，Agent 自动规划并执行
- **LangGraph 工作流** - 基于 LangGraph 的图状态机编排，支持多轮推理与工具调用
- **丰富的内置工具** - 文件读写/编辑、bash 命令执行、文件搜索（grep/find）、用户交互提问
- **工作空间管理** - 支持多项目切换，自动记录历史工作空间
- **对话持久化** - 自动保存/恢复会话，支持历史对话回溯
- **深度思考可视化** - 可折叠/展开 LLM 推理过程，支持精简与详细两种展示模式
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
        ├── main.py                 # CLI 主入口与交互循环
        ├── graph/
        │   ├── __init__.py
        │   └── workflow.py         # LangGraph 工作流定义
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

## 依赖

| 包 | 用途 |
|----|------|
| langgraph | 图状态机编排 |
| langchain-core | 消息与工具集成 |
| langchain-openai | OpenAI 兼容 LLM |
| python-dotenv | 环境变量加载 |
| rich | 终端 UI 渲染 |
| colorama | 跨平台终端颜色 |
| Pillow | 图片处理 |
| PyPDF2 | PDF 读取 |

## 开发

```bash
# 安装开发依赖
pip install -e ".[dev]"

# 运行测试
pytest
```

## License

MIT
