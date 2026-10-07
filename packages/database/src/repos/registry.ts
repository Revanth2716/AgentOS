import type { SqliteDb } from '../db.js';
import { nextId } from '../db.js';
import { jsonString, parseJson } from '../repo-utils.js';
import type { McpServerEntity, PolicyEntity, PolicyRuleEntity, ToolEntity } from '../entities.js';
import type { McpServerSpec, PolicySpec, RiskLevel } from '@agentos/shared';

interface ToolRow {
  id: string;
  name: string;
  description: string;
  kind: string;
  source: string;
  risk_level: string;
  permissions: string;
  input_schema: string;
  enabled: number;
  mcp_server_id: string | null;
  created_at: number;
  updated_at: number;
}

function toTool(r: ToolRow): ToolEntity {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    kind: r.kind,
    source: r.source === 'mcp' ? 'mcp' : 'builtin',
    riskLevel: (r.risk_level as RiskLevel) ?? 'medium',
    permissions: parseJson<string[]>(r.permissions, []),
    inputSchema: parseJson<Record<string, unknown>>(r.input_schema, {}),
    enabled: r.enabled === 1,
    mcpServerId: r.mcp_server_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class ToolRepository {
  constructor(private readonly db: SqliteDb) {}

  upsert(tool: {
    name: string;
    description: string;
    kind: string;
    source: 'builtin' | 'mcp';
    riskLevel: RiskLevel;
    permissions: string[];
    inputSchema: Record<string, unknown>;
    enabled?: boolean;
    mcpServerId?: string | null;
  }): ToolEntity {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO tools (id, name, description, kind, source, risk_level, permissions, input_schema, enabled, mcp_server_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           description=excluded.description, kind=excluded.kind, source=excluded.source,
           risk_level=excluded.risk_level, permissions=excluded.permissions,
           input_schema=excluded.input_schema, mcp_server_id=excluded.mcp_server_id,
           updated_at=excluded.updated_at`,
      )
      .run(
        nextId(this.db, 'tool'),
        tool.name,
        tool.description,
        tool.kind,
        tool.source,
        tool.riskLevel,
        jsonString(tool.permissions),
        jsonString(tool.inputSchema),
        tool.enabled === false ? 0 : 1,
        tool.mcpServerId ?? null,
        now,
        now,
      );
    return this.get(tool.name) as ToolEntity;
  }

  get(name: string): ToolEntity | null {
    const row = this.db.prepare('SELECT * FROM tools WHERE name = ?').get(name) as
      | ToolRow
      | undefined;
    return row ? toTool(row) : null;
  }

  list(opts: { source?: 'builtin' | 'mcp'; enabled?: boolean } = {}): ToolEntity[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.source) {
      where.push('source = ?');
      params.push(opts.source);
    }
    if (opts.enabled !== undefined) {
      where.push('enabled = ?');
      params.push(opts.enabled ? 1 : 0);
    }
    const rows = this.db
      .prepare(`SELECT * FROM tools ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name`)
      .all(...params) as ToolRow[];
    return rows.map(toTool);
  }

  setEnabled(name: string, enabled: boolean): void {
    this.db.prepare('UPDATE tools SET enabled = ?, updated_at = ? WHERE name = ?').run(
      enabled ? 1 : 0,
      Date.now(),
      name,
    );
  }

  deleteByServer(serverId: string): number {
    const res = this.db.prepare('DELETE FROM tools WHERE mcp_server_id = ?').run(serverId);
    return res.changes;
  }

  delete(name: string): void {
    this.db.prepare('DELETE FROM tools WHERE name = ? AND source = ?').run(name, 'mcp');
  }
}

interface PolicyRow {
  id: string;
  seq: number;
  name: string;
  description: string;
  agent_name: string | null;
  rules: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function toPolicy(r: PolicyRow): PolicyEntity {
  return {
    id: r.id,
    seq: r.seq,
    name: r.name,
    description: r.description,
    agentName: r.agent_name,
    rules: parseJson<PolicyRuleEntity[]>(r.rules, []),
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class PolicyRepository {
  constructor(private readonly db: SqliteDb) {}

  create(spec: PolicySpec): PolicyEntity {
    const id = nextId(this.db, 'policy');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO policies (id, seq, name, description, agent_name, rules, enabled, created_at, updated_at)
         VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM policies), ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        spec.name,
        spec.description,
        spec.agentName ?? null,
        jsonString(spec.rules),
        spec.enabled ? 1 : 0,
        now,
        now,
      );
    return this.get(id) as PolicyEntity;
  }

  get(id: string): PolicyEntity | null {
    const row = this.db.prepare('SELECT * FROM policies WHERE id = ?').get(id) as
      | PolicyRow
      | undefined;
    return row ? toPolicy(row) : null;
  }

  getByName(name: string): PolicyEntity | null {
    const row = this.db.prepare('SELECT * FROM policies WHERE name = ? COLLATE NOCASE').get(name) as
      | PolicyRow
      | undefined;
    return row ? toPolicy(row) : null;
  }

  list(opts: { agentName?: string } = {}): PolicyEntity[] {
    const rows = this.db.prepare('SELECT * FROM policies ORDER BY name').all() as PolicyRow[];
    const out = rows.map(toPolicy);
    if (opts.agentName === undefined) return out;
    return out.filter((p) => p.agentName === null || p.agentName === opts.agentName);
  }

  update(id: string, patch: Partial<PolicySpec>): PolicyEntity {
    const existing = this.get(id);
    if (!existing) throw new Error(`policy not found: ${id}`);
    this.db
      .prepare(
        `UPDATE policies SET name=?, description=?, agent_name=?, rules=?, enabled=?, updated_at=? WHERE id=?`,
      )
      .run(
        patch.name ?? existing.name,
        patch.description ?? existing.description,
        patch.agentName ?? existing.agentName,
        jsonString(patch.rules ?? existing.rules),
        (patch.enabled ?? existing.enabled) ? 1 : 0,
        Date.now(),
        id,
      );
    return this.get(id) as PolicyEntity;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM policies WHERE id = ?').run(id).changes > 0;
  }
}

interface McpRow {
  id: string;
  seq: number;
  name: string;
  command: string;
  args: string;
  env: string;
  risk_level: string;
  status: string;
  tool_count: number;
  last_discovered_at: number | null;
  created_at: number;
  updated_at: number;
}

function toMcp(r: McpRow): McpServerEntity {
  return {
    id: r.id,
    seq: r.seq,
    name: r.name,
    command: r.command,
    args: parseJson<string[]>(r.args, []),
    env: parseJson<Record<string, string>>(r.env, {}),
    riskLevel: (r.risk_level as RiskLevel) ?? 'high',
    status: r.status as McpServerEntity['status'],
    toolCount: r.tool_count,
    lastDiscoveredAt: r.last_discovered_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class McpRepository {
  constructor(private readonly db: SqliteDb) {}

  create(spec: McpServerSpec): McpServerEntity {
    const id = nextId(this.db, 'mcpServer');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO mcp_servers (id, seq, name, command, args, env, risk_level, status, created_at, updated_at)
         VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM mcp_servers), ?, ?, ?, ?, ?, 'unregistered', ?, ?)`,
      )
      .run(id, spec.name, spec.command, jsonString(spec.args), jsonString(spec.env), spec.riskLevel, now, now);
    return this.get(id) as McpServerEntity;
  }

  get(id: string): McpServerEntity | null {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as
      | McpRow
      | undefined;
    return row ? toMcp(row) : null;
  }

  getByName(name: string): McpServerEntity | null {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE name = ? COLLATE NOCASE').get(name) as
      | McpRow
      | undefined;
    return row ? toMcp(row) : null;
  }

  list(): McpServerEntity[] {
    return (this.db.prepare('SELECT * FROM mcp_servers ORDER BY name').all() as McpRow[]).map(toMcp);
  }

  updateStatus(id: string, status: McpServerEntity['status'], toolCount: number): void {
    this.db
      .prepare('UPDATE mcp_servers SET status=?, tool_count=?, last_discovered_at=?, updated_at=? WHERE id=?')
      .run(status, toolCount, Date.now(), Date.now(), id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes > 0;
  }
}
