import type {
  ModelProvider,
  ModelRequest,
  ModelResult,
  ProviderMetadata,
  ToolSummary,
} from './types.js';
import { ProviderError } from '@agentos/shared';
import { PRICE_TABLE, parsePriceOverrides, type ModelPrice } from './pricing.js';

export interface OpenAiCompatibleOptions {
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  timeoutMs?: number;
  /** Optional per-1K-token price overrides (from AGENTOS_PRICE_OVERRIDES). */
  priceOverrides?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Any OpenAI-compatible endpoint (OpenAI, Azure OpenAI gateways, vLLM,
 * llama.cpp server, LM Studio, …). NEVER required — the platform runs
 * fully without it.
 */
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly name = 'openai';
  readonly locality = 'cloud' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private readonly prices: Record<string, ModelPrice>;

  constructor(opts: OpenAiCompatibleOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.apiKey = opts.apiKey ?? '';
    this.defaultModel = opts.defaultModel ?? 'gpt-4o-mini';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.prices = parsePriceOverrides(opts.priceOverrides);
  }

  supports(modelRef: string): boolean {
    return modelRef === 'openai' || modelRef.startsWith('openai/');
  }

  metadata(): ProviderMetadata {
    return {
      name: this.name,
      locality: this.locality,
      defaultModel: this.defaultModel,
      contextWindow: 128_000,
      supportsStream: true,
      pricing: { inPer1k: 0.00015, outPer1k: 0.0006 },
    };
  }

  get configured(): boolean {
    return this.apiKey.length > 0;
  }

  modelOf(modelRef: string): string {
    return modelRef.startsWith('openai/') ? modelRef.slice('openai/'.length) : this.defaultModel;
  }

  priceOf(model: string): ModelPrice {
    return this.prices[model] ?? PRICE_TABLE[model] ?? { in: 0.001, out: 0.002 };
  }

  async generate(req: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    if (!this.apiKey) {
      throw new ProviderError('openai', 'no API key configured (set AGENTOS_OPENAI_API_KEY)');
    }
    const model = this.modelOf(req.modelRef ?? '');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: req.system },
            ...req.messages.map((m) => ({ role: m.role, content: m.content })),
          ],
          tools: req.allowedTools.map(openAiTool),
          tool_choice: 'auto',
        }),
      });
      if (!res.ok) {
        throw new ProviderError('openai', `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const body = (await res.json()) as ChatCompletionResponse;
      const choice = body.choices?.[0];
      const toolCalls = (choice?.message?.tool_calls ?? [])
        .map((tc) => {
          const name = tc.function?.name ?? '';
          let args: Record<string, unknown> = {};
          try {
            args = tc.function?.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
          } catch {
            args = {};
          }
          return name ? { name, args } : null;
        })
        .filter((c): c is { name: string; args: Record<string, unknown> } => c !== null);
      const usage = {
        tokensIn: body.usage?.prompt_tokens ?? 0,
        tokensOut: body.usage?.completion_tokens ?? 0,
      };
      if (toolCalls.length > 0) {
        return {
          action: { kind: 'tool_call', call: toolCalls[0] as { name: string; args: Record<string, unknown> } },
          usage,
          finishReason: 'tool_call',
          model,
          provider: this.name,
        };
      }
      return {
        action: { kind: 'final', result: choice?.message?.content ?? '(empty response)' },
        usage,
        finishReason: 'stop',
        model,
        provider: this.name,
      };
    } catch (e) {
      throw e instanceof ProviderError ? e : new ProviderError('openai', (e as Error).message);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async stream(
    req: ModelRequest,
    onChunk: (text: string) => void,
    signal: AbortSignal,
  ): Promise<ModelResult> {
    const result = await this.generate(req, signal); // aggregated streaming fallback
    if (result.action.kind === 'final') onChunk(result.action.result);
    return result;
  }
}

export function openAiTool(t: ToolSummary): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchemaJson,
    },
  };
}
