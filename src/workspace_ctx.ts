/**
 * 逻辑工作目录上下文 - 供所有工具解析相对路径
 *
 * TS 单线程 + async 环境，主 Agent 场景用模块级变量足够。
 * 后续如果引入 SubAgent 并行，可替换为 AsyncLocalStorage。
 */
import path from "node:path";

let currentWorkspace: string | null = null;

export function setWorkspace(p: string): void {
  currentWorkspace = path.resolve(p);
}

export function getWorkspace(): string {
  return currentWorkspace ?? process.cwd();
}

export function resetWorkspace(): void {
  currentWorkspace = null;
}

/** 将相对路径解析为绝对路径 (基于逻辑工作目录) */
export function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(getWorkspace(), p);
}
