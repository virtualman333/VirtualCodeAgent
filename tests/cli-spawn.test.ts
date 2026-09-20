/**
 * 入口冒烟测试 —— 真的把 CLI 当子进程跑起来，看它到底输出什么、退出码是几。
 *
 * 为什么必须在子进程层面测，而不是只测函数：
 * 上一轮踩到的坑是**入口守卫**在 Windows 上永不成立，`npm run dev` / `npm start`
 * 一行输出都没有就退出。这种故障在所有单元测试里都是绿的 —— 因为被测的函数
 * 一个都没被调用。判据很简单：**stdout 是空的就说明 main() 压根没跑**。
 *
 * 另外这里还锁住「帮助不被 API Key 挡在门外」：测试把 USERPROFILE 指到空目录，
 * 于是配置文件不存在、模型没有 key。此时
 *   vca --help   → 退出码 0，能看到完整帮助
 *   vca（无参数）→ 退出码 1，提示去填 API Key
 * 两条一起断言，才说明顺序是对的（而不是「恰好都返回 0」）。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { displayWidth, stripAnsi } from "../src/ui.js";
import { parseHistory } from "../src/input-history.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "src", "main.ts");
const PKG_VERSION = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")) as {
  version: string;
}).version;

/** 一个没有 ~/.vca/config.json 的空「家目录」——用来模拟首次安装 */
function emptyHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vca-smoke-"));
}

/**
 * 一个「装好了、填了 key」的家目录 —— 用来越过 API Key 校验、进到交互循环。
 * 工作空间就用家目录本身（配合 -w 传进去），免得再弹「选择工作空间」。
 */
function readyHome(): string {
  const home = emptyHome();
  fs.mkdirSync(path.join(home, ".vca"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".vca", "config.json"),
    JSON.stringify(
      {
        OPENAI_API_KEY: "sk-test-not-a-real-key",
        OPENAI_BASE_URL: "https://example.invalid/v1",
        OPENAI_MODEL: "gpt-4o-mini",
        DEFAULT_MODEL: "gpt-4o-mini",
        WORKSPACE_DIR: home,
        MAX_TOOL_ITERATIONS: 10,
        MAX_CONTEXT_TOKENS: 100000,
      },
      null,
      2
    ),
    "utf-8"
  );
  return home;
}

/**
 * 往家目录里放一份输入历史 —— **用 prompt_toolkit 的真实格式**，不是本模块自己那套。
 *
 * 真实文件（~/.vca/input_history）长这样：开头一个空行，然后每条是
 * 「`# 时间戳` + `+内容`」，条目之间夹一个空行。
 *
 * 为什么必须照抄它：这一层顺带成了跨语言契约的端到端验证。喂一份「理想化」的
 * 裸行文件，`+` 前缀没被剥掉这件事就永远暴露不出来 —— 本仓库实测，旧写法下
 * ↑ 翻出来的每条历史前面都挂着一个 `+`，而所有测试都是绿的。
 */
function seedHistory(home: string, lines: string[]): void {
  const text =
    "\n" + lines.map((l) => `# 2026-08-11 10:27:28.049413\n+${l}\n`).join("\n");
  fs.writeFileSync(path.join(home, ".vca", "input_history"), text, "utf-8");
}

const HISTORY_FILE = (home: string): string => path.join(home, ".vca", "input_history");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], home?: string, stdin?: string): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (home) {
    // Windows 上 os.homedir() 认 USERPROFILE，macOS/Linux 认 HOME，两个都设上
    env.USERPROFILE = home;
    env.HOME = home;
  }
  // 不给 stdin 就直接接 /dev/null：万一流程掉进 promptUser，readline 立刻 EOF 退出，
  // 测试不会挂住（真实的「静默卡在等输入」故障也就能被看见，而不是超时）。
  //
  // ⚠ 给了 stdin 也只会有**第一行**生效：promptUser 每读完一行就把 readline 关掉，
  // 它已经读进内部缓冲的后续行会一起丢掉（这是 README 里记着的既有行为）。
  // 所以这里一次只喂一条命令 —— 想测一串命令得按命令拆成多次 spawn。
  const r = spawnSync(process.execPath, ["--import", "tsx", ENTRY, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf-8",
    input: stdin ?? undefined,
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: 120_000,
  });
  assert.equal(r.error, undefined, `子进程启动失败: ${r.error?.message}`);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 在「装好了」的家目录里跑**一条**斜杠命令 */
