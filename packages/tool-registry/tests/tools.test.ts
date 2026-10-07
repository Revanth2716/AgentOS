import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ToolRegistry,
  resolveInSandbox,
  sanitizeFilename,
  calculatorTool,
  fsReadTool,
  fsWriteTool,
  httpFetchTool,
  corpusSearchTool,
  corpusReadTool,
  type ToolContext,
  type CorpusService,
} from '../src/index.js';
import { SandboxError } from '@agentos/shared';

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-ws-'));
}

function ctx(workspaceDir: string): ToolContext {
  return {
    runId: 'run_test',
    agentId: 'agt_test',
    signal: new AbortController().signal,
    workspaceDir,
    artifactsDir: path.join(workspaceDir, '..', 'artifacts-test'),
    logger: { info() {}, warn() {}, error() {} },
  };
}

describe('sandbox', () => {
  it('resolves paths inside the sandbox', () => {
    const root = tmpWorkspace();
    const resolved = resolveInSandbox(root, 'sub/dir/file.txt');
    expect(resolved.startsWith(path.resolve(root) + path.sep)).toBe(true);
  });

  it('rejects traversal attempts', () => {
    const root = tmpWorkspace();
    expect(() => resolveInSandbox(root, '../../etc/passwd')).toThrow(SandboxError);
    expect(() => resolveInSandbox(root, 'sub/../../../etc/passwd')).toThrow(SandboxError);
    expect(() => resolveInSandbox(root, '/etc/passwd')).toThrow(SandboxError);
    expect(() => resolveInSandbox(root, 'a\0b')).toThrow(SandboxError);
  });

  it('rejects symlink escapes', () => {
    const root = tmpWorkspace();
    const outside = tmpWorkspace();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'), 'file');
      expect(() => resolveInSandbox(root, 'link.txt')).toThrow(SandboxError);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return; // Windows without symlink privilege
      throw e;
    }
  });

  it('sanitizes filenames', () => {
    expect(sanitizeFilename('report-01.md')).toBe('report-01.md');
    expect(() => sanitizeFilename('../evil.md')).toThrow(SandboxError);
    expect(() => sanitizeFilename('sub/dir/x.md')).toThrow(SandboxError);
    expect(() => sanitizeFilename('x\0y')).toThrow(SandboxError);
  });
});

describe('calculator', () => {
  const tool = calculatorTool();
  const noopCtx = ctx(os.tmpdir());
  it('evaluates arithmetic with precedence', async () => {
    const r = await tool.handler({ expression: '(2+3)*4' }, noopCtx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('20');
  });
  it('supports unary minus, %, ^', async () => {
    expect((await tool.handler({ expression: '-5 + 2^3 % 3' }, noopCtx)).ok).toBe(true);
  });
  it('rejects division by zero and malformed input', async () => {
    expect((await tool.handler({ expression: '1/0' }, noopCtx)).error).toContain('division by zero');
    expect((await tool.handler({ expression: '2+' }, noopCtx)).ok).toBe(false);
    expect((await tool.handler({ expression: 'process.exit(1)' }, noopCtx)).ok).toBe(false);
  });
});

describe('registry permissions', () => {
  it('resolves only permission-satisfied tools for an agent', () => {
    const reg = new ToolRegistry();
    reg.register(calculatorTool());
    reg.register(fsReadTool());
    reg.register(fsWriteTool());
    const agent = { tools: ['calculator', 'fs.read', 'fs.write'], permissions: ['fs:read'] };
    const resolved = reg.resolveForAgent(agent);
    expect(resolved.map((t) => t.name)).toEqual(['calculator', 'fs.read']);
    const check = reg.checkPermissions(['fs:read'], fsWriteTool());
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual(['fs:write']);
  });
});

describe('filesystem tools', () => {
  it('write then read within sandbox', async () => {
    const root = tmpWorkspace();
    const write = fsWriteTool();
    const read = fsReadTool();
    const w = await write.handler({ path: 'out/note.txt', content: 'hello agentos' }, ctx(root));
    expect(w.ok).toBe(true);
    const r = await read.handler({ path: 'out/note.txt' }, ctx(root));
    expect(r.ok).toBe(true);
    expect(r.output).toBe('hello agentos');
  });
  it('read outside sandbox is rejected', async () => {
    const root = tmpWorkspace();
    const r = await fsReadTool().handler({ path: '../../../etc/hostname' }, ctx(root));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('sandbox');
  });
});

describe('http.fetch SSRF guard', () => {
  it('blocks non-http schemes and credential URLs without network', async () => {
    const tool = httpFetchTool();
    const r1 = await tool.handler({ url: 'file:///etc/passwd' }, ctx(os.tmpdir()));
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('blocked scheme');
    const r2 = await tool.handler({ url: 'http://user:pass@example.com' }, ctx(os.tmpdir()));
    expect(r2.ok).toBe(false);
  });
});

describe('corpus tools', () => {
  const corpus: CorpusService = {
    search: (q, limit) =>
      [
        { doc: { id: 'doc-01', title: 'Vector databases', source: 's', url: 'u', published: '2026-01-01', tags: ['vector'], content: 'vector search index', citations: ['doc-01'] }, score: 9 },
      ]
        .filter((r) => r.doc.title.toLowerCase().includes(q.toLowerCase()) || q === '')
        .slice(0, limit),
    get: (id) =>
      id === 'doc-01'
        ? { id: 'doc-01', title: 'Vector databases', source: 's', url: 'u', published: '2026-01-01', tags: [], content: 'body', citations: ['doc-01'] }
        : null,
    count: () => 1,
  };
  it('search returns formatted results', async () => {
    const r = await corpusSearchTool(corpus).handler({ query: 'vector' }, ctx(os.tmpdir()));
    expect(r.ok).toBe(true);
    expect(r.output).toContain('[doc-01]');
  });
  it('read returns full document; unknown id fails permanently', async () => {
    const tool = corpusReadTool(corpus);
    const r = await tool.handler({ id: 'doc-01' }, ctx(os.tmpdir()));
    expect(r.ok).toBe(true);
    expect(r.output).toContain('Vector databases');
    const bad = await tool.handler({ id: 'nope' }, ctx(os.tmpdir()));
    expect(bad.ok).toBe(false);
    expect(bad.errorKind).toBe('permanent');
  });
});
