import type { AgentDatabase, WorkflowRun, WorkflowNodeRun } from '@agentos/database';
import type { EventBus } from '@agentos/shared';
import { NotFoundError, ValidationError, randomSeed } from '@agentos/shared';
import type { AgentRuntime, ApprovalService } from '@agentos/runtime';
import type { AppMetrics, Logger } from '@agentos/observability';
import { validateGraph, predecessors, interpolate, type GraphValidation } from './graph.js';

export interface WorkflowEngineDeps {
  db: AgentDatabase;
  bus: EventBus;
  metrics: AppMetrics;
  runtime: AgentRuntime;
  approvals: ApprovalService;
  logger: Logger;
}

interface InflightWorkflow {
  controller: AbortController;
  startedRuns: Set<string>;
  done: Promise<WorkflowRun>;
}

/**
 * Multi-agent workflow executor.
 *
 * Nodes run in dependency order (Kahn scheduling — independent nodes run in
 * parallel). Node types: input, agent (runs an agent to completion), approval
 * (suspends on an operator gate), output (collects results). Workflow states:
 * queued → running → (waiting_approval) → completed | failed | cancelled.
 */
export class WorkflowEngine {
  private readonly inflight = new Map<string, InflightWorkflow>();

  constructor(private readonly deps: WorkflowEngineDeps) {}

  start(workflowId: string, input: Record<string, unknown>): WorkflowRun {
    const workflow = this.deps.db.workflows.get(workflowId);
    if (!workflow) throw new NotFoundError('workflow', workflowId);
    if (!workflow.enabled) throw new ValidationError(`workflow is disabled: ${workflow.name}`);
    validateGraph(workflow.graph);

    const wfRun = this.deps.db.workflows.createRun({ workflowId, input });
    const controller = new AbortController();
    const startedRuns = new Set<string>();
    const done = this.execute(wfRun.id, controller.signal, startedRuns).catch(async (e) => {
      this.deps.logger.error({ workflowRunId: wfRun.id, error: (e as Error).message }, 'workflow crashed');
      const cur = this.deps.db.workflows.getRun(wfRun.id);
      if (cur && !['completed', 'failed', 'cancelled'].includes(cur.status)) {
        this.emit('workflow_failed', wfRun.id, { error: (e as Error).message });
        return this.deps.db.workflows.updateRun(wfRun.id, {
          status: 'failed',
          error: (e as Error).message,
          endedAt: Date.now(),
        });
      }
      return cur as WorkflowRun;
    });
    this.inflight.set(wfRun.id, { controller, startedRuns, done });
    void done.finally(() => this.inflight.delete(wfRun.id));
    return wfRun;
  }

  async waitFor(workflowRunId: string): Promise<WorkflowRun> {
    const entry = this.inflight.get(workflowRunId);
    if (entry) return entry.done;
    const run = this.deps.db.workflows.getRun(workflowRunId);
    if (!run) throw new NotFoundError('workflow run', workflowRunId);
    return run;
  }

