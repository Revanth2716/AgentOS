/**
 * Minimal Prometheus-compatible registry: counters, gauges, histograms with
 * labels, and text exposition (GET /metrics). Zero external dependencies —
 * scrapable by any local Prometheus.
 */

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}` : '';
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

class Counter {
  readonly name: string;
  readonly help: string;
  protected readonly values = new Map<string, number>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels: Labels = {}, delta = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + delta);
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) lines.push(`${this.name} 0`);
    for (const [key, v] of this.values) lines.push(`${this.name}${key} ${v}`);
    return lines;
  }
}

class Gauge extends Counter {
  set(labels: Labels = {}, value = 0): void {
    this.values.set(labelKey(labels), value);
  }
}

interface HistogramBucket {
  le: number;
  count: number;
  sum: number;
}

class Histogram {
  readonly name: string;
  readonly help: string;
  private readonly bounds: number[];
  private readonly series = new Map<string, { buckets: HistogramBucket[]; total: number; count: number }>();

  constructor(name: string, help: string, bounds: number[]) {
    this.name = name;
    this.help = help;
    this.bounds = [...bounds].sort((a, b) => a - b);
  }

  observe(labels: Labels, value: number): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { buckets: this.bounds.map((le) => ({ le, count: 0, sum: 0 })), total: 0, count: 0 };
      this.series.set(key, s);
    }
    s.total += value;
    s.count += 1;
    for (const b of s.buckets) {
      if (value <= b.le) b.count += 1;
    }
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, s] of this.series) {
      const labels = key === '' ? '' : key.slice(1, -1);
      for (const b of s.buckets) {
        const le = labels ? `{${labels},le="${b.le}"}` : `{le="${b.le}"}`;
        lines.push(`${this.name}_bucket${le} ${b.count}`);
      }
      const inf = labels ? `{${labels},le="+Inf"}` : `{le="+Inf"}`;
      const base = labels ? `{${labels}}` : '';
      lines.push(`${this.name}_bucket${inf} ${s.count}`);
      lines.push(`${this.name}_sum${base} ${Math.round(s.total * 1000) / 1000}`);
      lines.push(`${this.name}_count${base} ${s.count}`);
    }
    if (this.series.size === 0) {
      lines.push(`${this.name}_count 0`);
      lines.push(`${this.name}_sum 0`);
    }
    return lines;
  }
}

export class MetricsRegistry {
  readonly counters = new Map<string, Counter>();
  readonly gauges = new Map<string, Gauge>();
  readonly histograms = new Map<string, Histogram>();

  counter(name: string, help: string): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter(name, help);
      this.counters.set(name, c);
    }
    return c;
  }

  gauge(name: string, help: string): Gauge {
    let g = this.gauges.get(name);
    if (!g) {
      g = new Gauge(name, help);
      this.gauges.set(name, g);
    }
    return g;
  }

  histogram(name: string, help: string, bounds: number[]): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram(name, help, bounds);
      this.histograms.set(name, h);
    }
    return h;
  }

  render(): string {
    const lines: string[] = [];
    for (const c of this.counters.values()) lines.push(...c.render());
    for (const g of this.gauges.values()) lines.push(...g.render());
    for (const h of this.histograms.values()) lines.push(...h.render());
    return `${lines.join('\n')}\n`;
  }
}

/** The application-wide metric set used by the runtime, server, and CLI. */
export interface AppMetrics {
  registry: MetricsRegistry;
  runsTotal: Counter;
  runsActive: Gauge;
  toolCalls: Counter;
  policyDecisions: Counter;
  approvalsPending: Gauge;
  runDuration: Histogram;
  toolDuration: Histogram;
  modelTokens: Counter;
  estCostUsd: Counter;
  evalPassRate: Gauge;
}

export function createAppMetrics(): AppMetrics {
  const registry = new MetricsRegistry();
  return {
    registry,
    runsTotal: registry.counter('agentos_runs_total', 'Total runs by status'),
    runsActive: registry.gauge('agentos_runs_active', 'Currently open runs'),
    toolCalls: registry.counter('agentos_tool_calls_total', 'Tool executions by result'),
    policyDecisions: registry.counter('agentos_policy_decisions_total', 'Policy decisions by action'),
    approvalsPending: registry.gauge('agentos_approvals_pending', 'Pending approval requests'),
    runDuration: registry.histogram(
      'agentos_run_duration_seconds',
      'Run duration in seconds',
      [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
    ),
    toolDuration: registry.histogram(
      'agentos_tool_duration_seconds',
      'Tool execution duration in seconds',
      [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 30],
    ),
    modelTokens: registry.counter('agentos_model_tokens_total', 'Model tokens by provider and direction'),
    estCostUsd: registry.counter('agentos_est_cost_usd_micros', 'Estimated cost in micro-USD'),
    evalPassRate: registry.gauge('agentos_eval_pass_rate', 'Latest evaluation pass rate (0-1)'),
  };
}
