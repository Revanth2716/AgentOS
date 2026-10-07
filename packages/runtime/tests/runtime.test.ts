import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentSpec } from '@agentos/shared';
import { replayRun } from '../src/index.js';
import { makeHarness, waitForPendingApproval, type Harness } from './harness.js';

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

const agentSpec = (over: Partial<AgentSpec> = {}): AgentSpec => ({
  name: 'tester',
  description: 'test agent',
  model: 'mock/researcher',
  tools: ['corpus.search', 'corpus.read'],
  permissions: [],
  policies: { mode: 'allowlist', allowed: ['corpus.*'], denied: [], requireApproval: [], rateLimits: {} },
  limits: { maxSteps: 10, maxRuntimeMs: 30_000, maxCostUsd: 0.5, toolTimeoutMs: 5_000, maxRetries: 2 },
  enabled: true,
  ...over,
});

describe('AgentRuntime bounded loop', () => {
  it('completes a research run: plan -> search -> reads -> final with full trace', async () => {
    const h = newHarness();
    const agent = h.db.agents.create(agentSpec());
    const run = h.runtime.start({ agent, task: 'Find three facts about agents', seed: 42 });
    const done = await h.runtime.waitFor(run.id);

    expect(done.status).toBe('completed');
    expect(done.finalResult).toBeTruthy();
    expect(done.finalResult).toContain('[doc-01]');
    expect(done.steps).toBeGreaterThanOrEqual(4);
    expect(done.toolCalls).toBeGreaterThanOrEqual(3);
    expect(done.costUsd).toBe(0);
    expect(done.mode).toBe('demo');

    const events = h.db.events.listForRun(run.id);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('task_received');
    expect(types).toContain('planning_started');
    expect(types).toContain('policy_check');
    expect(types).toContain('tool_called');
    expect(types).toContain('tool_completed');
    expect(types[types.length - 1]).toBe('run_completed');
    // seq numbers strictly increasing from 1
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

    // policy decisions persisted
    const decisions = h.db.decisions.listForRun(run.id);
    expect(decisions.length).toBeGreaterThanOrEqual(3);
    expect(decisions.every((d) => d.decision === 'allow')).toBe(true);
  });

  it('enforces maxSteps (never infinite)', async () => {
    const h = newHarness();
    const agent = h.db.agents.create(
      agentSpec({ name: 'bounded', model: 'mock/researcher', limits: { ...agentSpec().limits, maxSteps: 2 } }),
    );
    const run = h.runtime.start({ agent, task: 'task that cannot finish in 2 steps' });
    const done = await h.runtime.waitFor(run.id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('max steps exceeded');
    expect(done.steps).toBe(2);
    const events = h.db.events.listForRun(run.id);
    expect(events.at(-1)?.type).toBe('run_failed');
  });

  it('denies tools outside the agent allowlist and continues (observations, not crashes)', async () => {
    const h = newHarness();
    // Agent declares calculator but its policy allowlist omits it.
    const agent = h.db.agents.create(
      agentSpec({
        name: 'locked-down',
        model: 'mock/generic',
        tools: ['calculator'],
        permissions: [],
        policies: { mode: 'allowlist', allowed: [], denied: [], requireApproval: [], rateLimits: {} },
      }),
    );
    const run = h.runtime.start({ agent, task: 'do some math' });
    const done = await h.runtime.waitFor(run.id);
    expect(done.status).toBe('completed'); // denial is an observation, the run still terminates
    const decisions = h.db.decisions.listForRun(run.id);
    expect(decisions.some((d) => d.decision === 'deny')).toBe(true);
    const events = h.db.events.listForRun(run.id);
    expect(events.some((e) => e.type === 'policy_blocked')).toBe(true);
    expect(events.some((e) => e.type === 'tool_called')).toBe(false); // never executed
  });

  it('blocks missing permissions before policy evaluation', async () => {
    const h = newHarness();
    const agent = h.db.agents.create(
      agentSpec({
        name: 'no-fs',
        model: 'mock/generic',
        tools: ['fs.write'],
        permissions: [], // missing fs:write
        policies: { mode: 'allowlist', allowed: ['fs.write'], denied: [], requireApproval: [], rateLimits: {} },
      }),
    );
    const run = h.runtime.start({ agent, task: 'write a file' });
    const done = await h.runtime.waitFor(run.id);
    const decisions = h.db.decisions.listForRun(run.id);
    expect(decisions[0]?.decision).toBe('deny');
    expect(decisions[0]?.reason).toContain('missing permission');
    const workspace = path.join(h.paths.workspaceRoot, run.id);
    expect(fs.existsSync(path.join(workspace, 'x.txt'))).toBe(false);
  });

  it('rate limits repeated tool use per run', async () => {
    const h = newHarness();
    const agent = h.db.agents.create(
      agentSpec({
        name: 'limited',
        policies: {
          mode: 'allowlist',
          allowed: ['corpus.*'],
          denied: [],
          requireApproval: [],
          rateLimits: { 'corpus.read': 1 },
        },
      }),
    );
    const run = h.runtime.start({ agent, task: 'Find three facts about agents', seed: 7 });
    const done = await h.runtime.waitFor(run.id);
    expect(done.status).toBe('completed');
    const decisions = h.db.decisions.listForRun(run.id);
    expect(decisions.filter((d) => d.decision === 'rate_limited').length).toBeGreaterThanOrEqual(1);
    const events = h.db.events.listForRun(run.id);
    expect(events.some((e) => e.type === 'policy_rate_limited')).toBe(true);
    const executedReads = events.filter((e) => e.type === 'tool_completed' && e.tool === 'corpus.read');
    expect(executedReads.length).toBe(1);
  });
});

describe('human approval flow', () => {
  const approvalSpec = (decision: 'allow' | 'require_approval'): AgentSpec =>
    agentSpec({
      name: 'publisher',
      model: 'mock/finalizer',
      tools: ['report.write'],
      permissions: ['artifacts:write'],
      policies: {
        mode: 'allowlist',
        allowed: ['report.write'],
        denied: [],
        requireApproval: decision === 'require_approval' ? ['report.write'] : [],
        rateLimits: {},
      },
    });

  it('pauses on require_approval, resumes on Approve, writes artifact', async () => {
    const h = newHarness();
    const agent = h.db.agents.create(approvalSpec('require_approval'));
    const run = h.runtime.start({ agent, task: 'Publish the final research report' });

    // Run must suspend in waiting_approval.
    const approvalId = await waitForPendingApproval(h.db, run.id);
    const paused = h.db.runs.get(run.id);
    expect(paused?.status).toBe('waiting_approval');
    expect(paused?.pendingAction?.tool).toBe('report.write');
    expect(paused?.pendingAction?.approvalId).toBe(approvalId);

    // Operator approves — only path to proceed.
    h.approvals.decide(approvalId, 'approved', 'operator-test');
    const done = await h.runtime.waitFor(run.id);

    expect(done.status).toBe('completed');
    expect(done.pendingAction).toBeNull();
    const artifact = path.join(h.paths.artifactsDir, 'reports', 'research-report.md');
    expect(fs.existsSync(artifact)).toBe(true);

    const events = h.db.events.listForRun(run.id);
    const approvalIdx = events.findIndex((e) => e.type === 'approval_requested');
    const grantIdx = events.findIndex((e) => e.type === 'approval_granted');
    expect(approvalIdx).toBeGreaterThan(-1);
    expect(grantIdx).toBeGreaterThan(approvalIdx);
    expect(events.find((e) => e.type === 'tool_completed')?.tool).toBe('report.write');
    const approval = h.db.approvals.get(approvalId);
    expect(approval?.status).toBe('approved');
    expect(approval?.decidedBy).toBe('operator-test');
  });

  it('on Deny the tool never executes and the run still terminates cleanly', async () => {
    const h = newHarness();
    const agent = h.db.agents.create(approvalSpec('require_approval'));
    const run = h.runtime.start({ agent, task: 'Publish the final research report' });
    const approvalId = await waitForPendingApproval(h.db, run.id);
    h.approvals.decide(approvalId, 'denied', 'operator-test');
    const done = await h.runtime.waitFor(run.id);

    expect(done.status).toBe('completed');
    expect(fs.existsSync(path.join(h.paths.artifactsDir, 'reports', 'research-report.md'))).toBe(false);
    const events = h.db.events.listForRun(run.id);
    expect(events.some((e) => e.type === 'approval_denied')).toBe(true);
    expect(events.some((e) => e.type === 'tool_called')).toBe(false);
  });

  it('approval cannot be decided twice', async () => {
    const h = newHarness();
    const agent = h.db.agents.create(approvalSpec('require_approval'));
    const run = h.runtime.start({ agent, task: 'publish' });
    const approvalId = await waitForPendingApproval(h.db, run.id);
    h.approvals.decide(approvalId, 'denied');
    expect(() => h.approvals.decide(approvalId, 'approved')).toThrow(/already decided/);
    await h.runtime.waitFor(run.id);
  });
});

describe('retries', () => {
  it('retries transient failures and succeeds within bounds', async () => {
    const h = newHarness();
    let attempts = 0;
    h.registry.registerOrReplace({
      name: 'flaky',
      description: 'fails twice then succeeds',
      kind: 'compute',
      riskLevel: 'low',
      permissions: [],
      inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
      inputSchemaJson: { type: 'object' },
      timeoutMs: 5_000,
      maxRetries: 3,
      sampleInput: () => ({}),
      handler: async () => {
        attempts += 1;
        if (attempts < 3) return { ok: false, output: '', error: 'temporary glitch', errorKind: 'transient' };
        return { ok: true, output: 'recovered', data: { attempts } };
      },
    });
    const agent = h.db.agents.create(
      agentSpec({
        name: 'retryer',
        model: 'mock/generic',
        tools: ['flaky'],
        policies: { mode: 'allowlist', allowed: ['flaky'], denied: [], requireApproval: [], rateLimits: {} },
        limits: { ...agentSpec().limits, maxRetries: 3 },
      }),
    );
    const run = h.runtime.start({ agent, task: 'use the flaky tool' });
    const done = await h.runtime.waitFor(run.id);
    expect(done.status).toBe('completed');
    expect(attempts).toBe(3);
    expect(done.retries).toBe(2);
    const events = h.db.events.listForRun(run.id);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'tool_failed')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'tool_completed')).toHaveLength(1);
  });

  it('does not retry permanent failures', async () => {
    const h = newHarness();
    let attempts = 0;
    h.registry.registerOrReplace({
      name: 'broken',
      description: 'always permanent failure',
      kind: 'compute',
      riskLevel: 'low',
      permissions: [],
      inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
      inputSchemaJson: { type: 'object' },
      timeoutMs: 5_000,
      maxRetries: 3,
      sampleInput: () => ({}),
      handler: async () => {
        attempts += 1;
        return { ok: false, output: '', error: 'permanently broken', errorKind: 'permanent' };
      },
    });
    const agent = h.db.agents.create(
      agentSpec({
        name: 'no-retry',
        model: 'mock/generic',
        tools: ['broken'],
        policies: { mode: 'allowlist', allowed: ['broken'], denied: [], requireApproval: [], rateLimits: {} },
      }),
    );
    const run = h.runtime.start({ agent, task: 'try' });
    await h.runtime.waitFor(run.id);
    expect(attempts).toBe(1);
  });
});

