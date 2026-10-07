import type { FastifyInstance } from 'fastify';
import { runDoctor } from '../doctor.js';
import type { AppContext } from '../context.js';

export async function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/v1/system/health', async () => ({
    ok: true,
    name: 'AgentOS',
    version: '0.1.0',
    demoMode: ctx.config.demoMode,
    uptimeSec: Math.round(process.uptime()),
    dbMigrations: ctx.db.migrationsApplied,
  }));

  app.get('/api/v1/system/summary', async () => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const day = startOfDay.getTime();
    const stats = ctx.db.stats.runStats(day);
    const costs = ctx.db.costs.totals(day);
    const allTimeCosts = ctx.db.costs.totals(0);
    const evalLatest = latestEvalScore(ctx);
    const todayDecisions = ctx.db.stats.decisionCounts(day);
    const allDecisions = ctx.db.stats.decisionCounts(0);
    const blocks = (d: Record<string, number>): number => (d.deny ?? 0) + (d.rate_limited ?? 0);
    return {
      demoMode: ctx.config.demoMode,
      agents: { total: ctx.db.agents.count(), enabled: ctx.db.agents.list({ enabled: true }).length },
      runs: {
        today: stats.today,
        total: ctx.db.stats.runStats(0).total,
        active: stats.active,
        completed: stats.completed,
        failed: stats.failed,
        cancelled: stats.cancelled,
      },
      toolCalls: { today: stats.toolCalls, failures: stats.toolFailures },
      avgLatencyMs: stats.avgDurationMs,
      policy: {
        blocksToday: blocks(todayDecisions),
        blocksAllTime: blocks(allDecisions),
        requireApprovalToday: todayDecisions.require_approval ?? 0,
        pendingApprovals: ctx.db.approvals.pendingCount(),
      },
      cost: {
        todayUsd: costs.costUsd,
        allTimeUsd: allTimeCosts.costUsd,
        tokensToday: costs.tokensIn + costs.tokensOut,
        localCalls: costs.localCalls,
        cloudCalls: costs.cloudCalls,
        mockCalls: costs.mockCalls,
      },
      evaluation: evalLatest,
      providers: ctx.providers.list().map((p) => ({ ...p.metadata(), active: true })),
      mcpServers: ctx.db.mcp.list().length,
      workflows: ctx.db.workflows.list().length,
      tools: ctx.db.tools.list().length,
    };
  });

  app.get('/api/v1/system/timeseries', async (req) => {
    const q = req.query as { days?: string };
    const days = Math.min(90, Math.max(1, Number(q.days ?? 14)));
    return { runs: ctx.db.stats.runsPerDay(days), costs: ctx.db.costs.perDay(days) };
  });

  app.get('/api/v1/system/providers', async () => {
    const [ollamaUp, openaiConfigured] = await Promise.all([probeOllama(ctx), Promise.resolve(Boolean(ctx.config.openai.apiKey))]);
    return {
      providers: [
        {
          name: 'mock',
          locality: 'mock',
          status: 'ready',
          detail: 'deterministic offline provider — always available, cost $0.00',
          cost: '$0.00',
        },
        {
          name: 'ollama',
          locality: 'local',
          status: ollamaUp ? 'ready' : 'unreachable',
          detail: ollamaUp
            ? `connected at ${ctx.config.ollama.url} (model: ${ctx.config.ollama.model})`
            : `not reachable at ${ctx.config.ollama.url} — start Ollama or keep using the mock provider`,
          cost: '$0.00 (local)',
        },
        {
          name: 'openai-compatible',
          locality: 'cloud',
          status: openaiConfigured ? 'configured' : 'not-configured',
          detail: openaiConfigured
            ? `configured: ${ctx.config.openai.baseUrl} (model: ${ctx.config.openai.model})`
            : 'set AGENTOS_OPENAI_API_KEY to enable — never required for the demo',
          cost: 'metered (estimated)',
        },
      ],
      browser: await browserStatus(ctx),
    };
  });

  app.get('/api/v1/system/doctor', async () => ({ checks: await runDoctor(ctx) }));

  app.get('/api/v1/audit', async (req) => {
    const q = req.query as { limit?: string };
    return { entries: ctx.db.audit.list(Number(q.limit ?? 100)) };
  });

  app.get('/api/v1/settings', async () => ({
    settings: {
      dataDir: ctx.config.dataDir,
      dbFile: ctx.config.dbFile,
      workspaceDir: ctx.config.workspaceDir,
      artifactsDir: ctx.config.artifactsDir,
      demoMode: ctx.config.demoMode,
      port: ctx.config.port,
      host: ctx.config.host,
      fetchAllowHosts: ctx.config.fetchAllowHosts,
      webDist: ctx.config.webDist,
    },
    counts: {
      agents: ctx.db.agents.count(),
      runs: ctx.db.stats.runStats(0).total,
      corpus: ctx.db.corpus.count(),
      tools: ctx.db.tools.list().length,
      policies: ctx.db.policies.list().length,
      workflows: ctx.db.workflows.list().length,
      evalSuites: ctx.db.evals.listSuites().length,
      mcpServers: ctx.db.mcp.list().length,
    },
  }));

  // Offline corpus pages so browser.navigate works without internet.
  app.get('/fixtures/corpus', async (_req, reply) => {
    const docs = ctx.db.corpus.list();
    reply.type('text/html; charset=utf-8');
    return corpusIndexHtml(docs);
  });

  app.get('/fixtures/corpus/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const doc = ctx.db.corpus.get(id);
    if (!doc) {
      reply.code(404).type('text/html; charset=utf-8');
      return '<html><body><h1>404</h1><p>Unknown corpus document.</p></body></html>';
    }
    reply.type('text/html; charset=utf-8');
    return corpusDocHtml(doc);
  });
}

