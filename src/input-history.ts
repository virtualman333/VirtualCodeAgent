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
