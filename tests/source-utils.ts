import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
 * 为什么还要认正则字面量（第二条吞代码的路）
 * ----------------------------------------
 * 正则字面量里**可以出现引号和反引号**：本仓库 `src/ui.ts` 那条「匹配行内代码」的正则就把
 * 反引号写进了字符类。逐字符扫描碰到它会在第一个反引号处误入「模板串」状态，一路吞到下一个
 * 反引号，中间的真实代码与真注释一起消失（实测 `src/ui.ts`、`vscode/src/panel.ts` 中招，
 * 剥完后还残留 30 条与 2 条「像注释的行」—— 那就是失步的指纹）。
 *
 * 后果不是「锁松了一点」，而是**锁对着空字符串判绿**：`tests/version.test.ts` 里
 * `assert.deepEqual(shown, [], …)` 拿到空数组，「源码里没有第二份写死的版本号」这条锁
 * 在被吞掉的那段里永远成立。地基本身塌了，上面的锁全是真的。
 *
 * 所以这里逐字符扫描，分清「代码 / 行注释 / 块注释 / 字符串 / 模板串 / 正则」六种状态：
 * 注释丢掉，字符串、模板串与正则**原样保留**（里面的 `ws://`、`${…}`、`//` 都是代码里真实
 * 存在的字符，锁要能看到它们）。
 *
 * 边界一：模板串的 `${…}` 插值按「字符串内的普通字符」原样保留 —— 对上面几类锁足够了，
 * 且不需要引入真正的 JS 词法分析器。
 * 边界二：正则是否成立用「上一个有效字符」启发式 —— 判错的方向只能是「把正则当除号」，
 * 而不会「把除号当正则」把后面的代码吞掉（见 `regexAllowed`）。
 * 边界三：正则**必须在本行内闭合**。这既是语法事实，也是这里的安全阀。它不是纸上谈兵：
 * `.vue` 里的**闭合标签** `</span>` 每次都满足「`<` 之后可以是正则」，于是每个闭合标签
 * 都是一次正则尝试；没有这条约束，扫描会从那里一路咬到几行之后的下一个 `/`，把中间那段
 * CSS 注释（`/*` 开头的那些）整段变成「正则内容」漏出来（实测 `web/src/components/PlanList.vue`
 * 与 `web/src/components/SettingsPanel.vue`）。有了它，判错最多影响一行，绝不会像失步那样
 * 把文件后半段整段吃掉。
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    // 块注释：整段丢弃（`*/` 里的换行也丢，行数会变，断言不要依赖行号）
    // 注意顺序：`//`、`/*` 必须在正则之前判 —— `//` 永远不是正则（空正则非法）。
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

    // 正则字面量：整段照抄（内部的反引号/引号不是字符串定界符）
    if (c === "/" && regexAllowed(out)) {
      const end = regexEnd(src, i);
      if (end !== -1) {
        out += src.slice(i, end);
        i = end;
        continue;
      }
      // 本行内没有闭合的 `/` —— 它不可能是正则（是除号），落到下面按普通字符处理
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

/**
 * `/` 只可能出现在这些字符之后才是**正则开头**；跟在标识符、数字、`)`、`]`、`"` 之后的
 * 一律是除号。启发式取自 JS 词法分析器的通行做法（正则与除号在文法上二义，必须靠上下文）。
 */
const REGEX_AFTER_PUNCT = "(,=:[!&|?{};+-*%^~<>";

/** 这些关键字之后可以紧跟正则：`return /re/`、`typeof /re/`、`case /re/:` */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
  "case",
  "throw",
]);

/**
 * 已经吐出的内容末尾（跳过空白）看着像不像「正则该出现的地方」。
 *
 * 判错的方向很重要：这里返回 `true` 而实际是除号时，`regexEnd` 多半返回 -1（除号那一行
 * 里没有第二个裸 `/`），于是按普通字符处理；反过来返回 `false` 而实际是正则时，只是
 * 退回旧行为（正则里的引号可能再次引起失步）。两头都不至于吞掉整段代码。
 */
function regexAllowed(out: string): boolean {
  for (let k = out.length - 1; k >= 0; k--) {
    const ch = out[k];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
    if (REGEX_AFTER_PUNCT.includes(ch)) return true;
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let s = k;
      while (s > 0 && /[A-Za-z0-9_$]/.test(out[s - 1])) s--;
      return REGEX_AFTER_WORD.has(out.slice(s, k + 1));
    }
    return false;
  }
  return true; // 文件开头也是合法位置
}

/**
 * `src[start]` 是 `/`。返回闭合斜杠**之后**的下标（含 flags），不像正则则返回 -1。
 *
 * 三条边界：`[...]` 字符类里的 `/` 不结束正则；`\` 转义跳过两个字符；
 * 换行即判负（正则不可能跨行）。
 */
