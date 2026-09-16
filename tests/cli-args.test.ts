/**
 * CLI 参数解析的单元测试。
 *
 * 这一层是纯函数，所以能穷举边界 —— 而真正值得锁的不是「正常写法能跑」，
 * 是**写错的写法必须报错、不能静默降级**：以前 `vca --hlep` / `vca -m`
 * 都会安安静静地用默认工作空间、默认模型启动，用户以为指定了、其实没有。
 * 下面每条对应的都是那样一个真实的分支。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgs, describeUnknown, USAGE } from "../src/cli-args.js";

/** 断言解析成功并返回 args */
function okResult(argv: string[]) {
  const r = parseArgs(argv);
  assert.equal(r.ok, true, `期望解析成功，实际报错: ${r.ok ? "" : r.error}`);
  if (!r.ok) throw new Error("unreachable");
  return r.args;
}

/** 断言解析失败并返回错误信息 */
function errOf(argv: string[]): string {
  const r = parseArgs(argv);
  assert.equal(r.ok, false, `期望解析失败，实际成功: ${JSON.stringify(r)}`);
  if (r.ok) throw new Error("unreachable");
  return r.error;
}

test("空参数 → 三项全空，走交互流程", () => {
  const a = okResult([]);
  assert.deepEqual(a, { workspace: null, model: null, listWorkspaces: false, help: false, version: false });
});

test("位置参数等同于 --workspace", () => {
  assert.equal(okResult(["/proj"]).workspace, "/proj");
  assert.equal(okResult(["./rel"]).workspace, "./rel");
  assert.equal(okResult(["E:\\agent\\x"]).workspace, "E:\\agent\\x");
});

test("--workspace / -w / --workspace= 三种写法等价", () => {
  const want = "/proj";
  for (const argv of [["--workspace", want], ["-w", want], [`--workspace=${want}`]]) {
    assert.equal(okResult(argv).workspace, want, `写法 ${argv.join(" ")} 解析错`);
  }
});

test("--model / -m / --model= 三种写法等价", () => {
  for (const argv of [["--model", "gpt"], ["-m", "gpt"], ["--model=gpt"]]) {
    assert.equal(okResult(argv).model, "gpt", `写法 ${argv.join(" ")} 解析错`);
  }
});

test("工作空间与模型可以同时指定，且互不干扰", () => {
  const a = okResult(["-w", "/p", "-m", "gpt"]);
  assert.equal(a.workspace, "/p");
  assert.equal(a.model, "gpt");
});

test("--list-workspaces 单独可识别", () => {
  assert.equal(okResult(["--list-workspaces"]).listWorkspaces, true);
});

test("-- 之后的一切都是位置参数，不再当选项解释", () => {
  assert.equal(okResult(["--", "--help"]).workspace, "--help");
  assert.equal(okResult(["--", "--help"]).help, false);
  // 第一个位置参数之后仍受「至多一个」约束
  assert.match(errOf(["--", "a", "b"]), /只能给一个工作空间路径/);
});

// ---------------------------------------------------------------
// 出错的分支：静默忽略换成明确报错
// ---------------------------------------------------------------

test("★ 拼错的选项必须报错，并提示最接近的正确写法", () => {
  const e = errOf(["--hlep"]);
  assert.match(e, /未知参数 --hlep/);
  assert.match(e, /--help/, "报错要说清用户大概想输入什么");
});

test("未知参数绝不退回交互流程（旧行为是静默忽略）", () => {
  for (const bad of ["--dry-run", "-x", "--ws", "--modle"]) {
    const r = parseArgs([bad]);
    assert.equal(r.ok, false, `${bad} 本应报错`);
  }
});

test("★ 该取值的选项缺值时必须报错，不能悄悄用默认值", () => {
  assert.match(errOf(["-m"]), /-m 后面要跟一个值/);
  assert.match(errOf(["--model"]), /--model 后面要跟一个值/);
  assert.match(errOf(["-w"]), /-w 后面要跟一个值/);
  assert.match(errOf(["--workspace"]), /--workspace 后面要跟一个值/);
});

test("★ 取值位置写成了选项时不能把选项名当成值", () => {
  const e = errOf(["-w", "-m", "gpt"]);
  assert.match(e, /-w 后面要跟一个值，但读到的是选项 -m/);
});