describe('limits and cancellation', () => {
  it('enforces maxRuntimeMs', async () => {
    const h = newHarness();
    h.registry.registerOrReplace({
      name: 'slowpoke',
      description: 'sleeps past the runtime limit',
      kind: 'compute',
      riskLevel: 'low',
      permissions: [],
      inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
      inputSchemaJson: { type: 'object' },
      timeoutMs: 5_000,
      maxRetries: 0,
      sampleInput: () => ({}),
      handler: async () => {
        await new Promise((r) => setTimeout(r, 1_200));
        return { ok: true, output: 'done', data: {} };
      },
    });
    const agent = h.db.agents.create(
      agentSpec({
        name: 'slow',
        model: 'mock/generic',
        tools: ['slowpoke'],
        policies: { mode: 'allowlist', allowed: ['slowpoke'], denied: [], requireApproval: [], rateLimits: {} },
        limits: { ...agentSpec().limits, maxRuntimeMs: 1_000, maxSteps: 50 },
      }),
    );
    const run = h.runtime.start({ agent, task: 'take your time' });
    const done = await h.runtime.waitFor(run.id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('max runtime exceeded');
  }, 15_000);

  it('cancel() aborts a running run', async () => {
    const h = newHarness();
    h.registry.registerOrReplace({
      name: 'hang',
      description: 'aborts on signal',
      kind: 'compute',
      riskLevel: 'low',
      permissions: [],
      inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
      inputSchemaJson: { type: 'object' },
      timeoutMs: 10_000,
      maxRetries: 0,
      sampleInput: () => ({}),
      handler: async (_input, ctx) =>
        new Promise((resolve) => {
          const t = setTimeout(() => resolve({ ok: true, output: 'finished', data: {} }), 5_000);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve({ ok: false, output: '', error: 'cancelled', errorKind: 'permanent' });
          });
        }),
    });
    const agent = h.db.agents.create(
      agentSpec({
        name: 'cancellable',
        model: 'mock/generic',
        tools: ['hang'],
        policies: { mode: 'allowlist', allowed: ['hang'], denied: [], requireApproval: [], rateLimits: {} },
        limits: { ...agentSpec().limits, maxRuntimeMs: 20_000 },
      }),
    );
    const run = h.runtime.start({ agent, task: 'hang' });
    await new Promise((r) => setTimeout(r, 150));
    h.runtime.cancel(run.id);
    const done = await h.runtime.waitFor(run.id);
    expect(done.status).toBe('cancelled');
    const events = h.db.events.listForRun(run.id);
    expect(events.at(-1)?.type).toBe('run_cancelled');
  }, 10_000);
});

