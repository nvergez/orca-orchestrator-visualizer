import { DatabaseSync } from 'node:sqlite';
import type { FixtureBuilder } from './builder.ts';
import { tempDbPath } from './temp-dir.ts';

/**
 * Reading a fixture the way the tool reads the real database — `readOnly: true`, always
 * (SPEC §1.2, hard invariant 1). Tests assert on what comes back out of SQLite, never on
 * what the builder put in.
 */

const handles: DatabaseSync[] = [];

/** Write the fixture to a temporary database and open it read-only. */
export function openFixture(builder: FixtureBuilder): DatabaseSync {
  const db = new DatabaseSync(builder.write(tempDbPath()), { readOnly: true });
  handles.push(db);
  return db;
}

/** Close every handle `openFixture` handed out. Call from `afterEach` / `afterAll`. */
export function closeFixtures(): void {
  for (const db of handles.splice(0)) db.close();
}

export function rows<T = Record<string, unknown>>(db: DatabaseSync, sql: string): T[] {
  return db.prepare(sql).all() as T[];
}

/** The single number a `SELECT ... AS n` came back with. */
export function count(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}
