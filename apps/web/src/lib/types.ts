export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface PolicyConfig {
  mode: 'allowlist' | 'denylist';
  allowed: string[];
  denied: string[];
  requireApproval: string[];
  rateLimits: Record<string, number>;
}

export interface Limits {
  maxSteps: number;
  maxRuntimeMs: number;
  maxCostUsd: number;
  toolTimeoutMs: number;
  maxRetries: number;
}

export interface Agent {
  id: string;
  seq: number;
  name: string;
  description: string;
  model: string;
  systemPrompt?: string;
  tools: string[];
  permissions: string[];
  policies: PolicyConfig;
  limits: Limits;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Performance {
  runs: number;
  successRate: number;
  avgDurationMs: number;
  avgSteps: number;
  costUsd: number;
}

export interface EvalRunSummary {
  cases: number;
  passed: number;
  failed: number;
  successRate: number;
  avgSteps: number;
  avgLatencyMs: number;
  avgToolSuccessRate: number;
  policyViolations: number;
  recoveryRate: number;
  totalCostUsd: number;
}

export interface AgentListItem extends Agent {
  performance: Performance;
  evalSummary: EvalRunSummary | null;
  toolCount: number;
}

export interface Run {
  id: string;
  seq: number;
  agentId: string;
  workflowRunId: string | null;
  task: string;
  status: RunStatus;
  mode: 'demo' | 'live';
  seed: number;
  provider: string;
  model: string;
  steps: number;
  toolCalls: number;
  toolFailures: number;
  retries: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  error: string | null;
  finalResult: string | null;
  traceId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
}

export interface RunEvent {
  id?: number;
  runId: string;
  seq: number;
  ts: number;
  type: string;
  agentId?: string | null;
  tool?: string | null;
  payload?: Record<string, unknown> | null;
  durationMs?: number | null;
  status?: string | null;
}

export interface PolicyDecision {
  id: number;
  runId: string | null;
  ts: number;
  agentId: string | null;
  tool: string;
  decision: 'allow' | 'deny' | 'require_approval' | 'rate_limited';
  rule: string | null;
  reason: string;
}

export interface Approval {
  id: string;
  seq: number;
  runId: string | null;
  workflowRunId: string | null;
  agentId: string | null;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  reason: string;
  kind: 'tool_execution' | 'human_intervention' | 'workflow_gate';
  status: 'pending' | 'approved' | 'denied';
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

export interface ToolRow {
  id: string;
  name: string;
  description: string;
  kind: string;
  source: 'builtin' | 'mcp';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  permissions: string[];
  inputSchema: Record<string, unknown>;
  enabled: boolean;
  mcpServerId: string | null;
  executable: boolean;
  sampleInput: Record<string, unknown>;
}

export interface PolicyEntity {
  id: string;
  seq: number;
  name: string;
  description: string;
  agentName: string | null;
  rules: { pattern: string; action: 'allow' | 'deny' | 'require_approval'; maxCallsPerRun?: number; note?: string }[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowNode {
  id: string;
  type: 'input' | 'agent' | 'approval' | 'output';
  agentId?: string;
  label?: string;
  inputTemplate?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: { from: string; to: string }[];
}

export interface Workflow {
  id: string;
  seq: number;
  name: string;
  description: string;
  graph: WorkflowGraph;
  enabled: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
  recentRuns?: WorkflowRun[];
}

export interface WorkflowRun {
  id: string;
  seq: number;
  workflowId: string;
  status: RunStatus | 'waiting_approval';
  input: Record<string, unknown>;
  output: unknown;
  error: string | null;
  currentNodes: string[];
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
}

export interface WorkflowNodeRun {
  id: string;
  workflowRunId: string;
  nodeId: string;
  agentId: string | null;
  runId: string | null;
  status: 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'skipped';
  attempt: number;
  startedAt: number | null;
  endedAt: number | null;
  output: unknown;
  error: string | null;
}

export interface EvalCase {
  id: string;
  name: string;
  task: string;
  expect: {
    keywords?: string[];
    minSources?: number;
    requireCitations?: boolean;
    toolsUsed?: string[];
    maxSteps?: number;
    maxDurationMs?: number;
  };
}

export interface EvalSuite {
  id: string;
  seq: number;
  name: string;
  description: string;
  agentId: string;
  cases: EvalCase[];
  agent?: Agent | null;
  recentRuns?: EvalRun[];
}

export interface EvalRun {
  id: string;
  seq: number;
  suiteId: string;
  agentId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  startedAt: number | null;
  endedAt: number | null;
  summary: EvalRunSummary | null;
  error: string | null;
  createdAt: number;
}

export interface EvalCaseResult {
  id: number;
  evalRunId: string;
  caseId: string;
  name: string;
  passed: boolean;
  runId: string | null;
  metrics: {
    completed: boolean;
    steps: number;
    durationMs: number;
    toolSuccessRate: number;
    toolCalls: number;
    toolFailures: number;
    retries: number;
    policyViolations: number;
    recoveryRate: number;
    costUsd: number;
  };
  failureReason: string | null;
}

export interface Summary {
  demoMode: boolean;
  agents: { total: number; enabled: number };
  runs: { today: number; total: number; active: number; completed: number; failed: number; cancelled: number };
  toolCalls: { today: number; failures: number };
  avgLatencyMs: number;
  policy: { blocksToday: number; blocksAllTime: number; requireApprovalToday: number; pendingApprovals: number };
  cost: { todayUsd: number; allTimeUsd: number; tokensToday: number; localCalls: number; cloudCalls: number; mockCalls: number };
  evaluation: { successRate: number | null; cases: number; runId: string | null };
  providers: { name: string; locality: string; active: boolean }[];
  mcpServers: number;
  workflows: number;
  tools: number;
}

export interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  required: boolean;
}

export interface McpServer {
  id: string;
  seq: number;
  name: string;
  command: string;
  args: string[];
  riskLevel: string;
  status: 'unregistered' | 'connected' | 'error';
  toolCount: number;
  connected?: boolean;
}

export interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
}

export interface RunMetrics {
  completed: boolean;
  steps: number;
  durationMs: number;
  toolSuccessRate: number;
  toolCalls: number;
  toolFailures: number;
  retries: number;
  policyViolations: number;
  recoveryRate: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}
