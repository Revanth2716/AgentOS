import { useState } from 'react';
import { api } from '../lib/api.js';
import { usePoll, fmtDateTime, fmtRelative } from '../lib/hooks.js';
import { Card, Cell, CodeBlock, EmptyState, ErrorState, PageHeader, Row, Spinner, StatusPill, Table, Mono } from '../components/ui.js';

export default function Settings() {
  const [tab, setTab] = useState<'status' | 'audit'>('status');
  const settings = usePoll(() => api.settings(), 5_000);
  const audit = usePoll(() => api.audit(50), 3_000);
  const summary = usePoll(() => api.summary(), 5_000);
  const providers = usePoll(() => api.providers(), 6_000);
  const doctor = usePoll(() => api.doctor(), 10_000);

  if (settings.loading && !settings.data) return <Spinner label="Loading settings…" />;
  if (audit.error && !audit.data) return <ErrorState message={audit.error} />;

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Runtime configuration, connection info, providers, and the audit log."
        actions={
          <div className="flex gap-1.5">
            <button type="button" onClick={() => setTab('status')} className={`px-3 py-1.5 rounded-lg text-[13px] ${tab === 'status' ? 'bg-accent-soft text-accent font-medium' : 'text-muted hover:text-ink hover:bg-panel2'}`}>
              Status
            </button>
            <button type="button" onClick={() => setTab('audit')} className={`px-3 py-1.5 rounded-lg text-[13px] ${tab === 'audit' ? 'bg-accent-soft text-accent font-medium' : 'text-muted hover:text-ink hover:bg-panel2'}`}>
              Audit log
            </button>
          </div>
        }
      />

      {tab === 'status' && (
        <>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <Card className="p-4">
              <div className="text-[11px] uppercase text-muted tracking-wider">Data dir</div>
              <div className="font-mono text-[13px] mt-1.5 truncate">.agentos</div>
              <div className="text-[11px] text-muted mt-1">local SQLite DB + workspace</div>
            </Card>
            <Card className="p-4">
              <div className="text-[11px] uppercase text-muted tracking-wider">API port</div>
              <div className="font-mono text-[13px] mt-1.5">8787</div>
              <div className="text-[11px] text-muted mt-1">http://127.0.0.1:8787</div>
            </Card>
            <Card className="p-4">
              <div className="text-[11px] uppercase text-muted tracking-wider">Dashboard</div>
              <div className="font-mono text-[13px] mt-1.5">http://localhost:5173</div>
              <div className="text-[11px] text-muted mt-1">Vite dev server (proxy to API)</div>
            </Card>
            <Card className="p-4">
              <div className="text-[11px] uppercase text-muted tracking-wider">Demo mode</div>
              <div className={`text-lg font-semibold mt-1.5 ${summary.data?.demoMode ? 'text-ok' : 'text-ink'}`}>
                {summary.data?.demoMode ? 'Enabled' : 'Disabled'}
              </div>
              <div className="text-[11px] text-muted mt-1">{summary.data?.demoMode ? 'Deterministic, offline, $0.00' : 'Live provider mode'}</div>
            </Card>
          </div>

          <Card className="p-4 mb-4">
            <div className="text-[13px] font-medium mb-3">Environment</div>
            <CodeBlock maxLines={20}>{JSON.stringify(settings.data?.settings ?? {}, null, 2)}</CodeBlock>
          </Card>

          <Card className="p-4 mb-4">
            <div className="text-[13px] font-medium mb-3">Counts</div>
            {summary.data && (
              <Table head={['Entity', 'Count']}>
                <Row><Cell className="font-medium text-[13px]">Agents</Cell><Cell className="tabular-nums">{summary.data.agents.total}</Cell></Row>
                <Row><Cell className="font-medium text-[13px]">Enabled agents</Cell><Cell className="tabular-nums text-ok">{summary.data.agents.enabled}</Cell></Row>
                <Row><Cell className="font-medium text-[13px]">Runs (total)</Cell><Cell className="tabular-nums">{summary.data.runs.total}</Cell></Row>
                <Row><Cell className="font-medium text-[13px]">Runs today</Cell><Cell className="tabular-nums">{summary.data.runs.today}</Cell></Row>
                <Row><Cell className="font-medium text-[13px]">Active runs</Cell><Cell className="tabular-nums">{summary.data.runs.active}</Cell></Row>
                <Row><Cell className="font-medium text-[13px]">Completed runs</Cell><Cell className="tabular-nums text-ok">{summary.data.runs.completed}</Cell></Row>
                <Row><Cell className="font-medium text-[13px]">Failed runs</Cell><Cell className="tabular-nums text-danger">{summary.data.runs.failed}</Cell></Row>
                <Row><Cell className="font-medium text-[13px]">Cancelled runs</Cell><Cell className="tabular-nums text-muted">{summary.data.runs.cancelled}</Cell></Row>
                <Row><Cell className="font-medium text-[13px]">Tool calls today</Cell><Cell className="tabular-nums">{summary.data.toolCalls.today}</Cell></Row>
                <Row><Cell className="font-medium text-[13px]">Tool failures today</Cell><Cell className="tabular-nums text-danger">{summary.data.toolCalls.failures}</Cell></Row>
                <Row><Cell className="font-medium text-[13px]">Pending approvals</Cell><Cell className="tabular-nums text-warn">{summary.data.policy.pendingApprovals}</Cell></Row>
                <Row><Cell className="font-medium text-[13px]">Blocks today</Cell><Cell className="tabular-nums text-danger">{summary.data.policy.blocksToday}</Cell></Row>
                <Row><Cell className="font-medium text-[13px]">Blocks all time</Cell><Cell className="tabular-nums text-danger">{summary.data.policy.blocksAllTime}</Cell></Row>
                <Row><Cell className="font-medium text-[13px]">MCP servers</Cell><Cell className="tabular-nums">{summary.data.mcpServers}</Cell></Row>
                <Row><Cell className="font-medium text-[13px]">Workflows</Cell><Cell className="tabular-nums">{summary.data.workflows}</Cell></Row>
                <Row><Cell className="font-medium text-[13px]">Tools</Cell><Cell className="tabular-nums">{summary.data.tools}</Cell></Row>
              </Table>
            )}
          </Card>

          <Card className="p-4 mb-4">
            <div className="text-[13px] font-medium mb-3">Providers</div>
            {providers.data && providers.data.providers.length > 0 ? (
              <Table head={['Provider', 'Locality', 'Status', 'Detail', 'Cost']}>
                {providers.data.providers.map((p) => (
                  <Row key={p.name}>
                    <Cell className="font-mono text-[13px] font-medium">{p.name}</Cell>
                    <Cell><StatusPill status={p.locality as any} label={p.locality} /></Cell>
                    <Cell><StatusPill status={p.status as any} /></Cell>
                    <Cell className="text-[11px] text-muted max-w-[240px] truncate">{p.detail}</Cell>
                    <Cell className="text-[11px] text-muted">{p.cost}</Cell>
                  </Row>
                ))}
              </Table>
            ) : (
              <div className="text-muted text-[13px] py-4">No providers configured. The demo uses the deterministic mock provider.</div>
            )}
            {providers.data && (
              <div className="mt-3 pt-3 border-t border-border">
                <div className="text-[12px] font-medium">Browser</div>
                <div className="flex items-center gap-2 mt-1">
                  <StatusPill status={providers.data.browser.available ? 'completed' : 'failed'} label={providers.data.browser.available ? 'available' : 'unavailable'} />
                  {providers.data.browser.reason ? <span className="text-[11px] text-muted">{providers.data.browser.reason}</span> : null}
                </div>
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="text-[13px] font-medium mb-3">Health checks</div>
            {doctor.data && doctor.data.checks.length > 0 ? (
              <>
                <Table head={['Check', 'Status', 'Detail']}>
                  {doctor.data.checks.map((c) => (
                    <Row key={c.name}>
                      <Cell className="font-medium text-[13px]">{c.name}</Cell>
                      <Cell><StatusPill status={c.status} label={(c.status as string) === 'not-configured' ? 'not configured' : String(c.status)} /></Cell>
                      <Cell className="text-[11px] text-muted max-w-[300px] truncate">{c.detail}</Cell>
                    </Row>
                  ))}
                </Table>                <div className="mt-3 text-[12px] text-muted">
                  {doctor.data.checks.filter((c) => c.required).length} required · {((() => { const passes = doctor.data!.checks.filter(c => c.status === 'pass' && c.required).length; return passes; })())} passing
                </div>
              </>
            ) : (
              <div className="text-muted text-[13px] py-4">No checks available.</div>
            )}
          </Card>
        </>
      )}

      {tab === 'audit' && (
        <>
          <Card className="p-4 mb-4">
            <div className="flex items-center justify-between">
              <div className="text-[13px] font-medium">Audit log</div>
              <div className="text-[11px] text-muted">{audit.data?.entries.length ?? 0} entries</div>
            </div>
          </Card>
          {audit.data && audit.data.entries.length > 0 ? (
            <Table head={['#', 'Timestamp', 'Actor', 'Action', 'Target', 'Details']}>
              {audit.data.entries.map((e) => (
                <Row key={e.id}>
                  <Cell className="font-mono text-[12px]">{e.id}</Cell>
                  <Cell className="text-[12px] text-muted font-mono">{fmtDateTime(e.ts)}</Cell>
                  <Cell className="font-mono text-[12px]">{e.actor}</Cell>
                  <Cell className="text-[12px] font-medium">{e.action}</Cell>
                  <Cell className="text-[12px] text-muted font-mono max-w-[160px] truncate">{e.target ?? '—'}</Cell>
                  <Cell>
                    <details>
                      <summary className="text-[11px] text-muted cursor-pointer hover:text-ink">{Object.keys(e.details ?? {}).length} fields</summary>
                      <div className="mt-1">
                        <CodeBlock maxLines={8}>{JSON.stringify(e.details, null, 2)}</CodeBlock>
                      </div>
                    </details>
                  </Cell>
                </Row>
              ))}
            </Table>
          ) : (
            <EmptyState title="No audit entries" hint="Audit events are recorded as agents, runs, and operators interact with the system." />
          )}
        </>
      )}
    </div>
  );
}
