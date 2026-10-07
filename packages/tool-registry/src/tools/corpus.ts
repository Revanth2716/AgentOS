import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

/** Structurally compatible with @agentos/database CorpusDoc (kept decoupled). */
export interface CorpusDocument {
  id: string;
  title: string;
  source: string;
  url: string;
  published: string;
  tags: string[];
  content: string;
  citations: string[];
}

/** Injected read-only view over the demo corpus (backed by SQLite). */
export interface CorpusService {
  search(query: string, limit: number): { doc: CorpusDocument; score: number }[];
  get(id: string): CorpusDocument | null;
  count(): number;
}

const SearchSchema = z.object({
  query: z.string().min(2).max(300),
  limit: z.number().int().min(1).max(10).default(5),
});

const ReadSchema = z.object({ id: z.string().min(1).max(64) });

export function corpusSearchTool(corpus: CorpusService): ToolDefinition {
  return {
    name: 'corpus.search',
    description:
      'Search the offline demo corpus of synthetic documents. Returns ranked doc ids, titles, sources and snippets. Zero network access.',
    kind: 'corpus',
    riskLevel: 'low',
    permissions: [],
    inputSchema: SearchSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keyword query' },
        limit: { type: 'integer', description: 'max results (1-10, default 5)' },
      },
      required: ['query'],
    },
    timeoutMs: 5_000,
    maxRetries: 0,
    sampleInput: () => ({ query: 'vector database' }),
    async handler(raw) {
      const parsed = SearchSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: `invalid input: ${parsed.error.issues[0]?.message}`, errorKind: 'validation', output: '' };
      }
      const results = corpus.search(parsed.data.query, parsed.data.limit);
      if (results.length === 0) {
        return { ok: true, output: `no corpus documents matched "${parsed.data.query}"`, data: { hits: 0 } };
      }
      const lines = results.map(
        ({ doc, score }) => `[${doc.id}] ${doc.title} — ${doc.source} (${doc.published}) score=${score}\n    ${doc.content.slice(0, 160)}…`,
      );
      return {
        ok: true,
        output: lines.join('\n'),
        data: {
          hits: results.length,
          docs: results.map(({ doc, score }) => ({ id: doc.id, title: doc.title, score })),
        },
      };
    },
  };
}

export function corpusReadTool(corpus: CorpusService): ToolDefinition {
  return {
    name: 'corpus.read',
    description: 'Read one offline corpus document by id (e.g. "doc-03"). Returns title, source and full text.',
    kind: 'corpus',
    riskLevel: 'low',
    permissions: [],
    inputSchema: ReadSchema,
    inputSchemaJson: {
      type: 'object',
      properties: { id: { type: 'string', description: 'corpus document id' } },
      required: ['id'],
    },
    timeoutMs: 5_000,
    maxRetries: 0,
    sampleInput: () => ({ id: 'doc-01' }),
    async handler(raw) {
      const parsed = ReadSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: `invalid input: ${parsed.error.issues[0]?.message}`, errorKind: 'validation', output: '' };
      }
      const doc = corpus.get(parsed.data.id);
      if (!doc) {
        return {
          ok: false,
          error: `unknown corpus id: ${parsed.data.id} — use corpus.search to discover ids`,
          errorKind: 'permanent',
          output: '',
        };
      }
      return {
        ok: true,
        output: `# ${doc.title}\nsource: ${doc.source} (${doc.url}) published: ${doc.published}\n\n${doc.content}`,
        data: { id: doc.id, title: doc.title, source: doc.source, citations: doc.citations },
      };
    },
  };
}
