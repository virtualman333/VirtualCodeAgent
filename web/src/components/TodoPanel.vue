<script setup lang="ts">
import { computed } from "vue";
import { ViewListIcon } from "tdesign-icons-vue-next";

const props = defineProps<{ plan: string }>();

const steps = computed(() => {
  const text = props.plan ?? "";
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\s/.test(l));
});
</script>

<template>
  <div class="panel">
    <h3><ViewListIcon class="h3-icon" /> 任务计划</h3>
    <div v-if="steps.length === 0" style="font-size: 12px; color: var(--text-dim)">
      暂无计划（Agent 处理多步任务时会自动创建）
    </div>
    <div v-else class="todo-steps">
      <div v-for="(s, i) in steps" :key="i" class="todo-step">{{ s }}</div>
    </div>
  </div>
</template>
