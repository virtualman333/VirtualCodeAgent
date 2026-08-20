<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from "vue";
import type { Component } from "vue";
import { ChatList as TChatList, ChatSender as TChatSender } from "@tdesign-vue-next/chat";
import { Select as TSelect } from "tdesign-vue-next";
import {
  AddIcon,
  RobotIcon,
  FolderIcon,
  LinkIcon,
  ThunderIcon,
  BookIcon,
  DesktopIcon,
  CodeIcon,
  PaletteIcon,
  ToolsIcon,
  WebIcon,
  AppIcon,
  LightbulbIcon,
  RefreshIcon,
  FileIcon,
  SearchIcon,
  SettingIcon,
  EllipsisIcon,
  ViewListIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  NotificationIcon,
  PoweroffIcon,
  CloseIcon,
  ControlPlatformIcon,
  LockOnIcon,
} from "tdesign-icons-vue-next";
import MsgBlock from "./MsgBlock.vue";
import AskUserModal from "./AskUserModal.vue";
import SettingsPanel from "./SettingsPanel.vue";
import { useVcaChat } from "../composables/useVcaChat";

const chat = useVcaChat();

const {
  tabs,
  activeTabId,
  activeTab,
  messages,
  input,
  attachedImages,
  running,
  plan,
  askPending,
  connected,
  model,
  models,
  workspace,
  settingsOpen,
  settingsData,
  settingsBusy,
  enhancing,

  newTab,
  switchTab,
  closeTab,
  onSend,
  cancel,
  onFilePicker,
  onPaste,
  removeImage,
  switchModel,
  switchWorkspace,
  enhanceInput,
  openFile,
  openAsk,
  customAsk,
  skipAsk,
  openSettings,
  closeSettings,
  saveGeneralSettings,
  saveMcpConfig,
  reconnectMcp,
  reloadConfig,

  tabTitle,
  initTransport,
  destroy,
} = chat;

const chatListRef = ref<InstanceType<typeof TChatList> | null>(null);
const senderRef = ref<InstanceType<typeof TChatSender> | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const workspaceRef = ref<HTMLInputElement | null>(null);

// ============================================================
// 头像 (light DOM)
// ============================================================
const USER_AVATAR =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="#4c6ef5"/><circle cx="20" cy="15" r="7" fill="#ffffff"/><path d="M6 35c2.5-7.5 8-11 14-11s11.5 3.5 14 11z" fill="#ffffff"/></svg>'
  );
const ASSISTANT_AVATAR = "/logo-512.png";

// ============================================================
// 侧栏导航 (仿截图)
// ============================================================
interface NavItem {
  key: string;
  icon: Component;
  label: string;
  badge?: string;
}
const navItems: NavItem[] = [
  { key: "new", icon: AddIcon, label: "新建任务" },
  { key: "assistant", icon: RobotIcon, label: "助理", badge: "Beta" },
  { key: "project", icon: FolderIcon, label: "项目", badge: "Beta" },
  { key: "expert", icon: LinkIcon, label: "专家·技能·连接器" },
  { key: "automation", icon: ThunderIcon, label: "自动化" },
  { key: "library", icon: BookIcon, label: "资料库" },
];
const activeNav = ref<string>("assistant");

// 历史任务汇总 (从当前 tab 衍生)
const recentSessions = computed(() =>
  tabs.value
    .filter((t) => t.messages.length > 0)
    .slice(-10)
    .reverse()
);
const totalTasks = computed(() => recentSessions.value.length || tabs.value.length);

// ============================================================
// 快捷建议标签 (截图中的日常办公 / 代码开发 / 设计创意)
// ============================================================
const quickPrompts = [
  { label: "日常办公", icon: DesktopIcon, text: "帮我处理一份工作周报草稿" },
  { label: "@代码开发", icon: CodeIcon, text: "@src 重构一下入口文件，提高可读性" },
  { label: "设计创意", icon: PaletteIcon, text: "给我三个产品 logo 创意方案" },
];
const categoryTags = [
  { label: "日常开发", icon: ToolsIcon },
  { label: "网站开发", icon: WebIcon },
  { label: "Agent 应用", icon: AppIcon },
  { label: "Skill 开发", icon: LightbulbIcon },
  { label: "CI/CD", icon: RefreshIcon },
  { label: "文档", icon: FileIcon },
];

function applyQuick(text: string): void {
  if (activeTab.value) {
    activeTab.value.input = text;
    focusInput();
  }
}

