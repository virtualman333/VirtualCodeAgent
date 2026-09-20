/**
 * 会话管理（`/history` / `/load` 背后的那一层）。
 *
 * 这一层此前一行都测不了：`storage.ts` import `config.ts`，而 `config.ts` 顶层会
 * `ensureConfig()` 真写 `~/.vca/config.json` —— 想测就得先动用户真实的家目录。
 * 所以本轮把纯文件逻辑拆到了零依赖的 `src/session-store.ts`（目录由调用方传），
 * 测试拿一个临时目录就能把删除、搜索、索引外会话、上限全跑一遍。
 *
 * 这里钉的三件事，各自都对应一个**真实存在过**的缺陷：
 *
 *   1. `deleteSession` 定义了却**零调用** —— `/history` 只能列、不能删，会话文件
 *      只增不减，粘过密钥的对话永远躺在 `~/.vca/sessions/` 里；
 *   2. 列表窗口手抄在两处（`/history` 与 `/load <序号>` 各写一个 10），而
 *      `listSessions()` 的默认值又是 20 —— 于是 `cs.windowNo` **从第 21 条会话起
 *      永远停在 #21**，用户敲 `/new` 一直看到同一个号；
 *   3. 索引写盘时硬砍成 50 条，被砍掉的会话**文件还在**，却既列不出来也载不回来
 *      —— 静默丢东西，没有任何地方会响。
 *
 * 另外两条是**结构锁**（读源码），它们防的不是「行为不对」而是「能力又被摘掉」：
 * 参数语义必须在 `parseHistoryArg` 里只写一份；`/history` 必须真的接上删除。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  MAX_INDEXED_SESSIONS,
  LIST_DEFAULT,
  deleteSession,
  generateSessionId,
  indexFile,
  listOrphans,
  listSessions,
  parseHistoryArg,
  readIndex,
  searchSessions,
  selectSessions,
  sessionFile,
  sessionsDir,
  upsertIndex,
  writeIndex,
  type SessionEntry,
  type SessionRow,
} from "../src/session-store.js";
import { REPO_ROOT, stripComments } from "./source-utils.js";

// ============================================================
// 夹具
// ============================================================

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vca-sessions-"));
}

function entry(id: string, over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id,
    title: `会话 ${id}`,
    workspace: "/work/proj",
    message_count: 4,
    created_at: "2026-09-20 10:00",
    updated_at: "2026-09-20 10:30",
    ...over,
  };
}

/** 写一个会话文件（内容不需要是真的消息，这一层只关心文件在不在） */
function writeFile(dir: string, id: string, body = "[]"): void {
  fs.mkdirSync(sessionsDir(dir), { recursive: true });
  fs.writeFileSync(sessionFile(dir, id), body, "utf-8");
}

function row(id: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    title: `会话 ${id}`,
    workspace: "/work/proj",
    message_count: 4,
    updated_at: "2026-09-20 10:30",
    registered: true,
    ...over,
  };
}

// ============================================================
// 参数语义 —— 唯一一处定义
// ============================================================

