/**
 * 会话记录的读写 —— **目录由调用方传入**。
 *
 * 为什么单独成文件：`storage.ts` 在 import 时就 import 了 `config.ts`，而
 * `config.ts` 顶层会 `ensureConfig()` 真写 `~/.vca/config.json`。于是「会话管理」
 * 这套逻辑此前一行都测不了 —— 想测就得先动用户真实的家目录。本仓库已经为同一个
 * 理由把 `expandUser` 拆到 `paths.ts`、把 ToolNode 白名单拆到 `tools/executable.ts`，
 * 这里照同一套路子办：本文件不 import 任何本项目模块，每个函数收一个 `vcaDir`。
 *
 * ============================================================
 * 四个上限 / 口径，各自只有一个读取处
 * ============================================================
 *
 * 「会话」这套东西此前散着四个数，各改各的：
 *
 *   - `/history` 列 `listSessions(10)`，`/load <序号>` 也读 `listSessions(10)` ——
 *     同一个 10 手抄在两处，一旦有一处改动，「/history 说用 /load <序号> 恢复」
 *     里的序号指的就**不是**同一条会话；
 *   - `listSessions()` 的默认值又是 20，而 `cs.windowNo = listSessions().length + 1`
 *     —— 于是窗口号**从第 21 条会话起永远停在 #21**，用户敲 `/new` 一直看到同一个号；
 *   - 索引写盘时再硬砍成 50 条（`slice(0, 50)`），被砍掉的会话**文件还在磁盘上**，
 *     但既不进列表也不能被载入/删除 —— 静默丢东西，没有任何地方会响。
 *
 * 现在：列表窗口只有一个来源（`listDefault()` / 下面那组函数），索引外的会话文件
 * 一律会被 `listSessions` 列出来（见 `registered`），上限本身见 `MAX_INDEXED_SESSIONS`。
 *
 * ============================================================
 * 为什么「索引外的会话」必须能被列出来
 * ============================================================
 *
 * 索引只是一份**缓存**（标题 / 条数 / 工作空间）。真值永远是 `sessions/<id>.json`
 * 这些文件。只要两者可以不一致，就必须有一个方向能兜住：文件在、索引里没有 ——
 * 此时把它藏起来，用户就再也找不回自己的对话了，而且**不会报任何错**。
 */

import fs from "node:fs";
import path from "node:path";

/** 会话文件都放在 `<vcaDir>/sessions/` */
export const SESSIONS_SUBDIR = "sessions";
export const INDEX_BASENAME = "session_index.json";

/**
 * 索引里最多留多少条记录（超出时最旧的滚出索引）。
 *
 * 原来写死 50 —— 每天用几次，两个月就把最早的记录挤出索引了，而它们的文件还在，
 * 于是「/history 里再也看不到它」这件事静默发生。抬到 500（与输入历史的上限同一个
 * 数量级，索引文件也就几十 KB）之后仍然有上限，但**不再是静默的**：索引外的会话
 * 文件照样会被列出来、能载入、能删掉（见 `listSessions` / `listOrphans`）。
 */
export const MAX_INDEXED_SESSIONS = 500;

/** `/history` 不给条数时列几个，`/load <序号>` 的序号就取自同一份列表（`LIST_DEFAULT` 是它唯一来源） */
export const LIST_DEFAULT = 10;

/** 会话 id 的形状（时间戳 + 随机数）。同时也是删除时的路径安全闸：不认这种形状就不许删。 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

// ============================================================
// 路径
// ============================================================

export function sessionsDir(vcaDir: string): string {
  return path.join(vcaDir, SESSIONS_SUBDIR);
}

export function indexFile(vcaDir: string): string {
  return path.join(vcaDir, INDEX_BASENAME);
}

export function sessionFile(vcaDir: string, id: string): string {
  return path.join(sessionsDir(vcaDir), `${id}.json`);
}

/** 列表窗口的大小（`/history` 与 `/load` 共用） */
export function listDefault(): number {
  return LIST_DEFAULT;
}

