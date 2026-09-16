/**
 * 输入历史 —— 让 ↑ / ↓ 能翻回之前敲过的内容。
 *
 * Python 版（prompt_toolkit 的 FileHistory）本来就有，TS 重写时丢了：
 * ui.promptUser 每次 new 一个不带 history 的 readline，↑ 什么都翻不出来，
 * 敲一个长任务描述、按回车发现模型选错，就只能整段重打。
 * 这里把它补回来，并且**沿用同一个文件**（~/.vca/input_history）与同一种
 * 格式，所以 Python 版留下的历史直接就能读回来，不用迁移。
 *
 * ⚠ 两个顺序约定，别弄反（这是本模块唯一容易出错的地方）：
 *   - 文件里：**最早在前**（追加式，跟日志一样）
 *   - 内存里：**最新在前**（Node readline 的 history 就是 newest-first，
 *     ↑ 从数组末尾往前翻）
 * 转换只在 parseHistory / formatHistory 两处各做一次，别在别处再 reverse。
 *
 * 不 import 任何本项目模块：文件路径由调用方传进来，所以测试可以用临时
 * 文件跑，不会碰到真实的 ~/.vca。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 内存里最多留多少条。
 * Node readline 自己的 historySize 默认只有 30 —— 那点量翻两下就到底了，
 * 而"上次是怎么调起来的"往往隔了几十条。
 */
export const HISTORY_MAX = 500;

/** 一条历史：多行输入压成单行（readline 一次只给一行，多行只可能来自粘贴） */
export function normalizeEntry(line: unknown): string {
  return String(line ?? "")
    .replace(/\r?\n/g, " ")
    .trim();
}

/**
 * `/input` 不给条数时列多少条。
 * 取 20 是因为它要能在一屏里看完 —— 列 500 条等于什么都没说。
 */
export const SHOW_DEFAULT = 20;

/**
 * `/input` 的参数语义 —— **唯一一处定义**。
 *
 * 语法只有三种，但「什么算条数、什么算关键字」这种判断最容易在
 * 命令实现里再写一遍，然后两处慢慢分家（`/input 0` 一处当条数、
 * 一处当关键字）。所以判定放在这里，命令实现只管用它。
 *
 *   /input              → 列最近 SHOW_DEFAULT 条
 *   /input <正整数>      → 列最近 N 条（夹到 1..HISTORY_MAX，「/input 0」的意图
 *                          显然是条数，不是想找含 0 的历史）
 *   /input clear        → 清空（大小写不敏感、两边空白不计）
 *   /input <其它>        → 当关键字做子串过滤
 *
 * 「clear」永远是清空命令。想找含 clear 的历史，敲 `lear` 也能匹配到
 * （过滤是子串匹配，不必写全）。
 */
export type InputAction =
  | { kind: "list"; limit: number; filter: string }
  | { kind: "clear" };

export function parseInputArg(raw: unknown): InputAction {
  const arg = String(raw ?? "").trim();
  if (!arg) return { kind: "list", limit: SHOW_DEFAULT, filter: "" };
  if (arg.toLowerCase() === "clear") return { kind: "clear" };
  if (/^\d+$/.test(arg)) {
    const n = parseInt(arg, 10);
    return { kind: "list", limit: Math.min(Math.max(n, 1), HISTORY_MAX), filter: "" };
  }
  return { kind: "list", limit: SHOW_DEFAULT, filter: arg };
}

export interface HistorySelection {
  /** 要显示的条目（**最新在前**，与 ↑ 翻的顺序一致） */
  shown: readonly string[];
  /** 过滤前的总条数 */
  total: number;
  /** 命中过滤的条数 */
  matched: number;
  /** 实际生效的关键字（去掉首尾空白后的原文） */
  filter: string;
}

/**
 * 从历史里挑出要显示的那一段。**纯函数**：不改动传入的数组，
 * 也不碰文件 —— 显示什么和「文件里存了什么」是两件事。
 *
 * 过滤用**子串**而不是前缀：想找「那句带 redis 的」时，
 * 记得住的往往是中间某个词，前缀匹配基本等于没有。
 *
 * `skip` 用来剔掉「当前这一行」：主循环是**先记历史、再执行命令**
 * （shell 就是这么做的），所以 `/input` 自己已经在历史里了。不剔掉的话
 * 列表第一行永远是刚敲的那条 `/input`，而新装机器上「还没有输入历史」
 * 这个分支永远走不到 —— 列表里总有一条，就是它自己。
 * 只比对**第一条**，不误伤历史里真实存在的同名输入。
 */
