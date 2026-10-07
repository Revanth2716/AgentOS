// Acceptance flow against a running AgentOS server (default :8791).
const BASE = process.env.BASE ?? 'http://127.0.0.1:8791';

const j = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${opts.method ?? 'GET'} ${path} -> ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => console.log(`· ${msg}`);

// 1. health + summary
const health = await j('/api/v1/system/health');
step(`health ok=${health.ok} demo=${health.demoMode} migrations=${health.dbMigrations}`);

// 2. run an agent to completion
const agents = await j('/api/v1/agents');
const researcher = agents.agents.find((a) => a.name === 'Researcher');
step(`agents: ${agents.agents.map((a) => a.name).join(', ')}`);
const { run } = await j(`/api/v1/agents/${researcher.id}/run`, { method: 'POST', body: { task: 'Find three facts about agents', seed: 42 } });
let detail;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  detail = await j(`/api/v1/runs/${run.id}`);
  if (['completed', 'failed', 'cancelled'].includes(detail.run.status)) break;
}
if (detail.run.status !== 'completed') throw new Error(`run ended ${detail.run.status}: ${detail.run.error}`);
step(`run ${run.id}: ${detail.run.status} steps=${detail.run.steps} tools=${detail.run.toolCalls} events=${detail.events.length} decisions=${detail.decisions.length} cost=$${detail.run.costUsd}`);
if (!detail.run.finalResult.includes('[source:')) throw new Error('final answer missing citations');
if (detail.events.at(-1).type !== 'run_completed') throw new Error('trace does not end with run_completed');

// 3. replay determinism
const replay = await j(`/api/v1/runs/${run.id}/replay`, { method: 'POST', body: {} });
step(`replay ${replay.replayRunId}: identical=${replay.identical} diffs=${replay.differences.length}`);
if (!replay.identical) throw new Error(`replay drifted: ${JSON.stringify(replay.differences.slice(0, 3))}`);

// 4. workflow with approvals
const { workflowRun } = await j('/api/v1/workflows/research-report/run', {
  method: 'POST',
  body: { input: { task: 'Find three facts about agents' } },
});
step(`workflow ${workflowRun.id} started`);
let wf, approvals = [], guard = 0;
for (; guard < 60; guard++) {
  await sleep(1000);
  wf = await j(`/api/v1/workflow-runs/${workflowRun.id}`);
  approvals = wf.approvals.filter((a) => a.status === 'pending');
  if (approvals.length > 0) {
    const a = approvals[0];
    step(`approval required: ${a.kind} on ${a.tool} — "${a.summary}" → approving`);
    await j(`/api/v1/approvals/${a.id}/approve`, { method: 'POST', body: { decidedBy: 'acceptance-test' } });
    continue;
  }
  if (['completed', 'failed', 'cancelled'].includes(wf.workflowRun.status)) break;
}
if (wf.workflowRun.status !== 'completed') throw new Error(`workflow ended ${wf.workflowRun.status}: ${wf.workflowRun.error}`);
step(`workflow completed: nodes=${wf.nodeRuns.map((n) => `${n.nodeId}:${n.status}`).join(', ')}`);
step(`approvals: ${wf.approvals.map((a) => `${a.kind}:${a.status}`).join(', ')}`);

// 5. eval suite
const suites = await j('/api/v1/evals/suites');
const suite = suites.suites[0];
await j(`/api/v1/evals/suites/${suite.id}/run`, { method: 'POST', body: {} });
let evalRun = null;
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  const runs = await j('/api/v1/evals/runs');
  evalRun = runs.evalRuns.find((r) => r.suiteId === suite.id);
  if (evalRun && ['completed', 'failed'].includes(evalRun.status)) break;
}
const evalFull = await j(`/api/v1/evals/runs/${evalRun.id}`);
step(`eval: status=${evalRun.status} passed=${evalRun.summary?.passed}/${evalRun.summary?.cases} rate=${((evalRun.summary?.successRate ?? 0) * 100).toFixed(0)}% avgSteps=${evalRun.summary?.avgSteps} violations=${evalRun.summary?.policyViolations} cost=$${evalRun.summary?.totalCostUsd}`);
if (evalRun.status !== 'completed') throw new Error(`eval failed: ${evalRun.error}`);
if (evalFull.results.length !== evalRun.summary.cases) throw new Error('case results missing');

// 6. metrics + summary + doctor
const summary = await j('/api/v1/system/summary');
step(`summary: runs=${summary.runs.total} cost=$${summary.cost.todayUsd.toFixed(4)} tokens=${summary.cost.tokensToday} mock=${summary.cost.mockCalls} cloud=${summary.cost.cloudCalls} pendingApprovals=${summary.policy.pendingApprovals} evalScore=${summary.evaluation.successRate}`);
if (summary.cost.allTimeUsd !== 0) throw new Error('expected $0.00 total cost in demo mode');
const metrics = await fetch(`${BASE}/metrics`);
const metricsText = await metrics.text();
if (!metricsText.includes('agentos_runs_total')) throw new Error('prometheus metrics missing agentos_runs_total');
step(`prometheus: ${metricsText.split('\n').length} lines`);
const doctor = await j('/api/v1/system/doctor');
const failed = doctor.checks.filter((c) => c.status === 'fail' && c.required);
step(`doctor: ${doctor.checks.map((c) => `${c.status === 'pass' ? '✓' : c.status === 'warn' ? '⚠' : '✗'} ${c.name}`).join(', ')}`);
if (failed.length > 0) throw new Error(`doctor required failures: ${failed.map((f) => f.name).join(', ')}`);

// 7. SSE stream sanity
const ac = new AbortController();
const sseRes = await fetch(`${BASE}/api/v1/events/stream`, { signal: ac.signal });
const reader = sseRes.body.getReader();
const decoder = new TextDecoder();
let sseBuf = '';
while (sseBuf.length < 10) {
  const { value, done } = await reader.read();
  if (done) break;
  sseBuf += decoder.decode(value, { stream: true });
}
ac.abort();
if (!sseBuf.includes('event: connected')) throw new Error('SSE did not emit connected');
step('SSE stream: connected event received');

console.log('\nACCEPTANCE FLOW: ALL CHECKS PASSED');
