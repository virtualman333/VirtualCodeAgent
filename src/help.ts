/**
 * 斜杠命令清单 —— **单一来源**。
 *
 * 以前这份清单有两处写法：一处是 showHelp() 里手写的一串 print()，
 * 另一处是 handleCommand() 的 switch case。两份手工维护的清单必然漂移：
 * 加一个 case 忘了补一行帮助，用户就永远看不见那个命令；
 * 删一个 case 忘了删帮助，用户照着敲只会得到「未知命令」。
 *
 * 现在命令的「名字 / 用法 / 说明」只写在这里，showHelp() 从它渲染；
 * 实现仍在 main.ts 的 switch 里（分支体要改 state，不适合搬到纯数据模块），
 * 由 tests/help.test.ts 双向比对两份清单，谁少了谁就红。
 */
import { cyan, bold, displayWidth, padRight } from "./ui.js";

export interface CommandSpec {
  /** 命令名，必须与 main.ts 里 `case "<name>":` 逐字一致 */
  name: string;
  /** 用法，可有多行（如 /config 与 /config set） */
  usage: string | string[];
  /** 一行说明 */
  desc: string;
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: "/help", usage: "/help", desc: "显示帮助" },
  { name: "/new", usage: "/new", desc: "开启新对话窗口" },
  { name: "/clear", usage: "/clear", desc: "清除对话历史" },
  { name: "/cd", usage: "/cd <路径>", desc: "切换工作空间" },
  { name: "/workspace", usage: "/workspace", desc: "显示当前工作空间" },
  { name: "/verbose", usage: "/verbose", desc: "切换思考展开/折叠" },
  { name: "/todo", usage: "/todo", desc: "查看当前任务计划" },
  { name: "/skills", usage: "/skills", desc: "列出已发现的技能 (SKILL.md)" },
  { name: "/mcp", usage: "/mcp", desc: "查看 MCP server 配置与连接状态" },
  { name: "/agents", usage: "/agents", desc: "子代理：可用预设 + 本次会话的运行记录" },
  { name: "/config", usage: ["/config", "/config set K V"], desc: "显示配置 / 修改配置" },
  { name: "/model", usage: "/model", desc: "查看/切换模型 (如 /model deepseek)" },
  { name: "/save", usage: "/save", desc: "保存当前对话" },
  { name: "/load", usage: "/load [序号]", desc: "恢复历史对话" },
  { name: "/history", usage: "/history", desc: "列出历史会话" },
  {
    name: "/input",
    usage: ["/input [条数]", "/input <关键字>", "/input clear"],
    desc: "查看 / 搜索 / 清空输入历史",
  },
  { name: "/exit", usage: "/exit", desc: "退出" },
];

/** 全部命令名（不含用法）—— 用于校验用户输入与锁一致性 */
export function commandNames(): string[] {
  return COMMANDS.map((c) => c.name);
}

export function isKnownCommand(name: string): boolean {
  return COMMANDS.some((c) => c.name === name);
}

/**
 * 渲染帮助文本（返回行数组，不打印 —— 打印是 ui 的事）。
 * 对齐按显示宽度算：CJK 字算两列，否则 `路径` 这类词会把整列顶歪。
 */
export function renderHelp(verbose = false): string[] {
  const rows: Array<[string, string]> = [];
  for (const spec of COMMANDS) {
    const usages = Array.isArray(spec.usage) ? spec.usage : [spec.usage];
    usages.forEach((u, i) => {
      rows.push([u, i === 0 ? spec.desc : ""]);
    });
  }

  const col = Math.max(...rows.map(([u]) => displayWidth(u)));
  const lines: string[] = [bold("可用命令:")];
  for (const [u, desc] of rows) {
    // 先按纯文本补齐再上色：ANSI 不计宽度，padding 不会被颜色顶歪
    lines.push(`  ${cyan(padRight(u, col))}  ${desc}`.trimEnd());
  }

  if (verbose) {
    lines.push("");
    lines.push("提示: 大文件会自动分块，Agent 会用 chunk=N 分块读取");
    lines.push("Ctrl+C 可在 Agent 执行过程中打断");
    lines.push("↑/↓ 翻回敲过的内容（跨会话保留），Tab 补全命令、路径、配置键、模型名");
    // ⚠ 提示区每一行都不能以 `/` 开头：tests/help.test.ts 靠这个约定判断
    // 「多出来的只是提示，没有混进命令行」——以命令名开头会让那道锁形同虚设。
    lines.push("输入历史不只是 ↑ 一条条翻：/input 可查看、搜索、清空");
  }
  return lines;
}
