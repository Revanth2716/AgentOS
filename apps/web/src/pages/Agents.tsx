import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';
import { usePoll, fmtCost, fmtDuration } from '../lib/hooks.js';
import type { Agent, AgentListItem } from '../lib/types.js';
import { Button, Cell, EmptyState, ErrorState, Field, inputCls, Modal, PageHeader, Row, Spinner, StatusPill, Table } from '../components/ui.js';

const EMPTY: Agent = {
  id: '',
  seq: 0,
  name: '',
  description: '',
  model: 'mock/generic',
  tools: ['calculator'],
  permissions: [],
  policies: { mode: 'allowlist', allowed: ['calculator'], denied: [], requireApproval: [], rateLimits: {} },
  limits: { maxSteps: 10, maxRuntimeMs: 60_000, maxCostUsd: 0.2, toolTimeoutMs: 30_000, maxRetries: 2 },
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

export function AgentForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: Agent | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const tools = usePoll(() => api.tools(), 0);
  const [draft, setDraft] = useState<Agent>(initial ?? { ...EMPTY, name: '', description: '' });
  const [toolPicker, setToolPicker] = useState('');
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: async () => {
      const spec = {
        name: draft.name,
        description: draft.description,
        model: draft.model,
        tools: draft.tools,
        permissions: draft.permissions,
        policies: draft.policies,
        limits: draft.limits,
        enabled: draft.enabled,
      };
      return initial ? api.updateAgent(initial.id, spec) : api.createAgent(spec);
    },
    onSuccess: (res) => {
      void qc.invalidateQueries();
      onSaved(res.agent.id);
      onClose();
    },
    onError: (e: ApiError) => setError(e.message),
  });

  const toggleTool = (name: string, checked: boolean): void => {
    setDraft((d) => {
      const toolsSet = checked ? [...new Set([...d.tools, name])] : d.tools.filter((t) => t !== name);
      // keep allowlist in sync so tools are actually executable
      const allowed = checked ? [...new Set([...d.policies.allowed, name])] : d.policies.allowed.filter((t) => t !== name);
      return { ...d, tools: toolsSet, policies: { ...d.policies, allowed } };
    });
  };

  return (
    <Modal title={initial ? `Edit agent — ${initial.name}` : 'New agent'} onClose={onClose} wide>
      {error ? <div className="mb-3 text-[13px] text-danger bg-danger-soft border border-danger/30 rounded-lg p-2.5">{error}</div> : null}
      <div className="grid sm:grid-cols-2 gap-x-4">
        <Field label="Name">
          <input className={inputCls} value={draft.name} placeholder="e.g. Researcher" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="Model" hint="mock/* is deterministic and free. ollama/* and openai/* are optional.">
          <input className={inputCls} value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
        </Field>
      </div>
      <Field label="Description">
        <input className={inputCls} value={draft.description} placeholder="What this agent does" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
      </Field>

      <Field label="Tools" hint="Tools are offered to the agent; policy + permissions are enforced at execution time.">
        <div className="flex flex-wrap gap-1.5 mb-2">
          {draft.tools.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 bg-accent-soft text-accent text-[12px] px-2 py-1 rounded-lg">
              {t}
              <button onClick={() => toggleTool(t, false)} className="hover:text-danger" aria-label={`remove ${t}`}>×</button>
            </span>
          ))}
          {draft.tools.length === 0 ? <span className="text-[12px] text-muted">no tools selected</span> : null}
        </div>
        <div className="flex gap-2">
          <select className={inputCls} value={toolPicker} onChange={(e) => setToolPicker(e.target.value)}>
            <option value="">add a tool…</option>
            {tools.data?.tools
              .filter((t) => !draft.tools.includes(t.name))
              .map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} · {t.riskLevel} risk
                </option>
              ))}
          </select>
          <Button variant="secondary" onClick={() => { if (toolPicker) { toggleTool(toolPicker, true); setToolPicker(''); } }} disabled={!toolPicker}>
            Add
          </Button>
        </div>
      </Field>

      <div className="grid sm:grid-cols-2 gap-x-4">
        <Field label="Policy mode" hint="allowlist = deny anything not listed (safe default)">
          <select className={inputCls} value={draft.policies.mode} onChange={(e) => setDraft({ ...draft, policies: { ...draft.policies, mode: e.target.value as 'allowlist' | 'denylist' } })}>
            <option value="allowlist">allowlist</option>
            <option value="denylist">denylist</option>
          </select>
        </Field>
        <Field label="Denied tools" hint="comma separated patterns, e.g. http.fetch, mcp.*">
          <input
            className={inputCls}
            defaultValue={draft.policies.denied.join(', ')}
            onChange={(e) => setDraft({ ...draft, policies: { ...draft.policies, denied: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })}
          />
        </Field>
      </div>
      <div className="grid sm:grid-cols-2 gap-x-4">
        <Field label="Requires approval" hint="comma separated; these pause the run for an operator">
          <input
            className={inputCls}
            defaultValue={draft.policies.requireApproval.join(', ')}
            onChange={(e) => setDraft({ ...draft, policies: { ...draft.policies, requireApproval: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })}
          />
        </Field>
        <Field label="Permissions" hint="e.g. fs:read, fs:write, net:fetch, browser:use, artifacts:write">
          <input
            className={inputCls}
            defaultValue={draft.permissions.join(', ')}
            onChange={(e) => setDraft({ ...draft, permissions: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="Max steps">
          <input type="number" className={inputCls} value={draft.limits.maxSteps} onChange={(e) => setDraft({ ...draft, limits: { ...draft.limits, maxSteps: Number(e.target.value) } })} />
        </Field>
        <Field label="Max runtime (ms)">
          <input type="number" className={inputCls} value={draft.limits.maxRuntimeMs} onChange={(e) => setDraft({ ...draft, limits: { ...draft.limits, maxRuntimeMs: Number(e.target.value) } })} />
        </Field>
        <Field label="Max cost ($)">
          <input type="number" step="0.01" className={inputCls} value={draft.limits.maxCostUsd} onChange={(e) => setDraft({ ...draft, limits: { ...draft.limits, maxCostUsd: Number(e.target.value) } })} />
        </Field>
        <Field label="Max retries">
          <input type="number" className={inputCls} value={draft.limits.maxRetries} onChange={(e) => setDraft({ ...draft, limits: { ...draft.limits, maxRetries: Number(e.target.value) } })} />
        </Field>
      </div>

      <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-border">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || draft.name.trim().length < 2}>
          {save.isPending ? 'Saving…' : initial ? 'Save changes' : 'Create agent'}
        </Button>
      </div>
    </Modal>
  );
}

export function RunDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [task, setTask] = useState('Find three facts about agents');
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();
  const start = useMutation({
    mutationFn: () => api.runAgent(agent.id, task),
    onSuccess: (res) => nav(`/runs/${res.run.id}`),
    onError: (e: ApiError) => setError(e.message),
  });
  return (
    <Modal title={`Run ${agent.name}`} onClose={onClose}>
      {error ? <div className="mb-3 text-[13px] text-danger bg-danger-soft border border-danger/30 rounded-lg p-2.5">{error}</div> : null}
      <Field label="Task" hint="Give the agent a concrete objective. Demo mode uses the offline corpus.">
        <textarea className={`${inputCls} h-24 resize-y`} value={task} onChange={(e) => setTask(e.target.value)} />
      </Field>
      <div className="text-[12px] text-muted mb-4">
        model <span className="font-mono text-ink">{agent.model}</span> · limits: {agent.limits.maxSteps} steps /{' '}
        {(agent.limits.maxRuntimeMs / 1000).toFixed(0)}s / ${agent.limits.maxCostUsd.toFixed(2)}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => start.mutate()} disabled={start.isPending || !task.trim()}>
          {start.isPending ? 'Starting…' : 'Run agent'}
        </Button>
      </div>
    </Modal>
  );
}

export default function Agents() {
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [runAgent, setRunAgent] = useState<Agent | null>(null);
  const qc = useQueryClient();
  const { data, error, loading, refresh } = usePoll(() => api.agents(search), 4_000, [search]);

  const setEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setAgentEnabled(id, enabled),
    onSuccess: () => void qc.invalidateQueries(),
  });

  return (
    <div>
      <PageHeader
        title="Agents"
        subtitle="Declarative agent definitions: model, tools, permissions, policies, limits."
        actions={
          <>
            <input className={`${inputCls} !w-48`} placeholder="search agents…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Button onClick={() => setShowCreate(true)}>+ New agent</Button>
          </>
        }
      />
      {error && !data ? <ErrorState message={error} onRetry={refresh} /> : null}
      {loading && !data ? <Spinner /> : null}
      {data && data.agents.length === 0 ? (
        <EmptyState title="No agents found" hint="Create your first agent — it can run fully offline with the deterministic mock provider." action={<Button onClick={() => setShowCreate(true)}>+ New agent</Button>} />
      ) : null}
      {data && data.agents.length > 0 ? (
        <Table head={['Agent', 'Model', 'Tools', 'Policy', 'Runs', 'Success', 'Avg latency', 'Cost', 'Status', '']}>
          {data.agents.map((a: AgentListItem) => (
            <Row key={a.id} onClick={() => (window.location.href = `/agents/${a.id}`)}>
              <Cell>
                <Link to={`/agents/${a.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:text-accent">
                  {a.name}
                </Link>
                <div className="text-[11px] text-muted max-w-[260px] truncate">{a.description}</div>
              </Cell>
              <Cell className="font-mono text-[12px]">{a.model}</Cell>
              <Cell className="text-[12px] text-muted">{a.tools.length ? a.tools.join(', ') : '—'}</Cell>
              <Cell><span className="text-[11px] bg-panel2 px-1.5 py-0.5 rounded">{a.policies.mode}</span></Cell>
              <Cell className="tabular-nums">{a.performance.runs}</Cell>
              <Cell className="tabular-nums">
                {a.performance.runs > 0 ? (
                  <span className={a.performance.successRate >= 0.8 ? 'text-ok' : 'text-warn'}>
                    {Math.round(a.performance.successRate * 100)}%
                  </span>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </Cell>
              <Cell className="tabular-nums text-muted">{a.performance.runs ? `${a.performance.avgDurationMs}ms` : '—'}</Cell>
              <Cell className="tabular-nums text-ok">{fmtCost(a.performance.costUsd)}</Cell>
              <Cell><StatusPill status={a.enabled ? 'completed' : 'cancelled'} label={a.enabled ? 'enabled' : 'disabled'} /></Cell>
              <Cell onClick={(e) => e.stopPropagation()}>
                <div className="flex gap-1.5 justify-end">
                  <Button small variant="secondary" onClick={() => setRunAgent(a)}>Run</Button>
                  <Button small variant="ghost" onClick={() => setEnabled.mutate({ id: a.id, enabled: !a.enabled })}>
                    {a.enabled ? 'Disable' : 'Enable'}
                  </Button>
                </div>
              </Cell>
            </Row>
          ))}
        </Table>
      ) : null}

      {showCreate ? (
        <AgentForm
          initial={null}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            refresh();
            void qc.invalidateQueries();
          }}
        />
      ) : null}
      {runAgent ? <RunDialog agent={runAgent} onClose={() => setRunAgent(null)} /> : null}
    </div>
  );
}