function runCommand(home: string, command: string): RunResult {
  return runCli(["-w", home], home, command + "\n");
}

/**
 * 去掉 ANSI 之后的 stdout。
 * 断言列表内容必须走这里：序号是单独上色的（`  \e[36m 1\e[0m. xxx`），
 * 直接拿带色文本去 match `1\. xxx` 会永远不匹配 —— 功能是好的，
 * 红的是断言自己。
 */
function plain(stdout: string): string {
  return stripAnsi(stdout);
}

test("★ 入口守卫：main() 真的被执行了（stdout 不为空）", () => {
  const r = runCli(["--version"]);
  assert.notEqual(r.stdout.trim(), "", "stdout 是空的 —— main() 没跑，入口守卫坏了");
  assert.equal(r.status, 0);
});

test("★ --help 在任何情况下都能看到：即使还没填 API Key", () => {
  const r = runCli(["--help"], emptyHome());
  assert.equal(r.status, 0, `退出码应为 0，实际 ${r.status}；stderr=${r.stderr}`);
  const out = r.stdout;
  assert.match(out, /用法: vca \[选项\]/);
  assert.match(out, /-w, --workspace/);
  assert.match(out, /-m, --model/);
  assert.match(out, /可用命令:/);
  assert.match(out, /\/skills/);
  assert.doesNotMatch(out, /请在配置文件中填入你的 API Key/, "帮助被 API Key 校验挡住了");
  // 帮助里不该掉进交互选择（注意不能只判「选择工作空间」——用法说明里就有这五个字）
  assert.doesNotMatch(out, /回车=最近/);
});

test("对照：没参数且没 key 时，正常启动必须失败并提示填 key", () => {
  const r = runCli([], emptyHome());
  assert.equal(r.status, 1, `退出码应为 1，实际 ${r.status}`);
  assert.match(r.stdout, /请在配置文件中填入你的 API Key/);
});

test("--version 输出 package.json 里的真实版本号", () => {
  const r = runCli(["--version"], emptyHome());
  assert.equal(r.status, 0);
  assert.match(r.stdout, new RegExp(`vca\\s+${PKG_VERSION.replace(/\./g, "\\.")}`));
});

test("★ 未知参数：退出码 2、写到 stderr、并附用法", () => {
  const r = runCli(["--hlep"], emptyHome());
  assert.equal(r.status, 2, `退出码应为 2，实际 ${r.status}`);
  assert.match(r.stderr, /未知参数 --hlep/);
  assert.match(r.stderr, /--help/, "应提示正确写法");
  assert.match(r.stderr, /用法: vca/);
  // 用法要落在 stderr 上：stdout 可能正被管道消费，混进去会把数据流弄脏。
  // （不能断言 stdout 完全为空 —— 首次运行时 ensureConfig() 会往 stdout 打一行 [INFO]）
  assert.doesNotMatch(r.stdout, /用法: vca/);
});

test("★ 缺值的选项：退出码 2，不再静默用默认模型启动", () => {
  const r = runCli(["-m"], emptyHome());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /-m 后面要跟一个值/);
});

test("--list-workspaces 在空家目录下是「暂无历史记录」且退出码 0", () => {
  const r = runCli(["--list-workspaces"], emptyHome());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /暂无历史记录/);
});

test("--help 与 --badflag 同时给时，帮助照样出来（帮助是特权选项）", () => {
  const r = runCli(["--badflag", "--help"], emptyHome());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /可用命令:/);
});

