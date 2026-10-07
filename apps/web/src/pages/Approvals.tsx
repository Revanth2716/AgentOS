import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';
import { usePoll, fmtRelative } from '../lib/hooks.js';
import type { Approval } from '../lib/types.js';
import { Button, Card, Cell, EmptyState, ErrorState, PageHeader, Row, Spinner, StatusPill, Table } from '../components/ui.js';

type Filter = 'all' | 'pending' | 'approved' | 'denied';

export default function Approvals() {
  const [filter, setFilter] = useState<Filter>('pending');
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const { data, loading, refresh } = usePoll(() => api.approvals(filter === 'all' ? undefined : filter), 2_000, [filter]);

  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => api.decideApproval(id, approve),
    onSuccess: () => { void qc.invalidateQueries(); refresh(); },
    onError: (e: ApiError) => setError(e.message),
  });

  const statusCounts = data ? {
    pending: data.approvals.filter((a: Approval) => a.status === 'pending').length,
    approved: data.approvals.filter((a: Approval) => a.status === 'approved').length,
    denied: data.approvals.filter((a: Approval) => a.status === 'denied').length,
  } : { pending: 0, approved: 0, denied: 0 };

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle="Human-verification gates for tool execution, workflow gates, and human-intervention events."
        actions={
          <div className="flex gap-1.5">
            {(['pending', 'approved', 'denied', 'all'] as Filter[]).map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)} className={`px-3 py-1.5 rounded-lg text-[13px] ${filter === f ? 'bg-accent-soft text-accent font-medium' : 'text-muted hover:text-ink hover:bg-panel2'}`}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
              {statusCounts[f as keyof typeof statusCounts] ? (
                <span className="ml-1 text-muted">{statusCounts[f as keyof typeof statusCounts]}</span>
              ) : null}
            </button>
            ))}
          </div>
        }
      />

      {error ? <div className="mb-3 text-danger bg-danger-soft border border-danger/30 rounded-lg p-2.5 text-[13px]">{error}</div> : null}
      {loading && !data ? <Spinner /> : null}
      {data && data.approvals.length === 0 ? (
        <EmptyState
          title={filter === 'pending' ? 'No pending approvals' : filter === 'all' ? 'No approvals recorded' : `No ${filter} approvals`}
          hint={filter === 'pending' ? 'Approval-gated actions will appear here when an agent requests permission.' : undefined}
        />
      ) : null}

      {data && data.approvals.length > 0 ? (
        <Table head={['Approval', 'Run', 'Tool', 'Kind', 'Summary', 'Status', 'Requested', 'Decided']}>
          {data.approvals.map((a: Approval) => (
            <Row key={a.id}>
              <Cell className="font-mono text-[12px]">{a.id}</Cell>
              <Cell className="font-mono text-[12px]">{a.runId ?? a.workflowRunId ?? '—'}</Cell>
              <Cell className="font-mono text-[12px]">{a.tool}</Cell>
              <Cell className="text-[11px] uppercase text-muted">{a.kind.replaceAll('_', ' ')}</Cell>
              <Cell className="max-w-[280px] truncate text-muted text-[12px]"><span title={a.summary}>{a.summary}</span></Cell>
              <Cell><StatusPill status={a.status} /></Cell>
              <Cell className="text-[12px] text-muted">{fmtRelative(a.requestedAt)}</Cell>
              <Cell className="text-[12px] text-muted">{a.decidedAt ? fmtRelative(a.decidedAt) : '—'}</Cell>
            </Row>
          ))}
        </Table>
      ) : null}

      {data && data.approvals.filter((a: Approval) => a.status === 'pending').length > 0 && (
        <div className="mt-5">
          <div className="text-[13px] font-medium mb-3">Decide</div>
          {data.approvals.filter((a: Approval) => a.status === 'pending').map((a: Approval) => (
            <Card key={a.id} className="p-4 mb-3 border-warn/30 bg-warn-soft/30">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-[13px] font-medium">{a.id}</span>
                    <StatusPill status={a.status} />
                    <span className="text-[11px] uppercase text-muted">{a.kind.replaceAll('_', ' ')}</span>
                  </div>
                  <div className="text-[12px] font-mono text-accent font-medium mb-1">{a.tool}</div>
                  <div className="text-[13px] mb-1">{a.summary}</div>
                  <details className="mt-1">
                    <summary className="text-[11px] text-muted cursor-pointer hover:text-ink">Arguments</summary>
                    <div className="bg-panel2 border border-border rounded-lg p-2.5 mt-1 text-[12px] font-mono text-muted max-h-48 overflow-auto">
                      {JSON.stringify(a.args, null, 2)}
                    </div>
                  </details>
                  <div className="text-[11px] text-muted mt-2 font-mono">requested {fmtRelative(a.requestedAt)}</div>
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <Button small onClick={() => decide.mutate({ id: a.id, approve: true })} disabled={decide.isPending}>
                    {decide.isPending ? '…' : 'Approve'}
                  </Button>
                  <Button small variant="danger" onClick={() => decide.mutate({ id: a.id, approve: false })} disabled={decide.isPending}>
                    {decide.isPending ? '…' : 'Deny'}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {data && data.approvals.filter((a: Approval) => a.status !== 'pending').length > 0 && (
        <div className="mt-5">
          <div className="text-[13px] font-medium mb-3">History</div>
          <Table head={['Approval', 'Run', 'Tool', 'Kind', 'Status', 'Requested', 'Decided', 'Decided by']}>
            {data.approvals.filter((a: Approval) => a.status !== 'pending').map((a: Approval) => (
              <Row key={a.id}>
                <Cell className="font-mono text-[12px]">{a.id}</Cell>
                <Cell className="font-mono text-[12px]">{a.runId ?? a.workflowRunId ?? '—'}</Cell>
                <Cell className="font-mono text-[12px]">{a.tool}</Cell>
                <Cell className="text-[11px] uppercase text-muted">{a.kind.replaceAll('_', ' ')}</Cell>
                <Cell><StatusPill status={a.status} /></Cell>
                <Cell className="text-[12px] text-muted">{fmtRelative(a.requestedAt)}</Cell>
                <Cell className="text-[12px] text-muted">{a.decidedAt ? fmtRelative(a.decidedAt) : '—'}</Cell>
                <Cell className="text-[12px] text-muted">{a.decidedBy ?? '—'}</Cell>
              </Row>
            ))}
          </Table>
        </div>
      )}
    </div>
  );
}
