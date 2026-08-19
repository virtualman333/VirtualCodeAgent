<script setup lang="ts">
import ToolCallCard from "./ToolCallCard.vue";

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

export interface Msg {
  id: number;
  kind: "user" | "thinking" | "tool" | "final" | "info" | "usage";
  content?: string;
  images?: { id: string; dataUrl: string }[];
  tool?: ToolCallInfo;
  html?: string;
  usage?: UsageInfo;
}

const props = defineProps<{ msg: Msg | null; vscode: boolean }>();

const emit = defineEmits<{
  (e: "open-file", path: string, line?: number): void;
}>();

function fmtNum(n: number): string {
  return Math.round(n || 0).toLocaleString();
}

function formatDuration(ms: number): string {
  if (!ms) return "-";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
</script>

<template>
  <div v-if="!msg" class="msg-block empty" />

  <!-- 用户消息 -->
  <template v-else-if="msg.kind === 'user'">
    <div v-if="msg.images && msg.images.length" class="user-images">
      <img v-for="img in msg.images" :key="img.id" :src="img.dataUrl" alt="" />
    </div>
    <div v-if="msg.content" class="user-text">{{ msg.content }}</div>
  </template>

  <!-- 思考过程 -->
  <div v-else-if="msg.kind === 'thinking'" class="msg-block">
    <details class="think-card" open>
      <summary class="think-head">🧠 深度思考</summary>
      <div class="think-body">{{ msg.content }}</div>
    </details>
  </div>

  <!-- 工具调用 -->
  <div v-else-if="msg.kind === 'tool'" class="msg-block tool-block">
    <ToolCallCard
      :name="msg.tool!.name"
      :args="msg.tool!.args"
      :result="msg.tool!.result"
      :running="msg.tool!.running"
      :show-open="vscode"
      @open-file="(p: string, l?: number) => emit('open-file', p, l)"
    />
  </div>

  <!-- 最终回答 -->
  <div v-else-if="msg.kind === 'final'" class="msg-block final-block">
    <div class="markdown" v-html="msg.html"></div>
  </div>

  <!-- 系统/信息 -->
  <div v-else-if="msg.kind === 'info'" class="msg-block info-line">{{ msg.content }}</div>

  <!-- Token 用量 -->
  <div v-else-if="msg.kind === 'usage'" class="msg-block usage-line">
    <span>
      📊 Token {{ fmtNum(msg.usage!.input_tokens) }}↑ / {{ fmtNum(msg.usage!.output_tokens) }}↓
      / 共 {{ fmtNum(msg.usage!.total_tokens) }}
      <template v-if="msg.usage!.tool_count"> | 工具 {{ msg.usage!.tool_count }} 次</template>
      | 耗时 {{ formatDuration(msg.usage!.llm_duration_ms + msg.usage!.tool_duration_ms) }}
    </span>
  </div>
</template>

<style scoped>
.msg-block {
  width: 100%;
}

.user-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
}
.user-images img {
  max-width: 180px;
  max-height: 140px;
  border-radius: 8px;
  border: 1px solid var(--border);
  object-fit: cover;
}
.user-text {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.7;
}

.think-card {
  border: 1px dashed var(--border);
  border-radius: 10px;
  background: var(--bg-soft);
  padding: 6px 10px;
  font-size: 13px;
  color: var(--text-dim);
}
.think-head {
  cursor: pointer;
  font-weight: 600;
  color: var(--text);
}
.think-body {
  margin-top: 6px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}

.final-block .markdown {
  font-size: 14px;
  line-height: 1.75;
  word-break: break-word;
}

.info-line {
  font-size: 12px;
  color: var(--text-dim);
  padding: 4px 2px;
}

.usage-line {
  font-size: 12px;
  color: var(--text-dim);
  padding: 2px;
}
</style>
