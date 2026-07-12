import { DatabaseSync } from 'node:sqlite';

/**
 * The only way this tool opens a database — so that "every connection is read-only" is a
 * property of one function rather than a promise made in several places.
 *
 * Two settings, both load-bearing (SPEC §2.2):
 *
 * - `readOnly: true`, hard invariant #1. Orca's coordinator assumes it is the single
 *   writer and maintains its invariants inside its own transactions.
 * - `PRAGMA busy_timeout`, because brief locks exist around checkpoint and recovery
 *   windows. Without it a read that lands during a checkpoint fails instantly with
 *   `SQLITE_BUSY` — and a discovery probe that fails that way would mark a perfectly good
 *   database unusable and move on to a different one, which is the exact failure this tool
 *   exists to prevent.
 *
 * And one setting deliberately *not* used: **never `immutable=1`**. It tells SQLite the
 * file cannot change, which is a lie whenever Orca is running, and the reads go quietly
 * corrupt rather than loudly wrong (SPEC §2.2, `docs/research/db-discovery.md` §4.4).
 */

export const BUSY_TIMEOUT_MS = 5000;

/** Throws whatever SQLite throws — callers decide whether that is fatal or just a miss. */
export function openReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}
