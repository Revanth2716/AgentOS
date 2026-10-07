import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '@agentos/tool-registry';
import type { BrowserManager } from './manager.js';
import { detectHumanVerification } from './detection.js';

const NavigateSchema = z.object({ url: z.string().min(1).max(2_048) });
const ClickSchema = z.object({ selector: z.string().min(1).max(500) });
const TypeSchema = z.object({
  selector: z.string().min(1).max(500),
  text: z.string().max(10_000),
  clear: z.boolean().default(true),
});
const ScreenshotSchema = z.object({ filename: z.string().max(128).default('screenshot.png') });
const ScrollSchema = z.object({
  direction: z.enum(['down', 'up']).default('down'),
  pixels: z.number().int().min(50).max(5_000).default(800),
});
const InspectSchema = z.object({ selector: z.string().max(500).optional() });

function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`blocked scheme: ${url.protocol} (only http/https)`);
  }
  if (url.username || url.password) throw new Error('credentials in URL are not allowed');
  return url;
}

async function unavailable(name: string, mgr: BrowserManager): Promise<ToolResult | null> {
  const probe = await mgr.availabilityProbe();
  if (probe.available) return null;
  return {
    ok: false,
    output: '',
    error: `browser runtime unavailable for ${name}: ${probe.reason}`,
    errorKind: 'permanent',
  };
}

/**
 * Pauses on human-verification walls via the runtime approval hook (operator
 * intervention, then resume). NEVER attempts bypass.
 */
async function pauseForHumanVerification(
  ctx: Parameters<ToolDefinition['handler']>[1],
  url: string,
  marker: string,
): Promise<'approved' | 'denied' | 'no-hook'> {
  if (!ctx.requestApproval) return 'no-hook';
  const verdict = await ctx.requestApproval({
    summary: `Human verification required at ${url}`,
    reason: `page matches verification marker "${marker}" — complete it manually, then approve to resume`,
  });
  return verdict;
}

