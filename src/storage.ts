/**
 * 对话记录存储 - 自动保存/恢复会话
 */
import fs from "node:fs";
import path from "node:path";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import { VCA_DIR, SESSIONS_DIR } from "./config.js";
import type { AgentState } from "./agent/state.js";

const INDEX_FILE = path.join(VCA_DIR, "session_index.json");

// ============================================================
// 序列化 / 反序列化
// ============================================================

type MessageDict = {
  type: string;
  content: string;
  tool_calls?: Array<{ name: string; args: Record<string, unknown>; id: string }>;
  tool_call_id?: string;
  name?: string;
};

export function messageToDict(msg: BaseMessage): MessageDict {
  const out: MessageDict = { type: msg.constructor.name, content: String(msg.content ?? "") };
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
      return new HumanMessage({ content });
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
// 索引管理
// ============================================================

interface SessionEntry {
  id: string;
  title: string;
  workspace: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

function readIndex(): SessionEntry[] {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    if (fs.existsSync(INDEX_FILE)) {
      const data = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
      if (Array.isArray(data)) return data as SessionEntry[];
    }
  } catch {
    /* ignore */
  }
  return [];
}

function writeIndex(index: SessionEntry[]): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");
}

function nowStr(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
}

function updateIndex(sessionId: string, title: string, workspace: string, messageCount: number): void {
  const now = nowStr();
  const entry: SessionEntry = {
    id: sessionId,
    title,
    workspace,
    message_count: messageCount,
    created_at: now,
    updated_at: now,
  };

  const index = readIndex();
  for (let i = 0; i < index.length; i++) {
    if (index[i].id === sessionId) {
      entry.created_at = index[i].created_at;
      entry.title = index[i].title || title;
      index[i] = entry;
      writeIndex(index);
      return;
    }
  }
  index.unshift(entry);
  writeIndex(index.slice(0, 50));
}

function removeFromIndex(sessionId: string): void {
  writeIndex(readIndex().filter((item) => item.id !== sessionId));
}

// ============================================================
// 保存 / 加载 / 管理
// ============================================================

export function saveSession(
  sessionId: string,
  messages: BaseMessage[],
  workspaceDir: string,
  title = ""
): string {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

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
  const filepath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf-8");
  updateIndex(sessionId, title, workspaceDir, clean.length);
  return sessionId;
}

export function loadSession(sessionId: string): { messages: BaseMessage[]; workspace_dir: string; title: string } | null {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const filepath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (!fs.existsSync(filepath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(filepath, "utf-8")) as MessageDict[];
    const messages = deserializeMessages(data);

    let workspace = "";
    let title = "";
    for (const item of readIndex()) {
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

export function listSessions(maxCount = 20): SessionEntry[] {
  return readIndex().slice(0, maxCount);
}

export function deleteSession(sessionId: string): boolean {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const filepath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  let deleted = false;
  if (fs.existsSync(filepath)) {
    fs.rmSync(filepath);
    deleted = true;
  }
  removeFromIndex(sessionId);
  return deleted;
}

export function generateSessionId(): string {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const stamp =
    now.toISOString().replace(/[-:]/g, "").replace(/[T.]/g, "_").slice(0, 15);
  return `${stamp}_${Math.floor(Math.random() * 100000)}`;
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
