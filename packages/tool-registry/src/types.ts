import type { ZodType } from 'zod';
import type { RiskLevel } from '@agentos/shared';

export interface ToolLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface ToolContext {
  runId: string;
  agentId: string;
  /** Abort signal wired to run cancellation and step timeouts. */
  signal: AbortSignal;
  /** Filesystem sandbox root for this run. */
  workspaceDir: string;
  /** Directory where publish-style tools may write (approval-gated). */
  artifactsDir: string;
  logger: ToolLogger;
  /**
   * Pauses the run for an operator decision (e.g. human verification on a
   * blocked page). Resolves 'approved' | 'denied'. Wired by the runtime —
   * tools never decide approvals themselves.
   */
  requestApproval?(req: { summary: string; reason: string }): Promise<'approved' | 'denied'>;
}

export type ToolErrorKind = 'validation' | 'transient' | 'permanent';

export interface ToolResult {
  ok: boolean;
  /** Observation text handed back to the model / recorded in the trace. */
  output: string;
  data?: Record<string, unknown>;
  error?: string;
  /** Retry hints: validation/permanent failures are never retried. */
  errorKind?: ToolErrorKind;
}

export interface ToolDefinition {
  name: string;
  description: string;
  kind: 'compute' | 'filesystem' | 'network' | 'browser' | 'corpus' | 'mcp';
  riskLevel: RiskLevel;
  /** Permissions the agent must hold (checked in addition to policies). */
  permissions: string[];
  /** Zod schema validated before the handler runs. */
  inputSchema: ZodType;
  /** Hand-written JSON-schema summary for the tools UI. */
  inputSchemaJson: Record<string, unknown>;
  timeoutMs: number;
  maxRetries: number;
  handler(input: unknown, ctx: ToolContext): Promise<ToolResult>;
  /** Deterministic example input — used by the generic mock behavior and UI. */
  sampleInput(): Record<string, unknown>;
}

export type { RiskLevel };
