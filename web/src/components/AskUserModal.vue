<script setup lang="ts">
import { ref } from "vue";

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
  <div class="modal-mask">
    <div class="modal">
      <h3>💬 {{ header }}</h3>
      <p class="q">{{ question }}</p>

      <div v-if="options.length" class="options">
        <button
          v-for="opt in options"
          :key="opt"
          class="opt"
          :class="{ sel: selected.includes(opt) }"
          @click="toggle(opt)"
        >
          {{ opt }}
        </button>
      </div>
      <div v-if="isMulti && options.length" class="multi-tip">多选模式：可点选多个后确认</div>

      <div class="custom">
        <input
          v-model="customText"
          placeholder="自定义回答..."
          @keydown.enter="submitCustom"
        />
        <button @click="submitCustom">提交</button>
      </div>

      <div class="modal-actions">
        <button
          v-if="isMulti && selected.length"
          class="primary"
          @click="confirmMulti"
        >
          确认 ({{ selected.length }})
        </button>
        <button class="ghost" @click="emit('skip')">跳过</button>
      </div>
    </div>
  </div>
</template>
