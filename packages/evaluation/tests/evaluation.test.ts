import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSpec, EvalCase } from '@agentos/shared';
import { EvaluationRunner, checkExpectations, checkToolsUsed, computeRunMetrics, summarize } from '../src/index.js';
import { makeHarness, type Harness } from '../../runtime/tests/harness.js';
import { nullLogger } from '@agentos/observability';
import { InProcessEventBus } from '@agentos/observability';

let harness: Harness | null = null;

function newHarness(): Harness {
  harness?.cleanup();
  harness = makeHarness();
  return harness;
}

afterEach(() => {
  harness?.cleanup();
  harness = null;
});

const researcherSpec = (): AgentSpec => ({
  name: 'researcher',
  description: 'research agent',
  model: 'mock/researcher',
  tools: ['corpus.search', 'corpus.read'],
  permissions: [],
  policies: { mode: 'allowlist', allowed: ['corpus.*'], denied: [], requireApproval: [], rateLimits: {} },
  limits: { maxSteps: 10, maxRuntimeMs: 30_000, maxCostUsd: 0.5, toolTimeoutMs: 5_000, maxRetries: 1 },
  enabled: true,
});

function runnerFor(h: Harness): EvaluationRunner {
  return new EvaluationRunner({
    db: h.db,
    runtime: h.runtime,
    metrics: h.metrics,
    bus: new InProcessEventBus(),
    logger: nullLogger,
  });
}

const caseOf = (
  over: Omit<Partial<EvalCase>, 'expect' | 'id' | 'task'> & {
    id: string;
    task: string;
    expect?: Partial<EvalCase['expect']>;
  },
): EvalCase => ({
  id: over.id,
  task: over.task,
  name: over.name ?? over.id,
  expect: {
    keywords: [],
    minSources: 0,
    requireCitations: false,
    toolsUsed: [],
    ...over.expect,
  },
});

