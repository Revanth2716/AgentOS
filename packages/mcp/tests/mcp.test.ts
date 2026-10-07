import { afterAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type AgentDatabase } from '@agentos/database';
import { ToolRegistry } from '@agentos/tool-registry';
import { McpManager } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'fixture-server.mjs');

const dbs: AgentDatabase[] = [];

function setup(): { db: AgentDatabase; registry: ToolRegistry; manager: McpManager } {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const registry = new ToolRegistry();
  const manager = new McpManager(db, registry);
  return { db, registry, manager };
}

afterAll(() => {
  for (const db of dbs) db.close();
});

describe('MCP integration (offline fixture server)', () => {
  it('registers a server, discovers tools, and mirrors them into the registry', async () => {
    const { db, registry, manager } = setup();
    const server = db.mcp.create({
      name: 'fixture',
      command: process.execPath,
      args: [FIXTURE],
      env: {},
      riskLevel: 'high',
    });
    const count = await manager.connect(server);
    expect(count).toBe(2);

    // Registry + DB mirror under mcp.<server>.<tool>
    const mirrored = db.tools.list({ source: 'mcp' });
    expect(mirrored.map((t) => t.name).sort()).toEqual(['mcp.fixture.add', 'mcp.fixture.echo']);
    expect(mirrored[0]?.riskLevel).toBe('high');
    expect(mirrored[0]?.permissions).toEqual(['mcp:invoke']);
    expect(registry.get('mcp.fixture.echo')).toBeDefined();

    // Published JSON schema survives for UI display
    const echo = db.tools.get('mcp.fixture.echo');
    expect((echo?.inputSchema as { properties?: unknown }).properties).toBeTruthy();

    const status = db.mcp.get(server.id);
    expect(status?.status).toBe('connected');
    expect(status?.toolCount).toBe(2);
    await manager.shutdown();
  });

  it('executes MCP tool calls through the registry handler', async () => {
    const { db, registry, manager } = setup();
    const server = db.mcp.create({ name: 'exec', command: process.execPath, args: [FIXTURE], env: {}, riskLevel: 'high' });
    await manager.connect(server);

    const echoTool = registry.get('mcp.exec.echo');
    expect(echoTool).toBeDefined();
    const ctx = {
      runId: 'run_1',
      agentId: 'agt_1',
      signal: new AbortController().signal,
      workspaceDir: process.cwd(),
      artifactsDir: process.cwd(),
      logger: { info() {}, warn() {}, error() {} },
    };
    const echo = await echoTool?.handler({ text: 'hello agentos' }, ctx);
    expect(echo?.ok).toBe(true);
    expect(echo?.output).toBe('echo: hello agentos');

    const add = await registry.get('mcp.exec.add')?.handler({ a: 2, b: 40 }, ctx);
    expect(add?.ok).toBe(true);
    expect(add?.output).toBe('42');
    await manager.shutdown();
  });

  it('surfaces MCP isError responses as failed tool results', async () => {
    const { db, registry, manager } = setup();
    const server = db.mcp.create({ name: 'errs', command: process.execPath, args: [FIXTURE], env: {}, riskLevel: 'high' });
    await manager.connect(server);
    const ctx = {
      runId: 'run_1',
      agentId: 'agt_1',
      signal: new AbortController().signal,
      workspaceDir: process.cwd(),
      artifactsDir: process.cwd(),
      logger: { info() {}, warn() {}, error() {} },
    };
    // echo requires a non-empty "text" argument server-side
    const res = await registry.get('mcp.errs.echo')?.handler({}, ctx);
    expect(res?.ok).toBe(false);
    expect(res?.error).toContain('missing required argument: text');
    expect(res?.errorKind).toBe('permanent');
    await manager.shutdown();
  });

  it('marks unreachable servers as errored without crashing the app', async () => {
    const { db, manager } = setup();
    const server = db.mcp.create({
      name: 'broken',
      command: process.execPath,
      args: [path.join(__dirname, 'fixtures', 'does-not-exist.mjs')],
      env: {},
      riskLevel: 'high',
    });
    const result = await manager.connectAllRegistered();
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(db.mcp.get(server.id)?.status).toBe('error');
    await manager.shutdown();
  });

  it('reports a friendly error when calling while disconnected', async () => {
    const { db, registry, manager } = setup();
    const server = db.mcp.create({ name: 'gone', command: process.execPath, args: [FIXTURE], env: {}, riskLevel: 'high' });
    await manager.connect(server);
    await manager.disconnect(server.id);
    const ctx = {
      runId: 'run_1',
      agentId: 'agt_1',
      signal: new AbortController().signal,
      workspaceDir: process.cwd(),
      artifactsDir: process.cwd(),
      logger: { info() {}, warn() {}, error() {} },
    };
    const res = await registry.get('mcp.gone.echo')?.handler({ text: 'x' }, ctx);
    expect(res?.ok).toBe(false);
    expect(res?.error).toContain('not connected');
    expect(res?.errorKind).toBe('permanent');
  });
});