// ============================================================
// 输入框焦点
// ============================================================
function focusInput(): void {
  nextTick(() => {
    const el = (senderRef.value as unknown as { $el?: HTMLElement })?.$el;
    const ta = el?.querySelector?.("textarea") as HTMLTextAreaElement | null;
    (ta ?? document.querySelector<HTMLTextAreaElement>(".t-chat-sender textarea"))?.focus();
  });
}

watch(
  () => activeTabId.value,
  () => nextTick(focusInput)
);

// ============================================================
// chatData (TDesign 格式)
// ============================================================
const chatData = computed(() =>
  messages.value.map((m) => {
    if (m.kind === "user") return { role: "user", msg: m, content: [] as unknown[] };
    if (m.kind === "info" || m.kind === "usage") return { role: "system", msg: m, content: [] as unknown[] };
    return { role: "assistant", msg: m, content: [] as unknown[] };
  })
);

const modelOptions = computed(() => models.value.map((m) => ({ label: m.name, value: m.name })));
const canSend = computed(() => Boolean(input.value.trim()) || attachedImages.value.length > 0);

const showChatView = computed(() => messages.value.length > 0);

// ============================================================
// 生命周期
// ============================================================
onMounted(() => {
  initTransport();
  nextTick(focusInput);

  // Electron init 事件
  const w = window as unknown as {
    vca?: {
      onInit(cb: (p: { port: number; platform: string; version: string }) => void): () => void;
    };
  };
  w.vca?.onInit?.(() => {
    // 可以根据 port 显示调试信息, 此处留空
  });
});
onUnmounted(() => {
  destroy();
});

// 退出确认
function onQuit(): void {
  const w = window as unknown as { vca?: { quit(): void } };
  w.vca?.quit();
}
</script>

