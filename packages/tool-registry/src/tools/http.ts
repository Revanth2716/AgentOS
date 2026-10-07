import dns from 'node:dns';
import net from 'node:net';
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

const InputSchema = z.object({
  url: z.string().min(1).max(2_048),
  maxBytes: z.number().int().min(256).max(1_048_576).default(65_536),
});

const MAX_REDIRECTS = 3;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7));
  return false;
}

/** SSRF guard: http(s) only, no credentials in URL, host must resolve publicly. */
export async function assertPublicUrl(
  rawUrl: string,
  extraAllowedHosts: readonly string[],
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`blocked scheme: ${url.protocol} (only http/https)`);
  }
  if (url.username || url.password) throw new Error('credentials in URL are not allowed');
  const host = url.hostname.toLowerCase();
  if (extraAllowedHosts.includes(host)) return url;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`blocked host: ${host} (private network)`);
  }
  const addresses = await dns.promises.lookup(host, { all: true, verbatim: true }).catch(() => {
    throw new Error(`DNS lookup failed for ${host}`);
  });
  if (addresses.length === 0) throw new Error(`no addresses for ${host}`);
  const privateAddr = addresses.find((a) => isPrivateIp(a.address));
  if (privateAddr) throw new Error(`blocked: ${host} resolves to private address ${privateAddr.address}`);
  return url;
}

export interface HttpFetchOptions {
  timeoutMs?: number;
  /** Extra allowed hosts (from AGENTOS_FETCH_ALLOW_HOSTS) — e.g. a local fixture server. */
  allowHosts?: string[];
}

export function httpFetchTool(opts: HttpFetchOptions = {}): ToolDefinition {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const allowHosts = (opts.allowHosts ?? []).map((h) => h.toLowerCase());
  return {
    name: 'http.fetch',
    description:
      'Fetch a public URL (GET). SSRF-guarded: private networks, localhost and non-http(s) schemes are blocked. Returns status, content type and a text excerpt.',
    kind: 'network',
    riskLevel: 'medium',
    permissions: ['net:fetch'],
    inputSchema: InputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'absolute http(s) URL' },
        maxBytes: { type: 'integer', description: 'max body bytes to return (default 65536)' },
      },
      required: ['url'],
    },
    timeoutMs: timeoutMs + 5_000,
    maxRetries: 2,
    sampleInput: () => ({ url: 'https://example.com' }),
    async handler(raw, ctx) {
      const parsed = InputSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: `invalid input: ${parsed.error.issues[0]?.message}`, errorKind: 'validation', output: '' };
      }
      let url: URL;
      try {
        url = await assertPublicUrl(parsed.data.url, allowHosts);
      } catch (e) {
        return { ok: false, error: (e as Error).message, errorKind: 'permanent', output: '' };
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let current = url;
        for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
          const res = await fetch(current, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'user-agent': 'AgentOS/0.1 (+local-first; demo)' },
          });
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc) return { ok: false, error: `redirect without location (${res.status})`, errorKind: 'permanent', output: '' };
            current = new URL(loc, current);
            continue;
          }
          const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
          const buf = Buffer.from(await res.arrayBuffer());
          const truncated = buf.length > parsed.data.maxBytes;
          const text = buf.subarray(0, parsed.data.maxBytes).toString('utf8');
          const ok = res.status < 400;
          return {
            ok,
            output: `HTTP ${res.status} ${current.host} ${contentType} (${buf.length} bytes${truncated ? ', truncated' : ''})\n\n${text}`,
            data: { status: res.status, contentType, bytes: buf.length, truncated, url: current.toString() },
            error: ok ? undefined : `HTTP ${res.status}`,
            errorKind: res.status >= 500 || res.status === 429 ? 'transient' : ok ? undefined : 'permanent',
          };
        }
        return { ok: false, error: `too many redirects (>${MAX_REDIRECTS})`, errorKind: 'permanent', output: '' };
      } catch (e) {
        const err = e as Error;
        const aborted = err.name === 'AbortError';
        return {
          ok: false,
          error: aborted ? 'request timed out' : `fetch failed: ${err.message}`,
          errorKind: 'transient',
          output: '',
        };
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
