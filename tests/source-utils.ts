/**
 * 读源码做断言的共用工具 —— **只此一份**（此前 `tests/` 下有三份同名拷贝，一起漂移）。
 *
 * 为什么需要剥注释
 * ----------------
 * 「注释里写一句『不能这么写』的反面示例」是本仓库的既定风格，而 `includes` / 正则会把
 * 注释当成实现，于是锁在**已经修好**的代码上变红。所以断言源码之前必须先剥注释。
 *
 * 为什么不能写成「把 `//` 之后一直删到行尾」那条裸正则
 * ------------------------------------------------
 * 它会连**字符串里的** `//` 一起删。最要命的是 URL：
 *
 *   const url = `ws://${location.host}/ws`;      →  `//${...}` 被吃掉，剩 `ws:`
 *   const url = `${protocol}//${location.host}/ws`;  →  同样被吃
 *
 * 于是「`ws://` 字面量只在 ws-url.ts 里拼」「读 `location.host` 的地方只有一处」这两条锁
 * 对**上面这两种形态**一律判绿 —— 它们恰恰是这两条锁存在的理由。本仓库实测复现：
 * 把 `const url = `ws://${location.host}/ws`` 注入 `App.vue`，两条锁纹丝不动。
 *
 * 所以这里逐字符扫描，分清「代码 / 行注释 / 块注释 / 字符串 / 模板串」五种状态：
 * 注释丢掉，字符串与模板串**原样保留**（里面的 `ws://`、`${…}`、`//` 都是代码里真实存在
 * 的字符，锁要能看到它们）。
 *
 * 边界：模板串的 `${…}` 插值按「字符串内的普通字符」原样保留 —— 对上面两类锁足够了，
 * 且不需要引入真正的 JS 词法分析器。
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    // 块注释：整段丢弃（`*/` 里的换行也丢，行数会变，断言不要依赖行号）
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    // 行注释：丢到行尾，**保留换行**（保住行数）
    if (c === "/" && d === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      continue;
    }

    // 字符串 / 模板串：整段照抄，内部一律不当注释
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}
