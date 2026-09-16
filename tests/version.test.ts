/**
 * 版本号的单一来源 —— `package.json`。
 *
 * 踩过：`main.ts` 的 `--version` 是从 package.json 现场读的，而
 * `src/mcp/manager.ts` 把 MCP 客户端握手用的 self version 写死成 `"0.2.0"`。
 * 同一件事写两处，必然漂移；更糟的是**不报错** —— MCP server 只会收到一个
 * 过期的版本号，谁都不会发现。这一节把「只有一个读取处」钉住。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { readVersion } from "../src/version.js";
import { stripComments } from "./source-utils.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p: string): string => path.relative(ROOT, p).replace(/\\/g, "/");

/**
 * 会进产物的源码目录 —— **界面与主进程也算**。
 *
 * 这里原来只扫 `src/`，那是一条豁免通道：桌面版侧栏写死过 `v0.2.0`（当时已经是 0.3.0），
 * 它就在 `web/src/components/DesktopApp.vue` 里，谁都扫不到、也就一直没人核对。
 * 现在它取自主进程报的 `app.getVersion()`（见 tests/electron-boot.test.ts）。
 */
const SOURCE_DIRS = ["src", "web/src", "electron/src", "vscode/src"];

/** 上面这些目录下的 .ts / .vue */
function sourceFiles(): string[] {
  const out: string[] = [];
  for (const d of SOURCE_DIRS) {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (e.isFile() && /\.(ts|vue)$/.test(e.name)) out.push(path.join(e.parentPath, e.name));
    }
  }
  return out.sort();
}

/** 读源码做断言前先剥注释（注释里的反面示例会被当成实现 —— 本仓库踩过） */
// `stripComments` 已收敛到 ./source-utils.ts（原先本文件里那份会把字符串里的 `//` 当注释吃掉）

test("readVersion: 读到 package.json 里的真实版本号", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")) as { version?: string };
  assert.equal(readVersion(), pkg.version, "readVersion 与 package.json 对不上");
  assert.notEqual(readVersion(), "unknown", "读不到 package.json —— 相对层级变了？");
});

test("★ 结构锁: 版本号只有一个读取处（源码里没有第二份写死的版本）", () => {
  const files = sourceFiles();
  assert.ok(files.length > 10, `只扫到 ${files.length} 个源文件 —— 路径变了？`);

  // 1) readVersion 只能定义在 src/version.ts
  const defs = files.filter((f) => /function\s+readVersion\s*\(/.test(fs.readFileSync(f, "utf-8")));
  assert.deepEqual(defs.map(rel), ["src/version.ts"], `readVersion 被定义了多份：${defs.map(rel).join(", ")}`);

  // 2) 任何源码里都不许出现 `version: "1.2.3"` 这种写死
  const hard: string[] = [];
  for (const f of files) {
    stripComments(fs.readFileSync(f, "utf-8"))
      .split("\n")
      .forEach((line, i) => {
        if (/\bversion\s*:\s*["'`]\d+\.\d+\.\d+/.test(line)) hard.push(`${rel(f)}:${i + 1}`);
      });
  }
  assert.deepEqual(hard, [], `源码里出现了写死的版本号（应当走 readVersion）：${hard.join(", ")}`);

  // 3) 界面上那种 `v1.2.3` 的写法同样算写死 —— 桌面版侧栏就是这么写的
  //    （写死 v0.2.0，而当时 package.json 已经是 0.3.0，一直没人核对）
  const shown: string[] = [];
  for (const f of files) {
    stripComments(fs.readFileSync(f, "utf-8"))
      .split("\n")
      .forEach((line, i) => {
        if (/v\d+\.\d+\.\d+/.test(line)) shown.push(`${rel(f)}:${i + 1}`);
      });
  }
  assert.deepEqual(
    shown,
    [],
    `界面上出现了写死的版本号（应当取 readVersion 或主进程报的 version）：${shown.join(", ")}`
  );
});

test("★ 结构锁: 文档的「版本」章不抄版本号，只指向唯一来源", () => {
  // 只检查**有**「版本」章的文档：不强制每本文档都开这一章（vscode/README.md 就没有）。
  // 但「有没有可检查的对象」本身要钉住，否则这条锁会退化成永远为真。
  const docs = ["README.md", "vscode/README.md", "python_legacy/README.md"];
  const offenders: string[] = [];
  const chapters: string[] = [];
  for (const d of docs) {
    const p = path.join(ROOT, d);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf-8");
    const at = text.indexOf("\n## 版本");
    if (at < 0) continue;
    chapters.push(d);
    const after = text.indexOf("\n## ", at + 1);
    const section = text.slice(at, after > at ? after : undefined);
    section.split("\n").forEach((line, i) => {
      if (/\d+\.\d+\.\d+/.test(line)) offenders.push(`${d} 版本章第 ${i + 1} 行 → ${line.trim()}`);
    });
  }
  assert.ok(chapters.includes("README.md"), "README 必须有「版本」章");
  assert.deepEqual(
    offenders,
    [],
    "文档里抄了版本号。README 自己就写着这条判据（「抄一份必然漂移：此前这里写着 0.1.2，" +
      `而仓库里根本没有那个文件」），而且它已经漂移过一次：\n  ${offenders.join("\n  ")}`
  );

  // 反向对照：数字可以不抄，但**去哪看**不能没有 —— 否则读者只知道「不在这里」，
  // 等于把信息删了。
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf-8");
  const at = readme.indexOf("\n## 版本");
  const section = readme.slice(at, readme.indexOf("\n## ", at + 1));
  assert.ok(
    /package\.json/.test(section),
    "README 的版本章必须指出唯一来源（`package.json`）—— 不抄数字的前提是告诉读者去哪看"
  );
});

test("readVersion: 不缓存 —— 每次读盘，改了 package.json 立刻生效", () => {
  // 断言「实现里没有模块级缓存变量」太脆，直接验行为：连读两次都等于文件里的值。
  // 真正要挡的是「有人加一个 `const V = readVersion()` 在模块顶层」那种写法 ——
  // 那种写法在长驻进程里会一直用启动时的旧值。
  const src = fs.readFileSync(path.join(ROOT, "src", "version.ts"), "utf-8");
  assert.equal(
    /^\s*(export\s+)?const\s+\w*(VERSION|version)\w*\s*=/m.test(src),
    false,
    "version.ts 里出现了模块级常量缓存 —— 长驻进程会一直用旧版本号"
  );
  assert.equal(readVersion(), readVersion());
});
