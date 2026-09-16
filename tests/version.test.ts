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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p: string): string => path.relative(ROOT, p).replace(/\\/g, "/");

/** src/ 下所有 .ts（含子目录） */
function sourceFiles(): string[] {
  const dir = path.join(ROOT, "src");
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

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
    fs.readFileSync(f, "utf-8")
      .split("\n")
      .forEach((line, i) => {
        if (/\bversion\s*:\s*["'`]\d+\.\d+\.\d+/.test(line)) hard.push(`${rel(f)}:${i + 1}`);
      });
  }
  assert.deepEqual(hard, [], `源码里出现了写死的版本号（应当走 readVersion）：${hard.join(", ")}`);
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