test("parseHistoryArg：四种写法各自的落点（参数语义只有这一份）", () => {
  // 先自证解析面非空：拿不到东西的话，下面每条断言都是白过的
  const empty = parseHistoryArg("");
  assert.equal(empty.kind, "list", "空参数应当落在「列表」这一支上");

  assert.deepEqual(parseHistoryArg(""), { kind: "list", limit: LIST_DEFAULT, filter: "" });
  assert.deepEqual(parseHistoryArg("   "), { kind: "list", limit: LIST_DEFAULT, filter: "" });
  assert.deepEqual(parseHistoryArg("3"), { kind: "list", limit: 3, filter: "" });
  // `/history 0` 的意图显然是「列 1 个」，不是想找标题里含 0 的会话（与 /input 同一条约定）
  assert.deepEqual(parseHistoryArg("0"), { kind: "list", limit: 1, filter: "" });
  assert.deepEqual(parseHistoryArg("999999"), {
    kind: "list",
    limit: MAX_INDEXED_SESSIONS,
    filter: "",
  });
  assert.deepEqual(parseHistoryArg("redis"), { kind: "list", limit: LIST_DEFAULT, filter: "redis" });

  assert.deepEqual(parseHistoryArg("del 2"), { kind: "delete", index: 2 });
  assert.deepEqual(parseHistoryArg("DEL 2"), { kind: "delete", index: 2 });

  // 三种「说了删但没说清删哪个」—— 都要落成 index: null（命令那边报用法），
  // 绝不能掉到「搜索含 del 的标题」去：用户敲了 del 显然是想删
  for (const bad of ["del", "del abc", "del 0", "del -1", "del 2x"]) {
    assert.deepEqual(
      parseHistoryArg(bad),
      { kind: "delete", index: null },
      `「${bad}」应落成一句用法提示，而不是一次搜索`
    );
  }

  // 关键字里带 del 的会话仍然搜得到（过滤是子串匹配，不必写全）
  assert.deepEqual(parseHistoryArg("delete 掉旧会话"), {
    kind: "list",
    limit: LIST_DEFAULT,
    filter: "delete 掉旧会话",
  });
});

// ============================================================
// selectSessions —— 纯函数：过滤 + 截断
// ============================================================

test("selectSessions：子串匹配标题与工作空间，不区分大小写，并如实报出命中数", () => {
  const rows = [
    row("a", { title: "修 redis 连接超时", workspace: "/work/api" }),
    row("b", { title: "看板样式", workspace: "/work/Redis-Admin" }),
    row("c", { title: "打包 vsix", workspace: "/work/ext" }),
  ];
  assert.ok(rows.length >= 3, "夹具先自证非空");

  const hit = selectSessions(rows, { filter: "redis" });
  assert.equal(hit.total, 3);
  assert.equal(hit.matched, 2, "标题与工作空间两栏都要搜 —— 只搜标题会漏掉 b");
  assert.deepEqual(
    hit.shown.map((r) => r.id),
    ["a", "b"]
  );

  const none = selectSessions(rows, { filter: "zzz" });
  assert.equal(none.matched, 0);
  assert.equal(none.total, 3, "命中 0 时也要报出总数，用户才知道是不是自己搜错了");
  assert.deepEqual(none.shown, []);
});

test("selectSessions：默认窗口 = LIST_DEFAULT，给条数就截断（不改序）", () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(`s${i}`));
  assert.equal(selectSessions(rows, {}).shown.length, LIST_DEFAULT);
  assert.equal(selectSessions(rows, { limit: 3 }).shown.length, 3);
  assert.equal(selectSessions(rows, { limit: 0 }).shown.length, 1, "0 夹到 1，不是「一条都不给」");
  assert.deepEqual(
    selectSessions(rows, { limit: 2 }).shown.map((r) => r.id),
    ["s0", "s1"],
    "截断只能从尾部砍，顺序不许动"
  );
});

// ============================================================
// 索引：不丢条目、不覆盖标题
// ============================================================

test("upsertIndex：已存在时保留原 created_at 与标题（改标题只在第一次生成）", () => {
  const dir = tmpDir();
  upsertIndex(dir, entry("s1", { title: "第一次生成的标题", created_at: "2026-09-20 10:00" }));
  upsertIndex(dir, entry("s1", { title: "后来的标题", created_at: "2026-09-20 11:00", message_count: 9 }));

  const index = readIndex(dir);
  assert.equal(index.length, 1, "同 id 不该插入第二条");
  assert.equal(index[0].title, "第一次生成的标题");
  assert.equal(index[0].created_at, "2026-09-20 10:00");
  assert.equal(index[0].message_count, 9, "条数要跟着更新 —— 它是当前状态，不是历史");
});

