export interface ModelPrice {
  /** USD per 1,000 input tokens */
  in: number;
  /** USD per 1,000 output tokens */
  out: number;
}

/** Rough public list prices for common OpenAI-compatible models (per 1K tokens). */
export const PRICE_TABLE: Record<string, ModelPrice> = {
  'gpt-4o-mini': { in: 0.00015, out: 0.0006 },
  'gpt-4o': { in: 0.0025, out: 0.01 },
  'gpt-4.1-mini': { in: 0.0004, out: 0.0016 },
  'gpt-4.1': { in: 0.002, out: 0.008 },
  'o4-mini': { in: 0.0011, out: 0.0044 },
};

const DEFAULT_PRICE: ModelPrice = { in: 0.001, out: 0.002 };

export function parsePriceOverrides(json: string | undefined): Record<string, ModelPrice> {
  if (!json) return {};
  try {
    const raw = JSON.parse(json) as Record<string, { in?: number; out?: number }>;
    const out: Record<string, ModelPrice> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v?.in === 'number' && typeof v?.out === 'number') out[k] = { in: v.in, out: v.out };
    }
    return out;
  } catch {
    return {};
  }
}

export interface CostEstimate {
  usd: number;
  /** true when the model has no exact price entry (default table used). */
  estimated: boolean;
}

export function estimateCost(
  priceTable: Record<string, ModelPrice>,
  model: string,
  tokensIn: number,
  tokensOut: number,
): CostEstimate {
  const key = model.toLowerCase();
  const price = priceTable[key] ?? PRICE_TABLE[key] ?? DEFAULT_PRICE;
  const usd = (tokensIn / 1000) * price.in + (tokensOut / 1000) * price.out;
  return { usd: Math.round(usd * 1_000_000) / 1_000_000, estimated: !priceTable[key] && !PRICE_TABLE[key] };
}

/** Deterministic token estimate (~4 chars/token) for mock/local accounting. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
