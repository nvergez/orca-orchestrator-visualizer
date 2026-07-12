import type { DatabaseSync } from 'node:sqlite';
import type { SchemaSupport } from '../shared/types.ts';
import { StartupError } from './errors.ts';

/**
 * Render what parses (SPEC §5).
 *
 * Orca's schema is internal and unversioned as a public API, so this tool must survive an
 * Orca update it has never seen. It does that by never trusting `user_version` to tell it
 * what columns exist: it **introspects the real columns** and builds its query set from
 * what is actually there. `user_version` only decides the *banner*.
 *
 * The migration history is purely additive (v2 `last_heartbeat_at`, v3 `delivered_at`,
 * v4 `created_by_terminal_handle`, v5 `task_title`/`display_name`), which is what makes
 * per-feature degradation realistic: a missing column costs exactly the feature that
 * needed it, and nothing else.
 */

/** The version this tool was written against. Newer is a banner; older is degradation. */
export const BUILT_FOR_SCHEMA_VERSION = 5;

export const TABLES = ['tasks', 'dispatch_contexts', 'messages', 'decision_gates', 'coordinator_runs'] as const;
export type TableName = (typeof TABLES)[number];

/**
 * A feature the visualizer offers, the column it cannot live without, and what the user is
 * told when that column is not there. These strings go straight to the screen — the user
 * is owed an explanation of *why* a badge vanished, not a silent absence.
 */
const FEATURES: { columns: string[]; degraded: string }[] = [
  {
    // Both are v5. Either one alone still names the task, so only losing both degrades.
    columns: ['tasks.task_title', 'tasks.display_name'],
    degraded: 'Task titles — this Orca has no task_title/display_name column, so tasks are labelled by their short id.',
  },
  {
    columns: ['tasks.created_by_terminal_handle'],
    degraded:
      'Runs — this Orca has no created_by_terminal_handle column, so runs cannot be inferred and every task lands in Unattributed.',
  },
  {
    columns: ['dispatch_contexts.last_heartbeat_at'],
    degraded: 'The "last seen" badge — this Orca has no last_heartbeat_at column, so agent liveness is not shown.',
  },
];

/** The DAG itself. Without these there is no graph to draw, and no honest way to fake one. */
const DAG_CORE = ['tasks.id', 'tasks.status', 'tasks.deps'];

export type SchemaReport = {
  version: number;
  support: SchemaSupport;
  degraded: string[];
  /** The columns each table really has. Never SELECT one that is not in here. */
  columns: Record<TableName, ReadonlySet<string>>;
};

function columnsOf(db: DatabaseSync, table: TableName): ReadonlySet<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set(); // The table is not there at all — an even older, or stranger, Orca.
  }
}

function supportFor(version: number): SchemaSupport {
  if (version === BUILT_FOR_SCHEMA_VERSION) return 'supported';
  return version > BUILT_FOR_SCHEMA_VERSION ? 'newer' : 'older';
}

/**
 * Read the schema, or refuse the database.
 *
 * **The DAG core is the only legal hard-fail in the whole tool** (SPEC §5). Everything
 * else — a newer version, a missing column, an enum value we have never heard of —
 * degrades. This one cannot: a `tasks` table with no `deps` has no edges to draw, and
 * rendering an empty canvas would be a lie about the orchestration.
 */
export function inspectSchema(db: DatabaseSync): SchemaReport {
  const columns = Object.fromEntries(TABLES.map((table) => [table, columnsOf(db, table)])) as SchemaReport['columns'];

  const has = (qualified: string): boolean => {
    const [table, column] = qualified.split('.') as [TableName, string];
    return columns[table].has(column);
  };

  const missingCore = DAG_CORE.filter((column) => !has(column));
  if (missingCore.length > 0) {
    throw new StartupError(
      `This database has no readable task DAG — ${missingCore.join(', ')} ${missingCore.length === 1 ? 'is' : 'are'} missing.`,
      'Is this really an Orca orchestration.db? Run `orca-viz --list-dbs` to see the databases it can find.'
    );
  }

  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

  return {
    version,
    support: supportFor(version),
    // Driven by the columns that are really absent, not by the version number: a database
    // can carry any version and still be missing anything.
    degraded: FEATURES.filter((feature) => !feature.columns.some(has)).map((feature) => feature.degraded),
    columns,
  };
}

/**
 * Did someone run `orchestration reset`?
 *
 * `messages.sequence` is AUTOINCREMENT, so `sqlite_sequence` remembers the highest id ever
 * handed out even after the rows are deleted. A counter that has run ahead of the rows
 * that survive is the fingerprint of a reset — and it is the difference between a
 * mysteriously empty history and an explained one (SPEC §5).
 */
export function detectReset(db: DatabaseSync): boolean {
  let counter: number;
  try {
    const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'messages'").get() as
      | { seq: number }
      | undefined;
    if (!row) return false; // No message has ever been written: nothing to have reset.
    counter = row.seq;
  } catch {
    return false; // No sqlite_sequence at all — not a database that can tell us.
  }

  const { n, lowest, highest } = db
    .prepare('SELECT COUNT(*) AS n, MIN(sequence) AS lowest, MAX(sequence) AS highest FROM messages')
    .get() as { n: number; lowest: number | null; highest: number | null };

  if (n === 0) return counter > 0; // Every message deleted, but the counter remembers them.
  return lowest! > 1 || counter > highest!;
}
