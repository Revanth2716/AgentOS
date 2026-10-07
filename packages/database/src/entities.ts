import type {
  AgentSpec,
  EvalCase,
  Limits,
  PolicyAction,
  ApprovalStatus,
  ProviderLocality,
  RiskLevel,
  RunStatus,
  EvalStatus,
  WorkflowSpec,
  WorkflowStatus,
  WorkflowNodeStatus,
  RunEvent,
} from '@agentos/shared';

export interface Agent extends AgentSpec {
  id: string;
  seq: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  version: number;
  config: AgentSpec;
  createdAt: number;
}

export interface ToolEntity {
  id: string;
  name: string;
  description: string;
  kind: string;
  source: 'builtin' | 'mcp';
  riskLevel: RiskLevel;
  permissions: string[];
  inputSchema: Record<string, unknown>;
  enabled: boolean;
  mcpServerId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PolicyRuleEntity {
  pattern: string;
  action: 'allow' | 'deny' | 'require_approval';
  maxCallsPerRun?: number;
  note?: string;
}

export interface PolicyEntity {
  id: string;
  seq: number;
  name: string;
  description: string;
  agentName: string | null;
  rules: PolicyRuleEntity[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
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
  agentSnapshot: AgentSpec;
  steps: number;
  toolCalls: number;
  toolFailures: number;
  retries: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  error: string | null;
  finalResult: string | null;
  pendingAction: PendingAction | null;
  traceId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
}

/** Tool call parked while waiting for an approval decision. */
export interface PendingAction {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  approvalId: string;
  purpose?: string;
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
  status: ApprovalStatus;
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

export interface WorkflowEntity {
  id: string;
  seq: number;
  name: string;
  description: string;
  graph: WorkflowSpec;
  enabled: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRun {
  id: string;
  seq: number;
  workflowId: string;
  status: WorkflowStatus;
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
  status: WorkflowNodeStatus;
  attempt: number;
  startedAt: number | null;
  endedAt: number | null;
  output: unknown;
  error: string | null;
}

export interface EvalSuite {
  id: string;
  seq: number;
  name: string;
  description: string;
  agentId: string;
  cases: EvalCase[];
  createdAt: number;
  updatedAt: number;
}

export interface EvalRun {
  id: string;
  seq: number;
  suiteId: string;
  agentId: string;
  status: EvalStatus;
  startedAt: number | null;
  endedAt: number | null;
  summary: EvalRunSummary | null;
  error: string | null;
  createdAt: number;
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

export interface EvalCaseResult {
  id: number;
  evalRunId: string;
  caseId: string;
  name: string;
  passed: boolean;
  runId: string | null;
  metrics: RunMetrics;
  failureReason: string | null;
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

export interface CostEntry {
  id: number;
  runId: string | null;
  ts: number;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  locality: ProviderLocality;
}

export interface McpServerEntity {
  id: string;
  seq: number;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  riskLevel: RiskLevel;
  status: 'unregistered' | 'connected' | 'error';
  toolCount: number;
  lastDiscoveredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
}

export interface CorpusDoc {
  id: string;
  title: string;
  source: string;
  url: string;
  published: string;
  tags: string[];
  content: string;
  citations: string[];
}

export interface DecisionRecord {
  id: number;
  runId: string | null;
  ts: number;
  agentId: string | null;
  tool: string;
  decision: PolicyAction;
  rule: string | null;
  reason: string;
  argsDigest: string | null;
}

export type { RunEvent, RunMetrics as RunMetricsShape };
