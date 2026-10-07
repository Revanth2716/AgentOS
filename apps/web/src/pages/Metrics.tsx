import { useState } from 'react';
import { api } from '../lib/api.js';
import { usePoll, fmtDuration, fmtCost, fmtTokens, fmtRelative } from '../lib/hooks.js';
import { Card, Cell, CodeBlock, EmptyState, ErrorState, PageHeader, Row, Spinner, StatusPill, Table, Mono } from '../components/ui.js';
import { BarSeries, Sparkline, Donut, ProgressBar } from '../components/charts.js';

export default function Metrics() {
  const [tab, setTab] = useState<'timeseries' | 'providers' | 'doctor' | 'raw'>('timeseries');
  const ts = usePoll(() => api.timeseries(14), 30_000);
  const summary = usePoll(() => api.summary(), 5_000);
  const providers = usePoll(() => api.providers(), 6_000);
  const doctor = usePoll(() => api.doctor(), 10_000);
  const [rawMetrics, setRawMetrics] = useState<string | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const doctorChecks = ((doctor.data as any)?.checks as { status: string }[]) ?? [];

  const fetchRaw = async () => {
    try {
      const res = await fetch('/api/v1/system/metrics');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      setRawMetrics(text);
      setRawError(null);
    } catch (e) {
      setRawError((e as Error).message);
      setRawMetrics(null);
    }
  };

  if (ts.loading && !ts.data) return <Spinner label="Loading metrics…" />;
  if (summary.error && !summary.data) return <ErrorState message={summary.error} />;
  if (ts.error && !ts.data) return <ErrorState message={ts.error} />;

  return (
    <div>
      <PageHeader
        title="Metrics"
        subtitle="Run throughput, cost locality, provider status, and health checks."
        actions={
          <>
            <div className="flex gap-1.5">
              {(['timeseries', 'providers', 'doctor', 'raw'] as const).map((t) => (
                <button key={t} type="button" onClick={() => setTab(t)} className={`px-3 py-1.5 rounded-lg text-[13px] ${tab === t ? 'bg-accent-soft text-accent font-medium' : 'text-muted hover:text-ink hover:bg-panel2'}`}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </>
        }
      />

      {tab === 'timeseries' && (
        <>
          {summary.data && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <Card className="p-4">
                <div className="text-[11px] uppercase text-muted tracking-wider">Avg latency</div>
                <div className="text-2xl font-semibold mt-1.5 tabular-nums">{fmtDuration(summary.data.avgLatencyMs)}</div>
                <div className="text-[12px] text-muted mt-1">completed runs</div>
              </Card>
              <Card className="p-4">
                <div className="text-[11px] uppercase text-muted tracking-wider">Tool calls today</div>
                <div className="text-2xl font-semibold mt-1.5 tabular-nums">{summary.data.toolCalls.today}</div>
                <div className="text-[12px] text-muted mt-1">{summary.data.toolCalls.failures} failed</div>
              </Card>
              <Card className="p-4">
                <div className="text-[11px] uppercase text-muted tracking-wider">Cost today</div>
                <div className="text-2xl font-semibold mt-1.5 text-ok tabular-nums">{fmtCost(summary.data.cost.todayUsd)}</div>
                <div className="text-[12px] text-muted mt-1">{fmtTokens(summary.data.cost.tokensToday)} tokens</div>
              </Card>
              <Card className="p-4">
                <div className="text-[11px] uppercase text-muted tracking-wider">Eval score</div>
                <div className="text-2xl font-semibold mt-1.5 tabular-nums">
                  {summary.data.evaluation.successRate === null ? '—' : `${Math.round(summary.data.evaluation.successRate * 100)}%`}
                </div>
                <div className="text-[12px] text-muted mt-1">{summary.data.evaluation.cases} cases</div>
              </Card>
            </div>
          )}

          <Card className="p-4 mb-4">
            <div className="text-[13px] font-medium mb-3">Runs per day (14d)</div>
            {ts.data ? (
              <>
                <BarSeries
                  data={(ts.data.runs ?? []).map((r) => ({ label: r.day.slice(5), value: r.runs - r.failed, secondary: r.failed }))}
                  labels
                />
                <div className="flex gap-4 text-[11px] text-muted mt-3">
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--accent)' }} /> completed</span>
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--danger)' }} /> failed</span>
                </div>
              </>
            ) : (
              <div className="text-muted text-[13px] py-4">No timeseries data yet.</div>
            )}
          </Card>

          <div className="grid lg:grid-cols-2 gap-4 mb-4">
            <Card className="p-4">
              <div className="text-[13px] font-medium mb-3">Cost locality (today)</div>
              {summary.data && (
                <div className="flex items-center gap-4">
                  <Donut
                    value={summary.data.cost.mockCalls + summary.data.cost.localCalls + summary.data.cost.cloudCalls > 0
                      ? (summary.data.cost.mockCalls + summary.data.cost.localCalls) / (summary.data.cost.mockCalls + summary.data.cost.localCalls + summary.data.cost.cloudCalls)
                      : 1
                    }
                    color="var(--ok)"
                  />
                  <div className="text-[12px] space-y-1.5">
                    <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full" style={{ background: 'var(--ok)' }} /> MOCK {summary.data.cost.mockCalls}</div>
                    <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full" style={{ background: 'var(--accent)' }} /> LOCAL {summary.data.cost.localCalls}</div>
                    <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full" style={{ background: 'var(--warn)' }} /> CLOUD {summary.data.cost.cloudCalls}</div>
                    <div className="pt-1 border-t border-border text-muted">Total: <span className="text-ok font-semibold">{fmtCost(summary.data.cost.allTimeUsd)}</span></div>
                  </div>
                </div>
              )}
            </Card>
            <Card className="p-4">
              <div className="text-[13px] font-medium mb-3">Policy blocks</div>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[13px]">All time</span>
                  <span className={`font-semibold tabular-nums ${(summary.data?.policy.blocksAllTime ?? 0) > 0 ? 'text-danger' : 'text-muted'}`}>
                    {summary.data?.policy.blocksAllTime ?? 0}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[13px]">Today</span>
                  <span className={`font-semibold tabular-nums ${(summary.data?.policy.blocksToday ?? 0) > 0 ? 'text-danger' : 'text-muted'}`}>
                    {summary.data?.policy.blocksToday ?? 0}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[13px]">Require approval today</span>
                  <span className={`font-semibold tabular-nums ${(summary.data?.policy.requireApprovalToday ?? 0) > 0 ? 'text-warn' : 'text-muted'}`}>
                    {summary.data?.policy.requireApprovalToday ?? 0}
                  </span>
                </div>
                <ProgressBar
                  value={summary.data ? (summary.data.policy.blocksAllTime ?? 0) : 0}
                  max={Math.max(1, summary.data?.policy.blocksAllTime ?? 1)}
                  color="var(--danger)"
                />
              </div>
            </Card>
          </div>

          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[13px] font-medium">Cost over time (14d)</div>
              <div className="text-[11px] text-muted">estimated</div>
            </div>
            {ts.data && ts.data.costs && ts.data.costs.length > 0 ? (
              <>
                <BarSeries
                  data={ts.data.costs.map((c) => ({ label: c.day.slice(5), value: c.costUsd, secondary: c.tokens / 1000 }))}
                  height={80}
                  color="var(--ok)"
                  secondaryColor="var(--muted)"
                />
                <div className="flex gap-4 text-[11px] text-muted mt-2">
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--ok)' }} /> cost ($)</span>
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--muted)' }} /> tokens (K)</span>
                </div>
              </>
            ) : (
              <div className="text-muted text-[13px] py-4">No cost data yet.</div>
            )}
          </Card>
        </>
      )}

      {tab === 'providers' && (
        <>
          <Card className="p-4 mb-4">
            <div className="text-[13px] font-medium mb-3">Model providers</div>
            {providers.data && providers.data.providers.length > 0 ? (
              <Table head={['Provider', 'Locality', 'Status', 'Detail', 'Cost']}>
                {providers.data.providers.map((p) => (
                  <Row key={p.name}>
                    <Cell className="font-mono text-[13px] font-medium">{p.name}</Cell>
                    <Cell><StatusPill status={p.locality as any} label={p.locality} /></Cell>
                    <Cell><StatusPill status={p.status as any} /></Cell>
                    <Cell className="text-[11px] text-muted max-w-[240px] truncate">{p.detail}</Cell>
                    <Cell className="text-[11px] text-muted">{p.cost}</Cell>
                  </Row>
                ))}
              </Table>
            ) : (
              <div className="text-muted text-[13px] py-4">No providers configured.</div>
            )}
          </Card>
          <Card className="p-4">
            <div className="text-[13px] font-medium mb-3">Browser</div>
            {providers.data && (
              <div className="flex items-center gap-3">
                <Donut value={providers.data.browser.available ? 1 : 0} color={providers.data.browser.available ? 'var(--ok)' : 'var(--danger)'} size={64} />
                <div className="text-[13px] font-medium">{providers.data.browser.available ? 'Available' : 'Unavailable'}</div>
                {providers.data.browser.reason ? <div className="text-[12px] text-muted">{providers.data.browser.reason}</div> : null}
              </div>
            )}
          </Card>
        </>
      )}

      {tab === 'doctor' && (
        <>
          <Card className="p-4">
            <div className="text-[13px] font-medium mb-3">Health checks</div>
            {doctor.data && doctor.data.checks.length > 0 ? (
              <Table head={['Check', 'Status', 'Detail']}>
                {doctor.data.checks.map((c) => (
                  <Row key={c.name}>
                    <Cell className="font-medium text-[13px]">{c.name}</Cell>
                    <Cell><StatusPill status={c.status} label={(c.status as string) === 'not-configured' ? 'not configured' : (c.status as string)} /></Cell>
                    <Cell className="text-[11px] text-muted max-w-[300px] truncate">{c.detail}</Cell>
                  </Row>
                ))}
              </Table>
            ) : (
              <div className="text-muted text-[13px] py-4">No checks available.</div>
            )}
          </Card>
          {doctor.data && doctor.data.checks.length > 0 && (
            <div className="mt-4 flex gap-2">
              <span className={`text-[12px] px-2 py-1 rounded ${(() => { const statuses: string[] = doctorChecks.map(c => c.status as string); const allPass = statuses.every(s => s === 'pass'); const anyNotConfigured = statuses.some(s => s === 'not-configured'); const anyWarn = statuses.some(s => s === 'warn'); const anyFail = statuses.some(s => s === 'fail'); if (allPass && !anyNotConfigured && !anyWarn) return 'bg-ok-soft text-ok'; if (anyFail) return 'bg-danger-soft text-danger'; return 'bg-warn-soft text-warn'; })()}`}>
                {((() => { const statuses: string[] = doctorChecks.map(c => c.status as string); const allPass = statuses.every(s => s === 'pass'); const anyNotConfigured = statuses.some(s => s === 'not-configured'); const anyWarn = statuses.some(s => s === 'warn'); const anyFail = statuses.some(s => s === 'fail'); if (allPass && !anyNotConfigured && !anyWarn) return 'All checks pass'; if (anyFail) return 'Some checks failed'; return 'Some checks warn'; })())}
              </span>
            </div>
          )}
        </>
      )}

      {tab === 'raw' && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[13px] font-medium">Prometheus /metrics</div>
            <button type="button" onClick={fetchRaw} disabled={!rawMetrics && !rawError} className="px-3 py-1.5 rounded-lg text-[13px] bg-panel2 border border-border text-ink hover:border-accent/50">
              {!rawMetrics && !rawError ? 'Fetch' : rawError ? 'Retry' : 'Refresh'}
            </button>
          </div>
          {rawError ? (
            <div className="text-danger text-[13px]">{rawError}</div>
          ) : rawMetrics ? (
            <>
              <div className="text-[11px] text-muted mb-2">{rawMetrics.split('\n').filter((l) => !l.startsWith('#') && l).length} samples</div>
              <CodeBlock maxLines={60}>{rawMetrics}</CodeBlock>
            </>
          ) : (
            <div className="text-muted text-[13px] py-4">Click "Fetch" to load /metrics.</div>
          )}
        </Card>
      )}
    </div>
  );
}
