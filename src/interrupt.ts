/**
 * 打断处理 - Agent 运行期间的 Ctrl+C
 *
 * 设计:
 * - prompt 阶段: readline 接口捕获 Ctrl+C (见 ui.promptUser), 不影响这里
 * - agent 运行阶段: 无活跃 readline, Ctrl+C 触发进程级 SIGINT
 *   → 设置 interrupted 标志, 流式循环检查并暂停
 */

let interrupted = false;
let installed = false;

export function isInterrupted(): boolean {
  return interrupted;
}

export function setInterrupted(v: boolean): void {
  interrupted = v;
}

/** 安装全局 SIGINT handler (仅一次) */
export function installSigintHandler(): void {
  if (installed) return;
  installed = true;
  process.on("SIGINT", () => {
    interrupted = true;
  });
}

export type InterruptChoice = "resume" | "command" | "cancel";

/**
 * 打断菜单: 用户选择 继续 / 注入指令 / 取消
 * 返回 null 表示无法读取输入
 */
export async function handleInterrupt(): Promise<InterruptChoice | null> {
  const { print, yellow, dim, cyan, promptUser } = await import("./ui.js");
  print();
  print(yellow("⏸ 已打断当前执行"));
  print();
  print("  1. 继续执行");
  print("  2. 注入新指令");
  print("  3. 取消任务");
  print();

  const answer = await promptUser("请选择 (默认 1): ");
  if (answer === null) return "cancel";
  const choice = answer.trim() || "1";
  if (choice === "2") return "command";
  if (choice === "3") return "cancel";
  return "resume";
}

/** 读取打断后注入的指令 */
export async function readInterruptCommand(): Promise<string> {
  const { print, dim, promptUser } = await import("./ui.js");
  print(dim("请输入新指令 (回车放弃):"));
  const answer = await promptUser("> ");
  return (answer ?? "").trim();
}