// ============================================================
// 类型
// ============================================================

export interface SessionEntry {
  id: string;
  title: string;
  workspace: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

/** 列表里的一行 —— 可能来自索引，也可能只是个「索引外的会话文件」 */
export interface SessionRow {
  id: string;
  title: string;
  workspace: string;
  /** 索引里有时是准确条数；索引外报 `null`（不知道 ≠ 0） */
  message_count: number | null;
  updated_at: string;
  /** `false` = 磁盘上有这个会话文件、但索引里没有它 */
  registered: boolean;
}

export interface OrphanSession {
  id: string;
  bytes: number;
  mtime: string;
}

export interface DeleteOutcome {
  id: string;
  /** 删掉了会话文件 */
  file: boolean;
  /** 删掉了索引记录 */
  index: boolean;
  /** 一条都没删掉时说明原因（id 形状不对 / 文件不存在） */
  reason?: string;
}

// ============================================================
// 时间与 id
// ============================================================

/** 时间戳一律按北京时间写（+8h），与 `updated_at` 显示口径一致 */
export function nowStr(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
}

function mtimeStr(ms: number): string {
  return new Date(ms + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
}

export function generateSessionId(): string {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/[T.]/g, "_").slice(0, 15);
  return `${stamp}_${Math.floor(Math.random() * 100000)}`;
}

// ============================================================
// 索引读写
// ============================================================

/**
 * 读索引。文件不存在 / 读不动 / 内容损坏都返回空数组。
 *
 * ⚠ 「空数组」在这里有两种含义（本来是空的 / 读坏了），调用方按「没有索引」处理 ——
 * 这是安全的：真值在会话文件那边，`listSessions` 会把文件补上来。
 */
export function readIndex(vcaDir: string): SessionEntry[] {
  try {
    const file = indexFile(vcaDir);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (Array.isArray(data)) {
        return data.filter(
          (e): e is SessionEntry => !!e && typeof e === "object" && typeof (e as SessionEntry).id === "string"
        );
      }
    }
  } catch {
    /* 坏索引不拦住启动：会话文件还在，列表会把它补回来 */
  }
  return [];
}

export function writeIndex(vcaDir: string, index: readonly SessionEntry[]): void {
  fs.mkdirSync(sessionsDir(vcaDir), { recursive: true });
  fs.writeFileSync(indexFile(vcaDir), JSON.stringify(index, null, 2), "utf-8");
}

/**
 * 插入或更新一条索引记录。
 *
 * 两条既有语义（原来在 `storage.ts` 的 `updateIndex` 里，行为一字未改）：
 *   - 已存在：**保留原 `created_at` 与原 `title`**（标题只在第一次写入时从
 *     首条用户消息里生成，之后不再被改掉）；
 *   - 新的：插到最前面（最新在前），并按 `MAX_INDEXED_SESSIONS` 截断。
 */
export function upsertIndex(vcaDir: string, entry: SessionEntry): void {
  const index = readIndex(vcaDir);
  for (let i = 0; i < index.length; i++) {
    if (index[i].id === entry.id) {
      const merged: SessionEntry = {
        ...entry,
        created_at: index[i].created_at,
        title: index[i].title || entry.title,
      };
      index[i] = merged;
      writeIndex(vcaDir, index);
      return;
    }
  }
  index.unshift(entry);
  writeIndex(vcaDir, index.slice(0, MAX_INDEXED_SESSIONS));
}

export function removeFromIndex(vcaDir: string, id: string): boolean {
  const index = readIndex(vcaDir);
  const kept = index.filter((item) => item.id !== id);
  if (kept.length === index.length) return false;
  writeIndex(vcaDir, kept);
  return true;
}

// ============================================================
// 会话文件
// ============================================================

