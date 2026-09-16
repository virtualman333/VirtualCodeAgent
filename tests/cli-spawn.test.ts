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

/** 往家目录里放一份输入历史（文件里最早在前，与 writeHistory 的约定一致） */
function seedHistory(home: string, lines: string[]): void {
  fs.writeFileSync(path.join(home, ".vca", "input_history"), lines.join("\n") + "\n", "utf-8");
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
  const file = fs.readFileSync(HISTORY_FILE(home), "utf-8").trimEnd().split(/\r?\n/);
  assert.equal(file[file.length - 1], "/input 2", "刚敲的命令应该被追加到文件末尾（文件里最早在前）");
  assert.equal(file.length, SEED.length + 1);
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
