/**
 * 工具池 → 可执行工具池。**零 import 的叶子模块**，这是刻意的。
 *
 * 这条判定必须能被单独测。而它的天然位置（`tools/index.ts`）经 `skills/manager.ts`
 * 间接 import 了 `config.ts`，后者顶层有一句 `let _config = ensureConfig()` ——
 * 一旦被 import 就可能在真实磁盘上写下 `~/.vca/config.json`（见 `paths.ts` 的文件头，
 * 那里是为了同一个理由把 `expandUser` 拆出来的）。测试不该为了验一条 filter
 * 去动用户的配置，所以判定搬到这里，`tools/index.ts` 再 re-export 出去（对外 API 不变）。
 */

/**
 * 不能进 `ToolNode` 的工具名。
 *
 * 只有一条规则，但它必须**只有一份**：`ask_user` 的函数体是个占位符（真值由 `ask_user`
 * 节点负责，它会把问题挂到 `pending_question` 上等用户回答）。交给 `ToolNode` 执行的话，
 * 它会立刻返回 `[AWAITING_USER_INPUT]` 而**没有任何人在等用户** —— 图直接跑到 `respond`
 * 收尾，用户连题面都没看见，只得到一句莫名其妙的回复。
 *
 * 这张名单会随工具增多而变长（比如将来某个工具也要走专门节点），所以写成表而不是
 * 硬编码一句 `!== "ask_user"`：加人时改一处，`tests/subagents.test.ts` 会核对
 * 名单里的每个名字都真实存在（写错一个字母 = 那条规则静默失效）。
 */
export const NON_EXECUTABLE_TOOLS: readonly string[] = ["ask_user"];

/** 工具池里哪些能进 `ToolNode`（顺序原样保留 —— 展示与绑定都依赖这个顺序） */
export function executableOf<T extends { name: string }>(pool: readonly T[]): T[] {
  return pool.filter((t) => !NON_EXECUTABLE_TOOLS.includes(t.name));
}
