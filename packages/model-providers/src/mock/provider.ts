import type {
  ModelProvider,
  ModelRequest,
  ModelResult,
  ProviderMetadata,
} from '../types.js';
import { estimateTokens } from '../pricing.js';
import { getBehavior } from './behaviors.js';
import type { BehaviorContext } from './behaviors.js';

/**
 * Deterministic offline provider. Model refs look like "mock/<behavior>".
 * Decision logic is scripted (see behaviors.ts); the seed is honored so runs
 * are reproducible and replayable. Always succeeds — it is also the fallback
 * provider when cloud/local providers fail.
 */
export class DeterministicMockProvider implements ModelProvider {
  readonly name = 'mock';
  readonly locality = 'mock' as const;

  supports(modelRef: string): boolean {
    return modelRef === 'mock' || modelRef.startsWith('mock/');
  }

  metadata(): ProviderMetadata {
    return {
      name: this.name,
      locality: this.locality,
      defaultModel: 'mock/generic',
      contextWindow: 32_000,
      supportsStream: false,
      pricing: null,
    };
  }

  async generate(req: ModelRequest, _signal: AbortSignal): Promise<ModelResult> {
    const ref = req.modelRef ?? 'mock/generic';
    const behaviorId = ref === 'mock' || ref.startsWith('mock/') ? ref.slice('mock/'.length) || 'generic' : 'generic';
    const behavior = getBehavior(behaviorId);

    // Reconstruct prior tool-call results from the message trail. Tool
    // observations are appended by the runtime as role:"tool" messages with a
    // JSON envelope; the behavior only needs structured data for its decisions.
    const called: BehaviorContext['called'] = [];
    for (const m of req.messages) {
      if (m.role !== 'tool' || !m.toolName) continue;
      try {
        const envelope = JSON.parse(m.content) as {
          ok: boolean;
          output?: string;
          data?: Record<string, unknown>;
          error?: string;
        };
        called.push({
          tool: m.toolName,
          args: (envelope.data as { __args?: Record<string, unknown> } | undefined)?.__args ?? {},
          ok: envelope.ok,
          output: envelope.output ?? envelope.error ?? '',
          data: envelope.data,
        });
      } catch {
        called.push({ tool: m.toolName, args: {}, ok: false, output: m.content.slice(0, 200) });
      }
    }

    const ctx: BehaviorContext = {
      task: req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? req.system,
      // Advance on every prior model action (plans included) so scripted
      // behaviors can never loop plan→plan→plan.
      step: req.messages.filter((m) => m.role === 'assistant').length,
      allowedTools: req.allowedTools,
      messages: req.messages,
      called,
      workflowInput: req.workflowInput,
    };

    const action = behavior(ctx);
    const text =
      action.kind === 'final' ? action.result : action.kind === 'plan' ? action.text : `call ${action.call.name}`;

    return {
      action,
      usage: {
        tokensIn: estimateTokens(req.messages.map((m) => m.content).join('\n')),
        tokensOut: estimateTokens(text),
      },
      finishReason: action.kind === 'tool_call' ? 'tool_call' : 'stop',
      model: `mock/${behaviorId}`,
      provider: this.name,
    };
  }
}
