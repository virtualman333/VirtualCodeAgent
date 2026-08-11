<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, computed } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
import ToolCallCard from "./components/ToolCallCard.vue";
import TodoPanel from "./components/TodoPanel.vue";
import AskUserModal from "./components/AskUserModal.vue";

// ============================================================
// 类型定义 (WS 协议)
// ============================================================

interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

interface ToolCallInfo {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  running: boolean;
}

interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  tool_count: number;
  llm_duration_ms: number;
  tool_duration_ms: number;
}

type Msg =
  | { id: number; kind: "user"; content: string }
  | { id: number; kind: "thinking"; content: string }
  | { id: number; kind: "tool"; tool: ToolCallInfo }
  | { id: number; kind: "final"; html: string }
  | { id: number; kind: "info"; content: string }
  | { id: number; kind: "usage"; usage: UsageInfo };

interface AskPending {
  header: string;
  question: string;
  options: string[];
  is_multi: boolean;
}

// ============================================================
// 状态
// ============================================================

const messages = ref<Msg[]>([]);
const input = ref("");
const running = ref(false);
const connected = ref(false);
const plan = ref("");
const model = ref("—");
const workspace = ref("");
const askPending = ref<AskPending | null>(null);
const wsPath = ref("");
const scrollRef = ref<HTMLElement | null>(null);

let ws: WebSocket | null = null;
let msgSeq = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const toolById = new Map<string, ToolCallInfo>();

function push(m: Omit<Msg, "id">): void {
  messages.value.push({ ...m, id: ++msgSeq } as Msg);
  scrollToBottom();
}

function scrollToBottom(): void {
  nextTick(() => {
    const el = scrollRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function renderMd(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string);
}

function fmtNum(n: number): string {
  return Math.round(n || 0).toLocaleString();
}

const lastUsage = computed<UsageInfo | null>(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const m = messages.value[i];
    if (m.kind === "usage") return m.usage;
  }
  return null;
});

