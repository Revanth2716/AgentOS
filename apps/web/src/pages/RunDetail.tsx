import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { usePoll, fmtDuration, fmtCost, fmtDateTime, fmtRelative } from '../lib/hooks.js';
import type { Run, RunEvent, PolicyDecision, Approval, RunMetrics } from '../lib/types.js';
import { Button, Card, Cell, CodeBlock, EmptyState, PageHeader, Row, Spinner, StatusPill, Table, Mono } from '../components/ui.js';
import { Donut } from '../components/charts.js';

const EVENT_ICON: Record<string, string> = {
  task_received: '▶',
  model_called: '☁',
  model_completed: '✓',
  tool_called: '⚒',
  tool_completed: '✓',
  tool_failed: '✗',
  policy_check: '⛨',
  policy_blocked: '✗',
  approval_requested: '✓',
  approval_granted: '✓',
  approval_denied: '✗',
  run_completed: '◆',
  run_failed: '✗',
  run_cancelled: '■',
  retry: '↻',
  evaluation_started: '≡',
  evaluation_case_passed: '✓',
  evaluation_case_failed: '✗',
};

const EVENT_COLOR: Record<string, string> = {
  task_received: 'var(--muted)',
  model_called: 'var(--accent)',
  model_completed: 'var(--ok)',
  tool_called: 'var(--accent)',
  tool_completed: 'var(--ok)',
  tool_failed: 'var(--danger)',
  policy_check: 'var(--warn)',
  policy_blocked: 'var(--danger)',
  approval_requested: 'var(--warn)',
  approval_granted: 'var(--ok)',
  approval_denied: 'var(--danger)',
  run_completed: 'var(--ok)',
  run_failed: 'var(--danger)',
  run_cancelled: 'var(--muted)',
  retry: 'var(--warn)',
  evaluation_started: 'var(--accent)',
  evaluation_case_passed: 'var(--ok)',
  evaluation_case_failed: 'var(--danger)',
};

