/**
 * Skills 管理器 - 发现、解析、加载可插拔的专业技能
 *
 * Skill 目录结构:
 *   ~/.vca/skills/<skill-name>/SKILL.md
 *   <workspace>/.vca/skills/<skill-name>/SKILL.md
 *   <workspace>/skills/<skill-name>/SKILL.md
 *
 * SKILL.md 格式 (支持 YAML frontmatter):
 *   ---
 *   name: web-search
 *   description: 网页搜索技能
 *   ---
 *   正文...
 */
import fs from "node:fs";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as yaml from "js-yaml";

import { SKILLS_DIR } from "../config.js";
import { getWorkspace } from "../workspace_ctx.js";

// ============================================================
// Skill 数据结构
// ============================================================

export interface Skill {
  name: string;
  description: string;
  body: string;
  path: string;
  source: string;
}

export interface SkillConfig {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

// ============================================================
// 发现与解析
// ============================================================

function getSkillDirs(): string[] {
  const ws = getWorkspace();
  return [SKILLS_DIR, path.join(ws, ".vca", "skills"), path.join(ws, "skills")];
}

function parseSkillMd(content: string): { meta: SkillConfig; body: string } {
  let meta: SkillConfig = {};
  let body = content;

  if (content.startsWith("---")) {
    const end = content.indexOf("\n---", 3);
    if (end !== -1) {
      try {
        const parsed = yaml.load(content.slice(3, end)) as SkillConfig | null;
        meta = parsed && typeof parsed === "object" ? parsed : {};
        body = content.slice(end + 4).trim();
      } catch {
        meta = {};
      }
    }
  }
  return { meta, body };
}

let registry = new Map<string, Skill>();
let discovered = false;

/** 扫描所有 skill 目录，发现可用 skills (用户级优先) */
export function discoverSkills(): Skill[] {
  const found = new Map<string, Skill>();

  for (const dirPath of getSkillDirs()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!ent.isDirectory()) continue;
      const skillMd = path.join(dirPath, ent.name, "SKILL.md");
      if (!fs.existsSync(skillMd)) continue;

      try {
        const raw = fs.readFileSync(skillMd, "utf-8");
        const { meta, body } = parseSkillMd(raw);
        const name = meta.name || ent.name;
        const description = meta.description ?? "";

        if (found.has(name)) continue; // 用户级优先
        found.set(name, {
          name,
          description,
          body,
          path: path.join(dirPath, ent.name),
          source: dirPath,
        });
      } catch {
        continue;
      }
    }
  }

  registry = found;
  discovered = true;
  return [...found.values()];
}

export function getSkill(name: string): Skill | null {
  if (!discovered) discoverSkills();
  return registry.get(name) ?? null;
}

export function getAllSkills(): Skill[] {
  if (!discovered) discoverSkills();
  return [...registry.values()];
}

// ============================================================
// LangChain 工具 (注册给 LLM)
// ============================================================

export const listSkills = tool(
  async () => {
    const skills = getAllSkills();
    if (skills.length === 0) {
      return (
        "[OK] 暂无可用 Skills。\n" +
        "可在 ~/.vca/skills/ 或项目 .vca/skills/ 目录创建: <skill_name>/SKILL.md"
      );
    }
    const lines = [`[OK] 发现 ${skills.length} 个 Skills:`];
    for (const s of skills) {
      lines.push(`  - ${s.name}: ${s.description}`);
    }
    return lines.join("\n");
  },
  {
    name: "list_skills",
    description:
      "列出所有可用的 Skills（专业技能）。当你需要专业领域知识时先调用此工具查看有哪些技能可用，然后用 load_skill 加载需要的技能。",
    schema: z.object({}),
  }
);

export const loadSkill = tool(
  async ({ skill_name }: { skill_name: string }) => {
    if (!discovered) discoverSkills();
    const skill = getSkill(skill_name);
    if (!skill) {
      const available = [...registry.keys()].join(", ") || "(无)";
      return `[ERROR] 未找到技能 '${skill_name}'。可用技能: ${available}`;
    }
    const prompt = `## Skill: ${skill.name}\n${skill.description}\n\n${skill.body}`;
    return `[OK] 已加载技能 '${skill.name}':\n\n${prompt}`;
  },
  {
    name: "load_skill",
    description:
      "加载指定的 Skill（专业技能）到当前上下文。加载后你将获得该技能的专业领域知识、工作流程和注意事项。",
    schema: z.object({
      skill_name: z.string().describe("技能名称（先用 list_skills 查看可用技能）"),
    }),
  }
);

export const SKILL_TOOLS = [listSkills, loadSkill];