async function probeOllama(ctx: AppContext): Promise<boolean> {
  try {
    const res = await fetch(`${ctx.config.ollama.url}/api/tags`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

async function browserStatus(ctx: AppContext): Promise<{ available: boolean; reason?: string }> {
  try {
    const { getBrowserManager } = await import('@agentos/browser');
    const probe = await getBrowserManager().availabilityProbe();
    return { available: probe.available, reason: probe.reason };
  } catch (e) {
    return { available: false, reason: (e as Error).message };
  }
}

function latestEvalScore(ctx: AppContext): { successRate: number | null; cases: number; runId: string | null } {
  for (const run of ctx.db.evals.listRuns(undefined, 1)) {
    if (run.status === 'completed' && run.summary) {
      return { successRate: run.summary.successRate, cases: run.summary.cases, runId: run.id };
    }
  }
  return { successRate: null, cases: 0, runId: null };
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function corpusIndexHtml(docs: { id: string; title: string; source: string }[]): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>AgentOS Demo Corpus</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 16px;color:#111}
li{margin:.5rem 0}code{background:#f1f1f4;padding:1px 5px;border-radius:4px}</style></head>
<body><h1>AgentOS Demo Corpus</h1><p>Offline synthetic documents used by <code>corpus.search</code> / <code>corpus.read</code>. No internet required.</p>
<ul>${docs.map((d) => `<li><a href="/fixtures/corpus/${d.id}">${esc(d.title)}</a> — ${esc(d.source)} (<code>${d.id}</code>)</li>`).join('')}</ul>
</body></html>`;
}

function corpusDocHtml(doc: { id: string; title: string; source: string; url: string; published: string; tags: string[]; content: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.title)}</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 16px;color:#111}
.meta{color:#555;font-size:.9rem}.tag{display:inline-block;background:#eef2ff;color:#3730a3;padding:2px 8px;border-radius:999px;margin-right:6px;font-size:.8rem}</style></head>
<body><p class="meta"><a href="/fixtures/corpus">← corpus</a></p>
<h1>${esc(doc.title)}</h1>
<p class="meta">${esc(doc.source)} · ${esc(doc.published)} · <code>${doc.id}</code></p>
<p>${doc.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p>
<p>${esc(doc.content)}</p></body></html>`;
}
