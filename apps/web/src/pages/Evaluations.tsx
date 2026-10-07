import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';
import { usePoll, fmtDuration, fmtCost, fmtRelative, fmtDateTime } from '../lib/hooks.js';
import type { EvalSuite, EvalRun, EvalCaseResult } from '../lib/types.js';
import { Button, Card, Cell, CodeBlock, EmptyState, ErrorState, PageHeader, Row, Spinner, StatusPill, Table } from '../components/ui.js';
import { Donut, ProgressBar } from '../components/charts.js';

export default function Evaluations() {
  const [openRun, setOpenRun] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [selectedSuite, setSelectedSuite] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const { data: suitesData, loading: suitesLoading, refresh: refreshSuites } = usePoll(() => api.evalSuites(), 4_000);
  const { data: runsData, loading: runsLoading, refresh: refreshRuns } = usePoll(() => api.evalRuns(), 3_000);

  const runSuite = useMutation({
    mutationFn: (id: string) => api.runEvalSuite(id),
    onSuccess: (res) => {
      if (res.evalRun) {
        setSelectedRun(res.evalRun.id);
        setShowResults(true);
        void qc.invalidateQueries();
      }
    },
    onError: (e: ApiError) => setError(e.message),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteEvalSuite(id),
    onSuccess: () => { void qc.invalidateQueries(); refreshSuites(); },
    onError: (e: ApiError) => setError(e.message),
  });

  if (suitesLoading && !suitesData) return <Spinner />;
  if (runsLoading && !runsData && !showResults) return <Spinner label="Loading…" />;

  return (
    <div>
      <PageHeader
        title="Evaluations"
        subtitle="Deterministic evaluation suites — run an agent against a set of cases and verify expected behavior."
        actions={
          <Button variant="secondary" onClick={() => setOpenRun(true)}>Run suite</Button>
        }
      />

      {error ? <div className="mb-3 text-danger bg-danger-soft border border-danger/30 rounded-lg p-2.5 text-[13px]">{error}</div> : null}

      {!showResults && (
        <>
          {suitesData && suitesData.suites.length === 0 ? (
            <EmptyState title="No evaluation suites" hint="The demo ships with a research-agent-eval suite." />
          ) : null}
          {suitesData && suitesData.suites.length > 0 ? (
            <Table head={['Suite', 'Agent', 'Cases', 'Recent runs', 'Success', 'Avg steps', 'Policy violations', 'Cost', 'Updated']}>
              {suitesData.suites.map((s: EvalSuite) => {
                const last = s.recentRuns?.[0];
                const summary = last?.summary;
                return (
                  <Row key={s.id} onClick={() => { setSelectedSuite(s.id); setOpenRun(true); }}>
                    <Cell>
                      <div className="font-medium text-[13px]">{s.name}</div>
                      <div className="text-[11px] text-muted max-w-[240px] truncate">{s.description}</div>
                      <div className="text-[10px] text-muted font-mono mt-0.5">{s.id}</div>
                    </Cell>
                    <Cell className="font-mono text-[12px]">{s.agentId}</Cell>
                    <Cell className="tabular-nums">{s.cases.length}</Cell>
                    <Cell className="tabular-nums">{s.recentRuns?.length ?? 0}</Cell>
                    <Cell>
                      {summary ? (
                        <span className={summary.successRate >= 0.8 ? 'text-ok font-medium' : 'text-warn font-medium'}>
                          {Math.round(summary.successRate * 100)}%
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Cell>
                    <Cell className="tabular-nums text-muted">{summary ? summary.avgSteps.toFixed(1) : '—'}</Cell>
                    <Cell className={`tabular-nums ${summary && summary.policyViolations > 0 ? 'text-danger' : 'text-muted'}`}>
                      {summary ? summary.policyViolations : '—'}
                    </Cell>
                    <Cell className="tabular-nums text-ok">{summary ? fmtCost(summary.totalCostUsd) : '—'}</Cell>
                    <Cell className="text-[12px] text-muted">—</Cell>
                  </Row>
                );
              })}
            </Table>
          ) : null}
        </>
      )}

      {showResults && selectedRun && (
        <>
          <div className="flex items-center justify-between mb-4">
            <div className="text-[13px]">
              Viewing results for <span className="font-mono text-accent">{selectedRun}</span>
              {' '}<button type="button" className="text-muted hover:text-ink" onClick={() => { setShowResults(false); setSelectedRun(null); }}>view all suites</button>
            </div>
            <Button variant="ghost" onClick={() => setShowResults(false)}>Close</Button>
          </div>
          {runsData && runsData.evalRuns.length > 0 ? (
            <Table head={['Eval run', 'Suite', 'Agent', 'Status', 'Cases', 'Passed', 'Failed', 'Success', 'Avg steps', 'Violations', 'Cost', 'Started']}>
              {runsData.evalRuns.map((r: EvalRun) => {
                const summary = r.summary;
                return (
                  <Row key={r.id} onClick={() => { setSelectedRun(r.id); }}>
                    <Cell className="font-mono text-[12px]">{r.id}</Cell>
                    <Cell className="text-[12px] text-muted">{r.suiteId}</Cell>
                    <Cell className="font-mono text-[12px]">{r.agentId}</Cell>
                    <Cell><StatusPill status={r.status} /></Cell>
                    <Cell className="tabular-nums">{summary ? summary.cases : '—'}</Cell>
                    <Cell className="tabular-nums text-ok">{summary ? summary.passed : '—'}</Cell>
                    <Cell className="tabular-nums text-danger">{summary ? summary.failed : '—'}</Cell>
                    <Cell>{summary ? <span className={`font-medium ${summary.successRate >= 0.8 ? 'text-ok' : summary.successRate >= 0.5 ? 'text-warn' : 'text-danger'}`}>{Math.round(summary.successRate * 100)}%</span> : '—'}</Cell>
                    <Cell className="tabular-nums text-muted">{summary ? summary.avgSteps.toFixed(1) : '—'}</Cell>
                    <Cell className={`tabular-nums ${summary && summary.policyViolations > 0 ? 'text-danger' : 'text-muted'}`}>{summary ? summary.policyViolations : '—'}</Cell>
                    <Cell className="tabular-nums text-ok">{summary ? fmtCost(summary.totalCostUsd) : '—'}</Cell>
                    <Cell className="text-[12px] text-muted">{r.startedAt ? fmtRelative(r.startedAt) : '—'}</Cell>
                  </Row>
                );
              })}
            </Table>
          ) : null}

          {selectedRun && runsData && (() => {
            const run = runsData.evalRuns.find((r: EvalRun) => r.id === selectedRun);
            if (!run || !run.summary) return (
              <Card className="p-4 mt-4">
                <div className="text-muted text-[13px] py-4">Run still in progress…</div>
              </Card>
            );
            const summary = run.summary;
            return (
              <>
                <Card className="p-4 mt-4">
                  <div className="text-[13px] font-medium mb-2">Run details — {selectedRun}</div>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                    <Card className="p-4">
                      <div className="text-[11px] uppercase text-muted tracking-wider">Success rate</div>
                      <div className="flex items-center gap-3 mt-2">
                        <Donut value={summary.successRate} size={56} color={summary.successRate >= 0.8 ? 'var(--ok)' : 'var(--warn)'} />
                        <div className="text-[13px]"><div>{summary.passed}/{summary.cases} cases</div><div className="text-muted text-[12px]">{summary.avgSteps} avg steps</div></div>
                      </div>
                    </Card>
                    <Card className="p-4">
                      <div className="text-[11px] uppercase text-muted tracking-wider">Duration</div>
                      <div className="text-2xl font-semibold mt-1.5 tabular-nums">{fmtDuration(summary.avgLatencyMs)}</div>
                      <div className="text-[12px] text-muted mt-1">avg per case</div>
                    </Card>
                    <Card className="p-4">
                      <div className="text-[11px] uppercase text-muted tracking-wider">Tool success</div>
                      <div className="text-2xl font-semibold mt-1.5 tabular-nums">{Math.round(summary.avgToolSuccessRate * 100)}%</div>
                      <div className="text-[12px] text-muted mt-1">avg tool success rate</div>
                    </Card>
                    <Card className="p-4">
                      <div className="text-[11px] uppercase text-muted tracking-wider">Cost</div>
                      <div className="text-2xl font-semibold mt-1.5 text-ok tabular-nums">{fmtCost(summary.totalCostUsd)}</div>
                      <div className="text-[12px] text-muted mt-1">total for suite</div>
                    </Card>
                  </div>
                  <div className="mb-3">
                    <div className="text-[12px] text-muted mb-1">Tool success rate</div>
                    <ProgressBar value={summary.avgToolSuccessRate} max={1} color="var(--ok)" />
                    <div className="text-[11px] text-muted mt-1">{Math.round(summary.avgToolSuccessRate * 100)}%</div>
                  </div>
                  <div className="mb-3">
                    <div className="text-[12px] text-muted mb-1">Policy violations</div>
                    <ProgressBar value={summary.policyViolations} max={summary.cases} color="var(--danger)" />
                    <div className="text-[11px] text-muted mt-1">{summary.policyViolations} violations</div>
                  </div>
                  <div className="mb-3">
                    <div className="text-[12px] text-muted mb-1">Recovery rate</div>
                    <ProgressBar value={summary.recoveryRate} max={1} color="var(--accent)" />
                    <div className="text-[11px] text-muted mt-1">{Math.round(summary.recoveryRate * 100)}%</div>
                  </div>
                </Card>
                <Card className="p-4 mt-4">
                  <div className="text-[13px] font-medium mb-3">Case results</div>
                  <Table head={['Case', 'Name', 'Status', 'Run', 'Steps', 'Duration', 'Tool calls', 'Tool failures', 'Retries', 'Violations', 'Recovery', 'Cost', 'Failure reason']}>
                    <tr className="text-muted text-[12px]"><td colSpan={13} className="py-3">Case-level results are available in the eval run detail view.</td></tr>
                  </Table>
                </Card>
              </>
            );
          })()}
        </>
      )}

      {openRun && (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 overflow-y-auto bg-black/50" onClick={() => setOpenRun(false)}>
          <div className="bg-panel border border-border rounded-xl shadow-2xl w-full max-w-xl mt-8" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
              <h2 className="font-semibold text-[15px]">Run evaluation suite</h2>
              <button onClick={() => setOpenRun(false)} className="text-muted hover:text-ink text-lg leading-none px-1">×</button>
            </div>
            <div className="p-5 space-y-3">
              {suitesData && suitesData.suites.length === 0 ? (
                <div className="text-muted text-[13px]">No suites available.</div>
              ) : (
                <>
                  <div className="text-[12px] text-muted">Select a suite to run.</div>
                  <div className="flex gap-2">
                    <select
                      className="flex-1 bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-accent"
                      value={selectedSuite ?? ''}
                      onChange={(e) => setSelectedSuite(e.target.value || null)}
                    >
                      <option value="">select a suite…</option>
                      {suitesData?.suites.map((s: EvalSuite) => (
                        <option key={s.id} value={s.id}>{s.name} ({s.cases.length} cases)</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={() => setOpenRun(false)}>Cancel</Button>
                    <Button onClick={() => { if (selectedSuite) runSuite.mutate(selectedSuite); }} disabled={!selectedSuite || runSuite.isPending}>
                      {runSuite.isPending ? 'Running…' : 'Run'}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {!showResults && suitesData && suitesData.suites.length > 0 && (
        <div className="mt-4">
          <div className="text-[13px] font-medium mb-2">Recent eval runs</div>
          {runsData && runsData.evalRuns.length > 0 ? (
            <Table head={['Eval run', 'Suite', 'Agent', 'Status', 'Cases', 'Passed', 'Failed', 'Success', 'Cost', 'Started']}>
              {runsData.evalRuns.slice(0, 10).map((r: EvalRun) => {
                const summary = r.summary;
                return (
                  <Row key={r.id} onClick={() => { setSelectedRun(r.id); setShowResults(true); }}>
                    <Cell className="font-mono text-[12px]">{r.id}</Cell>
                    <Cell className="text-[12px] text-muted">{r.suiteId}</Cell>
                    <Cell className="font-mono text-[12px]">{r.agentId}</Cell>
                    <Cell><StatusPill status={r.status} /></Cell>
                    <Cell className="tabular-nums">{summary ? summary.cases : '—'}</Cell>
                    <Cell className="tabular-nums text-ok">{summary ? summary.passed : '—'}</Cell>
                    <Cell className="tabular-nums text-danger">{summary ? summary.failed : '—'}</Cell>
                    <Cell>{summary ? <span className={`font-medium ${summary.successRate >= 0.8 ? 'text-ok' : 'text-warn'}`}>{Math.round(summary.successRate * 100)}%</span> : '—'}</Cell>
                    <Cell className="tabular-nums text-ok">{summary ? fmtCost(summary.totalCostUsd) : '—'}</Cell>
                    <Cell className="text-[12px] text-muted">{r.startedAt ? fmtRelative(r.startedAt) : '—'}</Cell>
                  </Row>
                );
              })}
            </Table>
          ) : (
            <div className="text-muted text-[13px] py-4">No eval runs yet. Run a suite to see results.</div>
          )}
        </div>
      )}
    </div>
  );
}
