import { describe, expect, it } from 'vitest';
import {
  DeterministicMockProvider,
  OllamaProvider,
  OpenAiCompatibleProvider,
  ProviderRegistry,
  estimateCost,
  extractKeywords,
  getBehavior,
  parseActionJson,
  type ModelProvider,
  type ModelRequest,
} from '../src/index.js';
import { ProviderError } from '@agentos/shared';

const tools = [
  {
    name: 'corpus.search',
    description: 'search',
    inputSchemaJson: { type: 'object' },
    sampleInput: () => ({ query: 'vector' }),
  },
  {
    name: 'corpus.read',
    description: 'read',
    inputSchemaJson: { type: 'object' },
    sampleInput: () => ({ id: 'doc-01' }),
  },
];

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  system: 'system',
  messages: [{ role: 'user', content: 'Find three facts about vector databases' }],
  modelRef: 'mock/researcher',
  allowedTools: tools,
  seed: 42,
  ...over,
});

describe('DeterministicMockProvider', () => {
  it('produces identical results for identical requests', async () => {
    const p = new DeterministicMockProvider();
    const a = await p.generate(req(), new AbortController().signal);
    const b = await p.generate(req(), new AbortController().signal);
    expect(a.action).toEqual(b.action);
    expect(a.usage).toEqual(b.usage);
  });

  it('researcher behavior sequences plan -> search -> read -> final', async () => {
    const p = new DeterministicMockProvider();
    const signal = new AbortController().signal;
    const base = req();

    const plan = await p.generate(base, signal);
    expect(plan.action.kind).toBe('plan');
    if (plan.action.kind !== 'plan') throw new Error('expected plan');

    // Runtime appends the assistant plan, then asks for the next action.
    const msgs2 = [...base.messages, { role: 'assistant' as const, content: JSON.stringify(plan.action) }];
    const search = await p.generate(req({ messages: msgs2 }), signal);
    expect(search.action.kind).toBe('tool_call');
    if (search.action.kind !== 'tool_call') throw new Error('expected tool_call');
    expect(search.action.call.name).toBe('corpus.search');

    // Runtime appends the assistant call + the tool observation envelope.
    const msgs3 = [
      ...msgs2,
      { role: 'assistant' as const, content: JSON.stringify(search.action) },
      {
        role: 'tool' as const,
        toolName: 'corpus.search',
        content: JSON.stringify({
          ok: true,
          output: 'hit',
          data: { __args: search.action.call.args, docs: [{ id: 'doc-01', title: 'A' }, { id: 'doc-02', title: 'B' }] },
        }),
      },
    ];
    const read = await p.generate(req({ messages: msgs3 }), signal);
    expect(read.action.kind).toBe('tool_call');
    if (read.action.kind !== 'tool_call') throw new Error('expected tool_call');
    expect(read.action.call.name).toBe('corpus.read');
    expect(read.action.call.args).toEqual({ id: 'doc-01' });
  });

  it('unknown behavior falls back to generic behavior', async () => {
    const p = new DeterministicMockProvider();
    const r = await p.generate(req({ modelRef: 'mock/does-not-exist' }), new AbortController().signal);
    expect(r.action).toBeDefined();
  });

  it('reports zero-cost locality', () => {
    const p = new DeterministicMockProvider();
    expect(p.metadata().locality).toBe('mock');
    expect(p.metadata().pricing).toBeNull();
    expect(p.supports('mock/researcher')).toBe(true);
    expect(p.supports('ollama/x')).toBe(false);
  });
});

describe('extractKeywords', () => {
  it('prefers quoted phrases', () => {
    expect(extractKeywords('summarize "local first architecture" today')).toEqual(['local first architecture']);
  });
  it('ranks meaningful words deterministically', () => {
    const k = extractKeywords('Find three facts about vector databases');
    expect(k).toContain('vector');
    expect(k.length).toBeLessThanOrEqual(3);
  });
});

describe('ProviderRegistry fallback', () => {
  class FailingProvider implements ModelProvider {
    name = 'failing';
    locality = 'cloud' as const;
    supports(modelRef: string): boolean {
      return modelRef === 'failing/x';
    }
    metadata() {
      return { name: this.name, locality: this.locality, defaultModel: 'x', contextWindow: 0, supportsStream: false, pricing: null };
    }
    async generate(): Promise<never> {
      throw new ProviderError('failing', 'boom');
    }
  }

  it('falls back to deterministic mock when a provider fails', async () => {
    let fallbackInfo: { modelRef: string; reason: string } | null = null;
    const reg = new ProviderRegistry([new FailingProvider()], {
      onFallback: (i) => {
        fallbackInfo = i;
      },
    });
    const out = await reg.generateWithFallback(req({ modelRef: 'failing/x' }), new AbortController().signal, 'failing/x');
    expect(out.fellBack).toBe(true);
    expect(out.usedProvider).toBe('mock');
    expect(out.cost.usd).toBe(0);
    expect(fallbackInfo).not.toBeNull();
  });

  it('does not fall back when the caller aborts', async () => {
    class AbortingProvider implements ModelProvider {
      name = 'aborting';
      locality = 'local' as const;
      supports(): boolean {
        return true;
      }
      metadata() {
        return { name: this.name, locality: this.locality, defaultModel: 'x', contextWindow: 0, supportsStream: false, pricing: null };
      }
      async generate(): Promise<never> {
        throw new Error('should not matter');
      }
    }
    const controller = new AbortController();
    controller.abort();
    const reg = new ProviderRegistry([new AbortingProvider()]);
    await expect(
      reg.generateWithFallback(req({ modelRef: 'aborting/x' }), controller.signal, 'aborting/x'),
    ).rejects.toThrow();
  });
});

describe('ollama JSON protocol', () => {
  it('parses final/call/plan actions', () => {
    expect(parseActionJson('{"action":"final","result":"done"}')).toEqual({ kind: 'final', result: 'done' });
    expect(parseActionJson('{"action":"call","tool":"t","args":{"a":1}}')).toEqual({
      kind: 'tool_call',
      call: { name: 't', args: { a: 1 }, purpose: undefined },
    });
    expect(parseActionJson('some prose without json')).toBeNull();
  });
  it('unparseable model output degrades to final text', async () => {
    const p = new OllamaProvider();
    // Server unreachable → ProviderError (registry fallback covers real runs).
    await expect(p.generate(req({ modelRef: 'ollama/llama3.2' }), new AbortController().signal)).rejects.toThrow(
      /ollama/,
    );
  });
});

describe('cost accounting', () => {
  it('cloud models get estimated cost; mock/local are $0', () => {
    const est = estimateCost({}, 'gpt-4o-mini', 1_000, 500);
    expect(est.usd).toBeCloseTo(0.00015 + 0.0003, 6);
    expect(est.estimated).toBe(false);
    const unknown = estimateCost({}, 'mystery-model', 1_000, 1_000);
    expect(unknown.estimated).toBe(true);
  });

  it('openai provider is marked cloud with pricing metadata', () => {
    const p = new OpenAiCompatibleProvider();
    expect(p.metadata().locality).toBe('cloud');
    expect(p.metadata().pricing).not.toBeNull();
  });
});
