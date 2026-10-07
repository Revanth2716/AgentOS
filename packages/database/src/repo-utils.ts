import { LimitsSchema, PolicyConfigSchema, type Limits, type PolicyConfig } from '@agentos/shared';

/** JSON column helper — corrupted/legacy values fall back to the provided default. */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function parseLimits(text: string | null | undefined): Limits {
  const parsed = LimitsSchema.safeParse(parseJson(text, {}));
  return parsed.success ? parsed.data : LimitsSchema.parse({});
}

export function parsePolicyConfig(text: string | null | undefined): PolicyConfig {
  const raw = parseJson(text, {});
  const parsed = PolicyConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : PolicyConfigSchema.parse({});
}

export function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}
