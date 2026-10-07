import fs from 'node:fs';
import path from 'node:path';
import type { AgentDatabase, Agent, Run } from '@agentos/database';
import {
  NotFoundError,
  ValidationError,
  fnv1a,
  randomSeed,
  type EventBus,
} from '@agentos/shared';
import type { ModelMessage } from '@agentos/model-providers';
import { evaluatePolicy, type PolicyRuleEntity } from '@agentos/policy-engine';
import type { ToolRegistry, ToolDefinition, ToolResult } from '@agentos/tool-registry';
import type { ProviderRegistry } from '@agentos/model-providers';
import { newTraceId, type AppMetrics, type Logger } from '@agentos/observability';
import { EventRecorder } from './events.js';
import { ApprovalService } from './approvals.js';

export interface RuntimePaths {
  /** Root for per-run workspaces: <workspaceRoot>/<runId> */
  workspaceRoot: string;
  /** Shared directory approval-gated tools publish into. */
  artifactsDir: string;
}

export interface RuntimeDeps {
  db: AgentDatabase;
  bus: EventBus;
  metrics: AppMetrics;
  registry: ToolRegistry;
  providers: ProviderRegistry;
  approvals: ApprovalService;
  /** Stored (global/agent-scoped) policy rules for the agent name. */
  storedRulesFor(agentName: string): PolicyRuleEntity[];
  logger: Logger;
  paths: RuntimePaths;
}

export interface StartRunOptions {
  agent: Agent;
  task: string;
  mode?: 'demo' | 'live';
  seed?: number;
  workflowRunId?: string | null;
  workflowInput?: Record<string, unknown>;
  /** Set when this run is a replay of another run. */
  replayOf?: string;
}

const OBSERVATION_MAX = 4_000;

function truncate(s: string, max = OBSERVATION_MAX): string {
  return s.length <= max ? s : `${s.slice(0, max)}… [+${s.length - max} chars]`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(e as Error);
      },
    );
  });
}

interface Inflight {
  controller: AbortController;
  done: Promise<Run>;
}

/**
 * Bounded agent execution loop:
 *
 *   TASK → PLAN → TOOL CALL → OBSERVE → DECIDE → … → FINAL RESULT
 *
 * Every transition is persisted as a run event. Hard bounds (maxSteps,
 * maxRuntimeMs, maxCostUsd, tool timeouts) guarantee termination. All tool
 * calls pass through the policy engine; require_approval suspends the loop
 * on an operator decision that only the ApprovalService can resolve.
 */
export class AgentRuntime {
  private readonly inflight = new Map<string, Inflight>();

  constructor(private readonly deps: RuntimeDeps) {}

  /** Creates the run record and starts execution in the background. */
  start(opts: StartRunOptions): Run {
    const { agent, db } = { agent: opts.agent, db: this.deps.db };
    if (!agent.enabled) throw new ValidationError(`agent is disabled: ${agent.name}`);
    const mode = opts.mode ?? (agent.model.startsWith('mock/') ? 'demo' : 'live');
    const seed = opts.seed ?? randomSeed();
    const run = db.runs.create({
      agentId: agent.id,
      workflowRunId: opts.workflowRunId ?? null,
      task: opts.task,
      mode,
      seed,
      provider: agent.model.split('/')[0] ?? 'mock',
      model: agent.model,
      agentSnapshot: agent,
      traceId: newTraceId(),
    });
    this.deps.metrics.runsActive.set({}, db.runs.active().length);

    const controller = new AbortController();
    const done = this.execute(run.id, opts, controller.signal).catch((e) => {
      this.deps.logger.error({ runId: run.id, error: (e as Error).message }, 'run crashed');
      return this.finishCrashed(run.id, e as Error);
    });
    this.inflight.set(run.id, { controller, done });
    void done.finally(() => this.inflight.delete(run.id));
    return db.runs.get(run.id) as Run;
  }

  async waitFor(runId: string): Promise<Run> {
    const entry = this.inflight.get(runId);
    if (entry) return entry.done;
    const run = this.deps.db.runs.get(runId);
    if (!run) throw new NotFoundError('run', runId);
    return run;
  }

