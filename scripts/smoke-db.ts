import { openDatabase } from '../packages/database/src/index.js';

const db = openDatabase(':memory:');
const agent = db.agents.create({
  name: 'researcher',
  description: 'demo',
  model: 'mock/researcher',
  tools: ['corpus.search'],
  permissions: [],
  policies: {},
  limits: {},
  enabled: true,
});
const run = db.runs.create({
  agentId: agent.id,
  task: 'test task',
  mode: 'demo',
  seed: 42,
  provider: 'mock',
  model: 'mock/researcher',
  agentSnapshot: agent,
  traceId: 'trace_abc',
});
db.events.append({
  runId: run.id,
  seq: 1,
  ts: Date.now(),
  type: 'task_received',
  payload: { apiKey: 'sk-abc123def456ghi' },
});
const evs = db.events.listForRun(run.id);
console.log('agent:', agent.id, '| run:', run.id, '| events:', evs.length);
console.log('redaction applied:', JSON.stringify(evs[0].payload).includes('***REDACTED***'));
db.close();
console.log('DB_SMOKE_OK');
