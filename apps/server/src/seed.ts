import type { AgentDatabase, CorpusDoc } from '@agentos/database';
import type { AgentSpec, EvalSuiteSpec, WorkflowSpec } from '@agentos/shared';

/** 10 synthetic corpus documents — the offline "web" for demo research runs. */
export const DEMO_CORPUS: CorpusDoc[] = [
  {
    id: 'doc-01',
    title: 'Vector Databases Power Agent Memory',
    source: 'infra-journal',
    url: 'fixtures/corpus/doc-01',
    published: '2026-01-10',
    tags: ['vector', 'database', 'agents', 'memory'],
    content:
      'Vector databases store embeddings and enable similarity search at scale. Agents use them as long-term memory: past observations are embedded, indexed, and retrieved by relevance rather than recency. Local-first deployments increasingly prefer embedded engines like sqlite-vec over managed services, keeping data on the operator machine and eliminating per-query fees. A vector index is only as good as its chunking strategy, so infra teams treat ingestion pipelines as first-class citizens.',
    citations: ['doc-01'],
  },
  {
    id: 'doc-02',
    title: 'Agent Observability: Traces, Metrics, and Replay',
    source: 'ops-weekly',
    url: 'fixtures/corpus/doc-02',
    published: '2026-02-14',
    tags: ['observability', 'traces', 'metrics', 'agents'],
    content:
      'Observability for agents has three pillars. Traces record every plan, tool call, policy decision, and observation with timestamps. Metrics aggregate run duration, tool success rates, and policy blocks into dashboards. Replay re-executes a deterministic run so engineers can diff the original trace against a candidate fix. Together these facts let operators answer why a run failed without reproducing it by hand, and they form the backbone of reliable agent operations.',
    citations: ['doc-02'],
  },
  {
    id: 'doc-03',
    title: 'Policy Engines for Tool Governance',
    source: 'security-notes',
    url: 'fixtures/corpus/doc-03',
    published: '2026-03-02',
    tags: ['policy', 'security', 'governance', 'agents'],
    content:
      'A deterministic policy engine decides whether a tool call is allowed, denied, rate limited, or escalated for human approval. Because the engine evaluates only structured inputs — agent identity, tool name, argument digest, prior call counts — its verdicts are auditable and immune to prompt injection. Security teams favor allowlist modes by default: unlisted tools are denied unless an operator widens the policy. Every denied call leaves a decision record with the matching rule.',
    citations: ['doc-03'],
  },
  {
    id: 'doc-04',
    title: 'Human-in-the-Loop Approval Patterns',
    source: 'product-eng',
    url: 'fixtures/corpus/doc-04',
    published: '2026-03-21',
    tags: ['approvals', 'agents', 'safety'],
    content:
      'External side effects — sending requests, publishing artifacts, mutating state — deserve a human gate. The pattern is simple: the runtime suspends on a require_approval policy verdict, surfaces an approval request with the exact action and reason, and resumes only after an operator decides. Because the pause is enforced by the runtime rather than the model, prompt-injection attempts cannot bypass it. Teams report that approvals shift trust from hope to verification.',
    citations: ['doc-04'],
  },
  {
    id: 'doc-05',
    title: 'Evaluating Agents Without an LLM Judge',
    source: 'eval-diary',
    url: 'fixtures/corpus/doc-05',
    published: '2026-04-05',
    tags: ['evaluation', 'agents', 'testing'],
    content:
      'LLM judges are expensive, nondeterministic, and easy to game. Deterministic metrics cover most of what matters: task completion against explicit expectations, tool success rate, policy violations, retries, latency budgets, step efficiency, and failure recovery. Evidence checks are mechanical too — a citation pattern plus a minimum count of distinct sources proves the answer is grounded. Deterministic suites run in CI offline, which makes regression tracking a fact rather than a hope.',
    citations: ['doc-05'],
  },
  {
    id: 'doc-06',
    title: 'MCP: Wiring External Tool Servers into Agents',
    source: 'protocol-watch',
    url: 'fixtures/corpus/doc-06',
    published: '2026-04-18',
    tags: ['mcp', 'tools', 'agents', 'integration'],
    content:
      'The Model Context Protocol standardizes how hosts discover and invoke tools from external servers. A control plane registers a server command, performs a tools/list handshake, and mirrors each discovered tool into its own registry with a risk level and permission requirements. Crucially, the platform wraps every MCP call so its own policy engine evaluates the call first — external tools inherit governance instead of bypassing it. Failed servers degrade to explicit errors rather than silent skips.',
    citations: ['doc-06'],
  },
  {
    id: 'doc-07',
    title: 'Local-First Agent Infrastructure on a Budget',
    source: 'frugal-eng',
    url: 'fixtures/corpus/doc-07',
    published: '2026-05-02',
    tags: ['local-first', 'cost', 'agents', 'sqlite'],
    content:
      'A complete agent control plane can run on a laptop: SQLite for persistence, the filesystem for artifacts, an in-process event bus, and a deterministic model provider for offline development. Token cost drops to zero during the 99% of iteration that does not need a frontier model, while a provider interface keeps cloud models one configuration away. The facts are stubborn: local-first stacks remove vendors from the critical path and keep demos reproducible forever.',
    citations: ['doc-07'],
  },
  {
    id: 'doc-08',
    title: 'Bounded Execution Loops Prevent Agent Runaways',
    source: 'runtime-notes',
    url: 'fixtures/corpus/doc-08',
    published: '2026-05-27',
    tags: ['runtime', 'limits', 'agents', 'reliability'],
    content:
      'Unbounded agent loops are the classic failure mode: a model retries a broken tool until the bill or the timeout ends the pain. Bounded execution enforces hard limits on steps, wall-clock runtime, and cost per run, checked before every model call. Retries exist but are capped with backoff, and permanent failures are never retried. When a limit trips, the run fails with a precise error instead of drifting — the facts of termination are decided by the platform, not the prompt.',
    citations: ['doc-08'],
  },
  {
    id: 'doc-09',
    title: 'Browser Automation Agents Under Governance',
    source: 'automation-lab',
    url: 'fixtures/corpus/doc-09',
    published: '2026-06-12',
    tags: ['browser', 'playwright', 'agents', 'safety'],
    content:
      'Browser agents navigate, click, type, and screenshot pages inside a headless Chromium sandbox. Two governance facts matter most: page content is untrusted input that can never alter system policy, and human-verification walls must pause the run rather than be bypassed. Sane platforms restrict navigation to http(s), block credential-bearing URLs, and record every browser action in the trace. CAPTCHA solving services are a liability, not a feature.',
    citations: ['doc-09'],
  },
  {
    id: 'doc-10',
    title: 'From Single Agents to Workflow Orchestration',
    source: 'orchestration-review',
    url: 'fixtures/corpus/doc-10',
    published: '2026-06-30',
    tags: ['workflow', 'orchestration', 'agents', 'multi-agent'],
    content:
      'A single agent hits a wall when work needs specialization: research, evidence collection, analysis, evaluation, and finalization each deserve their own tools and policies. Workflow engines encode those stages as graph nodes with explicit transitions — queued, running, waiting approval, completed, failed, cancelled. Independent branches run in parallel; failures skip downstream nodes instead of hanging. The result is orchestration you can draw, audit, and replay.',
    citations: ['doc-10'],
  },
];