function regexEnd(src: string, start: number): number {
  const n = src.length;
  let j = start + 1;
  if (j >= n) return -1;
  let inClass = false;
  while (j < n) {
    const ch = src[j];
    if (ch === "\n" || ch === "\r") return -1;
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else     if (ch === "/" && !inClass) {
      j += 1;
      while (j < n && /[a-z]/i.test(src[j])) j++; // flags
      return j;
    }
    j += 1;
  }
  return -1;
}

/** 仓库根（`tests/` 的上一级） */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 安装 / 构建产物 —— **定义性排除**，不是「覆盖率清单」。
 * 这里的东西要么是别人装的，要么是构建出来的，永远不属于源码。
 */
const ARTIFACT_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  ".git",
  ".vscode",
  "out",
  "release",
  "coverage",
]);

/**
 * 刻意不扫的源码目录 —— **默认是扫，这里是例外**。
 *
 * 为什么要有这张表
 * ----------------
 * 扫描面原来写成一份手抄的目录清单（`version.test.ts` 的 `SOURCE_DIRS` /
 * `ansi-source.test.ts` 的 `SCAN_ROOTS`，两份内容还不一样）：
 *
 *   ["src", "web/src", "electron/src", "vscode/src"]
 *
 * 于是**新加一个源码目录，两条锁都不会知道**。这不是假设：`web/vite.config.ts`
 * 就一直在这份清单外（它是构建配置，但同样属于「会进产物的源码」）。
 * 同一形状在本仓库出现过两次，在兄弟仓库也出现过（XiaoWenDesktopAgent 的
 * `RUNTIME_SRC_DIRS`）—— 「扫描面写死目录清单」这个形状已经是第三次了。
 *
 * 改成**默认扫**之后失效模式反了过来：新目录默认进扫描面，要排除必须来这张表
 * 写明理由；而登记了一个「底下其实没有源码」的目录会进 `problems`（清单腐烂）。
 *
 * ⚠ 只登记**确实含有 `ts` / `vue` 的目录**。纯 Python 的 `python_legacy/`、只放
 * `.mjs` 的 `scripts/` 不必登记 —— 它们本来就不在扫描面上，登记了反而是假条目。
 */
export const EXCLUDED_SOURCE_DIRS: Record<string, string> = {
  tests: "测试数据：裸转义序列与版本号样例都在这里，它们是消费者不是生产者",
};

export interface SourceSurface {
  /** 扫到的源码文件（相对仓库根、`/` 分隔、已排序） */
  files: string[];
  /** **现算**出来的源码根目录（顶层目录，已排序）—— 不是手抄的 */
  roots: string[];
  /** 空数组 = 扫描面自洽；非空即失败原因 */
  problems: string[];
}

/** 可选注入点 —— 只为让 `sourceSurface` 的失败分支能被测到（见 source-utils.test.ts） */
export interface SourceSurfaceOpts {
  /** 从哪个目录开始走（默认仓库根） */
  root?: string;
  /** 排除表（默认 `EXCLUDED_SOURCE_DIRS`） */
  excluded?: Record<string, string>;
}

/**
 * 现算扫描面：仓库根下所有符合 `exts` 的文件，减去产物目录与排除表。
 *
 * `exts` 是**调用方**要的源码类型（`.ts|.vue` / 只 `.ts`）；目录的取舍与它无关，
 * 所以几条锁算出来的 `roots` 是同一份。
 */
export function sourceSurface(exts: RegExp, opts: SourceSurfaceOpts = {}): SourceSurface {
  const root = opts.root ?? REPO_ROOT;
  const excluded = opts.excluded ?? EXCLUDED_SOURCE_DIRS;
  // 调用方传进来的正则若带 `g`，`test()` 会在多次调用间来回翻转 —— 静默漏一半文件。
  const re = new RegExp(exts.source, exts.flags.replace(/g/g, ""));
  const all: string[] = [];

  (function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 读不到就跳过：夹层里的目录不该让整条锁崩掉
    }
    for (const e of entries) {
      if (ARTIFACT_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (re.test(e.name)) all.push(path.relative(root, full).replace(/\\/g, "/"));
    }
  })(root);

  all.sort();
  const topOf = (rel: string): string => rel.split("/")[0];
  const withSources = new Set(all.map(topOf));
  const problems: string[] = [];

  // 双向对齐：排除表里的每一条，都必须**真的**挡掉了源码；否则就是在骗后来人
  for (const dir of Object.keys(excluded)) {
    if (!withSources.has(dir)) {
      problems.push(
        `排除表里的 "${dir}/" 下面已经没有源码了 —— 清单腐烂，请删掉这一条（或改对目录名）`
      );
    }
  }

  const files = all.filter((rel) => !(topOf(rel) in excluded));
  const roots = [...new Set(files.map(topOf))].sort();

  // 扫描面自证：空集合会让「全仓没有第二份」这类断言恒真。
  // （`roots` 与 `files` 是同一件事的两种写法，所以只报一条 —— 两条一起报只是噪声。）
  if (files.length === 0) {
    problems.push(`扫描面是空的（0 个匹配 ${re} 的源码文件）—— 下面的「全仓没有」会变成一句空话`);
  }

  return { files, roots, problems };
}
