import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';
import { usePoll, fmtRelative } from '../lib/hooks.js';
import type { Workflow, WorkflowGraph } from '../lib/types.js';
import { Button, Card, Cell, EmptyState, ErrorState, Modal, PageHeader, Row, Spinner, StatusPill, Table } from '../components/ui.js';

function GraphViz({ graph }: { graph: WorkflowGraph }) {
  if (!graph.nodes.length || !graph.edges.length) return <div className="text-muted text-[13px]">No graph defined.</div>;
  const nodePos: Record<string, { x: number; y: number }> = {};
  const nodeW = 120, nodeH = 32, hGap = 40, vGap = 70;
  const n = graph.nodes.length;
  const rows = Math.max(1, Math.ceil(n / 4));
  const cols = Math.min(n, 4);
  graph.nodes.forEach((nd, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    nodePos[nd.id] = { x: col * (nodeW + hGap) + 60, y: row * (nodeH + vGap) + 40 };
  });

  const allX = Object.values(nodePos).map((p) => p.x);
  const allY = Object.values(nodePos).map((p) => p.y);
  const w = Math.max(...allX) + 160;
  const h = Math.max(...allY) + 100;

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} className="border border-border rounded-lg bg-panel2">
        {graph.edges.map((e, i) => {
          const f = nodePos[e.from], t = nodePos[e.to];
          if (!f || !t) return null;
          const fx = f.x + nodeW, fy = f.y + nodeH / 2;
          const tx = t.x, ty = t.y + nodeH / 2;
          return (
            <g key={i}>
              <line x1={fx} y1={fy} x2={tx} y2={ty} stroke="var(--border)" strokeWidth="1.5" markerEnd="url(#arrow)" />
            </g>
          );
        })}
        {graph.nodes.map((nd) => {
          const p = nodePos[nd.id];
          if (!p) return null;
          const bg = nd.type === 'input' ? 'var(--accent)' : nd.type === 'output' ? 'var(--ok)' : nd.type === 'approval' ? 'var(--warn)' : 'var(--accent)';
          const fg = nd.type === 'agent' ? 'var(--ink)' : 'white';
          return (
            <g key={nd.id}>
              <rect x={p.x} y={p.y} width={nodeW} height={nodeH} rx={6} fill={bg} opacity={0.85} />
              <text x={p.x + nodeW / 2} y={p.y + nodeH / 2 + 4} textAnchor="middle" fill={fg} fontSize="11" fontWeight="600">
                {nd.label ?? nd.id}
              </text>
              <text x={p.x + nodeW / 2} y={p.y + nodeH / 2 + 16} textAnchor="middle" fill={fg} fontSize="9" opacity="0.8">
                {nd.type}
              </text>
              {nd.agentId ? <text x={p.x + nodeW / 2} y={p.y + nodeH / 2 + 26} textAnchor="middle" fill="var(--muted)" fontSize="8">{nd.agentId}</text> : null}
            </g>
          );
        })}
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 Z" fill="var(--border)" />
          </marker>
        </defs>
      </svg>
    </div>
  );
}

const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] };

