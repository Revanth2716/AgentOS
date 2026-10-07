/**
 * Ordered, append-only migrations. Each runs exactly once inside a transaction;
 * applied versions are tracked in the `_migrations` table.
 *
 * Note: migrations live as typed modules (not loose .sql files) so the package
 * is self-contained and path resolution never breaks under tsx, node --dist,
 * or bundlers.
 */

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core_agents_runs_policies',
    statements: [
      `CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
      `CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT 'mock/generic',
        system_prompt TEXT,
        tools TEXT NOT NULL DEFAULT '[]',
        permissions TEXT NOT NULL DEFAULT '[]',
        policies TEXT NOT NULL DEFAULT '{}',
        limits TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE agent_versions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        config TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(agent_id, version)
      )`,
      `CREATE TABLE tools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'builtin',
        source TEXT NOT NULL DEFAULT 'builtin',
        risk_level TEXT NOT NULL DEFAULT 'medium',
        permissions TEXT NOT NULL DEFAULT '[]',
        input_schema TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        mcp_server_id TEXT REFERENCES mcp_servers(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE policies (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        agent_name TEXT,
        rules TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        workflow_run_id TEXT,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        mode TEXT NOT NULL DEFAULT 'demo',
        seed INTEGER NOT NULL,
        provider TEXT NOT NULL DEFAULT 'mock',
        model TEXT NOT NULL DEFAULT 'mock/generic',
        agent_snapshot TEXT NOT NULL DEFAULT '{}',
        steps INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        tool_failures INTEGER NOT NULL DEFAULT 0,
        retries INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        error TEXT,
        final_result TEXT,
        pending_action TEXT,
        trace_id TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_runs_status ON runs(status)`,
      `CREATE INDEX idx_runs_agent ON runs(agent_id, created_at DESC)`,
      `CREATE TABLE run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        agent_id TEXT,
        tool TEXT,
        payload TEXT,
        duration_ms INTEGER,
        status TEXT,
        trace_id TEXT,
        span_id TEXT,
        UNIQUE(run_id, seq)
      )`,
      `CREATE INDEX idx_run_events_run ON run_events(run_id, seq)`,
      `CREATE TABLE policy_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        ts INTEGER NOT NULL,
        agent_id TEXT,
        tool TEXT NOT NULL,
        decision TEXT NOT NULL,
        rule TEXT,
        reason TEXT NOT NULL,
        args_digest TEXT
      )`,
      `CREATE INDEX idx_policy_decisions_run ON policy_decisions(run_id)`,
      `CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        run_id TEXT,
        workflow_run_id TEXT,
        agent_id TEXT,
        tool TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '{}',
        summary TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'tool_execution',
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT
      )`,
      `CREATE INDEX idx_approvals_status ON approvals(status, requested_at DESC)`,
      `CREATE TABLE costs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        ts INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        est_cost_usd REAL NOT NULL DEFAULT 0,
        locality TEXT NOT NULL DEFAULT 'mock'
      )`,
      `CREATE INDEX idx_costs_ts ON costs(ts)`,
      `CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        command TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '[]',
        env TEXT NOT NULL DEFAULT '{}',
        risk_level TEXT NOT NULL DEFAULT 'high',
        status TEXT NOT NULL DEFAULT 'unregistered',
        tool_count INTEGER NOT NULL DEFAULT 0,
        last_discovered_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        details TEXT
      )`,
      `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    ],
  },
  {
    version: 2,
    name: 'workflows',
    statements: [
      `CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        graph TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
        enabled INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'queued',
        input TEXT NOT NULL DEFAULT '{}',
        output TEXT,
        error TEXT,
        current_nodes TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER,
        ended_at INTEGER,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_workflow_runs_wf ON workflow_runs(workflow_id, created_at DESC)`,
      `CREATE TABLE workflow_node_runs (
        id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        agent_id TEXT,
        run_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt INTEGER NOT NULL DEFAULT 1,
        started_at INTEGER,
        ended_at INTEGER,
        output TEXT,
        error TEXT,
        UNIQUE(workflow_run_id, node_id, attempt)
      )`,
    ],
  },
  {
    version: 3,
    name: 'evaluations',
    statements: [
      `CREATE TABLE eval_suites (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL,
        cases TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE eval_runs (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        suite_id TEXT NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        started_at INTEGER,
        ended_at INTEGER,
        summary TEXT,
        error TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE eval_case_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        eval_run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
        case_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        passed INTEGER NOT NULL DEFAULT 0,
        run_id TEXT,
        metrics TEXT NOT NULL DEFAULT '{}',
        failure_reason TEXT
      )`,
    ],
  },
  {
    version: 4,
    name: 'demo_corpus',
    statements: [
      `CREATE TABLE demo_corpus (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        published TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        content TEXT NOT NULL DEFAULT '',
        citations TEXT NOT NULL DEFAULT '[]'
      )`,
      `CREATE TABLE run_states (
        run_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT '{}'
      )`,
    ],
  },
];
