/**
 * Shell 命令的危险性判定 —— **判据只此一份**，纯函数、零 LangChain / 零 child_process 依赖。
 *
 * 为什么单独成模块
 * ----------------
 * 这段判断原来写死在 `src/tools/bash.ts` 里（一个 8 条的 `RISKY_COMMANDS` 数组 +
 * 一句 `command.includes(模式)`），而 `bash` 工具的**描述**对用户和模型承诺了
 * 「危险命令会被拦截」。底下一条断言都没有：`tests/` 里十来个测试文件谁也 import 不到它
 * （`bash.ts` 顶层就 `import { tool } from "@langchain/core/tools"`）。
 * 「拦得住吗」这件事，一直只靠读代码看着像。
 *
 * 实测：旧的裸子串匹配漏掉的（本轮提交说明里有逐条实测记录）
 *
 *   - `rm  -rf  /`、`rm -fr /`、`rm -rf --no-preserve-root /` —— 参数顺序/空白一换就放行
 *   - `rm -rf ~`、`rm -rf "$HOME"` —— 从来没在名单里
 *   - `del /q /s C:\`、`del /s /f C:\` —— 名单里只有 `del /f /s c:\` 这一种排列
 *   - `format.com C:` —— 名单里是 `format `（后面紧跟空格），`.com` 正好把它挡掉
 *   - `mkfs -t ext4 /dev/sda` —— 名单里是 `mkfs.`（要求带点）
 *   - `dd of=/dev/sda if=/dev/zero` —— 名单里是 `dd if=`（顺序敏感）
 *   - `chmod -R 777 /` —— 名单里是 `chmod 777 /`
 *   - `sh -c "rm -rf ~"` / `cmd /c del /q /s C:\` —— 包一层 shell 就不再查
 *   - `powershell -Command "Remove-Item -Recurse -Force C:\"` —— 完全没覆盖
 *
 * 现在的口径：不是继续往名单里加字符串（那是一场追不上的军备竞赛），而是
 *   1. **先归一化**：统一大小写、折叠空白、剥掉 shell 包装与最外层引号 ——
 *      让 `rm  -rf  /` 与 `rm -rf /`、`sh -c "rm -rf /"` 与 `rm -rf /` 落在同一个形状上；
 *   2. **按命令家族判**，每个家族一条能覆盖真实写法的判据，**参数顺序无关**
 *      （判的是「出现了哪些参数 + 作用于哪个路径」，不是排列）；
 *   3. 反过来也钉住：`rm -rf node_modules`、`rm -fr ./dist`、`chmod 644 x`、
 *      `mkfs_helper.ts` 这些**必须放行** —— 一个乱杀命令的护栏会被用户直接绕开，
 *      比没有护栏更坏。见 `tests/command-guard.test.ts` 的良性回归集。
 *
 * **它不是什么**：这是安全带，不是沙箱。`node -e "require('fs').rmSync('/',…)"`
 * 这类「换一种语言做同一件事」的写法不在覆盖范围内，README 里如实写明。
 */

/** 判定结果（结构化返回，测试与日志都能分别引用原文） */
export interface GuardVerdict {
  /** 是否拦截 */
  blocked: boolean;
  /** 命中的家族名；未拦截时为空串 */
  family: string;
  /** 一句人话，说明拦的是哪种危险 */
  reason: string;
}

const OK: GuardVerdict = { blocked: false, family: "", reason: "" };

/** 归一化：折叠空白、去首尾空白。**不**删引号 —— 引号里的空格是路径的一部分。 */
export function normalize(command: string): string {
  return String(command ?? "").replace(/\s+/g, " ").trim();
}

