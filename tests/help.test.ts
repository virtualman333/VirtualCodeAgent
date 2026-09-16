/**
 * 斜杠命令清单的一致性锁。
 *
 * 这里防的是本仓库最典型的一类坏味道：**同一个事实有两处写法**。
 * 命令清单以前就是两份 —— showHelp() 里手写的一串 print()，
 * 加 handleCommand() 的 switch case —— 加一个命令忘了补帮助，
 * 用户就永远看不见它；删一个 case 忘了删帮助，用户照着敲只会得到「未知命令」。
 *
 * 现在清单只写在 src/help.ts 的 COMMANDS 里，帮助文本由它渲染；
 * 实现仍在 main.ts 的 switch 里（分支体要改 state，不适合搬走），
 * 所以这个文件负责**双向**比对：声明 ⊆ 实现，实现 ⊆ 声明。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { COMMANDS, commandNames, isKnownCommand, renderHelp } from "../src/help.js";
import { displayWidth, stripAnsi } from "../src/ui.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_PATH = path.join(ROOT, "src", "main.ts");

/**
 * 从 main.ts 的 handleCommand 里抠出所有 `case "/xxx":` 标签。
 * 只截取 handleCommand → setConfigValue 之间的片段，免得把别处的 switch 也算进来。
 */
function casesInHandleCommand(): string[] {
  const src = fs.readFileSync(MAIN_PATH, "utf-8");
  const start = src.indexOf("async function handleCommand");
  assert.ok(start >= 0, "找不到 handleCommand —— 函数改名了？这条锁需要跟着改");
  const end = src.indexOf("function setConfigValue", start);
  assert.ok(end > start, "找不到 setConfigValue —— handleCommand 的边界定位失败，这条锁需要跟着改");

  const body = src.slice(start, end);
  const found = [...body.matchAll(/\bcase\s+"(\/[a-z][a-z0-9-]*)":/g)].map((m) => m[1]);
  // 正则一旦不匹配就会「零个 case 也算通过」，这条断言防的就是那种假绿
  assert.ok(found.length >= 10, `只抓到 ${found.length} 个 case，正则大概失效了 —— 这条锁形同虚设`);
  return found;
}

test("命令名不重复（重复会让 help 里出现两行一模一样的命令）", () => {
  const names = commandNames();
  assert.equal(new Set(names).size, names.length, `命令名有重复: ${names.join(", ")}`);
});

test("命令名形如 /xxx，且不带空格", () => {
  for (const n of commandNames()) {
    assert.match(n, /^\/[a-z][a-z0-9-]*$/, `命令名不合规范: ${n}`);
  }
});

test("isKnownCommand 与清单一致", () => {
  for (const n of commandNames()) assert.equal(isKnownCommand(n), true, `${n} 应被识别`);
  assert.equal(isKnownCommand("/nope"), false);
  assert.equal(isKnownCommand("help"), false, "漏斜杠不算命令");
});

test("★ 帮助里声明的每条命令，handleCommand 都必须有对应 case（否则用户照着敲会得到「未知命令」）", () => {
  const cases = new Set(casesInHandleCommand());
  const missing = commandNames().filter((n) => !cases.has(n));
  assert.deepEqual(missing, [], `这些命令在 help 里声明了、但 switch 里没有实现: ${missing.join(", ")}`);
});

test("★ handleCommand 实现的每个 case，帮助里都必须有对应声明（否则用户永远看不见这个命令）", () => {
  const declared = new Set(commandNames());
  const undeclared = casesInHandleCommand().filter((c) => !declared.has(c));
  assert.deepEqual(undeclared, [], `这些命令实现了、但帮助里没写: ${undeclared.join(", ")}`);
});

test("handleCommand 保留了 default 分支做「未知命令」兜底", () => {
  const src = fs.readFileSync(MAIN_PATH, "utf-8");
  const body = src.slice(src.indexOf("async function handleCommand"), src.indexOf("function setConfigValue"));
  assert.match(body, /\bdefault:/, "switch 缺 default，未知命令会静默什么都不做");
  assert.match(body, /未知命令/);
});

test("每条命令都在帮助里占一行，且说明非空", () => {
  const plain = renderHelp(false).map(stripAnsi);
  for (const spec of COMMANDS) {
    const usage = Array.isArray(spec.usage) ? spec.usage[0] : spec.usage;
    assert.ok(
      plain.some((l) => l.trim().startsWith(usage)),
      `帮助里找不到 ${usage}`
    );
    assert.ok(spec.desc.trim().length > 0, `${spec.name} 缺说明`);
  }
});

test("/config 的两行用法都要出现（多行 usage 不能被吞掉一行）", () => {
  const plain = renderHelp(false).map(stripAnsi);
  assert.ok(plain.some((l) => l.trim().startsWith("/config set")), "帮助里缺 /config set 的用法");
});

test("★ 说明列必须对齐（按显示宽度补白，中文用法不会把整列顶歪）", () => {
  const plain = renderHelp(false).map(stripAnsi);
  // 注意这里比的是**显示宽度**，不是字符串下标：padding 按终端列数补，
  // 而 indexOf 按码元数算，中文用法那一行的下标天然就小 —— 两者不可比。
  // 真正要锁的是「说明列在终端里落在同一列」，所以量的是前缀的显示宽度。
  const usages = COMMANDS.flatMap((c) => (Array.isArray(c.usage) ? c.usage : [c.usage]));
  const col = Math.max(...usages.map(displayWidth));
  const expected = 2 + col + 2; // 行首两空格 + 用法列 + 两空格

  for (const spec of COMMANDS) {
    const first = Array.isArray(spec.usage) ? spec.usage[0] : spec.usage;
    const line = plain.find((l) => l.trim().startsWith(first));
    assert.ok(line, `找不到 ${first} 那一行`);
    const at = line.indexOf(spec.desc);
    assert.ok(at > 0, `${first} 那行找不到说明文字`);
    assert.equal(
      displayWidth(line.slice(0, at)),
      expected,
      `${first} 那行的说明没落在第 ${expected} 列`
    );
  }
});

test("verbose 只多出提示区，命令本身一条不少", () => {
  const brief = renderHelp(false).map(stripAnsi);
  const full = renderHelp(true).map(stripAnsi);
  assert.ok(full.length > brief.length, "verbose 没有多出内容");
  for (const l of brief) assert.ok(full.includes(l), `verbose 丢了一行: ${l}`);
  assert.ok(full.some((l) => l.includes("Ctrl+C")), "verbose 缺 Ctrl+C 提示");
  assert.ok(full.some((l) => l.includes("Tab")), "verbose 缺 Tab 补全提示");
  // 多出来的必须全是提示，不能混进命令行（混进去会让上面那条「命令一条不少」形同虚设）
  const extra = full.filter((l) => !brief.includes(l));
  for (const l of extra) {
    assert.equal(l.startsWith("/"), false, `提示区里混进了一行命令: ${l}`);
  }
});

test("displayWidth 对中文算两列（对齐逻辑的基础）", () => {
  assert.equal(displayWidth("/cd <路径>"), 10);
  assert.equal(displayWidth("/help"), 5);
  assert.equal(displayWidth(stripAnsi("\x1b[36m/help\x1b[0m")), 5, "ANSI 不该计入宽度");
});