function EventTimeline({ events }: { events: RunEvent[] }) {
  if (events.length === 0) return <div className="text-muted text-[13px] py-4">No events recorded yet.</div>;
  const max = events.length;
  const shown = events.slice(0, 80);
  return (
    <div className="space-y-0.5">
      {shown.map((e, i) => {
        const idx = events.indexOf(e);
        const pct = max > 1 ? (idx / (max - 1)) * 100 : 50;
        const icon = EVENT_ICON[e.type] ?? '•';
        const color = EVENT_COLOR[e.type] ?? 'var(--muted)';
        const dur = e.durationMs ? ` · ${e.durationMs}ms` : '';
        return (
          <div key={e.id ?? `${e.runId}-${e.seq}-${i}`} className="flex gap-3 relative">
            <div className="flex-1 flex gap-2.5 items-start">
              <div className="flex-1 border-l-2 border-transparent ml-0" style={{ borderColor: color }} />
              <div className="pt-0.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px]" style={{ color }}>{icon}</span>
                  <span className="text-[12px] font-medium text-ink">{e.type.replaceAll('_', ' ')}</span>
                  {e.tool ? <Mono className="text-[11px] text-muted">· {e.tool}</Mono> : null}
                  {e.status ? <StatusPill status={e.status} label={e.status.replaceAll('_', ' ')} /> : null}
                </div>
                <div className="text-[11px] text-muted mt-0.5 font-mono">
                  {e.seq}. {fmtDateTime(e.ts)} {dur}
                </div>
                {e.payload ? (
                  <details className="mt-1">
                    <summary className="text-[10px] text-muted cursor-pointer hover:text-ink">payload</summary>
                    <div className="bg-panel2 border border-border rounded-lg p-2 mt-1 text-[11px] font-mono text-muted max-h-40 overflow-auto">
                      {JSON.stringify(e.payload, null, 2)}
                    </div>
                  </details>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
      {events.length > 80 ? (
        <div className="text-[11px] text-muted p-2 border border-border rounded-lg bg-panel2">
          … and {events.length - 80} more events (showing first 80)
        </div>
      ) : null}
    </div>
  );
}

export default function RunDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<'events' | 'decisions' | 'approvals' | 'metrics' | 'eval'>('events');
  const { data, error, loading, refresh } = usePoll(() => api.run(id!), 1_500, [id]);
  const cancel = useMutation({ mutationFn: (id: string) => api.cancelRun(id), onSuccess: () => void qc.invalidateQueries() });
  const replay = useMutation({
    mutationFn: (id: string) => api.replayRun(id),
    onSuccess: () => void qc.invalidateQueries(),
    onError: (e: any) => setError(e?.message ?? 'replay failed'),
  });

  const [errorMsg, setError] = useState<string | null>(null);

  if (!id) return <Navigate to="/runs" replace />;
  if (loading && !data) return <Spinner label="Loading run…" />;
  if (error && !data) return <Spinner label="Run unavailable" />;
  if (!data) return <EmptyState title="Run not found" hint={`Run ${id} does not exist.`} />;

  const { run, agentName, events, decisions, approvals, metrics, evalResults, isReplay } = data;
  const activeTabs: Array<{ id: typeof expanded; label: string }> = [
    { id: 'events', label: 'Timeline' },
    { id: 'decisions', label: 'Decisions' },
    { id: 'approvals', label: 'Approvals' },
    { id: 'metrics', label: 'Metrics' },
    { id: 'eval', label: 'Eval' },
  ];

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span className="font-mono text-[13px]">{run.id}</span>
            <StatusPill status={run.status} />
            {isReplay ? <span className="text-[11px] bg-accent-soft text-accent px-2 py-0.5 rounded-full">replay</span> : null}
          </span>
        }
        subtitle={`${agentName} · ${run.task}`}
        actions={
          <>
            {run.status === 'running' || run.status === 'queued' || run.status === 'waiting_approval' || run.status === 'paused' ? (
              <Button variant="danger" onClick={() => { if (confirm(`Cancel run ${run.id}?`)) cancel.mutate(run.id); }} disabled={cancel.isPending}>
                {cancel.isPending ? 'Cancelling…' : 'Cancel'}
              </Button>
            ) : null}
            {run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled' ? (
              <Button variant="secondary" onClick={() => replay.mutate(run.id)} disabled={replay.isPending}>
                {replay.isPending ? 'Replaying…' : 'Replay'}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => navigate('/runs')}>Back</Button>
          </>
        }
      />

      {errorMsg ? (
        <div className="mb-3 text-danger bg-danger-soft border border-danger/30 rounded-lg p-3 text-[13px]">{errorMsg}</div>
      ) : null}

      <div className="grid lg:grid-cols-4 gap-3 mb-4">
        <Card className="p-4">
          <div className="text-[11px] uppercase text-muted tracking-wider mb-2">Status</div>
          <div className="text-lg font-semibold"><StatusPill status={run.status} /></div>
          <div className="text-[12px] text-muted mt-2 font-mono">{run.mode.toUpperCase()} · seed {run.seed}</div>
        </Card>
        <Card className="p-4">
          <div className="text-[11px] uppercase text-muted tracking-wider mb-2">Steps</div>
          <div className="text-2xl font-semibold mt-1.5 tabular-nums">{run.steps}</div>
          <div className="text-[11px] text-muted mt-1">of {run.agentId && run.status !== 'completed' ? '—' : run.steps} completed</div>
        </Card>
        <Card className="p-4">
          <div className="text-[11px] uppercase text-muted tracking-wider mb-2">Tool calls</div>
          <div className="text-2xl font-semibold mt-1.5 tabular-nums">{run.toolCalls}</div>
          <div className="text-[11px] text-muted mt-1">{run.toolFailures} failed · {run.retries} retries</div>
        </Card>
        <Card className="p-4">
          <div className="text-[11px] uppercase text-muted tracking-wider mb-2">Est. cost</div>
          <div className="text-2xl font-semibold mt-1.5 text-ok tabular-nums">{fmtCost(run.costUsd)}</div>
          <div className="text-[11px] text-muted mt-1">{run.tokensIn + run.tokensOut} tokens · {run.provider}</div>
        </Card>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {activeTabs.map((t) => (
          <Button key={t.id} variant={expanded === t.id ? 'secondary' : 'ghost'} small onClick={() => setExpanded(t.id)}>
            {t.label}
            {(t.id === 'events' && events.length) || (t.id === 'decisions' && decisions.length) || (t.id === 'approvals' && approvals.length) ? (
              <span className="ml-1 text-muted">({t.id === 'events' ? events.length : t.id === 'decisions' ? decisions.length : approvals.length})</span>
            ) : null}
          </Button>
        ))}
      </div>

      <Card className="p-4">
        {expanded === 'events' && <EventTimeline events={events} />}
        {expanded === 'decisions' && (
          <div>
            {decisions.length === 0 ? (
              <div className="text-muted text-[13px] py-4">No policy decisions recorded.</div>
            ) : (
              <Table head={['#', 'Tool', 'Decision', 'Rule', 'Reason']}>
                {decisions.map((d: PolicyDecision) => (
                  <Row key={d.id}>
                    <Cell className="font-mono text-[12px]">{d.id}</Cell>
                    <Cell className="font-mono text-[12px]">{d.tool}</Cell>
                    <Cell><StatusPill status={d.decision} label={d.decision.replaceAll('_', ' ')} /></Cell>
                    <Cell className="text-[11px] text-muted max-w-[200px] truncate">{d.rule ?? '—'}</Cell>
                    <Cell className="text-[11px] text-muted">{d.reason}</Cell>
                  </Row>
                ))}
              </Table>
            )}
          </div>
        )}
        {expanded === 'approvals' && (
          <div>
            {approvals.length === 0 ? (
              <div className="text-muted text-[13px] py-4">No approvals recorded for this run.</div>
            ) : (
              <Table head={['Approval', 'Tool', 'Kind', 'Status', 'Requested', 'Decided', 'Decided by']}>
                {approvals.map((a: Approval) => (
                  <Row key={a.id}>
                    <Cell className="font-mono text-[12px]">{a.id}</Cell>
                    <Cell className="font-mono text-[12px]">{a.tool}</Cell>
                    <Cell className="text-[11px] uppercase text-muted">{a.kind.replaceAll('_', ' ')}</Cell>
                    <Cell><StatusPill status={a.status} /></Cell>
                    <Cell className="text-muted text-[12px]">{fmtRelative(a.requestedAt)}</Cell>
                    <Cell className="text-muted text-[12px]">{fmtRelative(a.decidedAt)}</Cell>
                    <Cell className="text-muted text-[12px]">{a.decidedBy ?? '—'}</Cell>
                  </Row>
                ))}
              </Table>
            )}
          </div>
        )}
        {expanded === 'metrics' && (
          <div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <div className="border border-border rounded-lg p-3"><div className="text-[11px] text-muted uppercase tracking-wider">Completed</div><div className="text-lg font-semibold mt-1 tabular-nums">{metrics.completed ? 'Yes' : 'No'}</div></div>
              <div className="border border-border rounded-lg p-3"><div className="text-[11px] text-muted uppercase tracking-wider">Tools success</div><div className="text-lg font-semibold mt-1 tabular-nums">{metrics.toolSuccessRate.toFixed(0)}%</div></div>
              <div className="border border-border rounded-lg p-3"><div className="text-[11px] text-muted uppercase tracking-wider">Policy violations</div><div className="text-lg font-semibold mt-1 tabular-nums">{metrics.policyViolations}</div></div>
              <div className="border border-border rounded-lg p-3"><div className="text-[11px] text-muted uppercase tracking-wider">Recovery rate</div><div className="text-lg font-semibold mt-1 tabular-nums">{metrics.recoveryRate.toFixed(0)}%</div></div>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="border border-border rounded-lg p-3"><div className="text-[11px] text-muted">Duration</div><div className="text-[15px] font-semibold mt-1 tabular-nums">{fmtDuration(metrics.durationMs ? metrics.durationMs : undefined)}</div></div>
              <div className="border border-border rounded-lg p-3"><div className="text-[11px] text-muted">Tokens in</div><div className="text-[15px] font-semibold mt-1 tabular-nums">{run.tokensIn.toLocaleString()}</div></div>
              <div className="border border-border rounded-lg p-3"><div className="text-[11px] text-muted">Tokens out</div><div className="text-[15px] font-semibold mt-1 tabular-nums">{run.tokensOut.toLocaleString()}</div></div>
              <div className="border border-border rounded-lg p-3"><div className="text-[11px] text-muted">Cost</div><div className="text-[15px] font-semibold mt-1 text-ok tabular-nums">{fmtCost(metrics.costUsd)}</div></div>
            </div>
            <div className="mt-4 pt-3 border-t border-border">
              <div className="text-[13px] font-medium mb-2">Steps budget</div>
              <div className="h-2 bg-panel2 rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-none ${run.steps >= 10 ? 'bg-warn' : 'bg-ok'}`} style={{ width: `${Math.min(100, (run.steps / 10) * 100)}%` }} />
              </div>
              <div className="text-[11px] text-muted mt-1 text-right">{run.steps} / 10 steps used</div>
            </div>
          </div>
        )}
        {expanded === 'eval' && (
          <div>
            {evalResults.length === 0 ? (
              <div className="text-muted text-[13px] py-4">No evaluation results for this run.</div>
            ) : (
              <Table head={['Case', 'Status', 'Run', 'Failure reason']}>
                {evalResults.map((r) => (
                  <Row key={r.evalRunId + r.caseId}>
                    <Cell className="text-[12px]">{r.caseId}</Cell>
                    <Cell><StatusPill status={r.passed ? 'pass' : 'fail'} label={r.passed ? 'passed' : 'failed'} /></Cell>
                    <Cell className="font-mono text-[12px]">{'—'}</Cell>
                    <Cell className="text-[11px] text-danger max-w-[260px] truncate">{r.failureReason ? String(r.failureReason) : '—'}</Cell>
                  </Row>
                ))}
              </Table>
            )}
          </div>
        )}
      </Card>

      {run.error ? (
        <Card className="p-4 mt-4 border-danger/40 bg-danger-soft">
          <div className="text-[13px] font-medium text-danger mb-2">Error</div>
          <CodeBlock>{run.error}</CodeBlock>
        </Card>
      ) : null}

      {run.finalResult ? (
        <Card className="p-4 mt-4">
          <div className="text-[13px] font-medium mb-2">Final result</div>
          <CodeBlock maxLines={40}>{run.finalResult}</CodeBlock>
        </Card>
      ) : null}

      <Card className="p-4 mt-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[13px] font-medium">Metadata</div>
          <Link to={`/runs?agentId=${run.agentId}`} className="text-[12px] text-accent hover:underline">filter by agent →</Link>
        </div>
        <Table head={['Field', 'Value']}>
          <Row><Cell className="font-mono text-[12px]">runId</Cell><Cell className="font-mono text-[12px]">{run.id}</Cell></Row>
          <Row><Cell className="font-mono text-[12px]">agentId</Cell><Cell className="font-mono text-[12px]">{run.agentId}</Cell></Row>
          <Row><Cell className="font-mono text-[12px]">workflowRunId</Cell><Cell className="font-mono text-[12px]">{run.workflowRunId ?? '—'}</Cell></Row>
          <Row><Cell className="font-mono text-[12px]">traceId</Cell><Cell className="font-mono text-[12px]">{run.traceId ?? '—'}</Cell></Row>
          <Row><Cell className="font-mono text-[12px]">createdAt</Cell><Cell className="font-mono text-[12px]">{fmtDateTime(run.createdAt)}</Cell></Row>
          <Row><Cell className="font-mono text-[12px]">startedAt</Cell><Cell className="font-mono text-[12px]">{fmtDateTime(run.startedAt)}</Cell></Row>
          <Row><Cell className="font-mono text-[12px]">endedAt</Cell><Cell className="font-mono text-[12px]">{fmtDateTime(run.endedAt)}</Cell></Row>
        </Table>
      </Card>
    </div>
  );
}
