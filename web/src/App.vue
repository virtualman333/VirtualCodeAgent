<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, computed } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { ChatList as TChatList, ChatSender as TChatSender } from "@tdesign-vue-next/chat";
import { Select as TSelect } from "tdesign-vue-next";
import {
  AddIcon,
  CloseIcon,
  SettingIcon,
  ControlPlatformIcon,
  LightbulbIcon,
  FolderIcon,
  LinkIcon,
  ImageIcon,
  EditIcon,
  ViewListIcon,
} from "tdesign-icons-vue-next";
import MsgBlock from "./components/MsgBlock.vue";
import TodoPanel from "./components/TodoPanel.vue";
import PlanList from "./components/PlanList.vue";
import AskUserModal from "./components/AskUserModal.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import {
  isVscodeEnv,
  createVscodeTransport,
  createWsTransport,
  type Transport,
  type ServerEvent,
} from "./transport";

// ============================================================
// 类型
// ============================================================

interface AttachedImage {
  id: string;
  dataUrl: string;
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

interface Msg {
  id: number;
  kind: "user" | "thinking" | "tool" | "final" | "info" | "usage";
  content?: string;
  images?: AttachedImage[];
  tool?: ToolCallInfo;
  html?: string;
  usage?: UsageInfo;
}

interface AskPending {
  header: string;
  question: string;
  options: string[];
  is_multi: boolean;
}

interface ModelOption {
  name: string;
  model: string;
  base_url?: string;
}

/** 单个 Tab = 一个独立会话 */
interface ChatTab {
  sessionId: string;
  title: string;
  messages: Msg[];
  input: string;
  attachedImages: AttachedImage[];
  running: boolean;
  plan: string;
  planDismissed: boolean;
  ctxTokens: number;
  ctxMax: number;
  ctxMessages: number;
  ctxPct: number;
  askPending: AskPending | null;
}

// ============================================================
// 状态
// ============================================================

const tabs = ref<ChatTab[]>([]);
const activeTabId = ref("");
const connected = ref(false);
const model = ref("—");
const settingsOpen = ref(false);
const settingsData = ref<unknown>(null);
const settingsBusy = ref(false);
const models = ref<ModelOption[]>([]);
const workspace = ref("");
const enhancing = ref(false);
const chatListRef = ref<InstanceType<typeof TChatList> | null>(null);
const senderRef = ref<InstanceType<typeof TChatSender> | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

/** 头像: 用户 / 助手 (info/usage 系统消息不显示头像) */
const USER_AVATAR =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="#4c6ef5"/><circle cx="20" cy="15" r="7" fill="#ffffff"/><path d="M6 35c2.5-7.5 8-11 14-11s11.5 3.5 14 11z" fill="#ffffff"/></svg>'
  );
const ASSISTANT_AVATAR = "/logo-512.png";

const isVscode = isVscodeEnv();

let transport: Transport | null = null;
let msgSeq = 0;
let imgSeq = 0;
const toolById = new Map<string, ToolCallInfo>();

// ---- 当前 Tab 代理 ----

const activeTab = computed<ChatTab | null>(
  () => tabs.value.find((t) => t.sessionId === activeTabId.value) ?? null
);

const messages = computed<Msg[]>(() => activeTab.value?.messages ?? []);
const input = computed({
  get: () => activeTab.value?.input ?? "",
  set: (v: string) => {
    if (activeTab.value) activeTab.value.input = v;
  },
});
const attachedImages = computed<AttachedImage[]>(() => activeTab.value?.attachedImages ?? []);
const running = computed(() => activeTab.value?.running ?? false);
const plan = computed(() => activeTab.value?.plan ?? "");

/** 映射为 TDesign ChatList 的消息数据 (自定义字段 msg 供 content 插槽渲染) */
const chatData = computed(() =>
  messages.value.map((m) => {
    if (m.kind === "user") return { role: "user", msg: m, content: [] as unknown[] };
    // 系统信息/用量统计: 居中显示, 无头像
    if (m.kind === "info" || m.kind === "usage") return { role: "system", msg: m, content: [] as unknown[] };
    return { role: "assistant", msg: m, content: [] as unknown[] };
  })
);

/** 模型下拉选项 */
const modelOptions = computed(() => models.value.map((m) => ({ label: m.name, value: m.name })));

/** 是否可发送 (有文字或已附加图片) */
const canSend = computed(() => Boolean(input.value.trim()) || attachedImages.value.length > 0);
const askPending = computed(() => activeTab.value?.askPending ?? null);

