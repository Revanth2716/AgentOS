import type { ModelAction, ModelRequest, ToolSummary } from '../types.js';

/**
 * Scripted, deterministic behaviors used by the DeterministicMockProvider.
 * A behavior maps the conversation state to the next action — no randomness
 * in the decision logic, so identical runs (same seed) replay identically.
 */

export interface BehaviorContext {
  task: string;
  step: number;
  allowedTools: ToolSummary[];
  messages: ModelRequest['messages'];
  /** Structured results of prior tool calls in this run. */
  called: Array<{
    tool: string;
    args: Record<string, unknown>;
    ok: boolean;
    output: string;
    data?: Record<string, unknown>;
  }>;
  /** Upstream workflow node outputs (nodeId -> output). */
  workflowInput?: Record<string, unknown>;
}

export type Behavior = (ctx: BehaviorContext) => ModelAction;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'about', 'find', 'me',
  'three', 'two', 'some', 'please', 'that', 'this', 'it', 'is', 'are', 'be', 'by', 'from', 'into',
]);

/** Deterministic keyword extraction: quoted phrases win, then longest content words. */
export function extractKeywords(task: string, max = 3): string[] {
  const quoted = task.match(/["']([^"']{3,80})["']/);
  if (quoted) return [quoted[1] as string];
  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const ranked = [...new Set(words)].sort((a, b) => b.length - a.length);
  return ranked.slice(0, max);
}

function findTool(tools: ToolSummary[], name: string): ToolSummary | undefined {
  return tools.find((t) => t.name === name);
}

function searchResultDocs(ctx: BehaviorContext): Array<{ id: string; title: string }> {
  for (let i = ctx.called.length - 1; i >= 0; i--) {
    const c = ctx.called[i] as (typeof ctx.called)[number];
    if (c.tool === 'corpus.search' && c.ok) {
      const docs = (c.data as { docs?: Array<{ id: string; title: string }> } | undefined)?.docs;
      if (docs && docs.length > 0) return docs;
    }
  }
  return [];
}

function upstreamText(ctx: BehaviorContext): string {
  if (!ctx.workflowInput) return '';
  return Object.entries(ctx.workflowInput)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
}

/** Researcher: plan → corpus.search → read top docs → cited summary. */
export const researcherBehavior: Behavior = (ctx) => {
  const search = findTool(ctx.allowedTools, 'corpus.search');
  const read = findTool(ctx.allowedTools, 'corpus.read');
  if (ctx.step === 0) {
    return { kind: 'plan', text: `Plan: 1) search corpus for "${extractKeywords(ctx.task).join(' ')}" 2) read the top sources 3) summarize with citations` };
  }
  if (ctx.step === 1 && search) {
    return {
      kind: 'tool_call',
      call: {
        name: 'corpus.search',
        args: { query: extractKeywords(ctx.task).join(' '), limit: 5 },
        purpose: 'find candidate sources',
      },
    };
  }
  const docs = searchResultDocs(ctx);
  const readIdx = ctx.called.filter((c) => c.tool === 'corpus.read').length;
  if (read && docs.length > readIdx) {
    return {
      kind: 'tool_call',
      call: { name: 'corpus.read', args: { id: docs[readIdx]?.id }, purpose: 'collect source details' },
    };
  }
  const sources = docs.map((d) => `[${d.id}] ${d.title}`);
  return {
    kind: 'final',
    result:
      `Research summary for "${ctx.task}":\n\n` +
      `Key findings from ${sources.length} source(s):\n` +
      sources.map((s) => `- ${s} [source: ${s.slice(1, s.indexOf(']'))}]`).join('\n') +
      (sources.length ? '' : '\n- (no corpus documents matched; see corpus.search)'),
  };
};

/** Evidence collector: reads remaining docs, emits structured evidence. */
export const evidenceCollectorBehavior: Behavior = (ctx) => {
  const search = findTool(ctx.allowedTools, 'corpus.search');
  const read = findTool(ctx.allowedTools, 'corpus.read');
  if (ctx.step === 0 && search) {
    return { kind: 'tool_call', call: { name: 'corpus.search', args: { query: extractKeywords(ctx.task).join(' '), limit: 5 }, purpose: 'locate all relevant sources' } };
  }
  const docs = searchResultDocs(ctx);
  const readCount = ctx.called.filter((c) => c.tool === 'corpus.read').length;
  if (read && docs.length > readCount + 1) {
    return { kind: 'tool_call', call: { name: 'corpus.read', args: { id: docs[readCount + 1]?.id }, purpose: 'extract evidence' } };
  }
  const evidence = docs.map((d, i) => ({ id: d.id, title: d.title, relevance: i === 0 ? 'primary' : 'supporting' }));
  return {
    kind: 'final',
    result: JSON.stringify(
      {
        evidence,
        note: 'deduplicated by corpus id; each entry carries its source id for citation checks',
      },
      null,
      2,
    ),
  };
};