  cancel(runId: string): Run {
    const entry = this.inflight.get(runId);
    const run = this.deps.db.runs.get(runId);
    if (!run) throw new NotFoundError('run', runId);
    entry?.controller.abort();
    if (!entry && ['queued', 'waiting_approval', 'paused', 'running'].includes(run.status)) {
      return this.deps.db.runs.update(runId, {
        status: 'cancelled',
        error: 'cancelled',
        endedAt: Date.now(),
        pendingAction: null,
      });
    }
    return run;
  }

  isInflight(runId: string): boolean {
    return this.inflight.has(runId);
  }

  activeCount(): number {
    return this.inflight.size;
  }

  private async finishCrashed(runId: string, err: Error): Promise<Run> {
    const db = this.deps.db;
    const run = db.runs.get(runId);
    if (!run || ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
      return run as Run;
    }
    const rec = this.recorder(run);
    rec.emit('run_failed', { error: err.message }, { status: 'error' });
    this.deps.metrics.runsTotal.inc({ status: 'failed' });
    return db.runs.update(runId, {
      status: 'failed',
      error: err.message,
      endedAt: Date.now(),
      pendingAction: null,
    });
  }

  private recorder(run: Run): EventRecorder {
    return new EventRecorder(
      this.deps.db,
      this.deps.bus,
      this.deps.metrics,
      run.id,
      run.traceId ?? '0',
      run.agentId,
    );
  }

