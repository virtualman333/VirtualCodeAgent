<script setup lang="ts">
import { ref } from "vue";
import { Dialog as TDialog, Button as TButton, Input as TInput } from "tdesign-vue-next";

const props = defineProps<{
  header: string;
  question: string;
  options: string[];
  isMulti: boolean;
}>();

const emit = defineEmits<{
  (e: "select", value: string): void;
  (e: "custom", value: string): void;
  (e: "skip"): void;
}>();

const customText = ref("");
const selected = ref<string[]>([]);

function toggle(opt: string): void {
  if (props.isMulti) {
    const i = selected.value.indexOf(opt);
    if (i >= 0) selected.value.splice(i, 1);
    else selected.value.push(opt);
  } else {
    emit("select", opt);
  }
}

function confirmMulti(): void {
  if (selected.value.length > 0) emit("select", selected.value.join(", "));
}

function submitCustom(): void {
  const v = customText.value.trim();
  if (v) emit("custom", v);
}
</script>

<template>
  <TDialog
    :visible="true"
    :header="`💬 ${header}`"
    width="480px"
    :footer="false"
    :close-on-overlay-click="false"
  >
    <p class="q">{{ question }}</p>

    <div v-if="options.length" class="options">
      <TButton
        v-for="opt in options"
        :key="opt"
        :variant="selected.includes(opt) ? 'base' : 'outline'"
        :theme="selected.includes(opt) ? 'primary' : 'default'"
        class="opt"
        @click="toggle(opt)"
      >
        {{ opt }}
      </TButton>
    </div>
    <div v-if="isMulti && options.length" class="multi-tip">多选模式：可点选多个后确认</div>

    <div class="custom">
      <TInput
        v-model="customText"
        placeholder="自定义回答..."
        @keydown.enter="submitCustom"
      />
      <TButton theme="primary" variant="base" @click="submitCustom">提交</TButton>
    </div>

    <div class="modal-actions">
      <TButton
        v-if="isMulti && selected.length"
        theme="primary"
        @click="confirmMulti"
      >
        确认 ({{ selected.length }})
      </TButton>
      <TButton variant="outline" @click="emit('skip')">跳过</TButton>
    </div>
  </TDialog>
</template>

<style scoped>
.q {
  margin-bottom: 16px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.opt {
  margin: 0;
}
.multi-tip {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 12px;
}
.custom {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
