#!/usr/bin/env node
/**
 * 控制台入口 - 编码 Agent 的交互式 CLI 主入口 (TS 版)
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SystemMessage } from "@langchain/core/messages";

import { readVersion } from "./version.js";
import { Config, CONFIG_FILE, EDITABLE_KEYS, INPUT_HISTORY_FILE } from "./config.js";
import { CodingAgent, createCodingAgent, makeSystemPrompt } from "./agent/graph.js";
import { createInitialState, type AgentState } from "./agent/state.js";
import { runAgent } from "./agent/runner.js";
import { selectWorkspace, switchWorkspace } from "./workspace.js";
import * as storage from "./storage.js";
import { MAX_INDEXED_SESSIONS, parseHistoryArg, type SessionRow } from "./session-store.js";
import { installSigintHandler, setInterrupted } from "./interrupt.js";
import {
  print,
  panel,
  renderMarkdown,
  promptUser,
  dim,
  cyan,
  yellow,
  green,
  red,
  blue,
  bold,
  magenta,
  clipToWidth,
} from "./ui.js";
import { parseArgs, USAGE } from "./cli-args.js";
import { renderHelp, commandNames } from "./help.js";
import {
  readHistory,
  pushHistory,
  writeHistory,
  parseInputArg,
  selectHistory,
  clearHistory,
} from "./input-history.js";
import { completeInput } from "./completer.js";
import { getCurrentPlan, formatPlan } from "./tools/index.js";
import { getAllSkills, getSkillDirs } from "./skills/manager.js";
import { mcpManager } from "./mcp/manager.js";
import { getSubagentManager, setSubagentHost } from "./agent/subagent_manager.js";
import { formatAgentLine, formatPresetLines } from "./agent/subagents.js";

// ============================================================
// 命令行参数
// ============================================================
//
// 解析逻辑已挪到 ./cli-args.js —— 那里是纯函数，可以脱开进程测试。
// 这里原来那份「认不出的参数就往下走」的实现会静默忽略 `--hlep` / `-m`（缺值），
// 于是用户以为指定了模型、其实用的默认模型；现在这类写法一律报错退出。

// ============================================================
// UI 辅助
// ============================================================

/**
 * `/input` 列表里一条最多占多少列。
 * 不截断的话，一条长任务描述就能把整屏顶掉 —— 列表是给人扫的，不是给人读的。
 */
const HISTORY_LINE_MAX = 110;

function showBanner(): void {
  print();
  print(bold(cyan("  ⚡ Virtual Code Agent (VCA)")) + dim("  — LangGraph.js"));
  print();
}

function showConfigInfo(workspaceDir: string): void {
  print(`配置文件:   ${CONFIG_FILE}`);
  print(`Model:       ${cyan(Config.OPENAI_MODEL)}`);
  print(`Base URL:    ${Config.OPENAI_BASE_URL}`);
  print(`Workspace:   ${path.resolve(workspaceDir)}`);
  print(`Max Iter:    ${Config.MAX_TOOL_ITERATIONS}`);
  print(`Max Tokens:  ${Config.MAX_CONTEXT_TOKENS.toLocaleString()}`);
  const models = Config.getModels();
  if (models.length > 1) {
    print(`可用模型:   ${models.map((m) => m.name).join(", ")}`);
  }
}

function showHelp(verbose = false): void {
  // 命令清单是 ./help.js 里的单一来源，这里只负责打印 ——
  // 以前那串手写 print() 与 handleCommand 的 switch 是两份清单，必然漂移。
  for (const line of renderHelp(verbose)) print(line);
}

function showWorkspaceInfo(workspaceDir: string): void {
  print(`工作空间: ${cyan(workspaceDir)}`);
}

// ============================================================
// 会话恢复
// ============================================================

