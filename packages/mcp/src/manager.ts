import type { AgentDatabase, McpServerEntity } from '@agentos/database';
import type { ToolDefinition, ToolRegistry, ToolResult } from '@agentos/tool-registry';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface ConnectedServer {
  client: Client;
  tools: McpToolInfo[];
}

const MCP_OUTPUT_MAX = 8_000;

/**
 * MCP integration boundary: connects to stdio MCP servers, discovers their
 * tools, mirrors them into the AgentOS tool registry, and executes calls.
 * Every MCP call still passes AgentOS policy + permissions first and is
 * captured in the run trace like any other tool.
 */
export class McpManager {
  private readonly connections = new Map<string, ConnectedServer>();

  constructor(
    private readonly db: AgentDatabase,
    private readonly registry: ToolRegistry,
  ) {}

  /** Connects, discovers tools, registers them in DB + registry. Returns tool count. */
  async connect(server: McpServerEntity): Promise<number> {
    await this.disconnect(server.id).catch(() => undefined);
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: { ...(process.env as Record<string, string>), ...server.env },
      stderr: 'pipe',
    });
    const client = new Client({ name: `agentos/${server.name}`, version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
    const { tools } = await client.listTools();

    const infos: McpToolInfo[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
    }));
    this.connections.set(server.id, { client, tools: infos });

    // Mirror into DB + runtime registry under mcp.<server>.<tool>
    this.db.tools.deleteByServer(server.id);
    for (const info of infos) {
      const fullName = `mcp.${server.name}.${info.name}`;
      this.registry.registerOrReplace(this.buildDefinition(server, info, fullName));
      this.db.tools.upsert({
        name: fullName,
        description: info.description ?? `MCP tool ${info.name} from server ${server.name}`,
        kind: 'mcp',
        source: 'mcp',
        riskLevel: server.riskLevel,
        permissions: ['mcp:invoke'],
        inputSchema: info.inputSchema ?? {},
        mcpServerId: server.id,
      });
    }
    this.db.mcp.updateStatus(server.id, 'connected', infos.length);
    return infos.length;
  }

  private buildDefinition(server: McpServerEntity, info: McpToolInfo, fullName: string): ToolDefinition {
    return {
      name: fullName,
      description: info.description ?? `MCP tool ${info.name} (server: ${server.name})`,
      kind: 'mcp',
      riskLevel: server.riskLevel,
      permissions: ['mcp:invoke'],
      // MCP servers validate their own schemas; we accept any object here and
      // keep the published JSON schema for UI/validation display.
      inputSchema: z.record(z.string(), z.unknown()) as unknown as ToolDefinition['inputSchema'],
      inputSchemaJson: info.inputSchema ?? { type: 'object' },
      timeoutMs: 30_000,
      maxRetries: 1,
      sampleInput: () => {
        const props = (info.inputSchema?.properties ?? {}) as Record<string, { type?: string }>;
        const sample: Record<string, unknown> = {};
        for (const [key, schema] of Object.entries(props)) {
          sample[key] = schema.type === 'integer' || schema.type === 'number' ? 1 : 'sample';
        }
        return sample;
      },
      handler: async (raw): Promise<ToolResult> => {
        const conn = this.connections.get(server.id);
        if (!conn) {
          return {
            ok: false,
            output: '',
            error: `MCP server "${server.name}" is not connected — reconnect from the Tools page`,
            errorKind: 'permanent',
          };
        }
        try {
          const result = (await conn.client.callTool({
            name: info.name,
            arguments: (raw ?? {}) as Record<string, unknown>,
          })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
          const text = (result.content ?? [])
            .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`))
            .join('\n');
          const truncated = text.length > MCP_OUTPUT_MAX ? `${text.slice(0, MCP_OUTPUT_MAX)}…` : text;
          if (result.isError) {
            return { ok: false, output: '', error: truncated || 'MCP tool returned isError', errorKind: 'permanent' };
          }
          return { ok: true, output: truncated, data: { server: server.name, tool: info.name } };
        } catch (e) {
          return {
            ok: false,
            output: '',
            error: `MCP call failed: ${(e as Error).message}`,
            errorKind: 'transient',
          };
        }
      },
    };
  }

  async disconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    this.connections.delete(serverId);
    await conn.client.close().catch(() => undefined);
  }

  async removeServer(serverId: string): Promise<void> {
    await this.disconnect(serverId);
    this.db.tools.deleteByServer(serverId);
  }

  isConnected(serverId: string): boolean {
    return this.connections.has(serverId);
  }

  /** Best-effort reconnect on boot; failures mark the server errored. */
  async connectAllRegistered(): Promise<{ connected: number; failed: number }> {
    let connected = 0;
    let failed = 0;
    for (const server of this.db.mcp.list()) {
      try {
        await this.connect(server);
        connected += 1;
      } catch (e) {
        this.db.mcp.updateStatus(server.id, 'error', 0);
        failed += 1;
        void e;
      }
    }
    return { connected, failed };
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }
}