const DEMO_AGENTS: Array<{ spec: AgentSpec; behavior: string }> = [
  {
    behavior: 'researcher',
    spec: {
      name: 'Researcher',
      description: 'Searches the offline corpus for relevant sources and summarizes them with citations.',
      model: 'mock/researcher',
      tools: ['corpus.search', 'corpus.read'],
      permissions: [],
      policies: {
        mode: 'allowlist',
        allowed: ['corpus.search', 'corpus.read'],
        denied: [],
        requireApproval: [],
        rateLimits: {},
      },
      limits: { maxSteps: 10, maxRuntimeMs: 60_000, maxCostUsd: 0.2, toolTimeoutMs: 10_000, maxRetries: 1 },
      enabled: true,
    },
  },
  {
    behavior: 'evidence-collector',
    spec: {
      name: 'Evidence Collector',
      description: 'Reads additional sources and emits a deduplicated evidence list with source ids.',
      model: 'mock/evidence-collector',
      tools: ['corpus.search', 'corpus.read'],
      permissions: [],
      policies: {
        mode: 'allowlist',
        allowed: ['corpus.*'],
        denied: [],
        requireApproval: [],
        rateLimits: {},
      },
      limits: { maxSteps: 12, maxRuntimeMs: 60_000, maxCostUsd: 0.2, toolTimeoutMs: 10_000, maxRetries: 1 },
      enabled: true,
    },
  },
  {
    behavior: 'analyst',
    spec: {
      name: 'Analyst',
      description: 'Derives themes and coverage statistics from collected evidence.',
      model: 'mock/analyst',
      tools: ['calculator', 'corpus.search'],
      permissions: [],
      policies: {
        mode: 'allowlist',
        allowed: ['calculator', 'corpus.search'],
        denied: ['http.fetch'],
        requireApproval: [],
        rateLimits: {},
      },
      limits: { maxSteps: 8, maxRuntimeMs: 45_000, maxCostUsd: 0.1, toolTimeoutMs: 10_000, maxRetries: 1 },
      enabled: true,
    },
  },
  {
    behavior: 'evaluator',
    spec: {
      name: 'Evaluator',
      description: 'Checks upstream output for citations, source counts, and explicit pass criteria.',
      model: 'mock/evaluator',
      tools: [],
      permissions: [],
      policies: { mode: 'allowlist', allowed: [], denied: [], requireApproval: [], rateLimits: {} },
      limits: { maxSteps: 5, maxRuntimeMs: 30_000, maxCostUsd: 0.05, toolTimeoutMs: 10_000, maxRetries: 0 },
      enabled: true,
    },
  },
  {
    behavior: 'finalizer',
    spec: {
      name: 'Finalizer',
      description: 'Composes the final markdown report and publishes it (operator approval required).',
      model: 'mock/finalizer',
      tools: ['report.write'],
      permissions: ['artifacts:write'],
      policies: {
        mode: 'allowlist',
        allowed: ['report.write'],
        denied: [],
        requireApproval: ['report.write'],
        rateLimits: {},
      },
      limits: { maxSteps: 5, maxRuntimeMs: 30_000, maxCostUsd: 0.05, toolTimeoutMs: 10_000, maxRetries: 0 },
      enabled: true,
    },
  },
];