/** Analyst: computes simple stats and derives themes from upstream evidence. */
export const analystBehavior: Behavior = (ctx) => {
  const calc = findTool(ctx.allowedTools, 'calculator');
  if (ctx.step === 0 && calc) {
    const docs = searchResultDocs(ctx);
    const count = docs.length || ctx.called.filter((c) => c.tool === 'corpus.read').length;
    return {
      kind: 'tool_call',
      call: { name: 'calculator', args: { expression: `${count} * 100 / 5` }, purpose: 'evidence coverage percentage (5 = corpus size)' },
    };
  }
  const coverage = ctx.called.find((c) => c.tool === 'calculator' && c.ok)?.output ?? 'coverage: n/a';
  return {
    kind: 'final',
    result:
      `Analysis:\n- Themes extracted from collected evidence (deterministic grouping by keyword overlap)\n- ${coverage}\n- Recommendation: proceed to evaluation with citation checks`,
  };
};

/** Evaluator agent: deterministic checks — citations present, min sources. */
export const evaluatorBehavior: Behavior = (ctx) => {
  const upstream = upstreamText(ctx) || ctx.task;
  const citations = (upstream.match(/\[source:\s*[^\]]+\]/g) ?? []).length;
  const sources = (upstream.match(/\[doc-\d+\]/g) ?? []).length;
  return {
    kind: 'final',
    result: JSON.stringify(
      {
        evaluator: 'deterministic-checks',
        citationsPresent: citations > 0,
        citationCount: citations,
        sourceCount: sources,
        passed: citations > 0 && sources >= 1,
        issues: citations === 0 ? ['no [source: …] citations found in upstream output'] : [],
      },
      null,
      2,
    ),
  };
};

/** Finalizer: publishes the markdown report (approval-gated), then finishes. */
export const finalizerBehavior: Behavior = (ctx) => {
  const report = findTool(ctx.allowedTools, 'report.write');
  if (ctx.step === 0 && report) {
    const body =
      `# Research Report\n\nTask: ${ctx.task}\n\n` +
      (ctx.workflowInput ? `## Inputs\n${upstreamText(ctx)}\n\n` : '') +
      '## Method\nDeterministic demo pipeline: research → evidence → analysis → evaluation.\n';
    return {
      kind: 'tool_call',
      call: { name: 'report.write', args: { filename: 'research-report.md', content: body }, purpose: 'publish final report artifact' },
    };
  }
  const published = ctx.called.find((c) => c.tool === 'report.write');
  return {
    kind: 'final',
    result: published?.ok
      ? `Report published (${(published.data as { file?: string } | undefined)?.file ?? 'artifacts/reports/research-report.md'}). Workflow complete.`
      : 'Report step finished.',
  };
};

/**
 * Generic fallback behavior: makes ANY agent runnable offline. Calls up to
 * three allowed tools with deterministic sample inputs, then summarizes.
 */
export const genericBehavior: Behavior = (ctx) => {
  const callable = ctx.allowedTools.filter((t) => t.name !== 'report.write');
  if (ctx.step === 0) {
    return { kind: 'plan', text: `Plan: probe allowed tools [${ctx.allowedTools.map((t) => t.name).join(', ')}] with sample inputs, then summarize observations.` };
  }
  const done = ctx.called.length;
  if (done < Math.min(3, callable.length)) {
    const tool = callable[done] as ToolSummary;
    return {
      kind: 'tool_call',
      call: { name: tool.name, args: tool.sampleInput(), purpose: `probe ${tool.name}` },
    };
  }
  const lines = ctx.called.map(
    (c) => `- ${c.tool}: ${c.ok ? 'ok' : 'failed'} → ${c.output.slice(0, 140).replace(/\n/g, ' ')}`,
  );
  return {
    kind: 'final',
    result: `Deterministic summary for "${ctx.task}":\n${lines.join('\n')}\n\n(mock provider — LOCAL, $0.00)`,
  };
};

export const BEHAVIORS: Record<string, Behavior> = {
  researcher: researcherBehavior,
  'evidence-collector': evidenceCollectorBehavior,
  analyst: analystBehavior,
  evaluator: evaluatorBehavior,
  finalizer: finalizerBehavior,
  generic: genericBehavior,
};

export function getBehavior(id: string | undefined): Behavior {
  return BEHAVIORS[id ?? 'generic'] ?? genericBehavior;
}
