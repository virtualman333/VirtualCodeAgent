/**
 * AskUser 工具 - 让 LLM 向用户提问
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const askUser = tool(
  async () => {
    // 函数体永远不会被真正执行 —— 由工作流特殊节点拦截
    return "[AWAITING_USER_INPUT]";
  },
  {
    name: "ask_user",
    description:
      "向用户提问以澄清模糊信息或确认关键决策。使用场景：用户指令模糊有多种理解、需要确认文件路径/命名约定/技术选型、执行不可逆操作前需要确认。不要滥用：只在确实需要时才提问。",
    schema: z.object({
      question: z.string().describe("向用户提出的具体问题（尽量清晰具体）"),
      header: z.string().optional().describe("问题的简短标题（可选，如 '确认路径'、'选择模式'）"),
      options: z
        .string()
        .optional()
        .describe(
          "预设选项，用 | 分隔。如 'React|Vue|Angular' 提供单选，如 '[可多选] Git|Linter|TypeScript|Docker' 提供多选。留空则允许用户自由输入。"
        ),
    }),
  }
);
