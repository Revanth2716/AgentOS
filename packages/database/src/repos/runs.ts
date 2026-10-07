import type { SqliteDb } from '../db.js';
import { nextId } from '../db.js';
import { jsonString, parseJson, parseLimits, parsePolicyConfig } from '../repo-utils.js';
import type { CostEntry, DecisionRecord, Run } from '../entities.js';
import type { PendingAction } from '../entities.js';
import {
  OPEN_RUN_STATUSES,
  redactDeep,
  type AgentSpec,
  type PolicyAction,
  type ProviderLocality,
  type RunEvent,
  type RunStatus,
} from '@agentos/shared';

interface RunRow {
  id: string;
  seq: number;
  agent_id: string;
  workflow_run_id: string | null;
  task: string;
  status: string;
  mode: string;
  seed: number;
  provider: string;
  model: string;
  agent_snapshot: string;
  steps: number;
  tool_calls: number;
  tool_failures: number;
  retries: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  error: string | null;
  final_result: string | null;
  pending_action: string | null;
  trace_id: string | null;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

export function toRun(r: RunRow): Run {
  const snapshot = parseJson<Partial<AgentSpec>>(r.agent_snapshot, {});
  return {
    id: r.id,
    seq: r.seq,
    agentId: r.agent_id,
    workflowRunId: r.workflow_run_id,
    task: r.task,
    status: r.status as RunStatus,
    mode: r.mode === 'live' ? 'live' : 'demo',
    seed: r.seed,
    provider: r.provider,
    model: r.model,
    agentSnapshot: {
      name: snapshot.name ?? r.agent_id,
      description: snapshot.description ?? '',
      model: snapshot.model ?? r.model,
      tools: snapshot.tools ?? [],
      permissions: snapshot.permissions ?? [],
      policies: parsePolicyConfig(JSON.stringify(snapshot.policies ?? {})),
      limits: parseLimits(JSON.stringify(snapshot.limits ?? {})),
      enabled: snapshot.enabled ?? true,
    },
    steps: r.steps,
    toolCalls: r.tool_calls,
    toolFailures: r.tool_failures,
    retries: r.retries,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    costUsd: r.cost_usd,
    error: r.error,
    finalResult: r.final_result,
    pendingAction: parseJson<PendingAction | null>(r.pending_action, null),
    traceId: r.trace_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    createdAt: r.created_at,
  };
}

export interface RunListFilter {
  status?: RunStatus;
  agentId?: string;
  workflowRunId?: string;
  limit?: number;
  offset?: number;
}

export interface RunPatch {
  status?: RunStatus;
  steps?: number;
  toolCalls?: number;
  toolFailures?: number;
  retries?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  error?: string | null;
  finalResult?: string | null;
  pendingAction?: PendingAction | null;
  startedAt?: number | null;
  endedAt?: number | null;
}

export class RunRepository {
  constructor(private readonly db: SqliteDb) {}

  create(input: {
    agentId: string;
    workflowRunId?: string | null;
    task: string;
    mode: 'demo' | 'live';
    seed: number;
    provider: string;
    model: string;
    agentSnapshot: AgentSpec;
    traceId: string;
  }): Run {
    const id = nextId(this.db, 'run');
    this.db
      .prepare(
        `INSERT INTO runs (id, seq, agent_id, workflow_run_id, task, status, mode, seed, provider, model, agent_snapshot, trace_id, created_at)
         VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM runs), ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.agentId,
        input.workflowRunId ?? null,
        input.task,
        input.mode,
        input.seed,
        input.provider,
        input.model,
        jsonString(input.agentSnapshot),
        input.traceId,
        Date.now(),
      );
    return this.get(id) as Run;
  }

  get(id: string): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  update(id: string, patch: RunPatch): Run {
    const sets: string[] = [];
    const params: unknown[] = [];
    const map: Partial<Record<keyof RunPatch, string>> = {
      status: 'status',
      steps: 'steps',
      toolCalls: 'tool_calls',
      toolFailures: 'tool_failures',
      retries: 'retries',
      tokensIn: 'tokens_in',
      tokensOut: 'tokens_out',
      costUsd: 'cost_usd',
      error: 'error',
      finalResult: 'final_result',
      startedAt: 'started_at',
      endedAt: 'ended_at',
    };
    for (const [k, col] of Object.entries(map) as [keyof RunPatch, string][]) {
      const v = patch[k];
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        params.push(v);
      }
    }
    if (patch.pendingAction !== undefined) {
      sets.push('pending_action = ?');
      params.push(patch.pendingAction === null ? null : jsonString(patch.pendingAction));
    }
    if (sets.length === 0) return this.get(id) as Run;
    params.push(id);
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.get(id) as Run;
  }

  list(filter: RunListFilter = {}): Run[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.agentId) {
      where.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter.workflowRunId) {
      where.push('workflow_run_id = ?');
      params.push(filter.workflowRunId);
    }
    params.push(filter.limit ?? 100, filter.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT * FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY seq DESC LIMIT ? OFFSET ?`,
      )
      .all(...params) as RunRow[];
    return rows.map(toRun);
  }

