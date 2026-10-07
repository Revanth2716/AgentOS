import { createHash, randomBytes } from 'node:crypto';
import type { RunEvent } from '@agentos/shared';

/** OTel-conformant 16-byte trace id / 8-byte span id as lowercase hex. */
export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

/** Deterministic trace id (used in replay so traces correlate across runs). */
export function traceIdFrom(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

export interface OtlpResourceSpans {
  resource: { attributes: { key: string; value: { stringValue?: string } }[] };
  scopeSpans: Array<{
    scope: { name: string; version: string };
    spans: Array<{
      traceId: string;
      spanId: string;
      parentSpanId?: string;
      name: string;
      kind: number;
      startTimeUnixNano: string;
      endTimeUnixNano: string;
      attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string; doubleValue?: string } }>;
      status: { code: number; message?: string };
    }>;
  }>;
}

/**
 * Converts run events into OTLP/JSON resourceSpans so traces can be exported
 * to any local OpenTelemetry collector without an SDK dependency here.
 * Each event becomes one span; the run itself is the root span.
 */
export function runEventsToOtlp(runId: string, events: RunEvent[], extra: { agentName?: string } = {}): OtlpResourceSpans {
  const traceId = (events[0]?.traceId ?? traceIdFrom(runId)).padEnd(32, '0').slice(0, 32);
  const spans = events.map((ev, i) => {
    const startNs = BigInt(ev.ts) * 1_000_000n;
    const durNs = BigInt(Math.max(0, ev.durationMs ?? 1)) * 1_000_000n;
    const spanId = (ev.spanId ?? traceIdFrom(`${runId}:${i}`)).padEnd(16, '0').slice(0, 16);
    const parentIdx = Math.max(0, i - 1);
    const parentSpanId =
      i === 0 ? undefined : (events[parentIdx]?.spanId ?? traceIdFrom(`${runId}:${parentIdx}`)).padEnd(16, '0').slice(0, 16);
    return {
      traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name: ev.type,
      kind: i === 0 ? 1 : 2,
      startTimeUnixNano: startNs.toString(),
      endTimeUnixNano: (startNs + durNs).toString(),
      attributes: [
        { key: 'agentos.run_id', value: { stringValue: runId } },
        { key: 'agentos.event_seq', value: { intValue: String(ev.seq) } },
        ...(ev.agentId ? [{ key: 'agentos.agent_id', value: { stringValue: ev.agentId } }] : []),
        ...(ev.tool ? [{ key: 'agentos.tool', value: { stringValue: ev.tool } }] : []),
        ...(ev.status ? [{ key: 'agentos.status', value: { stringValue: ev.status } }] : []),
      ],
      status: { code: ev.status === 'error' ? 2 : 1, message: ev.status === 'error' ? 'error' : undefined },
    };
  });

  return {
    resource: {
      attributes: [
        { key: 'service.name', value: { stringValue: 'agentos' } },
        { key: 'service.version', value: { stringValue: '0.1.0' } },
        ...(extra.agentName ? [{ key: 'agentos.agent_name', value: { stringValue: extra.agentName } }] : []),
      ],
    },
    scopeSpans: [
      {
        scope: { name: 'agentos.run-trace', version: '0.1.0' },
        spans,
      },
    ],
  };
}