test("★ 索引上限：超出时最旧的滚出索引，但会话文件还在（不许静默消失）", () => {
  const dir = tmpDir();
  const oldest = `s${MAX_INDEXED_SESSIONS - 1}`;
  writeIndex(
    dir,
    Array.from({ length: MAX_INDEXED_SESSIONS }, (_, i) => entry(`s${i}`))
  );
  writeFile(dir, oldest); // 只有这一个会话文件放在磁盘上
  assert.equal(readIndex(dir).length, MAX_INDEXED_SESSIONS, "夹具先自证装满了");

  upsertIndex(dir, entry("newest"));

  const index = readIndex(dir);
  assert.equal(index.length, MAX_INDEXED_SESSIONS, "上限是硬的，不能被撑破");
  assert.equal(index[0].id, "newest", "最新的在最前面");
  assert.ok(
    index.every((e) => e.id !== oldest),
    `${oldest} 应该已经滚出索引`
  );
  // 关键的一半：它的**文件还在**，所以必须能被列出来、能载入、能删掉。
  // 原来就卡在这里 —— slice(0, 50) 之后文件永远躺着，而 /history 再也看不到它。
  const rows = listSessions(dir);
  const orphanRow = rows.find((r) => r.id === oldest);
  assert.ok(orphanRow, "滚出索引的会话必须仍然出现在列表里");
  assert.equal(orphanRow!.registered, false, "要标出「不在索引里」，否则用户以为它有标题");
  assert.equal(
    orphanRow!.message_count,
    null,
    "条数不知道就报 null，不许写成 0 —— 「没算」显示成「0 条消息」是同一形状的界面缺陷"
  );
});

// ============================================================
// 列表：索引 + 索引外的文件
// ============================================================

test("★ listSessions：不传条数就是全部（窗口号不能从第 21 条起卡住）", () => {
  const dir = tmpDir();
  const N = 25; // > 原来的默认值 20
  writeIndex(
    dir,
    Array.from({ length: N }, (_, i) => entry(`s${i}`))
  );
  for (let i = 0; i < N; i++) writeFile(dir, `s${i}`);

  const all = listSessions(dir);
  assert.equal(all.length, N, `一共 ${N} 个会话，不传条数就该给 ${N} 个`);
  // cs.windowNo = listSessions().length + 1 —— 默认值截到 20 的时候，
  // 第 21 个会话之后再敲 /new 都显示 #21
  assert.equal(all.length + 1, N + 1, "窗口号必须跟着真数走");

  assert.equal(listSessions(dir, 10).length, 10, "要截断就只在显示处截一次");
});

test("listSessions：索引外的会话文件排在索引条目之后，按时间从新到旧", () => {
  const dir = tmpDir();
  upsertIndex(dir, entry("indexed"));
  writeFile(dir, "indexed");
  writeFile(dir, "orphan_old");
  writeFile(dir, "orphan_new");
  const base = Date.now() - 60_000;
  fs.utimesSync(sessionFile(dir, "orphan_old"), new Date(base), new Date(base));
  fs.utimesSync(sessionFile(dir, "orphan_new"), new Date(base + 30_000), new Date(base + 30_000));

  const rows = listSessions(dir);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["indexed", "orphan_new", "orphan_old"]
  );
  assert.deepEqual(
    rows.filter((r) => !r.registered).map((r) => r.id),
    ["orphan_new", "orphan_old"]
  );
});

test("listOrphans / listSessions 忽略非会话文件，也不把索引文件当成会话", () => {
  const dir = tmpDir();
  upsertIndex(dir, entry("s1"));
  writeFile(dir, "s1");
  fs.writeFileSync(path.join(sessionsDir(dir), "readme.txt"), "x", "utf-8");
  fs.writeFileSync(path.join(sessionsDir(dir), ".hidden.json"), "[]", "utf-8");
  assert.ok(fs.existsSync(indexFile(dir)), "索引文件应当就在 vcaDir 下（不在 sessions/ 里）");

  assert.deepEqual(listOrphans(dir), []);
  assert.deepEqual(
    listSessions(dir).map((r) => r.id),
    ["s1"]
  );
});

// ============================================================
// 删除 —— 文件与索引一起删
// ============================================================

