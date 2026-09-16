/**
 * 路径工具
 *
 * 单独一个模块，是为了让 completer 这类叶子模块能用上 expandUser 而
 * **不必 import config.js** —— config.js 顶层有一句
 * `let _config = ensureConfig()`，一旦被 import 就会在真实磁盘上
 * 创建 / 补写 ~/.vca/config.json。测试里只是想补一个 `~/xxx` 路径，
 * 不该顺手改到用户的配置。
 *
 * 实现只有这一份，config.js 从这里 re-export 出去（对外 API 不变）。
 */
import os from "node:os";
import path from "node:path";

/** 展开开头的 `~` / `~/` / `~\`。其余一律原样返回（不做 cwd 解析） */
export function expandUser(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
