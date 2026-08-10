"""Skills 管理器 - 发现、解析、加载可插拔的专业技能"""

from __future__ import annotations

import os
from pathlib import Path
from dataclasses import dataclass, field

import yaml
from langchain_core.tools import tool

# ============================================================
# Skill 数据结构
# ============================================================


@dataclass
class Skill:
    """一个已发现的 Skill"""
    name: str
    description: str
    body: str              # SKILL.md 正文
    path: str              # skill 目录路径
    source: str            # 来源目录

    def to_tool_prompt(self) -> str:
        """转换为注入上下文的文本"""
        return f"## Skill: {self.name}\n{self.description}\n\n{self.body}"


@dataclass
class SkillRegistry:
    """Skill 注册表（全局单例）"""
    skills: dict[str, Skill] = field(default_factory=dict)

    def add(self, skill: Skill) -> None:
        self.skills[skill.name] = skill


_registry = SkillRegistry()


# ============================================================
# Skill 发现
# ============================================================

def _get_skill_dirs() -> list[str]:
    """获取所有 skill 搜索目录 (用户级 + 项目级)"""
    from ..config import SKILLS_DIR

    dirs = [str(SKILLS_DIR)]
    # 项目级: 当前工作目录下的 .vca/skills 和 skills
    cwd = Path.cwd()
    dirs.append(str(cwd / ".vca" / "skills"))
    dirs.append(str(cwd / "skills"))
    return dirs


def _parse_skill_md(content: str) -> tuple[dict, str]:
    """
    解析 SKILL.md: 支持 YAML frontmatter。

    ---
    name: web-search
    description: 网页搜索技能
    ---
    正文...
    """
    meta: dict = {}
    body = content

    if content.startswith("---"):
        end = content.find("\n---", 3)
        if end != -1:
            try:
                meta = yaml.safe_load(content[3:end].strip()) or {}
                body = content[end + 4:].strip()
            except yaml.YAMLError:
                meta = {}

    return meta, body


def discover_skills() -> list[Skill]:
    """扫描所有 skill 目录，发现可用 skills"""
    found: dict[str, Skill] = {}

    for dirpath in _get_skill_dirs():
        base = Path(dirpath)
        if not base.is_dir():
            continue

        for skill_dir in sorted(base.iterdir()):
            if not skill_dir.is_dir():
                continue

            skill_md = skill_dir / "SKILL.md"
            if not skill_md.exists():
                continue

            try:
                raw = skill_md.read_text(encoding="utf-8")
                meta, body = _parse_skill_md(raw)
                name = meta.get("name") or skill_dir.name
                description = meta.get("description", "")

                if name in found:
                    continue  # 用户级优先，已存在则跳过

                found[name] = Skill(
                    name=name,
                    description=description,
                    body=body,
                    path=str(skill_dir),
                    source=str(base),
                )
            except Exception:
                continue

    _registry.skills = found
    return list(found.values())


def get_skill(name: str) -> Skill | None:
    """按名称获取 skill"""
    return _registry.skills.get(name)


def get_all_skills() -> list[Skill]:
    """获取全部已发现 skills"""
    if not _registry.skills:
        discover_skills()
    return list(_registry.skills.values())


# ============================================================
# LangChain 工具 (注册给 LLM)
# ============================================================


@tool
def list_skills() -> str:
    """
    列出所有可用的 Skills（专业技能）。

    当你需要专业领域知识时先调用此工具查看有哪些技能可用，
    然后用 load_skill 加载需要的技能。

    Returns:
        可用技能列表（名称 + 描述）
    """
    skills = get_all_skills()
    if not skills:
        return (
            "[OK] 暂无可用 Skills。\n"
            "可在 ~/.vca/skills/ 或项目 .vca/skills/ 目录创建: <skill_name>/SKILL.md"
        )

    lines = [f"[OK] 发现 {len(skills)} 个 Skills:"]
    for s in skills:
        lines.append(f"  - {s.name}: {s.description}")
    return "\n".join(lines)


@tool
def load_skill(skill_name: str) -> str:
    """
    加载指定的 Skill（专业技能）到当前上下文。

    加载后你将获得该技能的专业领域知识、工作流程和注意事项。

    Args:
        skill_name: 技能名称（先用 list_skills 查看可用技能）

    Returns:
        技能完整内容（说明 + 工作流程 + 注意事项）
    """
    if not _registry.skills:
        discover_skills()

    skill = get_skill(skill_name)
    if not skill:
        available = ", ".join(_registry.skills.keys()) or "(无)"
        return f"[ERROR] 未找到技能 '{skill_name}'。可用技能: {available}"

    return f"[OK] 已加载技能 '{skill.name}':\n\n" + skill.to_tool_prompt()


# 供工作流注册使用的工具列表
SKILL_TOOLS = [list_skills, load_skill]
