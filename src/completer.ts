/**
 * Tab 补全 —— 纯函数：给一行输入，返回「候选列表 + 会被替换掉的那一段」。
 *
 * 返回值的形状与 Node readline 的 completer 一致：`[hits, token]`，
 * readline 会用选中的 hit 替换掉行尾那段 token。所以 `token` 必须是
 * **行尾那一段**，而不是整行、也不是整段参数。
 *
 * Python 版有（prompt_toolkit 的 VCACompleter：命令 / 命令参数 / 路径），
 * TS 重写时一并丢了。补回来时改了两处做法：
 *
 *   1. **只在命令上下文里补全**。普通输入是给 Agent 的任务描述，是自然语言，
 *      在那种句子里到处插路径补全只会碍事。Python 版是全局补的，这里收窄：
 *      不以 `/` 开头的行一律不给候选。
 *   2. 候选清单**全部由调用方注入**（命令名取自 help.ts 的 COMMANDS、
 *      配置键取自 config.ts 的 EDITABLE_KEYS、模型名取自 Config）。
 *      这个模块里不抄任何一份清单 —— 抄一份必然漂移：加一个命令忘了同步，
 *      Tab 就永远补不出来它，而命令本身还好好的，没人会想到是补全的问题。
 *
 * 不 import 本项目其它模块（只用 node:path / node:fs / paths.js），
 * 所以测试喂一个临时目录就能验，不需要真终端。
 */
import fs from "node:fs";
import path from "node:path";

import { expandUser } from "./paths.js";

export interface CompleterContext {
  /** 斜杠命令名（来自 help.ts 的单一来源） */
  commands: readonly string[];
  /** `/config set` 能改的键（来自 config.ts 的 EDITABLE_KEYS） */
  configKeys: readonly string[];
  /** `/model` 能切换的模型名 */
  models: readonly string[];
  /** 相对路径的补全基准（当前工作空间） */
  cwd: string;
}

/** 一次最多列多少个候选 —— 在 C:\ 根目录按一下 Tab 不该把整屏刷掉 */
export const MAX_HITS = 40;

/**
 * 前缀匹配。**保留调用方给的顺序**，不在这里排序 ——
 * 顺序本身是有意义的：命令按 help.ts 的 COMMANDS 排（与 `/help` 的输出一致），
 * 模型按配置里的顺序排（与 `/model` 的编号一致）。这里若插一道排序，
 * 就等于凭空多出「另一种顺序」：用户 `/model` 看到的是
 * `1. default 2. deepseek`，按 Tab 却得到 `deepseek, default`。
 */
function prefixHits(candidates: readonly string[], prefix: string): string[] {
  const p = prefix.toLowerCase();
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const c of candidates) {
    if (!c.toLowerCase().startsWith(p)) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    hits.push(c);
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
}

/** 目录 / 文件名切开：`/a/b` → { dirPart: "/a/", namePart: "b" } */
function splitArg(arg: string): { dirPart: string; namePart: string } {
  const sep = Math.max(arg.lastIndexOf("/"), arg.lastIndexOf("\\"));
  return sep >= 0
    ? { dirPart: arg.slice(0, sep + 1), namePart: arg.slice(sep + 1) }
    : { dirPart: "", namePart: arg };
}

/** 软链接 / junction 指向目录时也算目录（Windows 上 junction 很常见） */
function isDirLike(entry: fs.Dirent, absDir: string): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(absDir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 只补目录：`/cd` 要的是目录，把文件也列出来只会让人白按一次回车。
 * 命中里带上 `dirPart` 原样前缀 —— 用户敲了 `~/pro`，补出来就该是
 * `~/projects/`，而不是把 `~` 展开成真实家目录路径。
 */
function completePath(arg: string, cwd: string): string[] {
  const { dirPart, namePart } = splitArg(arg);
  const lookup = dirPart === "" ? "." : expandUser(dirPart);
  const absDir = path.isAbsolute(lookup) ? lookup : path.resolve(cwd, lookup);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    // 目录不存在 / 没权限 / 路径还在半截 —— 补全该安静地什么都不给
    return [];
  }

  // 用户敲 `/` 就用 `/`，别给他混出 `E:/agent\` 这种两种分隔符的路径
  const sepStyle = dirPart.includes("/") && !dirPart.includes("\\") ? "/" : path.sep;
  const ignoreCase = process.platform === "win32";
  const needle = ignoreCase ? namePart.toLowerCase() : namePart;

  const hits: string[] = [];
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    const name = ignoreCase ? entry.name.toLowerCase() : entry.name;
    if (!name.startsWith(needle)) continue;
    if (!isDirLike(entry, absDir)) continue;
    hits.push(dirPart + entry.name + sepStyle);
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
}

/** 唯一命中时补一个尾空格：`/he` + Tab 直接得到 `/help `，接着就能敲参数 */
function maybePadSpace(hits: string[]): string[] {
  return hits.length === 1 ? [hits[0] + " "] : hits;
}

/**
 * 主入口。返回 `[hits, token]`，没有候选时 hits 为空数组（**不是** null）。
 */
export function completeInput(
  line: string,
  ctx: CompleterContext
): [string[], string] {
  const text = String(line ?? "");

  // 不是命令 → 不补（这是给 Agent 的任务描述，见文件头第 1 条）
  if (!text.startsWith("/")) return [[], ""];

  // 还在敲命令名本身（整行没有空格）
  if (!/\s/.test(text)) {
    return [maybePadSpace(prefixHits(ctx.commands, text)), text];
  }

  const m = /^(\/[A-Za-z0-9-]+)\s+(.*)$/.exec(text);
  if (!m) return [[], ""];
  const cmd = m[1].toLowerCase();
  const arg = m[2];
  // 行尾那一段才是要被替换掉的 token
  const token = arg.includes(" ") ? arg.slice(arg.lastIndexOf(" ") + 1) : arg;

  switch (cmd) {
    case "/cd":
      // 路径补全：token 就是整段参数（路径里没有空格；带空格的路径这里不处理）
      return [completePath(token, ctx.cwd), token];

    case "/model":
      return [maybePadSpace(prefixHits(ctx.models, token)), token];

    case "/config": {
      const parts = arg.split(/\s+/);
      // 还在敲子命令本身（`/config `、`/config se`）—— 只可能是 set
      if (parts.length === 1) {
        return [maybePadSpace(prefixHits(["set"], parts[0])), token];
      }
      // 只认 `/config set <KEY>`：parts = ["set", "<KEY>"]
      if (parts[0] !== "set" || parts.length > 2) return [[], token];
      return [prefixHits(ctx.configKeys, token), token];
    }

    default:
      return [[], token];
  }
}