/** shell 包装器：剥掉之后内层命令要按同样标准判 */
const WRAPPERS: RegExp[] = [
  /^(?:ba|z|da|k)?sh\s+-c\s+/i,
  /^cmd(?:\.exe)?\s+\/[ck]\s+/i,
  /^(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*-command\s+/i,
];

/** 剥掉包装层与最外层引号（可多层，`bash -c 'bash -c "rm -rf /"'`） */
export function unwrap(command: string): string {
  let cur = normalize(command);
  for (let depth = 0; depth < 5; depth++) {
    let changed = false;
    for (const re of WRAPPERS) {
      const m = re.exec(cur);
      if (m) {
        cur = normalize(cur.slice(m[0].length));
        changed = true;
        break;
      }
    }
    const q = /^(["'])([\s\S]*)\1$/.exec(cur);
    if (q) {
      cur = normalize(q[2]);
      changed = true;
    }
    if (!changed) break;
  }
  return cur;
}

/** 按 shell 分隔符切出各条命令（`&&` / `||` / `;` / `|` / 换行），逐条判 */
export function splitSegments(command: string): string[] {
  return normalize(command)
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** token 化：按空白切，引号内的整体算一个（`"C:\Program Files"` 是一个 token） */
export function tokenize(segment: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

/**
 * 去掉前置提权词，并把 `\rm` 归一成 `rm`。
 *
 * **提权不改变危险程度** —— `sudo rm -rf /` 与 `rm -rf /` 必须同罪。
 * 这一条是实测补上的：第一版把 `sudo` 当成命令名，于是 `sudo rm -rf /` 从「旧版能拦」
 * 变成「新版漏了」——**修护栏时把已有的那一格丢掉，比不修更坏**。
 */
export function stripElevation(tokens: string[]): string[] {
  const out = tokens.slice();
  while (out.length > 1 && /^(sudo|doas)$/i.test(out[0])) out.shift();
  if (/^\\rm$/.test(out[0] ?? "")) out[0] = "rm";
  return out;
}

/**
 * 这个路径参数是不是「一删/一改就不可逆」的目标。
 *
 * 注意这里**只看路径形态**，不看它是否存在 —— 判定必须在执行前完成。
 */
export function isRootishPath(p: string): boolean {
  const s = String(p ?? "").trim().replace(/\\/g, "/");
  if (!s) return false;
  if (s === "/" || s === "//" || s === "./" || s === "." || s === "..") return true;
  if (/^\/\*+$/.test(s)) return true;                     // /*  //**
  if (/^[a-z]:\/?$/i.test(s)) return true;                // C:  C:/
  if (/^[a-z]:\/\*+$/i.test(s)) return true;              // C:/*
  if (/^[a-z]:\/\*\.\*$/i.test(s)) return true;           // C:\*.*
  if (s === "~" || s === "~/") return true;
  if (/^\$(?:home|\{home\})\/?$/i.test(s)) return true;   // $HOME  ${HOME}
  if (/^%userprofile%\/?$/i.test(s)) return true;
  if (/^\/(?:etc|usr|var|bin|boot|lib|opt|root)\/?$/i.test(s)) return true;
  if (/^\/dev\/(?:sd[a-z]\d*|nvme\d+n\d+|disk\d+)$/.test(s)) return true;
  return false;
}

/** 参数里是不是「递归 + 强制」同时到位（`-rf` / `-fr` / `-Rf` / `-r -f` / `--recursive --force`） */
export function hasRecursiveForce(args: string[]): boolean {
  const letters = args
    .filter((a) => /^-/.test(a))
    .flatMap((a) => a.replace(/^--?/, "").toLowerCase().split(""));
  return letters.includes("r") && letters.includes("f");
}

/** Windows 路径形态：`C:\` `C:/` `C:\*` —— 用于 del 的目标判断 */
function isDriveRoot(p: string): boolean {
  return /^[a-z]:[\\/]*\*?$/i.test(String(p ?? "").trim());
}

/** 各家族的判据。返回非空字符串 = 拦，字符串就是理由。t 已去过提权词。 */
const FAMILIES: Array<{ name: string; test: (t: string[], seg: string) => string }> = [
  {
    name: "fork-bomb",
    test: (_t, seg) => (/:\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;?\s*:/i.test(seg) ? "shell fork 炸弹" : ""),
  },
  {
    name: "format-disk",
    // 必须「format 后面就是空白或结束」：否则 `format-json`、`formatter` 会被当成抹盘工具
    test: (t) => (/^format(?:\.com|\.exe)?$/i.test(t[0] ?? "") ? "格式化磁盘" : ""),
  },
  {
    name: "mkfs",
    // mkfs / mkfs.ext4 / mkfs.xfs —— 带不带点都要拦；`mkfs_helper.ts` 这类文件名不许误伤
    test: (t) => (/^mkfs(?:\.[a-z0-9]+)?$/i.test(t[0] ?? "") ? "创建文件系统（会抹掉整块盘）" : ""),
  },
  {
    name: "raw-device-write",
    test: (t) => {
      if ((t[0] ?? "").toLowerCase() !== "dd") return "";
      const of = t.find((a) => /^of=/i.test(a));
      if (!of) return "";
      const target = of.slice(3);
      if (/^\/dev\//i.test(target) || isRootishPath(target)) return "用 dd 向裸设备 / 整盘写数据";
      return "";
    },
  },
  {
    name: "chmod-chown-root",
    test: (t) => {
      const head = (t[0] ?? "").toLowerCase();
      if (head !== "chmod" && head !== "chown") return "";
      const rest = t.slice(1).filter((a) => !/^-/.test(a));
      if (head === "chmod") {
        const perms = rest[0];
        if (!perms || !/^[0-7]{3,4}$/.test(perms) || !/[2367]$/.test(perms)) return "";
        if (rest[1] && isRootishPath(rest[1])) return `给根目录改权限 ${perms}`;
        return "";
      }
      // chown 的权限位语义不同，不看数字 —— 只看目标是不是根
      if (rest[1] && isRootishPath(rest[1])) return "把根目录的属主改掉";
      return "";
    },
  },
  {
    name: "powershell-destructive",
    test: (t) => {
      const head = (t[0] ?? "").toLowerCase();
      if (head === "remove-item" || head === "ri") {
        const args = t.slice(1);
        const recursive = args.some((a) => /^-recurse$/i.test(a));
        const force = args.some((a) => /^-force$/i.test(a));
        if (!recursive || !force) return "";
        const target = args.find((a) => !/^-/.test(a));
        if (target && (isRootishPath(target) || isDriveRoot(target))) {
          return "PowerShell 递归强删根 / 整盘";
        }
        return "";
      }
      if (/^(format-volume|clear-disk|initialize-disk|remove-partition)$/.test(head)) {
        return "PowerShell 抹盘 / 改分区表";
      }
      return "";
    },
  },
  {
    name: "recursive-force-delete",
    test: (t) => {
      const head = (t[0] ?? "").toLowerCase();
      const args = t.slice(1);
      if (head === "rm") {
        if (!hasRecursiveForce(args)) return "";
        const targets = args.filter((a) => !/^-/.test(a));
        if (targets.some((p) => isRootishPath(p))) return "递归强制删除根 / 盘符 / 家目录";
        return "";
      }
      if (head === "rd" || head === "rmdir") {
        if (!args.some((a) => /^\/s/i.test(a))) return "";
        const targets = args.filter((a) => !/^\/[a-z]/i.test(a));
        if (targets.some((p) => isRootishPath(p) || isDriveRoot(p))) return "整目录树递归删除（rd /s）";
        return "";
      }
      if (head === "del") {
        if (!args.some((a) => /^\/[sqf]/i.test(a))) return "";
        const targets = args.filter((a) => !/^\/[a-z]/i.test(a));
        if (targets.some((p) => isRootishPath(p) || isDriveRoot(p))) return "删除整盘内容（del /s）";
        return "";
      }
      return "";
    },
  },
];

/**
 * 判定一条命令是否危险。
 *
 * 会把「原串 / 每条 segment / 每层剥包装后的形态」都收进候选集再判 ——
 * 否则 `sh -c "rm -rf ~"` 与 `rm -rf ~` 不同罪。
 */
export function checkCommand(command: string): GuardVerdict {
  const raw = normalize(command);
  if (!raw) return OK;

  const seen = new Set<string>();
  const queue: string[] = [raw, ...splitSegments(raw)];
  for (let i = 0; i < queue.length && seen.size < 200; i++) {
    for (const cand of new Set([queue[i], unwrap(queue[i])])) {
      if (seen.has(cand)) continue;
      seen.add(cand);
      queue.push(...splitSegments(cand));
    }
  }

  for (const seg of seen) {
    const t = stripElevation(tokenize(seg));
    for (const fam of FAMILIES) {
      const why = fam.test(t, seg);
      if (why) return { blocked: true, family: fam.name, reason: why };
    }
  }
  return OK;
}

/** 兼容旧调用点的布尔版本 */
export function isRiskyCommand(command: string): boolean {
  return checkCommand(command).blocked;
}

/** 家族名清单（顺序即优先级）—— 测试用它交叉验证「每个家族都有正例」 */
export const FAMILY_NAMES: string[] = FAMILIES.map((f) => f.name);
