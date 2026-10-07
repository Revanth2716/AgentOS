import type { AgentDatabase, Approval } from '@agentos/database';
import type { EventBus } from '@agentos/shared';
import { NotFoundError, ValidationError } from '@agentos/shared';
import type { AppMetrics } from '@agentos/observability';

export interface ApprovalRequest {
  runId?: string | null;
  workflowRunId?: string | null;
  agentId?: string | null;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  reason: string;
  kind?: Approval['kind'];
}

interface Waiter {
  resolve: (approval: Approval) => void;
  reject: (err: Error) => void;
}

/**
 * Manages the pause/resume handshake for human approval. `request()` persists
 * a pending approval and returns a promise that only `decide()` resolves —
 * model output can never resolve it (no prompt-bypass path exists).
 */
export class ApprovalService {
  private readonly waiters = new Map<string, Waiter>();

  constructor(
    private readonly db: AgentDatabase,
    private readonly bus: EventBus,
    private readonly metrics: AppMetrics,
  ) {}

  request(req: ApprovalRequest): { approval: Approval; decided: Promise<Approval> } {
    const approval = this.db.approvals.create(req);
    this.metrics.approvalsPending.set({}, this.db.approvals.pendingCount());
    this.bus.publish({
      topic: 'run',
      type: 'approval_requested',
      ts: Date.now(),
      entityId: approval.runId ?? approval.workflowRunId ?? undefined,
      data: {
        approvalId: approval.id,
        runId: approval.runId,
        workflowRunId: approval.workflowRunId,
        agentId: approval.agentId,
        tool: approval.tool,
        summary: approval.summary,
        reason: approval.reason,
        kind: approval.kind,
        status: approval.status,
      },
    });
    const decided = new Promise<Approval>((resolve, reject) => {
      this.waiters.set(approval.id, { resolve, reject });
    });
    return { approval, decided };
  }

  /** Operator decision. Approval can only come from this API/CLI — never from prompts. */
  decide(approvalId: string, status: 'approved' | 'denied', decidedBy = 'operator'): Approval {
    const existing = this.db.approvals.get(approvalId);
    if (!existing) throw new NotFoundError('approval', approvalId);
    if (existing.status !== 'pending') {
      throw new ValidationError(`approval ${approvalId} already decided: ${existing.status}`);
    }
    const updated = this.db.approvals.decide(approvalId, status, decidedBy);
    this.metrics.approvalsPending.set({}, this.db.approvals.pendingCount());
    this.bus.publish({
      topic: 'run',
      type: status === 'approved' ? 'approval_granted' : 'approval_denied',
      ts: Date.now(),
      entityId: updated.runId ?? updated.workflowRunId ?? undefined,
      data: {
        approvalId,
        runId: updated.runId,
        workflowRunId: updated.workflowRunId,
        tool: updated.tool,
        decidedBy,
        status,
      },
    });
    const waiter = this.waiters.get(approvalId);
    if (waiter) {
      this.waiters.delete(approvalId);
      waiter.resolve(updated);
    }
    return updated;
  }

  get(id: string): Approval | null {
    return this.db.approvals.get(id);
  }

  list(opts: { status?: 'pending' | 'approved' | 'denied'; runId?: string } = {}): Approval[] {
    return this.db.approvals.list(opts);
  }

  pendingCount(): number {
    return this.db.approvals.pendingCount();
  }

  /** Fail all waiters (used on shutdown). */
  shutdown(reason: string): void {
    for (const [id, waiter] of this.waiters) {
      waiter.reject(new Error(reason));
      this.waiters.delete(id);
    }
  }
}
