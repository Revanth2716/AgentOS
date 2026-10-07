import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConflictError, NotFoundError, WorkflowSpecSchema } from '@agentos/shared';
import type { AppContext } from '../context.js';
import { parse } from '../app.js';

const WorkflowCreateSchema = z.object({
  name: z.string().min(2).max(64),
  description: z.string().max(2_000).default(''),
  graph: WorkflowSpecSchema,
  enabled: z.boolean().default(true),
});

const WorkflowPatchSchema = WorkflowCreateSchema.partial();

const WorkflowRunSchema = z.object({
  input: z.record(z.string(), z.unknown()).default({}),
});

const SuiteCreateSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(2_000).default(''),
  agentId: z.string().min(1),
  cases: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(200),
        task: z.string().min(1).max(8_000),
        expect: z
          .object({
            keywords: z.array(z.string()).default([]),
            minSources: z.number().int().min(0).default(0),
            requireCitations: z.boolean().default(false),
            toolsUsed: z.array(z.string()).default([]),
            maxSteps: z.number().int().min(1).optional(),
            maxDurationMs: z.number().int().min(100).optional(),
          })
          .default({}),
      }),
    )
    .min(1)
    .max(100),
});

export async function registerWorkflowRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // ── Workflows ───────────────────────────────────────────────────────────
  app.get('/api/v1/workflows', async () => ({
    workflows: ctx.db.workflows.list().map((w) => ({
      ...w,
      recentRuns: ctx.db.workflows.listRuns(w.id, 5),
    })),
  }));

  app.post('/api/v1/workflows', async (req, reply) => {
    const spec = parse(WorkflowCreateSchema, req.body);
    if (ctx.db.workflows.getByName(spec.name)) throw new ConflictError(`workflow exists: ${spec.name}`);
    const workflow = ctx.db.workflows.create(spec);
    ctx.db.audit.add({ actor: 'operator', action: 'workflow.create', target: workflow.name });
    reply.code(201);
    return { workflow };
  });

  app.get('/api/v1/workflows/:id', async (req) => {
    const { id } = req.params as { id: string };
    const workflow = ctx.db.workflows.get(id) ?? ctx.db.workflows.getByName(id);
    if (!workflow) throw new NotFoundError('workflow', id);
    return {
      workflow,
      recentRuns: ctx.db.workflows.listRuns(workflow.id, 20),
      agents: workflow.graph.nodes
        .filter((n) => n.type === 'agent' && n.agentId)
        .map((n) => ({ node: n.id, agent: ctx.db.agents.get(n.agentId as string) ?? null })),
    };
  });

  app.patch('/api/v1/workflows/:id', async (req) => {
    const { id } = req.params as { id: string };
    const existing = findWorkflow(ctx, id);
    if (!existing) throw new NotFoundError('workflow', id);
    const patch = parse(WorkflowPatchSchema, req.body);
    const workflow = ctx.db.workflows.update(existing.id, patch);
    ctx.db.audit.add({ actor: 'operator', action: 'workflow.update', target: workflow.name });
    return { workflow };
  });

  app.delete('/api/v1/workflows/:id', async (req) => {
    const { id } = req.params as { id: string };
    const workflow = findWorkflow(ctx, id);
    if (!workflow) throw new NotFoundError('workflow', id);
    ctx.db.workflows.delete(workflow.id);
    ctx.db.audit.add({ actor: 'operator', action: 'workflow.delete', target: workflow.name });
    return { deleted: true, id: workflow.id };
  });

  const findWorkflow = (ctx: AppContext, idOrName: string) =>
    ctx.db.workflows.get(idOrName) ?? ctx.db.workflows.getByName(idOrName);

  app.post('/api/v1/workflows/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const workflow = findWorkflow(ctx, id);
    if (!workflow) throw new NotFoundError('workflow', id);
    const { input } = parse(WorkflowRunSchema, req.body ?? {});
    const run = ctx.workflows.start(workflow.id, input);
    ctx.db.audit.add({ actor: 'operator', action: 'workflow.run', target: run.id, details: { workflow: workflow.name } });
    reply.code(202);
    return { workflowRun: run };
  });

  app.get('/api/v1/workflow-runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const run = ctx.db.workflows.getRun(id);
    if (!run) throw new NotFoundError('workflow run', id);
    const nodeRuns = ctx.db.workflows.nodeRunsForWorkflowRun(id);
    const childRuns = ctx.db.runs.list({ workflowRunId: id, limit: 50 });
    const workflow = ctx.db.workflows.get(run.workflowId);
    return { workflowRun: run, workflow: workflow ?? null, nodeRuns, childRuns, approvals: ctx.db.approvals.listForWorkflow(id) };
  });

  app.get('/api/v1/workflow-runs', async (req) => {
    const q = req.query as { workflowId?: string; limit?: string };
    return { workflowRuns: ctx.db.workflows.listRuns(q.workflowId, Number(q.limit ?? 50)) };
  });

  app.post('/api/v1/workflow-runs/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const run = ctx.db.workflows.getRun(id);
    if (!run) throw new NotFoundError('workflow run', id);
    const cancelled = ctx.workflows.cancel(id);
    ctx.db.audit.add({ actor: 'operator', action: 'workflow.cancel', target: id });
    return { workflowRun: cancelled };
  });

  app.get('/api/v1/workflow-runs/:id/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ctx.db.workflows.getRun(id)) throw new NotFoundError('workflow run', id);
    const { openSse } = await import('../sse.js');
    openSse(reply, ctx.bus, (e) => e.entityId === id);
    return reply;
  });

  // ── Evaluations ─────────────────────────────────────────────────────────
  app.get('/api/v1/evals/suites', async () => ({
    suites: ctx.db.evals.listSuites().map((s) => ({
      ...s,
      agent: ctx.db.agents.get(s.agentId) ?? null,
      recentRuns: ctx.db.evals.listRuns(s.id, 5),
    })),
  }));

  app.post('/api/v1/evals/suites', async (req, reply) => {
    const spec = parse(SuiteCreateSchema, req.body);
    if (!ctx.db.agents.get(spec.agentId)) throw new NotFoundError('agent', spec.agentId);
    if (ctx.db.evals.getSuiteByName(spec.name)) throw new ConflictError(`suite exists: ${spec.name}`);
    const suite = ctx.db.evals.createSuite(spec);
    ctx.db.audit.add({ actor: 'operator', action: 'evalsuite.create', target: suite.name });
    reply.code(201);
    return { suite };
  });

  app.delete('/api/v1/evals/suites/:id', async (req) => {
    const { id } = req.params as { id: string };
    const suite = ctx.db.evals.getSuite(id);
    if (!suite) throw new NotFoundError('eval suite', id);
    ctx.db.evals.deleteSuite(id);
    ctx.db.audit.add({ actor: 'operator', action: 'evalsuite.delete', target: suite.name });
    return { deleted: true, id };
  });

  app.post('/api/v1/evals/suites/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const suite = ctx.db.evals.getSuite(id);
    if (!suite) throw new NotFoundError('eval suite', id);
    // Fire and forget — clients poll the eval run for status.
    void ctx.evals.runSuite(id).catch((e) => {
      ctx.logger.error({ suiteId: id, error: (e as Error).message }, 'evaluation failed');
    });
    await new Promise((r) => setTimeout(r, 30));
    const latest = ctx.db.evals.listRuns(id, 1)[0] ?? null;
    ctx.db.audit.add({ actor: 'operator', action: 'evalsuite.run', target: suite.name });
    reply.code(202);
    return { evalRun: latest };
  });

  app.get('/api/v1/evals/runs', async (req) => {
    const q = req.query as { suiteId?: string };
    return { evalRuns: ctx.db.evals.listRuns(q.suiteId, 50) };
  });

  app.get('/api/v1/evals/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const evalRun = ctx.db.evals.getRun(id);
    if (!evalRun) throw new NotFoundError('eval run', id);
    return { evalRun, results: ctx.db.evals.caseResults(id), suite: ctx.db.evals.getSuite(evalRun.suiteId) ?? null };
  });
}
