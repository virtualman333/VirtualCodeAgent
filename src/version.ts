/**
 * 版本号的**唯一**读取处。
 *
 * `package.json` 是唯一真值来源，源码里不再抄第二份 —— 抄一份必然漂移。
 * 这个仓库已经栽过：`src/mcp/manager.ts` 把 MCP 客户端握手的 self version 写死成
 * `"0.2.0"`，而 `main.ts` 的 `--version` 是从 package.json 现读的。两个数字来源于
 * 同一件事，迟早对不上，而且**谁都不会报错**：MCP server 只会看到一个过期的版本号。
 *
 * 刻意不缓存：`--version` 与 MCP 握手各自读一次磁盘的成本可以忽略，
 * 换来的是打包后改了 package.json 立刻生效（缓存版在长驻进程里会一直用旧值）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 读 package.json 里的 version。
 *
 * 从**本文件**往上找一层：源码态是 `src/version.ts`、编译后是 `dist/version.js`，
 * 两者都在仓库根下第一层，所以同一个相对路径两边都对。
 * 读不到（文件缺失 / 非法 JSON）时返回 `"unknown"`，不抛 —— 版本号显示不出来
 * 不该把整个 CLI 拖挂。
 */
export function readVersion(): string {
  try {
    const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const raw = JSON.parse(fs.readFileSync(pkg, "utf-8")) as { version?: unknown };
    return typeof raw.version === "string" && raw.version ? raw.version : "unknown";
  } catch {
    return "unknown";
  }
}