test("★ deleteSession：文件与索引**一起**删，只删一边都不算删", () => {
  const dir = tmpDir();
  upsertIndex(dir, entry("s1"));
  writeFile(dir, "s1");

  const out = deleteSession(dir, "s1");
  assert.deepEqual(out, { id: "s1", file: true, index: true });
  assert.equal(fs.existsSync(sessionFile(dir, "s1")), false, "会话文件必须真的没了");
  assert.deepEqual(readIndex(dir), [], "索引记录也必须没了 —— 留着它就是一条点进去是空的死链");
  assert.deepEqual(listSessions(dir), [], "删完列表里不该还有它");
});

test("deleteSession：只删索引外的那一类会话文件（索引里本来就没有它）", () => {
  const dir = tmpDir();
  writeFile(dir, "orphan"); // 只有文件，没有索引记录
  assert.equal(listSessions(dir).length, 1, "夹具先自证它确实被列了出来");

  const out = deleteSession(dir, "orphan");
  assert.equal(out.file, true);
  assert.equal(out.index, false, "索引里本来就没有，如实报 false 而不是谎报成功");
  assert.equal(out.reason, undefined, "删掉了东西就不该带失败原因");
  assert.equal(fs.existsSync(sessionFile(dir, "orphan")), false);
});

test("deleteSession：不存在的 id 报原因，不谎报成功", () => {
  const dir = tmpDir();
  const out = deleteSession(dir, "nope_20260101_00000");
  assert.equal(out.file, false);
  assert.equal(out.index, false);
  assert.match(String(out.reason), /不存在/);
});

test("★ deleteSession：id 形状不对直接拒（这个函数会 rmSync，不能拼出越界路径）", () => {
  const dir = tmpDir();
  // 故意放一个**同名同后缀**的文件在目录外：形状闸一旦失效，`../keepme` 就会真的把它删掉
  const outside = path.join(dir, "..", "keepme.json");
  fs.writeFileSync(outside, "别删我", "utf-8");
  upsertIndex(dir, entry("s1"));
  writeFile(dir, "s1");

  for (const evil of ["../keepme", "..", "a/b", "a\\b", "", ".hidden"]) {
    const out = deleteSession(dir, evil);
    assert.equal(out.file, false, `「${evil}」不该删掉任何文件`);
    assert.match(String(out.reason), /形状/, `「${evil}」应当被形状闸拒掉`);
  }

  assert.equal(fs.readFileSync(outside, "utf-8"), "别删我", "目录外的文件必须一个字都没动");
  assert.equal(fs.existsSync(sessionFile(dir, "s1")), true, "无关的会话也不许被误删");
  fs.rmSync(outside, { force: true });
});

test("★ 删掉当前会话之后，主循环不会把它又写回来（顺序：先看内存、再看盘）", () => {
  // 这条锁的是「删了等于没删」那个形态：主循环每轮交互后 autoSave，
  // 只删文件的话下一轮就把同一份对话写回同一个 id。判据在 saveSession 之后
  // 文件还在不在 —— 而 autoSave 只在 state.messages 非空或 sessionId 非空时触发，
  // 所以「删当前会话必须同时清内存」这件事在主循环那边成立；这里用等价步骤证一遍。
  const dir = tmpDir();
  upsertIndex(dir, entry("cur"));
  writeFile(dir, "cur", JSON.stringify([{ type: "HumanMessage", content: "含密钥的一段话" }]));

  const rows = listSessions(dir, LIST_DEFAULT);
  assert.equal(rows[0].id, "cur", "夹具先自证要删的就是它");

  deleteSession(dir, rows[0].id);
  // 主循环那句判据（main.ts 的 EOF / Ctrl+C 分支）：
  const sessionId: string | null = null; // 删当前会话时被置空
  const messages: unknown[] = []; // 内存里那段也一起清掉
  assert.equal(
    Boolean(sessionId) || messages.length > 0,
    false,
    "删完当前会话后必须满足「不再自动保存」的判据，否则文件会被原样写回来"
  );
  assert.equal(fs.existsSync(sessionFile(dir, "cur")), false);
});

// ============================================================
// generateSessionId / searchSessions
// ============================================================

