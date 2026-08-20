<script setup lang="ts">
import { ref, reactive, computed, watch } from "vue";
import {
  Dialog as TDialog,
  Tabs as TTabs,
  TabPanel as TTabPanel,
  Input as TInput,
  InputNumber as TInputNumber,
  Button as TButton,
  Select as TSelect,
  Option as TOption,
} from "tdesign-vue-next";
import { SettingIcon, DeleteIcon, AddIcon } from "tdesign-icons-vue-next";

// ============================================================
// 类型 (与后端 settings.ts 对齐)
// ============================================================

interface GeneralSettings {
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL: string;
  OPENAI_MODEL: string;
  DEFAULT_MODEL: string;
  WORKSPACE_DIR: string;
  MAX_TOOL_ITERATIONS: number;
  MAX_CONTEXT_TOKENS: number;
  config_file: string;
}

interface SkillInfo {
  name: string;
  description: string;
  body: string;
  path: string;
  source: string;
}

interface McpServerView {
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  argsText?: string;
  url?: string;
}

interface McpSettings {
  servers: McpServerView[];
  status: Record<string, string>;
  config_file: string;
}

interface SettingsView {
  general: GeneralSettings;
  skills: SkillInfo[];
  mcp: McpSettings;
}

const props = defineProps<{
  settings: SettingsView | null;
  busy: boolean;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "save-general", updates: Record<string, unknown>): void;
  (e: "save-mcp", servers: McpServerView[]): void;
  (e: "reconnect-mcp"): void;
  (e: "reload-config"): void;
}>();

const activeSection = ref<"general" | "skills" | "mcp">("general");

// ---- 通用配置表单 ----
const generalForm = reactive<GeneralSettings>({
  OPENAI_API_KEY: "",
  OPENAI_BASE_URL: "",
  OPENAI_MODEL: "",
  DEFAULT_MODEL: "",
  WORKSPACE_DIR: "",
  MAX_TOOL_ITERATIONS: 10,
  MAX_CONTEXT_TOKENS: 100000,
  config_file: "",
});

watch(
  () => props.settings,
  (s) => {
    if (s) Object.assign(generalForm, s.general);
  },
  { immediate: true }
);

function saveGeneral(): void {
  emit("save-general", {
    OPENAI_API_KEY: generalForm.OPENAI_API_KEY,
    OPENAI_BASE_URL: generalForm.OPENAI_BASE_URL,
    OPENAI_MODEL: generalForm.OPENAI_MODEL,
    DEFAULT_MODEL: generalForm.DEFAULT_MODEL,
    WORKSPACE_DIR: generalForm.WORKSPACE_DIR,
    MAX_TOOL_ITERATIONS: Number(generalForm.MAX_TOOL_ITERATIONS),
    MAX_CONTEXT_TOKENS: Number(generalForm.MAX_CONTEXT_TOKENS),
  });
}

// ---- MCP 编辑 ----
const mcpServers = ref<McpServerView[]>([]);
watch(
  () => props.settings?.mcp,
  (m) => {
    if (m) {
      mcpServers.value = m.servers.map((s) => ({
        ...s,
        args: [...(s.args ?? [])],
        argsText: (s.args ?? []).join(" "),
      }));
    }
  },
  { immediate: true }
);

function addMcpServer(): void {
  mcpServers.value.push({ name: "", transport: "stdio", command: "", args: [], argsText: "" });
}
function removeMcpServer(idx: number): void {
  mcpServers.value.splice(idx, 1);
}
function saveMcp(): void {
  const cleaned = mcpServers.value.map((s) => {
    const { argsText, ...rest } = s;
    const args = (argsText ?? "")
      .split(/\s+/)
      .map((a) => a.trim())
      .filter(Boolean);
    return { ...rest, args };
  });
  emit("save-mcp", cleaned);
}

