/**
 * Bash 工具 - 万能 Shell 命令执行
 */
import { exec } from "node:child_process";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getWorkspace } from "../workspace_ctx.js";

// ---- 安全警告命令 ----
const RISKY_COMMANDS = [
  "rm -rf /",
  "del /f /s c:\\",
  "format ",
  ":(){ :|:& };:",
  "chmod 777 /",
  "sudo rm -rf",
  "dd if=",
  "mkfs.",
];

function isRisky(command: string): boolean {
  const lower = command.toLowerCase().trim();
  return RISKY_COMMANDS.some((r) => lower.includes(r.toLowerCase()));
}

function truncateHeadTail(text: string, max: number, head: number, tail: number): string {
  if (text.length <= max) return text;
  const h = text.slice(0, head);
  const t = text.slice(-tail);
  return `${h}\n\n... (输出共 ${text.length.toLocaleString()} 字符, 中间已省略) ...\n\n${t}`;
}

export const bash = tool(
  async (input: { command: string; timeout?: number; description?: string }) => {
    const { command, timeout = 120, description = "" } = input;

    if (isRisky(command)) {
      return (
        `[BLOCKED] 危险命令被拦截: ${command}\n` +
        `如确实需要执行，请手动在终端中运行。`
      );
    }

    const cwd = getWorkspace();

    try {
      const result = await runCommand(command, cwd, timeout);
      const parts: string[] = [];

      if (result.stdout) {
        parts.push(truncateHeadTail(result.stdout.trimEnd(), 15000, 12000, 3000));
      }
      if (result.stderr) {
        parts.push(`[STDERR]\n${truncateHeadTail(result.stderr.trimEnd(), 3000, 2000, 1000)}`);
      }
      if (result.code !== 0) {
        parts.push(`[EXIT CODE: ${result.code}]`);
      }
      if (parts.length === 0) parts.push("(无输出)");

      const prefix = result.code === 0 ? "[OK] BASH" : "[ERR] BASH";
      const label = description || command;
      const body = parts.join("\n");
      // 首行: [OK]/[ERR] BASH: <描述>，后续是输出（避免重复 command）
      return `${prefix}: ${label}\n${body}`;
    } catch (e) {
      const err = e as { killed?: boolean; signal?: string; message?: string };
      if (err.killed) return `[ERROR] BASH 超时 (${timeout}s): ${command}`;
      return `[ERROR] BASH 执行失败: ${err.message}`;
    }
  },
  {
    name: "bash",
    description:
      "执行 Shell 命令并返回结果。这是运行测试、构建、lint、git 操作、包安装等任务的万能工具。注意：危险命令会被拦截，默认超时 120 秒。",
    schema: z.object({
      command: z.string().describe("要执行的 shell 命令"),
      timeout: z.number().int().optional().describe("超时时间 (秒)，默认 120"),
      description: z.string().optional().describe("命令用途描述（可选）"),
    }),
  }
);

function runCommand(command: string, cwd: string, timeoutSec: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd,
        shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
        encoding: "utf8",
        timeout: timeoutSec * 1000,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const execErr = error as Error & { killed?: boolean; code?: number; signal?: string };
          if (execErr.killed) {
            reject({ killed: true, message: `超时 (${timeoutSec}s)` });
          } else {
            // 命令非零退出码也是正常结果，返回 code
            resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: execErr.code ?? 1 });
          }
        } else {
          resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 });
        }
      }
    );
  });
}