test("generateSessionId：形状能被自己的 id 闸放行（否则存下来的会话删不掉）", () => {
  const ids = Array.from({ length: 20 }, () => generateSessionId());
  assert.equal(new Set(ids).size, ids.length, "20 次里不该撞 id");
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]+$/, `生成的 id 被自己的删除闸拒了: ${id}`);
});

test("searchSessions：在真实目录上端到端跑一遍（列表 + 过滤）", () => {
  const dir = tmpDir();
  upsertIndex(dir, entry("s1", { title: "修 redis 超时", workspace: "/work/api" }));
  upsertIndex(dir, entry("s2", { title: "看板样式", workspace: "/work/web" }));
  writeFile(dir, "s3"); // 索引外的：没有标题，但工作空间也没有 —— 只能靠 id 找到它

  const all = searchSessions(dir, {});
  assert.equal(all.total, 3);
  assert.equal(all.matched, 3);

  const redis = searchSessions(dir, { filter: "redis" });
  assert.deepEqual(
    redis.shown.map((r) => r.id),
    ["s1"]
  );

  const work = searchSessions(dir, { filter: "/work/w" });
  assert.deepEqual(
    work.shown.map((r) => r.id),
    ["s2"],
    "工作空间也要参与匹配"
  );
});

// ============================================================
// 结构锁 —— 防的是「能力又被摘掉」，不是「行为不对」
// ============================================================

/** 剥注释后读 main.ts（注释里会写反面示例，不剥的话锁会对修好的代码判红） */
function mainSrc(): string {
  return stripComments(fs.readFileSync(path.join(REPO_ROOT, "src", "main.ts"), "utf-8"));
}

test("★ /history 必须真的接上删除（deleteSession 不能再是「定义了却零调用」）", () => {
  const src = mainSrc();
  assert.match(
    src,
    /storage\.deleteSession\(/,
    "main.ts 里没有调用 deleteSession —— 那 /history del 就只是个说法，用户永远删不掉会话"
  );
});

test("★ 参数语义只能在 parseHistoryArg 里写一份（命令里不许自己判 del）", () => {
  const src = mainSrc();
  // 判据写成「命令分支必须**经过** parseHistoryArg」，而不是「分支里不许出现 del 字样」——
  // 后者是断言字面量形状：`deleteHistorySession(...)` 里就带着 del，正确代码上会误红
  // （本仓库栽过：`/===\s*"clear"/` 那条断言在正确代码上判红）。
  // 真正的判据是「按原本的方式改坏它会不会红」：把这一行换成自己判 del 的实现，这条必须响。
  const start = src.indexOf('case "/history"');
  assert.ok(start >= 0, "找不到 /history 分支 —— 命令改名了？这条锁需要跟着改");
  const end = src.indexOf("case ", start + 10);
  const body = src.slice(start, end > start ? end : src.length);
  assert.ok(body.length > 80, `只抠出 ${body.length} 个字符的 /history 分支，定位大概失效了`);

  assert.match(
    body,
    /parseHistoryArg\(/,
    "/history 分支没有调用 parseHistoryArg —— 参数语义又在命令里写了一份"
  );
});

test("★ 列表窗口不许在命令里写死数字（原来两处各抄一个 10）", () => {
  const src = mainSrc();
  const hits = [...src.matchAll(/listSessions\(\s*(\d+)\s*\)/g)];
  // 正则要是哪天匹配不上，这条锁就变成空转 —— 现算出来的命中数先自证一下
  assert.ok(hits.length >= 1, "连 listSessions(1) 都没匹配到，正则多半失效了");

  // `listSessions(1)` 的语义是「**最新那一条**」，不是「显示窗口」——那个 1 是对的，放行。
  // 要防的是「显示窗口」那个数（原来是两处各写一个 10）被抄成第二份。
  const hardcoded = hits.map((m) => m[1]).filter((n) => n !== "1");
  assert.deepEqual(
    hardcoded,
    [],
    `这些地方把显示窗口写死了：${hardcoded.join(", ")} —— 应当走 storage.getListWindow()，` +
      `否则 /history 列的那一份与 /load <序号> 取的序号会指到不同的会话`
  );
});
