import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';
import { usePoll, fmtRelative } from '../lib/hooks.js';
import type { PolicyEntity } from '../lib/types.js';
import { Button, Card, Cell, CodeBlock, EmptyState, ErrorState, Field, Modal, PageHeader, Row, Spinner, StatusPill, Table } from '../components/ui.js';

interface PolicyFormState {
  name: string;
  description: string;
  agentName: string;
  rules: { pattern: string; action: 'allow' | 'deny' | 'require_approval'; maxCallsPerRun?: number; note?: string }[];
}

const EMPTY_RULE = { pattern: 'http.*', action: 'allow' as const, note: '' };

export default function Policies() {
  const [activeTab, setActiveTab] = useState<'list' | 'evaluate'>('list');
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<PolicyEntity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [evalTool, setEvalTool] = useState('');
  const [evalResult, setEvalResult] = useState<{ decision: string; rule: string | null; reason: string; toolKnown: boolean; toolRisk: string } | null>(null);
  const qc = useQueryClient();

  const { data, loading, refresh } = usePoll(() => api.policies(), 3_000);

  const create = useMutation({
    mutationFn: (spec: Omit<PolicyEntity, 'id' | 'seq' | 'createdAt' | 'updatedAt' | 'enabled' | 'rules'> & { rules: { pattern: string; action: 'allow' | 'deny' | 'require_approval'; note?: string }[] }) => api.createPolicy(spec),
    onSuccess: () => { void qc.invalidateQueries(); refresh(); setShowCreate(false); },
    onError: (e: Error) => setError((e as ApiError).message ?? e.message),
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<PolicyEntity> }) => api.updatePolicy(id, patch),
    onSuccess: () => { void qc.invalidateQueries(); refresh(); setEditing(null); },
    onError: (e: Error) => setError((e as ApiError).message ?? e.message),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deletePolicy(id),
    onSuccess: () => { void qc.invalidateQueries(); refresh(); },
    onError: (e: Error) => setError((e as ApiError).message ?? e.message),
  });

  const evaluate = useMutation<{ decision: { decision: string; rule: string | null; reason: string }; toolKnown: boolean; toolRisk: string } | null>({
    mutationFn: async () => {
      if (!evalTool) return null;
      return api.evaluatePolicy(evalTool, evalTool);
    },
    onSuccess: (res: { decision: { decision: string; rule: string | null; reason: string }; toolKnown: boolean; toolRisk: string } | null) => {
      if (!res) return;
      setEvalResult({
        decision: res.decision.decision,
        rule: res.decision.rule,
        reason: res.decision.reason,
        toolKnown: res.toolKnown,
        toolRisk: res.toolRisk,
      });
    },
    onError: (e: Error) => setError((e as ApiError).message ?? e.message),
  });

  const formDefaults = editing ?? { name: '', description: '', agentName: '' };
  const [form, setForm] = useState<PolicyFormState>({ name: formDefaults.name, description: formDefaults.description, agentName: formDefaults.agentName || '', rules: editing ? [...editing.rules] : [{ ...EMPTY_RULE }] });

  const addRule = () => setForm({ ...form, rules: [...form.rules, { ...EMPTY_RULE }] });
  const removeRule = (i: number) => setForm({ ...form, rules: form.rules.filter((_, idx) => idx !== i) });
  const updateRule = (i: number, r: Partial<PolicyFormState['rules'][0]>) => setForm({ ...form, rules: form.rules.map((rule, idx) => idx === i ? { ...rule, ...r } : rule) });

  if (loading && !data) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Policies"
        subtitle="Named policy bundles (rules, agents, dry-run evaluation) — complementary to per-agent policy config on the Agents page."
        actions={
          <>
            <Button variant="secondary" onClick={() => setActiveTab(activeTab === 'list' ? 'evaluate' : 'list')}>
              {activeTab === 'list' ? 'Dry-run evaluate' : 'Back to list'}
            </Button>
            <Button onClick={() => setShowCreate(true)}>+ New policy</Button>
          </>
        }
      />

      {error ? <div className="mb-3 text-danger bg-danger-soft border border-danger/30 rounded-lg p-2.5 text-[13px]">{error}</div> : null}

      {activeTab === 'list' && (
        <>
          {data && data.policies.length === 0 ? (
            <EmptyState title="No policies" hint="Policies are created via the API or seed data. The demo ships with two policies." />
          ) : null}
          {data && data.policies.length > 0 ? (
            <Table head={['Policy', 'Agent', 'Rules', 'Enabled', 'Updated']}>
              {data.policies.map((p: PolicyEntity) => (
                <Row key={p.id}>
                  <Cell>
                    <div className="font-medium text-[13px]">{p.name}</div>
                    <div className="text-[11px] text-muted max-w-[200px] truncate">{p.description}</div>
                  </Cell>
                  <Cell className="text-[12px] text-muted font-mono">{p.agentName ?? '—'}</Cell>
                  <Cell className="text-[12px]">
                    <div className="flex flex-wrap gap-1">
                      {p.rules.map((r, i) => (
                        <span key={i} className="text-[11px] bg-panel2 px-1.5 py-0.5 rounded font-mono">
                          {r.pattern} → {r.action.replaceAll('_', ' ')}
                        </span>
                      ))}
                    </div>
                  </Cell>
                  <Cell><StatusPill status={p.enabled ? 'completed' : 'cancelled'} label={p.enabled ? 'enabled' : 'disabled'} /></Cell>
                  <Cell className="text-[12px] text-muted">{fmtRelative(p.updatedAt)}</Cell>
                </Row>
              ))}
            </Table>
          ) : null}

          {data && data.policies.map((p: PolicyEntity) => (
            <Card key={p.id} className="p-4 mt-2 border border-border">
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    <StatusPill status={p.enabled ? 'completed' : 'cancelled'} label={p.enabled ? 'enabled' : 'disabled'} />
                  </div>
                  <div className="text-[12px] text-muted mt-1">{p.description}</div>
                  <details className="mt-2">
                    <summary className="text-[11px] text-muted cursor-pointer hover:text-ink">Rules ({p.rules.length})</summary>
                    <div className="mt-1 space-y-1">
                      {p.rules.map((r, i) => (
                        <div key={i} className="text-[12px] font-mono bg-panel2 border border-border rounded-lg p-2">
                          <span className="text-accent">{r.pattern}</span> → <span className={`font-medium ${r.action === 'deny' ? 'text-danger' : r.action === 'require_approval' ? 'text-warn' : 'text-ok'}`}>{r.action.replaceAll('_', ' ')}</span>
                          {r.maxCallsPerRun ? <span className="text-muted ml-2">max {r.maxCallsPerRun}/run</span> : null}
                          {r.note ? <span className="text-muted ml-2">· {r.note}</span> : null}
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <Button small variant="secondary" onClick={() => setEditing(p)}>Edit</Button>
                  <Button small variant="danger" onClick={() => { if (confirm(`Delete policy "${p.name}"?`)) del.mutate(p.id); }} disabled={del.isPending}>
                    Delete
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </>
      )}

      {activeTab === 'evaluate' && (
        <Card className="p-4">
          <div className="text-[13px] font-medium mb-2">Evaluate a tool against policies</div>
          <div className="text-[12px] text-muted mb-4">Paste a tool pattern to see what policy decision applies. Useful for testing policy rules before applying them.</div>
          <div className="flex gap-2 mb-4">
            <input
              className="flex-1 bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:border-accent font-mono"
              placeholder="e.g. http.fetch, fs.write, mcp.my-server.tool"
              value={evalTool}
              onChange={(e) => setEvalTool(e.target.value)}
            />
            <Button onClick={() => evaluate.mutate()} disabled={!evalTool || evaluate.isPending}>
              {evaluate.isPending ? 'Evaluating…' : 'Evaluate'}
            </Button>
          </div>
          {evalResult && (
            <Card className="p-4 mt-4 border border-border bg-panel2">
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <div className="text-[11px] text-muted uppercase tracking-wider mb-1">Decision</div>
                  <div className="text-lg font-semibold"><StatusPill status={evalResult.decision as any} label={evalResult.decision.replaceAll('_', ' ')} /></div>
                </div>
                <div>
                  <div className="text-[11px] text-muted uppercase tracking-wider mb-1">Rule applied</div>
                  <div className="text-[13px] font-mono">{evalResult.rule ?? '— (no matching rule)'}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted uppercase tracking-wider mb-1">Reason</div>
                  <div className="text-[12px] text-muted">{evalResult.reason}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted uppercase tracking-wider mb-1">Tool info</div>
                  <div className="text-[12px]">Known: <span className="font-mono">{evalResult.toolKnown ? 'yes' : 'no'}</span> · Risk: <span className="font-mono">{evalResult.toolRisk}</span></div>
                </div>
              </div>
            </Card>
          )}
        </Card>
      )}

      {showCreate && (
        <Modal title="New policy" onClose={() => { setShowCreate(false); setError(null); }} wide>
          <div className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-x-4">
              <Field label="Name">
                <input className="w-full bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:border-accent" value={form.name} placeholder="e.g. research policy" onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label="Agent name (optional)" hint="Scope the policy to a specific agent by name.">
                <input className="w-full bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:border-accent" value={form.agentName} placeholder="e.g. Researcher" onChange={(e) => setForm({ ...form, agentName: e.target.value })} />
              </Field>
            </div>
            <Field label="Description">
              <input className="w-full bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:border-accent" value={form.description} placeholder="What this policy governs" onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </Field>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[12px] font-medium text-muted">Rules</div>                  <button type="button" onClick={addRule} className="px-2 py-1 rounded text-[12px] text-muted hover:text-ink hover:bg-panel2">+ Add rule</button>
                </div>
              {form.rules.map((r, i) => (
                <div key={i} className="flex gap-2 items-start border border-border rounded-lg p-3 bg-panel2">
                  <div className="flex-1 grid sm:grid-cols-3 gap-2">
                    <Field label="">
                      <input className="w-full bg-panel border border-border rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:border-accent font-mono" value={r.pattern} placeholder="pattern" onChange={(e) => updateRule(i, { pattern: e.target.value })} />
                    </Field>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="">
                        <select className="w-full bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-accent" value={r.action} onChange={(e) => updateRule(i, { action: e.target.value as 'allow' | 'deny' | 'require_approval' })}>
                          <option value="allow">allow</option>
                          <option value="deny">deny</option>
                          <option value="require_approval">require_approval</option>
                        </select>
                      </Field>
                      <Field label="Max calls/run">
                        <input type="number" className="w-full bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:border-accent" value={r.maxCallsPerRun ?? ''} placeholder="optional" onChange={(e) => updateRule(i, { maxCallsPerRun: e.target.value ? Number(e.target.value) : undefined })} />
                      </Field>
                    </div>
                  </div>
                  <Field label="">
                    <input className="w-full bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:border-accent" value={r.note ?? ''} placeholder="note (optional)" onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateRule(i, { note: e.target.value || undefined })} />
                  </Field>
                  <button type="button" onClick={() => removeRule(i)} className="self-end text-[13px] text-muted hover:text-ink">×</button>
                </div>
              ))}
            </div>
            {create.error ? <div className="text-danger text-[13px]">{create.error.message}</div> : null}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button onClick={() => {
                if (!form.name.trim()) return;
                create.mutate({
                  name: form.name,
                  description: form.description,
                  agentName: form.agentName || undefined,
                  rules: form.rules.map((r) => ({ pattern: r.pattern, action: r.action, maxCallsPerRun: r.maxCallsPerRun, note: r.note })),
                } as any);
              }} disabled={!form.name.trim() || create.isPending}>
                {create.isPending ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit policy — ${editing.name}`} onClose={() => setEditing(null)} wide>
          <div className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-x-4">
              <Field label="Name">
                <input className="w-full bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:border-accent" value={form.name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label="Agent name">
                <input className="w-full bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:border-accent" value={form.agentName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, agentName: e.target.value })} />
              </Field>
            </div>
            <Field label="Description">
              <input className="w-full bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:border-accent" value={form.description} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, description: e.target.value })} />
            </Field>
            <Field label="Enabled">
              <div className="flex items-center gap-2">
                <input type="checkbox" id="enabled" defaultChecked readOnly className="accent-accent" style={{ width: 18, height: 18 }} />
                <label htmlFor="enabled" className="ml-2 text-[13px]">Policy is active</label>
              </div>
            </Field>
            {update.error ? <div className="text-danger text-[13px]">{update.error.message}</div> : null}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={() => {
                if (!form.name.trim()) return;
                update.mutate({ id: editing.id, patch: { name: form.name, description: form.description, agentName: form.agentName || null, enabled: true } });
              }} disabled={!form.name.trim() || update.isPending}>
                {update.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
