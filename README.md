# Virtual Code Agent (VCA)

![logo](vscode/media/logo.png)

> LangGraph.js 驱动的编码 Agent —— 通过对话自动完成编程任务，支持控制台、Web、VS Code、桌面端四种形态。

VCA 是一个以 TypeScript 重写的编码 Agent，底层用 [LangGraph.js](https://github.com/langchain-ai/langgraphjs) 编排 Agent 工作流，调用 OpenAI 兼容的大模型，并通过一组内置工具（读/写/搜/执行命令等）在指定工作空间内自主完成编码任务。

---

## 特性

- **多形态运行**：同一套核心 Agent，可跑在控制台 CLI、独立 Web 面板、VS Code 扩展、或桌面端（Electron）里。
- **内置工具集**（`src/tools/`）：读文件、搜索（glob / grep）、编辑、写入、执行命令（bash）、提问（ask_user）、任务计划（plan）。执行命令那一环带**危险命令拦截**（删根目录 / 格式化 / 裸设备写入这一类不可逆操作，换写法也拦得住，见下面「命令安全护栏」），正常清理不受影响。
- **会话持久化**：对话自动保存，可随时 `/load` 恢复历史会话、切换工作空间。
- **交互式打断**：执行过程中可用 `Ctrl+C` 中断；Agent 遇到歧义时通过 `ask_user` 向用户确认。
- **交互式输入**：`↑`/`↓` 翻回敲过的内容（**跨会话保留**，与 Python 版**共用同一个历史文件、且双向可读**），`Tab` 补全命令、路径、配置键与模型名；`/input` 可搜索、按条数查看、清空这份历史（不用再一条条按 `↑` 找）。
- **多模型切换**：支持在 `config.json` 中配置多个模型并运行时切换（`/model`）。
- **可扩展**：Skills 专业技能（`SKILL.md`，用户级 / 项目级目录都能发现）与 MCP 外部工具接口均已接入，Agent 侧通过 `list_skills` / `load_skill` 取用技能，MCP 工具在每轮对话时动态并入工具池。用 `/skills`、`/mcp` 查看实际发现到什么。
- **子代理（SubAgent）**：主 Agent 能把一件能独立做完的子任务派出去（`spawn_subagent`），等它跑完再拿回一段精简汇报。子代理有**自己的工作目录与工具白名单**（`explorer` / `editor` / `tester` 三套预设，也可以直接点名工具），有自己的上下文，读过的文件不会占用主对话的额度。用 `/agents` 看预设与本次会话的运行记录。

---

## 技术栈

| 层 | 选型 |
|----|------|
| 核心编排 | TypeScript + `@langchain/langgraph` |
| 模型接入 | `@langchain/openai`（OpenAI 兼容接口，可自定义 base_url / model） |
| 前端 | Vue 3 + Vite（`web/`） |
| 编辑器集成 | VS Code Extension（Webview 面板，`vscode/`） |
| 桌面端 | Electron（外壳 + 内嵌后端，`electron/`，由 electron-builder 打包） |
| 通信 | WebSocket（`ws`）连接后端 Agent 服务 |
| 构建 | `tsc` / `esbuild` / `vite` / `vsce` / `electron-builder` |

---

## 目录结构

```
.
├── src/                 # TS 版核心 Agent
│   ├── agent/           # 状态图编排 (graph)、子代理 (subagents / subagent_manager)、会话、提示词、runner
│   ├── tools/           # 内置工具：read / search / edit / write / bash / ask_user / plan / subagent
│   │                    #          + executable（哪些能进 ToolNode，零依赖叶子模块，便于单测）
│   ├── mcp/             # MCP 管理器：读配置、连 server、收集动态工具
│   ├── skills/          # Skills 管理器：发现 / 解析 / 加载 SKILL.md
│   ├── config.ts        # 配置加载（~/.vca/config.json）
│   ├── paths.ts         # 路径工具（expandUser）。单独成文件是为了让 completer 不必 import config
│   ├── cli-args.ts      # CLI 参数解析（纯函数，参数契约的唯一来源）
│   ├── help.ts          # 斜杠命令清单（单一来源，/help 由它渲染）
│   ├── completer.ts     # Tab 补全（纯函数：一行输入 → 候选 + 待替换的 token）
│   ├── input-history.ts # ↑/↓ 输入历史（读写 ~/.vca/input_history）
│   ├── ui.ts            # ANSI 颜色 / 面板 / 显示宽度 / Markdown 渲染
│   ├── version.ts       # 版本号读取（唯一来源是 package.json，源码里不抄第二份）
│   ├── storage.ts       # 会话持久化：消息 ↔ JSON，路径绑定在 VCA_DIR 上
│   ├── session-store.ts # 会话索引 / 列表 / 搜索 / 删除（零依赖，目录由调用方传入，可单测）
│   ├── main.ts          # 控制台 CLI 入口
│   ├── server.ts        # HTTP + WebSocket 服务（供 Web 使用）
│   └── workspace*.ts    # 工作空间选择与管理
├── tests/               # 测试：每个主题一个 *.test.ts，`npm test` 全跑 —— 清单以目录为准，
│                        #       这里只举例：纯函数的 cli-args / help / completer /
│                        #       input-history / ui / version，真起子进程的 cli-spawn（含启动面板对齐）
├── vscode/              # VS Code 扩展（聊天面板、AskUser 弹窗、工具调用流式展示）
├── electron/            # 桌面端外壳（主进程 + preload；由 electron-builder 打包）
├── web/                 # 独立 Web 聊天前端（Vue 3 + Vite），同时供桌面端复用
├── scripts/             # 构建脚本：build-extension.mjs（扩展）/ build-vsix.mjs（构建 + 打 VSIX）
│                        #          / build-electron.mjs（桌面端）/ publish.mjs（扩展发布）
├── build-vsix.bat       # `npm run vsix` 的 Windows 包装（只转发，没有第二份逻辑）
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

## 四种运行形态

### A. 控制台 CLI

```bash
npm run dev
```

常用参数：

```bash
npm run dev -- -w <工作空间路径>     # 指定工作空间
npm run dev -- -m <模型名>           # 指定模型
npm run dev -- --list-workspaces     # 列出可用工作空间
npm run dev -- --help                # 查看完整用法
npm run dev -- --version             # 查看版本号
```

位置参数等同 `-w`，所以 `vca /path/to/project` 与 `vca -w /path/to/project` 一样。

参数写错一律报错退出（退出码 `2`，用法写到 stderr），**不会**静默退回默认值：

| 写法 | 结果 |
|------|------|
| `vca --hlep` | 报错，并提示「是否想输入 --help？」 |
| `vca -m` | 报错：`-m` 后面要跟一个值（旧行为是悄悄用默认模型启动） |
| `vca -w -m gpt` | 报错：读到的是选项 `-m`，不是值 |
| `vca -w a -w b` | 报错：重复指定 |
| `vca -w a b` | 报错：既给了 `-w` 又给了位置参数 |

`--help` 与 `--version` 是特权选项：出现在 `--` 之前就立即生效，**不受**其它参数写错的影响，也排在 API Key 校验之前 —— 首次安装还没填 key 时照样能看到帮助。

控制台内置命令（输入 `/help` 查看完整列表）：

| 命令 | 说明 |
|------|------|
| `/new` | 开启新对话窗口 |
| `/clear` | 清除对话历史 |
| `/cd <路径>` | 切换工作空间 |
| `/workspace` | 显示当前工作空间 |
| `/verbose` | 切换思考展开 / 折叠 |
| `/todo` | 查看当前任务计划 |
| `/skills` | 列出已发现的技能（含技能目录，方便自己放 `SKILL.md`） |
| `/mcp` | 查看 MCP server 配置与连接状态 |
| `/agents` | 子代理：可用预设 + 本次会话派过的子代理与运行状态 |
| `/config set K V` | 修改配置 |
| `/model [名称\|序号]` | 查看 / 切换模型 |
| `/save` `/load [序号]` | 保存 / 恢复历史会话（序号取自 `/history` 列出的那一份） |
| `/history [条数\|关键字\|del <序号>]` | 查看 / 搜索 / 删除历史会话 |
| `/input [条数\|关键字\|clear]` | 查看 / 搜索 / 清空输入历史（`↑` 翻的那些） |
| `/exit` | 退出 |

上表是分组摘要；命令清单的唯一来源是 `src/help.ts` 里的 `COMMANDS`，`/help` 的输出由它渲染，`tests/help.test.ts` 会双向比对它与 `main.ts` 里 `handleCommand` 的 `case` 分支 —— 声明了却没实现、或实现了却没声明，都会让测试变红。

#### 交互式输入：↑ 历史与 Tab 补全

`↑` / `↓` 翻回敲过的内容，`Tab` 补全。两样都是 Python 版原本就有、TS 重写时丢掉的，现在补回来了。

| 敲到哪一步 | Tab 补什么 |
|---|---|
| 行首（`/`、`/he`） | 命令名。清单取自 `help.ts`，顺序与 `/help` 输出一致 |
| `/cd ` | 目录（只列目录，不列文件；相对路径以当前工作空间为基准；`~` 原样保留，不会被展开成真实家目录） |
| `/config ` | 子命令 `set`；再往下补 `EDITABLE_KEYS` 里的配置键（`/config set MAX` → 两个 `MAX_*`） |
| `/model ` | 已配置的模型名，顺序与 `/model` 的编号一致 |

三条约定：

- **只在命令上下文里补**。普通输入是给 Agent 的任务描述（自然语言），在那种句子里到处插路径补全只会碍事，所以不以 `/` 开头的行一律不给候选。
- **命令清单不另抄一份**。候选里的命令名、配置键、模型名全部由调用方注入，都取自各自的单一来源（`help.ts` / `EDITABLE_KEYS` / `Config`）—— 抄一份必然漂移：加了命令却忘了同步，Tab 就永远补不出它。
- **候选最多 40 条**。在盘符根目录按一下 Tab 不该把整屏刷掉。

历史存在 `~/.vca/input_history`，**与 Python 版（prompt_toolkit 的 FileHistory）是同一个文件**，而且是**双向**的：那边留下的历史这边读得回来，这边敲的那边也读得回来。规则：最多 500 条、空行不记、与上一条完全相同不记（按住回车不会把历史刷满）、多行粘贴压成单行。文件里最早在前，内存里最新在前（`↑` 从最近一条往前翻）。

落盘格式就是 prompt_toolkit 那一套：每条写成一行 `+<内容>`，条目之间空一行。**下面这三条都是踩过才知道的**，谁要动落盘格式先照这张表核一遍 —— `tests/input-history.test.ts` 里有一条跨语言契约锁，**照抄 prompt_toolkit 自己的读取算法**跑往返，改坏哪一条都会红：

| 规则 | 少写会怎样 |
|---|---|
| 每条加 `+` 前缀 | 整行被 prompt_toolkit 当成**分隔符**，内容**静默丢弃** —— 敲过 `+86…` 这类输入的人永远读不回来 |
| 条目之间要有非 `+` 行 | 相邻几条被拼成**一条多行历史**（实测 21 条读成 1 条 21 行的巨型条目，不报错，用户只觉得历史没了） |
| 读的时候剥掉 `+` | `↑` 翻出来的**每一条**前面都挂一个 `+`（实测 21/21 条如此） |

分隔用空行而不是 prompt_toolkit 那种 `# <时间戳>`：格式上完全等价（判据只是「这一行不是 `+` 开头」），而内存里没有逐条时间，凭空盖一个「现在」是假信息。反过来，读的时候 **`+` 行要先剥前缀再判别**：用户真敲过 `# 2026-01-01 的计划` 的话，落盘是 `+# 2026-01-01 的计划`，先按行首判注释就会把这条真实输入当成时间戳吃掉。

#### `/input`：历史不该只是个按 `↑` 的暗盒

`↑` 只适合「上一条、再上一条」。隔了几十条之后想找「那句带 redis 的」基本找不到，而且此前**没有任何办法清掉它** —— 复制粘贴过的东西会一直躺在文件里，下次 `↑` 还能翻出来。

| 敲法 | 行为 |
|---|---|
| `/input` | 列最近 20 条，最新在前，序号与 `↑` 的顺序一致 |
| `/input <关键字>` | **子串**匹配（不区分大小写，两边空白不计），并如实报出「命中 N / 共 M 条」 |
| `/input <条数>` | 只看最近 N 条（1 ~ 500），超出部分提示「还有 M 条没显示」 |
| `/input clear` | 清空 —— **内存与文件一起清**，重启不会又冒出来 |

```
❯ /input redis
输入历史 · 匹配「redis」 2 / 5 条:
   1. redis 缓存策略要怎么设计
   2. 帮我看看这段 redis 连接超时的报错
↑/↓ 翻回，/input <关键字> 搜索，/input clear 清空
```

三条约定：

- **参数语义只有一处**。`''`→列表、正整数→条数（夹到 1~500）、`clear`→清空、其余一律当关键字，全部由 `src/input-history.ts` 的 `parseInputArg` 决定；命令里只在**解析结果**上分支，不自己判一次 `clear`，也不自己 `filter` 一遍。`tests/input-history.test.ts` 里有结构锁按这条检查 `main.ts` 的源码。
- **读的是 `↑` 正在用的那一份历史**（内存里的 `cs.inputHistory`），不重新读文件：刚敲的那条还没落盘，读文件会得到差一条的另一份。
- **清空先清内存、再落盘**，且 `clearHistory` 是**原地清空并返回同一个引用** —— 只清一边都不算清（只清文件 `↑` 还翻得出来，只清内存重启全回来）。

> 顺带一个已知限制：`promptUser` 每次读取一行后就关掉 readline，所以**把多行文本一次性粘贴进输入框只有第一行会生效**。这与本轮改动无关（原本如此），记在这里免得下次又当成新 bug 查一遍。

#### `/history`：会话也不该只是个「第几个」的暗盒

会话（`~/.vca/sessions/<id>.json`）此前只有两个动作：`/history` 把它列出来、`/load <序号>` 进去。三件事都不成立：

- **只能增不能减**。`src/storage.ts` 里 `deleteSession` 一直躺着、**零调用** —— 粘过 API Key、或聊错项目的会话会永远留在 `~/.vca/sessions/` 里，唯一的删法是自己去文件管理器翻。搜索也没有，会话攒多了只能一条条 `/load` 试。
- **序号窗口手抄在两处**。`/history` 列 `listSessions(10)`，`/load <序号>` 也读 `listSessions(10)` —— 同一个 `10` 写了两遍，而 `listSessions()` 的默认值又是 `20`。于是提示符上那个窗口号（`cs.windowNo`）**从第 21 条会话起永远停在 `#21`**：不报错，只是那个数字不再变了。
- **索引外的会话会静默消失**。索引写盘时硬砍成 50 条，被砍掉的会话文件还在磁盘上，却既列不出来、也载不回来。

现在：

| 敲法 | 行为 |
|---|---|
| `/history` | 列最近 10 个，最新在前，序号与 `/load <序号>` 一一对应 |
| `/history <条数>` | 只看最近 N 个（1 ~ 500），超出部分提示还有多少个没显示 |
| `/history <关键字>` | **子串**匹配（不区分大小写）**标题与工作空间**两栏，并如实报出「命中 N / 共 M」 |
| `/history del <序号>` | 删除：**会话文件与索引记录一起删** |

四条约定：

- **索引只是缓存，真值永远是 `sessions/*.json`**。两者可以不一致（索引里最多留 500 条记录，超出时最旧的滚出索引；也可能被手删过，或者换机器只拷了 `sessions/` 目录），所以列表 = 索引条目 **+ 索引外的会话文件** —— 后者标成「未登记」并把文件名亮出来，照样能 `/load`、能 `/history del`。把它们藏起来才是真正不可接受的：用户再也找不回自己的对话，而且不会看到任何报错。
- **`del` 只删一条**，不提供「清空全部」。一次手滑删掉所有会话不可逆；`/input clear` 敢一把清空，是因为它清掉的是「敲过的命令」那种可再生数据。
- **删的若是当前窗口那一条，内存里的对话也一起丢**。否则主循环下一轮自动保存就把同一份对话写回同一个 id —— 用户看到「已删除」，文件却还在。这一条有端到端测试钉着（退出时那次自动保存真的不会再写进那个 id）。
- **参数语义只有一处**。`''` → 列表、正整数 → 条数、`del <序号>` → 删除、其余一律当关键字，全由 `src/session-store.ts` 的 `parseHistoryArg` 决定（与 `/input` 的 `parseInputArg` 同构）；命令里只在**解析结果**上分支，不自己判一次 `del`。列表窗口同理：`/history` 与 `/load` 共用一个 `storage.getListWindow()`，两处各写一个 `10` 就会各走各的。

> 会话与输入历史是**两回事**：`~/.vca/input_history` 存的是「敲过什么」（一条条输入，可跨会话翻），`~/.vca/sessions/` 存的是「聊过什么」。前者与 Python 版共用同一个文件，后者是本仓库自己的格式。
>
> 这一层的逻辑单独放在零依赖的 `src/session-store.ts`（目录由调用方传入），所以能被单测跑在临时目录上 —— `storage.ts` 会 `import config.ts`，而后者在 import 时就真写 `~/.vca/config.json`。同一个理由先前已经拆出过 `paths.ts` 与 `tools/executable.ts`。

#### 子代理：把一件子任务派出去做完

主 Agent 遇到「要读一堆文件才能得出结论」的活时，可以整件派给一个子代理，而不是把几十个文件的原文全读进自己的上下文。

| 工具 | 用途 |
|---|---|
| `spawn_subagent` | 派出去并**等它跑完**（同步阻塞，不是后台任务）。同一轮里调多次会并发执行 |
| `list_subagent_runs` | 本次会话派过哪些子代理、状态 / 工具调用次数 / 耗时 |
| `get_subagent_result` | 按 id 再取某个子代理的完整汇报 |

三条约定，每条都是踩出来的：

- **子代理看不见本次对话**。它只拿到一段任务描述和一份**独立**的 system prompt，所以 `task` 必须自包含（目标、范围、验收标准都写清楚）。它读过的文件、跑过的命令也不进主对话历史，只有一段精简汇报回得来 —— 太长会留头留尾并写明省了多少字符（只留头会看不到结论，而结论几乎总在最后；只留尾则看不到它做了什么）。
- **安全边界由构造保证，不是靠拦**。子代理永远拿不到 `ask_user`（没有人可以问它，留着它会在「向用户提问」上永久挂起 = 整轮任务卡死）与派发类工具（否则子代理能无限套娃，成本与并发都不受控）。这不是「检查它有没有乱调」，而是**它看不见这些工具**：白名单同时过滤掉「绑给模型的」与「`ToolNode` 能执行的」两份 —— 只过滤前者的话，模型写出来的调用请求照样会被执行，白名单就成了假锁。拿 `explorer` 预设的子代理**没有写文件的能力**。
- **白名单没生效会说出来**。写了不认识的名字、或写了被禁用的工具，回包里会列出被忽略的名字；一个都没匹配上时回落到默认工具池并明确警告 —— 不然「我明明写了 `write_file`」和「子代理悄悄只能读」在主 Agent 眼里长得一模一样。

子代理的工作目录默认跟着主代理，也可以用 `workspace` 参数指到子目录去；工作目录的隔离靠 `AsyncLocalStorage` 挂在子代理自己的异步链上（`src/workspace_ctx.ts`），跑完还会把模块级变量还原 —— 少了这一步，子代理跑完之后主代理所有相对路径都会解析到子代理的目录里，文件写到别处去且**不报任何错**。

`/agents` 列出的预设清单来自代码里的常量（`src/agent/subagents.ts` 的 `BUILTIN_PRESETS`），这里不抄一份：抄一份必然漂移。

#### 颜色：只有 `ui.ts` 的 `esc()` 能产出转义序列

`src/ui.ts` 开头那十几行 helper（`red` / `green` / `blue` / `cyan` / `dim` / `bold` …）是**唯一**的 SGR 产出处。这条声称原本只是注释里的一句话，于是同一件事在仓库里长到了四份：

| 位置 | 形态 |
|---|---|
| `src/ui.ts` | `esc()` —— 唯一那份 |
| `src/main.ts` | 本地 `red` / `blue`（`\x1b[31m` 拼字符串）→ 已清 |
| `src/agent/runner.ts` | 本地 `red` / `blue` → 本轮清 |
| `src/workspace.ts` | 本地 `green` → 本轮清 |

main.ts 里那份走的时候还留了段注释：「ANSI 处理一旦在 ui.ts 里统一改动（比如加 NO_COLOR 支持），这两份副本不会跟着变」—— 话说对了，但**只清了 main.ts 那一处**，另外两处原样留了一整轮。副本的代价不是多几行：加 NO_COLOR、换主题、改成 24 位色这类「在 ui.ts 里统一改」的事一旦发生，副本一律不跟，**而且不报错**。

现在这句话有检查扛着：`tests/ansi-source.test.ts` 扫全仓 `.ts` 源码，**剥掉注释之后**只要在 `ui.ts` 之外出现裸转义序列（`\x1b[31m` 这种拼字符串的形态，以及 `/\x1b\[31m/` 这种正则字面量形态）就红。`tests/` 被刻意排除 —— 那里的裸转义是喂给 `stripAnsi` / `displayWidth` 的**测试数据**，是消费者不是生产者。

#### 面板对齐：宽度一律按**显示宽度**算

`src/ui.ts` 里的 `displayWidth` 是唯一的口径：CJK 与常见绘文字算 2 列，ANSI 序列不计。`padRight`、`clipToWidth`、`wrapToWidth`、命令表的说明列、`panel` 全走它。

这里踩过一个**不出声**的坑，而且是同一个坑的两种形态：

- **补白按码元算**。`panel` 原先用 `stripAnsi(l).length`，而一个汉字占 2 列却只占 1 个码元 —— 启动时那个「就绪」面板（工作空间路径、`/help` 说明全是中文）右边框随每行的中文数量忽左忽右，实测上下边框 34 列、正文行 34~50 列，**不报任何错**。
- **宽度算小了**。宽度被量少 → `inner` 比正文还窄 → 本该完整显示的行被截断加省略号。行与行之间**仍然是等宽的**，看的人只会发现自己的路径少了半截。

两条约定：

- **正文行与标题行的边框开销不一样**：正文是 `│ ` + 内容 + ` │`（4 列），标题是 `┌─ ` + 标题 + ` ` + 补线 + `┐`（5 列）。两者分别算，否则标题那行永远宽 1 列。
- **终端比内容窄时才截断**，给一个带 `…` 的整齐框；折行会让下边框跑到屏幕外，比截断更难看出问题。

`⚡` `✅` `⚠` 这类 `U+2600–U+27BF` 的符号**按 1 列算**（有 emoji 呈现也有文本呈现，各家终端宽度不一致，宁可算 1 也不乱猜）；本仓库只把它们用在自然句子里，不进方框。这条与「📋 算 2 列」一样各有测试钉着，免得被当成漏写而改掉。

#### Markdown 表格：列宽同样按显示宽度算

模型回答里表格很常见（对比、参数清单、排期），而 Markdown 表格的原始文本是按**码元**补空格的 —— 中文一个字占 2 列却只占 1 个码元，再加上渲染时插进去的 ANSI 序列（占 0 列但占码元），整张表的竖线每行都落在不同列。实测同一张四行表，竖线分别在 `0,7,14,21` / `0,13,22,31` / `0,9,19,26` 列；面板的右边框又是按显示宽度算的，两者一叠加，表就彻底散了。

`renderMarkdown` 现在把表格**整块**交给 `renderMarkdownTable(lines, maxWidth)` 处理（列宽要看完所有行才知道，一行一行过算不出来），规则：

| 规则 | 说明 |
|---|---|
| 判据成对 | 必须是「表格行 + 分隔行」，且分隔行只含竖线 / 空格 / 冒号 / 减号。只看竖线的话，两行以竖线收尾的 shell 管道会被拼成一张两列表格 |
| 列宽 | 按**渲染后**的 `displayWidth` 算；反斜杠转义的竖线不当分隔符切格 |
| 对齐 | 支持 `:--` / `:-:` / `--:` 三种，缺省左对齐 |
| 宽度上限 | 结果每行不超过 `maxWidth`（`0` = 不设上限）。从**最宽的列**往下削，每列不低于 3 列 |
| 装不下就折行 | 一格的内容超过列宽时**折成多行**（`wrapToWidth`），续行补空单元格 —— 一逻辑行对应多条物理行，竖线仍逐行对齐。**不截断**：单元格是数据，`…` 掉一半就是「安静地丢数据」，而表格不会报任何错 |
| 不猜 | 分隔行与表头格数不一致、不是合法表格时返回 `null`。连「列数 × 3 列 + 分隔符」都放不进 `maxWidth` 时也返回 `null` —— 那个宽度下画不出有这么多列的东西，由 `renderMarkdown` 折行兜底 |
| 输出仍是 Markdown | 仍然是竖线 + 减号，只是补齐了空格 —— 从终端复制出去粘回 Markdown 文件依然是一张表（换成边框绘制字符好看，但粘出去只剩花纹）。**格内的字面竖线会转义成 `\|`**，否则粘回去 2 列变 3 列、末列内容静默丢掉 |

单元格里的行内代码与加粗走 `renderInline`，与正文**同一套规则**：各写一份的话，同一段 Markdown 在正文里是青色、在表格里就是原文，而两边都不会报错。`tests/ui.test.ts` 里有一条结构锁盯着「`renderMarkdown` 里不许再出现行内渲染正则」。

#### 宽度上限：`panel(renderMarkdown(x))` 这条路上最容易漏的一环

列对齐只解决「竖线落在同一列」，**不解决「这张表有多宽」**。真实形态是 `panel(renderMarkdown(回答), 标题)`：`panel` 的宽度上限是 `min(终端列数, 100)`，表格比它宽时 `panel` 只能按行处理，而它会的只有截断 —— 超宽表格最右边那几列连同右边框一起被 `…` 吃掉，而 `renderMarkdown` 那边全程不知情、谁都不报错（实测一张三列中文表在 80 列终端里是 111 列宽）。

「收窄」这一步后来还暴露过两个**都算废纸**的形态（终端 49 列 × 8 列表格实测）：

1. **削到下限**：水位线一直削到每列 3 列宽，整张表变成 `| 参… | 类… | 默… |` —— 一个字都读不到；
2. **放弃**：再窄一点就返回 `null`、退回「原样输出」，那些行比面板还宽，交到 `panel` 手里被按行截断 —— 右边几列**整段消失**。

两种都不报错。根子是当时的收窄只会**截断**、不会**折行**。所以：

- **终端列数与 100 列上限只有一个读取处**（`termWidth()`），`panel` 画框、`renderMarkdown` 排表共用。各写一份的话，表格按 120 列排、方框按 100 列画，右边一截直接跑到框外面。有一条结构锁盯着「全文件只有一处读 `process.stdout.columns`」。
- `renderMarkdown` 默认按 `panelInnerWidth()`（面板内容宽 = 终端列数 − 4 列边框）排表，两个调用点都不用改；纯文本消费传 `Infinity` 即不设上限。
- **削法是水位线，不是等比缩**。`17/8/62` 三列在 40 列预算下等比缩成 `5/3/22`，`onUpdate`（8 列）这种本来装得下的短内容也被截成 `onUpd…`，而撑爆的那一列照样放不下 —— 两头都亏；从最宽的往下削得到 `11/8/11`，短内容全保住。
- **超过列宽的格子折行，不截断**。截断的判据是「能不能塞下」，折行的判据是「能不能摞起来」—— 表格的宽度该由后者决定。`wrapToWidth` 优先在空格处断；跨行断在样式中间时行尾补 `\x1b[0m`、下一行行首重开，否则断点之后整个面板都会被染成那个颜色。代价是表会变高（80 列 × 8 列表格由 4 行变 7 行），换来的是**一个字都不丢**；而且反复渲染不会越长越高（有测试钉着）。
- 每列下限 3 列：分隔行的 `---` 是 GFM 下限；再窄下去一列只放得下一个汉字，折行等于把表写成竖排。
- 连下限都放不下就**返回 `null`**：硬压到装下只会得到一张竖线错位、内容全成省略号的「表」，那不叫渲染。调用方（`renderMarkdown`）这时**自己也折行**，不再把超宽原文整条扔给 `panel` 去截。

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
npm run vsix          # 完整构建并打包 VSIX（跨平台，一条命令）
```

产物是 `vscode/vca-coding-agent-<版本>.vsix`（`--skip-web` / `--skip-ext` 可复用已有产物，
`--no-package` 只构建不打包）。安装后在命令面板（Ctrl+Shift+P）运行
`VCA: 打开 Coding Agent 聊天面板`，输入任务即可。

`build-vsix.bat` 是同一个脚本的 Windows 包装 —— **只做转发，里面没有第二份构建逻辑**。

> 在 `vscode/` 目录直接 `npx vsce package` 只在**扩展入口已经构建出来**时才可行：
> `vscode/dist/extension.js` 是构建产物、不随源码入库，干净 clone 上直接跑只会拿到
> `ERROR Extension entrypoint(s) missing.`（这条以前被 README 当成等价替代写法推荐过）。
> 所以要么先跑一次 `npm run vsix`，要么就用 `npm run vsix` 本身 —— 它打包前会先预检入口。

> 扩展详细用法见 [`vscode/README.md`](vscode/README.md)。

### D. 桌面端（Electron）

```bash
npm run electron:build    # 构建主进程 / preload → electron/dist
npm run electron:run      # 直接起桌面端（需要先 build:web）
npm run electron:dist:win # 完整打包（tsc + web + electron + electron-builder）→ release/
```

桌面端壳自己会**内嵌启动后端**（`node dist/server.js`），所以不需要另开 `npm run server`。

两条与「装了才出问题」直接相关的约定，改这块之前先看一眼：

- **端口只有一个来源**。主进程持有 `PORT`（默认 3001），并且**必须**通过 `vca:init` 把它告诉渲染层；渲染层再拿它拼 ws 地址。打包后页面是从磁盘加载的（`file://`），`location.host` 是空串 —— 不拿主进程那个端口就只能拼出 `ws:///ws` 这种连不到任何地方的地址（开发模式下 Vite 会把 `/ws` 代理到 3001，所以**只有打包后才炸**）。地址的拼装只在 `web/src/ws-url.ts` 一处，`tests/electron-boot.test.ts` 盯着。
- **产物后缀必须与 `type: module` 对付**。esbuild 出的是 CJS，而根 `package.json` 是 `"type": "module"`，所以主进程/preload 的产物是 `.cjs`，`package.json` 的 `main` 指向 `electron/dist/main.cjs`。名字写成 `.js` 的话 Electron 会按 ESM 加载它，第一行 `require("electron")` 就 `ReferenceError: require is not defined in ES module scope`。

---

## 命令安全护栏

`bash` 工具能跑任意 shell 命令，所以它有一道拦截。判定在 `src/tools/command_guard.ts`
（纯函数，`tests/command-guard.test.ts` 盯着），**包里带哪些**：

| 家族 | 拦什么 |
|------|--------|
| `recursive-force-delete` | 递归强制删除根 / 盘符 / 家目录：`rm -rf /`、`rm -rf ~`、`rm -rf "$HOME"`、`rm -rf C:\`、`del /q /s C:\`、`rd /s /q C:\` |
| `format-disk` / `mkfs` | `format c:`、`format.com c:`、`mkfs.ext4 /dev/sda` |
| `raw-device-write` | `dd` 往 `/dev/*` 或整盘写数据 |
| `chmod-chown-root` | 给根目录改权限 / 属主（`chmod -R 777 /`、`chown -R root /`） |
| `powershell-destructive` | `Remove-Item -Recurse -Force C:\`、`Format-Volume`、`Clear-Disk` |
| `powershell-encoded-command` | `powershell -EncodedCommand <base64>` —— 命令被编码，护栏读不出内容，所以直接拦 |
| `fork-bomb` | `:(){ :|:& };:` |

判定前会先**归一化** —— 折叠空白、剥掉 `sh -c` / `bash -c` / `cmd /c` / `powershell -Command`
包装层、剥掉最外层引号 —— 所以下面这些换皮写法同样会被拦：

```bash
rm  -rf  /                       # 多一个空格
rm -fr /                         # 参数顺序换一下
rm -rf --no-preserve-root /      # 多带一个参数
sh -c "rm -rf ~"                 # 外面套一层
cmd /c del /q /s C:\             # Windows 侧同理
cd /tmp && rm -rf /              # 藏在命令链里
sudo rm -rf /                    # 提权不改变危险程度
```

反过来也钉死了：**正常清理与只读命令一条都不许拦** —— `rm -rf node_modules`、
`rd /s /q .\temp`、`chmod 777 ./tmp-output`、`grep -rn 'rm -rf /' docs/`（在文档里搜这句话）、
`dd if=./disk.img of=./copy.img` 都照常放行。一个乱杀命令的护栏会被用户和模型一起绕开，
比没有护栏更坏，所以 `tests/command-guard.test.ts` 里有一份 73 条的良性回归集
（清单在 `tests/benign-commands.ts`；这里的条数与那份清单**现算对账**，写错了 `npm test` 会红）。

**命令词前面挂什么都不影响判定。** 早期版本默认「命令词就是第一个词」，
只特判了 `sudo` 一个前缀 —— 于是「`sudo` 后面跟个选项」就把这一格又丢了。现在改按一张
显式的**启动器表**剥前缀，表里每条都带它自己的选项与参数（`sudo -u root rm -rf /` 里的
`-u root` 要一起跳掉，`timeout 30 rm -rf /` 里的 `30` 也一样）；`su -c "…"` 这种
「选项的值本身就是命令」的会继续往里剥：

```bash
nohup rm -rf /                    # 挂个 nohup
env FOO=1 rm -rf /                # env + 前置赋值
timeout 30 rm -rf /               # 包一层超时
sudo -u root rm -rf /             # sudo 后面带选项（这一格曾经整个丢过）
nohup bash -c 'rm -rf /'          # 先挂启动器、再套一层 shell —— 两层都要剥
powershell -c "Remove-Item -Recurse -Force C:\"    # PowerShell 的 `-c` 就是 `-Command`
```

启动器表是 `src/tools/command_guard.ts` 里的 `LAUNCHERS`；**故意不认**的那几个
（`at` / `batch` / `qsub` / `systemd-run`）连同理由写在 `tests/command-guard.test.ts` 里，
并且是**两向对账**：表里少一条、多一条、或者「登记成例外却其实已经认了」，测试都会红。
每个启动器还有一条按真实写法手写的探针 —— 表里的任何一行都不是死数据。

**它不是沙箱**：这是安全带。`node -e "require('fs').rmSync('/',{recursive:true})"`
这类「换一种语言做同一件事」的写法不在覆盖范围内（连内容都读不出来的
`powershell -EncodedCommand` 属于另一种情况：读不出来就不猜，直接拦）；
模型也仍然会在你的工作目录里跑构建、装依赖、改文件。要真隔离请用容器或受限账号。

被拦时返回的第一行是 `[BLOCKED] 危险命令被拦截（<家族>）：<理由>` —— 带上家族和理由，
模型才知道为什么不行、该怎么换，而不是反复重试同一条。

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

### MCP 配置

MCP 管理器（`src/mcp/`）会读下面两个文件里的 `servers` 段，项目级覆盖用户级；每轮对话前连接并收集工具，某个 server 连不上只记状态、不阻塞对话：

- 用户级：`~/.vca/mcp.json`
- 项目级：`<工作空间>/.vca/mcp.json`

读是这两个文件的**合并**，写也是：设置页保存时每条按**自己的来源**回写到原文件
（新加的写项目级）。所以「删掉一个来自 `~/.vca/mcp.json` 的 server」是真的删掉了，
改一条也不会在另一个文件里留下影子副本 —— 早先保存是把整张表覆盖写进项目级那一个文件，
于是界面上删不掉、改完换个工作空间又看到旧的。设置页里每条 server 下面会标出它存在哪个文件。

`/mcp` 会按实际状态报告：连上后列出每个 server 的状态与工具数；只是配了还没连（或连不上）也不会含糊地说「未配置」，而是把配置过的 server 与失败原因直接列出来。

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
npm run typecheck:test  # 连 tests/ 一起类型检查 (tsconfig.test.json)
npm run build         # 编译 TS → dist/
npm run start         # 运行编译后的 CLI (node dist/main.js)
npm test              # 跑全部测试 (node --test + tsx)
npm run test:cli      # 只跑入口冒烟测试
npm run test:input    # 只跑输入历史与 Tab 补全
npm run check         # typecheck:test + test
```

测试分两层：

- `tests/cli-args.test.ts` / `tests/help.test.ts` / `tests/completer.test.ts` / `tests/input-history.test.ts` / `tests/ui.test.ts` / `tests/version.test.ts` / `tests/electron-boot.test.ts` / `tests/source-utils.test.ts` / `tests/ansi-source.test.ts` / `tests/subagents.test.ts` / `tests/agents-command.test.ts` / `tests/workspace-ctx.test.ts` / `tests/session-store.test.ts` —— 纯函数层。参数解析的每条错误分支、命令清单与 `handleCommand` 的双向一致性、Tab 补全的候选与 token、历史文件的读写与去重规则（含与 prompt_toolkit 的**格式往返** —— 把官方 `FileHistory.load_history_strings()` 的读取算法照抄进测试当契约，而不是拿自家实现的假设去测自家实现）、控制台宽度的口径（`panel` 每一行的显示宽度只有一个值、窄终端才截断、`📋` 算 2 列而 `⚡` 算 1 列）、Markdown 表格（中文列也对齐、已经对齐的表格再渲染一遍不再变、带竖线的命令行不会被吃成表格、`\|` 转义后能原样读回来、超宽表格按面板宽度收窄后不被 `panel` 二次截断、超宽单元格折行后一个字都不丢且反复渲染不会越长越高、连「列数 × 3 列」都放不下时兜底输出也折行）、版本号只有一个读取处（含界面与文档 —— 侧栏写死过版本号，一直没人核对）、桌面端地址拼装（没有 host 时用主进程报的端口，拿不到就返回 `null` 而不是拼出 `ws:///ws`）、子代理的工具白名单与派发计划（含两条结构锁：被封锁的工具名**即使出现在可用列表里也必须被拒**，白名单必须**同时**管住绑给模型的和 `ToolNode` 能执行的两份 —— 只过滤前者的话白名单就是假锁）、工作目录上下文的还原（同步 / 异步 resolve / 异步 reject / 同步 throw 四条出口逐条钉住，另有一条反向对照证明「不包裹时确实会泄漏」）。补全与历史都**不 import `config.ts`**（那会在 import 时就写下真实的 `~/.vca/config.json`），文件路径全部由调用方传入，所以这一层跑在临时目录上，不碰用户的任何数据 —— 同一条理由也让「哪些工具能进 `ToolNode`」这条判定从 `tools/index.ts` 拆到了零依赖的 `tools/executable.ts`，好让它可以被单独测。
- `tests/cli-spawn.test.ts` —— 入口冒烟层。**真的把 CLI 当子进程跑起来**，断言 stdout / stderr / 退出码。这一层存在的理由：上一轮那个「入口守卫在 Windows 上永不成立、`npm run dev` 一行输出都没有」的故障，在所有纯函数测试里都是绿的 —— 被测函数一个都没被调用。判据很朴素：**stdout 是空的就说明 `main()` 压根没跑**。启动面板的对齐也量在这里：喂假数据量不出「终端列数 + 真实内容」组合出来的宽度。

- `tests/artifacts-untracked.test.ts` —— 构建卫生层。这类测试不测行为，测**仓库状态**：`dist-electron/`（前端 vite 的 `build.outDir`）曾有 14 个产物文件被 git 跟踪着，而 `.gitignore` 里从来没有这一条 —— 每跑一次 `npm run build:web` 工作区就脏一次，`git add -A` 顺手把产物收进下一个 commit。判定逻辑分两条，缺一不可：**① 每个产物目录都被 `.gitignore` 覆盖**（挡住以后进来的）、**② 产物目录下没有被跟踪的文件**（抓已经进去的，因为「补一条 .gitignore」管不住已被跟踪的文件）。真值是 `git ls-files` 的输出而不是 `.gitignore` 的文本 —— 文本写得再对，产物照样可能在库里；`git ls-files` 跑不起来时这条检查**失败而不跳过**（跳过的检查比没有更坏）。豁免名单（`NEVER_TRACKED`）只放 `.git` 一个，并有断言钉着它不许变长：豁免一个目录就等于少管一件事，而不会有任何东西响。同一份文件里还钉着一条同源问题 —— `electron/src/main.ts` 的开发候选曾把「前端产物目录」当成「后端产物目录」（后端是 `tsc` 出到 `dist/` 的），那条候选每次启动都白跑一次 `existsSync`，还会被印进启动失败对话框让用户去找一个不可能存在的文件。

- 所有「读源码做断言」的结构锁共用一个地基：`tests/source-utils.ts` 的 `stripComments`（此前 `tests/` 下有三份拷贝，一起漂移）。它的契约只有一句 —— **只丢注释，别的一律原样保留**。两条会破坏契约的词法各栽过一次，每次的后果都不是「锁松了一点」而是**锁判错**：字符串里的 `//`（URL 的 `://` 一出现，「`ws://` 只有一处」这类锁就对写坏的代码判绿）；**正则字面量里的引号/反引号**（本仓库那两条匹配行内代码与加粗的正则就把反引号写进了字符类，`src/ui.ts` 与 `vscode/src/panel.ts` 实测中招 —— 扫描器在正则的引号处失步后，**从那一行起注释不再被剥**，注释里的反面示例又被当成实现，连栽过的假红原地复活）。`tests/source-utils.test.ts` 逐形态钉住这些边界，另有一条总闸：**全仓源码剥完后不得残留任何注释行** —— 任何新词法让扫描器失步都会在那里现形，不必事先枚举触发形态。
- 这份地基上还共享**第三样**东西：`/` 到底是正则还是除号，靠 `source-utils.ts` 里那张**手工维护**的关键字表判定。它原来的毛病不是写错，而是**没有任何东西扛着它**（14 条里只有 `return` 有测试），而它判错的那一侧（除号被读成正则）**会吞掉后面那行的注释** —— 症状与上面那两条一模一样。现在这张表两头都有证据：
  - **关键字表**：每条关键字一个活样例，经 TS 解析器认证语法合法，且「把它从表里删掉」该样例必须翻红（把「按原本的方式改坏它会不会红」写进了常规自测）；关键字宇宙从 `typescript` 的 `SyntaxKind` **现算**（84 个），表外的每一个都要在分组例外表里写明理由 —— TypeScript 加一个关键字（`satisfies`/`using`/`accessor` 都这么来的）这条对账就会红。
  - **标点表**：宇宙同样现算（可打印 ASCII 的非字母数字字符），表外的 12 个逐个写明理由。这里有条坑：测试**不能只循环登记表** —— 循环遍历表时「表里少一条」只是少跑一圈、静默通过，所以必须做减法（`宇宙 − 表 = 例外表`）。
  - **判错方向的另一侧也钉着**：新增了一条文法上精确的判据 —— 关键字前面紧邻 `.` 时它是**属性名**（`obj.of`），后面跟的 `/` 只能是除号。少了它，`obj.of / 2; // 注释` 的注释会被整段漏剥（实测三种形态）。剩下唯一会判错的形态是「上下文关键字被当作变量名」（`const of = 1; of / 2;`），需要作用域信息才能判，明写在测试的棘轮表里，多一种就红。

至于 `↑` 与 `Tab` 这类**真终端按键行为**，不在自动化范围内：用管道喂 stdin 能验到「历史被正确读写、命令正常执行」，按键本身需要 TTY，只能本地手工过一遍。

调试 VS Code 扩展：构建前端与扩展后，在 VS Code 中按 **F5** 启动扩展开发宿主。

---

## 版本

- 当前核心版本见根目录 `package.json` 的 `version`（`vca --version` 就是现读它，`src/version.ts` 是唯一读取处）—— **这里不抄具体数字**，理由见下一条。
- VS Code 扩展**独立发版**，打包产物在 `vscode/vca-coding-agent-<版本>.vsix`，版本号见 `vscode/package.json` —— 这里也不抄（抄一份必然漂移：此前这里写着扩展的旧版本号，而仓库里根本没有那个文件）。
- 桌面版侧栏显示的版本号取自主进程的 `app.getVersion()`（`vca:init` 带给渲染层）—— 同样不抄第二份。
- `python_legacy/` 为早期 Python 实现，已弃用，仅保留作参考。

---

## License

见 [`vscode/LICENSE`](vscode/LICENSE)。