function restoreSession(
  state: AgentState,
  workspaceDir: string,
  wsExplicit: boolean
): { sessionId: string | null; workspaceDir: string } {
  let sessionId: string | null = null;
  const lastSession = storage.getLastSession();
  if (!lastSession || lastSession.messages.length === 0) {
    return { sessionId, workspaceDir };
  }

  const lastWs = lastSession.workspace_dir;
  if (!wsExplicit && lastWs && fs.existsSync(lastWs)) {
    workspaceDir = lastWs;
  }
  state.workspace_dir = workspaceDir;
  state.messages = lastSession.messages;

  const sessions = storage.listSessions(1);
  if (sessions.length > 0) sessionId = sessions[0].id;

  print(
    `${green("↺ 已自动恢复上次对话")} ${dim(`「${lastSession.title}」(${lastSession.messages.length} 条消息) | 工作空间: ${workspaceDir}`)}`
  );
  return { sessionId, workspaceDir };
}

function refreshSystemPrompt(state: AgentState, workspaceDir: string): void {
  const idx = state.messages.findIndex(
    (m) => m instanceof SystemMessage && String(m.content).includes("工作空间")
  );
  if (idx >= 0) state.messages.splice(idx, 1);
  state.messages.unshift(new SystemMessage({ content: makeSystemPrompt(workspaceDir) }));
}

// ============================================================
// 命令分发
// ============================================================

interface CommandState {
  sessionId: string | null;
  workspaceDir: string;
  verbose: boolean;
  windowNo: number;
  modelName: string;
  /**
   * ↑/↓ 正在用的那一份输入历史（最新在前）。
   * 命令要读就读**这一个数组**，不要自己 readHistory(INPUT_HISTORY_FILE) ——
   * 那会多出第二份真相：内存里刚敲的那条还没落盘，重新读文件就看不到它。
   */
  inputHistory: string[];
}