// ============================================================
// /input —— 输入历史不能只是个按 ↑ 的暗盒
// ============================================================
//
// 这一节必须落在子进程层：`/input` 的成败取决于「主循环先记历史再执行命令」
// 这个顺序、以及 cs.inputHistory 与 ↑ 用的是不是同一个数组 —— 两样都在
// main() 里，纯函数测试一条都盖不到。

const SEED = [
  "修一下 Windows 上 CLI 没输出的问题",
  "帮我看看这段 redis 连接超时的报错",
  "把 web 面板的样式改一下",
  "redis 缓存策略要怎么设计",
  "加一个 /input 命令",
];

test("★ /input：列出输入历史，最新在前，序号与 ↑ 对得上", () => {
  const home = readyHome();
  seedHistory(home, SEED);
  const r = runCommand(home, "/input");
  assert.equal(r.status, 0, `stderr=${r.stderr}`);

  assert.match(plain(r.stdout), /输入历史 · 最近 5 \/ 5 条（最新在前）:/);
  // 刚敲的这条 /input 不该占着第一行（主循环先记历史，所以它确实在历史里）
  assert.doesNotMatch(plain(r.stdout), /1\. \/input\n/, "列表里出现了当前这次调用自己");
  assert.match(plain(r.stdout), /1\. 加一个 \/input 命令/);
  assert.match(plain(r.stdout), /5\. 修一下 Windows 上 CLI 没输出的问题/);
  // 顺序：第 2 条（最近的 redis）必须排在第 5 条（最早的）前面
  assert.ok(
    plain(r.stdout).indexOf("2. redis 缓存策略要怎么设计") <
      plain(r.stdout).indexOf("5. 修一下 Windows 上 CLI 没输出的问题")
  );
});

test("★ /input <关键字>：子串过滤（不区分大小写），并如实报出命中数", () => {
  const home = readyHome();
  seedHistory(home, SEED);
  const r = runCommand(home, "/input redis");
  assert.equal(r.status, 0, `stderr=${r.stderr}`);

  assert.match(plain(r.stdout), /输入历史 · 匹配「redis」 2 \/ 5 条:/);
  assert.match(plain(r.stdout), /redis 缓存策略要怎么设计/);
  assert.match(plain(r.stdout), /帮我看看这段 redis 连接超时的报错/);
  assert.doesNotMatch(plain(r.stdout), /把 web 面板的样式改一下/, "没命中的不该出现");
  assert.doesNotMatch(plain(r.stdout), /加一个 \/input 命令/, "没命中的不该出现");
});

test("/input <关键字>：匹配不到时说清楚，而不是打一张空表", () => {
  const home = readyHome();
  seedHistory(home, SEED);
  const r = runCommand(home, "/input zzz-不存在");
  assert.match(plain(r.stdout), /没有匹配「zzz-不存在」的输入历史（共 5 条）/);
});

test("★ /input <条数>：只截断不改序，并提示还有多少条", () => {
  const home = readyHome();
  seedHistory(home, SEED);
  const r = runCommand(home, "/input 2");
  assert.match(plain(r.stdout), /输入历史 · 最近 2 \/ 5 条（最新在前）:/);
  assert.match(plain(r.stdout), /1\. 加一个 \/input 命令/);
  assert.match(plain(r.stdout), /2\. redis 缓存策略要怎么设计/);
  assert.doesNotMatch(plain(r.stdout), /3\. /, "只要了 2 条，不该给出第 3 条");
  assert.match(plain(r.stdout), /…还有 3 条没显示（\/input <条数> 看更多）/);
});