  cancel(workflowRunId: string): WorkflowRun {
    const entry = this.inflight.get(workflowRunId);
    const run = this.deps.db.workflows.getRun(workflowRunId);
    if (!run) throw new NotFoundError('workflow run', workflowRunId);
    if (entry) {
      entry.controller.abort();
      for (const runId of entry.startedRuns) {
        try {
          this.deps.runtime.cancel(runId);
        } catch {
          // run may have finished already
        }
      }
    } else if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
      return this.deps.db.workflows.updateRun(workflowRunId, { status: 'cancelled', error: 'cancelled', endedAt: Date.now() });
    }
    return run;
  }

  private emit(type: string, workflowRunId: string, data: Record<string, unknown>, nodeId?: string): void {
    this.deps.bus.publish({
      topic: 'workflow',
      type,
      ts: Date.now(),
      entityId: workflowRunId,
      data: { workflowRunId, ...(nodeId ? { nodeId } : {}), ...data },
    });
  }

  private async execute(
    workflowRunId: string,
    signal: AbortSignal,
    startedRuns: Set<string>,
  ): Promise<WorkflowRun> {
    const { db } = this.deps;
    const wfRun = db.workflows.getRun(workflowRunId) as WorkflowRun;
    const workflow = db.workflows.get(wfRun.workflowId) as NonNullable<ReturnType<AgentDatabase['workflows']['get']>>;
    const spec = workflow.graph;
    const validation: GraphValidation = validateGraph(spec);
    const pred = predecessors(spec);

    db.workflows.updateRun(workflowRunId, { status: 'running', startedAt: Date.now(), currentNodes: validation.entry });
    this.emit('workflow_started', workflowRunId, { workflow: workflow.name, input: wfRun.input });

    const outputs: Record<string, unknown> = {};
    const done = new Set<string>();
    const skipped = new Set<string>();
    const started = new Set<string>();
    const running = new Map<string, Promise<void>>();
    let failure: string | null = null;

    const markNode = (
      node: string,
      status: WorkflowNodeRun['status'],
      extra: { output?: unknown; error?: string | null; runId?: string | null; agentId?: string | null } = {},
    ): void => {
      db.workflows.upsertNodeRun({
        workflowRunId,
        nodeId: node,
        status,
        startedAt: Date.now(),
        endedAt: ['completed', 'failed', 'skipped'].includes(status) ? Date.now() : null,
        output: extra.output,
        error: extra.error ?? null,
        runId: extra.runId ?? null,
        agentId: extra.agentId ?? null,
      });
    };

    const runNode = async (nodeId: string): Promise<void> => {
      const node = spec.nodes.find((n) => n.id === nodeId);
      if (!node) throw new ValidationError(`unknown node: ${nodeId}`);
      this.emit('workflow_node_started', workflowRunId, { nodeType: node.type }, nodeId);

      try {
        if (signal.aborted) throw new Error('workflow cancelled');

        if (node.type === 'input') {
          outputs[nodeId] = typeof wfRun.input.task === 'string' ? wfRun.input.task : wfRun.input;
          markNode(nodeId, 'completed', { output: outputs[nodeId] });
        } else if (node.type === 'agent') {
          const agent = db.agents.get(node.agentId as string);
          if (!agent) throw new ValidationError(`node "${nodeId}" references missing agent ${node.agentId}`);
          const task = node.inputTemplate
            ? interpolate(node.inputTemplate, outputs)
            : defaultTask(outputs, wfRun.input);
          const run = this.deps.runtime.start({
            agent,
            task,
            workflowRunId,
            workflowInput: outputs,
            seed: randomSeed(),
          });
          startedRuns.add(run.id);
          markNode(nodeId, 'running', { runId: run.id, agentId: agent.id });
          const finished = await this.waitOrAbort(this.deps.runtime.waitFor(run.id), signal);
          if (finished.status === 'cancelled') throw new Error('workflow cancelled');
          if (finished.status !== 'completed') {
            throw new ValidationError(
              `agent node "${nodeId}" (${agent.name}) ${finished.status}: ${finished.error ?? 'no result'}`,
            );
          }
          outputs[nodeId] = finished.finalResult ?? '';
          markNode(nodeId, 'completed', { output: outputs[nodeId], runId: run.id, agentId: agent.id });
        } else if (node.type === 'approval') {
          const upstream = pred.get(nodeId)?.[0];
          const { approval, decided } = this.deps.approvals.request({
            workflowRunId,
            tool: 'workflow.gate',
            args: { nodeId, workflowRunId },
            summary: node.label ?? `Workflow gate at node "${nodeId}"`,
            reason: 'workflow approval gate',
            kind: 'workflow_gate',
          });
          db.workflows.updateRun(workflowRunId, { status: 'waiting_approval', currentNodes: [nodeId] });
          this.emit('approval_requested', workflowRunId, {
            approvalId: approval.id,
            summary: approval.summary,
            reason: approval.reason,
          }, nodeId);
          const verdict = await this.waitOrAbort(decided, signal);
          if (verdict.status === 'denied') {
            throw new ValidationError(`operator denied workflow gate at node "${nodeId}"`);
          }
          this.emit('approval_granted', workflowRunId, { approvalId: approval.id, decidedBy: verdict.decidedBy }, nodeId);
          outputs[nodeId] = upstream ? outputs[upstream] : wfRun.input;
          markNode(nodeId, 'completed', { output: outputs[nodeId] });
          db.workflows.updateRun(workflowRunId, { status: 'running', currentNodes: [] });
        } else if (node.type === 'output') {
          outputs[nodeId] = { task: wfRun.input, outputs: { ...outputs } };
          markNode(nodeId, 'completed', { output: outputs[nodeId] });
        }
        done.add(nodeId);
        this.emit('workflow_node_completed', workflowRunId, {}, nodeId);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === 'workflow cancelled') {
          markNode(nodeId, 'failed', { error: 'cancelled' });
          skipped.add(nodeId);
          failure = failure ?? 'workflow cancelled';
          return;
        }
        markNode(nodeId, 'failed', { error: msg });
        this.emit('workflow_node_failed', workflowRunId, { error: msg }, nodeId);
        failure = failure ?? msg;
      }
    };

    // Kahn-style scheduling with parallelism for independent nodes. Fail-fast:
    // once any node fails the workflow fails and remaining nodes are skipped.
    for (;;) {
      for (const node of spec.nodes) {
        if (started.has(node.id) || skipped.has(node.id)) continue;
        const preds = pred.get(node.id) ?? [];
        const upstreamFailed =
          preds.some((p) => skipped.has(p)) || (failure !== null && preds.some((p) => !done.has(p)));
        if (upstreamFailed) {
          skipped.add(node.id);
          markNode(node.id, 'skipped', { error: 'upstream node failed' });
          continue;
        }
        if (!failure && preds.every((p) => done.has(p))) {
          started.add(node.id);
          const p = runNode(node.id).finally(() => running.delete(node.id));
          running.set(node.id, p);
        }
      }
      if (failure) {
        await Promise.allSettled([...running.values()]);
        break;
      }
      if (running.size === 0) break;
      await Promise.race([...running.values()]);
    }
    await Promise.allSettled([...running.values()]);

    const status = failure
      ? failure === 'workflow cancelled'
        ? 'cancelled'
        : 'failed'
      : 'completed';
    db.workflows.updateRun(workflowRunId, {
      status,
      output: status === 'completed' ? pickOutput(spec, outputs) : null,
      error: failure,
      currentNodes: [],
      endedAt: Date.now(),
    });
    if (status === 'completed') this.emit('workflow_completed', workflowRunId, { outputs: Object.keys(outputs) });
    else if (status === 'cancelled') this.emit('workflow_cancelled', workflowRunId, { error: failure });
    else this.emit('workflow_failed', workflowRunId, { error: failure });
    return db.workflows.getRun(workflowRunId) as WorkflowRun;
  }

  private async waitOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new Error('workflow cancelled');
    let onAbort: (() => void) | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error('workflow cancelled'));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
}

function defaultTask(outputs: Record<string, unknown>, input: Record<string, unknown>): string {
  const inputNode = Object.entries(outputs).find(([k]) => k === 'input');
  if (inputNode && typeof inputNode[1] === 'string') return inputNode[1];
  const upstream = Object.entries(outputs).filter(([k]) => k !== 'input');
  if (upstream.length === 0) return typeof input.task === 'string' ? input.task : JSON.stringify(input);
  return upstream
    .map(([k, v]) => `## ${k}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)
    .join('\n\n');
}

function pickOutput(spec: { nodes: { id: string; type: string }[] }, outputs: Record<string, unknown>): unknown {
  const outputNode = spec.nodes.find((n) => n.type === 'output');
  if (outputNode) return outputs[outputNode.id];
  return outputs;
}