async function handleCommand(
  cmd: string,
  userInput: string,
  state: AgentState,
  cs: CommandState
): Promise<CommandState> {
  switch (cmd) {
    case "/exit": {
      if (cs.sessionId || state.messages.length > 0) {
        const sid = storage.autoSave(state, cs.sessionId ?? undefined);
        print(dim(`对话已自动保存 (${sid})`));
      }
      print(yellow("再见!"));
      process.exit(0);
      break;
    }
    case "/help":
      showHelp(cs.verbose);
      break;
    case "/new": {
      if (cs.sessionId || state.messages.length > 0) {
        const sid = storage.autoSave(state, cs.sessionId ?? undefined);
        print(dim(`当前对话已保存 (${sid})`));
      }
      state.messages = [];
      state.pending_question = null;
      cs.sessionId = null;
      cs.windowNo = storage.listSessions().length + 1;
      // 子代理运行记录是**按会话**的：新开一个窗口后还列着上个窗口派过的子代理，
      // 会让「刚才那个子代理」指错对象（id 仍然有效，但汇报属于上一轮的上下文）。
      getSubagentManager().clear();
      print(`${green("✓ 已开启新对话窗口")} ${dim(`#${cs.windowNo} (输入 /load 可切回历史窗口)`)}`);
      break;
    }
    case "/clear":
      state.messages = [];
      state.pending_question = null;
      cs.sessionId = null;
      getSubagentManager().clear();
      print(green("对话历史已清除"));
      break;
    case "/workspace":
      showWorkspaceInfo(cs.workspaceDir);
      break;
    case "/verbose":
      cs.verbose = !cs.verbose;
      print(cs.verbose ? green("详细模式: 深度思考已展开") : dim("精简模式: 深度思考已折叠"));
      break;
    case "/cd": {
      const newWs = await switchWorkspace(userInput, cs.workspaceDir);
      if (newWs) {
        cs.workspaceDir = newWs;
        state.workspace_dir = newWs;
        refreshSystemPrompt(state, newWs);
      }
      break;
    }
    case "/config": {
      const parts = userInput.split(/\s+/);
      if (parts.length >= 4 && parts[1] === "set") {
        setConfigValue(parts[2], parts.slice(3).join(" "));
      } else {
        showConfigInfo(cs.workspaceDir);
      }
      break;
    }
    case "/model": {
      const rest = userInput.replace(/^\/model\s*/, "").trim();
      const models = Config.getModels();
      if (!rest) {
        print(`当前模型: ${cyan(cs.modelName)}`);
        print(dim("可用模型:"));
        models.forEach((m, i) => print(`  ${cyan(String(i + 1))}. ${m.name}  ${dim(m.model)}`));
        print(dim("用法: /model <模型名> 或 /model <序号>"));
      } else {
        const idx = parseInt(rest, 10);
        const target = !isNaN(idx) && idx >= 1 && idx <= models.length
          ? models[idx - 1].name
          : rest;
        const cfg = Config.getModelConfig(target);
        if (cfg && cfg.name === target) {
          cs.modelName = cfg.name;
          print(`${green("✓ 已切换模型:")} ${cyan(cfg.name)} ${dim(cfg.model)}`);
        } else {
          print(red(`未找到模型: ${rest}`));
          print(dim(`可用: ${models.map((m) => m.name).join(", ")}`));
        }
      }
      break;
    }
    case "/todo": {
      const plan = getCurrentPlan();
      if (plan.length === 0) {
        print(dim("当前无计划 (Agent 在多步任务时会自动创建)"));
      } else {
        const text = formatPlan(plan);
        const lines = text.split("\n").filter((l) => !l.startsWith("**") || l === "**任务计划:**");
        panel(lines.join("\n"), bold(blue("📋 任务计划")), "blue");
      }
      break;
    }
    // 下面三条此前一律回答「暂未接入 (规划中)」，但 Skills 与 MCP 其实早已
    // 实现并接进 Agent（SKILL_TOOLS 进了 ALL_TOOLS，mcpManager 在 createCodingAgent
    // 里连接）—— 用户看到这句就不会去配 mcp.json、也不会去放 SKILL.md，
    // 两个功能等于白做。现在一律从真实注册表/配置里读，不再手写结论。
    case "/skills": {
      const skills = getAllSkills();
      if (skills.length === 0) {
        print(dim("没发现技能。把一个 <名字>/SKILL.md 放进下面任一目录即可（重启后生效）:"));
        for (const d of getSkillDirs()) print(dim(`  - ${d}`));
      } else {
        print(bold(`已发现 ${skills.length} 个技能:`));
        for (const [i, s] of skills.entries()) {
          print(`  ${cyan(String(i + 1))}. ${bold(s.name)} ${dim(`(${s.source})`)}`);
          if (s.description) print(dim(`     ${s.description}`));
        }
        print(dim("Agent 需要时会自己用 list_skills / load_skill 取用"));
      }
      break;
    }
    case "/mcp": {
      const files = mcpManager.configFiles();
      const configured = mcpManager.loadConfig();
      // 注意不能用 isConnected 判：Agent 一启动就会尝试连接，即使一个 server 都没配，
      // _connected 也会变成 true —— 那时 statusText() 只会说「未配置」，
      // 而配置里明明写了 server，用户会以为改了没生效。所以按真实状态分三档。
      const known = mcpManager.serverStatus();
      if (known.size > 0) {
        panel(mcpManager.statusText(), bold(magenta("🔌 MCP")), "magenta");
      } else if (configured.length > 0) {
        print(bold(`已配置 ${configured.length} 个 MCP server（尚未连接，首次对话时建立）:`));
        for (const s of configured) {
          print(`  - ${cyan(s.name)} ${dim(s.config.transport ?? "stdio")}`);
        }
        print(dim(`配置文件: ${files.join("  ·  ")}`));
      } else {
        print(dim("MCP servers 未配置。在下面任一文件里写好 servers 段再重启:"));
        for (const f of files) print(dim(`  - ${f}`));
      }
      break;
    }
    case "/agents": {
      // 这条命令此前只打印「TS 版还没有 SubAgent」—— 与 /skills、/mcp 是同一个病：
      // 能力已经接进来了，界面还在说没有，用户永远不会去用（也不会去调它的白名单）。
      // 现在一律从真实注册表与运行记录里读，不手写结论。
      const mgr = getSubagentManager();
      print(bold("内置子代理预设") + dim(" (spawn_subagent 的 tools 参数可直接写预设名):"));
      for (const line of formatPresetLines()) print(line);

      const runs = mgr.listRuns();
      print();
      if (runs.length === 0) {
        print(dim("本次会话还没有派过子代理。主 Agent 遇到能独立做完的调研/改动时会自己派。"));
      } else {
        print(bold(`本次会话派过 ${runs.length} 个子代理（按派发顺序）:`));
        for (const r of runs) print(`  ${formatAgentLine(r)}`);
        print(dim("用 get_subagent_result <id> 看某个子代理的完整汇报"));
      }

      print(
        dim(
          mgr.hasHost()
            ? "子代理同步执行（派出去要等它跑完），有独立的工作目录与工具白名单，看不见 ask_user，也不能再派子代理。"
            : "⚠ 主代理还没登记工具池，现在派子代理会失败（创建 Agent 后应调用 setSubagentHost）。"
        )
      );
      break;
    }
    case "/history": {
      // 会话记录此前是个只增不减的暗盒：`/history` 只能列（还写死列 10 条），
      // `/load <序号>` 又是另一处手抄的 10，没有任何办法删掉一个会话 ——
      // 而 storage.ts 里 `deleteSession` 一直躺着、零调用（「定义了但全仓没有引用」）。
      // 粘过密钥 / 走错项目的会话会永远留在 ~/.vca/sessions/ 里，只能自己去文件管理
      // 器找。参数语义只在 session-store.ts 的 parseHistoryArg 定义一次
      // （与 /input 同构），这里不自己判「第一个词是不是 del」。
      const action = parseHistoryArg(userInput.replace(/^\/history\s*/i, ""));
      if (action.kind === "delete") {
        deleteHistorySession(action.index, state, cs);
        break;
      }

      const sel = storage.searchSessions({ limit: action.limit, filter: action.filter });
      if (sel.total === 0) {
        print(dim("暂无历史会话。"));
        print(dim("每轮交互后会自动存一次（/save 可立刻存），存在:"));
        print(dim(`  ${storage.getSessionsDir()}`));
        break;
      }
      if (sel.matched === 0) {
        print(dim(`没有匹配「${sel.filter}」的历史会话（共 ${sel.total} 个）`));
        break;
      }

      print(
        sel.filter
          ? bold(`历史会话 · 匹配「${sel.filter}」 ${sel.matched} / ${sel.total} 个:`)
          : bold(`历史会话 · 最近 ${sel.shown.length} / ${sel.total} 个（最新在前）:`)
      );
      sel.shown.forEach((s, i) => {
        print(`  ${cyan(String(i + 1).padStart(2))}. ${formatSessionRow(s)}`);
      });
      if (sel.matched > sel.shown.length) {
        print(dim(`  …还有 ${sel.matched - sel.shown.length} 个没显示（/history <条数> 看更多）`));
      }

      // 索引外的会话文件（索引只留最新的 MAX_INDEXED_SESSIONS 条记录，文件却一直都在）
      // 必须报出来，否则「文件还在、用户再也看不到它」这件事谁都不会知道。
      const unregistered = sel.shown.filter((s) => !s.registered).length;
      if (unregistered > 0) {
        print(
          dim(
            `  标「未登记」的 ${unregistered} 个只有会话文件、不在索引里` +
              `（索引最多留 ${MAX_INDEXED_SESSIONS} 条）—— 照样能 /load、能删`
          )
        );
      }
      print(dim("用 /load <序号> 恢复某个会话，/history <关键字> 搜索，/history del <序号> 删除"));
      break;
    }
    case "/input": {
      // 输入历史（↑ 翻的那些，存在 ~/.vca/input_history）。
      // 此前只能靠 ↑ 一条条翻：隔了几十条想找「那句带 redis 的」基本找不到，
      // 而且没有任何办法清掉它。参数语义只在 input-history.ts 定义一次
      // （parseInputArg），这里不自己判「是不是 clear」—— 两份判定必然分家。
      const action = parseInputArg(userInput.replace(/^\/input\s*/i, ""));
      if (action.kind === "clear") {
        const n = cs.inputHistory.length;
        // clearHistory 原地清空、writeHistory 写的就是同一个数组 ——
        // 只清一边都不算清（只清文件 ↑ 还翻得出来，只清内存重启全回来）
        clearHistory(cs.inputHistory);
        writeHistory(INPUT_HISTORY_FILE, cs.inputHistory);
        print(`${green("✓ 输入历史已清空")} ${dim(`(${n} 条，含刚敲的这一条)`)}`);
        break;
      }

      const sel = selectHistory(cs.inputHistory, {
        limit: action.limit,
        filter: action.filter,
        // 主循环先记历史再执行命令，所以 `/input` 自己已经在历史里了 ——
        // 不剔掉的话列表第一行永远是刚敲的这条
        skip: userInput,
      });
      if (sel.total === 0) {
        print(dim("还没有输入历史。"));
        print(dim("敲过的内容会自动记下来（最多 500 条，跨会话保留），之后用 ↑ 或 /input 就能翻回来。"));
        break;
      }
      if (sel.matched === 0) {
        print(dim(`没有匹配「${sel.filter}」的输入历史（共 ${sel.total} 条）`));
        break;
      }

      print(
        sel.filter
          ? bold(`输入历史 · 匹配「${sel.filter}」 ${sel.matched} / ${sel.total} 条:`)
          : bold(`输入历史 · 最近 ${sel.shown.length} / ${sel.total} 条（最新在前）:`)
      );
      sel.shown.forEach((line, i) => {
        print(`  ${cyan(String(i + 1).padStart(2))}. ${clipToWidth(line, HISTORY_LINE_MAX)}`);
      });
      if (sel.matched > sel.shown.length) {
        print(dim(`  …还有 ${sel.matched - sel.shown.length} 条没显示（/input <条数> 看更多）`));
      }
      print(dim("↑/↓ 翻回，/input <关键字> 搜索，/input clear 清空"));
      break;
    }
    case "/save": {
      const sid = storage.autoSave(state, cs.sessionId ?? undefined);
      cs.sessionId = sid;
      print(`${green("✓ 对话已保存")} (${sid})`);
      break;
    }
    case "/load": {
      const rest = userInput.replace(/^\/load\s*/, "").trim();
      if (rest) {
        const loaded = loadSessionByIndex(rest, state, cs);
        if (loaded) {
          cs.sessionId = loaded;
          cs.workspaceDir = state.workspace_dir;
        }
      } else {
        const last = storage.getLastSession();
        if (last) {
          state.messages = last.messages;
          state.workspace_dir = last.workspace_dir || cs.workspaceDir;
          cs.sessionId = storage.listSessions(1)[0]?.id ?? null;
          cs.workspaceDir = state.workspace_dir;
          print(`${green("✓ 已恢复最近会话")} ${dim(`「${last.title}」`)}`);
        } else {
          print(dim("暂无历史会话"));
        }
      }
      cs.windowNo = storage.listSessions().findIndex((s) => s.id === cs.sessionId) + 1 || storage.listSessions().length + 1;
      break;
    }
    default:
      print(red(`未知命令: ${userInput}`));
      print(dim("输入 /help 查看可用命令"));
  }
  return cs;
}

function setConfigValue(key: string, value: string): void {
  if (!EDITABLE_KEYS.has(key)) {
    print(`${red(`无效配置项: ${key}`)}\n${dim(`可用: ${[...EDITABLE_KEYS].sort().join(", ")}`)}`);
    return;
  }
  try {
    if (key === "MAX_TOOL_ITERATIONS" || key === "MAX_CONTEXT_TOKENS") {
      value = String(parseInt(value, 10));
    }
    Config.set(key, value);
    print(`${green(`✓ 已更新 ${key}: ${value}`)}`);
    print(dim("部分配置需重启后完全生效"));
  } catch {
    print(red(`${key} 需要整数值`));
  }
}

/**
 * 列表里一行怎么显示。
 *
 * 「未登记」那类只有会话文件、没有索引记录，于是**条数不知道** —— 这里报
 * 「条数未知」而不是 `0`。把「没算 / 不知道」显示成 `0`，与本仓库栽过的那些
 * 界面缺陷是同一个形状：界面不报错，只是安静地少显示一块。
 */
function formatSessionRow(s: SessionRow): string {
  const meta = [
    s.message_count === null ? "条数未知" : `${s.message_count} 条消息`,
    s.updated_at,
  ];
  if (!s.registered) {
    meta.push(`文件 ${s.id}.json`);
    return `${yellow("未登记")} ${dim(`(${meta.join(", ")})`)}`;
  }
  return `${s.title} ${dim(`(${meta.join(", ")})`)}`;
}

/**
 * `/history del <序号>` —— 序号取自 `/history` 列出的那一份窗口，而窗口大小只有一个
 * 来源（`storage.getListWindow()`），与 `/load <序号>` 用的是同一个数。
 *
 * ⚠ 删的若是**当前窗口**那个会话，内存里那段对话必须一起丢。否则主循环下一轮
 * 自动保存就把文件原样写回来 —— 用户看到「已删除」，文件其实还在，正是那种
 * 「看起来干了、其实没干」的坏形态。同理也要清掉子代理运行记录：那份记录是按
 * 会话算的，留着它，下一个窗口会列出上个窗口派过的子代理。
 */
function deleteHistorySession(no: number | null, state: AgentState, cs: CommandState): void {
  const rows = storage.listSessions(storage.getListWindow());
  if (no === null) {
    print(red("用法: /history del <序号>"));
    print(dim(`序号取自 /history 列出的会话（当前 1-${rows.length}）`));
    return;
  }
  if (no < 1 || no > rows.length) {
    print(red(`无效序号，请输入 1-${rows.length}`));
    return;
  }

  const target = rows[no - 1];
  const out = storage.deleteSession(target.id);
  if (out.reason) {
    print(red(`删除失败: ${out.reason}`));
    return;
  }

  const what = [out.file ? "会话文件" : "", out.index ? "索引记录" : ""].filter(Boolean).join(" + ");
  print(`${green("✓ 已删除会话")} ${formatSessionRow(target)}`);
  print(dim(`  已删: ${what} (${target.id})`));

  if (cs.sessionId === target.id) {
    state.messages = [];
    state.pending_question = null;
    cs.sessionId = null;
    getSubagentManager().clear();
    cs.windowNo = storage.listSessions().length + 1;
    print(yellow("  这是当前窗口的会话 —— 内存里的对话也一起清掉了（不清的话下一轮自动保存会把它写回来）"));
  }
}

function loadSessionByIndex(indexStr: string, state: AgentState, cs: CommandState): string | null {
  const idx = parseInt(indexStr, 10);
  // 序号窗口必须与 `/history` 是同一个数：各写一份（原来是两处手抄的 10）之后，
  // 「/history 说用 /load <序号> 恢复」里的序号指的不是同一条会话，而且谁都不报错。
  const sessions = storage.listSessions(storage.getListWindow());
  if (isNaN(idx) || idx < 1 || idx > sessions.length) {
    print(red(`无效序号，请输入 1-${sessions.length}`));
    return null;
  }
  const s = sessions[idx - 1];
  const loaded = storage.loadSession(s.id);
  if (!loaded) {
    print(red("会话加载失败"));
    return null;
  }
  state.messages = loaded.messages;
  state.workspace_dir = loaded.workspace_dir || cs.workspaceDir;
  print(`${green("✓ 已恢复会话")} ${dim(`「${loaded.title}」(${loaded.messages.length} 条消息)`)}`);
  return s.id;
}

// 这里原来各自复制了一份 red / blue（`\x1b[31m` 拼字符串），而 ui.ts 已经导出了
// 同名函数 —— 同一事实两处实现。ANSI 处理一旦在 ui.ts 里统一改动（比如加
// NO_COLOR 支持），这两份副本不会跟着变。现在统一从 ./ui.js 取。

// ============================================================
// 主入口
// ============================================================

function formatPrompt(workspaceDir: string, windowNo: number, verbose: boolean): string {
  const base = path.basename(workspaceDir) || workspaceDir;
  const mode = verbose ? " 📖" : "";
  return `${cyan(`vca:${base}`)}${dim(` #${windowNo}${mode}`)}> `;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    // 用法错误写到 stderr（stdout 可能正被管道消费），退出码 2 与「运行失败 1」区分开
    process.stderr.write(red(`参数错误: ${parsed.error}`) + "\n\n");
    process.stderr.write(USAGE + "\n");
    process.exit(2);
  }
  const args = parsed.args;

  // 帮助与版本必须**无条件**看得到，所以要排在配置校验之前：
  // 首次安装还没填 API Key 的时候，恰恰是最需要 `vca --help` 的时候，
  // 而原来的顺序会让帮助页被「请填入 API Key」挡在门外（退出码 1）。
  if (args.help) {
    showBanner();
    print(USAGE);
    print();
    showHelp(true);
    print();
    print(dim(`版本 ${readVersion()} · 配置文件 ${CONFIG_FILE}`));
    return;
  }
  if (args.version) {
    print(`vca ${readVersion()}`);
    return;
  }

  installSigintHandler();

  // 仅列出历史工作空间
  if (args.listWorkspaces) {
    const history = Config.getWorkspaceHistory();
    if (history.length > 0) {
      print(bold("最近使用的工作空间:"));
      history.forEach((p, i) => print(`  ${i + 1}. ${p}`));
    } else {
      print(dim("暂无历史记录"));
    }
    return;
  }

  // 1. 验证配置
  if (!Config.validate()) {
    print(red(`请在配置文件中填入你的 API Key: ${CONFIG_FILE}`));
    process.exit(1);
  }

  // 2. 选择工作空间
  const ws = await selectWorkspace(args.workspace);

  // 3. 创建 Agent (按指定模型或默认模型)
  print(dim("正在初始化 Agent..."));
  let agent: CodingAgent;
  try {
    agent = await createCodingAgent(args.model);
    setSubagentHost(agent);
  } catch (e) {
    print(red(`Agent 初始化失败: ${(e as Error).message}`));
    process.exit(1);
    return;
  }

  // 4. 初始状态 + 自动恢复
  const state = createInitialState(ws.path);
  const restored = restoreSession(state, ws.path, ws.explicit);

  // 5. 显示界面
  //
  // 输入历史与 Tab 补全（Python 版的 input_history + VCACompleter，
  // TS 重写时丢了 —— 裸 readline 既翻不出历史也补不了全）。
  // 历史只在**主事件循环**里记录：runAgent 内部的 ask_user 回答、打断菜单
  // 都是过程性输入，不该混进「↑ 翻回上次敲的命令」里。
  //
  // 在 cs 之前读出来：`/input` 命令读的就是这一份（cs.inputHistory），
  // 与 ↑/↓ 用的是同一个数组 —— 命令里再 readHistory 一次就是第二份真相。
  const inputHistory = readHistory(INPUT_HISTORY_FILE);
  const cs: CommandState = {
    sessionId: restored.sessionId,
    workspaceDir: restored.workspaceDir,
    verbose: false,
    windowNo: storage.listSessions().length + 1,
    modelName: agent.modelConfig.name,
    inputHistory,
  };

  showBanner();
  panel(
    `工作空间: ${cyan(state.workspace_dir)}\n` +
      `当前窗口: ${bold(magenta(`#${cs.windowNo}`))}\n\n` +
      `输入编程任务，Agent 将自动完成。\n` +
      `输入 ${cyan("/help")} 查看可用命令，${cyan("/cd <路径>")} 切换项目。\n` +
      `${cyan("/new")} 开启新对话窗口。\n` +
      `${dim("↑/↓")} 翻回敲过的内容，${dim("Tab")} 补全命令与路径。`,
    bold("就绪"),
    "green"
  );
  print();

  // 6. 主事件循环
  const completerContext = {
    commands: commandNames(),            // 命令清单的唯一来源是 help.ts
    configKeys: [...EDITABLE_KEYS].sort(), // 配置键的唯一来源是 config.ts
    models: [] as string[],              // 每次补全时现读，支持 /model 切完立刻补得到
    cwd: cs.workspaceDir,
  };

  while (true) {
    const prompt = formatPrompt(cs.workspaceDir, cs.windowNo, cs.verbose);
    const userInput = await promptUser(prompt, {
      history: inputHistory,
      completer: (line) =>
        completeInput(line, {
          ...completerContext,
          models: Config.getModels().map((m) => m.name),
          cwd: cs.workspaceDir,
        }),
    });
    setInterrupted(false);

    if (userInput === null) {
      // Ctrl+C / EOF → 保存退出
      if (cs.sessionId || state.messages.length > 0) {
        const sid = storage.autoSave(state, cs.sessionId ?? undefined);
        print(`\n对话已自动保存 (${sid})`);
      }
      print(yellow("再见!"));
      break;
    }

    const input = userInput.trim();
    if (!input) continue;

    // 记一条历史并落盘（命令也记 —— shell 就是这么做的）。
    // pushHistory 会挡掉空行与连续重复，返回 false 时不必重写文件。
    if (pushHistory(inputHistory, input)) {
      writeHistory(INPUT_HISTORY_FILE, inputHistory);
    }

    // 处理命令
    if (input.startsWith("/")) {
      const cmd = input.toLowerCase().split(/\s+/)[0];
      await handleCommand(cmd, input, state, cs);
      print();
      continue;
    }

    // 运行 Agent (每次按当前模型创建, 支持 /model 切换)
    try {
      agent = await createCodingAgent(cs.modelName);
      // 每轮都重建 Agent，所以每轮都要重新登记：`/model` 换了模型之后，
      // 子代理必须跟着换（不然它会悄悄用上一个模型，而这在日志里看不出来）。
      setSubagentHost(agent);
    } catch (e) {
      print(red(`Agent 创建失败: ${(e as Error).message}`));
      continue;
    }
    await runAgent(agent, state, input, cs.verbose);
    // 每次交互后自动保存
    cs.sessionId = storage.autoSave(state, cs.sessionId ?? undefined);
    print();
  }
}

process.on("unhandledRejection", (err) => {
  print(red(`[未处理的 Promise 异常] ${err}`));
});

// 只在被直接执行时启动 CLI（被 import 时不启动）。
//
// ⚠ 这里曾经是 `import.meta.url === \`file://${argv[1].replace(/\\/g,"/")}\``，
// 在 Windows 上**永不成立**：盘符路径的 file URL 是 `file:///E:/x/main.ts`
// （三个斜杠），手拼出来的是 `file://E:/x/main.ts`（两个），于是 main() 从不被调用，
// `npm run dev` / `npm start` 一行输出都没有就退出。POSIX 下两者恰好相同，
// 所以这个 bug 只在 Windows 上现形。pathToFileURL 会做完整规范化（含盘符、
// 空格与中文的百分号编码），跨平台一致。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    print(red(`[FATAL] ${e}`));
    process.exit(1);
  });
}
