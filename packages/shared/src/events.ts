/** Ordered catalog of every run-event type (the execution trace vocabulary). */
export const RUN_EVENT_TYPES = [
  'task_received',
  'planning_started',
  'planning_completed',
  'model_called',
  'model_completed',
  'tool_called',
  'tool_completed',
  'tool_failed',
  'retry',
  'policy_check',
  'policy_blocked',
  'policy_rate_limited',
  'approval_requested',
  'approval_granted',
  'approval_denied',
  'provider_fallback',
  'step_completed',
  'limit_warning',
  'run_completed',
  'run_failed',
  'run_cancelled',
  'run_interrupted',
  'run_resumed',
  'workflow_started',
  'workflow_node_started',
  'workflow_node_completed',
  'workflow_node_failed',
  'workflow_completed',
  'workflow_failed',
  'workflow_cancelled',
  'eval_started',
  'eval_case_completed',
  'eval_completed',
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export type EventStatus = 'ok' | 'error' | 'pending';

/** One entry of the append-only execution trace. */
export interface RunEvent {
  id?: number;
  runId: string;
  seq: number;
  ts: number;
  type: RunEventType;
  agentId?: string | null;
  tool?: string | null;
  /** JSON-serializable payload (already redacted by the writer). */
  payload?: Record<string, unknown> | null;
  durationMs?: number | null;
  status?: EventStatus | null;
  traceId?: string | null;
  spanId?: string | null;
}

/** Workflow-scoped events reuse the same shape with a workflowRunId. */
export interface WorkflowEvent extends Omit<RunEvent, 'runId'> {
  workflowRunId: string;
  nodeId?: string | null;
}