describe('replay', () => {
  it('replays a completed deterministic run identically', async () => {
    const h = newHarness();
    const agent = h.db.agents.create(agentSpec({ name: 'replayable' }));
    const run = h.runtime.start({ agent, task: 'Find three facts about agents', seed: 1234 });
    const first = await h.runtime.waitFor(run.id);
    expect(first.status).toBe('completed');

    const outcome = await replayRun(h.db, h.runtime, run.id);
    expect(outcome.identical).toBe(true);
    expect(outcome.differences).toEqual([]);
    expect(outcome.replayRunId).not.toBe(run.id);
    expect(outcome.replayRun.status).toBe('completed');
    expect(outcome.replayRun.finalResult).toBe(first.finalResult);

    // original untouched
    expect(h.db.runs.get(run.id)?.finalResult).toBe(first.finalResult);
  });

  it('refuses to replay non-completed runs', async () => {
    const h = newHarness();
    const agent = h.db.agents.create(agentSpec({ name: 'failed-replay' }));
    const run = h.runtime.start({ agent, task: 'x', seed: 1 });
    await h.runtime.waitFor(run.id);
    h.db.runs.update(run.id, { status: 'failed', error: 'synthetic' });
    await expect(replayRun(h.db, h.runtime, run.id)).rejects.toThrow(/only completed/);
  });
});