test("★ /input clear：内存与文件一起清（重启后不能又冒出来）", () => {
  const home = readyHome();
  seedHistory(home, SEED);
  const r = runCommand(home, "/input clear");
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  // 6 = 5 条种子 + 刚敲的这条 clear 自己（它也会被清掉，所以如实说明）
  assert.match(plain(r.stdout), /输入历史已清空/);
  assert.match(plain(r.stdout), /\(6 条，含刚敲的这一条\)/);
  assert.equal(fs.readFileSync(HISTORY_FILE(home), "utf-8"), "", "文件必须也是空的");

  // 再跑一次 /input 验证「清空是持久的」：新进程重新 readHistory 得到空数组，
  // 只把这次调用自己记为历史，而它会被 skip 掉 → 应当报「还没有输入历史」
  const again = runCommand(home, "/input");
  assert.match(plain(again.stdout), /还没有输入历史。/);
});

test("/input：全新家目录下是「还没有输入历史」，不是一张只写着自己的空表", () => {
  const home = readyHome();
  const r = runCommand(home, "/input");
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(plain(r.stdout), /还没有输入历史。/);
  assert.doesNotMatch(plain(r.stdout), /最近 1 \/ 1 条/);
});

test("/help 里能看到 /input（命令清单的唯一来源是 help.ts）", () => {
  const r = runCli(["--help"], emptyHome());
  assert.match(plain(r.stdout), /\/input \[条数\]/);
  assert.match(plain(r.stdout), /查看 \/ 搜索 \/ 清空输入历史/);
});

test("/input：命令本身也进历史（shell 的惯例），下一轮 /input 能看到它", () => {
  const home = readyHome();
  seedHistory(home, SEED);
  runCommand(home, "/input 2");
  const onDisk = parseHistory(fs.readFileSync(HISTORY_FILE(home), "utf-8"));
  assert.equal(onDisk[0], "/input 2", "刚敲的命令是最新的一条（内存里最新在前）");
  assert.equal(onDisk.length, SEED.length + 1, "历史里应恰好比种子多一条");
  assert.deepEqual(
    onDisk.slice(1),
    [...SEED].reverse(),
    "种子仍然原样在，而且没有被加号前缀污染"
  );
});

test("★ 落盘后仍是 prompt_toolkit 认得的格式（Python 版读得回来）", () => {
  // 这条只有在子进程层才成立：要跑过真入口，才知道真正写盘的是哪个函数。
  const home = readyHome();
  seedHistory(home, SEED);
  runCommand(home, "/input 2");

  const raw = fs.readFileSync(HISTORY_FILE(home), "utf-8");
  const nonEmpty = raw.split("\n").filter((l) => l !== "");
  assert.ok(nonEmpty.length > 0, "文件不该是空的");
  for (const line of nonEmpty) {
    assert.ok(
      line.startsWith("+") || line.startsWith("#"),
      `「${line}」既不是 + 条目也不是 # 时间戳 —— prompt_toolkit 只会拿它当分隔符，内容静默丢失`
    );
  }
  // 21 条进去 21 条出来：少了分隔行的话 Python 版会把它们并成一条多行历史
  assert.equal(
    nonEmpty.filter((l) => l.startsWith("+")).length,
    SEED.length + 1,
    "`+` 条目数必须与历史条数一一对应"
  );
  // 相邻两行不能都是 `+` —— 那说明缺了分隔行，prompt_toolkit 会把它们并成一条
  const allLines = raw.split("\n");
  for (let i = 1; i < allLines.length; i++) {
    assert.ok(
      !(allLines[i].startsWith("+") && allLines[i - 1].startsWith("+")),
      `第 ${i} 行与上一行都是 + 条目（缺分隔行）`
    );
  }
});

// ============================================================
// 启动面板对齐 —— 只能在这里锁
// ============================================================
//
// 面板的宽度取决于「终端列数 + 内容里每行的中文数量」，纯函数测试只能喂假数据；
// 而真正的用户第一眼看到的就是这块框。原先 panel 用 `stripAnsi(l).length` 量
// 行宽，中文一个占 2 列却只占 1 个码元 —— 右边框于是逐行忽左忽右，且不报错。
// 这里直接跑真入口，量输出里每一条框线的显示宽度。