  private async execute(runId: string, opts: StartRunOptions, signal: AbortSignal): Promise<Run> {
    const { db, registry, providers, approvals, metrics, logger, paths } = this.deps;
    const run0 = db.runs.get(runId) as Run;
    const agent = opts.agent;
    const rec = this.recorder(run0);

    // Per-run workspace (sandboxed fs tools operate here).
    const workspaceDir = path.join(paths.workspaceRoot, runId);
    fs.mkdirSync(workspaceDir, { recursive: true });

    const startedAt = Date.now();
    db.runs.update(runId, { status: 'running', startedAt, pendingAction: null });
    rec.emit('task_received', {
      task: run0.task,
      mode: run0.mode,
      seed: run0.seed,
      model: agent.model,
      limits: agent.limits,
      ...(opts.replayOf ? { replayOf: opts.replayOf } : {}),
      ...(opts.workflowRunId ? { workflowRunId: opts.workflowRunId } : {}),
    });
    metrics.runsTotal.inc({ status: 'started' });

    const messages: ModelMessage[] = [{ role: 'user', content: run0.task }];
    const callCounts: Record<string, number> = {};
    let steps = 0;
    let toolCalls = 0;
    let toolFailures = 0;
    let retries = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    let finalResult: string | null = null;

    const storedRules = this.deps.storedRulesFor(agent.name);
    const limits = agent.limits;

    const fail = (error: string): Run => {
      rec.emit('run_failed', { error, steps }, { status: 'error' });
      metrics.runsTotal.inc({ status: 'failed' });
      metrics.runDuration.observe({}, (Date.now() - startedAt) / 1000);
      metrics.runsActive.set({}, db.runs.active().length);
      return db.runs.update(runId, {
        status: 'failed',
        error,
        steps,
        toolCalls,
        toolFailures,
        retries,
        tokensIn,
        tokensOut,
        costUsd,
        finalResult,
        endedAt: Date.now(),
        pendingAction: null,
      });
    };

    // ── Bounded loop ────────────────────────────────────────────────────────
    for (;;) {
      if (signal.aborted) {
        rec.emit('run_cancelled', { steps }, { status: 'error' });
        metrics.runsTotal.inc({ status: 'cancelled' });
        metrics.runDuration.observe({}, (Date.now() - startedAt) / 1000);
        metrics.runsActive.set({}, db.runs.active().length);
        return db.runs.update(runId, {
          status: 'cancelled',
          error: 'cancelled by operator',
          steps,
          toolCalls,
          retries,
          endedAt: Date.now(),
          pendingAction: null,
        });
      }
      if (steps >= limits.maxSteps) {
        return fail(`max steps exceeded (limit ${limits.maxSteps})`);
      }
      if (Date.now() - startedAt > limits.maxRuntimeMs) {
        return fail(`max runtime exceeded (limit ${limits.maxRuntimeMs}ms)`);
      }

      steps += 1;
      // 1) PLAN / DECIDE via model provider
      rec.emit('model_called', { step: steps, modelRef: agent.model }, { status: 'pending' });
      const modelStart = Date.now();
      const outcome = await providers.generateWithFallback(
        {
          system: buildSystemPrompt(agent),
          messages,
          modelRef: agent.model,
          allowedTools: registry
            .resolveForAgent(agent)
            .map((t) => ({ name: t.name, description: t.description, inputSchemaJson: t.inputSchemaJson, sampleInput: () => t.sampleInput() })),
          seed: run0.seed,
          workflowInput: opts.workflowInput,
        },
        signal,
        agent.model,
      );
      const modelMs = Date.now() - modelStart;
      const result = outcome.result;
      tokensIn += result.usage.tokensIn;
      tokensOut += result.usage.tokensOut;
      costUsd = Math.round((costUsd + outcome.cost.usd) * 1_000_000) / 1_000_000;

      const locality = outcome.fellBack
        ? 'mock'
        : providers.resolve(agent.model).provider.locality;
      if (result.usage.tokensIn || result.usage.tokensOut) {
        db.costs.add({
          runId,
          provider: outcome.usedProvider,
          model: result.model,
          tokensIn: result.usage.tokensIn,
          tokensOut: result.usage.tokensOut,
          estCostUsd: outcome.cost.usd,
          locality,
        });
        metrics.modelTokens.inc({ provider: outcome.usedProvider, direction: 'in' }, result.usage.tokensIn);
        metrics.modelTokens.inc({ provider: outcome.usedProvider, direction: 'out' }, result.usage.tokensOut);
        metrics.estCostUsd.inc({}, Math.round(outcome.cost.usd * 1_000_000));
      }

      rec.emit(
        'model_completed',
        {
          step: steps,
          action: result.action.kind,
          provider: outcome.usedProvider,
          model: result.model,
          locality,
          tokensIn: result.usage.tokensIn,
          tokensOut: result.usage.tokensOut,
          costUsd: outcome.cost.usd,
          elapsedMs: modelMs,
          ...(outcome.fellBack ? { fallback: outcome.fallbackReason } : {}),
        },
        { durationMs: modelMs, status: 'ok' },
      );
      if (outcome.fellBack) {
        rec.emit('provider_fallback', { modelRef: agent.model, reason: outcome.fallbackReason });
      }
      if (costUsd > limits.maxCostUsd) {
        return fail(`max cost exceeded ($${costUsd} > $${limits.maxCostUsd})`);
      }

      const action = result.action;

      if (action.kind === 'plan') {
        rec.emit('planning_started', { step: steps });
        messages.push({ role: 'assistant', content: JSON.stringify(action) });
        rec.emit('planning_completed', { plan: truncate(action.text) });
        rec.emit('step_completed', { step: steps, of: limits.maxSteps });
        continue;
      }

      if (action.kind === 'final') {
        finalResult = action.result;
        messages.push({ role: 'assistant', content: JSON.stringify(action) });
        rec.emit('run_completed', {
          steps,
          toolCalls,
          durationMs: Date.now() - startedAt,
          result: truncate(action.result, 8_000),
          costUsd,
        }, { status: 'ok' });
        metrics.runsTotal.inc({ status: 'completed' });
        metrics.runDuration.observe({}, (Date.now() - startedAt) / 1000);
        metrics.runsActive.set({}, db.runs.active().length);
        return db.runs.update(runId, {
          status: 'completed',
          steps,
          toolCalls,
          toolFailures,
          retries,
          tokensIn,
          tokensOut,
          costUsd,
          finalResult,
          endedAt: Date.now(),
          pendingAction: null,
        });
      }

      // 2) TOOL CALL
      const { call } = action;
      messages.push({ role: 'assistant', content: JSON.stringify(action) });
      const tool = registry.get(call.name);

      // 2a) tool must be registered
      if (!tool) {
        rec.emit('policy_check', { tool: call.name, decision: 'deny', reason: 'tool not registered' }, { tool: call.name });
        metrics.policyDecisions.inc({ decision: 'deny' });
        db.decisions.record({ runId, agentId: agent.id, tool: call.name, decision: 'deny', reason: 'tool not registered' });
        rec.emit('policy_blocked', { tool: call.name, reason: 'tool not registered' }, { tool: call.name, status: 'error' });
        messages.push(toolEnvelope(call.name, call.args, { ok: false, error: 'tool not registered', errorKind: 'permanent', output: '' }));
        rec.emit('step_completed', { step: steps, of: limits.maxSteps });
        continue;
      }

      // 2b) permission check (defense in depth — independent of policy)
      const permCheck = registry.checkPermissions(agent.permissions, tool);
      if (!permCheck.ok) {
        const reason = `missing permission(s): ${permCheck.missing.join(', ')}`;
        db.decisions.record({ runId, agentId: agent.id, tool: tool.name, decision: 'deny', reason });
        rec.emit('policy_check', { tool: tool.name, decision: 'deny', reason }, { tool: tool.name });
        metrics.policyDecisions.inc({ decision: 'deny' });
        rec.emit('policy_blocked', { tool: tool.name, reason }, { tool: tool.name, status: 'error' });
        messages.push(toolEnvelope(tool.name, call.args, { ok: false, error: reason, errorKind: 'permanent', output: '' }));
        rec.emit('step_completed', { step: steps, of: limits.maxSteps });
        continue;
      }

      // 2c) policy decision
      const decision = evaluatePolicy({
        tool: tool.name,
        agentPolicies: agent.policies,
        storedRules,
        toolRisk: tool.riskLevel,
        callCounts,
      });
      db.decisions.record({
        runId,
        agentId: agent.id,
        tool: tool.name,
        decision: decision.decision,
        rule: decision.rule,
        reason: decision.reason,
        argsDigest: fnv1a(JSON.stringify(call.args)),
      });
      rec.emit('policy_check', {
        tool: tool.name,
        decision: decision.decision,
        rule: decision.rule,
        reason: decision.reason,
        args: call.args,
      }, { tool: tool.name });
      metrics.policyDecisions.inc({ decision: decision.decision });

      if (decision.decision === 'deny' || decision.decision === 'rate_limited') {
        const evType = decision.decision === 'deny' ? 'policy_blocked' : 'policy_rate_limited';
        rec.emit(evType, { tool: tool.name, reason: decision.reason, rule: decision.rule }, { tool: tool.name, status: 'error' });
        messages.push(toolEnvelope(tool.name, call.args, { ok: false, error: decision.reason, errorKind: 'permanent', output: '' }));
        rec.emit('step_completed', { step: steps, of: limits.maxSteps });
        continue;
      }

      // 2d) require_approval → suspend the loop on an operator decision
      if (decision.decision === 'require_approval') {
        const { approval, decided } = approvals.request({
          runId,
          agentId: agent.id,
          tool: tool.name,
          args: call.args,
          summary: describeCall(tool, call.args),
          reason: decision.reason,
          kind: 'tool_execution',
        });
        rec.emit('approval_requested', {
          approvalId: approval.id,
          tool: tool.name,
          args: call.args,
          reason: decision.reason,
          summary: approval.summary,
        }, { tool: tool.name, status: 'pending' });
        db.runs.update(runId, {
          status: 'waiting_approval',
          pendingAction: { step: steps, tool: tool.name, args: call.args, approvalId: approval.id },
        });
        metrics.runsActive.set({}, db.runs.active().length);

        const verdict = await decided; // suspends until operator decides
        if (signal.aborted) continue; // cancel path handled at loop head

        if (verdict.status === 'denied') {
          rec.emit('approval_denied', { approvalId: approval.id, tool: tool.name, decidedBy: verdict.decidedBy }, { tool: tool.name, status: 'error' });
          db.runs.update(runId, { status: 'running', pendingAction: null });
          messages.push(toolEnvelope(tool.name, call.args, {
            ok: false,
            error: `operator denied this action: ${decision.reason}`,
            errorKind: 'permanent',
            output: '',
          }));
          rec.emit('step_completed', { step: steps, of: limits.maxSteps });
          continue;
        }
        rec.emit('approval_granted', { approvalId: approval.id, tool: tool.name, decidedBy: verdict.decidedBy }, { tool: tool.name, status: 'ok' });
        db.runs.update(runId, { status: 'running', pendingAction: null });
        metrics.runsActive.set({}, db.runs.active().length);
      }

      // 2e) execute with retries (bounded)
      callCounts[tool.name] = (callCounts[tool.name] ?? 0) + 1;
      const toolResult = await this.runToolWithRetries({
        tool,
        args: call.args,
        runId,
        agentId: agent.id,
        signal,
        workspaceDir,
        artifactsDir: paths.artifactsDir,
        maxRetries: Math.min(limits.maxRetries, tool.maxRetries),
        timeoutMs: Math.min(limits.toolTimeoutMs, tool.timeoutMs),
        rec,
        logger,
        onResult: (r) => {
          toolCalls += 1;
          if (!r.ok) toolFailures += 1;
        },
        onRetry: () => {
          retries += 1;
        },
      });

      metrics.toolCalls.inc({ tool: tool.name, result: toolResult.ok ? 'ok' : 'failed' });
      messages.push(toolEnvelope(tool.name, call.args, toolResult));
      db.runs.update(runId, { steps, toolCalls, toolFailures, retries, tokensIn, tokensOut, costUsd });
      rec.emit('step_completed', { step: steps, of: limits.maxSteps });
    }
  }

