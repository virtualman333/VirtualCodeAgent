/**
 * Tab 补全的测试。
 *
 * 全部跑在临时目录上，不碰真实工作空间，也不需要终端 —— completeInput 是
 * 纯函数，喂一行字符串就能验。
 *
 * ⚠ 这里有个容易写错的地方：返回值是 `[hits, token]`，readline 用命中项替换
 * **token 那一段**（行尾那截），不是整行。所以「token 必须是行尾那一段」
 * 本身也要有断言：它一旦写成整行，补全会把前面已经敲好的命令名一起吃掉，
 * 而症状只是「结果不对」，很难一眼看出是 token 的问题。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { MAX_HITS, completeInput, type CompleterContext } from "../src/completer.js";
import { commandNames } from "../src/help.js";
import { expandUser } from "../src/paths.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 一棵可控的临时目录树；返回根目录（不带尾分隔符） */
function makeTree(): { root: string; sep: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vca-cmp-"));
  for (const d of ["alpha", "beta", "gamma", ".hidden-dir"]) {
    fs.mkdirSync(path.join(root, d));
  }
  fs.writeFileSync(path.join(root, "afile.txt"), "x");
  fs.mkdirSync(path.join(root, "alpha", "nested"));
  return { root, sep: path.sep };
}

function ctxOf(cwd: string): CompleterContext {
  return {
    commands: commandNames(), // 命令清单的唯一来源就是它，这里不另抄一份
    configKeys: ["MAX_CONTEXT_TOKENS", "MAX_TOOL_ITERATIONS", "OPENAI_API_KEY"],
    models: ["default", "deepseek", "gpt-4o-mini"],
    cwd,
  };
}

// ============================================================
// 命令名补全
// ============================================================

test("★ 命令清单不是本模块自己抄的：补全结果必须与 help.ts 一致", () => {
  const [hits] = completeInput("/", ctxOf(process.cwd()));
  assert.deepEqual(
    [...hits].sort(),
    [...commandNames()].sort(),
    "补全候选与 help.ts 的命令清单对不上 —— 有人加命令时漏了同步"
  );
});

test("★ 唯一命中时补一个尾空格，接着就能敲参数", () => {
  const [hits, token] = completeInput("/he", ctxOf(process.cwd()));
  assert.deepEqual(hits, ["/help "], "唯一命中应带尾空格");
  assert.equal(token, "/he");
});

test("★ 多命中时不补尾空格（列表里看着才对）", () => {
  const [hits] = completeInput("/", ctxOf(process.cwd()));
  assert.ok(hits.length > 1, "这个用例要求 '/' 能匹配到多个命令");
  for (const h of hits) {
    assert.equal(h.endsWith(" "), false, `${h} 不该带尾空格`);
  }
});

test("大小写不敏感（命令本身都是小写，不用为难用户）", () => {
  assert.deepEqual(completeInput("/HE", ctxOf(process.cwd()))[0], ["/help "]);
});

test("匹配不到任何命令时返回空候选，而不是 null", () => {
  const [hits, token] = completeInput("/zzz", ctxOf(process.cwd()));
  assert.deepEqual(hits, []);
  assert.equal(token, "/zzz");
});

// ============================================================
// 不该补全的地方 —— 一条都不能补
// ============================================================

test("★ 不以 / 开头的输入一律不补（那是给 Agent 的自然语言任务描述）", () => {
  for (const line of ["帮我改个 bug", "vca 怎么用", "cd /tmp", "  /help"]) {
    assert.deepEqual(completeInput(line, ctxOf(process.cwd())), [[], ""], `「${line}」不该给候选`);
  }
});

test("★ 同一段文字，只有放进命令上下文才补 —— 这条锁防的是「到处都补」", () => {
  // 用真实存在的目录名当输入：如果哪天有人把补全放开成「全局路径补全」
  // （Python 版就是全局的），`alpha` 这一行会立刻冒出候选、这条断言就红了。
  // 上面那条用例里的「帮我改个 bug」没有可匹配的目录，即使回归也照样绿 ——
  // 那种断言抓不到回归。
  const { root, sep } = makeTree();
  const ctx = ctxOf(root);
  assert.deepEqual(completeInput("alpha", ctx), [[], ""], "普通输入不该补路径");
  assert.deepEqual(completeInput("/cd alpha", ctx)[0], [`alpha${sep}`], "同名的词放进命令上下文就该补出来");
});