test("★ 启动面板：输出里每一条框线等宽（真实入口，不是喂假数据）", () => {
  const home = readyHome();
  const r = runCli(["-w", home], home, "");
  assert.equal(r.status, 0, `stderr=${r.stderr}`);

  const boxed = r.stdout.split("\n").filter((l) => /^[│┌└]/.test(stripAnsi(l)));
  assert.ok(boxed.length >= 9, `只认出 ${boxed.length} 条框线 —— 判定条件大概失效了，或面板没画出来`);
  assert.match(stripAnsi(boxed[0]), /^┌─ 就绪 /, "第一条框线应是「就绪」面板的上边框");

  const widths = [...new Set(boxed.map((l) => displayWidth(l)))];
  assert.equal(
    widths.length,
    1,
    `启动面板行宽不一致（${widths.join(" / ")}）：\n${boxed.map((l) => `${displayWidth(l)} | ${stripAnsi(l)}`).join("\n")}`
  );
});

// ============================================================
// /agents —— 在真实进程里跑一遍
// ============================================================
//
// 这一条不只是界面验证，它还是**模块图**的端到端验证：
//
//   main → tools/index → tools/subagent → agent/subagent_manager → (动态) agent/graph
//        → tools/index ← …这里是环
//
// 静态那半段能成立，全靠「谁都不在模块顶层读对方的绑定」。纯函数测试各自只 import
// 一小块，环的另一半根本没被加载过 —— 只有在真实进程里把整条路径走完，才能证明它不炸。

test("★ /agents：真实进程里跑得起来，列出预设且不再说「没有 SubAgent」", () => {
  const home = readyHome();
  const r = runCommand(home, "/agents");
  assert.equal(r.status, 0, `stderr=${r.stderr}`);

  const out = plain(r.stdout);
  assert.match(out, /内置子代理预设/, "没打出预设小节 —— 命令分支没走到？");
  // 三个预设都该出现，且它们来自 BUILTIN_PRESETS（不是界面里手写的第二份）
  for (const name of ["explorer", "editor", "tester"]) {
    assert.ok(out.includes(name), `/agents 没有列出预设 ${name}`);
  }
  assert.match(out, /本次会话还没有派过子代理/, "没报出「本会话还没派过」的状态");
  assert.doesNotMatch(out, /尚未接入|还没有 SubAgent|python_legacy/, "/agents 还在说那句谎话");
});

// ============================================================
// /history —— 会话记录不能只增不减
// ============================================================
//
// 这一节必须落在子进程层。会话的读/增/删都发生在 main() 里：
//   - 启动时自动恢复最后一条（restoreSession）
//   - 每轮交互后、以及 EOF/Ctrl+C 退出时自动保存（autoSave）
//   - /history del 删的若是**当前**那一条，还得同时清内存里的对话
// 这三件事的**顺序**才是判据：只删文件不清内存的话，退出时那次自动保存
// 会把同一份对话写回同一个 id —— 用户看到「已删除」，文件却还在。
// 纯函数测试盖不到这条路径（session-store 那边只能各测一半）。

const SESSION_FILE = (home: string, id: string): string =>
  path.join(home, ".vca", "sessions", `${id}.json`);
const SESSION_INDEX = (home: string): string => path.join(home, ".vca", "session_index.json");

interface SessionSeed {
  id: string;
  title: string;
  /** 写几条消息（默认 2）—— 有消息才会被自动恢复，没有就等于一段空会话 */
  messages?: number;
}

/** 种下几个历史会话：`session_index.json` + `sessions/<id>.json` 各写一份（最新在前） */
function seedSessions(home: string, seeds: SessionSeed[]): void {
  const dir = path.join(home, ".vca", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const index = seeds.map((s, i) => {
    const n = s.messages ?? 2;
    const msgs = Array.from({ length: n }, (_, k) =>
      k % 2 === 0
        ? { type: "HumanMessage", content: `${s.title}：第 ${k / 2 + 1} 句` }
        : { type: "AIMessage", content: "好的" }
    );
    fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(msgs, null, 2), "utf-8");
    return {
      id: s.id,
      title: s.title,
      workspace: home,
      message_count: n,
      created_at: "2026-09-20 10:00",
      updated_at: `2026-09-20 ${10 + i}:00`,
    };
  });
  fs.writeFileSync(SESSION_INDEX(home), JSON.stringify(index, null, 2), "utf-8");
}

