/**
 * MCP 管理器 - 配置读取、连接 MCP servers、收集动态工具
 *
 * 每个 MCP 工具在调用时自动创建/销毁 session (短生命周期, 参考 Python 版)。
 *
 * 配置文件格式 (mcp.json):
 * {
 *   "servers": {
 *     "server_name": {
 *       "transport": "stdio",                 // stdio | http
 *       "command": "npx",                     // stdio 必需
 *       "args": ["-y", "@modelcontextprotocol/server-fetch"],
 *       "env": {"KEY": "VALUE"}               // 可选
 *     },
 *     "http_server": {
 *       "transport": "http",                  // http 使用 url
 *       "url": "http://localhost:8000/mcp"
 *     }
 *   }
 * }
 *
 * 配置位置 (优先级从高到低):
 * 1. 项目根: <workspace>/.vca/mcp.json
 * 2. 用户级: ~/.vca/mcp.json
 */
import fs from "node:fs";
import path from "node:path";
import { DynamicStructuredTool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { MCP_CONFIG_FILE } from "../config.js";
import { getWorkspace } from "../workspace_ctx.js";

export interface McpServerConfig {
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  [key: string]: unknown;
}

interface McpServer {
  name: string;
  config: McpServerConfig;
}

// ============================================================
// JSON Schema → Zod 转换 (MCP 工具 inputSchema)
// ============================================================

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  const type = (schema.type as string) ?? inferType(schema);

  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array": {
      const items = schema.items as Record<string, unknown> | undefined;
      return z.array(items ? jsonSchemaToZod(items) : z.any());
    }
    case "object": {
      const properties = (schema.properties as Record<string, unknown>) ?? {};
      const required = (schema.required as string[]) ?? [];
      const shape: Record<string, z.ZodType> = {};
      for (const [key, value] of Object.entries(properties)) {
        const fieldSchema = jsonSchemaToZod(value as Record<string, unknown>);
        shape[key] = required.includes(key) ? fieldSchema : fieldSchema.optional();
      }
      return z.object(shape);
    }
    case "enum": {
      const enums = schema.enum as unknown[] | undefined;
      if (enums && enums.length > 0 && enums.every((e) => typeof e === "string")) {
        return z.enum(enums as [string, ...string[]]);
      }
      return z.any();
    }
    default:
      return z.any();
  }
}

function inferType(schema: Record<string, unknown>): string {
  if (schema.enum) return "enum";
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "string";
}

// ============================================================
// 会话创建与调用
// ============================================================

async function createClient(server: McpServer): Promise<{ client: Client; close: () => Promise<void> }> {
  const cfg = server.config;
  const client = new Client(
    { name: "vca", version: "0.2.0" },
    { capabilities: {} }
  );

  if (cfg.transport === "http" || cfg.transport === "sse" || cfg.transport === "streamable-http") {
    if (!cfg.url) throw new Error("http/sse transport 需要 url 配置");
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url));
    await client.connect(transport);
    return {
      client,
      close: async () => {
        try {
          await client.close();
          await transport.close();
        } catch {
          /* ignore */
        }
      },
    };
  }

  // 默认 stdio
  const command = cfg.command;
  if (!command) throw new Error("stdio transport 需要 command 配置");
  const transport = new StdioClientTransport({
    command,
    args: cfg.args ?? [],
    env: cfg.env ?? {},
    cwd: getWorkspace(),
    stderr: "pipe",
  });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      try {
        await client.close();
        await transport.close();
      } catch {
        /* ignore */
      }
    },
  };
}

async function callMcpTool(server: McpServer, toolName: string, args: Record<string, unknown>): Promise<string> {
  const { client, close } = await createClient(server);
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    return formatMcpResult(result);
  } finally {
    await close();
  }
}

