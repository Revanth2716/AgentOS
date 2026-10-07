import { openSqlite, migrate, type SqliteDb } from './db.js';
import { AgentRepository } from './repos/agents.js';
import { ToolRepository, PolicyRepository, McpRepository } from './repos/registry.js';
import { RunRepository, EventRepository, DecisionRepository, CostRepository } from './repos/runs.js';
import { ApprovalRepository } from './repos/approvals.js';
import { WorkflowRepository } from './repos/workflows.js';
import { EvalRepository } from './repos/evals.js';
import { AuditRepository, SettingsRepository, CorpusRepository, StatsRepository } from './repos/system.js';

export * from './entities.js';
export { openSqlite, migrate, nextId, currentSeq, type SqliteDb } from './db.js';

/** Facade bundling every repository over one SQLite connection. */
export interface AgentDatabase {
  readonly file: string;
  readonly raw: SqliteDb;
  readonly migrationsApplied: number;
  readonly agents: AgentRepository;
  readonly tools: ToolRepository;
  readonly policies: PolicyRepository;
  readonly mcp: McpRepository;
  readonly runs: RunRepository;
  readonly events: EventRepository;
  readonly decisions: DecisionRepository;
  readonly costs: CostRepository;
  readonly approvals: ApprovalRepository;
  readonly workflows: WorkflowRepository;
  readonly evals: EvalRepository;
  readonly audit: AuditRepository;
  readonly settings: SettingsRepository;
  readonly corpus: CorpusRepository;
  readonly stats: StatsRepository;
  close(): void;
}

export function openDatabase(file: string): AgentDatabase {
  const raw = openSqlite(file);
  const migrationsApplied = migrate(raw);
  const facade: AgentDatabase = {
    file,
    raw,
    migrationsApplied,
    agents: new AgentRepository(raw),
    tools: new ToolRepository(raw),
    policies: new PolicyRepository(raw),
    mcp: new McpRepository(raw),
    runs: new RunRepository(raw),
    events: new EventRepository(raw),
    decisions: new DecisionRepository(raw),
    costs: new CostRepository(raw),
    approvals: new ApprovalRepository(raw),
    workflows: new WorkflowRepository(raw),
    evals: new EvalRepository(raw),
    audit: new AuditRepository(raw),
    settings: new SettingsRepository(raw),
    corpus: new CorpusRepository(raw),
    stats: new StatsRepository(raw),
    close(): void {
      raw.close();
    },
  };
  return facade;
}