<template>
  <div class="desktop">
    <!-- ===================== 左侧栏 ===================== -->
    <aside class="sidebar">
      <div class="brand">
        <img src="/logo-512.png" alt="VCA" class="brand-logo" />
        <div class="brand-meta">
          <div class="brand-name">VCA</div>
          <div class="brand-ver">v0.2.0</div>
        </div>
        <button class="icon-btn" title="搜索"><SearchIcon /></button>
        <button class="icon-btn" title="筛选"><SettingIcon /></button>
      </div>

      <nav class="nav">
        <button
          v-for="item in navItems"
          :key="item.key"
          class="nav-item"
          :class="{ active: activeNav === item.key, 'nav-item--add': item.key === 'new' }"
          @click="item.key === 'new' ? newTab() : (activeNav = item.key)"
        >
          <span class="nav-icon"><component :is="item.icon" /></span>
          <span class="nav-label">{{ item.label }}</span>
          <span v-if="item.badge" class="nav-badge">{{ item.badge }}</span>
        </button>

        <div class="nav-item nav-item--more">
          <span class="nav-icon"><EllipsisIcon /></span>
          <span class="nav-label">更多</span>
          <span class="nav-badge">应用 · 灵感</span>
        </div>
      </nav>

      <div class="session-list">
        <div class="session-row">
          <span class="session-icon"><ViewListIcon /></span>
          <span class="session-label">任务 ({{ totalTasks }})</span>
          <span class="session-arrow"><ChevronRightIcon /></span>
        </div>
        <div class="session-row">
          <span class="session-icon"><FolderIcon /></span>
          <span class="session-label">空间 ({{ Math.max(tabs.length, 1) }})</span>
          <span class="session-arrow"><ChevronRightIcon /></span>
        </div>

        <div class="recent-tasks" v-if="recentSessions.length">
          <button
            v-for="t in recentSessions.slice(0, 6)"
            :key="t.sessionId"
            class="recent-task"
            :class="{ active: t.sessionId === activeTabId }"
            @click="switchTab(t.sessionId)"
            :title="tabTitle(t)"
          >
            <span class="recent-dot" :class="{ pulse: t.running }" />
            <span class="recent-text">{{ tabTitle(t) }}</span>
          </button>
        </div>
      </div>

      <div class="user">
        <div class="avatar">Y</div>
        <div class="user-meta">
          <div class="user-name">yongguichen</div>
          <div class="user-plan">企业版</div>
        </div>
        <button class="icon-btn" title="通知"><NotificationIcon /></button>
        <button class="icon-btn quit-btn" title="退出" @click="onQuit"><PoweroffIcon /></button>
      </div>
    </aside>

    <!-- ===================== 主区 ===================== -->
    <main class="main">
      <!-- 顶部 tab + 工具 -->
      <div class="topbar">
        <div class="tabs">
          <div
            v-for="t in tabs"
            :key="t.sessionId"
            class="tab"
            :class="{ active: t.sessionId === activeTabId }"
            @click="switchTab(t.sessionId)"
          >
            <span v-if="t.running" class="tab-dot" />
            <span class="tab-title">{{ tabTitle(t) }}</span>
            <span class="tab-close" @click.stop="closeTab(t.sessionId)"><CloseIcon /></span>
          </div>
          <button class="tab-add" title="新建会话" @click="newTab"><AddIcon /></button>
        </div>
        <div class="topbar-actions">
          <span class="conn-pill">
            <span class="dot" :class="{ on: connected }" />
            {{ connected ? "已连接" : "连接中..." }}
          </span>
          <button class="icon-btn" title="设置" @click="openSettings"><SettingIcon /></button>
        </div>
      </div>

      <!-- 主体内容: 有对话时显示聊天; 否则显示欢迎页 -->
      <div class="stage">
        <!-- 欢迎页 (无消息时) -->
        <div v-if="!showChatView" class="welcome">
          <h1 class="welcome-title">VCA，我帮你</h1>

          <div class="quick-prompts">
            <button
              v-for="q in quickPrompts"
              :key="q.label"
              class="quick-pill"
              :class="{ active: q.label.startsWith('@') }"
              @click="applyQuick(q.text)"
            >
              <span class="quick-icon"><component :is="q.icon" /></span>
              <span>{{ q.label }}</span>
            </button>
          </div>

          <div class="cat-tags">
            <button v-for="c in categoryTags" :key="c.label" class="cat-tag">
              <span><component :is="c.icon" /></span>
              <span>{{ c.label }}</span>
            </button>
            <div class="cat-mascot" />
          </div>

          <!-- 中央输入框 (欢迎页专属) -->
          <div class="center-input">
            <div v-if="attachedImages.length" class="attached-images">
              <div v-for="img in attachedImages" :key="img.id" class="thumb">
                <img :src="img.dataUrl" />
                <button class="thumb-remove" @click="removeImage(img.id)" title="移除"><CloseIcon /></button>
              </div>
            </div>
            <TChatSender
              v-model="input"
              class="chat-sender"
              placeholder="今天帮你做些什么？@引用对话文件，/调用技能与指令"
              :loading="running"
              :textarea-props="{ autosize: { minRows: 2, maxRows: 8 } }"
              @send="onSend"
              @stop="cancel"
            >
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
                  <div class="model-pill-inline" v-if="model !== '—'">
                    <span><ControlPlatformIcon /></span>
                    <span>{{ model }}</span>
                  </div>
                  <button v-if="!running" class="sender-avatar" :disabled="!canSend" title="发送" @click="onSend">
                    <span>A</span>
                  </button>
                  <button v-else class="sender-stop" title="停止" @click="cancel">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                      <rect x="5" y="5" width="14" height="14" rx="2"/>
                    </svg>
                  </button>
                </div>
              </template>
            </TChatSender>

            <div class="bottom-bar">
              <button class="picker">
                <span><FolderIcon /></span>
                <span>{{ workspace || "选择工作空间" }}</span>
                <span class="caret"><ChevronDownIcon /></span>
              </button>
              <button class="picker">
                <span><LockOnIcon /></span>
                <span>默认权限</span>
                <span class="caret"><ChevronDownIcon /></span>
              </button>
            </div>
          </div>
        </div>

        <!-- 聊天视图 -->
        <div v-else class="chat-view">
          <TChatList
            ref="chatListRef"
            class="chat-list"
            :data="chatData as any"
            layout="both"
            :auto-scroll="true"
            default-scroll-to="bottom"
            :show-scroll-button="true"
          >
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
            <template #content="{ item }">
              <MsgBlock
                :msg="(item as any)?.msg"
                :vscode="false"
                @open-file="(p: string, l?: number) => openFile(p, l)"
              />
            </template>
          </TChatList>

          <div class="input-dock" @paste="onPaste">
            <div v-if="attachedImages.length" class="attached-images">
              <div v-for="img in attachedImages" :key="img.id" class="thumb">
                <img :src="img.dataUrl" />
                <button class="thumb-remove" @click="removeImage(img.id)" title="移除"><CloseIcon /></button>
              </div>
            </div>

            <div class="dock-toolbar">
              <button class="t-icon" :disabled="enhancing || !input.trim()" @click="enhanceInput">
                <LightbulbIcon :class="{ 'spin-anim': enhancing }" />
              </button>
              <div class="model-picker" v-if="models.length">
                <span><ControlPlatformIcon /></span>
                <TSelect
                  class="model-select"
                  :value="model"
                  :options="modelOptions as any"
                  :disabled="running"
                  :borderless="true"
                  @change="switchModel"
                />
              </div>
              <div class="spacer" />
              <span class="ctx-text" v-if="activeTab && activeTab.ctxMax">
                {{ activeTab.ctxTokens }}/{{ activeTab.ctxMax }} · {{ activeTab.ctxMessages }} 条
              </span>
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
                  <button v-if="!running" class="sender-avatar" :disabled="!canSend" title="发送" @click="onSend">
                    <span>A</span>
                  </button>
                  <button v-else class="sender-stop" title="停止" @click="cancel">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                      <rect x="5" y="5" width="14" height="14" rx="2"/>
                    </svg>
                  </button>
                </div>
              </template>
            </TChatSender>

            <div class="bottom-bar">
              <button class="picker" @click="workspaceRef?.focus()">
                <span><FolderIcon /></span>
                <span>{{ workspace || "选择工作空间" }}</span>
                <span class="caret"><ChevronDownIcon /></span>
              </button>
              <button class="picker">
                <span><LockOnIcon /></span>
                <span>默认权限</span>
                <span class="caret"><ChevronDownIcon /></span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>

    <AskUserModal
      v-if="askPending"
      :header="askPending!.header"
      :question="askPending!.question"
      :options="askPending!.options"
      :is-multi="askPending!.is_multi"
      @select="openAsk"
      @custom="customAsk"
      @skip="skipAsk"
    />

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

