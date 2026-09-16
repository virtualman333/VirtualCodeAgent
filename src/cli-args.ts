/**
 * CLI 参数解析 —— 纯函数：不读文件、不打印、不 exit、不碰 process。
 *
 * 返回「结果」而不是直接打印，是为了让调用方决定怎么显示，也让解析规则可以被测试。
 *
 * 契约（只写在这一个文件里，别在别处再判一遍参数）：
 *   -h, --help             显示帮助后退出
 *   -v, --version          显示版本号后退出
 *   -w, --workspace <路径> 指定工作空间
 *   -m, --model <名称>     指定模型
 *       --list-workspaces  列出历史工作空间后退出
 *       --                 其后的参数一律当位置参数
 *   位置参数               至多一个，等同 -w
 *
 * 四条容易踩的边界，这里都当成**错误**而不是静默忽略 —— 静默忽略正是
 * 这类 CLI 最坏的失败模式（用户以为指定了模型/工作空间，其实没有）：
 *   1. 未知参数          `vca --workpsace /p` 不再悄悄用默认工作空间启动
 *   2. 该取值的选项缺值   `vca -m` 不再悄悄用默认模型启动
 *   3. 取值写成了选项     `vca -w -m gpt` 里 `-m` 会被当成路径，这里直接报错
 *   4. 两种指定方式打架   `-w a` 与位置参数同时给出时不再静默丢弃后者
 *
 * 唯一的例外是 --help / --version：它们在任何位置都立即生效，哪怕别处写错了
 * 也照样能看到帮助。首次安装还没填 API Key 时，恰恰最需要 `--help` ——
 * 而 main() 里配置校验一旦排在前面，帮助页就永远看不到。
 */

export interface CliArgs {
  /** 工作空间（-w / --workspace / 位置参数），未指定为 null */
  workspace: string | null;
  /** 模型（-m / --model），未指定为 null */
  model: string | null;
  /** --list-workspaces */
  listWorkspaces: boolean;
  /** -h / --help */
  help: boolean;
  /** -v / --version */
  version: boolean;
}

export type ParseResult = { ok: true; args: CliArgs } | { ok: false; error: string };

export const USAGE = [
  "用法: vca [选项] [工作空间路径]",
  "",
  "选项:",
  "  -w, --workspace <路径>   指定工作空间（不指定则交互选择）",
  "  -m, --model <名称>       指定模型（覆盖配置文件里的默认模型）",
  "      --list-workspaces    列出最近使用过的工作空间后退出",
  "  -h, --help               显示帮助后退出",
  "  -v, --version            显示版本号后退出",
  "",
  "示例:",
  "  vca                          交互选择工作空间",
  "  vca /path/to/project         直接进入某个项目",
  "  vca -w /path/to/project      同上，写法更明确",
  "  vca -m deepseek              指定模型启动",
].join("\n");

/** 需要取值的选项 */
const VALUE_FLAGS = new Set(["--workspace", "--model"]);
/** 短选项 → 长选项 */
const SHORT_ALIAS: Record<string, string> = {
  w: "--workspace",
  m: "--model",
  h: "--help",
  v: "--version",
};
/** 已知的长选项（用于「是不是拼错了」的提示） */
const KNOWN_LONG = ["--workspace", "--model", "--list-workspaces", "--help", "--version"];

function ok(args: CliArgs): ParseResult {
  return { ok: true, args };
}

function fail(error: string): ParseResult {
  return { ok: false, error };
}

function helpResult(): ParseResult {
  return ok({ workspace: null, model: null, listWorkspaces: false, help: true, version: false });
}

function versionResult(): ParseResult {
  return ok({ workspace: null, model: null, listWorkspaces: false, help: false, version: true });
}

/** 编辑距离 —— 只为了给拼错的选项一句「是否想输入…」 */
function distance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1).fill(0);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** 给一个无法识别的参数配一句话；认不出来就只说「未知参数」 */
export function describeUnknown(token: string): string {
  // `-w=x`：短选项不吃等号，单独给一句，否则用户只会看到「未知参数 -w=x」而不知所措
  const shortEq = /^-([A-Za-z])=(.*)$/.exec(token);
  if (shortEq && SHORT_ALIAS[shortEq[1]]) {
    return `短选项 -${shortEq[1]} 取值要写成 "-${shortEq[1]} <值>"，不能用等号`;
  }

  const bare = token.replace(/^-+/, "");
  if (bare.length >= 3) {
    let best: string | null = null;
    let bestD = 3;
    for (const cand of KNOWN_LONG) {
      const d = distance(bare, cand.replace(/^-+/, ""));
      if (d < bestD) {
        bestD = d;
        best = cand;
      }
    }
    if (best) return `未知参数 ${token}（是否想输入 ${best}？）`;
  }
  return `未知参数 ${token}`;
}

/** 一个 token 看起来像选项（而不是值）—— 用来拦住 `vca -w -m gpt` 这种写法 */
function looksLikeOption(token: string): boolean {
  return token === "--" || /^-[A-Za-z]/.test(token);
}

