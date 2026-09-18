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
 * 第二轮（命令词前面挂东西）
 * ------------------------
 * 上面这一版的 family 判据都默认了一件没写下来的事：**命令词就在 `tokens[0]`**。
 * 于是为了挡住 `sudo rm -rf /`，`stripElevation()` 变成了「剥掉开头的 `sudo` / `doas`」——
 * 一个特判。特判只能挡住它自己那一格，实测：
 *
 *   - `sudo -u root rm -rf /`、`sudo -E rm -rf /` —— `sudo` 后面跟了选项，head 变成 `-u` / `-E`
 *   - `nohup rm -rf /`、`env rm -rf /`、`time rm -rf /`、`nice rm -rf /`、`command rm -rf /`
 *   - `nohup bash -c 'rm -rf /'`、`sudo nohup rm -rf /`
 *
 * **七个家族，条条放行** —— 因为判据看的是 `tokens[0]`，而挂一个词就能把它挪开。
 * 这是同一缺陷形状的第二次出现（第一次是 `sudo`），按「第二次就换修法」的口径，
 * 不再往特判表里加词，而是把这件事本身变成判据：**命令头定位**（见 `LAUNCHERS`）。
 *
 * 另一类同样的前提错误：**命令必须是我们读得出来的明文**。
 * `powershell -c "…"`（`-c` 就是 `-Command` 的无歧义缩写）此前完全没被展开；
 * `powershell -EncodedCommand <base64>` 更彻底 —— 内容被编码，护栏读不出来，
 * 但 PowerShell 会照跑。这类「读不出内容」的写法只能拦，不能猜。
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

/**
 * PowerShell 允许只写参数名的**无歧义前缀**，所以 `-c` / `-co` / … / `-command` 是同一个参数。
 *
 * 这里刻意用**枚举**而不是嵌套可选链（`-c(?:o(?:m(?:…)?)?)?`）：
 * 那种写法少一个 `?` 就会把最外层变成必选，于是只认 `-com` 以上，而 `-c` 静默放行 ——
 * 本轮第一版就是这么写的，实测才发现。枚举的每一项都能一眼数出来。
 */
const PS_ABBREV = (full: string): string =>
  `-(?:${Array.from({ length: full.length }, (_, i) => full.slice(0, i + 1)).join("|")})(?![a-z0-9])`;

const PS_COMMAND = PS_ABBREV("command");