// ---- Skills 详情 ----
const skillDetail = ref<SkillInfo | null>(null);
function showSkill(s: SkillInfo): void {
  skillDetail.value = s;
}

const skillsCount = computed(() => props.settings?.skills.length ?? 0);
</script>

<template>
  <TDialog
    :visible="true"
    width="760px"
    :footer="false"
    destroy-on-close
    @close="emit('close')"
    @overlay-click="emit('close')"
  >
    <template #header>
      <span class="dialog-header"><SettingIcon /> 设置</span>
    </template>
    <TTabs v-model="activeSection" placement="left" class="settings-tabs">
      <!-- 通用 -->
      <TTabPanel value="general" label="通用">
        <div class="section">
          <div class="field">
            <label>OPENAI_API_KEY</label>
            <TInput
              v-model="generalForm.OPENAI_API_KEY"
              type="password"
              placeholder="sk-..."
              autocomplete="off"
            />
          </div>
          <div class="field">
            <label>OPENAI_BASE_URL</label>
            <TInput v-model="generalForm.OPENAI_BASE_URL" placeholder="https://api.openai.com/v1" />
          </div>
          <div class="field">
            <label>OPENAI_MODEL (默认模型)</label>
            <TInput v-model="generalForm.OPENAI_MODEL" placeholder="gpt-4o-mini" />
          </div>
          <div class="field">
            <label>DEFAULT_MODEL (MODELS 中的名称)</label>
            <TInput v-model="generalForm.DEFAULT_MODEL" placeholder="gpt-4o-mini" />
          </div>
          <div class="field">
            <label>WORKSPACE_DIR (默认工作空间)</label>
            <TInput v-model="generalForm.WORKSPACE_DIR" placeholder="~/.vca/workspace" />
          </div>
          <div class="field-row">
            <div class="field">
              <label>MAX_TOOL_ITERATIONS</label>
              <TInputNumber
                v-model="generalForm.MAX_TOOL_ITERATIONS"
                :min="1"
                theme="column"
                style="width: 100%"
              />
            </div>
            <div class="field">
              <label>MAX_CONTEXT_TOKENS</label>
              <TInputNumber
                v-model="generalForm.MAX_CONTEXT_TOKENS"
                :min="1000"
                :step="1000"
                theme="column"
                style="width: 100%"
              />
            </div>
          </div>
          <div class="hint">配置文件: {{ generalForm.config_file || "~/.vca/config.json" }}</div>
          <div class="actions">
            <TButton variant="outline" :disabled="busy" @click="emit('reload-config')">重载配置</TButton>
            <TButton theme="primary" :loading="busy" @click="saveGeneral">保存</TButton>
          </div>
        </div>
      </TTabPanel>

      <!-- Skills -->
      <TTabPanel value="skills" :label="`Skills (${skillsCount})`">
        <div class="section">
          <div class="hint" style="margin-bottom: 10px">
            技能目录: ~/.vca/skills/、项目 .vca/skills/、项目 skills/
          </div>
          <div v-if="!settings || settings.skills.length === 0" class="empty">暂无 Skills</div>
          <div v-else class="skill-list">
            <div
              v-for="s in settings.skills"
              :key="s.name"
              class="skill-item"
              :class="{ open: skillDetail?.name === s.name }"
              @click="showSkill(s)"
            >
              <div class="skill-head">
                <span class="skill-name">{{ s.name }}</span>
                <span class="skill-desc">{{ s.description }}</span>
              </div>
              <div v-if="skillDetail?.name === s.name" class="skill-body">
                <pre>{{ skillDetail.body }}</pre>
                <div class="hint">路径: {{ skillDetail.path }}</div>
              </div>
            </div>
          </div>
        </div>
      </TTabPanel>

      <!-- MCP -->
      <TTabPanel value="mcp" label="MCP">
        <div class="section">
          <div class="hint" style="margin-bottom: 10px">
            配置保存到项目 .vca/mcp.json（重启后生效，也可点"重连"立即生效）
          </div>

          <div v-if="settings && Object.keys(settings.mcp.status).length" class="mcp-status">
            <div
              v-for="(st, name) in settings.mcp.status"
              :key="name"
              class="status-line"
              :class="st.startsWith('ok') ? 'ok' : 'err'"
            >
              <span class="s-name">{{ name }}</span>
              <span class="s-text">{{ st }}</span>
            </div>
          </div>

          <div class="mcp-list">
            <div v-for="(s, i) in mcpServers" :key="i" class="mcp-server">
              <div class="mcp-row">
                <TInput v-model="s.name" placeholder="server 名称" class="srv-name" />
                <TSelect v-model="s.transport" style="width: 100px; flex-shrink: 0">
                  <TOption value="stdio" label="stdio" />
                  <TOption value="http" label="http" />
                </TSelect>
                <TButton variant="text" theme="danger" title="删除" @click="removeMcpServer(i)"><DeleteIcon /></TButton>
              </div>
              <div class="mcp-row" v-if="s.transport === 'stdio'">
                <TInput v-model="s.command" placeholder="command，如 npx" />
                <TInput v-model="s.argsText" placeholder="args，空格分隔" />
              </div>
              <div class="mcp-row" v-else>
                <TInput v-model="s.url" placeholder="http://localhost:8000/mcp" />
              </div>
            </div>
          </div>

          <div class="actions">
            <TButton variant="outline" @click="addMcpServer"><AddIcon /> 添加 Server</TButton>
            <TButton variant="outline" :disabled="busy" @click="emit('reconnect-mcp')">重连</TButton>
            <TButton theme="primary" :loading="busy" @click="saveMcp">保存</TButton>
          </div>
        </div>
      </TTabPanel>
    </TTabs>
  </TDialog>
