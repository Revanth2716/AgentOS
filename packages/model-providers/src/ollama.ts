import type {
  ModelProvider,
  ModelRequest,
  ModelResult,
  ProviderMetadata,
} from './types.js';
import { ProviderError } from '@agentos/shared';

const PROTOCOL_PROMPT = `You are an AI agent operating tools. Reply with STRICT JSON only, no prose:
{"action":"plan","text":"..."} | {"action":"call","tool":"<tool name>","args":{...},"purpose":"..."} | {"action":"final","result":"..."}`;

export interface OllamaOptions {
  baseUrl?: string;
  defaultModel?: string;
  timeoutMs?: number;
}

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Local Ollama provider — free, runs on the user's machine, cost $0. */
export class OllamaProvider implements ModelProvider {
  readonly name = 'ollama';
  readonly locality = 'local' as const;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;

  constructor(opts: OllamaOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.defaultModel = opts.defaultModel ?? 'llama3.2';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  supports(modelRef: string): boolean {
    return modelRef === 'ollama' || modelRef.startsWith('ollama/');
  }

  metadata(): ProviderMetadata {
    return {
      name: this.name,
      locality: this.locality,
      defaultModel: this.defaultModel,
      contextWindow: 32_000,
      supportsStream: true,
      pricing: null,
    };
  }

  private modelOf(modelRef: string): string {
    return modelRef.startsWith('ollama/') ? modelRef.slice('ollama/'.length) : this.defaultModel;
  }

  async generate(req: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    const model = this.modelOf(req.modelRef ?? '');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: 'system', content: `${PROTOCOL_PROMPT}\n\n${req.system}` },
            ...req.messages.map((m) => ({ role: m.role, content: m.content })),
          ],
        }),
      });
      if (!res.ok) {
        throw new ProviderError('ollama', `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const body = (await res.json()) as OllamaChatResponse;
      const content = body.message?.content ?? '';
      const parsed = parseActionJson(content);
      return {
        action: parsed ?? { kind: 'final', result: content || '(empty model response)' },
        usage: { tokensIn: body.prompt_eval_count ?? 0, tokensOut: body.eval_count ?? 0 },
        finishReason: parsed?.kind === 'tool_call' ? 'tool_call' : 'stop',
        model,
        provider: this.name,
      };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('ollama', (e as Error).message);
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
    const model = this.modelOf(req.modelRef ?? '');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [
            { role: 'system', content: `${PROTOCOL_PROMPT}\n\n${req.system}` },
            ...req.messages.map((m) => ({ role: m.role, content: m.content })),
          ],
        }),
      });
      if (!res.ok || !res.body) {
        throw new ProviderError('ollama', `HTTP ${res.status}`);
      }
      let full = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split('\n')) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line) as { message?: { content?: string } };
            const piece = evt.message?.content ?? '';
            if (piece) {
              full += piece;
              onChunk(piece);
            }
          } catch {
            // skip malformed ndjson lines
          }
        }
      }
      const parsed = parseActionJson(full);
      return {
        action: parsed ?? { kind: 'final', result: full || '(empty model response)' },
        usage: { tokensIn: 0, tokensOut: 0 },
        finishReason: 'stop',
        model,
        provider: this.name,
      };
    } catch (e) {
      throw e instanceof ProviderError ? e : new ProviderError('ollama', (e as Error).message);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/** Parses the strict-JSON action protocol; returns null when the model ignored it. */
export function parseActionJson(text: string): ModelResult['action'] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (obj.action === 'final' && typeof obj.result === 'string') {
      return { kind: 'final', result: obj.result };
    }
    if (obj.action === 'plan' && typeof obj.text === 'string') {
      return { kind: 'plan', text: obj.text };
    }
    if (obj.action === 'call' && typeof obj.tool === 'string') {
      return {
        kind: 'tool_call',
        call: {
          name: obj.tool,
          args: (obj.args as Record<string, unknown> | undefined) ?? {},
          purpose: typeof obj.purpose === 'string' ? obj.purpose : undefined,
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}
