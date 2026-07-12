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

/**
 * The same floor, for the reads that are **not** whole-table reads.
 *
 * `selectPresent` is right for rows that are overwritten in place: read them all, every tick.
 * It is wrong for `messages`, which is an append-only log the client has already seen most of
 * (the client resumes after a cursor) and of which the gates want 53 rows in 466 (`WHERE type =
 * 'decision_gate'`). Both of those still owe the same debt — **never name a column the file
 * does not have** — so they pay it here rather than each rolling their own filter.
 *
 * `tail` is whatever follows the table: the caller's `WHERE`, its `ORDER BY`, its placeholders.
 * It may only name columns the caller has already checked are present (`hasColumn`); nothing
 * else in this module can check that for it, because nothing else can parse SQL.
 */
export function selectWhere(
  db: DatabaseSync,
  table: string,
  present: ReadonlySet<string>,
  wanted: readonly string[],
  tail: string,
  parameters: (string | number)[] = []
): Row[] {
  const columns = wanted.filter((column) => present.has(column));
  if (columns.length === 0) return [];

  return db.prepare(`SELECT ${columns.join(', ')} FROM ${table} ${tail}`).all(...parameters) as Row[];
}

/** A TEXT column, or null when it is empty or absent. Nothing in this schema is validated. */
export function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** SQLite has no boolean type: a comparison comes back as the integer 1 or 0. */
export function isTrue(value: unknown): boolean {
  return value === 1;
}