function indexedIds(home: string): string[] {
  const raw = fs.readFileSync(SESSION_INDEX(home), "utf-8");
  return (JSON.parse(raw) as Array<{ id: string }>).map((e) => e.id);
}

/** 三个会话，最新在前（`seed-1` 就是启动时会被自动恢复的那一条） */
const SESSION_SEEDS: SessionSeed[] = [
  { id: "seed-1", title: "修 redis 超时" },
  { id: "seed-2", title: "看板样式" },
  { id: "seed-3", title: "打包 vsix" },
];

test("★ /history：列出历史会话（最新在前）并给出删除入口", () => {
  const home = readyHome();
  seedSessions(home, SESSION_SEEDS);
  const r = runCommand(home, "/history");
  assert.equal(r.status, 0, `stderr=${r.stderr}`);

  const out = plain(r.stdout);
  assert.match(out, /历史会话 · 最近 3 \/ 3 个（最新在前）:/);
  assert.match(out, /1\. 修 redis 超时 \(2 条消息, 2026-09-20 10:00\)/);
  assert.match(out, /2\. 看板样式/);
  assert.match(out, /3\. 打包 vsix/);
  // 原来这一页只能列：没有任何办法删掉一个会话，粘过密钥的对话永远躺在 ~/.vca/sessions/ 里
  assert.match(out, /\/history del <序号> 删除/, "必须告诉用户怎么删");
});

test("★ /history <关键字>：搜标题，如实报出命中数与总数", () => {
  const home = readyHome();
  seedSessions(home, SESSION_SEEDS);
  const r = runCommand(home, "/history redis");
  assert.equal(r.status, 0, `stderr=${r.stderr}`);

  const out = plain(r.stdout);
  assert.match(out, /历史会话 · 匹配「redis」 1 \/ 3 个:/);
  assert.match(out, /1\. 修 redis 超时/);
  assert.doesNotMatch(out, /打包 vsix/, "没命中的不该出现");
});

test("/history <关键字>：搜不到时说清楚，而不是打一张空表", () => {
  const home = readyHome();
  seedSessions(home, SESSION_SEEDS);
  const r = runCommand(home, "/history zzz-不存在");
  assert.match(plain(r.stdout), /没有匹配「zzz-不存在」的历史会话（共 3 个）/);
});

test("/history <条数>：只截断不改序，并提示还有多少没显示", () => {
  const home = readyHome();
  seedSessions(home, SESSION_SEEDS);
  const r = runCommand(home, "/history 1");
  assert.match(plain(r.stdout), /历史会话 · 最近 1 \/ 3 个（最新在前）:/);
  assert.match(plain(r.stdout), /1\. 修 redis 超时/);
  assert.doesNotMatch(plain(r.stdout), /看板样式/, "只要了 1 条，不该给出第 2 条");
  assert.match(plain(r.stdout), /…还有 2 个没显示/);
});

test("★ /history del 2：文件与索引一起删，当前那条不受牵连", () => {
  const home = readyHome();
  seedSessions(home, SESSION_SEEDS);
  const r = runCommand(home, "/history del 2");
  assert.equal(r.status, 0, `stderr=${r.stderr}`);

  assert.match(plain(r.stdout), /已删除会话/);
  assert.match(plain(r.stdout), /看板样式/, "要报出删的是哪一个，用户才知道有没有删错");
  assert.equal(fs.existsSync(SESSION_FILE(home, "seed-2")), false, "会话文件必须真的没了");
  assert.deepEqual(indexedIds(home), ["seed-1", "seed-3"], "索引里的记录也必须一起删");
  // 当前窗口是 seed-1（启动时自动恢复的就是它），不该被牵连
  assert.equal(fs.existsSync(SESSION_FILE(home, "seed-1")), true);
});

