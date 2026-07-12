import type { DatabaseSync } from 'node:sqlite';
import type { SchemaReport } from './schema.ts';

/**
 * The query layer's shared floor: read rows out of a table without ever naming a column the
 * database does not have.
 *
 * This is what makes "render what parses" (SPEC §5) mechanical rather than a promise. Every
 * reader — the tasks, the dispatch attempts, the coordinator runs — asks for the columns it
 * *wants* and gets the intersection with the columns that are really there, so an older Orca
 * costs exactly the feature whose column is missing and never a SQL error.
 */

export type Row = Record<string, unknown>;
export type Columns = SchemaReport['columns'];

/**
 * SELECT only what the file really has, in `rowid` order — insertion order, which is the
 * order `MAX(rowid)` folds depend on and a stable base for everything else.
 *
 * `projected` swaps a column for an expression over it, which is how `spec` and `result`
 * become booleans without their 172 KB of agent prompt ever crossing the SQLite boundary.
 */
export function selectPresent(
  db: DatabaseSync,
  table: string,
  present: ReadonlySet<string>,
  wanted: readonly string[],
  projected: Record<string, string> = {}
): Row[] {
  const columns = wanted.filter((column) => present.has(column));
  if (columns.length === 0) return [];

  const selected = columns.map((column) => projected[column] ?? column);
  return db.prepare(`SELECT ${selected.join(', ')} FROM ${table} ORDER BY rowid`).all() as Row[];
}

/** A TEXT column, or null when it is empty or absent. Nothing in this schema is validated. */
export function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** SQLite has no boolean type: a comparison comes back as the integer 1 or 0. */
export function isTrue(value: unknown): boolean {
  return value === 1;
}
