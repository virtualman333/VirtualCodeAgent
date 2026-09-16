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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "src", "main.ts");
const PKG_VERSION = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")) as {
  version: string;
}).version;

/** 一个没有 ~/.vca/config.json 的空「家目录」——用来模拟首次安装 */
function emptyHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vca-smoke-"));
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], home?: string): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (home) {
    // Windows 上 os.homedir() 认 USERPROFILE，macOS/Linux 认 HOME，两个都设上
    env.USERPROFILE = home;
    env.HOME = home;
  }
  // stdin 直接给 /dev/null：万一流程掉进 promptUser，readline 立刻 EOF 退出，
  // 测试不会挂住（真实的「静默卡在等输入」故障也就能被看见，而不是超时）。
  const r = spawnSync(process.execPath, ["--import", "tsx", ENTRY, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  assert.equal(r.error, undefined, `子进程启动失败: ${r.error?.message}`);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
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