export function selectHistory(
  entries: readonly string[],
  opts: { limit?: number; filter?: string; skip?: string } = {}
): HistorySelection {
  const all = Array.isArray(entries) ? entries : [];
  const skip = String(opts.skip ?? "").trim();
  const pool = skip && all.length > 0 && all[0] === skip ? all.slice(1) : all;

  const filter = String(opts.filter ?? "").trim();
  const needle = filter.toLowerCase();
  const matchedList = needle
    ? pool.filter((e) => String(e).toLowerCase().includes(needle))
    : pool;

  const rawLimit = Number(opts.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), HISTORY_MAX)
    : SHOW_DEFAULT;

  return {
    shown: matchedList.slice(0, limit),
    total: pool.length,
    matched: matchedList.length,
    filter,
  };
}

/**
 * 清空历史。**就地清空并返回同一个数组**。
 *
 * 为什么要求「同一个数组」：内存那份是 ↑/↓ 正在用的，文件那份是下次启动要读的。
 * 只清一边都不算清 —— 只清文件，↑ 还翻得出来；只清内存，重启全回来。
 * 让调用方把这个函数的返回值直接交给 writeHistory，两边就不可能分家。
 */
export function clearHistory(entries: string[]): string[] {
  entries.length = 0;
  return entries;
}

/**
 * 文件文本 → 内存数组（最新在前）。
 *
 * 认两种行：
 *   - `# 2026-08-11 10:27:28.049413` —— prompt_toolkit 的时间戳注释，跳过
 *   - 其它非空行 —— 一条历史
 *
 * 只把形如 `# <日期>` 的行当注释：用户完全可能真的敲过一行 `# 注释`，
 * 那种不能被吃掉。反过来，我们自己写文件时不写时间戳（内存里没有逐条
 * 时间，凭空盖一个"现在"是假信息），prompt_toolkit 读没有时间戳的行也认。
 */
export function parseHistory(text: unknown): string[] {
  const out: string[] = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    if (/^#\s*\d{4}-\d{2}-\d{2}/.test(raw)) continue;
    const entry = normalizeEntry(raw);
    if (!entry) continue;
    out.push(entry);
  }
  out.reverse();
  return out.slice(0, HISTORY_MAX);
}

/** 内存数组（最新在前）→ 文件文本（最早在前，一行一条） */
export function formatHistory(entries: readonly string[]): string {
  const lines = entries.map(normalizeEntry).filter((l) => l.length > 0);
  if (lines.length === 0) return "";
  return lines.reverse().join("\n") + "\n";
}

/** 读历史。文件不存在 / 读不动 / 内容损坏都按「没有历史」处理，不该拦住启动 */
export function readHistory(file: string): string[] {
  try {
    return parseHistory(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

/**
 * 落盘：整份重写，不追加。
 * 内存里就是全量，重写不会出现「内存一份、文件一份」两份真相；
 * 500 行的文本重写一次也就几十微秒，不值得为它引入增量同步的复杂度。
 */
export function writeHistory(file: string, entries: readonly string[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, formatHistory(entries), "utf-8");
  } catch {
    /* 历史存不下来不是什么大事，不影响正常使用 */
  }
}

/**
 * 记一条新输入。**就地**改动传入的数组（与 readline 的约定一致：
 * 它自己也是 unshift 进同一个数组），返回是否真的记下了。
 *
 * 空行与「与上一条完全相同」都不记 —— 否则按住回车就能把历史刷满，
 * 真正想翻回来的那条被挤出去。非连续的重复照记（隔了两条又敲一次同样
 * 的命令是很常见的）。
 */
export function pushHistory(
  entries: string[],
  line: unknown,
  max: number = HISTORY_MAX
): boolean {
  const entry = normalizeEntry(line);
  if (!entry) return false;
  if (entries[0] === entry) return false;
  entries.unshift(entry);
  if (entries.length > max) entries.length = max; // 丢最旧的
  return true;
}
