import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ValidationError, type RunStatus } from '@agentos/shared';
import { computeRunMetrics } from '@agentos/evaluation';
import { replayRun } from '@agentos/runtime';
import { runEventsToOtlp } from '@agentos/observability';
import type { AppContext } from '../context.js';
import { parse } from '../app.js';
import { openSse } from '../sse.js';

const ListRunsSchema = z.object({
  status: z.string().optional(),
  agentId: z.string().optional(),
  workflowRunId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const DecisionRequestSchema = z.object({
  decidedBy: z.string().max(64).default('operator'),
});

export async function registerRunRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/v1/runs', async (req) => {
    const q = parse(ListRunsSchema, req.query);
    const runs = ctx.db.runs.list({
      status: q.status as RunStatus | undefined,
      agentId: q.agentId,
      workflowRunId: q.workflowRunId,
      limit: q.limit,
      offset: q.offset,
    });
    return { runs, total: runs.length };
  });

  app.get('/api/v1/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const run = ctx.db.runs.get(id);
    if (!run) throw new NotFoundError('run', id);
    const agent = ctx.db.agents.get(run.agentId);
    const events = ctx.db.events.listForRun(run.id);
    const decisions = ctx.db.decisions.listForRun(run.id);
    const approvals = ctx.db.approvals.list({ runId: run.id });
    const evalResults = ctx.db.evals
      .listRuns(undefined, 200)
      .flatMap((er) =>
        ctx.db.evals
          .caseResults(er.id)
          .filter((c) => c.runId === run.id)
          .map((c) => ({ evalRunId: er.id, caseId: c.caseId, passed: c.passed, failureReason: c.failureReason })),
      );
    return {
      run,
      agentName: agent?.name ?? run.agentSnapshot.name,
      events,
      decisions,
      approvals,
      metrics: computeRunMetrics(ctx.db, run),
      evalResults,
      isReplay: events.some((e) => (e.payload as { replayOf?: string } | null)?.replayOf),
    };
  });

  app.get('/api/v1/runs/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    if (!ctx.db.runs.get(id)) throw new NotFoundError('run', id);
    return { events: ctx.db.events.listForRun(id) };
  });

  app.get('/api/v1/runs/:id/decisions', async (req) => {
    const { id } = req.params as { id: string };
    if (!ctx.db.runs.get(id)) throw new NotFoundError('run', id);
    return { decisions: ctx.db.decisions.listForRun(id) };
  });

  app.post('/api/v1/runs/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const run = ctx.db.runs.get(id);
    if (!run) throw new NotFoundError('run', id);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
      throw new ValidationError(`run already finished: ${run.status}`);
    }
    const cancelled = ctx.runtime.cancel(id);
    ctx.db.audit.add({ actor: 'operator', action: 'run.cancel', target: id });
    return { run: cancelled };
  });

  app.post('/api/v1/runs/:id/replay', async (req, reply) => {
    const { id } = req.params as { id: string };
    const outcome = await replayRun(ctx.db, ctx.runtime, id, ctx.bus, ctx.metrics);
    ctx.db.audit.add({ actor: 'operator', action: 'run.replay', target: id, details: { replayRunId: outcome.replayRunId } });
    reply.code(201);
    return {
      originalRunId: outcome.originalRunId,
      replayRunId: outcome.replayRunId,
      identical: outcome.identical,
      differences: outcome.differences,
      run: outcome.replayRun,
    };
  });

  app.get('/api/v1/runs/:id/otel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = ctx.db.runs.get(id);
    if (!run) throw new NotFoundError('run', id);
    const agent = ctx.db.agents.get(run.agentId);
    reply.type('application/json');
    return runEventsToOtlp(id, ctx.db.events.listForRun(id), { agentName: agent?.name });
  });

  app.get('/api/v1/runs/:id/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ctx.db.runs.get(id)) throw new NotFoundError('run', id);
    openSse(reply, ctx.bus, (e) => e.entityId === id);
    return reply;
  });

  app.get('/api/v1/events/stream', async (_req, reply) => {
    openSse(reply, ctx.bus);
    return reply;
  });

  // ── Approvals ──────────────────────────────────────────────────────────
  app.get('/api/v1/approvals', async (req) => {
    const q = req.query as { status?: 'pending' | 'approved' | 'denied'; runId?: string };
    return { approvals: ctx.approvals.list({ status: q.status, runId: q.runId }), pending: ctx.approvals.pendingCount() };
  });

  for (const verdict of ['approve', 'deny'] as const) {
    app.post(`/api/v1/approvals/:id/${verdict}`, async (req) => {
      const { id } = req.params as { id: string };
      const { decidedBy } = parse(DecisionRequestSchema, req.body ?? {});
      const approval = ctx.approvals.decide(id, verdict === 'approve' ? 'approved' : 'denied', decidedBy);
      ctx.db.audit.add({ actor: decidedBy, action: `approval.${verdict}`, target: id, details: { tool: approval.tool, runId: approval.runId } });
      return { approval };
    });
  }
}
