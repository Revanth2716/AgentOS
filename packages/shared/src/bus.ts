/**
 * Event bus contract. AgentOS ships an in-process implementation (default);
 * the interface is the seam for a future NATS adapter.
 */
export type BusTopic = 'run' | 'workflow' | 'eval' | 'system';

export interface BusEvent {
  topic: BusTopic;
  type: string;
  ts: number;
  /** runId for run events, workflowRunId for workflow events, etc. */
  entityId?: string;
  data: Record<string, unknown>;
}

export type BusListener = (event: BusEvent) => void;

export interface EventBus {
  publish(event: BusEvent): void;
  subscribe(listener: BusListener): () => void;
}

export function newBusEvent(
  topic: BusTopic,
  type: string,
  data: Record<string, unknown> = {},
  entityId?: string,
): BusEvent {
  return { topic, type, ts: Date.now(), data, entityId };
}
