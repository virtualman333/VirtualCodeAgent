/**
 * 逻辑工作目录上下文 - 供所有工具解析相对路径
 *
 * 主 Agent 场景用模块级变量足够（TS 单线程），但 **SubAgent 不能共用它**：
 * 子代理有自己的工作目录，而它和主代理的异步链是交错执行的 —— 用模块级变量
 * 会出现「子代理把主代理的工作目录改掉、子代理跑完再改回来」这种靠时序碰运气的写法，
 * 一旦将来并行跑两个子代理就一定串目录（而且串得很安静：文件读写到别的目录去，
 * 不报错）。
 *
 * 所以这里分成两层：
 *   - **主 Agent**：`setWorkspace()` 写模块级变量（行为与以前完全一致）；
 *   - **SubAgent**：用 `AsyncLocalStorage` 挂在它自己的异步链上（`runWithWorkspace`）。
 *     `getWorkspace()` 优先读异步上下文，读不到才回落到模块级变量 —— 所以主代理
 *     一行都不用改，子代理天然隔离，两个子代理并行也各看各的。
 *
 * 这正是本文件上一版注释里写着「后续如果引入 SubAgent 并行，可替换为 AsyncLocalStorage」
 * 的那件事 —— 现在做到了。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

let currentWorkspace: string | null = null;

/** 子代理（以及将来任何需要隔离工作目录的异步任务）的目录栈 */
const workspaceAls = new AsyncLocalStorage<string>();

export function setWorkspace(p: string): void {
  currentWorkspace = path.resolve(p);
}

export function getWorkspace(): string {
  return workspaceAls.getStore() ?? currentWorkspace ?? process.cwd();
}

export function resetWorkspace(): void {
  currentWorkspace = null;
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    ((typeof v === "object" && v !== null) || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

/**
 * 在 `p` 这个工作目录下执行 `fn`，期间所有 `getWorkspace()` 都返回它。
 *
 * `fn` 里 `await` 出去的任何深度都还在这个上下文里（AsyncLocalStorage 跟着异步链走），
 * 所以子代理的工具调用不需要自己传目录。返回 `fn` 的返回值。
 *
 * ⚠ **只在 ALS 里跑是不够的**：`CodingAgent` 的 agent 节点每轮都会调 `setWorkspace(...)`，
 * 子代理跑起来后模块级变量就变成子代理的目录了。ALS 只保证「子代理内部看到的是对的」，
 * 保证不了「子代理跑完主代理看到的还是原来的」—— 而那才是真正会出事的方向：
 * 主代理在同一批工具调用里并发跑的别的工具（`write_file` / `bash`），
 * 会拿着子代理的目录去解析相对路径，**写到别的目录去且不报错**。
 *
 * 所以这里在进入前记下模块级变量、退出后还原。还原点必须在 `fn` 的 Promise 落地之后，
 * 不能放 `finally` —— 异步函数返回的 Promise 是**立刻**返回的，`finally` 会在第一个
 * `await` 之前就跑掉，那时子代理才刚把目录改掉，等于没还原。
 */
export function runWithWorkspace<T>(p: string, fn: () => T): T {
  const prev = currentWorkspace;
  const restore = (): void => {
    currentWorkspace = prev;
  };

  let out: T;
  try {
    out = workspaceAls.run(path.resolve(p), fn);
  } catch (e) {
    restore();
    throw e;
  }

  if (isThenable(out)) {
    return out.then(
      (v) => {
        restore();
        return v;
      },
      (e) => {
        restore();
        throw e;
      }
    ) as unknown as T;
  }

  restore();
  return out;
}

/** 将相对路径解析为绝对路径 (基于逻辑工作目录) */
export function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(getWorkspace(), p);
}
