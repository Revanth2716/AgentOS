import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { sanitizeFilename } from '../sandbox.js';

const WriteSchema = z.object({
  filename: z.string().min(3).max(128),
  content: z.string().min(1).max(2_000_000),
});

/**
 * Publishes a report artifact. Deliberately writes OUTSIDE the run workspace
 * (into the shared artifacts directory), so demo policy config marks it
 * require_approval — exercising the human approval flow for real.
 */
export function reportWriteTool(): ToolDefinition {
  return {
    name: 'report.write',
    description:
      'Write a markdown report to the shared artifacts directory (outside the run sandbox). High impact: typically requires human approval.',
    kind: 'filesystem',
    riskLevel: 'high',
    permissions: ['artifacts:write'],
    inputSchema: WriteSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'target filename (letters/digits/dash/underscore/dot only)' },
        content: { type: 'string', description: 'markdown content' },
      },
      required: ['filename', 'content'],
    },
    timeoutMs: 10_000,
    maxRetries: 0,
    sampleInput: () => ({ filename: 'research-report.md', content: '# Report\n' }),
    async handler(raw, ctx) {
      const parsed = WriteSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: `invalid input: ${parsed.error.issues[0]?.message}`, errorKind: 'validation', output: '' };
      }
      let filename: string;
      try {
        filename = sanitizeFilename(parsed.data.filename);
      } catch (e) {
        return { ok: false, error: (e as Error).message, errorKind: 'validation', output: '' };
      }
      try {
        const dir = path.join(ctx.artifactsDir, 'reports');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, filename);
        fs.writeFileSync(file, parsed.data.content, 'utf8');
        return {
          ok: true,
          output: `report published: ${path.relative(process.cwd(), file)} (${parsed.data.content.length} bytes)`,
          data: { file: path.relative(process.cwd(), file), bytes: parsed.data.content.length },
        };
      } catch (e) {
        return { ok: false, error: `report write failed: ${(e as Error).message}`, errorKind: 'transient', output: '' };
      }
    },
  };
}
