import fs from 'node:fs';
import { openDatabase, type AgentDatabase } from '@agentos/database';
import {
  InProcessEventBus,
  createAppMetrics,
  createLogger,
  nullLogger,
  type AppMetrics,
  type Logger,
} from '@agentos/observability';
import { ToolRegistry, builtinTools } from '@agentos/tool-registry';
import {
  DeterministicMockProvider,
  OllamaProvider,
  OpenAiCompatibleProvider,
  ProviderRegistry,
} from '@agentos/model-providers';
import { AgentRuntime, ApprovalService } from '@agentos/runtime';
import { WorkflowEngine } from '@agentos/workflow-engine';
import { EvaluationRunner } from '@agentos/evaluation';
import { McpManager } from '@agentos/mcp';
import { browserTools, getBrowserManager } from '@agentos/browser';
import type { EventBus } from '@agentos/shared';
import type { AppConfig } from './config.js';
import { seedDemoData } from './seed.js';

export interface AppContext {
  config: AppConfig;
  db: AgentDatabase;
  bus: EventBus;
  metrics: AppMetrics;
  logger: Logger;
  registry: ToolRegistry;
  providers: ProviderRegistry;
  approvals: ApprovalService;
  runtime: AgentRuntime;
  workflows: WorkflowEngine;
  evals: EvaluationRunner;
  mcp: McpManager;
  seedSummary: Record<string, number>;
  close(): Promise<void>;
}

export function createContext(config: AppConfig, opts: { logPretty?: boolean } = {}): AppContext {
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  fs.mkdirSync(config.artifactsDir, { recursive: true });

  const db = openDatabase(config.dbFile);
  const bootInterrupted = db.runs.interruptAll() + db.workflows.interruptOpen();
  const orphanedApprovals = db.approvals.resolveAllPending('system:restart');
  const logger =
    config.logPretty || opts.logPretty
      ? createLogger({ pretty: true })
      : createLogger({ pretty: false });

  const bus = new InProcessEventBus();
  const metrics = createAppMetrics();

  // Tool registry: builtin + browser tools (Playwright optional at runtime).
  const registry = new ToolRegistry();
  const corpus = {
    search: (q: string, limit: number) => db.corpus.search(q, limit),
    get: (id: string) => db.corpus.get(id),
    count: () => db.corpus.count(),
  };
  for (const tool of builtinTools({ corpus, allowHosts: config.fetchAllowHosts })) {
    registry.register(tool);
  }
  for (const tool of browserTools(getBrowserManager())) {
    registry.register(tool);
  }
  // Mirror registered tool metadata into the tools table for the UI.
  for (const def of registry.list()) {
    db.tools.upsert({
      name: def.name,
      description: def.description,
      kind: def.kind,
      source: 'builtin',
      riskLevel: def.riskLevel,
      permissions: def.permissions,
      inputSchema: def.inputSchemaJson,
    });
  }

  // Providers: mock always; Ollama + OpenAI-compatible registered so failures
  // degrade visibly (provider_fallback) instead of silently routing to mock.
  const providers = new ProviderRegistry(
    [
      new DeterministicMockProvider(),
      new OllamaProvider({ baseUrl: config.ollama.url, defaultModel: config.ollama.model }),
      new OpenAiCompatibleProvider({
        baseUrl: config.openai.baseUrl,
        apiKey: config.openai.apiKey,
        defaultModel: config.openai.model,
        priceOverrides: config.priceOverrides,
      }),
    ],
    {
      onFallback: ({ modelRef, reason }) => {
        logger.warn({ modelRef, reason }, 'provider failed — falling back to deterministic mock');
        metrics.policyDecisions.inc({ decision: 'provider_fallback' });
      },
    },
  );

  const approvals = new ApprovalService(db, bus, metrics);
  const runtime = new AgentRuntime({
    db,
    bus,
    metrics,
    registry,
    providers,
    approvals,
    storedRulesFor: (agentName) =>
      db.policies.list({ agentName }).flatMap((p) => (p.enabled ? p.rules : [])),
    logger: logger.child({ mod: 'runtime' }),
    paths: { workspaceRoot: config.workspaceDir, artifactsDir: config.artifactsDir },
  });
  const workflows = new WorkflowEngine({
    db,
    bus,
    metrics,
    runtime,
    approvals,
    logger: logger.child({ mod: 'workflow' }),
  });
  const evals = new EvaluationRunner({
    db,
    runtime,
    metrics,
    bus,
    logger: logger.child({ mod: 'eval' }),
  });
  const mcp = new McpManager(db, registry);

  const seed = seedDemoData(db);
  if (bootInterrupted > 0) {
    logger.warn({ count: bootInterrupted }, 'marked open runs as interrupted after restart');
  }
  if (orphanedApprovals > 0) {
    logger.warn({ count: orphanedApprovals }, 'resolved orphaned pending approvals (no waiter survives restart)');
  }

  return {
    config,
    db,
    bus,
    metrics,
    logger: logger.child({ mod: 'app' }),
    registry,
    providers,
    approvals,
    runtime,
    workflows,
    evals,
    mcp,
    seedSummary: seed.summary,
    async close() {
      approvals.shutdown('server shutting down');
      await mcp.shutdown().catch(() => undefined);
      await getBrowserManager().closeAll().catch(() => undefined);
      db.close();
    },
  };
}

/** Quiet context for API integration tests (in-memory db, silent logs). */
export function createTestContext(config: AppConfig): AppContext {
  const ctx = createContext({ ...config, dbFile: ':memory:' }, { logPretty: false });
  return ctx;
}

export { nullLogger };