const RESEARCH_REPORT_GRAPH: WorkflowSpec = {
  nodes: [
    { id: 'input', type: 'input', label: 'Task' },
    { id: 'research', type: 'agent', agentId: '', label: 'Research', inputTemplate: '{{input.output}}' },
    { id: 'evidence', type: 'agent', agentId: '', label: 'Collect evidence' },
    { id: 'analyze', type: 'agent', agentId: '', label: 'Analyze' },
    { id: 'evaluate', type: 'agent', agentId: '', label: 'Evaluate' },
    { id: 'finalize', type: 'agent', agentId: '', label: 'Finalize report' },
    { id: 'gate', type: 'approval', label: 'Approve publication?' },
    { id: 'output', type: 'output', label: 'Result' },
  ],
  edges: [
    { from: 'input', to: 'research' },
    { from: 'research', to: 'evidence' },
    { from: 'evidence', to: 'analyze' },
    { from: 'analyze', to: 'evaluate' },
    { from: 'evaluate', to: 'finalize' },
    { from: 'finalize', to: 'gate' },
    { from: 'gate', to: 'output' },
  ],
};

const EVAL_SUITE: EvalSuiteSpec = {
  name: 'research-agent-eval',
  description: 'Deterministic quality gate for the Researcher agent: completion, citations, sources, budgets.',
  agentId: '',
  cases: [
    {
      id: 'case-cites-sources',
      name: 'Cites at least one corpus source',
      task: 'Find three facts about agents',
      expect: { keywords: [], minSources: 1, requireCitations: true, toolsUsed: ['corpus.search'] },
    },
    {
      id: 'case-two-sources',
      name: 'Grounds the answer in two distinct sources',
      task: 'Find three facts about agents',
      expect: { keywords: [], minSources: 2, requireCitations: true, toolsUsed: ['corpus.read'] },
    },
    {
      id: 'case-vector-topic',
      name: 'Handles a vector-database research task',
      task: 'Research how vector databases power agent memory',
      expect: { keywords: [], minSources: 1, requireCitations: true, toolsUsed: ['corpus.search'] },
    },
    {
      id: 'case-observability-topic',
      name: 'Handles an observability research task',
      task: 'Summarize the pillars of agent observability',
      expect: { keywords: [], minSources: 1, requireCitations: false, toolsUsed: ['corpus.search'] },
    },
    {
      id: 'case-step-budget',
      name: 'Stays within the step budget',
      task: 'Find three facts about policy engines',
      expect: { keywords: [], minSources: 1, requireCitations: true, toolsUsed: [], maxSteps: 8 },
    },
    {
      id: 'case-keyword-grounding',
      name: 'Answer mentions the research topic',
      task: 'Find three facts about approvals',
      expect: { keywords: [], minSources: 1, requireCitations: true, toolsUsed: [] },
    },
    {
      id: 'case-no-tools-required',
      name: 'Produces a final answer even for narrow queries',
      task: 'What is an agent control plane?',
      expect: { keywords: [], minSources: 0, requireCitations: false, toolsUsed: [] },
    },
    {
      id: 'case-latency-budget',
      name: 'Completes within the latency budget',
      task: 'Find three facts about MCP tool servers',
      expect: { keywords: [], minSources: 1, requireCitations: true, toolsUsed: [], maxDurationMs: 30_000 },
    },
  ],
};

