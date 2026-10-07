import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { usePoll, useSse, fmtCost, fmtDuration, fmtTokens, fmtRelative } from '../lib/hooks.js';
import { Card, Cell, EmptyState, ErrorState, PageHeader, Row, Spinner, StatCard, StatusPill, Table } from '../components/ui.js';
import { BarSeries, Donut, Sparkline } from '../components/charts.js';

export default function Dashboard() {
  const summary = usePoll(() => api.summary(), 4_000);
  const runs = usePoll(() => api.runs({ limit: 8 }), 4_000);
  const ts = usePoll(() => api.timeseries(14), 30_000);
  const { connected, lastEvent } = useSse('/api/v1/events/stream');
  const approvals = usePoll(() => api.approvals('pending'), 4_000);

  if (summary.loading && !summary.data) return <Spinner label="Loading dashboard…" />;
  if (summary.error && !summary.data) return <ErrorState message={summary.error} onRetry={summary.refresh} />;
  const s = summary.data!;

  const successRate =
    s.runs.completed + s.runs.failed > 0 ? s.runs.completed / (s.runs.completed + s.runs.failed) : 1;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={
          s.demoMode ? (
            <span className="text-ok font-medium">Demo mode — deterministic, offline, estimated cost $0.00</span>
          ) : (
            'Live provider mode'
          )
        }
        actions={
          <span className="text-[12px] text-muted flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-ok' : 'bg-danger'}`} />
            {connected ? 'live' : 'disconnected'}
            {lastEvent ? <span className="ml-2 font-mono text-[11px] opacity-60">{lastEvent.type}</span> : null}
          </span>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 mb-4">
        <StatCard label="Agents" value={s.agents.total} sub={`${s.agents.enabled} enabled`} />
        <StatCard label="Active runs" value={s.runs.active} tone={s.runs.active > 0 ? 'accent' : 'default'} sub={`${s.runs.today} today`} />
        <StatCard label="Succeeded" value={s.runs.completed} tone="ok" sub={`${Math.round(successRate * 100)}% success rate`} />
        <StatCard label="Failed" value={s.runs.failed} tone={s.runs.failed > 0 ? 'danger' : 'default'} sub={`${s.runs.cancelled} cancelled`} />
        <StatCard
          label="Approvals pending"
          value={s.policy.pendingApprovals}
          tone={s.policy.pendingApprovals > 0 ? 'warn' : 'default'}
          sub={<Link to="/approvals" className="text-accent hover:underline">review →</Link>}
        />
        <StatCard label="Tool calls" value={s.toolCalls.today} sub={`${s.toolCalls.failures} failed today`} />
        <StatCard label="Avg latency" value={fmtDuration(s.avgLatencyMs)} sub="completed runs" />
        <StatCard label="Policy blocks" value={s.policy.blocksAllTime} tone={s.policy.blocksAllTime > 0 ? 'danger' : 'ok'} sub={`${s.policy.blocksToday} today`} />
        <StatCard label="Est. cost today" value={fmtCost(s.cost.todayUsd)} tone="ok" sub={`${fmtTokens(s.cost.tokensToday)} tokens · ${s.cost.mockCalls} mock / ${s.cost.cloudCalls} cloud`} />
        <StatCard
          label="Evaluation"
          value={s.evaluation.successRate === null ? '—' : `${Math.round(s.evaluation.successRate * 100)}%`}
          tone={s.evaluation.successRate !== null && s.evaluation.successRate >= 0.9 ? 'ok' : 'warn'}
          sub={s.evaluation.runId ? <Link to="/evaluations" className="text-accent hover:underline">suite results →</Link> : 'no runs yet'}
        />
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <Card className="p-4 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[13px] font-medium">Runs per day (14d)</div>
            <div className="text-[11px] text-muted">{ts.data ? ts.data.runs.reduce((a, r) => a + r.runs, 0) : 0} runs</div>
          </div>
          <BarSeries
            data={(ts.data?.runs ?? []).map((r) => ({ label: r.day.slice(5), value: r.runs - r.failed, secondary: r.failed }))}
            labels
          />
          <div className="flex gap-4 text-[11px] text-muted mt-3">
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--accent)' }} /> completed</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--danger)' }} /> failed</span>
          </div>
        </Card>

        <Card className="p-4">
          <div className="text-[13px] font-medium mb-3">Cost locality (today)</div>
          <div className="flex items-center gap-4">
            <Donut value={s.cost.mockCalls + s.cost.localCalls + s.cost.cloudCalls > 0 ? (s.cost.mockCalls + s.cost.localCalls) / (s.cost.mockCalls + s.cost.localCalls + s.cost.cloudCalls) : 1} />
            <div className="text-[12px] space-y-1.5">
              <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full" style={{ background: 'var(--ok)' }} /> MOCK {s.cost.mockCalls}</div>
              <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full" style={{ background: 'var(--accent)' }} /> LOCAL {s.cost.localCalls}</div>
              <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full" style={{ background: 'var(--warn)' }} /> CLOUD {s.cost.cloudCalls}</div>
              <div className="pt-1 border-t border-border text-muted">Total: <span className="text-ok font-semibold">{fmtCost(s.cost.allTimeUsd)}</span></div>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="p-4 lg:col-span-2">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[13px] font-medium">Recent runs</div>
            <Link to="/runs" className="text-[12px] text-accent hover:underline">all runs →</Link>
          </div>
          {runs.loading && !runs.data ? <Spinner /> : null}
          {runs.data?.runs.length === 0 ? (
            <EmptyState title="No runs yet" hint="Run an agent from the Agents page or start the research-report workflow." />
          ) : (
            <Table head={['Run', 'Agent', 'Task', 'Status', 'Steps', 'Latency', 'Cost']}>
              {runs.data?.runs.map((r) => (
                <Row key={r.id} onClick={() => (window.location.href = `/runs/${r.id}`)}>
                  <Cell className="font-mono text-[12px]"><Link to={`/runs/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.id}</Link></Cell>
                  <Cell>{r.agentId}</Cell>
                  <Cell className="max-w-[240px] truncate text-muted">{r.task}</Cell>
                  <Cell><StatusPill status={r.status} /></Cell>
                  <Cell className="tabular-nums">{r.steps}</Cell>
                  <Cell className="tabular-nums text-muted">{fmtDuration(r.endedAt && r.startedAt ? r.endedAt - r.startedAt : null)}</Cell>
                  <Cell className="text-ok tabular-nums">{fmtCost(r.costUsd)}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>

        <Card className="p-4">
          <div className="text-[13px] font-medium mb-3">Pending approvals</div>
          {approvals.data && approvals.data.approvals.length > 0 ? (
            <div className="space-y-2.5">
              {approvals.data.approvals.slice(0, 5).map((a) => (
                <Link key={a.id} to="/approvals" className="block bg-warn-soft border border-warn/30 rounded-lg p-3 hover:border-warn/60">
                  <div className="text-[12px] font-semibold text-warn">{a.tool}</div>
                  <div className="text-[11px] text-muted mt-0.5 truncate">{a.summary}</div>
                  <div className="text-[10px] text-muted mt-1">{fmtRelative(a.requestedAt)}</div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="text-[13px] text-muted py-6 text-center">No pending approvals<br /><span className="text-[11px]">Approval-gated actions will appear here.</span></div>
          )}
          <div className="mt-4 pt-3 border-t border-border">
            <div className="flex items-center justify-between text-[12px] text-muted mb-2">
              <span>Run throughput</span>
              <span>{s.runs.total} total</span>
            </div>
            <Sparkline points={(ts.data?.runs ?? []).map((r) => r.runs)} />
          </div>
        </Card>
      </div>
    </div>
  );
}