/**
 * 解析 argv（不含 node 与脚本路径）。
 * 任何一处不合契约就返回 ok:false，由调用方决定退出码与显示位置。
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  // --help / --version 先扫一遍：只要出现在 `--` 之前就立刻生效，
  // 不受后面任何参数写错的影响。
  for (const a of argv) {
    if (a === "--") break;
    if (a === "--help" || a === "-h") return helpResult();
    if (a === "--version" || a === "-v") return versionResult();
  }

  let workspace: string | null = null;
  let model: string | null = null;
  let listWorkspaces = false;
  let positional: string | null = null;
  let onlyPositional = false;

  const takeValue = (flag: string, value: string): string | null => {
    if (value === "") return `${flag} 的值不能为空`;
    if (flag === "--workspace") {
      if (workspace !== null) return `--workspace 重复指定（已经给过 ${workspace}）`;
      workspace = value;
    } else {
      if (model !== null) return `--model 重复指定（已经给过 ${model}）`;
      model = value;
    }
    return null;
  };

  const takePositional = (value: string): string | null => {
    if (value === "") return "工作空间路径不能为空";
    if (positional !== null) {
      return `只能给一个工作空间路径（已经有 ${positional}，又多出 ${value}）`;
    }
    positional = value;
    return null;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (onlyPositional) {
      const err = takePositional(a);
      if (err) return fail(err);
      continue;
    }

    if (a === "--") {
      onlyPositional = true;
      continue;
    }

    // 长选项（支持 --flag=value）
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq >= 0 ? a.slice(0, eq) : a;
      const inline = eq >= 0 ? a.slice(eq + 1) : null;

      // 理论上走不到这里（上面已扫过），保留是为了防御顺序被改动
      if (name === "--help") return helpResult();
      if (name === "--version") return versionResult();

      if (name === "--list-workspaces") {
        if (inline !== null) return fail("--list-workspaces 不取值");
        listWorkspaces = true;
        continue;
      }

      if (VALUE_FLAGS.has(name)) {
        if (inline !== null) {
          const err = takeValue(name, inline);
          if (err) return fail(err);
          continue;
        }
        const next = argv[i + 1];
        if (next === undefined) return fail(`${name} 后面要跟一个值`);
        if (looksLikeOption(next)) {
          return fail(`${name} 后面要跟一个值，但读到的是选项 ${next}`);
        }
        i++;
        const err = takeValue(name, next);
        if (err) return fail(err);
        continue;
      }

      return fail(describeUnknown(a));
    }

    // 短选项（支持 -hv 这种纯开关合并）
    if (a.startsWith("-") && a.length > 1) {
      // `-w=/proj` 要先单独拦下：不拦的话它会被当成「合并短选项」，
      // 逐字符检查到 `=` 就报出「未知参数 -=」，用户完全看不出哪里错了。
      const shortEq = /^-([A-Za-z])=(.*)$/.exec(a);
      if (shortEq) {
        return fail(SHORT_ALIAS[shortEq[1]] ? describeUnknown(`-${shortEq[1]}=${shortEq[2]}`) : `未知参数 ${a}`);
      }

      const chars = a.slice(1).split("");

      const unknown = chars.find((c) => !SHORT_ALIAS[c]);
      if (unknown) return fail(describeUnknown(`-${unknown}`));

      const valueChar = chars.find((c) => VALUE_FLAGS.has(SHORT_ALIAS[c]));
      if (valueChar) {
        // 取值型短选项不能与别的合并（`-wm` 该读成什么？不猜）
        if (chars.length > 1) {
          return fail(`短选项 -${valueChar} 需要取值，不能和其它短选项合并写`);
        }
        const long = SHORT_ALIAS[valueChar];
        const next = argv[i + 1];
        if (next === undefined) return fail(`-${valueChar} 后面要跟一个值（等价于 ${long} <值>）`);
        if (looksLikeOption(next)) {
          return fail(`-${valueChar} 后面要跟一个值，但读到的是选项 ${next}`);
        }
        i++;
        const err = takeValue(long, next);
        if (err) return fail(err);
        continue;
      }

      // 到这里 chars 只可能由 h / v 组成（SHORT_ALIAS 里再无其它纯开关）。
      // 与 `-v -h` 分开写时保持一致：从左往右，先出现的先生效。
      return chars[0] === "h" ? helpResult() : versionResult();
    }

    const err = takePositional(a);
    if (err) return fail(err);
  }

  if (positional !== null) {
    if (workspace !== null) {
      return fail(`既用 --workspace 指定了 ${workspace}，又给了位置参数 ${positional}，二者只能留一个`);
    }
    workspace = positional;
  }

  if (listWorkspaces && workspace !== null) {
    return fail(`--list-workspaces 与指定工作空间（${workspace}）不能同时用：前者只是列出后退出`);
  }

  return ok({ workspace, model, listWorkspaces, help: false, version: false });
}