function createTab(sessionId?: string, title = "新对话"): ChatTab {
  const tab: ChatTab = {
    sessionId: sessionId ?? `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title,
    messages: [],
    input: "",
    attachedImages: [],
    running: false,
    plan: "",
    planDismissed: false,
    ctxTokens: 0,
    ctxMax: 0,
    ctxMessages: 0,
    ctxPct: 0,
    askPending: null,
  };
  tabs.value.push(tab);
  activeTabId.value = tab.sessionId;
  return tab;
}

function findTab(sessionId: string): ChatTab | null {
  return tabs.value.find((t) => t.sessionId === sessionId) ?? null;
}

// ============================================================
// 基础辅助
// ============================================================

function pushTo(tab: ChatTab, m: Omit<Msg, "id">): void {
  tab.messages.push({ ...m, id: ++msgSeq } as Msg);
  scrollToBottom();
}

function scrollToBottom(): void {
  nextTick(() => {
    chatListRef.value?.scrollToBottom?.({ behavior: "smooth" } as never);
  });
}

function focusInput(): void {
  const el = (senderRef.value as any)?.$el;
  const ta = el && typeof el.querySelector === "function" ? el.querySelector("textarea") : null;
  (ta ?? document.querySelector<HTMLTextAreaElement>(".t-chat-sender textarea"))?.focus();
}

function renderMd(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string);
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function contextColor(pct: number): string {
  if (pct >= 90) return "var(--red)";
  if (pct >= 70) return "var(--yellow)";
  return "var(--green)";
}

// ============================================================
// 图片输入
// ============================================================

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function processFile(file: File): Promise<AttachedImage | null> {
  if (!file.type.startsWith("image/")) return null;
  if (file.size > MAX_IMAGE_BYTES) {
    if (activeTab.value) {
      pushTo(activeTab.value, { kind: "info", content: `图片过大 (>${MAX_IMAGE_BYTES / 1024 / 1024}MB): ${file.name}` });
    }
    return null;
  }
  return { id: `img_${++imgSeq}`, dataUrl: await readAsDataUrl(file) };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function handlePastedFiles(files: File[]): Promise<void> {
  const tab = activeTab.value;
  if (!tab) return;
  const imgs: AttachedImage[] = [];
  for (const f of files) {
    const img = await processFile(f);
    if (img) imgs.push(img);
  }
  if (imgs.length === 0) return;
  const remaining = MAX_IMAGES - tab.attachedImages.length;
  if (remaining <= 0) {
    pushTo(tab, { kind: "info", content: `最多 ${MAX_IMAGES} 张图片` });
    return;
  }
  tab.attachedImages.push(...imgs.slice(0, remaining));
}

function onPaste(ev: ClipboardEvent): void {
  const items = ev.clipboardData?.items;
  if (!items) return;
  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === "file") {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length === 0) return;
  ev.preventDefault();
  void handlePastedFiles(files);
}

function removeImage(id: string): void {
  const tab = activeTab.value;
  if (tab) tab.attachedImages = tab.attachedImages.filter((i) => i.id !== id);
}

function clearImages(): void {
  const tab = activeTab.value;
  if (tab) tab.attachedImages = [];
}

function getInputDisplayText(): string {
  const tab = activeTab.value;
  if (!tab) return "";
  const placeholders = tab.attachedImages.map((_, i) => `[图片${i + 1}]`);
  if (placeholders.length === 0) return tab.input;
  if (tab.input.includes("[图片1]")) return tab.input;
  return tab.input ? `${tab.input} ${placeholders.join(" ")}` : placeholders.join(" ");
}

// ============================================================
// 自动增高 / 换行 / 发送
// ============================================================

function onSend(): void {
  const tab = activeTab.value;
  if (!tab || !transport || !connected.value || tab.running) return;
  const text = getInputDisplayText();
  const images = tab.attachedImages;
  if (!text.trim() && images.length === 0) return;
  pushTo(tab, { kind: "user", content: text, images: images.length ? [...images] : undefined });
  transport.send({
    type: "chat",
    content: text,
    images: images.map((i) => i.dataUrl),
    session_id: tab.sessionId,
  });
  tab.input = "";
  tab.attachedImages = [];
  requestAnimationFrame(focusInput);
}

function onFilePicker(ev: Event): void {
  const files = (ev.target as HTMLInputElement).files;
  if (!files) return;
  void handlePastedFiles(Array.from(files));
  (ev.target as HTMLInputElement).value = "";
}

function cancel(): void {
  const tab = activeTab.value;
  if (!tab) return;
  transport?.send({ type: "cancel", session_id: tab.sessionId });
}

function onAskSelect(v: string): void {
  const tab = activeTab.value;
  if (!tab) return;
  tab.askPending = null;
  transport?.send({ type: "answer_option", content: v, session_id: tab.sessionId });
}
function onAskCustom(v: string): void {
  const tab = activeTab.value;
  if (!tab) return;
  tab.askPending = null;
  transport?.send({ type: "answer", content: v, session_id: tab.sessionId });
}
function onAskSkip(): void {
  const tab = activeTab.value;
  if (!tab) return;
  tab.askPending = null;
  transport?.send({ type: "skip_question", session_id: tab.sessionId });
}

function onWorkspaceChange(ev: Event): void {
  const tab = activeTab.value;
  if (!tab) return;
  const val = (ev.target as HTMLInputElement).value.trim();
  if (!val) return;
  transport?.send({ type: "workspace", path: val, session_id: tab.sessionId });
}

function switchModel(value: unknown): void {
  const tab = activeTab.value;
  if (!tab) return;
  const name = String(value ?? "");
  if (!name || name === model.value) return;
  transport?.send({ type: "set_model", name, session_id: tab.sessionId });
}

function enhanceInput(): void {
  const tab = activeTab.value;
  if (!tab || enhancing.value) return;
  const current = tab.input.trim();
  if (!current) {
    pushTo(tab, { kind: "info", content: "请先输入内容，再使用增强提示词" });
    return;
  }
  enhancing.value = true;
  pushTo(tab, { kind: "info", content: "正在增强提示词..." });
  transport?.send({ type: "enhance", input: current, session_id: tab.sessionId });
}

function openFileInEditor(filePath: string, line?: number): void {
  const tab = activeTab.value;
  if (!tab) return;
  transport?.send({ type: "open_file", path: filePath, line: line ?? 0, session_id: tab.sessionId });
}

// ============================================================
// 设置
// ============================================================

function openSettings(): void {
  settingsOpen.value = true;
  settingsBusy.value = true;
  transport?.send({ type: "get_settings", session_id: activeTab.value?.sessionId ?? "" });
}
function closeSettings(): void {
  settingsOpen.value = false;
}
function saveGeneralSettings(updates: Record<string, unknown>): void {
  settingsBusy.value = true;
  transport?.send({
    type: "save_general_settings",
    updates,
    session_id: activeTab.value?.sessionId ?? "",
  });
}
function saveMcpConfig(servers: unknown[]): void {
  settingsBusy.value = true;
  transport?.send({
    type: "save_mcp_config",
    servers,
    session_id: activeTab.value?.sessionId ?? "",
  });
}
function reconnectMcp(): void {
  settingsBusy.value = true;
  transport?.send({ type: "reconnect_mcp", session_id: activeTab.value?.sessionId ?? "" });
}
function reloadConfig(): void {
  settingsBusy.value = true;
  transport?.send({ type: "reload_config", session_id: activeTab.value?.sessionId ?? "" });
}

// ============================================================
// Tab 管理
// ============================================================

function newTab(): void {
  createTab();
  transport?.send({ type: "new_session" });
  // 后端返回 session_created 时更新 sessionId
  requestAnimationFrame(focusInput);
}

function switchTab(id: string): void {
  if (tabs.value.some((t) => t.sessionId === id)) {
    activeTabId.value = id;
    scrollToBottom();
  }
}

function closeTab(id: string): void {
  const idx = tabs.value.findIndex((t) => t.sessionId === id);
  if (idx === -1) return;
  const tab = tabs.value[idx];
  transport?.send({ type: "close_session", session_id: tab.sessionId });
  tabs.value.splice(idx, 1);
  // 若关闭的是活动 tab，切换到相邻
  if (activeTabId.value === id) {
    const next = tabs.value[Math.min(idx, tabs.value.length - 1)];
    if (next) {
      activeTabId.value = next.sessionId;
    } else {
      createTab();
    }
  }
  if (tabs.value.length === 0) createTab();
}

function tabTitle(tab: ChatTab): string {
  const first = tab.messages.find((m) => m.kind === "user");
  if (first?.content) {
    return first.content.replace(/\n/g, " ").slice(0, 12) || "新对话";
  }
  return tab.title || "新对话";
}

// ============================================================
// 传输层
// ============================================================

function initTransport(): void {
  if (isVscodeEnv()) {
    transport = createVscodeTransport(handleEvent);
    connected.value = true;
    createTab(); // 等待 session_id 事件绑定
    // vscode 模式下扩展侧构造时同步 emit 的初始事件可能在 webview 就绪前丢失,
    // 主动发一次握手, 让后端重发 session_id / models / model / context。
    nextTick(() => {
      transport?.send({ type: "init" });
    });
    return;
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws`;
  transport = createWsTransport(url, handleEvent, (c) => {
    connected.value = c;
    if (c) {
      createTab();
    } else {
      for (const t of tabs.value) t.running = false;
    }
  });
}

function handleEvent(e: ServerEvent): void {
  const sid = String(e.sessionId ?? "");

  // 会话级事件 (需要绑定到具体 tab)
  switch (e.type) {
    case "session_id": {
      // 后端返回首个会话 id → 绑定到第一个 tab
      const first = tabs.value[0];
      if (first && !first.sessionId.startsWith("tab_")) {
        first.sessionId = String(e.id ?? first.sessionId);
      } else if (first) {
        first.sessionId = String(e.id ?? first.sessionId);
      }
      activeTabId.value = first?.sessionId ?? "";
      return;
    }
    case "session_created": {
      // 新建的 tab 获得真实 sessionId
      const id = String(e.id ?? "");
      const tab = tabs.value[tabs.value.length - 1];
      if (tab && (tab.sessionId.startsWith("tab_") || tab.messages.length === 0)) {
        tab.sessionId = id;
      } else {
        createTab(id);
      }
      activeTabId.value = id;
      return;
    }
    case "session_closed": {
      const id = String(e.id ?? "");
      const idx = tabs.value.findIndex((t) => t.sessionId === id);
      if (idx !== -1) tabs.value.splice(idx, 1);
      if (activeTabId.value === id) {
        const next = tabs.value[Math.min(idx, tabs.value.length - 1)];
        activeTabId.value = next?.sessionId ?? "";
      }
      if (tabs.value.length === 0) createTab();
      return;
    }
  }

  // 其余事件按 sessionId 路由 (无 sessionId 的模型/全局事件忽略 tab 关联)
  let tab: ChatTab | null = null;
  if (sid) {
    tab = findTab(sid);
  }
  // 模型/模型列表是全局的，直接更新
  if (e.type === "models") {
    if (Array.isArray(e.models)) {
      models.value = (e.models as ModelOption[]).map((m) => ({
        name: m.name ?? m.model,
        model: m.model ?? m.name ?? "",
        base_url: m.base_url,
      }));
    }
    return;
  }
  if (e.type === "model") {
    model.value = String(e.name ?? "");
    return;
  }
  if (e.type === "settings") {
    settingsData.value = e.settings ?? null;
    settingsBusy.value = false;
    return;
  }
  if (e.type === "settings_result") {
    settingsBusy.value = false;
    if (e.settings) settingsData.value = e.settings;
    const tabForInfo = activeTab.value ?? tab;
    if (tabForInfo) {
      if (String(e.section ?? "") === "config") {
        pushTo(tabForInfo, { kind: "info", content: e.ok ? "配置已重新加载" : `重载失败: ${String(e.error ?? "")}` });
      } else if (e.ok) {
        pushTo(tabForInfo, { kind: "info", content: `设置已保存 (${String(e.section ?? "")})` });
      } else {
        pushTo(tabForInfo, { kind: "info", content: `保存失败: ${String(e.error ?? "")}` });
      }
    }
    return;
  }

  if (!tab) tab = activeTab.value;
  if (!tab) return;

  switch (e.type) {
    case "running":
      tab.running = Boolean(e.value);
      break;
    case "info":
      pushTo(tab, { kind: "info", content: String(e.text ?? "") });
      break;
    case "thinking": {
      const content = String(e.content ?? "");
      if (content.trim()) pushTo(tab, { kind: "thinking", content });
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
      pushTo(tab, { kind: "tool", tool });
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
      tab.plan = String(e.content ?? "");
      tab.planDismissed = false;
      break;
    case "final":
      pushTo(tab, { kind: "final", html: renderMd(String(e.content ?? "")) });
      break;
    case "usage":
      pushTo(tab, {
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
      tab.askPending = {
        header: String(e.header ?? "确认"),
        question: String(e.question ?? ""),
        options: Array.isArray(e.options) ? (e.options as string[]) : [],
        is_multi: Boolean(e.is_multi),
      };
      break;
    case "workspace":
      workspace.value = String(e.path ?? "");
      break;
    case "context":
      tab.ctxTokens = Number(e.tokens ?? 0);
      tab.ctxMax = Number(e.max_tokens ?? 0);
      tab.ctxMessages = Number(e.messages ?? 0);
      tab.ctxPct = Number(e.pct ?? 0);
      break;
    case "enhance_result":
      enhancing.value = false;
      if (e.error) {
        pushTo(tab, { kind: "info", content: `增强失败: ${e.error}` });
      } else {
        tab.input = String(e.text ?? "");
        requestAnimationFrame(focusInput);
      }
      break;
    case "external": {
      const content = String(e.content ?? "").trim();
      if (content && !tab.running) {
        pushTo(tab, { kind: "user", content });
        transport?.send({ type: "chat", content, session_id: tab.sessionId });
      }
      break;
    }
  }
  scrollToBottom();
}

// ============================================================
// 生命周期
// ============================================================

onMounted(() => {
  initTransport();
  requestAnimationFrame(focusInput);
});

onUnmounted(() => {
  transport?.close();
});
</script>

<template>
  <div class="app" :class="{ 'is-vscode': isVscode }">
    <!-- 顶部 tab -->
    <header class="tab-bar">
      <div
        v-for="t in tabs"
        :key="t.sessionId"
        class="tab"
        :class="{ active: t.sessionId === activeTabId }"
        @click="switchTab(t.sessionId)"
      >
        <span class="tab-dot" v-if="t.running"></span>
        <span class="tab-title">{{ tabTitle(t) }}</span>
        <span class="tab-close" @click.stop="closeTab(t.sessionId)"><CloseIcon /></span>
      </div>
      <div class="tab tab-add" title="新建会话" @click="newTab">
        <AddIcon />
      </div>
      <div class="tab-actions">
        <button class="settings-btn" title="设置" @click="openSettings"><SettingIcon /></button>
        <span class="conn-status">
          <span class="dot" :class="{ on: connected }" />
          {{ connected ? "已连接" : "连接中..." }}
        </span>
      </div>
    </header>

    <div class="main">
      <!-- 聊天区 -->
      <div class="chat">
        <TChatList
          ref="chatListRef"
          class="chat-list"
          :data="chatData as any"
          layout="both"
          :auto-scroll="true"
          default-scroll-to="bottom"
          :show-scroll-button="true"
        >
          <!-- 空状态 -->
          <template #default>
            <div class="empty-state">
              <div class="empty-avatar">
                <img src="/logo-512.png" alt="VCA Logo" class="logo-img"/>
              </div>
              <div class="empty-name">VCA</div>
              <div class="empty-sub">Virtual Code Agent — 开始一次对话吧</div>
              <div class="empty-tips">
                <div class="empty-tip"><ImageIcon /> 直接粘贴/拖入图片到输入框</div>
                <div class="empty-tip"><EditIcon /> Enter 发送，Shift+Enter 换行</div>
                <div class="empty-tip"><ViewListIcon /> 在编辑器中选中文本，右键发送到 Agent</div>
              </div>
            </div>
          </template>

          <!-- 每条消息头像 -->
          <template #avatar="{ item }">
            <img
              v-if="item.role === 'user'"
              :src="USER_AVATAR"
              class="chat-avatar chat-avatar--user"
              alt=""
            />
            <img
              v-else-if="item.role === 'assistant'"
              :src="ASSISTANT_AVATAR"
              class="chat-avatar chat-avatar--assistant"
              alt=""
            />
          </template>

          <!-- 每条消息自定义渲染 -->
          <template #content="{ item }">
            <MsgBlock :msg="(item as any)?.msg" :vscode="isVscode" @open-file="openFileInEditor" />
          </template>
        </TChatList>

        <!-- 任务清单列表 (在消息区与输入区之间) -->
        <div class="plan-slot" v-if="plan && !planDismissed">
          <PlanList :plan="plan" @close="activeTab && (activeTab.planDismissed = true)" />
        </div>

        <!-- 输入区 -->
        <div class="input-area" @paste="onPaste">
          <div v-if="attachedImages.length" class="attached-images">
            <div v-for="img in attachedImages" :key="img.id" class="thumb">
              <img :src="img.dataUrl" />
              <button class="thumb-remove" @click="removeImage(img.id)" title="移除"><CloseIcon /></button>
            </div>
          </div>

          <div class="input-tools">
            <button class="tool-icon" :class="{ active: running }" @click="running ? cancel() : null" title="任务状态">
              <span :class="running ? 'dot-pulse' : 'dot-idle'"></span>
              <span>{{ running ? "执行中..." : "就绪" }}</span>
            </button>

            <div class="ctx-wrap" v-if="activeTab && activeTab.ctxMax > 0" title="上下文窗口占用 (消息数)">
              <div class="ctx-bar">
                <div class="ctx-fill" :style="{ width: activeTab.ctxPct + '%', background: contextColor(activeTab.ctxPct) }"></div>
              </div>
              <span class="ctx-text" :style="{ color: contextColor(activeTab.ctxPct) }">
                {{ formatTokens(activeTab.ctxTokens) }}/{{ formatTokens(activeTab.ctxMax) }} ({{
                  activeTab.ctxPct
                }}%) · {{ activeTab.ctxMessages }} 条
              </span>
            </div>

            <div class="spacer" />

            <div class="model-picker" title="切换模型">
              <span class="model-picker__icon"><ControlPlatformIcon /></span>
              <TSelect
                v-if="models.length"
                class="model-select"
                :value="model"
                :options="modelOptions as any"
                :disabled="running"
                placeholder="选择模型"
                :borderless="true"
                :popup-props="{ overlayClassName: 'model-popup' }"
                @change="switchModel"
              />
              <span v-else class="model-select--empty">{{ model }}</span>
            </div>
          </div>

          <TChatSender
            v-model="input"
            class="chat-sender"
            placeholder="提问输入/ ⌥快捷命令，Enter 发送 / Shift+Enter 换行"
            :loading="running"
            :textarea-props="{ autosize: { minRows: 1, maxRows: 8 } }"
            @send="onSend"
            @stop="cancel"
          >
            <template #footer-prefix>
              <button class="t-icon" title="用内置提示词增强当前输入" :disabled="enhancing || !input.trim()" @click="enhanceInput">
                <LightbulbIcon :class="{ 'spin-anim': enhancing }" />
              </button>
            </template>

            <template #suffix>
              <div class="sender-actions">
                <button class="sender-icon" title="上传图片" @click="fileInputRef?.click()">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <path d="m21 15-5-5L5 21"/>
                  </svg>
                </button>
                <input ref="fileInputRef" type="file" accept="image/*" multiple style="display:none" @change="onFilePicker" />
                <button v-if="!running" class="sender-send" :disabled="!canSend" title="发送" @click="onSend">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M3 20v-6l8-2-8-2V4l18 8z"/>
                  </svg>
                </button>
                <button v-else class="sender-stop" title="停止" @click="cancel">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <rect x="5" y="5" width="14" height="14" rx="2"/>
                  </svg>
                </button>
              </div>
            </template>
          </TChatSender>
        </div>
      </div>

      <!-- 侧边栏 -->
      <aside class="side">
        <TodoPanel :plan="plan" />
        <div class="panel">
          <h3><FolderIcon class="h3-icon" /> 工作空间</h3>
          <div class="workspace-box">
            <div>{{ workspace || "默认" }}</div>
            <input placeholder="切换目录" @keydown.enter="onWorkspaceChange" />
          </div>
        </div>
        <div class="panel">
          <h3><LinkIcon class="h3-icon" /> 连接</h3>
          <div class="info-line">
            <span class="dot" :class="{ on: connected }" />
            <span>{{ connected ? "已连接" : "连接中..." }}</span>
          </div>
          <div class="info-line dim">{{ tabs.length }} 个会话窗口</div>
        </div>
      </aside>
    </div>

    <!-- AskUser 弹窗 (当前 tab) -->
    <AskUserModal
      v-if="askPending"
      :header="askPending!.header"
      :question="askPending!.question"
      :options="askPending!.options"
      :is-multi="askPending!.is_multi"
      @select="onAskSelect"
      @custom="onAskCustom"
      @skip="onAskSkip"
    />

    <!-- 设置面板 -->
    <SettingsPanel
      v-if="settingsOpen"
      :settings="settingsData as any"
      :busy="settingsBusy"
      @close="closeSettings"
      @save-general="saveGeneralSettings"
      @save-mcp="saveMcpConfig"
      @reconnect-mcp="reconnectMcp"
      @reload-config="reloadConfig"
    />
  </div>
</template>
