import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import { ZodError, type z } from 'zod';
import { AgentOsError, isAgentOsError } from '@agentos/shared';
import type { AppContext } from './context.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerRegistryRoutes } from './routes/registry.js';
import { registerWorkflowRoutes } from './routes/workflows.js';
import { registerSystemRoutes } from './routes/system.js';

/** Zod-parse helper: returns the schema OUTPUT type; throws 400 with the first issue. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new AgentOsError(`${where}${issue?.message ?? 'invalid input'}`, 400);
  }
  return result.data as z.infer<S>;
}

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 1_048_576, // 1 MB request size cap
    disableRequestLogging: true,
  });

  await app.register(cors, { origin: true });

  app.setErrorHandler((error: unknown, _req, reply) => {
    const err = (error ?? {}) as { message?: string; statusCode?: number };
    if (error instanceof ZodError) {
      reply.code(400).send({ error: 'validation failed', issues: error.issues });
      return;
    }
    if (isAgentOsError(error)) {
      reply.code(error.status).send({ error: error.message });
      return;
    }
    const status = typeof err.statusCode === 'number' && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) ctx.logger.error({ err: err.message }, 'unhandled route error');
    reply.code(status).send({ error: err.message || 'internal error' });
  });

  app.addHook('onRequest', (req, reply, done) => {
    reply.header('x-agentos', 'control-plane');
    void req;
    done();
  });

  // Metrics (Prometheus text format)
  app.get('/metrics', async (_req, reply) => {
    ctx.metrics.runsActive.set({}, ctx.db.runs.active().length);
    ctx.metrics.approvalsPending.set({}, ctx.db.approvals.pendingCount());
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return ctx.metrics.registry.render();
  });

  await registerSystemRoutes(app, ctx);
  await registerAgentRoutes(app, ctx);
  await registerRunRoutes(app, ctx);
  await registerRegistryRoutes(app, ctx);
  await registerWorkflowRoutes(app, ctx);

  // Serve the built dashboard when present (production-style single port).
  if (fs.existsSync(ctx.config.webDist)) {
    await app.register(fastifyStatic, { root: ctx.config.webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url === '/metrics') {
        reply.code(404).send({ error: `not found: ${req.url}` });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  return app;
}
