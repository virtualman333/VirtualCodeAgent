<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{ plan: string }>();

const collapsed = ref(false);

interface Step {
  index: string;
  icon: string;
  text: string;
  status: string;
}

const steps = computed<Step[]>(() => {
  const text = props.plan ?? "";
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\s/.test(l))
    .map((l) => {
      const m = l.match(/^(\d+)\.\s*(.*)$/);
      const raw = m ? m[2] : l;
      let icon = "🔲";
      let status = "pending";
      for (const [ic, st] of [
        ["✅", "completed"],
        ["🔄", "in_progress"],
        ["❌", "failed"],
        ["🔲", "pending"],
      ] as const) {
        if (raw.includes(ic)) {
          icon = ic;
          status = st;
          break;
        }
      }
      return {
        index: m ? m[1] : "",
        icon,
        text: raw.replace(/✅|🔄|❌|🔲/g, "").trim(),
        status,
      };
    });
});

const total = computed(() => steps.value.length);
const done = computed(() => steps.value.filter((s) => s.status === "completed").length);
const current = computed(() => steps.value.find((s) => s.status === "in_progress"));
const pct = computed(() => (total.value ? Math.round((done.value / total.value) * 100) : 0));
</script>

<template>
  <div class="plan-list" v-if="steps.length > 0">
    <div class="plan-head" @click="collapsed = !collapsed">
      <span class="plan-title">📋 任务清单</span>
      <span class="plan-progress">{{ done }}/{{ total }} 已完成</span>
      <span class="plan-bar">
        <span class="plan-bar-fill" :style="{ width: pct + '%' }"></span>
      </span>
      <span class="plan-chevron">{{ collapsed ? "▸" : "▾" }}</span>
    </div>
    <div v-if="!collapsed" class="plan-body">
      <div
        v-for="s in steps"
        :key="s.index"
        class="plan-item"
        :class="`status-${s.status}`"
      >
        <span class="plan-icon">{{ s.icon }}</span>
        <span class="plan-text">{{ s.text }}</span>
        <span class="plan-tag" v-if="s.status === 'in_progress'">进行中</span>
        <span class="plan-tag done" v-else-if="s.status === 'completed'">完成</span>
        <span class="plan-tag failed" v-else-if="s.status === 'failed'">失败</span>
      </div>
      <div class="plan-note" v-if="current">
        <span class="dot-pulse" />{{ current.text }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.plan-list {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  flex-shrink: 0;
}
.plan-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  cursor: pointer;
  user-select: none;
  background: var(--bg-hover);
}
.plan-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  white-space: nowrap;
}
.plan-progress {
  font-size: 11px;
  color: var(--accent-2);
  background: var(--accent-bg);
  padding: 1px 8px;
  border-radius: 10px;
  white-space: nowrap;
}
.plan-bar {
  flex: 1;
  height: 4px;
  background: var(--border);
  border-radius: 2px;
  overflow: hidden;
  min-width: 40px;
}
.plan-bar-fill {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.4s;
}
.plan-chevron {
  color: var(--text-dim);
  font-size: 12px;
}
.plan-body {
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.plan-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.5;
}
.plan-item:hover {
  background: var(--bg-hover);
}
.plan-icon {
  font-size: 13px;
  flex-shrink: 0;
}
.plan-text {
  flex: 1;
  color: var(--text);
  word-break: break-word;
}
.status-completed .plan-text {
  color: var(--text-dim);
  text-decoration: line-through;
  text-decoration-color: var(--border-strong);
}
.status-in_progress .plan-text {
  color: var(--text);
  font-weight: 500;
}
.status-failed .plan-text {
  color: var(--red);
}
.plan-tag {
  font-size: 10px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--bg-hover);
  color: var(--text-dim);
  flex-shrink: 0;
}
.plan-tag.done {
  background: rgba(5, 150, 105, 0.12);
  color: var(--green);
}
.plan-tag.failed {
  background: rgba(220, 38, 38, 0.12);
  color: var(--red);
}
.plan-note {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--accent-2);
}
.dot-pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1s infinite;
  flex-shrink: 0;
}
@keyframes pulse {
  50% {
    opacity: 0.4;
  }
}
</style>
