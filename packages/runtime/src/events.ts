import type { AgentDatabase, RunEvent } from '@agentos/database';
import type { EventBus, RunEventType, EventStatus } from '@agentos/shared';
import { newSpanId } from '@agentos/observability';
import type { AppMetrics } from '@agentos/observability';

export interface EmitOptions {
  status?: EventStatus;
  durationMs?: number;
  tool?: string;
}

/**
 * Writes the append-only execution trace for one run: persists to SQLite
 * (redacted), publishes on the event bus (SSE/dashboard), and updates metrics.
 * Sequence numbers are monotonic per recorder and resume from stored events.
 */
export class EventRecorder {
  private lastSeq: number;

  constructor(
    private readonly db: AgentDatabase,
    private readonly bus: EventBus,
    private readonly metrics: AppMetrics,
    private readonly runId: string,
    private readonly traceId: string,
    private readonly agentId?: string,
    resumeFromSeq = 0,
  ) {
    this.lastSeq = Math.max(resumeFromSeq, db.events.lastSeq(runId));
  }

  emit(type: RunEventType, payload?: Record<string, unknown>, opts: EmitOptions = {}): RunEvent {
    const ev: RunEvent = {
      runId: this.runId,
      seq: ++this.lastSeq,
      ts: Date.now(),
      type,
      agentId: this.agentId ?? null,
      tool: opts.tool ?? null,
      payload: payload ?? null,
      durationMs: opts.durationMs ?? null,
      status: opts.status ?? null,
      traceId: this.traceId,
      spanId: newSpanId(),
    };
    this.db.events.append(ev);
    this.bus.publish({
      topic: 'run',
      type,
      ts: ev.ts,
      entityId: this.runId,
      data: {
        runId: this.runId,
        seq: ev.seq,
        tool: ev.tool,
        status: ev.status,
        durationMs: ev.durationMs,
        payload: payload ?? {},
      },
    });
    return ev;
  }

  get seq(): number {
    return this.lastSeq;
  }
}