<style scoped>
.desktop {
  display: flex;
  height: 100vh;
  width: 100vw;
  background: #ffffff;
  color: var(--text);
  overflow: hidden;
  font-size: 13px;
}

/* ============================================================
   Sidebar (240px)
   ============================================================ */
.sidebar {
  width: 240px;
  flex-shrink: 0;
  background: #f7f8fa;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 14px 10px 12px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 6px;
  margin-bottom: 14px;
}
.brand-logo {
  width: 22px;
  height: 22px;
  border-radius: 6px;
}
.brand-meta {
  flex: 1;
  line-height: 1.1;
}
.brand-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}
.brand-ver {
  font-size: 10px;
  color: var(--text-dim);
  margin-top: 2px;
}
.icon-btn {
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-2);
  font-size: 13px;
}
.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 14px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  width: 100%;
  font-size: 13px;
  color: var(--text);
}
.nav-item:hover {
  background: var(--bg-hover);
}
.nav-item.active {
  background: rgba(76, 110, 245, 0.10);
  color: var(--accent);
  font-weight: 600;
}
.nav-item--add {
  background: var(--accent);
  color: #fff;
}
.nav-item--add:hover {
  background: var(--accent-2);
}
.nav-icon {
  width: 18px;
  text-align: center;
}
.nav-label {
  flex: 1;
}
.nav-badge {
  font-size: 10px;
  color: var(--text-dim);
  background: var(--bg-hover);
  padding: 1px 6px;
  border-radius: 4px;
}
.nav-item--more {
  color: var(--text-dim);
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 4px;
  margin: 0 -4px;
}
.session-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  border-radius: 6px;
}
.session-row:hover {
  background: var(--bg-hover);
}
.session-icon {
  width: 18px;
  text-align: center;
}
.session-label {
  flex: 1;
  font-size: 12px;
  color: var(--text-2);
}
.session-arrow {
  color: var(--text-dim);
}

.recent-tasks {
  margin-top: 4px;
  padding: 0 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.recent-task {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
  color: var(--text-2);
  width: 100%;
}
.recent-task:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.recent-task.active {
  background: var(--bg-active);
  color: var(--accent);
}
.recent-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-dim);
  flex-shrink: 0;
}
.recent-dot.pulse {
  background: var(--accent);
  animation: pulse 1.4s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.7); }
}
.recent-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 6px;
  border-top: 1px solid var(--border);
  margin-top: 8px;
}
.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 12px;
}
.user-meta {
  flex: 1;
  line-height: 1.2;
}
.user-name {
  font-size: 12px;
  font-weight: 600;
}
.user-plan {
  font-size: 10px;
  color: var(--text-dim);
}
.quit-btn {
  color: var(--red);
}