// ============================================================
// WebSocket
// ============================================================

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws`;
  wsPath.value = url;
  ws = new WebSocket(url);

  ws.onopen = () => {
    connected.value = true;
    push({ kind: "info", content: "已连接服务" });
  };

  ws.onclose = () => {
    connected.value = false;
    running.value = false;
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };

  ws.onmessage = (ev) => {
    let e: ServerEvent;
    try {
      e = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    handleEvent(e);
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

function handleEvent(e: ServerEvent): void {
  switch (e.type) {
    case "running":
      running.value = Boolean(e.value);
      break;
    case "info":
      push({ kind: "info", content: String(e.text ?? "") });
      break;
    case "thinking": {
      const content = String(e.content ?? "");
      if (content.trim()) push({ kind: "thinking", content });
      break;
    }
    case "tool_call": {
      const tool: ToolCallInfo = {
        id: String(e.serverId),
        name: String(e.name),
        args: (e.args as Record<string, unknown>) ?? {},
        running: true,
      };
      toolById.set(tool.id, tool);
      push({ kind: "tool", tool });
      break;
    }
    case "tool_result": {
      const tool = toolById.get(String(e.serverId));
      if (tool) {
        tool.result = String(e.content ?? "");
        tool.running = false;
      }
      break;
    }
    case "plan":
      plan.value = String(e.content ?? "");
      break;
    case "final":
      push({
        kind: "final",
        html: renderMd(String(e.content ?? "")),
      });
      break;
    case "usage":
      push({
        kind: "usage",
        usage: {
          input_tokens: Number(e.input_tokens ?? 0),
          output_tokens: Number(e.output_tokens ?? 0),
          total_tokens: Number(e.total_tokens ?? 0),
          tool_count: Number(e.tool_count ?? 0),
          llm_duration_ms: Number(e.llm_duration_ms ?? 0),
          tool_duration_ms: Number(e.tool_duration_ms ?? 0),
        },
      });
      break;
    case "ask_user":
      askPending.value = {
        header: String(e.header ?? "确认"),
        question: String(e.question ?? ""),
        options: Array.isArray(e.options) ? (e.options as string[]) : [],
        is_multi: Boolean(e.is_multi),
      };
      break;
  }
  scrollToBottom();
}

// ============================================================
// 交互
// ============================================================

function send(): void {
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN || running.value) return;
  push({ kind: "user", content: text });
  input.value = "";
  ws.send(JSON.stringify({ type: "chat", content: text }));
}

function cancel(): void {
  ws?.send(JSON.stringify({ type: "cancel" }));
}

function onAskSelect(v: string): void {
  askPending.value = null;
  ws?.send(JSON.stringify({ type: "answer_option", content: v }));
}
function onAskCustom(v: string): void {
  askPending.value = null;
  ws?.send(JSON.stringify({ type: "answer", content: v }));
}
function onAskSkip(): void {
  askPending.value = null;
  ws?.send(JSON.stringify({ type: "skip_question" }));
}

function onWorkspaceChange(ev: Event): void {
  const val = (ev.target as HTMLInputElement).value.trim();
  if (!val) return;
  ws?.send(JSON.stringify({ type: "workspace", path: val }));
}

function formatDuration(ms: number): string {
  if (!ms) return "-";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

onMounted(() => {
  connect();
});

onUnmounted(() => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  ws?.close();
});
</script>

<template>
  <div class="app">
    <!-- 顶栏 -->
    <header class="topbar">
      <span class="logo">⚡ VCA</span>
      <span class="conn">
        <span class="dot" :class="{ on: connected }" />
        {{ connected ? "已连接" : "连接中..." }}
      </span>
      <span class="model">{{ model }}</span>
    </header>

    <div class="main">
      <!-- 聊天区 -->
      <div class="chat">
        <div class="messages" ref="scrollRef">
          <template v-for="m in messages" :key="m.id">
            <!-- 用户消息 -->
            <div v-if="m.kind === 'user'" class="msg user">{{ m.content }}</div>

            <!-- 思考 -->
            <div v-else-if="m.kind === 'thinking'" class="msg thinking">
              <details class="think-card" open>
                <summary class="think-head">
                  🧠 深度思考
                  <span class="think-collapsed">{{ m.content.replace(/\s+/g, " ") }}</span>
                </summary>
                <div class="think-body">{{ m.content }}</div>
              </details>
            </div>

            <!-- 工具调用 -->
            <div v-else-if="m.kind === 'tool'" class="msg tool">
              <ToolCallCard
                :name="m.tool.name"
                :args="m.tool.args"
                :result="m.tool.result"
                :running="m.tool.running"
              />
            </div>

            <!-- 最终回答 -->
            <div v-else-if="m.kind === 'final'" class="msg final">
              <div class="markdown" v-html="m.html"></div>
            </div>

            <!-- 提示 -->
            <div v-else-if="m.kind === 'info'" class="msg info">{{ m.content }}</div>

            <!-- 消耗汇总 -->
            <div v-else-if="m.kind === 'usage'" class="msg usage">
              📊 Token {{ fmtNum(m.usage.input_tokens) }}↑ / {{ fmtNum(m.usage.output_tokens) }}↓
              / 共 {{ fmtNum(m.usage.total_tokens) }}
              <template v-if="m.usage.tool_count"> | 工具 {{ m.usage.tool_count }} 次</template>
              | 耗时 {{ formatDuration(m.usage.llm_duration_ms + m.usage.tool_duration_ms) }}
            </div>
          </template>
        </div>

        <!-- 输入区 -->
        <div class="input-area">
          <textarea
            v-model="input"
            placeholder="输入编程任务，回车发送 (Shift+Enter 换行)..."
            rows="1"
            @keydown.enter.exact.prevent="send"
            @keydown.enter.shift="() => {}"
          />
          <button v-if="running" class="btn stop" @click="cancel">⏹ 停止</button>
          <button class="btn" :disabled="running || !connected" @click="send">发送</button>
        </div>
      </div>

      <!-- 侧边栏 -->
      <aside class="side">
        <TodoPanel :plan="plan" />
        <div class="panel">
          <h3>📍 工作空间</h3>
          <div class="workspace-box">
            <div style="margin-bottom: 4px">{{ workspace || "默认 (~/.vca/workspace)" }}</div>
            <input
              placeholder="切换目录 (如 D:\\my-project)"
              @keydown.enter="onWorkspaceChange"
            />
          </div>
        </div>
        <div class="panel">
          <h3>ℹ️ 信息</h3>
          <div style="font-size: 12px; color: var(--text-dim); line-height: 1.8">
            <div>连接: {{ wsPath }}</div>
            <div>模型: {{ model }}</div>
            <div>协议: WS 流式事件</div>
          </div>
        </div>
      </aside>
    </div>

    <!-- AskUser 弹窗 -->
    <AskUserModal
      v-if="askPending"
      :header="askPending.header"
      :question="askPending.question"
      :options="askPending.options"
      :is-multi="askPending.is_multi"
      @select="onAskSelect"
      @custom="onAskCustom"
      @skip="onAskSkip"
    />
  </div>
</template>
