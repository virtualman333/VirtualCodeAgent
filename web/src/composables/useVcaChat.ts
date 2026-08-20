/**
 * 会话状态机 composable - 供 App.vue (web/vscode) 与 DesktopApp.vue 共享
 *
 * 负责:
 *  - 与后端 ws / vscode 传输层对接
 *  - 多 Tab 会话管理 (创建/关闭/切换)
 *  - 消息 (用户/助手/工具/思考/最终) 流
 *  - 模型/工作空间/上下文/计划/设置 等全局状态
 *  - ask_user 弹窗、token 用量、enhance 等交互
 */
import { ref, computed, nextTick } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  createVscodeTransport,
  createWsTransport,
  isVscodeEnv,
  isElectronEnv,
  openFileInExternalEditor,
  type Transport,
  type ServerEvent,
} from "../transport";

export interface AttachedImage {
  id: string;
  dataUrl: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  running: boolean;
}

export interface UsageInfo {
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
  images?: AttachedImage[];
  tool?: ToolCallInfo;
  html?: string;
  usage?: UsageInfo;
}

export interface AskPending {
  header: string;
  question: string;
  options: string[];
  is_multi: boolean;
}

export interface ModelOption {
  name: string;
  model: string;
  base_url?: string;
}

export interface ChatTab {
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

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function useVcaChat(): {
  // state (readonly refs)
  tabs: ReturnType<typeof ref<ChatTab[]>>;
  activeTabId: ReturnType<typeof ref<string>>;
  activeTab: ReturnType<typeof computed<ChatTab | null>>;
  messages: ReturnType<typeof computed<Msg[]>>;
  input: ReturnType<typeof computed<string>>;
  attachedImages: ReturnType<typeof computed<AttachedImage[]>>;
  running: ReturnType<typeof computed<boolean>>;
  plan: ReturnType<typeof computed<string>>;
  askPending: ReturnType<typeof computed<AskPending | null>>;
  connected: ReturnType<typeof ref<boolean>>;
  model: ReturnType<typeof ref<string>>;
  models: ReturnType<typeof ref<ModelOption[]>>;
  workspace: ReturnType<typeof ref<string>>;
  settingsOpen: ReturnType<typeof ref<boolean>>;
  settingsData: ReturnType<typeof ref<unknown>>;
  settingsBusy: ReturnType<typeof ref<boolean>>;
  enhancing: ReturnType<typeof ref<boolean>>;

  // actions
  newTab: () => void;
  switchTab: (id: string) => void;
  closeTab: (id: string) => void;
  setInput: (v: string) => void;
  onSend: () => Promise<void> | void;
  cancel: () => void;
  onFilePicker: (ev: Event) => void;
  onPaste: (ev: ClipboardEvent) => void;
  removeImage: (id: string) => void;
  switchModel: (value: unknown) => void;
  switchWorkspace: (path: string) => void;
  enhanceInput: () => void;
  openFile: (path: string, line?: number) => void;
  openAsk: (v: string) => void;
  customAsk: (v: string) => void;
  skipAsk: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  saveGeneralSettings: (updates: Record<string, unknown>) => void;
  saveMcpConfig: (servers: unknown[]) => void;
  reconnectMcp: () => void;
  reloadConfig: () => void;

  // helpers
  tabTitle: (tab: ChatTab) => string;
  scrollToBottom: () => void;
  initTransport: () => void;
  destroy: () => void;
  isVscode: boolean;
  isElectron: boolean;
} {
  const tabs = ref<ChatTab[]>([]);
  const activeTabId = ref("");
  const connected = ref(false);
  const model = ref("—");
  const models = ref<ModelOption[]>([]);
  const workspace = ref("");
  const settingsOpen = ref(false);
  const settingsData = ref<unknown>(null);
  const settingsBusy = ref(false);
  const enhancing = ref(false);

  const activeTab = computed<ChatTab | null>(
    () => tabs.value.find((t) => t.sessionId === activeTabId.value) ?? null
  );
  const messages = computed(() => activeTab.value?.messages ?? []);
  const input = computed({
    get: () => activeTab.value?.input ?? "",
    set: (v: string) => {
      if (activeTab.value) activeTab.value.input = v;
    },
  });
  const attachedImages = computed(() => activeTab.value?.attachedImages ?? []);
  const running = computed(() => activeTab.value?.running ?? false);
  const plan = computed(() => activeTab.value?.plan ?? "");
  const askPending = computed(() => activeTab.value?.askPending ?? null);

  let transport: Transport | null = null;
  let msgSeq = 0;
  let imgSeq = 0;
  const toolById = new Map<string, ToolCallInfo>();
  const isVscode = isVscodeEnv();
  const isElectron = isElectronEnv();

  // ============================================================
  // Tab CRUD
  // ============================================================

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
  function newTab(): void {
    createTab();
    transport?.send({ type: "new_session" });
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
    if (activeTabId.value === id) {
      const next = tabs.value[Math.min(idx, tabs.value.length - 1)];
      if (next) activeTabId.value = next.sessionId;
      else createTab();
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
  // 输入与发送
  // ============================================================

  function setInput(v: string): void {
    if (activeTab.value) activeTab.value.input = v;
  }
  function scrollToBottom(): void {
    nextTick(() => {
      const el = document.querySelector<HTMLElement>(".chat-list");
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
  function pushTo(tab: ChatTab, m: Omit<Msg, "id">): void {
    tab.messages.push({ ...m, id: ++msgSeq } as Msg);
    scrollToBottom();
  }
  function renderMd(text: string): string {
    return DOMPurify.sanitize(marked.parse(text) as string);
  }
  async function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
  async function processFile(file: File): Promise<AttachedImage | null> {
    if (!file.type.startsWith("image/")) return null;
    if (file.size > MAX_IMAGE_BYTES) {
      if (activeTab.value) {
        pushTo(activeTab.value, {
          kind: "info",
          content: `图片过大 (>${MAX_IMAGE_BYTES / 1024 / 1024}MB): ${file.name}`,
        });
      }
      return null;
    }
    return { id: `img_${++imgSeq}`, dataUrl: await readAsDataUrl(file) };
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
  function onFilePicker(ev: Event): void {
    const files = (ev.target as HTMLInputElement).files;
    if (!files) return;
    void handlePastedFiles(Array.from(files));
    (ev.target as HTMLInputElement).value = "";
  }
  function removeImage(id: string): void {
    const tab = activeTab.value;
    if (tab) tab.attachedImages = tab.attachedImages.filter((i) => i.id !== id);
  }
  function getInputDisplayText(): string {
    const tab = activeTab.value;
    if (!tab) return "";
    const placeholders = tab.attachedImages.map((_, i) => `[图片${i + 1}]`);
    if (placeholders.length === 0) return tab.input;
    if (tab.input.includes("[图片1]")) return tab.input;
    return tab.input ? `${tab.input} ${placeholders.join(" ")}` : placeholders.join(" ");
  }
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
  }
  function cancel(): void {
    const tab = activeTab.value;
    if (!tab) return;
    transport?.send({ type: "cancel", session_id: tab.sessionId });
  }

  // ============================================================
  // 模型 / 工作空间 / 增强 / 文件
  // ============================================================

  function switchModel(value: unknown): void {
    const tab = activeTab.value;
    if (!tab) return;
    const name = String(value ?? "");
    if (!name || name === model.value) return;
    transport?.send({ type: "set_model", name, session_id: tab.sessionId });
  }
  function switchWorkspace(path: string): void {
    const tab = activeTab.value;
    if (!tab) return;
    if (!path.trim()) return;
    transport?.send({ type: "workspace", path: path.trim(), session_id: tab.sessionId });
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
  function openFile(filePath: string, line?: number): void {
    const sendWs = (p: Record<string, unknown>): void => transport?.send(p);
    void openFileInExternalEditor(filePath, line, sendWs);
  }

  // ============================================================
  // ask_user
  // ============================================================

  function openAsk(v: string): void {
    const tab = activeTab.value;
    if (!tab) return;
    tab.askPending = null;
    transport?.send({ type: "answer_option", content: v, session_id: tab.sessionId });
  }
  function customAsk(v: string): void {
    const tab = activeTab.value;
    if (!tab) return;
    tab.askPending = null;
    transport?.send({ type: "answer", content: v, session_id: tab.sessionId });
  }
  function skipAsk(): void {
    const tab = activeTab.value;
    if (!tab) return;
    tab.askPending = null;
    transport?.send({ type: "skip_question", session_id: tab.sessionId });
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
  // 事件分发
  // ============================================================

  function handleEvent(e: ServerEvent): void {
    const sid = String(e.sessionId ?? "");
    switch (e.type) {
      case "session_id": {
        const first = tabs.value[0];
        if (first) first.sessionId = String(e.id ?? first.sessionId);
        activeTabId.value = first?.sessionId ?? "";
        return;
      }
      case "session_created": {
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

    let tab: ChatTab | null = sid ? findTab(sid) : null;
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
          pushTo(tabForInfo, {
            kind: "info",
            content: e.ok ? "配置已重新加载" : `重载失败: ${String(e.error ?? "")}`,
          });
        } else if (e.ok) {
          pushTo(tabForInfo, {
            kind: "info",
            content: `设置已保存 (${String(e.section ?? "")})`,
          });
        } else {
          pushTo(tabForInfo, {
            kind: "info",
            content: `保存失败: ${String(e.error ?? "")}`,
          });
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
  // 传输初始化
  // ============================================================

  function initTransport(): void {
    if (isVscode) {
      transport = createVscodeTransport(handleEvent);
      connected.value = true;
      createTab();
      nextTick(() => {
        transport?.send({ type: "init" });
      });
      return;
    }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/ws`;
    transport = createWsTransport(url, handleEvent, (c) => {
      connected.value = c;
      if (c && tabs.value.length === 0) createTab();
      else if (!c) for (const t of tabs.value) t.running = false;
    });
  }

  function destroy(): void {
    transport?.close();
    transport = null;
  }

  return {
    // state
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

    // actions
    newTab,
    switchTab,
    closeTab,
    setInput,
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

    // helpers
    tabTitle,
    scrollToBottom,
    initTransport,
    destroy,
    isVscode,
    isElectron,
  };
}