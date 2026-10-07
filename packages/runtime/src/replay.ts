import type { AgentDatabase, Run } from '@agentos/database';
import { ValidationError, type EventBus } from '@agentos/shared';
import type { AppMetrics } from '@agentos/observability';
import type { AgentRuntime } from './runtime.js';

export interface ReplayDiffEntry {
  seq: number;
  original: string;
  replay: string | null;
}

export interface ReplayOutcome {
  originalRunId: string;
  replayRunId: string;
  /** True when the replayed trace matches the original event-for-event (types + tools + final result). */
  identical: boolean;
  differences: ReplayDiffEntry[];
  replayRun: Run;
}

/**
 * Re-executes a completed run with the same seed and agent snapshot, then
 * diffs the two traces. Deterministic providers (mock, and local runs of the
 * same seed) reproduce identical sequences — drift surfaces as differences.
 */
export async function replayRun(
  db: AgentDatabase,
  runtime: AgentRuntime,
  originalRunId: string,
  bus?: EventBus,
  metrics?: AppMetrics,
): Promise<ReplayOutcome> {
  void bus;
  void metrics;
  const original = db.runs.get(originalRunId);
  if (!original) throw new ValidationError(`run not found: ${originalRunId}`);
  if (original.status !== 'completed') {
    throw new ValidationError(`only completed runs can be replayed (status: ${original.status})`);
  }
  if (original.mode === 'live' && !original.model.startsWith('mock/')) {
    throw new ValidationError(
      'replay requires a deterministic run (demo/mock provider); live cloud runs are not bit-reproducible',
    );
  }
  const agentRow = db.agents.get(original.agentId);
  if (!agentRow) throw new ValidationError(`agent ${original.agentId} no longer exists`);

  // Re-run against the SNAPSHOT captured at run time, not the current config.
  const snapshotAgent = { ...original.agentSnapshot, id: original.agentId };

  const replay = runtime.start({
    agent: {
      ...snapshotAgent,
      name: agentRow.name,
      createdAt: agentRow.createdAt,
      updatedAt: agentRow.updatedAt,
      seq: agentRow.seq,
    },
    task: original.task,
    mode: original.mode,
    seed: original.seed,
    workflowRunId: null,
    replayOf: original.id,
  });
  const replayRun = await runtime.waitFor(replay.id);

  const originalEvents = db.events.listForRun(originalRunId);
  const replayEvents = db.events.listForRun(replay.id);

  const signature = (e: { seq: number; type: string; tool?: string | null }): string =>
    `${e.type}${e.tool ? `:${e.tool}` : ''}`;

  const differences: ReplayDiffEntry[] = [];
  const maxLen = Math.max(originalEvents.length, replayEvents.length);
  for (let i = 0; i < maxLen; i++) {
    const o = originalEvents[i];
    const r = replayEvents[i];
    const so = o ? signature(o) : '<missing>';
    const sr = r ? signature(r) : null;
    if (so !== sr) differences.push({ seq: i + 1, original: so, replay: sr });
  }
  const identical =
    differences.length === 0 && original.finalResult === replayRun.finalResult;

  if (!identical && original.finalResult !== replayRun.finalResult) {
    differences.push({
      seq: maxLen + 1,
      original: `final_result:${(original.finalResult ?? '').slice(0, 60)}`,
      replay: `final_result:${(replayRun.finalResult ?? '').slice(0, 60)}`,
    });
  }

  return { originalRunId, replayRunId: replay.id, identical, differences, replayRun };
}
