import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type AgentDatabase, type Agent } from '@agentos/database';
import { InProcessEventBus, createAppMetrics, nullLogger, type AppMetrics } from '@agentos/observability';
import { ToolRegistry, builtinTools, type CorpusService } from '@agentos/tool-registry';
import { DeterministicMockProvider, ProviderRegistry } from '@agentos/model-providers';
import { ApprovalService, AgentRuntime } from '../src/index.js';

export interface Harness {
  db: AgentDatabase;
  runtime: AgentRuntime;
  approvals: ApprovalService;
  bus: InProcessEventBus;
  metrics: AppMetrics;
  registry: ToolRegistry;
  paths: { workspaceRoot: string; artifactsDir: string };
  cleanup(): void;
}

export function seedCorpus(db: AgentDatabase): void {
  db.corpus.seed([
    {
      id: 'doc-01',
      title: 'Vector databases for agent memory',
      source: 'infra-journal',
      url: 'https://example.com/vector-databases',
      published: '2026-01-10',
      tags: ['vector', 'database', 'agents'],
      content:
        'Vector databases store embeddings and enable similarity search. Agents use them as long-term memory. Common choices include sqlite-vec, chroma and qdrant for local-first setups.',
      citations: ['doc-01'],
    },
    {
      id: 'doc-02',
      title: 'Agent observability best practices',
      source: 'ops-weekly',
      url: 'https://example.com/agent-observability',
      published: '2026-02-14',
      tags: ['observability', 'traces', 'agents'],
      content:
        'Tracing every tool call and policy decision is essential for agent operations. Structured logs, metrics and deterministic replay form the backbone of agent observability.',
      citations: ['doc-02'],
    },
    {
      id: 'doc-03',
      title: 'Policy engines for tool governance',
      source: 'security-notes',
      url: 'https://example.com/policy-engines',
      published: '2026-03-02',
      tags: ['policy', 'security', 'governance', 'agents'],
      content:
        'A deterministic policy engine decides whether tool calls are allowed, denied, rate limited or require approval. Agents rely on auditable decisions to prevent prompt-injection escalation.',
      citations: ['doc-03'],
    },
  ]);
}

export function corpusService(db: AgentDatabase): CorpusService {
  return {
    search: (query, limit) => db.corpus.search(query, limit),
    get: (id) => db.corpus.get(id),
    count: () => db.corpus.count(),
  };
}

export function makeHarness(opts: { providers?: ProviderRegistry } = {}): Harness {
  const db = openDatabase(':memory:');
  seedCorpus(db);
  const bus = new InProcessEventBus();
  const metrics = createAppMetrics();
  const registry = new ToolRegistry();
  for (const t of builtinTools({ corpus: corpusService(db), allowHosts: [] })) registry.register(t);
  const approvals = new ApprovalService(db, bus, metrics);
  const providers = opts.providers ?? new ProviderRegistry([new DeterministicMockProvider()]);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-rt-'));
  const paths = { workspaceRoot: path.join(tmpRoot, 'runs'), artifactsDir: path.join(tmpRoot, 'artifacts') };
  const runtime = new AgentRuntime({
    db,
    bus,
    metrics,
    registry,
    providers,
    approvals,
    storedRulesFor: (name) =>
      db.policies.list({ agentName: name }).flatMap((p) => (p.enabled ? p.rules : [])),
    logger: nullLogger,
    paths,
  });
  return {
    db,
    runtime,
    approvals,
    bus,
    metrics,
    registry,
    paths,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

/** Polls until a pending approval exists for the run (or throws after timeout). */
export async function waitForPendingApproval(
  db: AgentDatabase,
  runId: string,
  timeoutMs = 3_000,
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const a = db.approvals.pendingForRun(runId);
    if (a) return a.id;
    if (Date.now() - start > timeoutMs) throw new Error(`no pending approval for ${runId} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
