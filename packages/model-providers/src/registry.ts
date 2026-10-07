import { ProviderError } from '@agentos/shared';
import type { ModelProvider, ModelRequest, ModelResult } from './types.js';
import { DeterministicMockProvider } from './mock/provider.js';
import { estimateCost, type CostEstimate, type ModelPrice } from './pricing.js';

export interface ResolvedProvider {
  provider: ModelProvider;
  /** Behavior/model identifier passed through to the provider. */
  modelRef: string;
}

export interface FallbackOutcome {
  result: ModelResult;
  /** Provider that actually produced the result. */
  usedProvider: string;
  /** True when the configured provider failed and mock answered instead. */
  fellBack: boolean;
  fallbackReason?: string;
  cost: CostEstimate;
}

export interface ProviderRegistryOptions {
  priceTable?: Record<string, ModelPrice>;
  /** Called when a configured provider fails and fallback engages. */
  onFallback?: (info: { modelRef: string; reason: string }) => void;
}

/**
 * Resolves model refs ("mock/…", "ollama/…", "openai/…") to providers and
 * orchestrates graceful degradation: any provider failure falls back to the
 * deterministic mock provider so a run NEVER dies from an infra outage.
 */
export class ProviderRegistry {
  private readonly providers: ModelProvider[] = [];
  private readonly fallback: DeterministicMockProvider;
  private readonly priceTable: Record<string, ModelPrice>;
  private readonly onFallback?: ProviderRegistryOptions['onFallback'];

  constructor(providers: ModelProvider[], opts: ProviderRegistryOptions = {}) {
    this.providers = providers;
    this.fallback = new DeterministicMockProvider();
    this.priceTable = opts.priceTable ?? {};
    this.onFallback = opts.onFallback;
  }

  list(): ModelProvider[] {
    return [...this.providers];
  }

  /** First provider advertising support for the ref, else the mock fallback. */
  resolve(modelRef: string): ResolvedProvider {
    const found = this.providers.find((p) => p.supports(modelRef));
    if (found) return { provider: found, modelRef };
    return { provider: this.fallback, modelRef: 'mock/generic' };
  }

  /**
   * Generate with fallback: try the resolved provider; on ProviderError (but
   * never on caller-initiated abort), degrade to the deterministic mock.
   */
  async generateWithFallback(
    req: ModelRequest,
    signal: AbortSignal,
    modelRef: string,
  ): Promise<FallbackOutcome> {
    const { provider } = this.resolve(modelRef);
    if (provider === this.fallback) {
      const result = await this.fallback.generate(req, signal);
      return {
        result,
        usedProvider: 'mock',
        fellBack: false,
        cost: { usd: 0, estimated: false },
      };
    }
    try {
      const result = await provider.generate(req, signal);
      return {
        result,
        usedProvider: provider.name,
        fellBack: false,
        cost: this.costOf(provider, result),
      };
    } catch (e) {
      // Caller abort (run cancellation) must not be swallowed by fallback.
      if (signal.aborted) throw e;
      const reason = e instanceof ProviderError ? e.message : (e as Error).message;
      this.onFallback?.({ modelRef, reason });
      const result = await this.fallback.generate(req, signal);
      return {
        result,
        usedProvider: 'mock',
        fellBack: true,
        fallbackReason: reason,
        cost: { usd: 0, estimated: false },
      };
    }
  }

  costOf(provider: ModelProvider, result: ModelResult): CostEstimate {
    if (provider.locality !== 'cloud') return { usd: 0, estimated: false };
    return estimateCost(
      this.priceTable,
      result.model,
      result.usage.tokensIn,
      result.usage.tokensOut,
    );
  }
}
