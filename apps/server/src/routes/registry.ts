import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConflictError, NotFoundError, PolicyConfigSchema } from '@agentos/shared';
import { evaluatePolicy } from '@agentos/policy-engine';
import { McpServerSpecSchema } from '@agentos/shared';
import type { AppContext } from '../context.js';
import { parse } from '../app.js';

const ToolInvokeSchema = z.object({
  args: z.record(z.string(), z.unknown()).default({}),
});

const PolicyEvaluateSchema = z.object({
  agentId: z.string().min(1),
  tool: z.string().min(1).max(128),
});

const PolicyCreateSchema = z.object({
  name: z.string().min(2).max(64),
  description: z.string().max(2_000).default(''),
  agentName: z.string().max(64).optional(),
  rules: z
    .array(
      z.object({
        pattern: z.string().min(1).max(128),
        action: z.enum(['allow', 'deny', 'require_approval']),
        maxCallsPerRun: z.number().int().min(1).max(10_000).optional(),
        note: z.string().max(500).optional(),
      }),
    )
    .default([]),
  enabled: z.boolean().default(true),
});

export async function registerRegistryRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // ── Tools ───────────────────────────────────────────────────────────────
  app.get('/api/v1/tools', async () => {
    const rows = ctx.db.tools.list();
    const handlers = new Map(ctx.registry.list().map((t) => [t.name, t]));
    return {
      tools: rows.map((row) => ({
        ...row,
        executable: handlers.has(row.name),
        sampleInput: handlers.get(row.name)?.sampleInput() ?? {},
      })),
    };
  });

  for (const action of ['enable', 'disable'] as const) {
    app.post(`/api/v1/tools/:name/${action}`, async (req) => {
      const { name } = req.params as { name: string };
      if (!ctx.db.tools.get(name)) throw new NotFoundError('tool', name);
      ctx.db.tools.setEnabled(name, action === 'enable');
      ctx.db.audit.add({ actor: 'operator', action: `tool.${action}`, target: name });
      return { tool: ctx.db.tools.get(name) };
    });
  }

  app.post('/api/v1/tools/:name/invoke', async (req) => {
    const { name } = req.params as { name: string };
    const def = ctx.registry.get(name);
    if (!def) throw new NotFoundError('tool', name);
    const { args } = parse(ToolInvokeSchema, req.body ?? {});
    const startedAt = Date.now();
    const result = await def.handler(args, {
      runId: 'console',
      agentId: 'operator',
      signal: new AbortController().signal,
      workspaceDir: ctx.config.workspaceDir,
      artifactsDir: ctx.config.artifactsDir,
      logger: ctx.logger,
    });
    ctx.db.audit.add({ actor: 'operator', action: 'tool.invoke', target: name, details: { ok: result.ok } });
    return { result: { ...result, durationMs: Date.now() - startedAt } };
  });

  // ── Policies ────────────────────────────────────────────────────────────
  app.get('/api/v1/policies', async () => ({ policies: ctx.db.policies.list() }));

  app.post('/api/v1/policies', async (req, reply) => {
    const spec = parse(PolicyCreateSchema, req.body);
    if (ctx.db.policies.getByName(spec.name)) throw new ConflictError(`policy already exists: ${spec.name}`);
    const policy = ctx.db.policies.create(spec);
    ctx.db.audit.add({ actor: 'operator', action: 'policy.create', target: policy.name });
    reply.code(201);
    return { policy };
  });

  app.patch('/api/v1/policies/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!ctx.db.policies.get(id)) throw new NotFoundError('policy', id);
    const patch = parse(PolicyCreateSchema.partial(), req.body);
    const policy = ctx.db.policies.update(id, patch);
    ctx.db.audit.add({ actor: 'operator', action: 'policy.update', target: policy.name });
    return { policy };
  });

  app.delete('/api/v1/policies/:id', async (req) => {
    const { id } = req.params as { id: string };
    const policy = ctx.db.policies.get(id);
    if (!policy) throw new NotFoundError('policy', id);
    ctx.db.policies.delete(id);
    ctx.db.audit.add({ actor: 'operator', action: 'policy.delete', target: policy.name });
    return { deleted: true, id };
  });

  /** Dry-run: what would the policy engine decide for this agent + tool? */
  app.post('/api/v1/policies/evaluate', async (req) => {
    const { agentId, tool } = parse(PolicyEvaluateSchema, req.body);
    const agent = ctx.db.agents.get(agentId) ?? ctx.db.agents.getByName(agentId);
    if (!agent) throw new NotFoundError('agent', agentId);
    const def = ctx.registry.get(tool);
    const storedRules = ctx.db.policies
      .list({ agentName: agent.name })
      .flatMap((p) => (p.enabled ? p.rules : []));
    const decision = evaluatePolicy({
      tool,
      agentPolicies: agent.policies,
      storedRules,
      toolRisk: def?.riskLevel ?? 'high',
      callCounts: {},
    });
    return { decision, toolKnown: Boolean(def), toolRisk: def?.riskLevel ?? 'unknown' };
  });

  /** Preview an agent policy config as the engine sees it. */
  app.get('/api/v1/policies/agent/:agentId', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const agent = ctx.db.agents.get(agentId) ?? ctx.db.agents.getByName(agentId);
    if (!agent) throw new NotFoundError('agent', agentId);
    const stored = ctx.db.policies.list({ agentName: agent.name });
    return { embedded: PolicyConfigSchema.parse(agent.policies), stored };
  });

  // ── MCP servers ─────────────────────────────────────────────────────────
  app.get('/api/v1/mcp/servers', async () => ({
    servers: ctx.db.mcp.list().map((s) => ({ ...s, connected: ctx.mcp.isConnected(s.id) })),
  }));

  app.post('/api/v1/mcp/servers', async (req, reply) => {
    const spec = parse(McpServerSpecSchema, req.body);
    if (ctx.db.mcp.getByName(spec.name)) throw new ConflictError(`MCP server already registered: ${spec.name}`);
    const server = ctx.db.mcp.create(spec);
    ctx.db.audit.add({ actor: 'operator', action: 'mcp.register', target: server.name });
    try {
      const toolCount = await ctx.mcp.connect(server);
      reply.code(201);
      return { server: ctx.db.mcp.get(server.id), tools: toolCount, connected: true };
    } catch (e) {
      ctx.db.mcp.updateStatus(server.id, 'error', 0);
      reply.code(201);
      return {
        server: ctx.db.mcp.get(server.id),
        tools: 0,
        connected: false,
        error: `registered but connect failed: ${(e as Error).message}`,
      };
    }
  });

  app.post('/api/v1/mcp/servers/:id/reconnect', async (req) => {
    const { id } = req.params as { id: string };
    const server = ctx.db.mcp.get(id);
    if (!server) throw new NotFoundError('mcp server', id);
    try {
      const toolCount = await ctx.mcp.connect(server);
      return { server: ctx.db.mcp.get(id), tools: toolCount, connected: true };
    } catch (e) {
      ctx.db.mcp.updateStatus(id, 'error', 0);
      return { server: ctx.db.mcp.get(id), tools: 0, connected: false, error: (e as Error).message };
    }
  });

  app.delete('/api/v1/mcp/servers/:id', async (req) => {
    const { id } = req.params as { id: string };
    const server = ctx.db.mcp.get(id);
    if (!server) throw new NotFoundError('mcp server', id);
    await ctx.mcp.removeServer(id);
    ctx.db.mcp.delete(id);
    ctx.db.audit.add({ actor: 'operator', action: 'mcp.remove', target: server.name });
    return { deleted: true, id };
  });
}