/** 磁盘上的会话文件（id → stat）。目录不存在就是空；读不动则**抛**（别把「读不出来」说成「没有」）。 */
function listFiles(vcaDir: string): Map<string, OrphanSession> {
  const out = new Map<string, OrphanSession>();
  const dir = sessionsDir(vcaDir);
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const id = name.slice(0, -".json".length);
    if (!SESSION_ID_RE.test(id)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      out.set(id, { id, bytes: st.size, mtime: mtimeStr(st.mtimeMs) });
    } catch {
      /* 单个文件 stat 失败就跳过它，不影响别的 */
    }
  }
  return out;
}

/**
 * 「索引外的会话文件」—— 磁盘上有、索引里没有的那些。
 *
 * 按 mtime 从新到旧排。索引上限截断掉的老会话、手删过索引、换过机器只拷了
 * `sessions/` 目录，都会走到这里。
 */
export function listOrphans(vcaDir: string): OrphanSession[] {
  const indexed = new Set(readIndex(vcaDir).map((e) => e.id));
  const orphans = [...listFiles(vcaDir).values()].filter((f) => !indexed.has(f.id));
  orphans.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
  return orphans;
}

export function readSessionFile(vcaDir: string, id: string): unknown {
  return JSON.parse(fs.readFileSync(sessionFile(vcaDir, id), "utf-8"));
}

export function writeSessionFile(vcaDir: string, id: string, data: unknown): void {
  fs.mkdirSync(sessionsDir(vcaDir), { recursive: true });
  fs.writeFileSync(sessionFile(vcaDir, id), JSON.stringify(data, null, 2), "utf-8");
}

// ============================================================
// 列表 / 搜索 / 删除
// ============================================================

/**
 * 会话列表：**索引条目 + 索引外的会话文件**（后者接在末尾，按 mtime 从新到旧）。
 *
 * 不传 `maxCount` 就是全部 —— 这一点是刻意的：调用方里有一处在数「一共几个会话」
 * （窗口号、序号范围），给它一个会截断的默认值就是在两处各算一次不同的总数。
 * 只截断一次，而且只在**要显示**的地方截。
 */
export function listSessions(vcaDir: string, maxCount?: number): SessionRow[] {
  const rows: SessionRow[] = readIndex(vcaDir).map((e) => ({ ...e, registered: true }));
  for (const o of listOrphans(vcaDir)) {
    rows.push({
      id: o.id,
      title: "",
      workspace: "",
      message_count: null,
      updated_at: o.mtime,
      registered: false,
    });
  }
  if (typeof maxCount === "number" && Number.isFinite(maxCount)) {
    return rows.slice(0, Math.max(0, Math.trunc(maxCount)));
  }
  return rows;
}

export interface SessionSelection {
  /** 要显示的那一段 */
  shown: readonly SessionRow[];
  /** 过滤前的总条数 */
  total: number;
  /** 命中过滤的条数 */
  matched: number;
  /** 实际生效的关键字（去首尾空白后的原文） */
  filter: string;
}

/**
 * 从列表里挑出要显示的那一段。**纯函数**：不碰文件，只在一份已经排好的列表上
 * 过滤 + 截断 —— 显示什么和「磁盘上有什么」是两件事，可分别测。
 *
 * 过滤用**子串**（不区分大小写）而不是前缀：想找「那次改 redis 的会话」时，
 * 记得住的往往是标题中间某个词。搜索面对齐 `/input`：**标题 + 工作空间**两栏。
 */
export function selectSessions(
  rows: readonly SessionRow[],
  opts: { limit?: number; filter?: string } = {}
): SessionSelection {
  const all = Array.isArray(rows) ? rows : [];
  const filter = String(opts.filter ?? "").trim();
  const needle = filter.toLowerCase();
  const matchedList = needle
    ? all.filter(
        (r) =>
          String(r.title).toLowerCase().includes(needle) ||
          String(r.workspace).toLowerCase().includes(needle)
      )
    : all;

  const rawLimit = Number(opts.limit);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.trunc(rawLimit)) : LIST_DEFAULT;

  return {
    shown: matchedList.slice(0, limit),
    total: all.length,
    matched: matchedList.length,
    filter,
  };
}

