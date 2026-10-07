import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { usePoll, fmtDuration, fmtCost, fmtDateTime, fmtRelative } from '../lib/hooks.js';
import type { Workflow, WorkflowRun, WorkflowNodeRun, Run, Approval } from '../lib/types.js';
import { Button, Card, Cell, EmptyState, ErrorState, PageHeader, Row, Spinner, StatusPill, Table, Mono, CodeBlock } from '../components/ui.js';
import { Donut, ProgressBar } from '../components/charts.js';

function NodeStatusDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: 'var(--panel-2)', running: 'var(--accent)', waiting_approval: 'var(--warn)',
    completed: 'var(--ok)', failed: 'var(--danger)', skipped: 'var(--panel-2)',
  };
  return <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: map[status] ?? 'var(--panel-2)' }} />;
}

export default function WorkflowDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [openRun, setOpenRun] = useState(false);
  const [input, setInput] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const { data, loading, refresh } = usePoll(() => api.workflow(id!), 2_000, [id]);

  const start = useMutation({
    mutationFn: (id: string) => api.runWorkflow(id, input),
    onSuccess: () => { void qc.invalidateQueries(); refresh(); },
    onError: (e: any) => setError(e?.message ?? 'start failed'),
  });

  const cancelRun = useMutation({
    mutationFn: (wrId: string) => api.cancelWorkflowRun(wrId),
    onSuccess: () => { void qc.invalidateQueries(); refresh(); },
  });

  if (!id) return <Navigate to="/workflows" replace />;
  if (loading && !data) return <Spinner label="Loading workflow…" />;
  if (!data) return <EmptyState title="Workflow not found" hint={`Workflow ${id} does not exist.`} />;

  const { workflow, recentRuns, agents } = data;

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {workflow.name}
            <StatusPill status={workflow.enabled ? 'completed' : 'cancelled'} label={workflow.enabled ? 'enabled' : 'disabled'} />
          </span>
        }
        subtitle={workflow.description}
        actions={
          <>
            {workflow.enabled ? (
              <Button variant="secondary" onClick={() => setOpenRun(true)}>Run workflow</Button>
            ) : (
              <div className="text-[13px] text-muted">Disabled — enable via API to run</div>
            )}
            <Button variant="ghost" onClick={() => navigate('/workflows')}>Back</Button>
          </>
        }
      />

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Card className="p-4">
          <div className="text-[11px] uppercase text-muted tracking-wider">Nodes</div>
          <div className="text-2xl font-semibold mt-1.5 tabular-nums">{workflow.graph.nodes.length}</div>
          <div className="text-[11px] text-muted mt-1">{workflow.graph.edges.length} edges</div>
        </Card>
        <Card className="p-4">
          <div className="text-[11px] uppercase text-muted tracking-wider">Recent runs</div>
          <div className="text-2xl font-semibold mt-1.5 tabular-nums">{recentRuns.length}</div>
          <div className="text-[11px] text-muted mt-1">{recentRuns.filter((r: WorkflowRun) => r.status === 'completed').length} completed</div>
        </Card>
        <Card className="p-4">
          <div className="text-[11px] uppercase text-muted tracking-wider">Version</div>
          <div className="text-2xl font-semibold mt-1.5 tabular-nums">v{workflow.version}</div>
          <div className="text-[11px] text-muted mt-1">updated {fmtRelative(workflow.updatedAt)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-[11px] uppercase text-muted tracking-wider">ID</div>
          <div className="text-[13px] font-mono mt-1.5 truncate">{workflow.id}</div>
          <div className="text-[11px] text-muted mt-1">created {fmtRelative(workflow.createdAt)}</div>
        </Card>
      </div>

      <Card className="p-4 mb-4">
        <div className="text-[13px] font-medium mb-2">Graph</div>
        <div className="space-y-1.5">
          {workflow.graph.nodes.map((nd) => {
            const agentInfo = agents.find((a) => a.node === nd.id);
            return (
              <div key={nd.id} className="flex items-center gap-3 border border-border rounded-lg px-3 py-2">
                <NodeStatusDot status="completed" />
                <div className="flex-1">
                  <div className="text-[13px] font-medium">{nd.label ?? nd.id}</div>
                  <div className="text-[11px] text-muted">{nd.type} · {nd.agentId ?? '—'}</div>
                </div>
                {agentInfo && agentInfo.agent ? (
                  <span className="text-[12px] text-ok font-mono">{agentInfo.agent.name}</span>
                ) : nd.agentId ? (
                  <span className="text-[12px] text-danger">agent not found</span>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>

      <div className="mb-4">
        <div className="text-[13px] font-medium mb-2">Recent runs</div>
        {recentRuns.length === 0 ? (
          <div className="text-muted text-[13px] py-4">No runs yet. Hit "Run workflow".</div>
        ) : (
          <Table head={['Run', 'Status', 'Input', 'Output', 'Error', 'Started', 'Duration']}>
            {recentRuns.map((r: WorkflowRun) => {
              const active = r.status === 'running' || r.status === 'waiting_approval' || r.status === 'queued';
              return (
                <Row key={r.id} onClick={() => navigate(`/workflows/${r.id}`)}>
                  <Cell className="font-mono text-[12px]"><span className="hover:text-accent">{r.id}</span></Cell>
                  <Cell><StatusPill status={r.status} /></Cell>
                  <Cell className="text-[11px] text-muted max-w-[160px] truncate font-mono">
                    {Object.keys(r.input).length ? JSON.stringify(r.input).slice(0, 60) + '…' : '—'}
                  </Cell>
                  <Cell className="text-[11px] text-muted max-w-[160px] truncate font-mono">
                    {r.output ? JSON.stringify(r.output).slice(0, 60) + '…' : '—'}
                  </Cell>
                  <Cell className="text-[11px] text-danger max-w-[160px] truncate">{r.error ?? '—'}</Cell>
                  <Cell className="text-[12px] text-muted">{r.startedAt ? fmtRelative(r.startedAt) : '—'}</Cell>
                  <Cell className="text-[12px] text-muted tabular-nums">
                    {r.startedAt && r.endedAt ? fmtDuration(r.endedAt - r.startedAt) : '—'}
                  </Cell>
                </Row>
              );
            })}
          </Table>
        )}
      </div>

      {error ? <div className="mb-3 text-danger bg-danger-soft border border-danger/30 rounded-lg p-2.5 text-[13px]">{error}</div> : null}

      {openRun && (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 overflow-y-auto bg-black/50" onClick={() => setOpenRun(false)}>
          <div className="bg-panel border border-border rounded-xl shadow-2xl w-full max-w-xl mt-8" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
              <h2 className="font-semibold text-[15px]">Run workflow — {workflow.name}</h2>
              <button onClick={() => setOpenRun(false)} className="text-muted hover:text-ink text-lg leading-none px-1">×</button>
            </div>
            <div className="p-5 space-y-3">
              <div className="text-[12px] text-muted">Provide input as JSON (leave empty for defaults).</div>
              <textarea
                className="w-full bg-panel2 border border-border rounded-lg p-2.5 text-[12px] font-mono text-ink placeholder:text-muted focus:outline-none focus:border-accent h-32 resize-y"
                placeholder='{"query": "Find three facts about agents"}'
                value={Object.keys(input).length ? JSON.stringify(input, null, 2) : ''}
                onChange={(e) => { try { setInput(JSON.parse(e.target.value || '{}')); } catch { /* ignore */ } }}
              />
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setOpenRun(false)}>Cancel</Button>
                <Button onClick={() => { start.mutate(workflow.id); setOpenRun(false); }} disabled={start.isPending}>
                  {start.isPending ? 'Starting…' : 'Run'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