describe('provider fallback', () => {
  it('falls back to mock on provider failure and records the event', async () => {
    const h = makeHarnessFallback();
    const agent = h.db.agents.create(agentSpec({ name: 'degraded', model: 'cloudai/x' }));
    const run = h.runtime.start({ agent, task: 'Find three facts about agents', mode: 'demo', seed: 5 });
    const done = await h.runtime.waitFor(run.id);
    expect(done.status).toBe('completed');
    const events = h.db.events.listForRun(run.id);
    expect(events.some((e) => e.type === 'provider_fallback')).toBe(true);
  });
});

// Small helper indirection kept local to keep the harness simple.
import { ProviderRegistry } from '@agentos/model-providers';
import type { ModelProvider } from '@agentos/model-providers';

function makeHarnessFallback(): Harness {
  class AlwaysFailing implements ModelProvider {
    name = 'cloudai';
    locality = 'cloud' as const;
    supports(ref: string): boolean {
      return ref.startsWith('cloudai/');
    }
    metadata() {
      return { name: this.name, locality: this.locality, defaultModel: 'x', contextWindow: 0, supportsStream: false, pricing: null };
    }
    async generate(): Promise<never> {
      throw new Error('simulated outage');
    }
  }
  harness?.cleanup();
  harness = makeHarness({ providers: new ProviderRegistry([new AlwaysFailing()]) });
  return harness;
}
