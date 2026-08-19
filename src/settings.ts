/**
 * 设置模块 - 统一提供设置面板所需的数据与操作
 *
 * 覆盖三块:
 * 1. 通用配置 (config.json): API Key / Base URL / 模型 / 迭代上限 / 上下文上限
 * 2. Skills 列表 (发现 + 查看 SKILL.md)
 * 3. MCP 配置 (mcp.json 读写 + 连接状态 + 重连)
 */
import fs from "node:fs";
import path from "node:path";

import {
  Config,
  CONFIG_FILE,
  EDITABLE_KEYS,
  MCP_CONFIG_FILE,
  type VcaConfig,
} from "./config.js";
import { getAllSkills, getSkill } from "./skills/manager.js";
import { mcpManager } from "./mcp/manager.js";
import { getWorkspace } from "./workspace_ctx.js";

// ============================================================
// 通用配置
// ============================================================

export interface GeneralSettings {
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL: string;
  OPENAI_MODEL: string;
  DEFAULT_MODEL: string;
  WORKSPACE_DIR: string;
  MAX_TOOL_ITERATIONS: number;
  MAX_CONTEXT_TOKENS: number;
  config_file: string;
}

export function getGeneralSettings(): GeneralSettings {
  const v = Config.value;
  return {
    OPENAI_API_KEY: String(v.OPENAI_API_KEY ?? ""),
    OPENAI_BASE_URL: String(v.OPENAI_BASE_URL ?? ""),
    OPENAI_MODEL: String(v.OPENAI_MODEL ?? ""),
    DEFAULT_MODEL: String(v.DEFAULT_MODEL ?? v.OPENAI_MODEL ?? ""),
    WORKSPACE_DIR: String(v.WORKSPACE_DIR ?? ""),
    MAX_TOOL_ITERATIONS: Number(v.MAX_TOOL_ITERATIONS ?? 10),
    MAX_CONTEXT_TOKENS: Number(v.MAX_CONTEXT_TOKENS ?? 100000),
    config_file: CONFIG_FILE,
  };
}

/** 保存通用配置。返回 { ok, error? }。API Key 允许为空 (将回退到各模型自身 key) */
export function saveGeneralSettings(updates: Record<string, unknown>): { ok: boolean; error?: string } {
  const v: VcaConfig = { ...Config.value };
  for (const [key, value] of Object.entries(updates)) {
    if (!EDITABLE_KEYS.has(key)) {
      return { ok: false, error: `无效配置项: ${key}` };
    }
    if (key === "MAX_TOOL_ITERATIONS" || key === "MAX_CONTEXT_TOKENS") {
      const n = Number(value);
      if (isNaN(n) || n <= 0) return { ok: false, error: `${key} 需要正整数` };
      v[key] = n;
    } else if (typeof value === "string") {
      v[key] = value.trim();
    } else {
      return { ok: false, error: `${key} 需要字符串值` };
    }
  }
  // 若 MODELS 存在且其内未显式给 key，更新默认 key 供继承
  if (updates.OPENAI_API_KEY !== undefined && Array.isArray(v.MODELS)) {
    v.MODELS = v.MODELS.map((m) => ({
      ...m,
      api_key: m.api_key || String(updates.OPENAI_API_KEY ?? ""),
    }));
  }
  try {
    Config.setAll(v);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 重新从磁盘加载 config.json (手改配置文件后调用，无需重启进程) */
export function reloadConfig(): { ok: boolean; error?: string } {
  try {
    Config.reload();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ============================================================
// Skills
// ============================================================

export interface SkillInfo {
  name: string;
  description: string;
  body: string;
  path: string;
  source: string;
}

export function getSkillsInfo(): SkillInfo[] {
  return getAllSkills().map((s) => ({
    name: s.name,
    description: s.description,
    body: s.body,
    path: s.path,
    source: s.source,
  }));
}

export function getSkillDetail(name: string): SkillInfo | null {
  const s = getSkill(name);
  if (!s) return null;
  return { name: s.name, description: s.description, body: s.body, path: s.path, source: s.source };
}

// ============================================================
// MCP
// ============================================================

export interface McpServerConfigView {
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
}

export interface McpSettingsView {
  servers: McpServerConfigView[];
  status: Record<string, string>;
  config_file: string;
}

/** 读取 mcp 配置 (不含密钥等敏感字段的展示) */
export function getMcpSettings(): McpSettingsView {
  const config = mcpManager.loadConfig();
  const servers = config.map((s) => ({
    name: s.name,
    transport: s.config.transport ?? "stdio",
    command: s.config.command,
    args: s.config.args,
    url: s.config.url,
  }));
  return {
    servers,
    status: Object.fromEntries(mcpManager.serverStatus()),
    config_file: MCP_CONFIG_FILE,
  };
}

/**
 * 保存 MCP 配置到 <workspace>/.vca/mcp.json (项目级)。
 * 前端传完整 servers 数组, 覆盖写入。
 */
export function saveMcpConfig(servers: McpServerConfigView[]): { ok: boolean; error?: string } {
  try {
    const target = path.join(getWorkspace(), ".vca", "mcp.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const out: Record<string, unknown> = {};
    for (const s of servers) {
      if (!s.name || !s.name.trim()) continue;
      const cfg: Record<string, unknown> = { transport: s.transport ?? "stdio" };
      if (cfg.transport === "http" || cfg.transport === "sse") {
        if (!s.url) return { ok: false, error: `server ${s.name} 需要 url` };
        cfg.url = s.url;
      } else {
        if (!s.command) return { ok: false, error: `server ${s.name} 需要 command` };
        cfg.command = s.command;
        cfg.args = s.args ?? [];
      }
      out[s.name] = cfg;
    }
    fs.writeFileSync(target, JSON.stringify({ servers: out }, null, 2), "utf-8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 重连 MCP (返回状态) */
export async function reconnectMcp(): Promise<Record<string, string>> {
  return mcpManager.connect();
}

// ============================================================
// 汇总
// ============================================================

export interface SettingsView {
  general: GeneralSettings;
  skills: SkillInfo[];
  mcp: McpSettingsView;
}

export function getSettingsView(): SettingsView {
  return {
    general: getGeneralSettings(),
    skills: getSkillsInfo(),
    mcp: getMcpSettings(),
  };
}
