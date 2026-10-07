import type { PolicyAction, PolicyConfig, RiskLevel } from '@agentos/shared';

export interface PolicyRuleEntity {
  pattern: string;
  action: 'allow' | 'deny' | 'require_approval';
  maxCallsPerRun?: number;
  note?: string;
}

export interface PolicyDecisionInput {
  tool: string;
  /** Embedded per-agent policy config. */
  agentPolicies: PolicyConfig;
  /** Rules from stored policies (global + agent-scoped). */
  storedRules?: PolicyRuleEntity[];
  toolRisk: RiskLevel;
  /** Times each tool was invoked in the current run (drives rate limits). */
  callCounts?: Record<string, number>;
}

export interface PolicyDecision {
  decision: PolicyAction;
  /** Which pattern produced the decision (audit trail). */
  rule: string | null;
  reason: string;
}

/**
 * Tool pattern matching: exact name, trailing-star prefix glob ("corpus.*", "http*"),
 * or "*" for everything. Deterministic and side-effect free.
 */
export function matchToolPattern(pattern: string, tool: string): boolean {
  if (pattern === tool) return true;
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1));
  return false;
}

interface MatchedRule {
  action: PolicyRuleEntity['action'];
  pattern: string;
  maxCallsPerRun?: number;
  source: 'agent' | 'stored';
}

function collectMatches(
  input: PolicyDecisionInput,
  action: PolicyRuleEntity['action'],
  patterns: string[],
  source: MatchedRule['source'],
): MatchedRule[] {
  const out: MatchedRule[] = [];
  for (const p of patterns) {
    if (matchToolPattern(p, input.tool)) {
      out.push({ action, pattern: p, source });
    }
  }
  return out;
}

/**
 * Deterministic, auditable policy decision.
 *
 * Precedence (most restrictive wins, defined order breaks ties):
 *   1. explicit deny
 *   2. require_approval
 *   3. explicit allow
 *   4. mode default — allowlist: deny unlisted tools (safe by default),
 *                      denylist: allow unlisted tools unless risk=critical (then approval)
 * Rate limits apply after an allow/approval decision, based on per-run call counts.
 *
 * Model output can never influence this function's inputs beyond naming the tool.
 */
export function evaluatePolicy(input: PolicyDecisionInput): PolicyDecision {
  const cfg = input.agentPolicies;
  const stored = input.storedRules ?? [];

  const matches: MatchedRule[] = [
    ...collectMatches(input, 'deny', cfg.denied, 'agent'),
    ...collectMatches(input, 'require_approval', cfg.requireApproval, 'agent'),
    ...collectMatches(input, 'allow', cfg.allowed, 'agent'),
    ...stored.map(
      (r): MatchedRule =>
        matchToolPattern(r.pattern, input.tool)
          ? { action: r.action, pattern: r.pattern, maxCallsPerRun: r.maxCallsPerRun, source: 'stored' }
          : { action: 'deny', pattern: '', source: 'stored' },
    ).filter((m) => m.pattern !== ''),
  ];

  const byAction = (a: MatchedRule['action']): MatchedRule | undefined =>
    matches.find((m) => m.action === a);

  const deny = byAction('deny');
  if (deny) {
    return { decision: 'deny', rule: deny.pattern, reason: `denied by rule "${deny.pattern}"` };
  }

  const approval = byAction('require_approval');
  const allow = byAction('allow');
  const effective: MatchedRule | undefined = approval ?? allow;

  if (!effective && cfg.mode === 'allowlist') {
    return {
      decision: 'deny',
      rule: null,
      reason: `tool "${input.tool}" is not in the agent allowlist (mode=allowlist)`,
    };
  }

  if (!effective && cfg.mode === 'denylist') {
    if (input.toolRisk === 'critical') {
      return {
        decision: 'require_approval',
        rule: null,
        reason: `unlisted critical-risk tool requires approval (mode=denylist)`,
      };
    }
    return {
      decision: 'allow',
      rule: null,
      reason: `no matching rule; allowed by mode=denylist (risk=${input.toolRisk})`,
    };
  }

  const rule = effective as MatchedRule;

  // Rate limiting (deterministic per-run counts — no wall clock).
  const ratePattern = Object.keys(cfg.rateLimits).find((p) => matchToolPattern(p, input.tool));
  const limits: { pattern: string; max: number }[] = [];
  if (ratePattern) limits.push({ pattern: ratePattern, max: cfg.rateLimits[ratePattern] as number });
  if (rule.maxCallsPerRun) limits.push({ pattern: rule.pattern, max: rule.maxCallsPerRun });

  if (limits.length > 0) {
    const used = input.callCounts?.[input.tool] ?? 0;
    const binding = limits.sort((a, b) => a.max - b.max)[0] as { pattern: string; max: number };
    if (used >= binding.max) {
      return {
        decision: 'rate_limited',
        rule: binding.pattern,
        reason: `rate limited by "${binding.pattern}": max ${binding.max} calls per run (used ${used})`,
      };
    }
  }

  if (rule.action === 'require_approval') {
    return {
      decision: 'require_approval',
      rule: rule.pattern,
      reason: `requires approval by rule "${rule.pattern}"`,
    };
  }
  return {
    decision: 'allow',
    rule: rule.pattern,
    reason:
      rule.source === 'agent'
        ? `allowed by rule "${rule.pattern}"`
        : `allowed by stored policy rule "${rule.pattern}"`,
  };
}

/** Human-readable summary of an agent's policy config (used by UI + docs). */
export function summarizePolicy(cfg: PolicyConfig): string[] {
  const lines: string[] = [`mode: ${cfg.mode}`];
  if (cfg.allowed.length) lines.push(`allow: ${cfg.allowed.join(', ')}`);
  if (cfg.denied.length) lines.push(`deny: ${cfg.denied.join(', ')}`);
  if (cfg.requireApproval.length) lines.push(`require approval: ${cfg.requireApproval.join(', ')}`);
  const rates = Object.entries(cfg.rateLimits);
  if (rates.length) lines.push(`rate limits: ${rates.map(([t, n]) => `${t}<=${n}/run`).join(', ')}`);
  return lines;
}
