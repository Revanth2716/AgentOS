import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSpec, WorkflowSpec } from '@agentos/shared';
import { nullLogger } from '@agentos/observability';
import { WorkflowEngine, validateGraph, interpolate } from '../src/index.js';
import { makeHarness, waitForPendingApproval, type Harness } from '../../runtime/tests/harness.js';

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

const agentSpec = (name: string, model: string, over: Partial<AgentSpec> = {}): AgentSpec => ({
  name,
  description: `${name} demo agent`,
  model,
  tools: ['corpus.search', 'corpus.read', 'calculator'],
  permissions: [],
  policies: {
    mode: 'allowlist',
    allowed: ['corpus.*', 'calculator'],
    denied: [],
    requireApproval: [],
    rateLimits: {},
  },
  limits: { maxSteps: 10, maxRuntimeMs: 30_000, maxCostUsd: 0.5, toolTimeoutMs: 5_000, maxRetries: 1 },
  enabled: true,
  ...over,
});

function engineFor(h: Harness): WorkflowEngine {
  return new WorkflowEngine({
    db: h.db,
    bus: h.bus,
    metrics: h.metrics,
    runtime: h.runtime,
    approvals: h.approvals,
    logger: nullLogger,
  });
}

describe('validateGraph', () => {
  it('accepts a valid DAG and returns topo order', () => {
    const spec: WorkflowSpec = {
      nodes: [
        { id: 'input', type: 'input' },
        { id: 'a', type: 'agent', agentId: 'agt_1' },
        { id: 'out', type: 'output' },
      ],
      edges: [
        { from: 'input', to: 'a' },
        { from: 'a', to: 'out' },
      ],
    };
    const v = validateGraph(spec);
    expect(v.order).toEqual(['input', 'a', 'out']);
    expect(v.entry).toEqual(['input']);
    expect(v.exit).toEqual(['out']);
  });

  it('rejects cycles, unknown refs, self-edges, and agent nodes without agentId', () => {
    expect(() =>
      validateGraph({
        nodes: [
          { id: 'a', type: 'agent', agentId: 'x' },
          { id: 'b', type: 'agent', agentId: 'y' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      }),
    ).toThrow(/cycle/);
    expect(() =>
      validateGraph({ nodes: [{ id: 'a', type: 'input' }], edges: [{ from: 'a', to: 'ghost' }] }),
    ).toThrow(/unknown node/);
    expect(() => validateGraph({ nodes: [{ id: 'a', type: 'input' }], edges: [{ from: 'a', to: 'a' }] })).toThrow(
      /self-edge/,
    );
    expect(() => validateGraph({ nodes: [{ id: 'a', type: 'agent' }], edges: [] })).toThrow(/missing agentId/);
  });
});

describe('interpolate', () => {
  it('substitutes {{node.output}} placeholders with string or JSON values', () => {
    expect(interpolate('Summarize: {{research.output}}', { research: 'finding A' })).toBe('Summarize: finding A');
    const json = interpolate('{{research.output}}', { research: { n: 1 } });
    expect(json).toContain('"n": 1');
    expect(() => interpolate('{{missing.output}}', {})).toThrow(/unknown upstream/);
  });
});

describe('WorkflowEngine', () => {
  it('runs a multi-agent chain to completion with node records', async () => {
    const h = newHarness();
    const researcher = h.db.agents.create(agentSpec('researcher', 'mock/researcher'));
    const evaluator = h.db.agents.create(agentSpec('evaluator', 'mock/evaluator'));
    const wf = h.db.workflows.create({
      name: 'chain',
      description: 'research then evaluate',
      graph: {
        nodes: [
          { id: 'input', type: 'input' },
          { id: 'research', type: 'agent', agentId: researcher.id },
          { id: 'evaluate', type: 'agent', agentId: evaluator.id, inputTemplate: 'Evaluate this output:\n{{research.output}}' },
          { id: 'out', type: 'output' },
        ],
        edges: [
          { from: 'input', to: 'research' },
          { from: 'research', to: 'evaluate' },
          { from: 'evaluate', to: 'out' },
        ],
      },
    });
    const engine = engineFor(h);
    const start = engine.start(wf.id, { task: 'Find three facts about agents' });
    expect(start.status).toBe('queued');
    const done = await engine.waitFor(start.id);

    expect(done.status).toBe('completed');
    const nodeRuns = h.db.workflows.nodeRunsForWorkflowRun(start.id);
    expect(nodeRuns.map((n) => `${n.nodeId}:${n.status}`)).toEqual([
      'input:completed',
      'research:completed',
      'evaluate:completed',
      'out:completed',
    ]);
    // agent nodes link to their child runs
    const researchNode = nodeRuns.find((n) => n.nodeId === 'research');
    expect(researchNode?.runId).toMatch(/^run_/);
    const childRun = h.db.runs.get(researchNode?.runId as string);
    expect(childRun?.status).toBe('completed');
    expect(childRun?.workflowRunId).toBe(start.id);
    expect(done.output).toBeTruthy();
  });

  it('pauses at an approval gate and resumes on approve', async () => {
    const h = newHarness();
    const agent = h.db.agents.create(agentSpec('researcher', 'mock/researcher'));
    const wf = h.db.workflows.create({
      name: 'gated',
      description: '',
      graph: {
        nodes: [
          { id: 'input', type: 'input' },
          { id: 'work', type: 'agent', agentId: agent.id },
          { id: 'gate', type: 'approval', label: 'Publish results?' },
          { id: 'out', type: 'output' },
        ],
        edges: [
          { from: 'input', to: 'work' },
          { from: 'work', to: 'gate' },
          { from: 'gate', to: 'out' },
        ],
      },
    });
    const engine = engineFor(h);
    const start = engine.start(wf.id, { task: 'Find three facts about agents' });

    const approvalId = await waitForPendingApproval(h.db, start.id);
    const paused = h.db.workflows.getRun(start.id);
    expect(paused?.status).toBe('waiting_approval');

    h.approvals.decide(approvalId, 'approved');
    const done = await engine.waitFor(start.id);
    expect(done.status).toBe('completed');
    const gate = h.db.workflows.nodeRunsForWorkflowRun(start.id).find((n) => n.nodeId === 'gate');
    expect(gate?.status).toBe('completed');
  });

  it('fails the workflow when an approval gate is denied', async () => {
    const h = newHarness();
    const agent = h.db.agents.create(agentSpec('researcher', 'mock/researcher'));
    const wf = h.db.workflows.create({
      name: 'denied-gate',
      description: '',
      graph: {
        nodes: [
          { id: 'input', type: 'input' },
          { id: 'work', type: 'agent', agentId: agent.id },
          { id: 'gate', type: 'approval' },
          { id: 'out', type: 'output' },
        ],
        edges: [
          { from: 'input', to: 'work' },
          { from: 'work', to: 'gate' },
          { from: 'gate', to: 'out' },
        ],
      },
    });
    const engine = engineFor(h);
    const start = engine.start(wf.id, { task: 'Find three facts about agents' });
    const approvalId = await waitForPendingApproval(h.db, start.id);
    h.approvals.decide(approvalId, 'denied');
    const done = await engine.waitFor(start.id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('denied workflow gate');
    const nodes = h.db.workflows.nodeRunsForWorkflowRun(start.id);
    expect(nodes.find((n) => n.nodeId === 'gate')?.status).toBe('failed');
    expect(nodes.find((n) => n.nodeId === 'out')?.status).toBe('skipped');
  });

  it('fails fast when an agent node fails and skips downstream nodes', async () => {
    const h = newHarness();
    // Agent whose policy allows nothing → run fails on max steps? No: denial is
    // not failure. Use a disabled-agnostic hard failure: reference a missing agent.
    const wf = h.db.workflows.create({
      name: 'broken',
      description: '',
      graph: {
        nodes: [
          { id: 'input', type: 'input' },
          { id: 'boom', type: 'agent', agentId: 'agt_does_not_exist' },
          { id: 'after', type: 'agent', agentId: 'agt_missing_too' },
          { id: 'out', type: 'output' },
        ],
        edges: [
          { from: 'input', to: 'boom' },
          { from: 'boom', to: 'after' },
          { from: 'after', to: 'out' },
        ],
      },
    });
    const engine = engineFor(h);
    const start = engine.start(wf.id, { task: 'x' });
    const done = await engine.waitFor(start.id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('missing agent');
    const nodes = h.db.workflows.nodeRunsForWorkflowRun(start.id);
    expect(nodes.find((n) => n.nodeId === 'boom')?.status).toBe('failed');
    expect(nodes.find((n) => n.nodeId === 'after')?.status).toBe('skipped');
  });

  it('runs independent branches in parallel', async () => {
    const h = newHarness();
    const a = h.db.agents.create(agentSpec('branch-a', 'mock/researcher'));
    const b = h.db.agents.create(agentSpec('branch-b', 'mock/researcher'));
    const wf = h.db.workflows.create({
      name: 'parallel',
      description: '',
      graph: {
        nodes: [
          { id: 'input', type: 'input' },
          { id: 'left', type: 'agent', agentId: a.id },
          { id: 'right', type: 'agent', agentId: b.id },
          { id: 'out', type: 'output' },
        ],
        edges: [
          { from: 'input', to: 'left' },
          { from: 'input', to: 'right' },
          { from: 'left', to: 'out' },
          { from: 'right', to: 'out' },
        ],
      },
    });
    const engine = engineFor(h);
    const start = engine.start(wf.id, { task: 'Find three facts about agents' });
    const done = await engine.waitFor(start.id);
    expect(done.status).toBe('completed');
    const nodes = h.db.workflows.nodeRunsForWorkflowRun(start.id);
    expect(nodes.filter((n) => n.status === 'completed')).toHaveLength(4);
    const outNode = nodes.find((n) => n.nodeId === 'out');
    const output = outNode?.output as { outputs: Record<string, unknown> };
    expect(output.outputs.left).toBeTruthy();
    expect(output.outputs.right).toBeTruthy();
  });

  it('refuses to start a workflow with an invalid graph', () => {
    const h = newHarness();
    const wf = h.db.workflows.create({
      name: 'cyclic',
      description: '',
      graph: {
        nodes: [
          { id: 'a', type: 'input' },
          { id: 'b', type: 'output' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      },
    });
    const engine = engineFor(h);
    expect(() => engine.start(wf.id, {})).toThrow(/cycle/);
  });
});
