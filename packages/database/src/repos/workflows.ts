import type { SqliteDb } from '../db.js';
import { nextId } from '../db.js';
import { jsonString, parseJson } from '../repo-utils.js';
import type { WorkflowEntity, WorkflowNodeRun, WorkflowRun } from '../entities.js';
import { WorkflowSpecSchema, type WorkflowSpec, type WorkflowStatus, type WorkflowNodeStatus } from '@agentos/shared';

interface WorkflowRow {
  id: string;
  seq: number;
  name: string;
  description: string;
  graph: string;
  enabled: number;
  version: number;
  created_at: number;
  updated_at: number;
}

function toWorkflow(r: WorkflowRow): WorkflowEntity {
  const graphParsed = WorkflowSpecSchema.safeParse(parseJson(r.graph, { nodes: [], edges: [] }));
  return {
    id: r.id,
    seq: r.seq,
    name: r.name,
    description: r.description,
    graph: graphParsed.success
      ? graphParsed.data
      : ({ nodes: [], edges: [] } as unknown as WorkflowSpec),
    enabled: r.enabled === 1,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class WorkflowRepository {
  constructor(private readonly db: SqliteDb) {}

  create(input: { name: string; description: string; graph: WorkflowSpec }): WorkflowEntity {
    const id = nextId(this.db, 'workflow');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workflows (id, seq, name, description, graph, enabled, version, created_at, updated_at)
         VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM workflows), ?, ?, ?, 1, 1, ?, ?)`,
      )
      .run(id, input.name, input.description, jsonString(input.graph), now, now);
    return this.get(id) as WorkflowEntity;
  }

  get(id: string): WorkflowEntity | null {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as
      | WorkflowRow
      | undefined;
    return row ? toWorkflow(row) : null;
  }

  getByName(name: string): WorkflowEntity | null {
    const row = this.db.prepare('SELECT * FROM workflows WHERE name = ? COLLATE NOCASE').get(name) as
      | WorkflowRow
      | undefined;
    return row ? toWorkflow(row) : null;
  }

  list(): WorkflowEntity[] {
    return (this.db.prepare('SELECT * FROM workflows ORDER BY name').all() as WorkflowRow[]).map(
      toWorkflow,
    );
  }

  update(id: string, patch: { name?: string; description?: string; graph?: WorkflowSpec; enabled?: boolean }): WorkflowEntity {
    const existing = this.get(id);
    if (!existing) throw new Error(`workflow not found: ${id}`);
    this.db
      .prepare(
        'UPDATE workflows SET name=?, description=?, graph=?, enabled=?, version=version+1, updated_at=? WHERE id=?',
      )
      .run(
        patch.name ?? existing.name,
        patch.description ?? existing.description,
        jsonString(patch.graph ?? existing.graph),
        (patch.enabled ?? existing.enabled) ? 1 : 0,
        Date.now(),
        id,
      );
    return this.get(id) as WorkflowEntity;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id).changes > 0;
  }

  createRun(input: { workflowId: string; input: Record<string, unknown> }): WorkflowRun {
    const id = nextId(this.db, 'workflowRun');
    this.db
      .prepare(
        `INSERT INTO workflow_runs (id, seq, workflow_id, status, input, created_at)
         VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM workflow_runs), ?, 'queued', ?, ?)`,
      )
      .run(id, input.workflowId, jsonString(input.input), Date.now());
    return this.getRun(id) as WorkflowRun;
  }

  getRun(id: string): WorkflowRun | null {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as
      | {
          id: string;
          seq: number;
          workflow_id: string;
          status: string;
          input: string;
          output: string | null;
          error: string | null;
          current_nodes: string;
          started_at: number | null;
          ended_at: number | null;
          created_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      seq: row.seq,
      workflowId: row.workflow_id,
      status: row.status as WorkflowStatus,
      input: parseJson<Record<string, unknown>>(row.input, {}),
      output: parseJson<unknown>(row.output, null),
      error: row.error,
      currentNodes: parseJson<string[]>(row.current_nodes, []),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      createdAt: row.created_at,
    };
  }

  listRuns(workflowId?: string, limit = 100): WorkflowRun[] {
    const rows = (
      workflowId
        ? this.db
            .prepare('SELECT id FROM workflow_runs WHERE workflow_id = ? ORDER BY seq DESC LIMIT ?')
            .all(workflowId, limit)
        : this.db.prepare('SELECT id FROM workflow_runs ORDER BY seq DESC LIMIT ?').all(limit)
    ) as { id: string }[];
    return rows
      .map((r) => this.getRun(r.id))
      .filter((r): r is WorkflowRun => r !== null);
  }

  updateRun(
    id: string,
    patch: {
      status?: WorkflowStatus;
      output?: unknown;
      error?: string | null;
      currentNodes?: string[];
      startedAt?: number | null;
      endedAt?: number | null;
    },
  ): WorkflowRun {
    const existing = this.getRun(id);
    if (!existing) throw new Error(`workflow run not found: ${id}`);
    this.db
      .prepare('UPDATE workflow_runs SET status=?, output=?, error=?, current_nodes=?, started_at=?, ended_at=? WHERE id=?')
      .run(
        patch.status ?? existing.status,
        patch.output !== undefined ? jsonString(patch.output) : jsonString(existing.output),
        patch.error !== undefined ? patch.error : existing.error,
        jsonString(patch.currentNodes ?? existing.currentNodes),
        patch.startedAt !== undefined ? patch.startedAt : existing.startedAt,
        patch.endedAt !== undefined ? patch.endedAt : existing.endedAt,
        id,
      );
    return this.getRun(id) as WorkflowRun;
  }

  /** Marks open workflow runs as failed after a process restart. Returns count. */
  interruptOpen(): number {
    return this.db
      .prepare(
        `UPDATE workflow_runs SET status = 'failed', error = 'interrupted by process restart', ended_at = ?
         WHERE status IN ('queued', 'running', 'waiting_approval', 'paused')`,
      )
      .run(Date.now()).changes;
  }

  upsertNodeRun(input: {
    workflowRunId: string;
    nodeId: string;
    agentId?: string | null;
    runId?: string | null;
    status: WorkflowNodeStatus;
    attempt?: number;
    startedAt?: number | null;
    endedAt?: number | null;
    output?: unknown;
    error?: string | null;
  }): WorkflowNodeRun {
    const existing = this.db
      .prepare('SELECT id FROM workflow_node_runs WHERE workflow_run_id = ? AND node_id = ? AND attempt = ?')
      .get(input.workflowRunId, input.nodeId, input.attempt ?? 1) as { id: string } | undefined;
    const id = existing?.id ?? nextId(this.db, 'workflowNodeRun');
    this.db
      .prepare(
        `INSERT INTO workflow_node_runs (id, workflow_run_id, node_id, agent_id, run_id, status, attempt, started_at, ended_at, output, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workflow_run_id, node_id, attempt) DO UPDATE SET
           agent_id=excluded.agent_id, run_id=excluded.run_id, status=excluded.status,
           started_at=excluded.started_at, ended_at=excluded.ended_at,
           output=excluded.output, error=excluded.error`,
      )
      .run(
        id,
        input.workflowRunId,
        input.nodeId,
        input.agentId ?? null,
        input.runId ?? null,
        input.status,
        input.attempt ?? 1,
        input.startedAt ?? null,
        input.endedAt ?? null,
        input.output !== undefined ? jsonString(input.output) : null,
        input.error ?? null,
      );
    return this.getNodeRun(id) as WorkflowNodeRun;
  }

  getNodeRun(id: string): WorkflowNodeRun | null {
    const row = this.db.prepare('SELECT * FROM workflow_node_runs WHERE id = ?').get(id) as
      | {
          id: string;
          workflow_run_id: string;
          node_id: string;
          agent_id: string | null;
          run_id: string | null;
          status: string;
          attempt: number;
          started_at: number | null;
          ended_at: number | null;
          output: string | null;
          error: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      workflowRunId: row.workflow_run_id,
      nodeId: row.node_id,
      agentId: row.agent_id,
      runId: row.run_id,
      status: row.status as WorkflowNodeStatus,
      attempt: row.attempt,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      output: parseJson<unknown>(row.output, null),
      error: row.error,
    };
  }

  nodeRunsForWorkflowRun(workflowRunId: string): WorkflowNodeRun[] {
    const rows = this.db
      .prepare('SELECT id FROM workflow_node_runs WHERE workflow_run_id = ? ORDER BY started_at ASC, id ASC')
      .all(workflowRunId) as { id: string }[];
    return rows
      .map((r) => this.getNodeRun(r.id))
      .filter((r): r is WorkflowNodeRun => r !== null);
  }
}