/* ============================================================
   Main
   ============================================================ */
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #fff;
}
.topbar {
  display: flex;
  align-items: center;
  height: 40px;
  border-bottom: 1px solid var(--border);
  padding: 0 12px;
  gap: 12px;
}
.tabs {
  flex: 1;
  display: flex;
  gap: 2px;
  overflow-x: auto;
  align-items: center;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  background: var(--bg-hover);
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
  border: 1px solid transparent;
  max-width: 180px;
  min-width: 100px;
  white-space: nowrap;
}
.tab:hover {
  background: var(--bg-active);
}
.tab.active {
  background: #fff;
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1.4s infinite;
}
.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.tab-close {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  text-align: center;
  font-size: 14px;
  color: var(--text-dim);
}
.tab-close:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.tab-add {
  width: 26px;
  height: 26px;
  border: 1px dashed var(--border);
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  color: var(--text-dim);
}
.tab-add:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.topbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.conn-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-dim);
  padding: 3px 10px;
  border-radius: 8px;
  background: var(--bg-hover);
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-dim);
}
.dot.on {
  background: var(--green);
}

/* ============================================================
   Stage (Welcome / Chat)
   ============================================================ */
.stage {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ---------- 欢迎页 ---------- */
.welcome {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px 20px;
  gap: 18px;
  overflow-y: auto;
}
.welcome-title {
  font-size: 32px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: 0.5px;
}
.quick-prompts {
  display: flex;
  gap: 10px;
}
.quick-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  border-radius: 18px;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-2);
}
.quick-pill:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.quick-pill.active {
  border-color: var(--accent);
  background: var(--bg-active);
  color: var(--accent);
}
.quick-icon {
  font-size: 14px;
}
.cat-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  max-width: 720px;
  align-items: center;
}
.cat-tag {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  border-radius: 16px;
  font-size: 12px;
  cursor: pointer;
  color: var(--text);
}
.cat-tag:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.cat-mascot {
  width: 80px;
  height: 50px;
  background: url("/mascot.svg") center/contain no-repeat;
  margin-left: 12px;
  filter: drop-shadow(0 4px 8px rgba(0,0,0,0.06));
  font-size: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 中央输入框 (欢迎页) */
.center-input {
  width: min(720px, 92vw);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: 0 6px 24px rgba(15, 22, 50, 0.04);
  padding: 12px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.center-input :deep(.t-chat-sender) {
  padding: 0;
}
.center-input :deep(.t-chat-sender__textarea) {
  border: none;
  border-radius: 12px;
}
.center-input :deep(.t-chat-sender .t-textarea .t-textarea__inner) {
  font-size: 14px;
  min-height: 50px;
}

.bottom-bar {
  display: flex;
  gap: 8px;
  padding-top: 4px;
}
.picker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  border-radius: 14px;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-2);
}
.picker:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.caret {
  font-size: 10px;
  color: var(--text-dim);
}

/* ---------- 聊天视图 ---------- */
.chat-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.chat-view .chat-list {
  flex: 1;
  min-height: 0;
  padding: 16px 28px;
}
.chat-avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  object-fit: cover;
  display: block;
  flex: 0 0 auto;
}
.chat-avatar--assistant {
  border: 1px solid var(--border);
}
.chat-avatar--user {
  border: 1px solid var(--accent);
}

.input-dock {
  border-top: 1px solid var(--border);
  padding: 10px 28px 14px;
  background: var(--bg-panel);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dock-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.spacer { flex: 1; }
.t-icon {
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
}
.t-icon:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}
.t-icon:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.spin-anim {
  display: inline-block;
  animation: spin 1.4s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.ctx-text {
  font-size: 11px;
  color: var(--text-dim);
}

.model-picker {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0 8px;
  height: 28px;
}
.model-picker .model-select :deep(.t-input) {
  height: 26px;
}
.model-picker .model-select :deep(.t-input__inner) {
  font-size: 12px;
}

.model-pill-inline {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  background: var(--bg-hover);
  border-radius: 12px;
  font-size: 11px;
  color: var(--text-2);
}

/* 发送按钮 (圆形头像风, 仿截图 A 圆形) */
.sender-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sender-icon {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: 6px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.sender-icon:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.sender-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: linear-gradient(135deg, #4c6ef5, #7950f2);
  color: #fff;
  font-weight: 700;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(76, 110, 245, 0.3);
}
.sender-avatar:disabled {
  background: var(--bg-hover);
  color: var(--text-dim);
  cursor: not-allowed;
  box-shadow: none;
}
.sender-stop {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--red);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.attached-images {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.thumb {
  position: relative;
  width: 60px;
  height: 60px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border: none;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  border-radius: 50%;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
</style>