  active(): Run[] {
    const placeholders = OPEN_RUN_STATUSES.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE status IN (${placeholders}) ORDER BY seq DESC`)
      .all(...OPEN_RUN_STATUSES) as RunRow[];
    return rows.map(toRun);
  }

  /** Marks every open run as interrupted (used on boot after a process restart). */
  interruptAll(): number {
    const placeholders = OPEN_RUN_STATUSES.map(() => '?').join(',');
    return this.db
      .prepare(
        `UPDATE runs SET status = 'interrupted', error = 'interrupted by process restart', ended_at = ?
         WHERE status IN (${placeholders})`,
      )
      .run(Date.now(), ...OPEN_RUN_STATUSES).changes;
  }

  agentIdsWithRuns(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT agent_id FROM runs').all() as { agent_id: string }[]
    ).map((r) => r.agent_id);
  }
}

export class EventRepository {
  constructor(private readonly db: SqliteDb) {}

  append(ev: RunEvent): void {
    this.db
      .prepare(
        `INSERT INTO run_events (run_id, seq, ts, type, agent_id, tool, payload, duration_ms, status, trace_id, span_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ev.runId,
        ev.seq,
        ev.ts,
        ev.type,
        ev.agentId ?? null,
        ev.tool ?? null,
        ev.payload ? jsonString(redactDeep(ev.payload)) : null,
        ev.durationMs ?? null,
        ev.status ?? null,
        ev.traceId ?? null,
        ev.spanId ?? null,
      );
  }

  listForRun(runId: string, limit = 5_000): RunEvent[] {
    const rows = this.db
      .prepare(
        'SELECT run_id, seq, ts, type, agent_id, tool, payload, duration_ms, status, trace_id, span_id FROM run_events WHERE run_id = ? ORDER BY seq ASC LIMIT ?',
      )
      .all(runId, limit) as {
      run_id: string;
      seq: number;
      ts: number;
      type: string;
      agent_id: string | null;
      tool: string | null;
      payload: string | null;
      duration_ms: number | null;
      status: string | null;
      trace_id: string | null;
      span_id: string | null;
    }[];
    return rows.map((r) => ({
      runId: r.run_id,
      seq: r.seq,
      ts: r.ts,
      type: r.type as RunEvent['type'],
      agentId: r.agent_id,
      tool: r.tool,
      payload: parseJson<Record<string, unknown> | null>(r.payload, null),
      durationMs: r.duration_ms,
      status: r.status as RunEvent['status'],
      traceId: r.trace_id,
      spanId: r.span_id,
    }));
  }

  lastSeq(runId: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) AS s FROM run_events WHERE run_id = ?')
      .get(runId) as { s: number | null };
    return row.s ?? 0;
  }

  countForRun(runId: string, type: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = ?')
      .get(runId, type) as { n: number };
    return row.n;
  }
}

export class DecisionRepository {
  constructor(private readonly db: SqliteDb) {}