test("未知命令的参数不补（`/nope ` 别硬塞路径候选）", () => {
  const [hits, token] = completeInput("/nope ", ctxOf(process.cwd()));
  assert.deepEqual(hits, []);
  assert.equal(token, "");
});

test("不在补全范围内的命令（/load 要的是数字）不给候选", () => {
  assert.deepEqual(completeInput("/load 1", ctxOf(process.cwd()))[0], []);
  assert.deepEqual(completeInput("/history ", ctxOf(process.cwd()))[0], []);
  assert.deepEqual(completeInput("/save ", ctxOf(process.cwd()))[0], []);
});

// ============================================================
// token 必须是行尾那一段
// ============================================================

test("★ token 是行尾那一段，不是整行也不是整段参数", () => {
  const { root, sep } = makeTree();
  const arg = `${root}${sep}al`;
  const [hits, token] = completeInput(`/cd ${arg}`, ctxOf(process.cwd()));
  assert.equal(token, arg, "token 必须正好是行尾那截（写成整行会把 `/cd ` 一起替换掉）");
  assert.deepEqual(hits, [`${root}${sep}alpha${sep}`]);
});

test("★ token 在 `/config set KEY` 里是那个键，不是 'set KEY'", () => {
  const [, token] = completeInput("/config set MAX", ctxOf(process.cwd()));
  assert.equal(token, "MAX");
});

// ============================================================
// /config
// ============================================================

test("★ `/config ` 补子命令，`/config set ` 补配置键", () => {
  assert.deepEqual(completeInput("/config ", ctxOf(process.cwd()))[0], ["set "]);
  assert.deepEqual(completeInput("/config se", ctxOf(process.cwd()))[0], ["set "]);

  const [keys, token] = completeInput("/config set ", ctxOf(process.cwd()));
  assert.equal(token, "");
  assert.deepEqual(keys, ["MAX_CONTEXT_TOKENS", "MAX_TOOL_ITERATIONS", "OPENAI_API_KEY"]);
});

test("`/config set` 后面只补前缀命中的键", () => {
  assert.deepEqual(completeInput("/config set MAX", ctxOf(process.cwd()))[0], [
    "MAX_CONTEXT_TOKENS",
    "MAX_TOOL_ITERATIONS",
  ]);
  assert.deepEqual(completeInput("/config set OPENAI_API_KEY nope", ctxOf(process.cwd()))[0], [], "补到第三个 token（值）就不该再给键了");
});

test("`/config` 的非 set 用法不补", () => {
  assert.deepEqual(completeInput("/config X", ctxOf(process.cwd()))[0], []);
});

// ============================================================
// /model
// ============================================================

test("★ `/model` 补模型名（唯一命中带尾空格）", () => {
  assert.deepEqual(completeInput("/model ", ctxOf(process.cwd()))[0], ["default", "deepseek", "gpt-4o-mini"]);
  // 注意 `de` 同时命中 default 与 deepseek，是**两**个候选，不带尾空格
  assert.deepEqual(completeInput("/model de", ctxOf(process.cwd()))[0], ["default", "deepseek"]);
  assert.deepEqual(completeInput("/model deep", ctxOf(process.cwd()))[0], ["deepseek "]);
  assert.deepEqual(completeInput("/model zz", ctxOf(process.cwd()))[0], []);
});

test("★ 模型清单为空时 /model 不炸（没配 MODELS 的机器上 list 可能是空的）", () => {
  const ctx = { ...ctxOf(process.cwd()), models: [] };
  assert.doesNotThrow(() => completeInput("/model ", ctx));
  assert.deepEqual(completeInput("/model ", ctx)[0], []);
});

// ============================================================
// /cd —— 路径补全
// ============================================================

test("★ `/cd <目录><sep>` 列出子目录，且只列目录", () => {
  const { root, sep } = makeTree();
  const [hits] = completeInput(`/cd ${root}${sep}`, ctxOf(process.cwd()));
  const names = hits.map((h) => h.slice(root.length + sep.length));
  assert.deepEqual(names.sort(), [".hidden-dir", "alpha", "beta", "gamma"].map((n) => n + sep).sort());
  assert.equal(names.some((n) => n.includes("afile.txt")), false, "文件不该出现在候选里");
});

