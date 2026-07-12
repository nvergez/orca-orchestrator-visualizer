import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The files that make up an Orca instance directory, and how fresh they are.
 *
 * **The `-wal` is part of the database** (SPEC §2.3): the live WAL was 4 MB against a
 * 512 KB main file, so the most recent orchestration state may exist *only* in the WAL
 * until a checkpoint. Anything that asks "how recent is this database?" — the stale-state
 * wording, the discovery tiebreak — has to look at both files or it will read a busy
 * instance as an idle one.
 */

/** Orca's liveness marker: the running app's pid and RPC endpoint, beside the database. */
export const RUNTIME_FILE = 'orca-runtime.json';

/** The database file Orca puts at the root of its `userData` directory. */
export const DB_FILE = 'orchestration.db';

export function walPath(dbPath: string): string {
  return `${dbPath}-wal`;
}

/** `orca-runtime.json` for the instance whose database this is. */
export function runtimeFilePath(dbPath: string): string {
  return join(dirname(dbPath), RUNTIME_FILE);
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null; // Not there — a clean shutdown deletes the `-wal`.
  }
}

/**
 * The most recent mtime of the database *or its WAL*, or null when the database is not
 * there at all.
 */
export function databaseMtime(dbPath: string): Date | null {
  const main = mtimeOf(dbPath);
  if (main === null) return null;
  const wal = mtimeOf(walPath(dbPath));
  return new Date(wal === null ? main : Math.max(main, wal));
}
