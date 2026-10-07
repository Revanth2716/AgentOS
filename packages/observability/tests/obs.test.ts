import { describe, expect, it } from 'vitest';
import { MetricsRegistry, createAppMetrics, InProcessEventBus, runEventsToOtlp, newTraceId } from '../src/index.js';
import type { RunEvent } from '@agentos/shared';

describe('MetricsRegistry', () => {
  it('renders Prometheus text for counters, gauges, histograms', () => {
    const r = new MetricsRegistry();
    const c = r.counter('agentos_test_total', 'test counter');
    c.inc({ tool: 'a' });
    c.inc({ tool: 'a' });
    c.inc({ tool: 'b' });
    const g = r.gauge('agentos_test_gauge', 'test gauge');
    g.set({}, 7);
    const h = r.histogram('agentos_test_seconds', 'test hist', [1, 5]);
    h.observe({}, 0.5);
    h.observe({}, 3);
    h.observe({}, 100);

    const text = r.render();
    expect(text).toContain('# TYPE agentos_test_total counter');
    expect(text).toContain('agentos_test_total{tool="a"} 2');
    expect(text).toContain('agentos_test_gauge 7');
    expect(text).toContain('# TYPE agentos_test_seconds histogram');
    expect(text).toContain('agentos_test_seconds_bucket{le="1"} 1');
    expect(text).toContain('agentos_test_seconds_bucket{le="5"} 2');
    expect(text).toContain('agentos_test_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain('agentos_test_seconds_count 3');
  });

  it('escapes label values', () => {
    const r = new MetricsRegistry();
    r.counter('x_total', 'x').inc({ name: 'a"b\\c' });
    expect(r.render()).toContain('x_total{name="a\\"b\\\\c"} 1');
  });

  it('app metrics exposes the full expected surface', () => {
    const m = createAppMetrics();
    m.runsTotal.inc({ status: 'completed' });
    m.toolCalls.inc({ tool: 'calculator', result: 'ok' });
    m.policyDecisions.inc({ decision: 'deny' });
    m.runDuration.observe({}, 2.5);
    m.approvalsPending.set({}, 3);
    const text = m.registry.render();
    expect(text).toContain('agentos_runs_total{status="completed"} 1');
    expect(text).toContain('agentos_policy_decisions_total{decision="deny"} 1');
    expect(text).toContain('agentos_approvals_pending 3');
  });
});

describe('InProcessEventBus', () => {
  it('publishes to subscribers and supports unsubscribe', () => {
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    const off = bus.subscribe((e) => seen.push(e.type));
    bus.publish({ topic: 'run', type: 'tool_called', ts: 1, data: {} });
    off();
    bus.publish({ topic: 'run', type: 'tool_completed', ts: 2, data: {} });
    expect(seen).toEqual(['tool_called']);
  });

  it('keeps publishing when a subscriber throws', () => {
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error('bad subscriber');
    });
    bus.subscribe((e) => seen.push(e.type));
    expect(() => bus.publish({ topic: 'run', type: 'x', ts: 1, data: {} })).not.toThrow();
    expect(seen).toEqual(['x']);
  });
});

describe('OTLP export', () => {
  it('produces OTLP/JSON resourceSpans with conformant ids', () => {
    const traceId = newTraceId();
    const events: RunEvent[] = [
      { runId: 'run_1', seq: 1, ts: 1000, type: 'task_received', traceId, spanId: 'a'.repeat(16), status: 'ok' },
      { runId: 'run_1', seq: 2, ts: 1500, type: 'tool_called', tool: 'calculator', durationMs: 5, traceId, spanId: 'b'.repeat(16), status: 'ok' },
    ];
    const otlp = runEventsToOtlp('run_1', events, { agentName: 'researcher' });
    expect(otlp.resource.attributes.some((a) => a.key === 'service.name' && a.value.stringValue === 'agentos')).toBe(true);
    expect(otlp.scopeSpans[0]?.spans).toHaveLength(2);
    const span = otlp.scopeSpans[0]?.spans[1];
    expect(span?.name).toBe('tool_called');
    expect(span?.traceId).toHaveLength(32);
    expect(span?.spanId).toHaveLength(16);
    expect(span?.attributes.some((a) => a.key === 'agentos.tool' && a.value.stringValue === 'calculator')).toBe(true);
    expect(BigInt(span?.startTimeUnixNano ?? '0')).toBeGreaterThan(0n);
  });
});