test("★ 候选原样带回用户敲的前缀，不会被改写成别的形式", () => {
  const { root, sep } = makeTree();
  const [hits] = completeInput(`/cd ${root}${sep}`, ctxOf(process.cwd()));
  assert.ok(hits.length > 0, "这个用例需要候选非空");
  for (const h of hits) {
    assert.ok(h.startsWith(`${root}${sep}`), `${h} 丢了用户敲的前缀`);
  }
});

test("前缀过滤只看名字那一段", () => {
  const { root, sep } = makeTree();
  const [hits] = completeInput(`/cd ${root}${sep}al`, ctxOf(process.cwd()));
  assert.deepEqual(hits, [`${root}${sep}alpha${sep}`]);
});

test("★ 目录不存在（路径敲到一半 / 名字打错）时安静返回空候选，不抛异常", () => {
  const { root, sep } = makeTree();
  assert.deepEqual(completeInput(`/cd ${root}${sep}nope${sep}`, ctxOf(process.cwd()))[0], []);
  assert.deepEqual(completeInput(`/cd ${root}${sep}does-not-exist/`, ctxOf(process.cwd()))[0], []);
});

test("★ 相对路径以工作空间为基准（不是以进程 cwd 为基准）", () => {
  const { root, sep } = makeTree();
  const ctx = ctxOf(root);
  assert.deepEqual(completeInput("/cd al", ctx)[0], [`alpha${sep}`]);
  // 敲了 `/` 就补 `/`（分隔符跟着用户写的走），所以这里不是 path.sep
  assert.deepEqual(completeInput("/cd ./al", ctx)[0], ["./alpha/"]);
});

test("★ 候选顺序跟着调用方给的清单走，不在这里另排一遍", () => {
  const ctx = { ...ctxOf(process.cwd()), commands: ["/zzz", "/aaa"] };
  assert.deepEqual(completeInput("/", ctx)[0], ["/zzz", "/aaa"], "/model 的编号与命令列表的顺序都不该被 Tab 打乱");
});

test("★ 候选有上限，在根目录按 Tab 不该把整屏刷掉", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vca-cmp-many-"));
  for (let i = 0; i < MAX_HITS + 20; i++) {
    fs.mkdirSync(path.join(root, `proj-${String(i).padStart(3, "0")}`));
  }
  const [hits] = completeInput(`/cd ${root}${path.sep}`, ctxOf(process.cwd()));
  assert.equal(hits.length, MAX_HITS, `候选应被截到 ${MAX_HITS} 条`);
});

test("分隔符跟着用户写的走：敲 `/` 就补 `/`，不混出两种分隔符", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vca-cmp-sep-"));
  fs.mkdirSync(path.join(root, "child"));
  const asPosix = root.replace(/\\/g, "/");
  const [hits] = completeInput(`/cd ${asPosix}/`, ctxOf(process.cwd()));
  assert.deepEqual(hits, [`${asPosix}/child/`]);
});

test("`/cd ` 不带参数时列当前工作空间的子目录", () => {
  const { root, sep } = makeTree();
  const [hits, token] = completeInput("/cd ", ctxOf(root));
  assert.equal(token, "");
  assert.ok(hits.includes(`alpha${sep}`), `应列出工作空间下的目录，实际: ${JSON.stringify(hits)}`);
});

// ============================================================
// expandUser（从 config.ts 挪到 paths.ts，这里顺手钉住语义）
// ============================================================

test("expandUser: `~` 展开成家目录，其余原样返回", () => {
  assert.equal(expandUser("~"), os.homedir());
  assert.equal(expandUser("~/proj"), path.join(os.homedir(), "proj"));
  assert.equal(expandUser("~\\proj"), path.join(os.homedir(), "proj"));
  assert.equal(expandUser("/abs/path"), "/abs/path");
  assert.equal(expandUser("rel/path"), "rel/path");
  assert.equal(expandUser(""), "");
});

test("★ completeInput 不 import config.js（否则测试会顺手改用户的 ~/.vca/config.json）", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "completer.ts"), "utf-8");
  assert.equal(
    /from\s+"\.\/config\.js"/.test(src),
    false,
    "completer.ts 一旦 import config.js，测试就会触发 ensureConfig() 去写真实磁盘"
  );
  assert.equal(
    /from\s+"\.\/config\.js"/.test(fs.readFileSync(path.join(ROOT, "src", "input-history.ts"), "utf-8")),
    false,
    "input-history.ts 同理：它只收一个文件路径进来"
  );
});
