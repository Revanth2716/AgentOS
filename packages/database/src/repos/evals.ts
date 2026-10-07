import type { SqliteDb } from '../db.js';
import { nextId } from '../db.js';
import { jsonString, parseJson } from '../repo-utils.js';
import type { EvalCaseResult, EvalRun, EvalRunSummary, EvalSuite, RunMetrics } from '../entities.js';
import { EvalCaseSchema, type EvalStatus } from '@agentos/shared';

interface SuiteRow {
  id: string;
  seq: number;
  name: string;
  description: string;
  agent_id: string;
  cases: string;
  created_at: number;
  updated_at: number;
}

function toSuite(r: SuiteRow): EvalSuite {
  const raw = parseJson<unknown[]>(r.cases, []);
  const cases = raw
    .map((c) => EvalCaseSchema.safeParse(c))
    .filter((p) => p.success)
    .map((p) => p.data);
  return {
    id: r.id,
    seq: r.seq,
    name: r.name,
    description: r.description,
    agentId: r.agent_id,
    cases,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class EvalRepository {
  constructor(private readonly db: SqliteDb) {}

  createSuite(input: { name: string; description: string; agentId: string; cases: unknown[] }): EvalSuite {
    const id = nextId(this.db, 'evalSuite');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO eval_suites (id, seq, name, description, agent_id, cases, created_at, updated_at)
         VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM eval_suites), ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.description, input.agentId, jsonString(input.cases), now, now);
    return this.getSuite(id) as EvalSuite;
  }

  getSuite(id: string): EvalSuite | null {
    const row = this.db.prepare('SELECT * FROM eval_suites WHERE id = ?').get(id) as
      | SuiteRow
      | undefined;
    return row ? toSuite(row) : null;
  }

  getSuiteByName(name: string): EvalSuite | null {
    const row = this.db.prepare('SELECT * FROM eval_suites WHERE name = ? COLLATE NOCASE').get(name) as
      | SuiteRow
      | undefined;
    return row ? toSuite(row) : null;
  }

  listSuites(): EvalSuite[] {
    return (this.db.prepare('SELECT * FROM eval_suites ORDER BY name').all() as SuiteRow[]).map(toSuite);
  }

  deleteSuite(id: string): boolean {
    return this.db.prepare('DELETE FROM eval_suites WHERE id = ?').run(id).changes > 0;
  }

  createRun(input: { suiteId: string; agentId: string }): EvalRun {
    const id = nextId(this.db, 'evalRun');
    this.db
      .prepare(
        `INSERT INTO eval_runs (id, seq, suite_id, agent_id, status, created_at)
         VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM eval_runs), ?, ?, 'queued', ?)`,
      )
      .run(id, input.suiteId, input.agentId, Date.now());
    return this.getRun(id) as EvalRun;
  }

  getRun(id: string): EvalRun | null {
    const row = this.db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(id) as
      | {
          id: string;
          seq: number;
          suite_id: string;
          agent_id: string;
          status: string;
          started_at: number | null;
          ended_at: number | null;
          summary: string | null;
          error: string | null;
          created_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      seq: row.seq,
      suiteId: row.suite_id,
      agentId: row.agent_id,
      status: row.status as EvalStatus,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      summary: parseJson<EvalRunSummary | null>(row.summary, null),
      error: row.error,
      createdAt: row.created_at,
    };
  }

  listRuns(suiteId?: string, limit = 50): EvalRun[] {
    const rows = (
      suiteId
        ? this.db
            .prepare('SELECT id FROM eval_runs WHERE suite_id = ? ORDER BY seq DESC LIMIT ?')
            .all(suiteId, limit)
        : (this.db.prepare('SELECT id FROM eval_runs ORDER BY seq DESC LIMIT ?').all(limit) as {
            id: string;
          }[])
    ) as { id: string }[];
    return rows.map((r) => this.getRun(r.id)).filter((r): r is EvalRun => r !== null);
  }

  updateRun(
    id: string,
    patch: { status?: EvalStatus; startedAt?: number | null; endedAt?: number | null; summary?: EvalRunSummary | null; error?: string | null },
  ): EvalRun {
    const existing = this.getRun(id);
    if (!existing) throw new Error(`eval run not found: ${id}`);
    this.db
      .prepare('UPDATE eval_runs SET status=?, started_at=?, ended_at=?, summary=?, error=? WHERE id=?')
      .run(
        patch.status ?? existing.status,
        patch.startedAt !== undefined ? patch.startedAt : existing.startedAt,
        patch.endedAt !== undefined ? patch.endedAt : existing.endedAt,
        patch.summary !== undefined ? jsonString(patch.summary) : jsonString(existing.summary),
        patch.error !== undefined ? patch.error : existing.error,
        id,
      );
    return this.getRun(id) as EvalRun;
  }

  addCaseResult(input: {
    evalRunId: string;
    caseId: string;
    name: string;
    passed: boolean;
    runId?: string | null;
    metrics: RunMetrics;
    failureReason?: string | null;
  }): void {
    this.db
      .prepare(
        'INSERT INTO eval_case_results (eval_run_id, case_id, name, passed, run_id, metrics, failure_reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.evalRunId,
        input.caseId,
        input.name,
        input.passed ? 1 : 0,
        input.runId ?? null,
        jsonString(input.metrics),
        input.failureReason ?? null,
      );
  }

  caseResults(evalRunId: string): EvalCaseResult[] {
    const rows = this.db
      .prepare('SELECT * FROM eval_case_results WHERE eval_run_id = ? ORDER BY id ASC')
      .all(evalRunId) as {
      id: number;
      eval_run_id: string;
      case_id: string;
      name: string;
      passed: number;
      run_id: string | null;
      metrics: string;
      failure_reason: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      evalRunId: r.eval_run_id,
      caseId: r.case_id,
      name: r.name,
      passed: r.passed === 1,
      runId: r.run_id,
      metrics: parseJson<RunMetrics>(r.metrics, {} as RunMetrics),
      failureReason: r.failure_reason,
    }));
  }

  latestSummaryForAgent(agentId: string): EvalRunSummary | null {
    const row = this.db
      .prepare(
        "SELECT id FROM eval_runs WHERE agent_id = ? AND status = 'completed' ORDER BY seq DESC LIMIT 1",
      )
      .get(agentId) as { id: string } | undefined;
    if (!row) return null;
    return this.getRun(row.id)?.summary ?? null;
  }
}
