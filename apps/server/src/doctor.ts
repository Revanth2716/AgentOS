import fs from 'node:fs';
import path from 'node:path';
import { evaluatePolicy } from '@agentos/policy-engine';
import { runEventsToOtlp } from '@agentos/observability';
import { PolicyConfigSchema } from '@agentos/shared';
import type { AppContext } from './context.js';

export interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  required: boolean;
}

/**
 * Environment diagnostics shared by the CLI (`agentos doctor`) and the API.
 * `required` checks decide readiness: any required failure => NOT READY.
 */
export async function runDoctor(ctx: AppContext): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: DoctorCheck['status'], detail: string, required = true): void => {
    checks.push({ name, status, detail, required });
  };

  // 1. Node
  const major = Number(process.versions.node.split('.')[0]);
  add('Node', major >= 20 ? 'pass' : 'fail', `v${process.versions.node} (requires >= 20.10)`);

  // 2. SQLite
  try {
    const n = ctx.db.stats.runStats(0).total;
    add('SQLite', 'pass', `${ctx.config.dbFile} — ${ctx.db.migrationsApplied} migration(s) applied, ${n} run(s) stored`);
  } catch (e) {
    add('SQLite', 'fail', (e as Error).message);
  }

  // 3. Demo provider determinism self-test
  try {
    const { DeterministicMockProvider } = await import('@agentos/model-providers');
    const p = new DeterministicMockProvider();
    const req = {
      system: 'self-test',
      messages: [{ role: 'user' as const, content: 'doctor self test task' }],
      modelRef: 'mock/generic',
      allowedTools: [],
    };
    const a = await p.generate(req, new AbortController().signal);
    const b = await p.generate(req, new AbortController().signal);
    const deterministic = JSON.stringify(a.action) === JSON.stringify(b.action);
    add('Demo Provider', deterministic ? 'pass' : 'fail', deterministic ? 'deterministic mock verified (cost $0.00)' : 'mock output not deterministic');
  } catch (e) {
    add('Demo Provider', 'fail', (e as Error).message);
  }

  // 4. Policy engine self-test
  try {
    const decision = evaluatePolicy({
      tool: 'delete_file',
      agentPolicies: PolicyConfigSchema.parse({ mode: 'allowlist', allowed: ['search'], denied: ['delete_file'] }),
      toolRisk: 'critical',
    });
    add(
      'Policy Engine',
      decision.decision === 'deny' ? 'pass' : 'fail',
      decision.decision === 'deny' ? `deny rule verified (${decision.reason})` : `expected deny, got ${decision.decision}`,
    );
  } catch (e) {
    add('Policy Engine', 'fail', (e as Error).message);
  }

  // 5. Evaluation engine
  try {
    const suites = ctx.db.evals.listSuites();
    add('Evaluation Engine', 'pass', `${suites.length} suite(s) registered, deterministic runner ready`);
  } catch (e) {
    add('Evaluation Engine', 'fail', (e as Error).message);
  }

  // 6. Filesystem sandbox
  try {
    const probeDir = path.join(ctx.config.workspaceDir, '_doctor');
    fs.mkdirSync(probeDir, { recursive: true });
    const probe = path.join(probeDir, 'probe.txt');
    fs.writeFileSync(probe, 'ok', 'utf8');
    const content = fs.readFileSync(probe, 'utf8');
    fs.rmSync(probeDir, { recursive: true, force: true });
    add('Filesystem', content === 'ok' ? 'pass' : 'fail', `workspace writable at ${ctx.config.workspaceDir}`);
  } catch (e) {
    add('Filesystem', 'fail', (e as Error).message);
  }

  // 7. Ollama (optional)
  try {
    const res = await fetch(`${ctx.config.ollama.url}/api/tags`, { signal: AbortSignal.timeout(800) });
    add('Ollama', res.ok ? 'pass' : 'warn', res.ok ? `reachable at ${ctx.config.ollama.url}` : `unexpected status from ${ctx.config.ollama.url}`, false);
  } catch {
    add('Ollama', 'warn', `not reachable at ${ctx.config.ollama.url} (optional — mock provider covers demo)`, false);
  }

  // 8. Playwright + Chromium (optional)
  try {
    const { getBrowserManager } = await import('@agentos/browser');
    const probe = await getBrowserManager().availabilityProbe();
    add('Playwright', probe.available ? 'pass' : 'warn', probe.available ? 'playwright module loaded' : probe.reason ?? 'not installed (optional)', false);
    add('Chromium', probe.available ? 'pass' : 'warn', probe.available ? `executable at ${probe.executable}` : 'browser tools disabled until `npm run setup:browser` (optional)', false);
  } catch (e) {
    add('Playwright', 'warn', (e as Error).message, false);
  }

  // 9. MCP (optional)
  try {
    const servers = ctx.db.mcp.list();
    const connected = servers.filter((s) => ctx.mcp.isConnected(s.id)).length;
    add('MCP', 'pass', `${servers.length} registered server(s), ${connected} connected`, false);
  } catch (e) {
    add('MCP', 'warn', (e as Error).message, false);
  }

  // 10. Metrics
  try {
    const text = ctx.metrics.registry.render();
    add('Metrics', text.includes('agentos_') || text.includes('# TYPE') ? 'pass' : 'fail', `Prometheus exposition ready (${text.split('\n').length} lines)`);
  } catch (e) {
    add('Metrics', 'fail', (e as Error).message);
  }

  // 11. Tracing
  try {
    const otlp = runEventsToOtlp('run_doctor', [
      { runId: 'run_doctor', seq: 1, ts: Date.now(), type: 'task_received', status: 'ok' },
    ]);
    const ok = otlp.scopeSpans[0]?.spans.length === 1;
    add('Tracing', ok ? 'pass' : 'fail', ok ? 'OTLP/JSON export verified' : 'OTLP export produced no spans');
  } catch (e) {
    add('Tracing', 'fail', (e as Error).message);
  }

  // 12. Configuration
  try {
    fs.mkdirSync(ctx.config.dataDir, { recursive: true });
    add('Configuration', 'pass', `data dir ${ctx.config.dataDir}, host ${ctx.config.host}:${ctx.config.port}, demo mode ${ctx.config.demoMode ? 'on' : 'off'}`);
  } catch (e) {
    add('Configuration', 'fail', (e as Error).message);
  }

  // 13. Dashboard build (optional)
  const dist = path.join(ctx.config.webDist, 'index.html');
  add('Dashboard', fs.existsSync(dist) ? 'pass' : 'warn', fs.existsSync(dist) ? `built at ${ctx.config.webDist}` : 'not built — run `npm run build` for single-port serving (dev mode uses vite)', false);

  return checks;
}

export function doctorVerdict(checks: DoctorCheck[]): { ready: boolean; passed: number; warned: number; failed: number } {
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  const passed = checks.filter((c) => c.status === 'pass').length;
  return { ready: checks.filter((c) => c.required).every((c) => c.status === 'pass'), passed, warned, failed };
}
