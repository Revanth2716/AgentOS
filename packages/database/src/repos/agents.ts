import type { SqliteDb } from '../db.js';
import { nextId } from '../db.js';
import { jsonString, parseJson, parseLimits, parsePolicyConfig } from '../repo-utils.js';
import type { Agent, AgentVersion } from '../entities.js';
import type { AgentSpec } from '@agentos/shared';

interface AgentRow {
  id: string;
  seq: number;
  name: string;
  description: string;
  model: string;
  system_prompt: string | null;
  tools: string;
  permissions: string;
  policies: string;
  limits: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function toAgent(r: AgentRow): Agent {
  return {
    id: r.id,
    seq: r.seq,
    name: r.name,
    description: r.description,
    model: r.model,
    systemPrompt: r.system_prompt ?? undefined,
    tools: parseJson<string[]>(r.tools, []),
    permissions: parseJson<string[]>(r.permissions, []),
    policies: parsePolicyConfig(r.policies),
    limits: parseLimits(r.limits),
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface AgentListFilter {
  enabled?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export class AgentRepository {
  constructor(private readonly db: SqliteDb) {}

  create(spec: AgentSpec): Agent {
    const id = nextId(this.db, 'agent');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO agents (id, seq, name, description, model, system_prompt, tools, permissions, policies, limits, enabled, created_at, updated_at)
         VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM agents), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        spec.name,
        spec.description,
        spec.model,
        spec.systemPrompt ?? null,
        jsonString(spec.tools),
        jsonString(spec.permissions),
        jsonString(spec.policies),
        jsonString(spec.limits),
        spec.enabled ? 1 : 0,
        now,
        now,
      );
    void this.recordVersion(id, spec, now);
    return this.get(id) as Agent;
  }

  get(id: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as
      | AgentRow
      | undefined;
    return row ? toAgent(row) : null;
  }

  getByName(name: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE name = ? COLLATE NOCASE').get(name) as
      | AgentRow
      | undefined;
    return row ? toAgent(row) : null;
  }

  list(filter: AgentListFilter = {}): Agent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.enabled !== undefined) {
      where.push('enabled = ?');
      params.push(filter.enabled ? 1 : 0);
    }
    if (filter.search) {
      where.push('(name LIKE ? OR description LIKE ?)');
      params.push(`%${filter.search}%`, `%${filter.search}%`);
    }
    const sql = `SELECT * FROM agents ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY name ASC LIMIT ? OFFSET ?`;
    params.push(filter.limit ?? 200, filter.offset ?? 0);
    return (this.db.prepare(sql).all(...params) as AgentRow[]).map(toAgent);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n;
  }

  update(id: string, patch: Partial<AgentSpec>): Agent {
    const existing = this.get(id);
    if (!existing) throw new Error(`agent not found: ${id}`);
    const next: AgentSpec = {
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description,
      model: patch.model ?? existing.model,
      systemPrompt: patch.systemPrompt ?? existing.systemPrompt,
      tools: patch.tools ?? existing.tools,
      permissions: patch.permissions ?? existing.permissions,
      policies: patch.policies ?? existing.policies,
      limits: patch.limits ?? existing.limits,
      enabled: patch.enabled ?? existing.enabled,
    };
    this.db
      .prepare(
        `UPDATE agents SET name=?, description=?, model=?, system_prompt=?, tools=?, permissions=?, policies=?, limits=?, enabled=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        next.name,
        next.description,
        next.model,
        next.systemPrompt ?? null,
        jsonString(next.tools),
        jsonString(next.permissions),
        jsonString(next.policies),
        jsonString(next.limits),
        next.enabled ? 1 : 0,
        Date.now(),
        id,
      );
    void this.recordVersion(id, next, Date.now());
    return this.get(id) as Agent;
  }

  setEnabled(id: string, enabled: boolean): Agent {
    this.db
      .prepare('UPDATE agents SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Date.now(), id);
    return this.get(id) as Agent;
  }

  delete(id: string): boolean {
    const res = this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    return res.changes > 0;
  }

  versions(agentId: string): AgentVersion[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY version DESC')
      .all(agentId) as { id: string; agent_id: string; version: number; config: string; created_at: number }[];
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      version: r.version,
      config: parseJson<AgentSpec>(r.config, {} as AgentSpec),
      createdAt: r.created_at,
    }));
  }

  private recordVersion(agentId: string, spec: AgentSpec, now: number): void {
    const maxV = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM agent_versions WHERE agent_id = ?')
      .get(agentId) as { v: number };
    this.db
      .prepare(
        'INSERT INTO agent_versions (id, agent_id, version, config, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(nextId(this.db, 'agentVersion'), agentId, maxV.v + 1, jsonString(spec), now);
  }
}