/** `selectSessions(listSessions(...), ...)` —— 命令实现只调这一个 */
export function searchSessions(
  vcaDir: string,
  opts: { limit?: number; filter?: string } = {}
): SessionSelection {
  return selectSessions(listSessions(vcaDir), opts);
}

/**
 * 删掉一个会话：**文件 + 索引一起删**。
 *
 * 只删一边都不算删 —— 只删文件，`/history` 里还挂着一条点进去是空的；
 * 只删索引，文件永远留在磁盘上（下次照样出现在「索引外」那一组里）。
 *
 * id 形状不对（含 `/`、`..` 之类）直接拒掉：这个函数会 `rmSync`，而 id 一路
 * 可能来自用户的 `/history del` 参数，绝不能拼出一个越界的路径。
 */
export function deleteSession(vcaDir: string, id: string): DeleteOutcome {
  const sid = String(id ?? "").trim();
  if (!SESSION_ID_RE.test(sid)) {
    return { id: sid, file: false, index: false, reason: `会话 id 形状不对: ${JSON.stringify(sid)}` };
  }
  const file = sessionFile(vcaDir, sid);
  let removed = false;
  try {
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed = true;
    }
  } catch (e) {
    return { id: sid, file: false, index: false, reason: `会话文件删不掉: ${(e as Error).message}` };
  }
  const inIndex = removeFromIndex(vcaDir, sid);
  const out: DeleteOutcome = { id: sid, file: removed, index: inIndex };
  // 失败原因**只在真的失败时**挂上去：`{file:false,index:false,reason:undefined}` 这种
  // 带一个空键的返回会让调用方每处都得判两次（`out.reason ?? ...`），也测不干净
  if (!removed && !inIndex) out.reason = "这个会话不存在（文件与索引里都没有）";
  return out;
}

// ============================================================
// `/history` 的参数语义 —— **唯一一处定义**
// ============================================================

/**
 * 语法与 `/input` 同构（那边是 `parseInputArg`），因为用户已经在 `/input` 上学过一遍了：
 *
 *   /history                 → 列最近 `LIST_DEFAULT` 个
 *   /history <正整数>         → 列最近 N 个（夹到 1..`MAX_INDEXED_SESSIONS`；
 *                              `/history 0` 的意图显然是「列 1 个」，不是想找含 0 的标题）
 *   /history del <序号>      → 删除第 <序号> 个（序号取自上面那份列表；缺序号 → `index: null`）
 *   /history <其它>          → 当关键字，搜标题与工作空间
 *
 * 「del」永远是删除，但只删**一条**：整片清空不提供 —— 一次手滑删掉全部会话是
 * 不可逆的，而 `/input clear` 清掉的只是「敲过的命令」那种可再生数据。
 * 想找标题里带 del 的会话，搜 `de` 也能匹配到（过滤是子串匹配）。
 */
export type HistoryAction =
  | { kind: "list"; limit: number; filter: string }
  | { kind: "delete"; index: number | null };

export function parseHistoryArg(raw: unknown): HistoryAction {
  const arg = String(raw ?? "").trim();
  if (!arg) return { kind: "list", limit: LIST_DEFAULT, filter: "" };

  const del = /^del(?:\s+(\S+))?$/i.exec(arg);
  if (del) {
    // `del` 光杆也认作删除（报用法），不要掉到「搜索含 del 的标题」那条分支去 ——
    // 用户敲了 del 显然是想删，此时给一张搜索结果是拿他开玩笑
    const n = del[1] !== undefined && /^\d+$/.test(del[1]) ? parseInt(del[1], 10) : NaN;
    return { kind: "delete", index: Number.isFinite(n) && n >= 1 ? n : null };
  }

  if (/^\d+$/.test(arg)) {
    const n = parseInt(arg, 10);
    return { kind: "list", limit: Math.min(Math.max(n, 1), MAX_INDEXED_SESSIONS), filter: "" };
  }

  return { kind: "list", limit: LIST_DEFAULT, filter: arg };
}
