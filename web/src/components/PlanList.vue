<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{ plan: string }>();
const emit = defineEmits<{ (e: "close"): void }>();

const collapsed = ref(false);

interface Step {
  index: string;
  text: string;
  status: "completed" | "in_progress" | "failed" | "pending";
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
      let status: Step["status"] = "pending";
      if (raw.includes("✅")) status = "completed";
      else if (raw.includes("🔄")) status = "in_progress";
      else if (raw.includes("❌")) status = "failed";
      return {
        index: m ? m[1] : "",
        text: raw.replace(/✅|🔄|❌|🔲/g, "").trim(),
        status,
      };
    });
});

const total = computed(() => steps.value.length);
const done = computed(() => steps.value.filter((s) => s.status === "completed").length);
const current = computed(() => steps.value.find((s) => s.status === "in_progress"));
</script>

<template>
  <div class="plan-list" v-if="steps.length > 0">
    <div class="plan-head">
      <button class="plan-toggle" @click="collapsed = !collapsed" :title="collapsed ? '展开' : '收起'">
        <span class="list-icon">
          <span></span><span></span><span></span>
        </span>
        <span class="plan-title">任务清单</span>
        <span class="plan-progress">{{ done }}/{{ total }} 已完成</span>
      </button>
      <span class="plan-spacer" />
      <button class="plan-chevron" @click="collapsed = !collapsed" :title="collapsed ? '展开' : '收起'">
        <svg viewBox="0 0 16 16" width="12" height="12" :class="{ flip: collapsed }">
          <path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <button class="plan-close" @click="emit('close')" title="隐藏任务清单">
        <svg viewBox="0 0 16 16" width="12" height="12">
          <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <div v-if="!collapsed" class="plan-body">
      <div
        v-for="s in steps"
        :key="s.index"
        class="plan-item"
        :class="`status-${s.status}`"
      >
        <span class="check">
          <svg v-if="s.status === 'completed'" viewBox="0 0 16 16" width="10" height="10">
            <path d="M3.5 8.3l3 3 6-6.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span v-else-if="s.status === 'in_progress'" class="check-dot" />
          <span v-else-if="s.status === 'failed'" class="check-fail">!</span>
        </span>
        <span class="plan-text">{{ s.text }}</span>
      </div>

      <div v-if="current" class="plan-current">
        <span class="dot-pulse" />
        <span>{{ current.text }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plan-list {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: var(--shadow-sm);
}

/* 顶部行 */
.plan-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px 6px 10px;
  min-height: 32px;
}
.plan-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: none;
  padding: 2px 4px;
  border-radius: 6px;
  color: var(--text-2);
  font-size: 12.5px;
}
.plan-toggle:hover {
  background: var(--bg-hover);
}
.list-icon {
  display: inline-flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  width: 14px;
  height: 12px;
  flex-shrink: 0;
}
.list-icon span {
  display: block;
  height: 1.5px;
  background: var(--accent);
  border-radius: 1px;
}
.list-icon span:nth-child(1) { width: 100%; }
.list-icon span:nth-child(2) { width: 70%; }
.list-icon span:nth-child(3) { width: 85%; }

.plan-title {
  font-weight: 600;
  color: var(--text);
}
.plan-progress {
  font-size: 11.5px;
  color: var(--text-dim);
}
.plan-spacer {
  flex: 1;
}
.plan-chevron,
.plan-close {
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  border-radius: 5px;
  color: var(--text-dim);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.plan-chevron:hover,
.plan-close:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.plan-close:hover {
  color: var(--red);
}
.plan-chevron svg {
  transition: transform 0.2s;
}
.plan-chevron svg.flip {
  transform: rotate(-90deg);
}

/* 列表 */
.plan-body {
  padding: 4px 10px 8px;
  border-top: 1px solid var(--border);
}
.plan-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 4px 4px 4px 2px;
  font-size: 13px;
  line-height: 1.5;
}

/* checkbox 圆点 */
.check {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1.5px solid var(--border-strong);
  background: var(--bg-panel);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
  color: #fff;
  transition: all 0.15s;
}
.status-completed .check {
  background: var(--green);
  border-color: var(--green);
}
.status-in_progress .check {
  border-color: var(--accent);
  background: var(--accent-bg);
}
.status-failed .check {
  background: var(--red);
  border-color: var(--red);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}
.check-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1.1s infinite ease-in-out;
}
.check-fail {
  font-size: 10px;
  line-height: 1;
  margin-top: -1px;
}

.plan-text {
  flex: 1;
  color: var(--text);
  word-break: break-word;
  min-width: 0;
}
.status-completed .plan-text {
  color: var(--text-dim);
  text-decoration: line-through;
  text-decoration-color: var(--border-strong);
}
.status-pending .plan-text {
  color: var(--text-dim);
}
.status-failed .plan-text {
  color: var(--red);
}

/* 当前进行的提示 */
.plan-current {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 2px 2px;
  padding: 6px 10px 6px 8px;
  font-size: 12.5px;
  color: var(--green);
  background: rgba(5, 150, 105, 0.07);
  border-left: 2px solid var(--green);
  border-radius: 0 6px 6px 0;
  line-height: 1.5;
}
.dot-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--green);
  flex-shrink: 0;
  animation: pulse 1.1s infinite ease-in-out;
  box-shadow: 0 0 0 0 rgba(5, 150, 105, 0.5);
}
@keyframes pulse {
  0%   { opacity: 1;   transform: scale(1); }
  50%  { opacity: 0.45; transform: scale(0.85); }
  100% { opacity: 1;   transform: scale(1); }
}
</style>