test("等号空心值视为报错，而不是解析出一个空字符串", () => {
  assert.match(errOf(["--workspace="]), /值不能为空/);
  assert.match(errOf(["--model="]), /值不能为空/);
});

test("短选项不能用等号取值，且报错要告诉正确写法", () => {
  const e = errOf(["-w=/proj"]);
  assert.match(e, /短选项 -w 取值要写成 "-w <值>"/);
});

test("重复指定同一个选项要报错（后写的不会静默覆盖前写的）", () => {
  assert.match(errOf(["-w", "a", "-w", "b"]), /重复指定/);
  assert.match(errOf(["-m", "a", "--model", "b"]), /重复指定/);
});

test("--workspace 与位置参数打架要报错（旧行为是静默丢弃位置参数）", () => {
  const e = errOf(["-w", "a", "b"]);
  assert.match(e, /既用 --workspace 指定了 a，又给了位置参数 b/);
});

test("两个位置参数要报错", () => {
  assert.match(errOf(["a", "b"]), /只能给一个工作空间路径/);
});

test("空字符串位置参数要报错", () => {
  assert.match(errOf([""]), /不能为空/);
});

test("--list-workspaces 与工作空间不能同时用（后者会被静默忽略）", () => {
  assert.match(errOf(["--list-workspaces", "-w", "/p"]), /不能同时用/);
  assert.match(errOf(["-w", "/p", "--list-workspaces"]), /不能同时用/);
});

test("不取值的开关后面加等号要报错", () => {
  assert.match(errOf(["--list-workspaces=1"]), /不取值/);
});

test("取值型短选项不能和其它短选项合并写", () => {
  assert.match(errOf(["-wm", "x"]), /需要取值，不能和其它短选项合并写/);
});

// ---------------------------------------------------------------
// --help / --version 的特权：任何位置都生效
// ---------------------------------------------------------------

test("★ --help / -h 短路：即使同一行还有别的错，也照样能看到帮助", () => {
  for (const argv of [["--help"], ["-h"], ["--help", "--badflag"], ["--badflag", "--help"], ["-w", "--help"]]) {
    const a = okResult(argv);
    assert.equal(a.help, true, `${argv.join(" ")} 应该给出帮助`);
  }
});

test("★ --version / -v 短路，且与 --help 同给时先出现者胜", () => {
  assert.equal(okResult(["--version"]).version, true);
  assert.equal(okResult(["-v"]).version, true);
  assert.equal(okResult(["--version", "--help"]).version, true);
  assert.equal(okResult(["--help", "--version"]).help, true);
});

test("合并的纯开关短选项按从左往右取值", () => {
  assert.equal(okResult(["-hv"]).help, true);
  assert.equal(okResult(["-vh"]).version, true);
});

test("--help 的短路必须在 `--` 之前才生效", () => {
  // `--` 之后不再解析选项，所以这里是「工作空间名叫 --help」而不是帮助
  const a = okResult(["--", "--help"]);
  assert.equal(a.help, false);
  assert.equal(a.workspace, "--help");
});

// ---------------------------------------------------------------
// 纯函数与信息质量
// ---------------------------------------------------------------

test("parseArgs 不改动传入数组（main 会复用 process.argv 的切片）", () => {
  const argv = ["-w", "/p", "--badflag"];
  const copy = [...argv];
  parseArgs(argv);
  assert.deepEqual(argv, copy);
});

test("每条错误信息里都要出现出错的参数本身", () => {
  for (const token of ["--dry-run", "-x", "--ws"]) {
    assert.ok(errOf([token]).includes(token), `报错里应出现 ${token}`);
  }
});

test("describeUnknown 对短选项等号写法给专门的提示", () => {
  assert.match(describeUnknown("-w=x"), /不能用等号/);
  assert.match(describeUnknown("--nope"), /未知参数/);
});

test("USAGE 里必须列全支持的选项（帮助文本不能漏掉能用的选项）", () => {
  for (const flag of ["-w, --workspace", "-m, --model", "--list-workspaces", "-h, --help", "-v, --version"]) {
    assert.ok(USAGE.includes(flag), `USAGE 里缺 ${flag}`);
  }
});
