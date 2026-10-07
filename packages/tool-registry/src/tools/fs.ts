import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { resolveInSandbox, ensureDirSandboxed } from '../sandbox.js';

const MAX_READ_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;

const ReadSchema = z.object({ path: z.string().min(1).max(500) });
const WriteSchema = z.object({
  path: z.string().min(1).max(500),
  content: z.string().min(1).max(1_000_000),
});
const ListSchema = z.object({ path: z.string().max(500).default('.') });

export function fsReadTool(): ToolDefinition {
  return {
    name: 'fs.read',
    description: 'Read a text file inside the run workspace sandbox (max 64 KB).',
    kind: 'filesystem',
    riskLevel: 'low',
    permissions: ['fs:read'],
    inputSchema: ReadSchema,
    inputSchemaJson: {
      type: 'object',
      properties: { path: { type: 'string', description: 'path relative to the workspace sandbox' } },
      required: ['path'],
    },
    timeoutMs: 10_000,
    maxRetries: 0,
    sampleInput: () => ({ path: 'notes.txt' }),
    async handler(raw, ctx) {
      const parsed = ReadSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: `invalid input: ${parsed.error.issues[0]?.message}`, errorKind: 'validation', output: '' };
      }
      try {
        const file = resolveInSandbox(ctx.workspaceDir, parsed.data.path);
        const stat = fs.statSync(file);
        if (!stat.isFile()) return { ok: false, error: 'not a regular file', errorKind: 'permanent', output: '' };
        if (stat.size > MAX_READ_BYTES) {
          return { ok: false, error: `file too large (${stat.size} bytes > ${MAX_READ_BYTES})`, errorKind: 'permanent', output: '' };
        }
        const content = fs.readFileSync(file, 'utf8');
        return { ok: true, output: content, data: { path: parsed.data.path, bytes: stat.size } };
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        const kind = err.code === 'ENOENT' ? 'permanent' : 'transient';
        return { ok: false, error: `read failed: ${err.message}`, errorKind: kind, output: '' };
      }
    },
  };
}

export function fsWriteTool(): ToolDefinition {
  return {
    name: 'fs.write',
    description: 'Write a text file inside the run workspace sandbox (max 256 KB). Creates parent dirs.',
    kind: 'filesystem',
    riskLevel: 'medium',
    permissions: ['fs:write'],
    inputSchema: WriteSchema,
    inputSchemaJson: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'path relative to the workspace sandbox' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    timeoutMs: 10_000,
    maxRetries: 0,
    sampleInput: () => ({ path: 'out/result.md', content: '# Result\n' }),
    async handler(raw, ctx) {
      const parsed = WriteSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: `invalid input: ${parsed.error.issues[0]?.message}`, errorKind: 'validation', output: '' };
      }
      try {
        const file = resolveInSandbox(ctx.workspaceDir, parsed.data.path);
        ensureDirSandboxed(ctx.workspaceDir, path.dirname(parsed.data.path));
        if (Buffer.byteLength(parsed.data.content, 'utf8') > MAX_WRITE_BYTES) {
          return { ok: false, error: `content too large (max ${MAX_WRITE_BYTES} bytes)`, errorKind: 'permanent', output: '' };
        }
        fs.writeFileSync(file, parsed.data.content, 'utf8');
        return {
          ok: true,
          output: `wrote ${parsed.data.path} (${Buffer.byteLength(parsed.data.content, 'utf8')} bytes)`,
          data: { path: parsed.data.path, bytes: Buffer.byteLength(parsed.data.content, 'utf8') },
        };
      } catch (e) {
        return { ok: false, error: `write failed: ${(e as Error).message}`, errorKind: 'transient', output: '' };
      }
    },
  };
}

export function fsListTool(): ToolDefinition {
  return {
    name: 'fs.list',
    description: 'List entries of a directory inside the run workspace sandbox.',
    kind: 'filesystem',
    riskLevel: 'low',
    permissions: ['fs:read'],
    inputSchema: ListSchema,
    inputSchemaJson: {
      type: 'object',
      properties: { path: { type: 'string', description: 'directory relative to the sandbox (default ".")' } },
    },
    timeoutMs: 10_000,
    maxRetries: 0,
    sampleInput: () => ({ path: '.' }),
    async handler(raw, ctx) {
      const parsed = ListSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        return { ok: false, error: `invalid input: ${parsed.error.issues[0]?.message}`, errorKind: 'validation', output: '' };
      }
      try {
        const dir = resolveInSandbox(ctx.workspaceDir, parsed.data.path || '.');
        const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 500);
        const lines = entries.map((e) => {
          const size = e.isFile() ? fs.statSync(path.join(dir, e.name)).size : null;
          return `${e.isDirectory() ? 'dir ' : 'file'}  ${e.name}${size !== null ? ` (${size} B)` : ''}`;
        });
        return {
          ok: true,
          output: lines.length ? lines.join('\n') : '(empty directory)',
          data: { count: entries.length, entries: entries.map((e) => ({ name: e.name, dir: e.isDirectory() })) },
        };
      } catch (e) {
        return { ok: false, error: `list failed: ${(e as Error).message}`, errorKind: 'permanent', output: '' };
      }
    },
  };
}