export function browserTools(mgr: BrowserManager): ToolDefinition[] {
  return [
    {
      name: 'browser.navigate',
      description: 'Navigate to an http(s) URL in the sandboxed headless browser and return title + text excerpt. Pauses for operator approval when human verification is detected.',
      kind: 'browser',
      riskLevel: 'medium',
      permissions: ['browser:use'],
      inputSchema: NavigateSchema,
      inputSchemaJson: {
        type: 'object',
        properties: { url: { type: 'string', description: 'absolute http(s) URL' } },
        required: ['url'],
      },
      timeoutMs: 30_000,
      maxRetries: 1,
      sampleInput: () => ({ url: 'https://example.com' }),
      async handler(raw, ctx) {
        const parsed = NavigateSchema.safeParse(raw);
        if (!parsed.success) return { ok: false, output: '', error: 'invalid input', errorKind: 'validation' };
        const unavail = await unavailable('browser.navigate', mgr);
        if (unavail) return unavail;
        try {
          assertAllowedUrl(parsed.data.url);
          const page = await mgr.pageFor(ctx.runId);
          const res = await page.goto(parsed.data.url, { waitUntil: 'domcontentloaded' });
          const title = await page.title();
          const text = (await page.innerText('body').catch(() => '')).slice(0, 3_000);
          const check = detectHumanVerification({ title, text });
          if (check.detected) {
            const verdict = await pauseForHumanVerification(ctx, parsed.data.url, check.marker as string);
            if (verdict === 'denied') {
              return {
                ok: false,
                output: '',
                error: `operator declined to resolve human verification at ${parsed.data.url}`,
                errorKind: 'permanent',
                data: { humanVerification: 'denied', marker: check.marker },
              };
            }
            return {
              ok: true,
              output: `Human verification at ${parsed.data.url} acknowledged by operator (${verdict === 'approved' ? 'approved' : 'no approval hook; continuing'}). Title: ${title}`,
              data: { humanVerification: 'acknowledged', marker: check.marker, url: parsed.data.url },
            };
          }
          return {
            ok: true,
            output: `HTTP ${res?.status() ?? 0} — ${title}\n${parsed.data.url}\n\n${text}`,
            data: { status: res?.status() ?? 0, title, url: parsed.data.url, textBytes: text.length },
          };
        } catch (e) {
          return { ok: false, output: '', error: `navigate failed: ${(e as Error).message}`, errorKind: 'transient' };
        }
      },
    },
    {
      name: 'browser.click',
      description: 'Click a CSS selector on the current page.',
      kind: 'browser',
      riskLevel: 'medium',
      permissions: ['browser:use'],
      inputSchema: ClickSchema,
      inputSchemaJson: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'CSS selector' } },
        required: ['selector'],
      },
      timeoutMs: 20_000,
      maxRetries: 1,
      sampleInput: () => ({ selector: 'a' }),
      async handler(raw, ctx) {
        const parsed = ClickSchema.safeParse(raw);
        if (!parsed.success) return { ok: false, output: '', error: 'invalid input', errorKind: 'validation' };
        const unavail = await unavailable('browser.click', mgr);
        if (unavail) return unavail;
        try {
          const page = await mgr.pageFor(ctx.runId);
          await page.click(parsed.data.selector, { timeout: 10_000 });
          return {
            ok: true,
            output: `clicked ${parsed.data.selector}`,
            data: { selector: parsed.data.selector, url: page.url() },
          };
        } catch (e) {
          return {
            ok: false,
            output: '',
            error: `click failed: ${(e as Error).message}`,
            errorKind: 'permanent',
          };
        }
      },
    },
    {
      name: 'browser.type',
      description: 'Fill text into an input/textarea matched by CSS selector.',
      kind: 'browser',
      riskLevel: 'high',
      permissions: ['browser:use'],
      inputSchema: TypeSchema,
      inputSchemaJson: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' },
          clear: { type: 'boolean', description: 'clear existing value first (default true)' },
        },
        required: ['selector', 'text'],
      },
      timeoutMs: 20_000,
      maxRetries: 0,
      sampleInput: () => ({ selector: 'input[name="q"]', text: 'sample query' }),
      async handler(raw, ctx) {
        const parsed = TypeSchema.safeParse(raw);
        if (!parsed.success) return { ok: false, output: '', error: 'invalid input', errorKind: 'validation' };
        const unavail = await unavailable('browser.type', mgr);
        if (unavail) return unavail;
        try {
          const page = await mgr.pageFor(ctx.runId);
          await page.fill(parsed.data.selector, parsed.data.clear ? parsed.data.text : '', { timeout: 10_000 });
          if (!parsed.data.clear) await page.type(parsed.data.selector, parsed.data.text, { delay: 5 });
          return {
            ok: true,
            output: `typed ${parsed.data.text.length} chars into ${parsed.data.selector}`,
            data: { selector: parsed.data.selector, chars: parsed.data.text.length },
          };
        } catch (e) {
          return { ok: false, output: '', error: `type failed: ${(e as Error).message}`, errorKind: 'permanent' };
        }
      },
    },
    {
      name: 'browser.screenshot',
      description: 'Capture the viewport as PNG into the run workspace.',
      kind: 'browser',
      riskLevel: 'low',
      permissions: ['browser:use'],
      inputSchema: ScreenshotSchema,
      inputSchemaJson: {
        type: 'object',
        properties: { filename: { type: 'string', description: 'file name inside workspace/browser/' } },
      },
      timeoutMs: 20_000,
      maxRetries: 0,
      sampleInput: () => ({ filename: 'screenshot.png' }),
      async handler(raw, ctx) {
        const parsed = ScreenshotSchema.safeParse(raw ?? {});
        if (!parsed.success) return { ok: false, output: '', error: 'invalid input', errorKind: 'validation' };
        const unavail = await unavailable('browser.screenshot', mgr);
        if (unavail) return unavail;
        try {
          const page = await mgr.pageFor(ctx.runId);
          const dir = path.join(ctx.workspaceDir, 'browser');
          fs.mkdirSync(dir, { recursive: true });
          const filename = path.basename(parsed.data.filename).replace(/[^\w.-]/g, '_') || 'screenshot.png';
          const file = path.join(dir, filename);
          const buf = await page.screenshot({ type: 'png' });
          fs.writeFileSync(file, buf);
          return {
            ok: true,
            output: `screenshot saved: browser/${filename} (${buf.length} bytes)`,
            data: { file: `browser/${filename}`, bytes: buf.length, url: page.url() },
          };
        } catch (e) {
          return { ok: false, output: '', error: `screenshot failed: ${(e as Error).message}`, errorKind: 'transient' };
        }
      },
    },
    {
      name: 'browser.scroll',
      description: 'Scroll the page by pixels in a direction.',
      kind: 'browser',
      riskLevel: 'low',
      permissions: ['browser:use'],
      inputSchema: ScrollSchema,
      inputSchemaJson: {
        type: 'object',
        properties: { direction: { type: 'string', enum: ['down', 'up'] }, pixels: { type: 'integer' } },
      },
      timeoutMs: 15_000,
      maxRetries: 0,
      sampleInput: () => ({ direction: 'down', pixels: 800 }),
      async handler(raw, ctx) {
        const parsed = ScrollSchema.safeParse(raw ?? {});
        if (!parsed.success) return { ok: false, output: '', error: 'invalid input', errorKind: 'validation' };
        const unavail = await unavailable('browser.scroll', mgr);
        if (unavail) return unavail;
        try {
          const page = await mgr.pageFor(ctx.runId);
          const delta = parsed.data.direction === 'down' ? parsed.data.pixels : -parsed.data.pixels;
          await page.mouse.wheel(0, delta);
          return { ok: true, output: `scrolled ${parsed.data.direction} ${parsed.data.pixels}px`, data: { delta } };
        } catch (e) {
          return { ok: false, output: '', error: `scroll failed: ${(e as Error).message}`, errorKind: 'permanent' };
        }
      },
    },
    {
      name: 'browser.inspect',
      description: 'Inspect the page: title, URL, links, visible text — or one element by CSS selector.',
      kind: 'browser',
      riskLevel: 'low',
      permissions: ['browser:use'],
      inputSchema: InspectSchema,
      inputSchemaJson: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'optional CSS selector to inspect one element' } },
      },
      timeoutMs: 20_000,
      maxRetries: 0,
      sampleInput: () => ({}),
      async handler(raw, ctx) {
        const parsed = InspectSchema.safeParse(raw ?? {});
        if (!parsed.success) return { ok: false, output: '', error: 'invalid input', errorKind: 'validation' };
        const unavail = await unavailable('browser.inspect', mgr);
        if (unavail) return unavail;
        try {
          const page = await mgr.pageFor(ctx.runId);
          const url = page.url();
          if (parsed.data.selector) {
            const el = page.locator(parsed.data.selector).first();
            const count = await page.locator(parsed.data.selector).count();
            if (count === 0) {
              return {
                ok: false,
                output: '',
                error: `no element matches selector: ${parsed.data.selector}`,
                errorKind: 'permanent',
              };
            }
            const tag = await el.evaluate((n) => `${n.tagName.toLowerCase()} ${n.outerHTML.slice(0, 600)}`);
            return {
              ok: true,
              output: `${count} match(es) for ${parsed.data.selector}\nfirst: ${tag}`,
              data: { count, selector: parsed.data.selector },
            };
          }
          const title = await page.title();
          const links = await page.$$eval('a[href]', (as) =>
            as.slice(0, 30).map((a) => ({ text: (a.textContent ?? '').trim().slice(0, 80), href: a.getAttribute('href') })),
          );
          const text = (await page.innerText('body').catch(() => '')).slice(0, 4_000);
          const check = detectHumanVerification({ title, text });
          return {
            ok: true,
            output: `URL: ${url}\nTitle: ${title}\n\nLinks:\n${links.map((l) => `- ${l.text} → ${l.href}`).join('\n')}\n\nText:\n${text}`,
            data: { url, title, linkCount: links.length, humanVerification: check.detected },
          };
        } catch (e) {
          return { ok: false, output: '', error: `inspect failed: ${(e as Error).message}`, errorKind: 'transient' };
        }
      },
    },
  ];
}