</template>

<style scoped>
.dialog-header {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}
.settings-tabs {
  height: 62vh;
  max-height: 520px;
}
.settings-tabs :deep(.t-tabs__content) {
  overflow-y: auto;
  padding-right: 6px;
}
.section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-row {
  display: flex;
  gap: 14px;
}
.field-row .field {
  flex: 1;
}
label {
  font-size: 12px;
  color: var(--text-2);
  font-weight: 500;
}
.hint {
  font-size: 11px;
  color: var(--text-dim);
}
.empty {
  padding: 24px;
  text-align: center;
  color: var(--text-dim);
  font-size: 13px;
  background: var(--bg-hover);
  border-radius: 8px;
}
.actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 6px;
}
/* skills */
.skill-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.skill-item {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.skill-item.open {
  border-color: var(--accent);
}
.skill-head {
  padding: 9px 12px;
  display: flex;
  gap: 10px;
  align-items: baseline;
  cursor: pointer;
}
.skill-head:hover {
  background: var(--bg-hover);
}
.skill-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--accent-2);
  flex-shrink: 0;
}
.skill-desc {
  font-size: 12px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skill-body {
  border-top: 1px solid var(--border);
  padding: 10px 12px;
  background: var(--bg-hover);
}
.skill-body pre {
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-2);
  font-family: "Cascadia Code", Consolas, monospace;
  max-height: 220px;
  overflow-y: auto;
}
/* mcp */
.mcp-status {
  background: var(--bg-hover);
  border-radius: 8px;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.status-line {
  display: flex;
  gap: 10px;
  font-size: 12px;
  align-items: center;
}
.status-line .s-name {
  font-weight: 600;
  flex-shrink: 0;
}
.status-line.ok .s-name {
  color: var(--green);
}
.status-line.err .s-name {
  color: var(--red);
}
.status-line .s-text {
  color: var(--text-dim);
  word-break: break-all;
}
.mcp-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mcp-server {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mcp-row {
  display: flex;
  gap: 6px;
}
.mcp-row .srv-name {
  flex: 1;
}
</style>