  private async runToolWithRetries(args: {
    tool: ToolDefinition;
    args: Record<string, unknown>;
    runId: string;
    agentId: string;
    signal: AbortSignal;
    workspaceDir: string;
    artifactsDir: string;
    maxRetries: number;
    timeoutMs: number;
    rec: EventRecorder;
    logger: Logger;
    onResult(r: ToolResult): void;
    onRetry(): void;
  }): Promise<ToolResult> {
    const { tool, rec } = args;
    let lastResult: ToolResult = { ok: false, output: '', error: 'not executed' };
    for (let attempt = 0; attempt <= args.maxRetries; attempt++) {
      if (args.signal.aborted) {
        return { ok: false, output: '', error: 'cancelled', errorKind: 'permanent' };
      }
      if (attempt > 0) {
        rec.emit('retry', { tool: tool.name, attempt, maxRetries: args.maxRetries }, { tool: tool.name });
        args.onRetry();
        await new Promise((r) => setTimeout(r, Math.min(100 * 2 ** (attempt - 1), 1_000)));
      }
      rec.emit('tool_called', { tool: tool.name, args: args.args, attempt }, { tool: tool.name, status: 'pending' });
      const t0 = Date.now();
      let result: ToolResult;
      try {
        result = await withTimeout(
          tool.handler(args.args, {
            runId: args.runId,
            agentId: args.agentId,
            signal: args.signal,
            workspaceDir: args.workspaceDir,
            artifactsDir: args.artifactsDir,
            logger: args.logger,
          }),
          args.timeoutMs,
          args.signal,
        );
      } catch (e) {
        const msg = (e as Error).message;
        const cancelled = args.signal.aborted || msg === 'cancelled';
        result = { ok: false, output: '', error: msg, errorKind: cancelled ? 'permanent' : 'transient' };
      }
      const dur = Date.now() - t0;
      lastResult = result;
      rec.emit(
        result.ok ? 'tool_completed' : 'tool_failed',
        {
          tool: tool.name,
          args: args.args,
          ...(result.ok ? {} : { error: result.error }),
          ...(result.data ? { data: result.data } : {}),
          output: truncate(result.output),
          attempt,
        },
        { tool: tool.name, durationMs: dur, status: result.ok ? 'ok' : 'error' },
      );
      args.onResult(result);
      if (result.ok || result.errorKind === 'validation' || result.errorKind === 'permanent') break;
      if (attempt >= args.maxRetries) break;
    }
    return lastResult;
  }
}

function buildSystemPrompt(agent: Agent): string {
  const base =
    agent.systemPrompt?.trim() ??
    `You are ${agent.name}, an autonomous agent running on the AgentOS control plane. ` +
      (agent.description ? `${agent.description} ` : '') +
      'Use your available tools to gather evidence, then return a concise final result.';
  return base;
}

/** Tool observation envelope persisted in the message trail (mock reads __args/data). */
function toolEnvelope(
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
): ModelMessage {
  return {
    role: 'tool',
    toolName,
    content: JSON.stringify({
      ok: result.ok,
      output: truncate(result.output),
      error: result.error,
      data: { ...(result.data ?? {}), __args: args },
    }),
  };
}

function describeCall(tool: ToolDefinition, args: Record<string, unknown>): string {
  const flat = Object.entries(args)
    .slice(0, 4)
    .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
    .join(' ');
  return `Execute ${tool.name}(${flat})`;
}
