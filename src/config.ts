/**
 * 配置管理 - 基于 ~/.vca/config.json 的配置文件
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ============================================================
// 路径常量
// ============================================================

export const VCA_DIR = path.join(os.homedir(), ".vca");
export const CONFIG_FILE = path.join(VCA_DIR, "config.json");
export const HISTORY_FILE = path.join(VCA_DIR, "workspace_history.json");
export const SESSIONS_DIR = path.join(VCA_DIR, "sessions");
export const SKILLS_DIR = path.join(VCA_DIR, "skills");
export const MCP_CONFIG_FILE = path.join(VCA_DIR, "mcp.json");

// ============================================================
// 配置类型与默认值
// ============================================================

/** 单个模型配置 */
export interface ModelConfig {
  name: string;
  model: string;
  base_url?: string;
  api_key?: string;
}

export interface VcaConfig {
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL: string;
  OPENAI_MODEL: string;
  /** 默认使用哪个模型 (MODELS 中的 name，或 OPENAI_MODEL) */
  DEFAULT_MODEL?: string;
  /** 多模型列表 (可省略 base_url/api_key，继承全局默认) */
  MODELS?: ModelConfig[];
  WORKSPACE_DIR: string;
  MAX_TOOL_ITERATIONS: number;
  MAX_CONTEXT_TOKENS: number;
  [key: string]: unknown;
}

export const DEFAULT_CONFIG: VcaConfig = {
  OPENAI_API_KEY: "",
  OPENAI_BASE_URL: "https://api.openai.com/v1",
  OPENAI_MODEL: "gpt-4o-mini",
  DEFAULT_MODEL: "gpt-4o-mini",
  WORKSPACE_DIR: "~/.vca/workspace",
  MAX_TOOL_ITERATIONS: 10,
  MAX_CONTEXT_TOKENS: 100000,
};

export const EDITABLE_KEYS = new Set([
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "DEFAULT_MODEL",
  "WORKSPACE_DIR",
  "MAX_TOOL_ITERATIONS",
  "MAX_CONTEXT_TOKENS",
]);

// ============================================================
// 读写
// ============================================================

function ensureDirs(): void {
  for (const d of [VCA_DIR, SESSIONS_DIR, SKILLS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function loadFile(): VcaConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      if (data && typeof data === "object") {
        return data as VcaConfig;
      }
    }
  } catch {
    /* 损坏配置忽略 */
  }
  return {} as VcaConfig;
}

function saveFile(data: VcaConfig): void {
  ensureDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function ensureConfig(): VcaConfig {
  ensureDirs();
  let config = loadFile();

  if (Object.keys(config).length === 0) {
    config = { ...DEFAULT_CONFIG };
    saveFile(config);
    console.log(`[INFO] 已生成默认配置文件: ${CONFIG_FILE}`);
    console.log("[INFO] 请编辑该文件填入你的 OPENAI_API_KEY");
  }

  // 合并缺失的默认项 (配置升级时自动补齐)
  let changed = false;
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (!(key in config)) {
      config[key] = DEFAULT_CONFIG[key];
      changed = true;
    }
  }
  if (changed) saveFile(config);
  return config;
}

// ============================================================
// 历史工作空间
// ============================================================

export function loadWorkspaceHistory(): string[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
      if (Array.isArray(data)) {
        return data
          .filter((p: unknown) => typeof p === "string" && fs.existsSync(p))
          .slice(0, 10);
      }
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function saveWorkspaceHistory(paths: string[]): void {
  try {
    const seen = new Set<string>();
    const clean = paths.filter((p) => {
      if (seen.has(p) || !fs.existsSync(p)) return false;
      seen.add(p);
      return true;
    });
    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(clean.slice(0, 10), null, 2),
      "utf-8"
    );
  } catch {
    /* ignore */
  }
}

// ============================================================
// 配置对象
// ============================================================

let _config: VcaConfig = ensureConfig();

export const Config = {
  get value(): VcaConfig {
    return _config;
  },

  get OPENAI_API_KEY() {
    return String(_config.OPENAI_API_KEY ?? "");
  },
  get OPENAI_BASE_URL() {
    return String(_config.OPENAI_BASE_URL ?? "https://api.openai.com/v1");
  },
  get OPENAI_MODEL() {
    return String(_config.OPENAI_MODEL ?? "gpt-4o-mini");
  },
  get WORKSPACE_DIR() {
    return expandUser(String(_config.WORKSPACE_DIR ?? "~/.vca/workspace"));
  },
  get MAX_TOOL_ITERATIONS() {
    return Number(_config.MAX_TOOL_ITERATIONS ?? 10);
  },
  get MAX_CONTEXT_TOKENS() {
    return Number(_config.MAX_CONTEXT_TOKENS ?? 100000);
  },

  get(key: string, def?: unknown): unknown {
    return _config[key] ?? def;
  },

  set(key: string, value: string | number | ModelConfig[]): void {
    _config[key] = value;
    saveFile(_config);
  },

  // ---------- 多模型 ----------

  /** 模型配置列表。优先用 MODELS 数组，否则回退到单模型配置 */
  getModels(): ModelConfig[] {
    const models = _config.MODELS;
    if (Array.isArray(models) && models.length > 0) {
      return models.map((m, i) => ({
        name: m.name || m.model || `model_${i + 1}`,
        model: m.model || m.name || "gpt-4o-mini",
        base_url: m.base_url || this.OPENAI_BASE_URL,
        api_key: m.api_key || this.OPENAI_API_KEY,
      }));
    }
    return [
      {
        name: this.OPENAI_MODEL,
        model: this.OPENAI_MODEL,
        base_url: this.OPENAI_BASE_URL,
        api_key: this.OPENAI_API_KEY,
      },
    ];
  },

  /** 默认模型名 */
  getDefaultModelName(): string {
    return String(_config.DEFAULT_MODEL ?? this.OPENAI_MODEL);
  },

  /** 按名称取模型配置 (不存在时回退默认模型) */
  getModelConfig(name?: string | null): ModelConfig {
    const models = this.getModels();
    if (!name) {
      const defName = this.getDefaultModelName();
      return models.find((m) => m.name === defName) ?? models[0];
    }
    return models.find((m) => m.name === name) ?? models[0];
  },

  /** 判断 API Key 是否有效 (任一模型有 key 即可) */
  hasApiKey(): boolean {
    if (this.OPENAI_API_KEY) return true;
    return this.getModels().some((m) => m.api_key);
  },

  validate(): boolean {
    if (!this.hasApiKey()) {
      console.log("[WARN] OPENAI_API_KEY 未设置");
      console.log(`[WARN] 请编辑配置文件: ${CONFIG_FILE}`);
      return false;
    }
    return true;
  },

  resolveWorkspace(p: string): string {
    const abs = path.resolve(expandUser(p));
    if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
    return abs;
  },

  getWorkspaceHistory(): string[] {
    return loadWorkspaceHistory();
  },

  addWorkspaceToHistory(p: string): void {
    const abs = path.resolve(p);
    const history = loadWorkspaceHistory().filter((x) => x !== abs);
    history.unshift(abs);
    saveWorkspaceHistory(history);
  },
};

export function expandUser(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