test("★ /history del 1（当前窗口那条）：退出时不许被自动保存写回来", () => {
  const home = readyHome();
  seedSessions(home, SESSION_SEEDS);
  const r = runCommand(home, "/history del 1");
  assert.equal(r.status, 0, `stderr=${r.stderr}`);

  const out = plain(r.stdout);
  assert.match(out, /已删除会话/);
  assert.match(out, /这是当前窗口的会话/, "删掉当前会话要明说内存里那段也一起丢了");
  assert.equal(
    fs.existsSync(SESSION_FILE(home, "seed-1")),
    false,
    "删完退出时又被自动保存写回来了 —— 用户看到「已删除」，文件却还在"
  );
  assert.deepEqual(indexedIds(home), ["seed-2", "seed-3"], "索引里也不该再有它");
});

test("/history del 不给序号：报用法，什么都不删", () => {
  const home = readyHome();
  seedSessions(home, SESSION_SEEDS);
  const r = runCommand(home, "/history del");
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(plain(r.stdout), /用法: \/history del <序号>/);
  assert.deepEqual(indexedIds(home), ["seed-1", "seed-2", "seed-3"]);
  for (const s of SESSION_SEEDS) {
    assert.equal(fs.existsSync(SESSION_FILE(home, s.id)), true, `${s.id} 不该被删`);
  }
});

test("/history del <越界序号>：明确报错，且什么都没删", () => {
  const home = readyHome();
  seedSessions(home, SESSION_SEEDS);
  const r = runCommand(home, "/history del 99");
  assert.match(plain(r.stdout), /无效序号，请输入 1-3/);
  for (const s of SESSION_SEEDS) {
    assert.equal(fs.existsSync(SESSION_FILE(home, s.id)), true, `${s.id} 不该被删`);
  }
});

test("★ /history：索引外的会话文件也要列出来、也能删（只拷了 sessions/ 目录的用户）", () => {
  const home = readyHome();
  seedSessions(home, [{ id: "seed-1", title: "在索引里的" }, { id: "seed-9", title: "只在磁盘上" }]);
  // 索引里只剩 seed-1：模拟「索引被截断 / 换机器只拷了 sessions/ 目录」
  const only = JSON.parse(fs.readFileSync(SESSION_INDEX(home), "utf-8"))[0];
  fs.writeFileSync(SESSION_INDEX(home), JSON.stringify([only], null, 2), "utf-8");

  const listed = runCommand(home, "/history");
  const out = plain(listed.stdout);
  assert.match(out, /历史会话 · 最近 2 \/ 2 个（最新在前）:/, "索引外的会话文件也必须出现在列表里");
  assert.match(out, /未登记/, "要标出「不在索引里」——它没有标题，用户不该以为是空的");
  assert.match(out, /标「未登记」的 1 个只有会话文件/);
  assert.match(out, /文件 seed-9\.json/, "把文件名亮出来，用户好在 sessions/ 目录里对上号");

  // 能删 —— 否则这些文件永远只能靠自己开文件管理器找
  const del = runCommand(home, "/history del 1");
  assert.match(plain(del.stdout), /已删除会话/);
  assert.equal(fs.existsSync(SESSION_FILE(home, "seed-1")), false);
  assert.deepEqual(indexedIds(home), [], "删的正是索引里唯一那条");
});

test("/help 里能看到 /history 的四行用法（命令清单的唯一来源是 help.ts）", () => {
  const r = runCli(["--help"], emptyHome());
  const out = plain(r.stdout);
  assert.match(out, /\/history \[条数\]/);
  assert.match(out, /\/history <关键字>/);
  assert.match(out, /\/history del <序号>/);
  assert.match(out, /列出 \/ 搜索 \/ 删除历史会话/);
});
