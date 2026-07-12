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
 * The one cursor in this schema that can be trusted: AUTOINCREMENT, gap-free, append-only.
 * It spots an `orchestration reset` (`detectReset`), and it is what the message feed resumes
 * from (`highWaterMark`, and #17's SSE event id) — three call sites for one column, so it is
 * named once and guarded by that name.
 */
export const MESSAGE_SEQUENCE = 'messages.sequence';

/**
 * What it takes to derive a gate from a `decision_gate` message — the primary and required
 * source, and the only one the live database actually has (`gates.ts`, SPEC §4.5).
 *
 * All three, or none. `type` is what finds a gate at all, and `id` + `thread_id` are the *only*
 * record anywhere in this schema that one was ever answered: without them every gate in the
 * file reads open forever, and a strip raised over 53 questions that were all settled days ago
 * is worse than no strip at all. So the feature degrades whole rather than degrading into a lie.
 *
 * **`payload` is deliberately not on this list.** It costs a gate its options and the node it
 * marks, and half the live database's gate messages have no question in it anyway — the
 * question is in the `subject`. Requiring it would disable more than its absence really costs,
 * which is exactly the over-degradation #21 exists to prevent (`GATE_PAYLOAD` below).
 */
export const GATE_MESSAGE_COLUMNS = ['messages.type', 'messages.id', 'messages.thread_id'] as const;

/** What a gate loses when there is no payload to read: its options, and the task it blocks. */
export const GATE_PAYLOAD = 'messages.payload';

/**
 * A feature the visualizer offers, the column it cannot live without, and what the user is
 * told when that column is not there. These strings go straight to the screen — the user
 * is owed an explanation of *why* a badge vanished, not a silent absence.
 *
 * **This list is the whole degradation contract, and it is meant to be added to.** A feature
 * that reads a column outside the DAG core belongs here, worded for a human: name the feature
 * first, then the column, then what the user gets instead. A feature with no entry degrades
 * silently, which is the failure this ticket exists to prevent.
 *
 * A feature names its columns one of two ways, and they are not the same question:
 *
 * - `anyOf` — *any* one of them is enough. The ordinary case is a single column; a pair is how
 *   two interchangeable ones are spelled (the two title columns).
 * - `allOf` — it needs **all** of them. That is a feature whose columns are not alternatives
 *   but parts: lose one and what is left is not a lesser version of the feature, it is a
 *   wrong one (the gate columns, above).
 *
 * One or the other, never neither: a feature that named no column would be satisfied by every
 * database forever, and would degrade silently — which is the one thing this list exists to
 * make impossible. The type is what enforces that, rather than a rule someone has to remember.
 */
type Feature = { degraded: string } & (
  | { anyOf: readonly string[]; allOf?: never }
  | { allOf: readonly string[]; anyOf?: never }
);

const FEATURES: Feature[] = [
  {
    // Both are v5. Either one alone still names the task, so only losing both degrades.
    anyOf: ['tasks.task_title', 'tasks.display_name'],
    degraded: 'Task titles — this Orca has no task_title/display_name column, so tasks are labelled by their short id.',
  },
  {
    anyOf: ['tasks.created_by_terminal_handle'],
    degraded:
      'Runs — this Orca has no created_by_terminal_handle column, so runs cannot be inferred and every task lands in Unattributed.',
  },
  {
    anyOf: ['dispatch_contexts.last_heartbeat_at'],
    degraded: 'The "last seen" badge — this Orca has no last_heartbeat_at column, so agent liveness is not shown.',
  },
  {
    // The feed is ordered by `sequence` and resumed from it. A feed with no order is not a
    // feed, so this column is the one the whole panel rests on — the message *rows* can all
    // be there and it still cannot be built.
    anyOf: [MESSAGE_SEQUENCE],
    degraded:
      'The message feed — this Orca has no messages.sequence column, so there is no cursor to order the feed by or resume it from.',
  },
  {
    anyOf: [MESSAGE_SEQUENCE],
    degraded:
      'Reset detection — this Orca has no messages.sequence column, so a history wiped by `orchestration reset` cannot be spotted.',
  },
  {
    // Gates come from *messages*, never from the `decision_gates` table (SPEC §4.2, trap 1) —
    // so the columns a gate needs are the message columns, and this is what their absence costs.
    // The table is still merged in additively when it has rows; it just almost never does.
    allOf: GATE_MESSAGE_COLUMNS,
    degraded:
      'Decision gates — this Orca is missing one of messages.type/id/thread_id, so a gate cannot be read from the messages that raise it, or told apart from one that was already answered.',
  },
  {
    anyOf: [GATE_PAYLOAD],
    degraded:
      'Gate options, and the task a gate blocks — this Orca has no messages.payload column, so a gate shows the question in its subject line and marks no node.',
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

/**
 * Is this column really there? — the question every query in this server has to ask first.
 *
 * `selectPresent` (`rows.ts`) asks it for whole row reads. This is for the handful of queries
 * that are not row reads: an aggregate, a `MAX()`, anything that names a column in SQL text
 * of its own. Asking SQLite for a column that is not there is not a degraded feature, it is a
 * thrown error — and outside the DAG core, throwing is never this tool's right to take.
 *
 * `table.column`, so a call site reads as the thing it is guarding.
 */
export function hasColumn(columns: SchemaReport['columns'], qualified: string): boolean {
  const [table, column] = qualified.split('.') as [TableName, string];
  const present = columns[table];

  // A table that is not one of Orca's five is a typo in *this* file, not drift in the
  // database — every real table introspects to a set, an absent one to an empty set. Answering
  // `false` would report the feature degraded forever and never say why, and this list is
  // explicitly meant to be added to (`FEATURES`), so the typo has to be loud.
  if (present === undefined) throw new Error(`not a table in Orca's schema: ${table} (from "${qualified}")`);

  return present.has(column);
}

/** A feature survives when *any* of the columns it can choose between, or *all* of the ones it is made of, are there. */
function satisfied(feature: Feature, has: (column: string) => boolean): boolean {
  return feature.anyOf === undefined ? feature.allOf.every(has) : feature.anyOf.some(has);
}

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

  const has = (qualified: string): boolean => hasColumn(columns, qualified);

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
    degraded: FEATURES.filter((feature) => !satisfied(feature, has)).map((feature) => feature.degraded),
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
 *
 * The detector is itself a *feature*, and so it degrades like one: an Orca with no
 * `messages.sequence` gets no reset detection and is told so (`FEATURES`), rather than being
 * asked a question SQLite would answer by throwing.
 */
export function detectReset(db: DatabaseSync, columns: SchemaReport['columns']): boolean {
  if (!hasColumn(columns, MESSAGE_SEQUENCE)) return false;

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