export default function Workflows() {
  const [searchParams] = useState(() => new URLSearchParams(window.location.search));
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showRun, setShowRun] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [input, setInput] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);

  const { data, loading, refresh } = usePoll(() => api.workflows(), 4_000);

  const start = useMutation({
    mutationFn: (id: string) => api.runWorkflow(id, input),
    onSuccess: (res) => { setRunId(res.workflowRun.id); setShowRun(false); void qc.invalidateQueries(); },
    onError: (e: ApiError) => setError(e.message),
  });

  const statusLabel = (s: string) => {
    const map: Record<string, string> = { waiting_approval: 'waiting approval', queued: 'queued', running: 'running', paused: 'paused', completed: 'completed', failed: 'failed', cancelled: 'cancelled', interrupted: 'interrupted' };
    return map[s] ?? s;
  };

  return (
    <div>
      <PageHeader
        title="Workflows"
        subtitle="Multi-step orchestrations: agent nodes, approval gates, and output assembly."
        actions={<Button onClick={() => setShowRun(true)}>+ Run workflow</Button>}
      />

      {error ? <div className="mb-3 text-danger bg-danger-soft border border-danger/30 rounded-lg p-2.5 text-[13px]">{error}</div> : null}

      {showRun && (
        <Modal title="Run workflow" onClose={() => setShowRun(false)} wide>
          <div className="space-y-3">
            {runId ? (
              <div className="text-[13px]">
                Started <Link to={`/workflows/${runId}`} className="text-accent hover:underline font-mono">{runId}</Link>
                {' '}— <a href="#_" onClick={() => setShowRun(false)} className="text-muted">run another</a>
              </div>
            ) : (
              <>
                {data && data.workflows.length === 0 ? (
                  <div className="text-muted text-[13px]">No workflows defined.</div>
                ) : (
                  <div className="flex gap-2">
                    <select className="w-full bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-accent" value={runId || ''} onChange={(e) => setRunId(e.target.value || null)}>
                      <option value="">select a workflow…</option>
                      {data?.workflows.filter((w: Workflow) => w.enabled).map((w: Workflow) => (
                        <option key={w.id} value={w.id}>{w.name} ({w.id})</option>
                      ))}
                    </select>
                  </div>
                )}
                {runId && (
                  <div className="text-[12px] text-muted">
                    Provide workflow input as JSON. Leave empty for defaults.
                  </div>
                )}
                <textarea
                  className="w-full bg-panel2 border border-border rounded-lg p-2.5 text-[12px] font-mono text-ink placeholder:text-muted focus:outline-none focus:border-accent h-32 resize-y"
                  placeholder='{"query": "Find three facts about agents"}'
                  value={Object.keys(input).length ? JSON.stringify(input, null, 2) : ''}
                  onChange={(e) => { try { setInput(JSON.parse(e.target.value || '{}')); } catch { /* ignore */ } }}
                />
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => setShowRun(false)}>Cancel</Button>
                  <Button onClick={() => { if (runId) start.mutate(runId); }} disabled={!runId || start.isPending}>
                    {start.isPending ? 'Starting…' : 'Run'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      {loading && !data ? <Spinner /> : null}
      {data && data.workflows.length === 0 ? (
        <EmptyState
          title="No workflows"
          hint="Workflows are created via the API or seed data. The demo ships with a research-report workflow."
          action={<Button onClick={() => setShowRun(true)}>Run workflow</Button>}
        />
      ) : null}

      {data && data.workflows.length > 0 ? (
        <Table head={['Workflow', 'Graph', 'Status', 'Runs', 'Updated']}>
          {data.workflows.map((w: Workflow) => {
            const runCount = w.recentRuns?.length ?? 0;
            const active = w.recentRuns?.filter((r) => r.status === 'running' || r.status === 'waiting_approval' || r.status === 'queued').length ?? 0;
            return (
              <Row key={w.id} onClick={() => navigate(`/workflows/${w.id}`)}>
                <Cell>
                  <Link to={`/workflows/${w.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:text-accent">{w.name}</Link>
                  <div className="text-[11px] text-muted max-w-[240px] truncate">{w.description}</div>
                  <div className="text-[10px] text-muted font-mono mt-0.5">v{w.version} · {w.id}</div>
                </Cell>
                <Cell>
                  <div className="text-[11px]"><span className="font-mono">{w.graph.nodes.length} nodes</span> · <span className="font-mono">{w.graph.edges.length} edges</span></div>
                </Cell>
                <Cell>
                  {active > 0 ? <StatusPill status="running" label={`${active} active`} /> : <StatusPill status="completed" label={w.enabled ? 'enabled' : 'disabled'} />}
                </Cell>
                <Cell className="tabular-nums">{runCount}</Cell>
                <Cell className="text-muted text-[12px]">{fmtRelative(w.updatedAt)}</Cell>
              </Row>
            );
          })}
        </Table>
      ) : null}

      {data && data.workflows.slice(0, 3).map((w: Workflow) => (
        <Card key={w.id} className="p-4 mt-4">
          <div className="flex items-center justify-between mb-2">
            <div>
              <Link to={`/workflows/${w.id}`} className="font-medium hover:text-accent">{w.name}</Link>
              <div className="text-[11px] text-muted">{w.description}</div>
            </div>
            <StatusPill status={w.enabled ? 'completed' : 'cancelled'} label={w.enabled ? 'enabled' : 'disabled'} />
          </div>
          <GraphViz graph={w.graph} />
          <div className="flex gap-2 mt-3 justify-end">                  <Button variant="secondary" small onClick={() => { setRunId(w.id); setShowRun(true); }}>Run</Button>                  <Button variant="ghost" small onClick={() => navigate(`/workflows/${w.id}`)}>Detail</Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
