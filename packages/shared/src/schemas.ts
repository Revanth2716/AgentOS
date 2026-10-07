import { z } from 'zod';

/**
 * Zod schemas are the single source of truth for every externally supplied
 * structure: API bodies, agent configs, workflow graphs, eval suites.
 * They are also used by the runtime to validate tool inputs.
 */

export const LimitsSchema = z
  .object({
    maxSteps: z.number().int().min(1).max(500).default(10),
    maxRuntimeMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
    maxCostUsd: z.number().min(0).max(1_000).default(0.5),
    toolTimeoutMs: z.number().int().min(100).max(600_000).default(30_000),
    maxRetries: z.number().int().min(0).max(5).default(2),
  })
  .default({});
export type Limits = z.infer<typeof LimitsSchema>;

export const PolicyConfigSchema = z
  .object({
    mode: z.enum(['allowlist', 'denylist']).default('allowlist'),
    /** Tool names, prefix globs ("corpus.*") or "*" */
    allowed: z.array(z.string().max(128)).max(100).default([]),
    denied: z.array(z.string().max(128)).max(100).default([]),
    requireApproval: z.array(z.string().max(128)).max(100).default([]),
    /** tool pattern -> max invocations per run (deterministic rate limiting) */
    rateLimits: z.record(z.string().max(128), z.number().int().min(1).max(10_000)).default({}),
  })
  .default({});
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

export const AgentSpecSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/, 'letters, digits, space, dash, underscore'),
  description: z.string().max(2_000).default(''),
  /** Provider/model reference: "mock/<behavior>", "ollama/<model>", "openai/<model>" */
  model: z.string().min(1).max(128).default('mock/generic'),
  systemPrompt: z.string().max(8_000).optional(),
  tools: z.array(z.string().max(128)).max(64).default([]),
  permissions: z.array(z.string().max(64)).max(64).default([]),
  policies: PolicyConfigSchema,
  limits: LimitsSchema,
  enabled: z.boolean().default(true),
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export const AgentPatchSchema = AgentSpecSchema.partial();

export const ToolPattern = z.string().max(128);

export const PolicyRuleSchema = z.object({
  pattern: ToolPattern,
  action: z.enum(['allow', 'deny', 'require_approval']),
  /** max calls per run when the rule also rate limits */
  maxCallsPerRun: z.number().int().min(1).max(10_000).optional(),
  note: z.string().max(500).optional(),
});

/** A named, storable policy (in addition to per-agent embedded config). */
export const PolicySpecSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/),
  description: z.string().max(2_000).default(''),
  /** apply to one agent name, or omit for global */
  agentName: z.string().max(64).optional(),
  rules: z.array(PolicyRuleSchema).max(200).default([]),
  enabled: z.boolean().default(true),
});
export type PolicySpec = z.infer<typeof PolicySpecSchema>;

export const WorkflowNodeSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  type: z.enum(['input', 'agent', 'approval', 'output']),
  agentId: z.string().max(64).optional(),
  label: z.string().max(120).optional(),
  /** Template with {{nodeId.output}} interpolation for the node task. */
  inputTemplate: z.string().max(8_000).optional(),
});
export const WorkflowSpecSchema = z
  .object({
    nodes: z.array(WorkflowNodeSchema).min(1).max(50),
    edges: z
      .array(z.object({ from: z.string().max(48), to: z.string().max(48) }))
      .max(200)
      .default([]),
  })
  .superRefine((wf, ctx) => {
    const ids = new Set(wf.nodes.map((n) => n.id));
    if (ids.size !== wf.nodes.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate node ids' });
    }
    for (const e of wf.edges) {
      if (!ids.has(e.from) || !ids.has(e.to)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `edge references unknown node: ${e.from}->${e.to}` });
      }
      if (e.from === e.to) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'self-edges are not allowed' });
      }
    }
  });
export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;

export const EvalExpectSchema = z
  .object({
    keywords: z.array(z.string().max(120)).max(20).default([]),
    minSources: z.number().int().min(0).max(100).default(0),
    requireCitations: z.boolean().default(false),
    toolsUsed: z.array(z.string().max(128)).max(20).default([]),
    maxSteps: z.number().int().min(1).max(500).optional(),
    maxDurationMs: z.number().int().min(100).optional(),
  })
  .default({});

export const EvalCaseSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  task: z.string().min(1).max(8_000),
  expect: EvalExpectSchema,
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const EvalSuiteSpecSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(2_000).default(''),
  agentId: z.string().min(1).max(64),
  cases: z.array(EvalCaseSchema).min(1).max(100),
});
export type EvalSuiteSpec = z.infer<typeof EvalSuiteSpecSchema>;

export const McpServerSpecSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  command: z.string().min(1).max(500),
  args: z.array(z.string().max(500)).max(50).default([]),
  /** Env vars for the MCP server process. Values are stored redacted. */
  env: z.record(z.string().max(128), z.string().max(2_000)).default({}),
  /** Risk applied to every tool exposed by this server. */
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']).default('high'),
});
export type McpServerSpec = z.infer<typeof McpServerSpecSchema>;

/** Tool execution request body for the manual tool console. */
export const ToolInvokeSchema = z.object({
  args: z.record(z.string(), z.unknown()).default({}),
});