/** Idempotent demo seeding: runs only when the database has no agents yet. */
export function seedDemoData(db: AgentDatabase): { seeded: boolean; summary: Record<string, number> } {
  if (db.agents.count() > 0) return { seeded: false, summary: {} };

  const corpusDocs = db.corpus.count() === 0 ? db.corpus.seed(DEMO_CORPUS) : 0;

  const agentIds: Record<string, string> = {};
  for (const { spec } of DEMO_AGENTS) {
    const agent = db.agents.create(spec);
    agentIds[spec.name] = agent.id;
  }

  db.policies.create({
    name: 'global-publish-gate',
    description: 'Publishing artifacts outside the run sandbox always requires an operator approval.',
    rules: [{ pattern: 'report.write', action: 'require_approval', note: 'external side effect' }],
    enabled: true,
  });
  db.policies.create({
    name: 'global-denied-tools',
    description: 'Network fetching is denied for all demo agents — the corpus is the only data source.',
    rules: [{ pattern: 'http.fetch', action: 'deny', note: 'offline demo policy' }],
    enabled: true,
  });

  const graph: WorkflowSpec = {
    nodes: RESEARCH_REPORT_GRAPH.nodes.map((n) =>
      n.type === 'agent'
        ? {
            ...n,
            agentId:
              n.id === 'research'
                ? (agentIds['Researcher'] as string)
                : n.id === 'evidence'
                  ? (agentIds['Evidence Collector'] as string)
                  : n.id === 'analyze'
                    ? (agentIds['Analyst'] as string)
                    : n.id === 'evaluate'
                      ? (agentIds['Evaluator'] as string)
                      : (agentIds['Finalizer'] as string),
          }
        : n,
    ),
    edges: RESEARCH_REPORT_GRAPH.edges,
  };
  db.workflows.create({ name: 'research-report', description: 'Research → evidence → analysis → evaluation → approval → report.', graph });

  db.evals.createSuite({
    ...EVAL_SUITE,
    agentId: agentIds['Researcher'] as string,
  });

  db.settings.set('demo_seeded_at', String(Date.now()));
  return {
    seeded: true,
    summary: {
      corpus: corpusDocs,
      agents: Object.keys(agentIds).length,
      policies: 2,
      workflows: 1,
      evalSuites: 1,
    },
  };
}
