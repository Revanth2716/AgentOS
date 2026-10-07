import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';
import { usePoll } from '../lib/hooks.js';
import type { ToolRow, McpServer } from '../lib/types.js';
import { Button, Card, Cell, CodeBlock, EmptyState, ErrorState, Field, Modal, PageHeader, Row, Spinner, StatusPill, Table } from '../components/ui.js';
import { RiskBadge } from '../components/ui.js';

export default function Tools() {
  const [activeTab, setActiveTab] = useState<'registry' | 'invoke' | 'mcp'>('registry');
  const [showInvoke, setShowInvoke] = useState(false);
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [selected, setSelected] = useState<ToolRow | null>(null);
  const [invokeArgs, setInvokeArgs] = useState<string>('');
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const [invokeResult, setInvokeResult] = useState<string | null>(null);
  const [mcpName, setMcpName] = useState('');
  const [mcpCommand, setMcpCommand] = useState('');
  const [mcpArgs, setMcpArgs] = useState('');
  const qc = useQueryClient();

  const { data: toolsData, loading: toolsLoading, refresh: refreshTools } = usePoll(() => api.tools(), 3_000);
  const { data: mcpData, loading: mcpLoading, refresh: refreshMcp } = usePoll(() => api.mcpServers(), 3_000);

  const toggleTool = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => api.setToolEnabled(name, enabled),
    onSuccess: () => { void qc.invalidateQueries(); refreshTools(); },
  });

  const invoke = useMutation<{ result: { ok: boolean; output: string; error?: string; durationMs: number } } | null>({
    mutationFn: async () => {
      if (!selected) return null;
      const args = invokeArgs ? (JSON.parse(invokeArgs) as Record<string, unknown>) : selected.sampleInput ?? {};
      return api.invokeTool(selected.name, args);
    },
    onSuccess: (res: { result: { ok: boolean; output: string; error?: string; durationMs: number } } | null) => {
      if (!res) return;
      setInvokeResult(`OK: ${JSON.stringify(res.result.output)}`);
      setInvokeError(res.result.error ?? null);
    },
    onError: (e: Error) => setInvokeError((e as ApiError).message ?? e.message),
  });

  const toggle = useMutation({
  });

  const addMcp = useMutation({
    mutationFn: (spec: { name: string; command: string; args: string[] }) => api.addMcpServer(spec),
    onSuccess: () => { void qc.invalidateQueries(); refreshMcp(); setShowMcpForm(false); },
    onError: (e: ApiError) => setInvokeError(e.message),
  });

  const reconnectMcp = useMutation({
    mutationFn: (id: string) => api.reconnectMcp(id),
    onSuccess: () => { void qc.invalidateQueries(); refreshMcp(); },
  });

  const deleteMcp = useMutation({
    mutationFn: (id: string) => api.deleteMcpServer(id),
    onSuccess: () => { void qc.invalidateQueries(); refreshMcp(); },
  });

  if (toolsLoading && !toolsData) return <Spinner />;
  if (mcpLoading && !mcpData) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Tools"
        subtitle="Built-in tools, MCP-exposed tools, enable/disable, and an inline invocation console."
        actions={<Button onClick={() => setShowMcpForm(true)}>+ Add MCP server</Button>}
      />

      <div className="flex gap-2 mb-4 border-b border-border">
        {(['registry', 'invoke', 'mcp'] as const).map((t) => (
          <Button key={t} variant={activeTab === t ? 'secondary' : 'ghost'} small onClick={() => setActiveTab(t)}>
            {t === 'registry' ? 'Registry' : t === 'invoke' ? 'Invoke' : 'MCP servers'}
          </Button>
        ))}
      </div>

      {activeTab === 'registry' && (
        <>
          {toolsData && toolsData.tools.length === 0 ? (
            <EmptyState title="No tools" hint="Tools are registered by the runtime or MCP servers." />
          ) : null}
          {toolsData && toolsData.tools.length > 0 ? (
            <Table head={['Tool', 'Kind', 'Risk', 'Source', 'Enabled', 'Permissions', 'Executable']}>
              {toolsData.tools.map((t: ToolRow) => (
                <Row key={t.name}>
                  <Cell>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[13px]">{t.name}</span>
                      {t.mcpServerId ? <span className="text-[10px] bg-panel2 px-1 rounded text-muted">mcp</span> : null}
                    </div>
                    <div className="text-[11px] text-muted max-w-[220px] truncate">{t.description}</div>
                  </Cell>
                  <Cell className="text-[11px] text-muted">{t.kind}</Cell>
                  <Cell><RiskBadge risk={t.riskLevel} /></Cell>
                  <Cell className="text-[11px] uppercase text-muted">{t.source}</Cell>
                  <Cell><StatusPill status={t.enabled ? 'completed' : 'cancelled'} label={t.enabled ? 'enabled' : 'disabled'} /></Cell>
                  <Cell>
                    <div className="flex flex-wrap gap-1 max-w-[200px]">
                      {t.permissions.slice(0, 4).map((p) => (
                        <span key={p} className="text-[10px] bg-panel2 px-1 rounded text-muted">{p}</span>
                      ))}
                      {t.permissions.length > 4 ? <span className="text-[10px] text-muted">+{t.permissions.length - 4}</span> : null}
                    </div>
                  </Cell>
                  <Cell><StatusPill status={t.executable ? 'completed' : 'cancelled'} label={t.executable ? 'yes' : 'no'} /></Cell>
                </Row>
              ))}
            </Table>
          ) : null}

          {toolsData && toolsData.tools.length > 0 && (
            <div className="mt-4">
              <div className="text-[13px] font-medium mb-2">Enable / disable</div>
              <div className="flex flex-wrap gap-2">
                {toolsData.tools.map((t: ToolRow) => (
                  <Button
                    key={t.name}
                    variant={t.enabled ? 'secondary' : 'ghost'}
                    small
                    onClick={() => toggleTool.mutate({ name: t.name, enabled: !t.enabled })}
                    disabled={toggleTool.isPending}
                  >
                    {t.enabled ? 'Disable' : 'Enable'} {t.name}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {activeTab === 'invoke' && (
        <>
          <div className="flex gap-2 mb-4">
            <select
              className="flex-1 bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-accent"
              value={selected?.name ?? ''}
              onChange={(e) => setSelected(toolsData?.tools.find((t: ToolRow) => t.name === e.target.value) ?? null)}
            >
              <option value="">select a tool…</option>
              {toolsData?.tools.map((t: ToolRow) => (
                <option key={t.name} value={t.name}>{t.name} · {t.riskLevel} risk</option>
              ))}
            </select>
            <button type="button" onClick={() => setShowInvoke(true)} disabled={!selected} className="px-3 py-1.5 rounded-lg text-[13px] bg-panel2 border border-border text-ink hover:border-accent/50 disabled:opacity-40">
              Open console
            </button>
          </div>
          {selected && (
            <Card className="p-4">
              <div className="text-[13px] font-medium mb-2">{selected.name}</div>
              <div className="text-[12px] text-muted mb-3">{selected.description}</div>
              <div className="grid sm:grid-cols-2 gap-3 text-[12px]">
                <div><span className="text-muted">Risk:</span> <span className="font-mono">{selected.riskLevel}</span></div>
                <div><span className="text-muted">Kind:</span> <span className="font-mono">{selected.kind}</span></div>
                <div><span className="text-muted">Source:</span> <span className="font-mono">{selected.source}</span></div>
                <div><span className="text-muted">Permissions:</span> <span className="font-mono">{selected.permissions.join(', ')}</span></div>
              </div>
            </Card>
          )}
        </>
      )}

      {activeTab === 'mcp' && (
        <>
          {mcpData && mcpData.servers.length === 0 ? (
            <EmptyState
              title="No MCP servers"
              hint="Add an MCP server to expose external tools through the tool registry."
              action={<Button onClick={() => setShowMcpForm(true)}>+ Add MCP server</Button>}
            />
          ) : null}
          {mcpData && mcpData.servers.length > 0 ? (
            <Table head={['Server', 'Command', 'Risk', 'Status', 'Tools', 'Connected']}>
              {mcpData.servers.map((s: McpServer) => (
                <Row key={s.id}>
                  <Cell>
                    <div className="font-mono text-[13px]">{s.name}</div>
                    <div className="text-[11px] text-muted font-mono">{s.id}</div>
                  </Cell>
                  <Cell className="text-[11px] font-mono text-muted max-w-[240px] truncate">
                    {s.command} {s.args.join(' ')}
                  </Cell>
                  <Cell><RiskBadge risk={s.riskLevel} /></Cell>
                  <Cell><StatusPill status={s.status} /></Cell>
                  <Cell className="tabular-nums">{s.toolCount}</Cell>
                  <Cell><StatusPill status={s.connected ? 'completed' : 'cancelled'} label={s.connected ? 'connected' : 'disconnected'} /></Cell>
                </Row>
              ))}
            </Table>
          ) : null}
          {mcpData && mcpData.servers.map((s: McpServer) => (
            <Card key={s.id} className="p-4 mt-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium">{s.name}</span>
                    <StatusPill status={s.status} />
                  </div>
                  <div className="text-[11px] text-muted font-mono mt-1">{s.command} {s.args.join(' ')}</div>
                  <div className="text-[11px] text-muted mt-1">{s.toolCount} tools · {s.connected ? 'connected' : 'disconnected'}</div>
                </div>
                <div className="flex gap-1.5">
                  {s.status === 'unregistered' || s.status === 'error' ? (
                    <Button small variant="secondary" onClick={() => reconnectMcp.mutate(s.id)} disabled={reconnectMcp.isPending}>
                      Reconnect
                    </Button>
                  ) : null}
                  <Button small variant="danger" onClick={() => { if (confirm(`Delete MCP server ${s.name}?`)) deleteMcp.mutate(s.id); }} disabled={deleteMcp.isPending}>
                    Delete
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </>
      )}

      {showInvoke && selected && (
        <Modal title={`Invoke ${selected.name}`} onClose={() => { setShowInvoke(false); setInvokeResult(null); setInvokeError(null); }} wide>
          <div className="space-y-3">
            <Field label="Arguments (JSON)">
              <textarea
                className="w-full bg-panel2 border border-border rounded-lg p-2.5 text-[12px] font-mono text-ink placeholder:text-muted focus:outline-none focus:border-accent h-32 resize-y"
                placeholder={JSON.stringify(selected.sampleInput ?? {}, null, 2)}
                value={invokeArgs}
                onChange={(e) => setInvokeArgs(e.target.value)}
              />
              {selected.sampleInput ? (
                <div className="mt-1">
                  <button
                    type="button"
                    className="text-[11px] text-accent hover:underline"
                    onClick={() => setInvokeArgs(JSON.stringify(selected.sampleInput, null, 2))}
                  >
                    Use sample input
                  </button>
                </div>
              ) : null}
            </Field>
            {invokeError && (
              <div className="text-danger bg-danger-soft border border-danger/30 rounded-lg p-2.5 text-[13px]">{invokeError}</div>
            )}
            {invokeResult && (
              <div className="text-ok bg-ok-soft border border-ok/30 rounded-lg p-2.5 text-[13px]">{invokeResult}</div>
            )}
            {invoke.isPending ? <div className="text-muted text-[13px]">Invoking…</div> : null}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => { setShowInvoke(false); setInvokeResult(null); setInvokeError(null); }}>Cancel</Button>
              <Button onClick={() => invoke.mutate()} disabled={invoke.isPending}>
                {invoke.isPending ? 'Invoking…' : 'Invoke'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {showMcpForm && (
        <Modal title="Add MCP server" onClose={() => setShowMcpForm(false)}>
          <div className="space-y-3">
            <Field label="Server name">
              <input className="w-full bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:border-accent" value={mcpName} placeholder="e.g. my-server" onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMcpName(e.target.value)} />
            </Field>
            <Field label="Command">
              <input className="w-full bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:border-accent font-mono" value={mcpCommand} placeholder="./node fixture-server.mjs" onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMcpCommand(e.target.value)} />
            </Field>
            <Field label="Arguments" hint="Space-separated, or leave empty.">
              <input className="w-full bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:border-accent font-mono" value={mcpArgs} placeholder="" onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMcpArgs(e.target.value)} />
            </Field>
            {addMcp.error ? <div className="text-danger text-[13px]">{addMcp.error.message}</div> : null}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowMcpForm(false)}>Cancel</Button>
              <Button
                onClick={() => {
                  if (!mcpName || !mcpCommand) return;
                  addMcp.mutate({ name: mcpName, command: mcpCommand, args: mcpArgs.split(/\s+/).filter(Boolean) });
                }}
                disabled={!mcpName || !mcpCommand || addMcp.isPending}
              >
                {addMcp.isPending ? 'Adding…' : 'Add server'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
