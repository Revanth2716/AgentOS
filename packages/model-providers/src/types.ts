import type { ProviderLocality } from '@agentos/shared';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** For role=tool: which tool produced this observation. */
  toolName?: string;
}

export interface ToolSummary {
  name: string;
  description: string;
  inputSchemaJson: Record<string, unknown>;
  sampleInput(): Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  /** Full model ref from agent config: "mock/<behavior>", "ollama/<model>", "openai/<model>". */
  modelRef?: string;
  allowedTools: ToolSummary[];
  /** Deterministic seed for mock generation. */
  seed?: number;
  /** Upstream node outputs when invoked from a workflow. */
  workflowInput?: Record<string, unknown>;
}

export interface ModelToolCall {
  name: string;
  args: Record<string, unknown>;
  purpose?: string;
}

export type ModelAction =
  | { kind: 'plan'; text: string }
  | { kind: 'tool_call'; call: ModelToolCall }
  | { kind: 'final'; result: string };

export interface ModelUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface ModelResult {
  action: ModelAction;
  usage: ModelUsage;
  finishReason: 'stop' | 'tool_call' | 'length' | 'error';
  model: string;
  provider: string;
}

export interface ProviderMetadata {
  name: string;
  locality: ProviderLocality;
  defaultModel: string;
  contextWindow: number;
  supportsStream: boolean;
  /** USD per 1K tokens; null when cost is always zero. */
  pricing: { inPer1k: number; outPer1k: number } | null;
}

/**
 * The single seam for all model inference. Provider-specific code lives ONLY
 * behind this interface — never in routes, runtime, or workflows.
 */
export interface ModelProvider {
  readonly name: string;
  readonly locality: ProviderLocality;
  supports(modelRef: string): boolean;
  metadata(): ProviderMetadata;
  generate(req: ModelRequest, signal: AbortSignal): Promise<ModelResult>;
  stream?(
    req: ModelRequest,
    onChunk: (text: string) => void,
    signal: AbortSignal,
  ): Promise<ModelResult>;
}
