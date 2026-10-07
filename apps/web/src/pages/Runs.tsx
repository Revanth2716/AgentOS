import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';
import { usePoll, fmtDuration, fmtCost, fmtRelative } from '../lib/hooks.js';
import type { Run } from '../lib/types.js';
import { Button, Cell, EmptyState, ErrorState, PageHeader, Row, Spinner, StatusPill, Table } from '../components/ui.js';

export default function Runs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = (searchParams.get('status') as Run['status'] | null) ?? null;
  const agentId = searchParams.get('agentId') ?? undefined;
  const [q, setQ] = useState({ status: status ?? undefined, agentId });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showFilters, setShowFilters] = useState(false);
  const { data, error, loading, refresh } = usePoll(() => api.runs(q), 3_000, [q.status, q.agentId]);

  const statusOptions: Run['status'][] = ['queued', 'running', 'waiting_approval', 'paused', 'completed', 'failed', 'cancelled', 'interrupted'];

  const setStatus = (s: string) => {
    const next: Record<string, string> = {};
    if (s) next.status = s; else delete (next as any).status;
    if (q.agentId) next.agentId = q.agentId; else delete (next as any).agentId;
    setSearchParams(next as any);
    setQ({ status: s ? (s as Run['status']) : undefined, agentId: q.agentId });
  };

  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelRun(id),
    onSuccess: () => void qc.invalidateQueries(),
  });

  return (
    <div>
      <PageHeader
        title="Runs"
        subtitle="Agent execution records — each run is a full trace of steps, tools, policy decisions, and approvals."
        actions={
          <>
            <Button variant="secondary" onClick={() => setShowFilters(!showFilters)}>
              {showFilters ? 'Hide filters' : 'Filters'}
            </Button>
            <input className={`${'w-full bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:border-accent'} !w-48`}
              placeholder="search runs…" value={q.agentId ?? ''} onChange={(e) => setQ({ ...q, agentId: e.target.value || undefined })} />
          </>
        }
      />

      {showFilters && (
        <div className="flex flex-wrap gap-2 mb-4 pb-4 border-b border-border">
          <span className="text-[12px] text-muted">Status:</span>
          {statusOptions.map((s) => (
            <Button key={s} small variant={q.status === s ? 'secondary' : 'ghost'} onClick={() => setStatus(q.status === s ? '' : s)}>
              {s.replaceAll('_', ' ')}
            </Button>
          ))}
          <div className="flex-1" />
          <Button variant="ghost" small onClick={() => { setQ({ status: undefined, agentId: undefined }); setSearchParams({}); }}>Clear</Button>
        </div>
      )}

      {error && !data ? <ErrorState message={error} onRetry={refresh} /> : null}
      {loading && !data ? <Spinner /> : null}
      {data && data.runs.length === 0 ? (
        <EmptyState title="No runs found" hint="Run an agent from the Agents page, or start a workflow. Use filters to narrow the list." />
      ) : null}
      {data && data.runs.length > 0 ? (
        <Table head={['Run', 'Agent', 'Task', 'Status', 'Mode', 'Steps', 'Tools', 'Failures', 'Retries', 'Duration', 'Cost', 'Started']}>
          {data.runs.map((r: Run) => (
            <Row key={r.id} onClick={() => navigate(`/runs/${r.id}`)}>
              <Cell className="font-mono text-[12px]"><Link to={`/runs/${r.id}`} onClick={(e) => e.stopPropagation()} className="hover:text-accent">{r.id}</Link></Cell>
              <Cell className="font-mono text-[12px]">{r.agentId}</Cell>
              <Cell className="max-w-[260px] truncate text-muted">{r.task}</Cell>
              <Cell><StatusPill status={r.status} /></Cell>
              <Cell className="text-[11px] uppercase text-muted">{r.mode}</Cell>
              <Cell className="tabular-nums">{r.steps}</Cell>
              <Cell className="tabular-nums text-muted">{r.toolCalls}</Cell>
              <Cell className={`tabular-nums ${r.toolFailures > 0 ? 'text-danger' : 'text-muted'}`}>{r.toolFailures}</Cell>
              <Cell className="tabular-nums text-muted">{r.retries}</Cell>
              <Cell className="tabular-nums text-muted">{fmtDuration(r.endedAt && r.startedAt ? r.endedAt - r.startedAt : null)}</Cell>
              <Cell className="tabular-nums text-ok">{fmtCost(r.costUsd)}</Cell>
              <Cell className="text-muted text-[12px]">{r.startedAt ? fmtRelative(r.startedAt) : '—'}</Cell>
            </Row>
          ))}
        </Table>
      ) : null}

      {data && data.total !== undefined && data.runs.length > 0 && (
        <div className="mt-3 text-[12px] text-muted">
          {data.total} run{data.total === 1 ? '' : 's'} total
          {q.status ? ` · filtered by status: ${q.status.replaceAll('_', ' ')}` : ''}
          {q.agentId ? ` · agent: ${q.agentId}` : ''}
        </div>
      )}
    </div>
  );
}
