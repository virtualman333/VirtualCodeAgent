<script setup lang="ts">
import { ref, computed } from "vue";

const props = defineProps<{
  name: string;
  args: Record<string, unknown>;
  result?: string;
  running: boolean;
}>();

const expanded = ref(false);

const argsText = computed(() =>
  Object.entries(props.args ?? {})
    .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v)}`)
    .join(", ")
);

const resultPreview = computed(() => {
  if (!props.result) return "";
  return props.result.length > 2000 ? props.result.slice(0, 2000) + "\n... (结果已截断)" : props.result;
});
</script>

<template>
  <div class="tool-card" :class="{ running, done: !running && result !== undefined }">
    <div class="tool-head" @click="expanded = !expanded">
      <span class="dot" />
      <span class="tool-name">→ {{ name }}</span>
      <span class="tool-args">{{ argsText }}</span>
      <span class="state">{{ running ? "运行中..." : "✓ 完成" }}</span>
      <span class="chevron">{{ expanded ? "▾" : "▸" }}</span>
    </div>
    <div v-if="expanded && result !== undefined" class="tool-result">
      <pre>{{ resultPreview }}</pre>
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-left: 3px solid var(--cyan);
  border-radius: var(--radius);
  overflow: hidden;
}
.tool-card.running {
  border-left-color: var(--yellow);
}
.tool-card.done {
  border-left-color: var(--accent-2);
}
.tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  cursor: pointer;
  user-select: none;
}
.tool-head:hover {
  background: var(--bg-hover);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--cyan);
  flex-shrink: 0;
}
.running .dot {
  background: var(--yellow);
  animation: pulse 1s infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
.tool-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--cyan);
  white-space: nowrap;
}
.tool-args {
  font-size: 12px;
  color: var(--text-dim);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  flex: 1;
}
.state {
  font-size: 11px;
  color: var(--text-dim);
  flex-shrink: 0;
}
.chevron {
  color: var(--text-dim);
  font-size: 12px;
}
.tool-result {
  border-top: 1px solid var(--border);
  padding: 10px 14px;
  max-height: 260px;
  overflow-y: auto;
}
.tool-result pre {
  font-size: 12px;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-all;
  font-family: "Cascadia Code", Consolas, monospace;
}
</style>
