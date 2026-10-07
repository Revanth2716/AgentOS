import type {
  Agent,
  AgentListItem,
  Approval,
  AuditEntry,
  DoctorCheck,
  EvalCaseResult,
  EvalRun,
  EvalSuite,
  McpServer,
  PolicyDecision,
  PolicyEntity,
  Run,
  RunEvent,
  RunMetrics,
  Summary,
  ToolRow,
  Workflow,
  WorkflowNodeRun,
  WorkflowRun,
} from './types.js';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  const data = (await res.json().catch(() => null)) as T | { error?: string } | null;
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in data ? (data as { error: string }).error : `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

const post = <T,>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body ?? {}) });

export const api = {
  // system
  health: () => request<{ ok: boolean; demoMode: boolean; uptimeSec: number }>('/api/v1/system/health'),
  summary: () => request<Summary>('/api/v1/system/summary'),
  timeseries: (days = 14) =>
    request<{ runs: { day: string; runs: number; failed: number }[]; costs: { day: string; costUsd: number; tokens: number }[] }>(
      `/api/v1/system/timeseries?days=${days}`,
    ),
  providers: () =>
    request<{ providers: { name: string; locality: string; status: string; detail: string; cost: string }[]; browser: { available: boolean; reason?: string } }>(
      '/api/v1/system/providers',
    ),
  doctor: () => request<{ checks: DoctorCheck[] }>('/api/v1/system/doctor'),
  settings: () =>
    request<{ settings: Record<string, unknown>; counts: Record<string, number> }>('/api/v1/settings'),
  audit: (limit = 100) => request<{ entries: AuditEntry[] }>(`/api/v1/audit?limit=${limit}`),

  // agents
  agents: (search?: string) => request<{ agents: AgentListItem[]; total: number }>(`/api/v1/agents${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  agent: (id: string) =>
    request<{
      agent: Agent;
      versions: { id: string; version: number; createdAt: number }[];
      performance: { runs: number; successRate: number; avgDurationMs: number; avgSteps: number; costUsd: number };
      evalSummary: EvalRun['summary'];
      capabilities: { name: string; registered: boolean; risk: string; kind: string; description: string; permissionOk: boolean; missing: string[]; enabled: boolean }[];
      recentRuns: Run[];
      policies: PolicyEntity[];
    }>(`/api/v1/agents/${id}`),
  createAgent: (spec: unknown) => post<{ agent: Agent }>('/api/v1/agents', spec),
  updateAgent: (id: string, patch: unknown) =>
    request<{ agent: Agent }>(`/api/v1/agents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAgent: (id: string) => request<{ deleted: boolean }>(`/api/v1/agents/${id}`, { method: 'DELETE' }),
  setAgentEnabled: (id: string, enabled: boolean) =>
    post<{ agent: Agent }>(`/api/v1/agents/${id}/${enabled ? 'enable' : 'disable'}`),
  runAgent: (id: string, task: string, seed?: number) =>
    post<{ run: Run }>(`/api/v1/agents/${id}/run`, { task, seed }),

  // runs
  runs: (q: { status?: string; agentId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (q.status) params.set('status', q.status);
    if (q.agentId) params.set('agentId', q.agentId);
    if (q.limit) params.set('limit', String(q.limit));
    return request<{ runs: Run[]; total: number }>(`/api/v1/runs?${params}`);
  },
  run: (id: string) =>
    request<{
      run: Run;
      agentName: string;
      events: RunEvent[];
      decisions: PolicyDecision[];
      approvals: Approval[];
      metrics: RunMetrics;
      evalResults: { evalRunId: string; caseId: string; passed: boolean; failureReason: string | null }[];
      isReplay: boolean;
    }>(`/api/v1/runs/${id}`),
  cancelRun: (id: string) => post<{ run: Run }>(`/api/v1/runs/${id}/cancel`),
  replayRun: (id: string) =>
    post<{ originalRunId: string; replayRunId: string; identical: boolean; differences: { seq: number; original: string; replay: string | null }[] }>(
      `/api/v1/runs/${id}/replay`,
    ),

  // approvals
  approvals: (status?: string) =>
    request<{ approvals: Approval[]; pending: number }>(`/api/v1/approvals${status ? `?status=${status}` : ''}`),
  decideApproval: (id: string, approve: boolean, decidedBy = 'operator') =>
    post<{ approval: Approval }>(`/api/v1/approvals/${id}/${approve ? 'approve' : 'deny'}`, { decidedBy }),

  // tools
  tools: () => request<{ tools: ToolRow[] }>('/api/v1/tools'),
  setToolEnabled: (name: string, enabled: boolean) =>
    post<{ tool: ToolRow }>(`/api/v1/tools/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`),
  invokeTool: (name: string, args: Record<string, unknown>) =>
    post<{ result: { ok: boolean; output: string; error?: string; durationMs: number } }>(
      `/api/v1/tools/${encodeURIComponent(name)}/invoke`,
      { args },
    ),

  // policies
  policies: () => request<{ policies: PolicyEntity[] }>('/api/v1/policies'),
  createPolicy: (spec: unknown) => post<{ policy: PolicyEntity }>('/api/v1/policies', spec),
  updatePolicy: (id: string, patch: unknown) =>
    request<{ policy: PolicyEntity }>(`/api/v1/policies/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deletePolicy: (id: string) => request<{ deleted: boolean }>(`/api/v1/policies/${id}`, { method: 'DELETE' }),
  evaluatePolicy: (agentId: string, tool: string) =>
    post<{ decision: { decision: string; rule: string | null; reason: string }; toolKnown: boolean; toolRisk: string }>(
      '/api/v1/policies/evaluate',
      { agentId, tool },
    ),

  // workflows
  workflows: () => request<{ workflows: Workflow[] }>('/api/v1/workflows'),
  workflow: (id: string) =>
    request<{ workflow: Workflow; recentRuns: WorkflowRun[]; agents: { node: string; agent: Agent | null }[] }>(
      `/api/v1/workflows/${id}`,
    ),
  createWorkflow: (spec: unknown) => post<{ workflow: Workflow }>('/api/v1/workflows', spec),
  runWorkflow: (id: string, input: Record<string, unknown>) =>
    post<{ workflowRun: WorkflowRun }>(`/api/v1/workflows/${id}/run`, { input }),
  workflowRun: (id: string) =>
    request<{
      workflowRun: WorkflowRun;
      workflow: Workflow | null;
      nodeRuns: WorkflowNodeRun[];
      childRuns: Run[];
      approvals: Approval[];
    }>(`/api/v1/workflow-runs/${id}`),
  cancelWorkflowRun: (id: string) => post<{ workflowRun: WorkflowRun }>(`/api/v1/workflow-runs/${id}/cancel`),
  workflowRuns: (workflowId?: string) =>
    request<{ workflowRuns: WorkflowRun[] }>(`/api/v1/workflow-runs${workflowId ? `?workflowId=${workflowId}` : ''}`),

  // evaluations
  evalSuites: () => request<{ suites: EvalSuite[] }>('/api/v1/evals/suites'),
  createEvalSuite: (spec: unknown) => post<{ suite: EvalSuite }>('/api/v1/evals/suites', spec),
  deleteEvalSuite: (id: string) => request<{ deleted: boolean }>(`/api/v1/evals/suites/${id}`, { method: 'DELETE' }),
  runEvalSuite: (id: string) => post<{ evalRun: EvalRun | null }>(`/api/v1/evals/suites/${id}/run`),
  evalRuns: (suiteId?: string) =>
    request<{ evalRuns: EvalRun[] }>(`/api/v1/evals/runs${suiteId ? `?suiteId=${suiteId}` : ''}`),
  evalRun: (id: string) =>
    request<{ evalRun: EvalRun; results: EvalCaseResult[]; suite: EvalSuite | null }>(`/api/v1/evals/runs/${id}`),

  // mcp
  mcpServers: () => request<{ servers: McpServer[] }>('/api/v1/mcp/servers'),
  addMcpServer: (spec: unknown) =>
    post<{ server: McpServer; tools: number; connected: boolean; error?: string }>('/api/v1/mcp/servers', spec),
  reconnectMcp: (id: string) =>
    post<{ server: McpServer; tools: number; connected: boolean; error?: string }>(`/api/v1/mcp/servers/${id}/reconnect`),
  deleteMcpServer: (id: string) => request<{ deleted: boolean }>(`/api/v1/mcp/servers/${id}`, { method: 'DELETE' }),
};
