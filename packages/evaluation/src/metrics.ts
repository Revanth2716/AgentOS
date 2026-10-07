import type { AgentDatabase, Run, RunMetrics } from '@agentos/database';

/**
 * Deterministic run metrics — computed purely from persisted trace events and
 * run counters. No LLM judge involved: this is the evidence-based core of the
 * evaluation engine.
 */
export function computeRunMetrics(db: AgentDatabase, run: Run): RunMetrics {
  const events = db.events.listForRun(run.id);
  const toolCompleted = events.filter((e) => e.type === 'tool_completed').length;
  const toolFailed = events.filter((e) => e.type === 'tool_failed').length;
  const retried = events.filter((e) => e.type === 'retry').length;
  const blocked = events.filter((e) => e.type === 'policy_blocked' || e.type === 'policy_rate_limited').length;
  const started = events.find((e) => e.type === 'task_received')?.ts ?? run.startedAt ?? run.createdAt;
  const ended = run.endedAt ?? events.at(-1)?.ts ?? started;
  const toolCalls = toolCompleted + toolFailed;

  // Failure recovery: a tool that failed at least once but later succeeded.
  const byTool = new Map<string, { failed: boolean; succeeded: boolean }>();
  for (const e of events) {
    if (!e.tool || (e.type !== 'tool_failed' && e.type !== 'tool_completed')) continue;
    const s = byTool.get(e.tool) ?? { failed: false, succeeded: false };
    if (e.type === 'tool_failed') s.failed = true;
    else s.succeeded = true;
    byTool.set(e.tool, s);
  }
  const failedTools = [...byTool.values()].filter((s) => s.failed);
  const recoveredTools = failedTools.filter((s) => s.succeeded);
  const recoveryRate = failedTools.length > 0 ? recoveredTools.length / failedTools.length : 1;

  return {
    completed: run.status === 'completed',
    steps: run.steps,
    durationMs: Math.max(0, ended - started),
    toolSuccessRate: toolCalls > 0 ? toolCompleted / toolCalls : 1,
    toolCalls,
    toolFailures: toolFailed,
    retries: retried,
    policyViolations: blocked,
    recoveryRate,
    costUsd: run.costUsd,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
  };
}