describe('computeRunMetrics', () => {
  it('derives metrics from the persisted trace', async () => {
    const h = newHarness();
    const agent = h.db.agents.create(researcherSpec());
    const run = h.runtime.start({ agent, task: 'Find three facts about agents', seed: 99 });
    const finished = await h.runtime.waitFor(run.id);
    const m = computeRunMetrics(h.db, finished);
    expect(m.completed).toBe(true);
    expect(m.steps).toBeGreaterThanOrEqual(4);
    expect(m.toolSuccessRate).toBe(1);
    expect(m.policyViolations).toBe(0);
    expect(m.recoveryRate).toBe(1); // no failures → fully recovered
    expect(m.costUsd).toBe(0);
    expect(m.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('checkExpectations', () => {
  const base = {
    completed: true,
    steps: 5,
    durationMs: 1000,
    toolSuccessRate: 1,
    toolCalls: 3,
    toolFailures: 0,
    retries: 0,
    policyViolations: 0,
    recoveryRate: 1,
    costUsd: 0,
    tokensIn: 10,
    tokensOut: 10,
  };

  it('requires every keyword in the final answer', () => {
    const c = caseOf({ id: 'c1', task: 't', expect: { keywords: ['vector', 'agents'] } });
    expect(checkExpectations(c, 'agents use vector search', base, 'completed', null)).toBeNull();
    expect(checkExpectations(c, 'agents use sql', base, 'completed', null)).toContain('missing keyword "vector"');
  });

  it('requires citations when asked', () => {
    const c = caseOf({ id: 'c2', task: 't', expect: { requireCitations: true } });
    expect(checkExpectations(c, 'claim [source: doc-01]', base, 'completed', null)).toBeNull();
    expect(checkExpectations(c, 'unsupported claim', base, 'completed', null)).toContain('citations');
  });

  it('counts distinct cited sources', () => {
    const c = caseOf({ id: 'c3', task: 't', expect: { minSources: 2 } });
    expect(checkExpectations(c, '[doc-01] a [doc-02] b', base, 'completed', null)).toBeNull();
    expect(checkExpectations(c, '[doc-01] a [doc-01] b', base, 'completed', null)).toContain('expected >= 2');
  });

  it('enforces step and latency budgets and failed runs', () => {
    const c = caseOf({ id: 'c4', task: 't', expect: { maxSteps: 3, maxDurationMs: 500 } });
    expect(checkExpectations(c, 'ok', base, 'completed', null)).toContain('steps 5 exceeded budget 3');
    expect(checkExpectations(c, 'ok', base, 'failed', 'boom')).toContain('run failed');
  });
});

describe('checkToolsUsed', () => {
  it('verifies required tools were called', () => {
    const events = [
      { type: 'tool_called', tool: 'corpus.search' },
      { type: 'tool_completed', tool: 'corpus.search' },
    ];
    expect(checkToolsUsed(events, ['corpus.search'])).toBeNull();
    expect(checkToolsUsed(events, ['corpus.read'])).toContain('corpus.read');
  });
});

describe('summarize', () => {
  it('aggregates pass rate, averages, violations, and cost', () => {
    const mk = (passed: boolean, steps: number) => ({
      caseId: 'x',
      name: 'x',
      passed,
      runId: 'run_1',
      metrics: {
        completed: passed,
        steps,
        durationMs: 1000,
        toolSuccessRate: 1,
        toolCalls: 2,
        toolFailures: 0,
        retries: 0,
        policyViolations: passed ? 0 : 2,
        recoveryRate: 1,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
      },
      failureReason: passed ? null : 'nope',
    });
    const s = summarize([mk(true, 4), mk(true, 6), mk(false, 8)]);
    expect(s.cases).toBe(3);
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.successRate).toBeCloseTo(0.667, 3);
    expect(s.avgSteps).toBe(6);
    expect(s.policyViolations).toBe(2);
    expect(s.totalCostUsd).toBe(0);
  });
});

describe('EvaluationRunner', () => {
  it('runs a suite end-to-end deterministically', async () => {
    const h = newHarness();
    const agent = h.db.agents.create(researcherSpec());
    const suite = h.db.evals.createSuite({
      name: 'research-quality',
      description: 'citation and source checks',
      agentId: agent.id,
      cases: [
        {
          id: 'c1',
          name: 'cites at least one source',
          task: 'Find three facts about agents',
          expect: { keywords: [], minSources: 1, requireCitations: true, toolsUsed: ['corpus.search'] },
        },
        {
          id: 'c2',
          name: 'includes keyword vector',
          task: 'Find three facts about agents',
          expect: { keywords: ['doc'], minSources: 1, requireCitations: false, toolsUsed: [] },
        },
      ],
    });

    const runner = runnerFor(h);
    const { evalRun, outcomes } = await runner.runSuite(suite.id);
    expect(evalRun.status).toBe('completed');
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.passed)).toBe(true);
    expect(evalRun.summary?.successRate).toBe(1);
    expect(evalRun.summary?.cases).toBe(2);

    // case results persisted for the UI
    const rows = h.db.evals.caseResults(evalRun.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.runId?.startsWith('run_'))).toBe(true);
    expect(rows.every((r) => r.metrics.completed === true)).toBe(true);
  });

  it('fails a case whose expectation is not met', async () => {
    const h = newHarness();
    const agent = h.db.agents.create(researcherSpec());
    const suite = h.db.evals.createSuite({
      name: 'strict',
      description: '',
      agentId: agent.id,
      cases: [
        {
          id: 'impossible',
          name: 'requires a keyword that never appears',
          task: 'Find three facts about agents',
          expect: { keywords: ['quantum-blockchain'], minSources: 0, requireCitations: false, toolsUsed: [] },
        },
      ],
    });
    const { evalRun, outcomes } = await runnerFor(h).runSuite(suite.id);
    expect(evalRun.status).toBe('completed');
    expect(outcomes[0]?.passed).toBe(false);
    expect(outcomes[0]?.failureReason).toContain('quantum-blockchain');
    expect(evalRun.summary?.successRate).toBe(0);
  });
});
