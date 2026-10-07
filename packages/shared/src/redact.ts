/**
 * Secret redaction applied to every persisted event payload and log line.
 * External content (web pages, tool output) is treated as untrusted, so
 * anything that *looks* like a credential is scrubbed before storage.
 */

const SECRET_PATTERNS: RegExp[] = [
  /(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /((?:api[_-]?key|secret|token|password|authorization|credential)s?["']?\s*[:=]\s*)(["']?)[^\s"',}\]]{6,}/gi,
];

const REDACTED = '***REDACTED***';

export function redactString(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, p1?: string, p2?: string) =>
      p1 !== undefined ? `${p1}${p2 ?? ''}${REDACTED}` : REDACTED,
    );
  }
  return out;
}

const MAX_DEPTH = 6;

export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return '[depth-limit]' as unknown as T;
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((v) => redactDeep(v, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactDeep(v, depth + 1);
  }
  return out as T;
}
