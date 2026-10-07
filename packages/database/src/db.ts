import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { formatId, type IdPrefix } from '@agentos/shared';
import { MIGRATIONS } from './migrations.js';

export type SqliteDb = InstanceType<typeof Database>;

export function openSqlite(file: string): SqliteDb {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}

/** Applies pending migrations in order, each in its own transaction. Returns count applied. */
export function migrate(db: SqliteDb): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`,
  );
  const applied = new Set(
    (db.prepare('SELECT version FROM _migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const apply = db.transaction(() => {
      for (const stmt of m.statements) db.exec(stmt);
      db.prepare('INSERT INTO _migrations(version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now(),
      );
    });
    apply();
    count += 1;
  }
  return count;
}

/** Monotonic, human-readable IDs: run_1, agt_2, … (deterministic ordering). */
export function nextId(db: SqliteDb, prefix: IdPrefix): string {
  const row = db
    .prepare(
      `INSERT INTO counters(name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get(prefix) as { value: number };
  return formatId(prefix, row.value);
}

export function currentSeq(db: SqliteDb, prefix: IdPrefix): number {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(prefix) as
    | { value: number }
    | undefined;
  return row?.value ?? 0;
}
