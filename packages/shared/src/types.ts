/** Canonical status and enum unions used across AgentOS. */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export const OPEN_RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting_approval',
  'paused',
];

export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export type PolicyAction = 'allow' | 'deny' | 'require_approval' | 'rate_limited';

export type WorkflowStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type WorkflowNodeStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'skipped';

export type EvalStatus = 'queued' | 'running' | 'completed' | 'failed';

/** Locality of a model provider — drives the "cost = $0" display. */
export type ProviderLocality = 'mock' | 'local' | 'cloud';

export const ID_PREFIXES = {
  agent: 'agt',
  agentVersion: 'agtver',
  tool: 'tool',
  policy: 'pol',
  run: 'run',
  approval: 'apr',
  workflow: 'wf',
  workflowRun: 'wfr',
  workflowNodeRun: 'wfnr',
  evalSuite: 'suite',
  evalRun: 'eval',
  mcpServer: 'mcp',
} as const;

/** Key into ID_PREFIXES ('agent', 'run', …); rendered IDs are agt_1, run_2, … */
export type IdPrefix = keyof typeof ID_PREFIXES;

export function formatId(prefix: IdPrefix, n: number): string {
  return `${ID_PREFIXES[prefix]}_${n}`;
}