function formatMcpResult(result: unknown): string {
  const r = result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  };
  const parts: string[] = [];
  for (const block of r.content ?? []) {
    if (block.text) parts.push(block.text);
    else parts.push(JSON.stringify(block));
  }
  if (r.structuredContent !== undefined) {
    parts.push(JSON.stringify(r.structuredContent, null, 2));
  }
  const body = parts.join("\n").trim() || "(空结果)";
  return r.isError ? `[MCP ERROR] ${body}` : `[MCP OK] ${body}`;
}

// ============================================================
// MCPManager
// ============================================================

export class MCPManager {
  private _tools: StructuredToolInterface[] = [];
  private _serverStatus = new Map<string, string>();
  private _connected = false;

  /** 读取 MCP 配置 (用户级 + 项目级, 后者覆盖前者) */
  loadConfig(): McpServer[] {
    const servers = new Map<string, McpServerConfig>();
    const candidates = [
      MCP_CONFIG_FILE,
      path.join(getWorkspace(), ".vca", "mcp.json"),
    ];
    for (const file of candidates) {
      try {
        if (!fs.existsSync(file)) continue;
        const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
          servers?: Record<string, McpServerConfig>;
        };
        const cfg = data.servers ?? {};
        for (const [name, serverCfg] of Object.entries(cfg)) {
          if (serverCfg && typeof serverCfg === "object") {
            servers.set(name, serverCfg);
          }
        }
      } catch {
        continue;
      }
    }
    return [...servers.entries()].map(([name, config]) => ({ name, config }));
  }

  /** 连接所有配置的 servers 并收集工具 (失败不阻塞) */
  async connect(): Promise<Record<string, string>> {
    const servers = this.loadConfig();
    const status: Record<string, string> = {};
    const allTools: StructuredToolInterface[] = [];
    const multiServer = servers.length > 1;

    for (const server of servers) {
      try {
        const { client, close } = await createClient(server);
        let tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = [];
        try {
          const result = await client.listTools();
          tools = result.tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
          }));
        } finally {
          await close();
        }

        const converted = tools.map((t) => this.toLangChainTool(server, t, multiServer));
        allTools.push(...converted);
        status[server.name] = `ok (${converted.length} tools)`;
      } catch (e) {
        status[server.name] = `error: ${(e as Error).constructor.name}: ${(e as Error).message}`;
      }
    }

    this._tools = allTools;
    this._serverStatus = new Map(Object.entries(status));
    this._connected = true;
    return status;
  }

  private toLangChainTool(
    server: McpServer,
    mcpTool: { name: string; description?: string; inputSchema: Record<string, unknown> },
    multiServer: boolean
  ): StructuredToolInterface {
    const toolName = multiServer ? `${server.name}__${mcpTool.name}` : mcpTool.name;
    const schema = jsonSchemaToZod(mcpTool.inputSchema);

    return new DynamicStructuredTool({
      name: toolName,
      description: `[MCP:${server.name}] ${mcpTool.description ?? mcpTool.name}`,
      schema,
      func: async (args) => {
        return callMcpTool(server, mcpTool.name, args as Record<string, unknown>);
      },
    });
  }

  get tools(): StructuredToolInterface[] {
    return this._tools;
  }

  get isConnected(): boolean {
    return this._connected;
  }

  /** server 状态 Map (name → 状态文本) */
  serverStatus(): Map<string, string> {
    return new Map(this._serverStatus);
  }

  statusText(): string {
    if (this._serverStatus.size === 0) {
      return (
        "MCP servers 未配置。\n" +
        "在 ~/.vca/mcp.json 或 <项目>/.vca/mcp.json 中配置后重启生效。"
      );
    }
    const lines = ["MCP server 状态:"];
    for (const [name, st] of this._serverStatus) {
      lines.push(`  - ${name}: ${st}`);
    }
    if (this._tools.length > 0) {
      const names = this._tools.map((t) => t.name).join(", ");
      lines.push(`共加载 ${this._tools.length} 个工具: ${names}`);
    }
    return lines.join("\n");
  }
}

// 全局单例
export const mcpManager = new MCPManager();
