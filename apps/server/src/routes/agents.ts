import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentPatchSchema, AgentSpecSchema, ConflictError, NotFoundError, type AgentSpec } from '@agentos/shared';
import type { AppContext } from '../context.js';
import { parse } from '../app.js';

const RunRequestSchema = z.object({
  task: z.string().min(1).max(8_000),
  mode: z.enum(['demo', 'live']).optional(),
  seed: z.number().int().min(0).max(0xffffffff).optional(),
});

export async function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/v1/agents', async (req) => {
    const q = req.query as { search?: string; enabled?: string };
    const agents = ctx.db.agents.list({
      search: q.search,
      enabled: q.enabled === undefined ? undefined : q.enabled === 'true',
    });
    return {
      agents: agents.map((a) => ({
        ...a,
        performance: ctx.db.stats.agentPerformance(a.id),
        evalSummary: ctx.db.evals.latestSummaryForAgent(a.id),
        toolCount: a.tools.length,
      })),
      total: agents.length,
    };
  });

  app.post('/api/v1/agents', async (req, reply) => {
    const spec = parse(AgentSpecSchema, req.body);
    assertToolsExist(ctx, spec);
    const agent = ctx.db.agents.create(spec);
    ctx.db.audit.add({ actor: 'operator', action: 'agent.create', target: agent.name, details: { model: agent.model } });
    reply.code(201);
    return { agent };
  });

  app.get('/api/v1/agents/:id', async (req) => {
    const { id } = req.params as { id: string };
    const agent = ctx.db.agents.get(id) ?? ctx.db.agents.getByName(id);
    if (!agent) throw new NotFoundError('agent', id);
    const runs = ctx.db.runs.list({ agentId: agent.id, limit: 20 });
    const capabilities = agent.tools.map((name) => {
      const def = ctx.registry.get(name);
      const perm = def
        ? ctx.registry.checkPermissions(agent.permissions, def)
        : { ok: false, missing: ['unregistered'] };
      return {
        name,
        registered: Boolean(def),
        risk: def?.riskLevel ?? 'unknown',
        kind: def?.kind ?? 'unknown',
        description: def?.description ?? '',
        permissionOk: perm.ok,
        missing: perm.missing,
        enabled: ctx.db.tools.get(name)?.enabled ?? false,
      };
    });
    return {
      agent,
      versions: ctx.db.agents.versions(agent.id),
      performance: ctx.db.stats.agentPerformance(agent.id),
      evalSummary: ctx.db.evals.latestSummaryForAgent(agent.id),
      capabilities,
      recentRuns: runs,
      policies: ctx.db.policies.list({ agentName: agent.name }),
    };
  });

  app.patch('/api/v1/agents/:id', async (req) => {
    const { id } = req.params as { id: string };
    const patch = parse(AgentPatchSchema, req.body);
    const existing = ctx.db.agents.get(id);
    if (!existing) throw new NotFoundError('agent', id);
    const merged: AgentSpec = { ...existing, ...patch };
    assertToolsExist(ctx, merged);
    const agent = ctx.db.agents.update(id, patch);
    ctx.db.audit.add({ actor: 'operator', action: 'agent.update', target: agent.name, details: { fields: Object.keys(patch) } });
    return { agent };
  });

  app.delete('/api/v1/agents/:id', async (req) => {
    const { id } = req.params as { id: string };
    const agent = ctx.db.agents.get(id);
    if (!agent) throw new NotFoundError('agent', id);
    const active = ctx.db.runs
      .list({ agentId: id, limit: 10 })
      .some((r) => ['queued', 'running', 'waiting_approval', 'paused'].includes(r.status));
    if (active) throw new ConflictError('cannot delete an agent with active runs');
    ctx.db.agents.delete(id);
    ctx.db.audit.add({ actor: 'operator', action: 'agent.delete', target: agent.name });
    return { deleted: true, id };
  });

  for (const action of ['enable', 'disable'] as const) {
    app.post(`/api/v1/agents/:id/${action}`, async (req) => {
      const { id } = req.params as { id: string };
      const agent = ctx.db.agents.get(id);
      if (!agent) throw new NotFoundError('agent', id);
      const updated = ctx.db.agents.setEnabled(id, action === 'enable');
      ctx.db.audit.add({ actor: 'operator', action: `agent.${action}`, target: agent.name });
      return { agent: updated };
    });
  }

  app.get('/api/v1/agents/:id/versions', async (req) => {
    const { id } = req.params as { id: string };
    const agent = ctx.db.agents.get(id);
    if (!agent) throw new NotFoundError('agent', id);
    return { versions: ctx.db.agents.versions(id) };
  });

  app.post('/api/v1/agents/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = ctx.db.agents.get(id);
    if (!agent) throw new NotFoundError('agent', id);
    const { task, mode, seed } = parse(RunRequestSchema, req.body);
    const run = ctx.runtime.start({ agent, task, mode, seed });
    ctx.db.audit.add({ actor: 'operator', action: 'run.start', target: run.id, details: { agent: agent.name } });
    reply.code(202);
    return { run };
  });

  app.get('/api/v1/agents/:id/runs', async (req) => {
    const { id } = req.params as { id: string };
    const agent = ctx.db.agents.get(id);
    if (!agent) throw new NotFoundError('agent', id);
    const q = req.query as { limit?: string };
    return { runs: ctx.db.runs.list({ agentId: id, limit: Number(q.limit ?? 50) }) };
  });
}

function assertToolsExist(ctx: AppContext, spec: AgentSpec): void {
  for (const t of spec.tools) {
    if (!ctx.registry.get(t)) {
      throw new ConflictError(`unknown tool in agent config: ${t}`);
    }
  }
}