/** shell 包装器：剥掉之后内层命令要按同样标准判 */
const WRAPPERS: RegExp[] = [
  /^(?:ba|z|da|k)?sh\s+-c\s+/i,
  /^cmd(?:\.exe)?\s+\/[ck]\s+/i,
  // `-EncodedCommand` **不在**这里：它不是「剥一层再看」，而是内容读不出来，见 family 表。
  new RegExp(`^(?:powershell|pwsh)(?:\\.exe)?\\s+(?:-\\w+\\s+)*${PS_COMMAND}\\s*`, "i"),
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
 * 启动器（launcher）：跑在你那条命令**前面**、替它改环境/权限/时限的那些词。
 *
 * 每个家族判据都长成 `t[0] === "rm"` 这样 —— 「命令词在第一个 token 上」。
 * 这个前提是错的：shell 允许在前面挂任意多个词。上一版只特判了 `sudo`，
 * 于是 `sudo -u root rm -rf /`（`sudo` 后面跟了选项）立刻变成放行。
 *
 * 所以这里不列举「危险命令怎么拼」，而是回答一个更早的问题：**命令词到底在第几个 token 上**。
 *   - `value`：这个启动器的哪些选项**带值** —— 值必须一起跳掉。
 *     少了它，`sudo -u root rm -rf /` 里的 `root` 会被当成命令词（就是上面那个洞）。
 *   - `command`：哪些选项的**值本身就是一条要执行的命令**（`su -c "rm -rf /"`）——
 *     不是跳掉，是剥出来接着判。
 *   - `positional`：启动器自己会先吃掉几个位置参数（`timeout 30 rm …` 里的 `30`）。
 *
 * 认定口径保守：**表里没有的词一律不当启动器**。宁可漏（README 已写明这不是沙箱），
 * 也不能误判 —— 一个乱杀命令的护栏会被用户和模型一起绕开。
 */
export interface LauncherSpec {
  value?: string[];
  command?: string[];
  positional?: number;
}

export const LAUNCHERS: Record<string, LauncherSpec> = {
  // 只列**真的带值**的选项。把无值选项写进来，后果是它会把下一个 token（也就是命令词）当值吞掉 ——
  // 那是这个文件正在修的同一类错误，方向相反而已。所以 `sudo -h`（= --help）、`-E`、`-n`、`-i`
  // 这些一律不进表：跳过它们自己就行，`sudo -h rm -rf /` 照样应该按 `rm -rf /` 判。
  sudo: {
    value: ["-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "--close-from",
            "-r", "--role", "-t", "--type", "-U", "--other-user",
            "-T", "--command-timeout", "-D", "--chdir", "-R", "--chroot"],
  },
  doas: { value: ["-u", "-C"] },
  env: { value: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"] },
  nohup: {},
  time: { value: ["-f", "--format", "-o", "--output"] },
  nice: { value: ["-n", "--adjustment"] },
  ionice: { value: ["-c", "-n", "-p", "-P", "-u"] },
  // `timeout 30 rm -rf /` / `timeout -k 5 30 rm -rf /` —— DURATION 是必给的
  timeout: { value: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
  // `chroot /newroot rm -rf /` —— NEWROOT 是必给的
  chroot: { value: ["--userspec", "--groups", "-u", "-g"], positional: 1 },
  // `su -c "…"` 里 `-c` 的值就是命令本身；`su root -c "…"` 里 user 是位置参数
  su: { command: ["-c", "--command"], positional: 1, value: ["-s", "--shell", "-g", "--group", "--supp-group"] },
  runuser: { command: ["-c", "--command"], value: ["-s", "--shell", "-g", "--group", "-u", "--user"] },
  command: {},
  builtin: {},
  exec: {},
  setsid: {},
  stdbuf: { value: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  strace: { value: ["-o", "--output", "-p", "--attach", "-e", "--trace", "-s", "--string-limit", "-P", "--trace-path"] },
  ltrace: { value: ["-o", "--output", "-p", "--attach", "-e"] },
  // `xargs -i` 是**无值**的旧写法（等价于 `-I{}`），`-I` 才带值
  xargs: {
    value: ["-n", "--max-args", "-I", "--replace", "-P", "--max-procs", "-d", "--delimiter",
            "-E", "--eof", "-L", "--max-lines", "-s", "--max-chars", "-a", "--arg-file"],
  },
  watch: { value: ["-n", "--interval"] },
  // macOS 的「别睡觉」，纯包装：真正的命令就是跟在它后面的那个
  caffeinate: { value: ["-t", "--timeout", "-w", "--wait-for"] },
};

/** 前置赋值 `FOO=bar rm -rf /` —— 它不改变后面那条命令的危险程度 */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * 定位真正的命令词，返回**从它开始**的 token 列表。
 *
 * 反复剥「启动器 + 它自己的选项/参数」，直到剩下一个不是启动器的词。
 * 全程不增不减 token 之外的东西 —— `\rm` 归一成 `rm`，`su -c "…"` 的值会被重新 token 化。
 *
 * 命名说明：以前叫 `stripElevation`，只剥 `sudo` / `doas`。名字一旦只描述特判，
 * 下一个人就会以为「开头挂别的词不用管」，那正是这个洞的成因。
 */
export function stripLaunchers(tokens: string[]): string[] {
  let t = tokens.slice();
  for (let depth = 0; depth < 5 && t.length > 1; depth++) {
    if (/^\\rm$/.test(t[0])) t[0] = "rm";
    if (ASSIGNMENT.test(t[0])) { t = t.slice(1); continue; }

    const spec = LAUNCHERS[t[0].toLowerCase()];
    if (!spec) break;

    let i = 1;
    let posLeft = spec.positional ?? 0;
    let inner: string[] | null = null;
    while (i < t.length) {
      const tok = t[i];
      if (tok === "--") { i++; break; }
      const eq = tok.indexOf("=");
      const key = (eq > 0 ? tok.slice(0, eq) : tok).toLowerCase();
      const inline = eq > 0;                      // `--user=root` 的值在同一个 token 里

      if (spec.command?.some((o) => o === key) && /^-/.test(tok)) {
        const val = inline ? tok.slice(eq + 1) : (i + 1 < t.length ? t[i + 1] : "");
        inner = tokenize(val).concat(t.slice(i + (inline ? 1 : 2)));
        break;
      }
      if (/^-/.test(tok) && tok !== "-") {
        i += spec.value?.some((o) => o === key) && !inline ? 2 : 1;
        continue;
      }
      if (posLeft > 0) { posLeft--; i++; continue; }  // 启动器自己的位置参数（`timeout 30`）
      break;                                          // 到命令词了
    }

    if (inner) return stripLaunchers(inner);
    const rest = t.slice(i);
    if (!rest.length) break;                       // 只剩启动器、没有命令 —— 原样返回，不切空
    t = rest;
  }
  return t.length ? t : tokens;
}

/**
 * `stripLaunchers` 的文本版：剥掉启动器前缀后的命令串；**头词没变就返回 `null`**。
 *
 * 为什么两个剥法不能只留一个：`nohup bash -c 'rm -rf /'` 要连着剥两层 ——
 * 先剥启动器（`nohup`，token 级），再剥 shell 包装（`bash -c`，字符串级）。
 * 只在 token 上剥的话第二层没人管，只在字符串上剥的话第一层没人管，
 * 于是「先挂个启动器、再套一层 shell」又是一条通道。所以候选集里两者都放，**并且能叠加**。
 */
export function stripLaunchersText(command: string): string | null {
  const tokens = tokenize(command);
  const stripped = stripLaunchers(tokens);
  if (!stripped.length || stripped[0] === tokens[0]) return null;
  return stripped.join(" ");
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

/** 各家族的判据。返回非空字符串 = 拦，字符串就是理由。t 已去过提权/启动器前缀。 */
const FAMILIES: Array<{ name: string; test: (t: string[], seg: string) => string }> = [
  {
    name: "fork-bomb",
    test: (_t, seg) => (/:\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;?\s*:/i.test(seg) ? "shell fork 炸弹" : ""),
  },
  {
    name: "powershell-encoded-command",
    // `-EncodedCommand` 及其无歧义缩写 —— 命令被 Base64 包起来，护栏读不出内容，
    // 但 PowerShell 会照跑。这是绕过「读命令名再判」这类护栏最标准的一招：宁可拦。
    // （判的是 seg 而不是 t：这段里 head 就是 `powershell` 本身，剥不出内层命令。）
    test: (_t, seg) =>
      new RegExp(`^(?:powershell|pwsh)(?:\\.exe)?\\s+(?:-\\w+\\s+)*${PS_ABBREV("encodedcommand")}`, "i").test(seg)
        ? "PowerShell 的 -EncodedCommand：命令被编码，护栏读不出内容"
        : "",
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
 * 把「原串 / 每条 segment / 每层往内剥出来的形态」都收进候选集再逐条判 ——
 * 否则 `sh -c "rm -rf ~"`、`nohup bash -c "rm -rf /"` 与 `rm -rf ~` 不同罪。
 * 两种剥法（包装层 / 启动器）都进队列，所以能叠加，不是各剥一层就完事。
 */
export function checkCommand(command: string): GuardVerdict {
  const raw = normalize(command);
  if (!raw) return OK;

  const seen = new Set<string>();
  const queue: string[] = [raw, ...splitSegments(raw)];
  for (let i = 0; i < queue.length && seen.size < 200; i++) {
    const cur = queue[i];
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of [unwrap(cur), stripLaunchersText(cur)]) {
      if (!next || next === cur) continue;
      queue.push(next, ...splitSegments(next));
    }
  }

  for (const seg of seen) {
    const t = stripLaunchers(tokenize(seg));
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
