import type { AgentDatabase, EvalRun, EvalRunSummary, RunMetrics } from '@agentos/database';
import type { EvalCase, EventBus } from '@agentos/shared';
import type { AgentRuntime } from '@agentos/runtime';
import type { AppMetrics, Logger } from '@agentos/observability';
import { fnv1a } from '@agentos/shared';
import { computeRunMetrics } from './metrics.js';

export interface EvaluationRunnerDeps {
  db: AgentDatabase;
  runtime: AgentRuntime;
  metrics: AppMetrics;
  bus: EventBus;
  logger: Logger;
}

export interface CaseOutcome {
  caseId: string;
  name: string;
  passed: boolean;
  runId: string;
  metrics: RunMetrics;
  failureReason: string | null;
}

/**
 * Runs an eval suite: executes each case against the target agent with a
 * deterministic per-case seed, then applies purely deterministic checks
 * (completion, citations/evidence, tools used, step/latency budgets).
 * There is no LLM judge in the core path.
 */
export class EvaluationRunner {
  constructor(private readonly deps: EvaluationRunnerDeps) {}

  async runSuite(suiteId: string): Promise<{ evalRun: EvalRun; outcomes: CaseOutcome[] }> {
    const { db, runtime, metrics, bus, logger } = this.deps;
    const suite = db.evals.getSuite(suiteId);
    if (!suite) throw new Error(`eval suite not found: ${suiteId}`);
    const agent = db.agents.get(suite.agentId);
    if (!agent) throw new Error(`agent not found: ${suite.agentId}`);

    const evalRun = db.evals.createRun({ suiteId, agentId: agent.id });
    db.evals.updateRun(evalRun.id, { status: 'running', startedAt: Date.now() });
    bus.publish({ topic: 'eval', type: 'eval_started', ts: Date.now(), entityId: evalRun.id, data: { suite: suite.name, cases: suite.cases.length } });

    const outcomes: CaseOutcome[] = [];
    try {
      for (const evalCase of suite.cases) {
        const seed = parseInt(fnv1a(`${suite.id}:${evalCase.id}`).slice(0, 8), 16);
        const run = runtime.start({ agent, task: evalCase.task, mode: 'demo', seed });
        const finished = await runtime.waitFor(run.id);
        const runMetrics = computeRunMetrics(db, finished);
        const expectationFailure = checkExpectations(evalCase, finished.finalResult, runMetrics, finished.status, finished.error);
        const toolsFailure = checkToolsUsed(db.events.listForRun(finished.id), evalCase.expect.toolsUsed);
        const failureReason = [expectationFailure, toolsFailure].filter((f) => f !== null).join('; ') || null;
        const outcome: CaseOutcome = {
          caseId: evalCase.id,
          name: evalCase.name,
          passed: failureReason === null,
          runId: finished.id,
          metrics: runMetrics,
          failureReason,
        };
        outcomes.push(outcome);
        db.evals.addCaseResult({
          evalRunId: evalRun.id,
          caseId: evalCase.id,
          name: evalCase.name,
          passed: outcome.passed,
          runId: finished.id,
          metrics: runMetrics,
          failureReason,
        });
        bus.publish({
          topic: 'eval',
          type: 'eval_case_completed',
          ts: Date.now(),
          entityId: evalRun.id,
          data: { caseId: evalCase.id, passed: outcome.passed, runId: finished.id, failureReason },
        });
      }

      const summary = summarize(outcomes);
      db.evals.updateRun(evalRun.id, { status: 'completed', endedAt: Date.now(), summary });
      metrics.evalPassRate.set({}, summary.successRate);
      bus.publish({ topic: 'eval', type: 'eval_completed', ts: Date.now(), entityId: evalRun.id, data: { ...summary } });
      logger.info({ suite: suite.name, evalRunId: evalRun.id, ...summary }, 'evaluation completed');
      return { evalRun: db.evals.getRun(evalRun.id) as EvalRun, outcomes };
    } catch (e) {
      db.evals.updateRun(evalRun.id, { status: 'failed', endedAt: Date.now(), error: (e as Error).message });
      throw e;
    }
  }
}

/** Deterministic expectation checks against the run's final answer + trace. */
export function checkExpectations(
  evalCase: EvalCase,
  finalResult: string | null,
  m: RunMetrics,
  status: string,
  runError: string | null,
): string | null {
  const failures: string[] = [];
  if (status !== 'completed') failures.push(`run ${status}: ${runError ?? ''}`.trim());

  const answer = finalResult ?? '';
  const expect = evalCase.expect;

  for (const kw of expect.keywords) {
    if (!answer.toLowerCase().includes(kw.toLowerCase())) {
      failures.push(`missing keyword "${kw}" in final answer`);
    }
  }
  if (expect.requireCitations && !/\[source:\s*[^\]]+\]/i.test(answer)) {
    failures.push('final answer carries no [source: …] citations (evidence unsupported)');
  }
  if (expect.minSources > 0) {
    const sourceIds = new Set(answer.match(/\[doc-\d+\]/g) ?? []);
    if (sourceIds.size < expect.minSources) {
      failures.push(`only ${sourceIds.size} cited source(s), expected >= ${expect.minSources}`);
    }
  }
  if (expect.maxSteps !== undefined && m.steps > expect.maxSteps) {
    failures.push(`steps ${m.steps} exceeded budget ${expect.maxSteps}`);
  }
  if (expect.maxDurationMs !== undefined && m.durationMs > expect.maxDurationMs) {
    failures.push(`duration ${m.durationMs}ms exceeded budget ${expect.maxDurationMs}`);
  }
  return failures.length > 0 ? failures.join('; ') : null;
}

/** Extends check with tool-usage requirements (needs the trace, so kept separate). */
export function checkToolsUsed(events: { type: string; tool?: string | null }[], required: string[]): string | null {
  const called = new Set(events.filter((e) => e.type === 'tool_called').map((e) => e.tool ?? ''));
  const missing = required.filter((t) => !called.has(t));
  return missing.length > 0 ? `required tool(s) never called: ${missing.join(', ')}` : null;
}

export function summarize(outcomes: CaseOutcome[]): EvalRunSummary {
  const n = outcomes.length;
  const passed = outcomes.filter((o) => o.passed).length;
  const withFailures = outcomes.filter((o) => o.metrics.toolFailures > 0);
  return {
    cases: n,
    passed,
    failed: n - passed,
    successRate: n > 0 ? passed / n : 0,
    avgSteps: n > 0 ? round(outcomes.reduce((s, o) => s + o.metrics.steps, 0) / n, 1) : 0,
    avgLatencyMs: n > 0 ? Math.round(outcomes.reduce((s, o) => s + o.metrics.durationMs, 0) / n) : 0,
    avgToolSuccessRate: n > 0
      ? round(outcomes.reduce((s, o) => s + o.metrics.toolSuccessRate, 0) / n, 3)
      : 1,
    policyViolations: outcomes.reduce((s, o) => s + o.metrics.policyViolations, 0),
    recoveryRate:
      withFailures.length > 0
        ? round(withFailures.reduce((s, o) => s + o.metrics.recoveryRate, 0) / withFailures.length, 3)
        : 1,
    totalCostUsd: Math.round(outcomes.reduce((s, o) => s + o.metrics.costUsd, 0) * 1_000_000) / 1_000_000,
  };
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
