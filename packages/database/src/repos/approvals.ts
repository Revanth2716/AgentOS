import type { SqliteDb } from '../db.js';
import { nextId } from '../db.js';
import { parseJson } from '../repo-utils.js';
import type { Approval } from '../entities.js';
import type { ApprovalStatus } from '@agentos/shared';

interface ApprovalRow {
  id: string;
  seq: number;
  run_id: string | null;
  workflow_run_id: string | null;
  agent_id: string | null;
  tool: string;
  args: string;
  summary: string;
  reason: string;
  kind: string;
  status: string;
  requested_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

function toApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    seq: r.seq,
    runId: r.run_id,
    workflowRunId: r.workflow_run_id,
    agentId: r.agent_id,
    tool: r.tool,
    args: parseJson<Record<string, unknown>>(r.args, {}),
    summary: r.summary,
    reason: r.reason,
    kind: r.kind as Approval['kind'],
    status: r.status as ApprovalStatus,
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
  };
}

export class ApprovalRepository {
  constructor(private readonly db: SqliteDb) {}

  create(input: {
    runId?: string | null;
    workflowRunId?: string | null;
    agentId?: string | null;
    tool: string;
    args: Record<string, unknown>;
    summary: string;
    reason: string;
    kind?: Approval['kind'];
  }): Approval {
    const id = nextId(this.db, 'approval');
    this.db
      .prepare(
        `INSERT INTO approvals (id, seq, run_id, workflow_run_id, agent_id, tool, args, summary, reason, kind, status, requested_at)
         VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM approvals), ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        input.runId ?? null,
        input.workflowRunId ?? null,
        input.agentId ?? null,
        input.tool,
        JSON.stringify(input.args ?? {}),
        input.summary,
        input.reason,
        input.kind ?? 'tool_execution',
        Date.now(),
      );
    return this.get(id) as Approval;
  }

  get(id: string): Approval | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      | ApprovalRow
      | undefined;
    return row ? toApproval(row) : null;
  }

  list(opts: { status?: ApprovalStatus; runId?: string; limit?: number } = {}): Approval[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.runId) {
      where.push('run_id = ?');
      params.push(opts.runId);
    }
    params.push(opts.limit ?? 100);
    const rows = this.db
      .prepare(
        `SELECT * FROM approvals ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY requested_at DESC LIMIT ?`,
      )
      .all(...params) as ApprovalRow[];
    return rows.map(toApproval);
  }

  decide(id: string, status: Exclude<ApprovalStatus, 'pending'>, decidedBy: string): Approval {
    this.db
      .prepare('UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?')
      .run(status, Date.now(), decidedBy, id);
    return this.get(id) as Approval;
  }

  pendingCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")
      .get() as { n: number };
    return row.n;
  }

  /** Pending approval for a run id OR a workflow-run id. */
  pendingForRun(runId: string): Approval | null {
    const row = this.db
      .prepare(
        "SELECT * FROM approvals WHERE (run_id = ? OR workflow_run_id = ?) AND status = 'pending' ORDER BY requested_at DESC",
      )
      .get(runId, runId) as ApprovalRow | undefined;
    return row ? toApproval(row) : null;
  }
}
