import type { SqliteDb } from '../db.js';
import { jsonString, parseJson, parsePolicyConfig } from '../repo-utils.js';
import { toRun } from './runs.js';
import type { AuditEntry, CorpusDoc } from '../entities.js';

export class AuditRepository {
  constructor(private readonly db: SqliteDb) {}

  add(input: { actor: string; action: string; target?: string | null; details?: Record<string, unknown> }): void {
    this.db
      .prepare('INSERT INTO audit_log (ts, actor, action, target, details) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), input.actor, input.action, input.target ?? null, input.details ? jsonString(input.details) : null);
  }

  list(limit = 100): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(limit) as {
      id: number;
      ts: number;
      actor: string;
      action: string;
      target: string | null;
      details: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      actor: r.actor,
      action: r.action,
      target: r.target,
      details: parseJson<Record<string, unknown> | null>(r.details, null),
    }));
  }
}

export class SettingsRepository {
  constructor(private readonly db: SqliteDb) {}

  get(key: string, fallback?: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? fallback;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }
}

export class CorpusRepository {
  constructor(private readonly db: SqliteDb) {}

  seed(docs: CorpusDoc[]): number {
    const insert = this.db.prepare(
      `INSERT INTO demo_corpus (id, title, source, url, published, tags, content, citations)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, tags=excluded.tags`,
    );
    const tx = this.db.transaction((all: CorpusDoc[]) => {
      for (const d of all) {
        insert.run(d.id, d.title, d.source, d.url, d.published, JSON.stringify(d.tags), d.content, JSON.stringify(d.citations));
      }
    });
    tx(docs);
    return docs.length;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM demo_corpus').get() as { n: number };
    return row.n;
  }

  list(): CorpusDoc[] {
    const rows = this.db.prepare('SELECT * FROM demo_corpus ORDER BY id').all() as {
      id: string;
      title: string;
      source: string;
      url: string;
      published: string;
      tags: string;
      content: string;
      citations: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      source: r.source,
      url: r.url,
      published: r.published,
      tags: parseJson<string[]>(r.tags, []),
      content: r.content,
      citations: parseJson<string[]>(r.citations, []),
    }));
  }

  get(id: string): CorpusDoc | null {
    const row = this.db.prepare('SELECT * FROM demo_corpus WHERE id = ?').get(id) as
      | (Omit<CorpusDoc, 'tags' | 'citations'> & { tags: string; citations: string })
      | undefined;
    if (!row) return null;
    return {
      ...row,
      tags: parseJson<string[]>(row.tags, []),
      citations: parseJson<string[]>(row.citations, []),
    };
  }

  /** Deterministic keyword search: title/tag matches rank above content matches. */
  search(query: string, limit = 5): { doc: CorpusDoc; score: number }[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2);
    const scored = this.list().map((doc) => {
      const title = doc.title.toLowerCase();
      const tagText = doc.tags.join(' ').toLowerCase();
      const content = doc.content.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (title.includes(t)) score += 5;
        if (tagText.includes(t)) score += 3;
        const hits = content.split(t).length - 1;
        score += Math.min(hits, 5);
      }
      return { doc, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
      .slice(0, limit);
  }
}

export class StatsRepository {
  constructor(private readonly db: SqliteDb) {}

  runStats(sinceTs = 0): {
    total: number;
    today: number;
    active: number;
    completed: number;
    failed: number;
    cancelled: number;
    avgDurationMs: number;
    toolCalls: number;
    toolFailures: number;
  } {
    const sinceToday = Date.now() - 86_400_000;
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today,
                SUM(CASE WHEN status IN ('queued','running','waiting_approval','paused') THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
                AVG(CASE WHEN ended_at IS NOT NULL AND started_at IS NOT NULL THEN ended_at - started_at END) AS avg_duration,
                SUM(tool_calls) AS tool_calls,
                SUM(tool_failures) AS tool_failures
         FROM runs WHERE created_at >= ?`,
      )
      .get(sinceToday, sinceTs) as {
      total: number;
      today: number | null;
      active: number | null;
      completed: number | null;
      failed: number | null;
      cancelled: number | null;
      avg_duration: number | null;
      tool_calls: number | null;
      tool_failures: number | null;
    };
    return {
      total: totals.total,
      today: totals.today ?? 0,
      active: totals.active ?? 0,
      completed: totals.completed ?? 0,
      failed: totals.failed ?? 0,
      cancelled: totals.cancelled ?? 0,
      avgDurationMs: Math.round(totals.avg_duration ?? 0),
      toolCalls: totals.tool_calls ?? 0,
      toolFailures: totals.tool_failures ?? 0,
    };
  }

  runsPerDay(days = 14): { day: string; runs: number; failed: number }[] {
    const since = Date.now() - days * 86_400_000;
    const rows = this.db
      .prepare(
        `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS runs,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM runs WHERE created_at >= ? GROUP BY day ORDER BY day ASC`,
      )
      .all(since) as { day: string; runs: number; failed: number | null }[];
    return rows.map((r) => ({ day: r.day, runs: r.runs, failed: r.failed ?? 0 }));
  }

  agentPerformance(agentId: string): {
    runs: number;
    successRate: number;
    avgDurationMs: number;
    avgSteps: number;
    costUsd: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS runs,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                AVG(CASE WHEN ended_at IS NOT NULL AND started_at IS NOT NULL THEN ended_at - started_at END) AS avg_duration,
                AVG(steps) AS avg_steps,
                SUM(cost_usd) AS cost
         FROM runs WHERE agent_id = ? AND status IN ('completed','failed')`,
      )
      .get(agentId) as {
      runs: number;
      completed: number | null;
      avg_duration: number | null;
      avg_steps: number | null;
      cost: number | null;
    };
    const runs = row.runs;
    return {
      runs,
      successRate: runs > 0 ? (row.completed ?? 0) / runs : 0,
      avgDurationMs: Math.round(row.avg_duration ?? 0),
      avgSteps: Math.round((row.avg_steps ?? 0) * 10) / 10,
      costUsd: row.cost ?? 0,
    };
  }

  recentRuns(limit = 10) {
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY seq DESC LIMIT ?')
      .all(limit) as Parameters<typeof toRun>[0][];
    return rows.map(toRun);
  }
}

export { parsePolicyConfig };