  record(input: {
    runId?: string | null;
    agentId?: string | null;
    tool: string;
    decision: PolicyAction;
    rule?: string | null;
    reason: string;
    argsDigest?: string | null;
  }): void {
    this.db
      .prepare(
        'INSERT INTO policy_decisions (run_id, ts, agent_id, tool, decision, rule, reason, args_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.runId ?? null,
        Date.now(),
        input.agentId ?? null,
        input.tool,
        input.decision,
        input.rule ?? null,
        input.reason,
        input.argsDigest ?? null,
      );
  }

  listForRun(runId: string): DecisionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM policy_decisions WHERE run_id = ? ORDER BY id ASC')
      .all(runId) as {
      id: number;
      run_id: string | null;
      ts: number;
      agent_id: string | null;
      tool: string;
      decision: string;
      rule: string | null;
      reason: string;
      args_digest: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      ts: r.ts,
      agentId: r.agent_id,
      tool: r.tool,
      decision: r.decision as PolicyAction,
      rule: r.rule,
      reason: r.reason,
      argsDigest: r.args_digest,
    }));
  }
}

export class CostRepository {
  constructor(private readonly db: SqliteDb) {}

  add(input: {
    runId?: string | null;
    ts?: number;
    provider: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
    estCostUsd: number;
    locality: ProviderLocality;
  }): void {
    this.db
      .prepare(
        'INSERT INTO costs (run_id, ts, provider, model, tokens_in, tokens_out, est_cost_usd, locality) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.runId ?? null,
        input.ts ?? Date.now(),
        input.provider,
        input.model,
        input.tokensIn,
        input.tokensOut,
        input.estCostUsd,
        input.locality,
      );
  }

  totals(sinceTs = 0): {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    localCalls: number;
    cloudCalls: number;
    mockCalls: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(tokens_in), 0) AS tokens_in,
          COALESCE(SUM(tokens_out), 0) AS tokens_out,
          COALESCE(SUM(est_cost_usd), 0) AS cost_usd,
          COALESCE(SUM(CASE WHEN locality = 'local' THEN 1 ELSE 0 END), 0) AS local_calls,
          COALESCE(SUM(CASE WHEN locality = 'cloud' THEN 1 ELSE 0 END), 0) AS cloud_calls,
          COALESCE(SUM(CASE WHEN locality = 'mock' THEN 1 ELSE 0 END), 0) AS mock_calls
         FROM costs WHERE ts >= ?`,
      )
      .get(sinceTs) as {
      tokens_in: number;
      tokens_out: number;
      cost_usd: number;
      local_calls: number;
      cloud_calls: number;
      mock_calls: number;
    };
    return {
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      costUsd: row.cost_usd,
      localCalls: row.local_calls,
      cloudCalls: row.cloud_calls,
      mockCalls: row.mock_calls,
    };
  }

  perDay(days = 14): { day: string; runs: number; costUsd: number; tokens: number }[] {
    const since = Date.now() - days * 86_400_000;
    const rows = this.db
      .prepare(
        `SELECT date(ts / 1000, 'unixepoch') AS day,
                COUNT(DISTINCT run_id) AS runs,
                SUM(est_cost_usd) AS cost,
                SUM(tokens_in + tokens_out) AS tokens
         FROM costs WHERE ts >= ? GROUP BY day ORDER BY day ASC`,
      )
      .all(since) as { day: string; runs: number; cost: number | null; tokens: number | null }[];
    return rows.map((r) => ({ day: r.day, runs: r.runs, costUsd: r.cost ?? 0, tokens: r.tokens ?? 0 }));
  }

  list(limit = 100): CostEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM costs ORDER BY id DESC LIMIT ?')
      .all(limit) as {
      id: number;
      run_id: string | null;
      ts: number;
      provider: string;
      model: string;
      tokens_in: number;
      tokens_out: number;
      est_cost_usd: number;
      locality: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      ts: r.ts,
      provider: r.provider,
      model: r.model,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      estCostUsd: r.est_cost_usd,
      locality: (r.locality as ProviderLocality) ?? 'mock',
    }));
  }
}
