import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { usePoll, fmtCost, fmtDuration } from '../lib/hooks.js';
import { Button, Card, Cell, CodeBlock, ErrorState, PageHeader, Row, RiskBadge, Spinner, StatusPill, Table } from '../components/ui.js';
import { Donut } from '../components/charts.js';
import { AgentForm, RunDialog } from './Agents.js';

export default function AgentDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const { data, error, loading, refresh } = usePoll(() => api.agent(id), 4_000, [id]);

  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) => api.setAgentEnabled(id, enabled),
    onSuccess: () => void qc.invalidateQueries(),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAgent(id),
    onSuccess: () => nav('/agents'),
  });

  if (loading && !data) return <Spinner label="Loading agent…" />;
  if (error && !data) return <ErrorState message={error} onRetry={refresh} />;
  if (!data) return null;
  const { agent, performance, evalSummary, capabilities, recentRuns, versions, policies } = data;

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {agent.name}
            <StatusPill status={agent.enabled ? 'completed' : 'cancelled'} label={agent.enabled ? 'enabled' : 'disabled'} />
          </span>
        }
        subtitle={agent.description}
        actions={
          <>
            <Button onClick={() => setRunOpen(true)}>Run agent</Button>
            <Button variant="secondary" onClick={() => setEdit(true)}>Edit</Button>
            <Button variant="secondary" onClick={() => setEnabled.mutate(!agent.enabled)}>
              {agent.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button variant="danger" onClick={() => { if (confirm(`Delete agent ${agent.name}? Runs are kept.`)) remove.mutate(); }}>
              Delete
            </Button>
          </>
        }
      />

      <div className="grid lg:grid-cols-4 gap-3 mb-4">
        <Card className="p-4">
          <div className="text-[11px] uppercase text-muted tracking-wider">Success rate</div>
          <div className="flex items-center gap-3 mt-2">
            <Donut value={performance.successRate} size={56} />
            <div className="text-[13px]"><div>{performance.runs} runs</div><div className="text-muted text-[12px]">{fmtDuration(performance.avgDurationMs)} avg</div></div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-[11px] uppercase text-muted tracking-wider">Avg steps</div>
          <div className="text-2xl font-semibold mt-1.5 tabular-nums">{performance.avgSteps}</div>
          <div className="text-[12px] text-muted mt-1">budget: {agent.limits.maxSteps} steps</div>
        </Card>
        <Card className="p-4">
          <div className="text-[11px] uppercase text-muted tracking-wider">Total cost</div>
          <div className="text-2xl font-semibold mt-1.5 text-ok tabular-nums">{fmtCost(performance.costUsd)}</div>
          <div className="text-[12px] text-muted mt-1">model: {agent.model}</div>
        </Card>
        <Card className="p-4">
          <div className="text-[11px] uppercase text-muted tracking-wider">Eval score</div>
          <div className="text-2xl font-semibold mt-1.5 tabular-nums">
            {evalSummary ? `${Math.round(evalSummary.successRate * 100)}%` : '—'}
          </div>
          <div className="text-[12px] text-muted mt-1">{evalSummary ? `${evalSummary.passed}/${evalSummary.cases} cases · ${evalSummary.policyViolations} violations` : 'no evaluation yet'}</div>
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <Card className="p-4">
          <div className="text-[13px] font-medium mb-2">Capabilities</div>
          <div className="space-y-2">
            {capabilities.length === 0 ? <div className="text-[13px] text-muted">No tools assigned.</div> : null}
            {capabilities.map((c) => (
              <div key={c.name} className="border border-border rounded-lg p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[12px]">{c.name}</span>
                  <RiskBadge risk={c.risk} />
                </div>
                <div className="text-[11px] text-muted mt-1">{c.description || c.kind}</div>
                {!c.permissionOk ? (
                  <div className="text-[11px] text-danger mt-1">missing permission: {c.missing.join(', ')}</div>
                ) : null}
                {!c.registered ? <div className="text-[11px] text-danger mt-1">not registered</div> : null}
              </div>
            ))}
          </div>
          <div className="text-[11px] text-muted mt-3">
            permissions: {agent.permissions.length ? agent.permissions.join(', ') : 'none'}
          </div>
        </Card>

        <Card className="p-4">
          <div className="text-[13px] font-medium mb-2">Policy ({agent.policies.mode})</div>
          <div className="space-y-2 text-[12px]">
            <div>
              <div className="text-muted text-[11px] uppercase tracking-wider mb-1">Allowed</div>
              <div className="flex flex-wrap gap-1">{agent.policies.allowed.length ? agent.policies.allowed.map((t) => <span key={t} className="bg-ok-soft text-ok px-1.5 py-0.5 rounded font-mono text-[11px]">{t}</span>) : <span className="text-muted">—</span>}</div>
            </div>
            <div>
              <div className="text-muted text-[11px] uppercase tracking-wider mb-1">Denied</div>
              <div className="flex flex-wrap gap-1">{agent.policies.denied.length ? agent.policies.denied.map((t) => <span key={t} className="bg-danger-soft text-danger px-1.5 py-0.5 rounded font-mono text-[11px]">{t}</span>) : <span className="text-muted">—</span>}</div>
            </div>
            <div>
              <div className="text-muted text-[11px] uppercase tracking-wider mb-1">Requires approval</div>
              <div className="flex flex-wrap gap-1">{agent.policies.requireApproval.length ? agent.policies.requireApproval.map((t) => <span key={t} className="bg-warn-soft text-warn px-1.5 py-0.5 rounded font-mono text-[11px]">{t}</span>) : <span className="text-muted">—</span>}</div>
            </div>
            {Object.keys(agent.policies.rateLimits).length ? (
              <div>
                <div className="text-muted text-[11px] uppercase tracking-wider mb-1">Rate limits</div>
                {Object.entries(agent.policies.rateLimits).map(([t, n]) => (
                  <div key={t} className="font-mono text-[11px]">{t} ≤ {n}/run</div>
                ))}
              </div>
            ) : null}
          </div>
          {policies.length ? (
            <div className="mt-3 pt-3 border-t border-border text-[11px] text-muted">
              stored policies: {policies.map((p) => p.name).join(', ')}
            </div>
          ) : null}
          <div className="mt-3 pt-3 border-t border-border">
            <div className="text-[11px] uppercase text-muted tracking-wider mb-1">Limits</div>
            <div className="text-[12px] font-mono">
              maxSteps={agent.limits.maxSteps} · maxRuntime={agent.limits.maxRuntimeMs}ms<br />
              maxCost=${agent.limits.maxCostUsd} · retries={agent.limits.maxRetries} · timeout={agent.limits.toolTimeoutMs}ms
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[13px] font-medium">Recent runs</div>
            <Link to={`/runs?agentId=${agent.id}`} className="text-[12px] text-accent hover:underline">view all →</Link>
          </div>
          {recentRuns.length === 0 ? (
            <div className="text-[13px] text-muted py-4">No runs yet. Hit “Run agent”.</div>
          ) : (
            <div className="space-y-1.5">
              {recentRuns.slice(0, 8).map((r) => (
                <Link key={r.id} to={`/runs/${r.id}`} className="flex items-center justify-between border border-border rounded-lg px-2.5 py-2 hover:border-accent/50">
                  <span className="font-mono text-[12px]">{r.id}</span>
                  <StatusPill status={r.status} />
                </Link>
              ))}
            </div>
          )}
          <div className="mt-3 pt-3 border-t border-border">
            <div className="text-[11px] uppercase text-muted tracking-wider mb-1">Versions ({versions.length})</div>
            <div className="text-[12px] text-muted font-mono">
              {versions.slice(0, 6).map((v) => `v${v.version}`).join(' → ')}
            </div>
          </div>
        </Card>
      </div>

      <Card className="p-4">
        <div className="text-[13px] font-medium mb-2">Configuration (snapshot)</div>
        <CodeBlock maxLines={24}>{JSON.stringify({ model: agent.model, tools: agent.tools, permissions: agent.permissions, policies: agent.policies, limits: agent.limits }, null, 2)}</CodeBlock>
      </Card>

      <div className="mt-4">
        <Table head={['Run', 'Task', 'Status', 'Steps', 'Cost', 'Started']}>
          {recentRuns.slice(0, 12).map((r) => (
            <Row key={r.id} onClick={() => nav(`/runs/${r.id}`)}>
              <Cell className="font-mono text-[12px]">{r.id}</Cell>
              <Cell className="max-w-[360px] truncate text-muted">{r.task}</Cell>
              <Cell><StatusPill status={r.status} /></Cell>
              <Cell className="tabular-nums">{r.steps}</Cell>
              <Cell className="tabular-nums text-ok">{fmtCost(r.costUsd)}</Cell>
              <Cell className="text-muted text-[12px]">{r.startedAt ? new Date(r.startedAt).toLocaleString(undefined, { hour12: false }) : '—'}</Cell>
            </Row>
          ))}
        </Table>
      </div>

      {edit ? <AgentForm initial={agent} onClose={() => setEdit(false)} onSaved={() => refresh()} /> : null}
      {runOpen ? <RunDialog agent={agent} onClose={() => setRunOpen(false)} /> : null}
    </div>
  );
}
