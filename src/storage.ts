/**
 * 对话记录存储 —— 自动保存 / 恢复会话。
 *
 * 这一层只干两件事：**把消息与 BaseMessage 互转**（LangChain 的对象图不能直接
 * JSON 化），以及**把路径定下来**（`VCA_DIR` 来自 config.ts）。索引、列表、
 * 搜索、删除那些纯文件逻辑全在 `./session-store.js`，那边目录由调用方传进去，
 * 所以能被单独测（本文件的 `import "./config.js"` 会在 import 时写
 * `~/.vca/config.json`，一行都测不得）。
 *
 * 拆分的边界就是「要不要碰用户的真实家目录」，与 `paths.ts` / `tools/executable.ts`
 * 同一个理由。
 */
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import { VCA_DIR } from "./config.js";
import type { AgentState } from "./agent/state.js";
import {
  deleteSession as deleteSessionIn,
  generateSessionId as generateSessionIdIn,
  listDefault,
  listSessions as listSessionsIn,
  nowStr,
  readSessionFile,
  searchSessions as searchSessionsIn,
  sessionsDir,
  upsertIndex,
  writeSessionFile,
  type DeleteOutcome,
  type SessionRow,
  type SessionSelection,
} from "./session-store.js";

// ============================================================
// 序列化 / 反序列化
// ============================================================

type MessageDict = {
  type: string;
  /** content 可以是字符串 (纯文本) 或字符串数组 (多模态 parts) */
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_calls?: Array<{ name: string; args: Record<string, unknown>; id: string }>;
  tool_call_id?: string;
  name?: string;
};

export function messageToDict(msg: BaseMessage): MessageDict {
  const raw = msg.content;
  let content: MessageDict["content"];
  if (Array.isArray(raw)) {
    // 多模态 content (如含图片的 HumanMessage)
    content = raw as MessageDict["content"];
  } else {
    content = String(raw ?? "");
  }
  const out: MessageDict = { type: msg.constructor.name, content };
  if (msg instanceof AIMessage) {
    if (msg.tool_calls?.length) {
      out.tool_calls = msg.tool_calls.map((tc) => ({
        name: tc.name,
        args: (tc.args ?? {}) as Record<string, unknown>,
        id: tc.id ?? "",
      }));
    }
  } else if (msg instanceof ToolMessage) {
    out.tool_call_id = msg.tool_call_id;
    out.name = msg.name ?? "";
  }
  return out;
}

export function dictToMessage(data: MessageDict): BaseMessage {
  const content = data.content ?? "";
  const type = data.type.replace("Message", "").toLowerCase();
  switch (type) {
    case "human":
      return new HumanMessage({ content: content as never });
    case "ai": {
      const toolCalls = data.tool_calls;
      if (toolCalls?.length) {
        return new AIMessage({
          content,
          tool_calls: toolCalls.map((tc) => ({
            name: tc.name,
            args: tc.args ?? {},
            id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
            type: "tool_call",
          })),
        });
      }
      return new AIMessage({ content });
    }
    case "system":
      return new SystemMessage({ content });
    case "tool":
      return new ToolMessage({
        content,
        tool_call_id: data.tool_call_id ?? "",
        name: data.name ?? "",
      });
    default:
      return new HumanMessage({ content: String(data) });
  }
}

function isInternalMessage(msg: BaseMessage): boolean {
  return msg instanceof ToolMessage && msg.content === "[AWAITING_USER_INPUT]";
}

function serializeMessages(messages: BaseMessage[]): MessageDict[] {
  return messages.filter((m) => !isInternalMessage(m)).map(messageToDict);
}

function deserializeMessages(data: MessageDict[]): BaseMessage[] {
  return data.map(dictToMessage);
}

// ============================================================
// 对外 API（路径绑定在 VCA_DIR 上）
// ============================================================

/** 会话文件所在目录（`/history` 的提示里会报出来，用户好自己去备份） */
export function getSessionsDir(): string {
  return sessionsDir(VCA_DIR);
}

/** `/history` 与 `/load` 共用的列表窗口大小 —— 只有一个来源，别在命令里写死数字 */
export function getListWindow(): number {
  return listDefault();
}

export function saveSession(
  sessionId: string,
  messages: BaseMessage[],
  workspaceDir: string,
  title = ""
): string {
  const clean = messages.filter((m) => !isInternalMessage(m));

  if (!title) {
    for (const m of clean) {
      if (m instanceof HumanMessage && m.content) {
        title = String(m.content).replace(/\n/g, " ").slice(0, 60);
        break;
      }
    }
    title = title || "未命名会话";
  }

  const data = serializeMessages(clean);
  writeSessionFile(VCA_DIR, sessionId, data);

  // 时间戳的写法只有一处（session-store.nowStr）—— 这里原来又拼了一遍
  // `new Date(Date.now() + 8*3600*1000).toISOString()...`：索引里的 created_at
  // 与 updated_at 一旦分头改格式，界面上那两个时间就会长得不一样
  const now = nowStr();
  upsertIndex(VCA_DIR, {
    id: sessionId,
    title,
    workspace: workspaceDir,
    message_count: clean.length,
    created_at: now,
    updated_at: now,
  });
  return sessionId;
}

export function loadSession(
  sessionId: string
): { messages: BaseMessage[]; workspace_dir: string; title: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId ?? ""))) return null;
  try {
    const data = readSessionFile(VCA_DIR, sessionId) as MessageDict[];
    const messages = deserializeMessages(data);

    let workspace = "";
    let title = "";
    for (const item of listSessionsIn(VCA_DIR)) {
      if (item.id === sessionId) {
        workspace = item.workspace;
        title = item.title;
        break;
      }
    }
    return { messages, workspace_dir: workspace, title };
  } catch {
    return null;
  }
}

/**
 * 会话列表：索引里有的 + **索引外的会话文件**。
 *
 * 不传 `maxCount` 是全部 —— 数总数的地方（窗口号、序号范围）不能被截断，
 * 要截断只在显示时截一次。
 */
export function listSessions(maxCount?: number): SessionRow[] {
  return listSessionsIn(VCA_DIR, maxCount);
}

export function searchSessions(opts: { limit?: number; filter?: string } = {}): SessionSelection {
  return searchSessionsIn(VCA_DIR, opts);
}

export function deleteSession(sessionId: string): DeleteOutcome {
  return deleteSessionIn(VCA_DIR, sessionId);
}

export function generateSessionId(): string {
  return generateSessionIdIn();
}

export function getLastSession(): { messages: BaseMessage[]; workspace_dir: string; title: string } | null {
  const sessions = listSessions(1);
  if (sessions.length === 0) return null;
  return loadSession(sessions[0].id);
}

export function autoSave(state: AgentState, sessionId?: string): string {
  if (!sessionId) sessionId = generateSessionId();
  saveSession(sessionId, state.messages, state.workspace_dir);
  return sessionId;
}
