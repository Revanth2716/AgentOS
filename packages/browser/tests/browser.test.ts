import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserManager, browserTools, detectHumanVerification } from '../src/index.js';
import type { ToolContext } from '@agentos/tool-registry';

describe('detectHumanVerification', () => {
  it('flags common verification walls', () => {
    expect(detectHumanVerification({ title: 'Puzzle', text: 'please complete the CAPTCHA to continue' }).detected).toBe(true);
    expect(detectHumanVerification({ title: 'X', text: 'Verify you are human before continuing' }).detected).toBe(true);
    expect(detectHumanVerification({ title: 'Docs', text: 'How to build agents with tools' }).detected).toBe(false);
  });
});

function ctx(): ToolContext {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-br-'));
  return {
    runId: 'run_test',
    agentId: 'agt_test',
    signal: new AbortController().signal,
    workspaceDir: ws,
    artifactsDir: path.join(ws, 'artifacts'),
    logger: { info() {}, warn() {}, error() {} },
    requestApproval: async () => 'approved',
  };
}

describe('browser tool contracts', () => {
  it('exposes the full browser tool surface with schemas and permissions', () => {
    const tools = browserTools(new BrowserManager());
    expect(tools.map((t) => t.name).sort()).toEqual([
      'browser.click',
      'browser.inspect',
      'browser.navigate',
      'browser.screenshot',
      'browser.scroll',
      'browser.type',
    ]);
    for (const t of tools) {
      expect(t.permissions).toEqual(['browser:use']);
      expect(t.inputSchemaJson).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(20);
      expect(['low', 'medium', 'high', 'critical']).toContain(t.riskLevel);
    }
    // typing into pages is the highest-impact browser action
    expect(tools.find((t) => t.name === 'browser.type')?.riskLevel).toBe('high');
  });

  it('rejects invalid and unsafe inputs before touching the browser', async () => {
    const tools = browserTools(new BrowserManager());
    const nav = tools.find((t) => t.name === 'browser.navigate');
    expect(nav).toBeDefined();
    const bad = await nav?.handler({ url: 'javascript:alert(1)' }, ctx());
    expect(bad?.ok).toBe(false);
    const missing = await nav?.handler({}, ctx());
    expect(missing?.ok).toBe(false);
    expect(missing?.errorKind).toBe('validation');
  });

  it('fails gracefully with install instructions when Playwright/Chromium is unavailable', async () => {
    const mgr = new BrowserManager();
    const probe = await mgr.availabilityProbe();
    if (!probe.available) {
      const tools = browserTools(mgr);
      const nav = tools.find((t) => t.name === 'browser.navigate');
      const res = await nav?.handler({ url: 'https://example.com' }, ctx());
      expect(res?.ok).toBe(false);
      expect(res?.error).toContain('browser runtime unavailable');
      expect(res?.error).toMatch(/setup:browser|playwright/);
    } else {
      expect(probe.executable).toBeTruthy();
    }
  });
});
