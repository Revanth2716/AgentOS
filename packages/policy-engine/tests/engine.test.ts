import { describe, expect, it } from 'vitest';
import { evaluatePolicy, matchToolPattern, summarizePolicy } from '../src/index.js';
import type { PolicyConfig } from '@agentos/shared';

const cfg = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({
  mode: 'allowlist',
  allowed: [],
  denied: [],
  requireApproval: [],
  rateLimits: {},
  ...over,
});

describe('matchToolPattern', () => {
  it('matches exact names', () => {
    expect(matchToolPattern('http.fetch', 'http.fetch')).toBe(true);
    expect(matchToolPattern('http.fetch', 'http.post')).toBe(false);
  });
  it('matches prefix globs and wildcard', () => {
    expect(matchToolPattern('corpus.*', 'corpus.search')).toBe(true);
    expect(matchToolPattern('corpus.*', 'other.search')).toBe(false);
    expect(matchToolPattern('*', 'anything.at.all')).toBe(true);
  });
});

describe('evaluatePolicy', () => {
  it('allows explicitly listed tools', () => {
    const d = evaluatePolicy({
      tool: 'corpus.search',
      agentPolicies: cfg({ allowed: ['corpus.*'] }),
      toolRisk: 'low',
    });
    expect(d.decision).toBe('allow');
    expect(d.rule).toBe('corpus.*');
  });

  it('denies unlisted tools in allowlist mode (safe by default)', () => {
    const d = evaluatePolicy({
      tool: 'fs.write',
      agentPolicies: cfg({ allowed: ['corpus.*'] }),
      toolRisk: 'high',
    });
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('allowlist');
  });

  it('deny overrides allow regardless of order', () => {
    const d = evaluatePolicy({
      tool: 'http.fetch',
      agentPolicies: cfg({ allowed: ['http.*'], denied: ['http.fetch'] }),
      toolRisk: 'medium',
    });
    expect(d.decision).toBe('deny');
  });

  it('require_approval applies to matching tools and survives allowlist', () => {
    const d = evaluatePolicy({
      tool: 'report.write',
      agentPolicies: cfg({ allowed: ['report.write'], requireApproval: ['report.write'] }),
      toolRisk: 'high',
    });
    expect(d.decision).toBe('require_approval');
  });

  it('stored global rules deny even when agent allows', () => {
    const d = evaluatePolicy({
      tool: 'browser.click',
      agentPolicies: cfg({ allowed: ['*'] }),
      storedRules: [{ pattern: 'browser.*', action: 'deny' }],
      toolRisk: 'medium',
    });
    expect(d.decision).toBe('deny');
    expect(d.rule).toBe('browser.*');
  });

  it('stored rules can require approval', () => {
    const d = evaluatePolicy({
      tool: 'mcp.teamfs.delete',
      agentPolicies: cfg({ allowed: ['mcp.*'] }),
      storedRules: [{ pattern: 'mcp.teamfs.delete', action: 'require_approval' }],
      toolRisk: 'critical',
    });
    expect(d.decision).toBe('require_approval');
  });

  it('rate limits a tool after the configured per-run count', () => {
    const d = evaluatePolicy({
      tool: 'http.fetch',
      agentPolicies: cfg({ allowed: ['http.fetch'], rateLimits: { 'http.fetch': 2 } }),
      toolRisk: 'medium',
      callCounts: { 'http.fetch': 2 },
    });
    expect(d.decision).toBe('rate_limited');
    expect(d.reason).toContain('max 2');
  });

  it('does not rate limit below the threshold', () => {
    const d = evaluatePolicy({
      tool: 'http.fetch',
      agentPolicies: cfg({ allowed: ['http.fetch'], rateLimits: { 'http.fetch': 5 } }),
      toolRisk: 'medium',
      callCounts: { 'http.fetch': 1 },
    });
    expect(d.decision).toBe('allow');
  });

  it('denylist mode allows unlisted low/medium risk tools', () => {
    const d = evaluatePolicy({
      tool: 'calculator',
      agentPolicies: cfg({ mode: 'denylist', denied: ['fs.write'] }),
      toolRisk: 'low',
    });
    expect(d.decision).toBe('allow');
  });

  it('denylist mode still requires approval for unlisted critical tools', () => {
    const d = evaluatePolicy({
      tool: 'mcp.prod.deploy',
      agentPolicies: cfg({ mode: 'denylist' }),
      toolRisk: 'critical',
    });
    expect(d.decision).toBe('require_approval');
  });

  it('is deterministic for identical inputs', () => {
    const input = {
      tool: 'fs.write',
      agentPolicies: cfg({ requireApproval: ['fs.*'] }),
      toolRisk: 'high' as const,
      callCounts: {},
    };
    const a = evaluatePolicy(input);
    const b = evaluatePolicy(input);
    expect(a).toEqual(b);
  });
});

describe('summarizePolicy', () => {
  it('renders human-readable lines', () => {
    const lines = summarizePolicy(cfg({ allowed: ['a'], denied: ['b'], requireApproval: ['c'] }));
    expect(lines[0]).toContain('allowlist');
    expect(lines.join('\n')).toContain('allow: a');
    expect(lines.join('\n')).toContain('deny: b');
    expect(lines.join('\n')).toContain('require approval: c');
  });
});
