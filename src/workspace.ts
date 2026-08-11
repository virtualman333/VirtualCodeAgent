/**
 * 工作空间选择与切换
 */
import path from "node:path";
import { Config } from "./config.js";
import { print, cyan, bold, dim, yellow, promptUser } from "./ui.js";

export interface WorkspaceSelection {
  path: string;
  explicit: boolean;
}

/**
 * 选择工作空间。
 * - cliPath 提供 → 直接使用 (explicit=true)
 * - 有历史记录 → 交互选择 (回车=最新, 数字=历史项, 其他=新路径)
 * - 无历史 → 输入新路径
 */
export async function selectWorkspace(cliPath: string | null): Promise<WorkspaceSelection> {
  if (cliPath) {
    return { path: Config.resolveWorkspace(cliPath), explicit: true };
  }

  const history = Config.getWorkspaceHistory();

  if (history.length > 0) {
    print(dim("最近使用的工作空间:"));
    history.forEach((p, i) => {
      const mark = i === 0 ? " (最近)" : "";
      print(`  ${cyan(String(i + 1))}. ${p}${dim(mark)}`);
    });
    print(`  ${cyan(String(history.length + 1))}. 输入其他路径`);
    print();

    const answer = await promptUser("选择工作空间 (回车=最近): ");
    if (answer === null) {
      // 用户取消 → 使用默认
      return { path: Config.WORKSPACE_DIR, explicit: false };
    }
    const choice = answer.trim();
    if (choice === "") {
      return { path: history[0], explicit: false };
    }
    const idx = parseInt(choice, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= history.length) {
      return { path: history[idx - 1], explicit: false };
    }
    if (choice === String(history.length + 1) || true) {
      // 数字超出或非数字 → 视为新路径输入
      return await promptNewPath();
    }
  }

  return await promptNewPath();
}

async function promptNewPath(): Promise<WorkspaceSelection> {
  print(dim("请输入工作空间/项目目录路径 (回车使用默认):"));
  const answer = await promptUser("> ");
  if (answer === null || !answer.trim()) {
    return { path: Config.WORKSPACE_DIR, explicit: false };
  }
  const resolved = Config.resolveWorkspace(answer.trim());
  return { path: resolved, explicit: true };
}

/**
 * 切换工作空间 (/cd <路径>)。
 * 返回新工作空间路径，或 null (未切换)。
 */
export async function switchWorkspace(arg: string, current: string): Promise<string | null> {
  const rest = arg.replace(/^\/cd\s*/, "").trim();
  if (!rest) {
    print(`当前工作空间: ${cyan(current)}`);
    return null;
  }
  const target = path.isAbsolute(rest)
    ? rest
    : path.resolve(current, rest);
  try {
    const resolved = Config.resolveWorkspace(target);
    if (resolved === current) {
      print(dim("已在当前工作空间"));
      return null;
    }
    print(`${green("✓ 已切换工作空间:")} ${bold(cyan(resolved))}`);
    return resolved;
  } catch (e) {
    print(yellow(`无法切换工作空间: ${(e as Error).message}`));
    return null;
  }
}

function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}
