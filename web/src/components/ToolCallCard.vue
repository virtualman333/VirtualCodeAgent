<script setup lang="ts">
import { ref, computed } from "vue";
import {
  ArrowRightIcon,
  FileIcon,
  CheckCircleIcon,
  LoadingIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "tdesign-icons-vue-next";

const props = defineProps<{
  name: string;
  args: Record<string, unknown>;
  result?: string;
  running: boolean;
  /** 是否显示"在编辑器中打开"按钮 (VS Code 环境) */
  showOpen?: boolean;
}>();

const emit = defineEmits<{
  (e: "open-file", path: string, line?: number): void;
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

/** 工具涉及的文件路径 (read/edit/write 的 path 参数) */
const filePath = computed<string | null>(() => {
  const p = props.args?.path;
  return typeof p === "string" && p.trim() ? p.trim() : null;
});

/** 从 edit 结果解析行号 (如 "第 5 行" / "第 3-7 行") */
const fileLine = computed<number | undefined>(() => {
  if (!props.result) return undefined;
  const m = props.result.match(/第\s*(\d+)\s*(?:-(\d+))?\s*行/);
  return m ? Number(m[1]) : undefined;
});

function onOpenFile(): void {
  if (filePath.value) emit("open-file", filePath.value, fileLine.value);
}
</script>

<template>
  <div class="tool-card" :class="{ running, done: !running && result !== undefined }">
    <div class="tool-head" @click="expanded = !expanded">
      <span class="dot" />
      <span class="tool-name"><ArrowRightIcon class="tool-arrow" /> {{ name }}</span>
      <span class="tool-args">{{ argsText }}</span>
      <button
        v-if="showOpen && filePath && !running"
        class="open-btn"
        title="在编辑器中打开文件"
        @click.stop="onOpenFile"
      ><FileIcon /></button>
      <span class="state">
        <LoadingIcon v-if="running" class="spin" />
        <CheckCircleIcon v-else />
        {{ running ? "运行中..." : "完成" }}
      </span>
      <span class="chevron"><ChevronDownIcon v-if="expanded" /><ChevronRightIcon v-else /></span>
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
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.tool-arrow {
  font-size: 12px;
}
.tool-args {
  font-size: 12px;
  color: var(--text-dim);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  flex: 1;
}
.open-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-dim);
  font-size: 12px;
  padding: 1px 5px;
  flex-shrink: 0;
  line-height: 1.4;
}
.open-btn:hover {
  border-color: var(--accent);
  background: rgba(76, 154, 255, 0.12);
}
.state {
  font-size: 11px;
  color: var(--text-dim);
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.state .spin {
  animation: rotate 1s linear infinite;
}
@keyframes rotate {
  to {
    transform: rotate(360deg);
  }
}
.chevron {
  color: var(--text-dim);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
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
