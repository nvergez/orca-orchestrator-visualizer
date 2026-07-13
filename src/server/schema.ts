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
 * The four graph-owned tables: where task graph history lives (CONTEXT.md), and exactly what
 * a tasks-only reset deletes — `messages` is deliberately not among them (#50). Named once,
 * here, because the history-loss detector (`history-loss.ts`) and the fixture that models
 * the reset (`test/fixtures/builder.ts`) must mean the same four tables or the test proves
 * nothing.
 */
export const GRAPH_OWNED_TABLES = [
  'tasks',
  'dispatch_contexts',
  'decision_gates',
  'coordinator_runs',
] as const satisfies readonly TableName[];

/**
 * The one cursor in this schema that can be trusted: AUTOINCREMENT, gap-free, append-only.
 * It spots lost message history (`detectHistoryLoss`), and it is what the message log resumes
 * from (the rows used for the event, and the SSE event id) — three call sites for one column,
 * so it is named once and guarded by that name.
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
 * which is exactly the over-degradation #21 exists to prevent (`MESSAGE_PAYLOAD` below).
 */
export const GATE_MESSAGE_COLUMNS = ['messages.type', 'messages.id', 'messages.thread_id'] as const;

/**
 * `payload.taskId` is the only thing in this schema that links a message to a task — it carries
 * 83% of attribution (SPEC §4.4). Without the column, a gate loses its options and the task it
 * blocks, *and* the inspector loses the messages that referenced a task: one absent column, two
 * features, and `FEATURES` names them separately because a user is owed both.
 */
export const MESSAGE_PAYLOAD = 'messages.payload';

/**
 * What it takes to recognize the empty-graph shape a tasks-only reset leaves (#50, SPEC §5.1):
 * `messages.payload` for the retained task reference, and the identity column of every other
 * graph-owned table — not because counting rows reads `id`, but because a table has to be
 * *verified through introspection* before its emptiness can be observed at all: an absent
 * table introspects to the same empty column set a renamed one does, and asking SQLite to
 * count a table that is not there throws. Derived from `GRAPH_OWNED_TABLES` minus `tasks`,
 * whose columns are the DAG core and the one legal hard-fail (`inspectSchema`) — a database
 * without them never reaches this question.
 */
export const TASK_GRAPH_EVIDENCE_COLUMNS: readonly string[] = [
  MESSAGE_PAYLOAD,
  ...GRAPH_OWNED_TABLES.filter((table) => table !== 'tasks').map((table) => `${table}.id`),
];

/** What finds a message of one kind at all — the gates need it, and so do the completions (#67). */
export const MESSAGE_TYPE = 'messages.type';

/**
 * What it takes to read an outcome receipt out of a worker's completion (#67): `type` to find
 * the `worker_done` rows, `payload` to read what they handed back. Either alone reads nothing
 * honest — rows that cannot be told apart, or rows with nothing in them to recognize.
 */
export const COMPLETION_COLUMNS = [MESSAGE_TYPE, MESSAGE_PAYLOAD] as const;

/** What ties a dispatch attempt to the task it was made for — the whole retry history hangs on it. */
export const DISPATCH_TASK_ID = 'dispatch_contexts.task_id';

/**
 * **What it takes to know who the agents were** — the cast, and everything that hangs off it.
 *
 * An orchestrator is `tasks.created_by_terminal_handle`; *its agents* are the `assignee_handle`s
 * of its dispatch contexts, and there is nowhere else in this schema that anybody records who did
 * the work. Both columns, or none: `assignee_handle` with no `task_id` names a worker that cannot
 * be tied to a task, so it can be neither counted nor drawn nor dimmed to — and `task_id` with no
 * `assignee_handle` ties an attempt to a task and to nobody.
 *
 * Losing it is not losing a badge. It is losing the pivot of the whole screen (SPEC §4.3a).
 */
export const CAST_COLUMNS = [DISPATCH_TASK_ID, 'dispatch_contexts.assignee_handle'] as const;

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
    // The orchestrator *is* this column (SPEC §4.3). Without it there is no coordinator to list, no
    // conversation to have a direction, and no cast — every task in the file lands in the one
    // synthetic Unattributed row, and the rail says so rather than showing an empty list.
    anyOf: ['tasks.created_by_terminal_handle'],
    degraded:
      'Orchestrators — this Orca has no created_by_terminal_handle column, so no task says which terminal coordinated it: every task lands in Unattributed, and there is nobody for the conversation to call the orchestrator.',
  },
  {
    anyOf: ['dispatch_contexts.last_heartbeat_at'],
    degraded: 'The "last seen" badge — this Orca has no last_heartbeat_at column, so agent liveness is not shown.',
  },
  {
    // The message log is ordered by `sequence` and resumed from it. A log with no order is not a
    // log, so this column is the one the whole read rests on — the message *rows* can all be there
    // and they still cannot be put in order. It costs the agents' half of the conversation (SPEC
    // §4.7): the orchestrator's prompts and the final reports are columns and survive, so what is
    // left is an orchestrator dispatching into a silence.
    anyOf: [MESSAGE_SEQUENCE],
    degraded:
      'What the agents said back — this Orca has no messages.sequence column, so there is no cursor to order the message log by or resume it from, and the conversation is left with only the orchestrator speaking.',
  },
  {
    anyOf: [MESSAGE_SEQUENCE],
    degraded:
      'Message history-loss detection — this Orca has no messages.sequence column, so a history wiped by `orchestration reset` cannot be spotted.',
  },
  {
    // The other history-loss signal (#50, SPEC §5.1), degrading whole for the same reason the
    // gates do: with one requirement unverifiable, "the graph is empty and messages still point
    // into it" is a claim this build cannot check — and a suppressed signal explained here is
    // honest where a guessed one would not be. The sentence is the spec's, verbatim.
    allOf: TASK_GRAPH_EVIDENCE_COLUMNS,
    degraded:
      'Task graph history-loss detection — this Orca is missing message payloads or a graph-table identity, so the visualizer cannot safely recognize the empty-graph shape left by a tasks-only reset.',
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
    anyOf: [MESSAGE_PAYLOAD],
    degraded:
      'Gate options, and the task a gate blocks — this Orca has no messages.payload column, so a gate shows the question in its subject line and marks no node.',
  },
  {
    // The same missing column, a different feature. `payload.taskId` is the only link a message has
    // to a task, so without it a message can be placed in an orchestrator's conversation (by its
    // handles) but never in a *task's* — which is what the node inspector's exchange is, and what
    // the gate entry above does not say. A user reading a half-empty panel is owed both reasons.
    anyOf: [MESSAGE_PAYLOAD],
    degraded:
      "The agents' half of a task's exchange — this Orca has no messages.payload column, so nothing says which task a message referenced: the node inspector shows the prompt and the result, and none of the replies in between.",
  },
  {
    // The task's own two body columns. Each costs exactly its own section of the inspector: an
    // Orca with no `result` still has a spec to show, and vice versa.
    anyOf: ['tasks.spec'],
    degraded:
      'The dispatched spec — this Orca has no tasks.spec column, so the inspector cannot show the prompt an agent was given.',
  },
  {
    anyOf: ['tasks.result'],
    degraded:
      'The result receipt — this Orca has no tasks.result column, so the inspector cannot show what a worker reported back.',
  },
  {
    // The same column as the entry above, and a different feature (#67) — the pattern
    // `MESSAGE_PAYLOAD` sets. Losing it costs the inspector the result body; it *also* costs
    // the recognized facts that body would have carried, and only the facts read from this
    // column: the worker's own completion payloads still summarize. An ordinary result the
    // readers do not recognize is NOT this — unknown shapes render verbatim and degrade
    // nothing (SPEC §12.4).
    anyOf: ['tasks.result'],
    degraded:
      'Outcome receipts from task results — this Orca has no tasks.result column, so no files, branches, tickets or links can be recognized in what a task reported back; receipts from worker completion messages are unaffected.',
  },
  {
    // The other evidence source an outcome has (#67). `type` finds the worker_done rows and
    // `payload` is what they handed back — parts, not alternatives, so `allOf`.
    allOf: COMPLETION_COLUMNS,
    degraded:
      'Outcome receipts from worker completions — this Orca is missing messages.type or messages.payload, so what a worker handed back with worker_done cannot be found or read: the inspector shows no completion payloads, and receipts come from task results alone.',
  },
  {
    // Everything a dispatch row is *for* hangs on this one column: with no `task_id`, no attempt
    // can be tied to a task, so the assignee badge, the retry count and the inspector's attempt
    // history all go at once. They go together because they are all the same read.
    anyOf: [DISPATCH_TASK_ID],
    degraded:
      'Dispatch attempts — this Orca has no dispatch_contexts.task_id column, so no attempt can be tied to the task it was made for: no assignee badge, no retry count, and no attempt history.',
  },
  {
    // The pivot of the whole screen, and so the entry this list most needed. An orchestrator with
    // no cast is the old rail back again: a row named after a task, with the two characters the
    // reader is actually following — who coordinated, and who did the work — nowhere on it.
    allOf: CAST_COLUMNS,
    degraded:
      "The cast — this Orca is missing dispatch_contexts.task_id or assignee_handle, so an orchestrator's agents cannot be named: the rail lists no agents, nodes wear no agent stripe, and the conversation cannot say who was being spoken to.",
  },
  {
    // The same column as the inspector's spec entry above, and a *different* feature — the pattern
    // `MESSAGE_PAYLOAD` already sets. Losing it costs the inspector one section; it costs the
    // conversation an entire speaker. A reader looking at a panel where only the agents ever talk
    // is owed the reason, and it is not the reason the inspector's entry gives.
    anyOf: ['tasks.spec'],
    degraded:
      "The orchestrator's side of the conversation — this Orca has no tasks.spec column, and a dispatch writes no message at all (Orca injects the prompt into the worker's PTY), so nothing anywhere records what an agent was told to do: the conversation becomes agents answering a question nobody asked.",
  },
  {
    // The six-hour rule, made visible. With no instant to measure the silence between two tasks
    // there is no gap to caption — the orchestrator still lists, still draws and still talks; it
    // simply does so as one undivided burst of work.
    anyOf: ['tasks.created_at'],
    degraded:
      'Waves — this Orca has no tasks.created_at column, so the idle gaps that separate one burst of an orchestrator’s work from the next cannot be measured, and every task is drawn in a single wave.',
  },
  {
    // The durations (#66), clock by clock. The dispatch clock closes on `completed_at`; without
    // it no attempt can say when it finished, and the honest observation is none. The tasks that
    // *do* retain a completion fall back to the labelled task span — the sentence says so, because
    // a user watching every duration change wording at once is owed the mechanism.
    anyOf: ['dispatch_contexts.completed_at'],
    degraded:
      'Dispatch durations — this Orca has no dispatch_contexts.completed_at column, so no attempt can say when it finished: attempts show no duration, and a completed task falls back to its created → completed task span.',
  },
  {
    // The same clock, the other endpoint. `dispatched_at` falls back to the row's `created_at`
    // (`toDispatch` — the row is written when the attempt is made), so only losing *both* leaves
    // an attempt's clock with no start.
    anyOf: ['dispatch_contexts.dispatched_at', 'dispatch_contexts.created_at'],
    degraded:
      'Dispatch durations — this Orca records no instant an attempt was dispatched at (neither dispatch_contexts.dispatched_at nor created_at), so an attempt’s clock has no start: attempts show no duration, and a completed task falls back to its task span.',
  },
  {
    // The fallback clock. Both endpoints or neither: a span with one end is not a lesser span,
    // it is no interval at all.
    allOf: ['tasks.created_at', 'tasks.completed_at'],
    degraded:
      'Task spans — this Orca is missing tasks.created_at or tasks.completed_at, so a completed task whose dispatch clock never closed shows no duration at all.',
  },
  {
    // The run's wall-clock span opens on the earliest readable task creation; with no creation
    // instants anywhere there is nothing to open it on. The same column costs the waves, and
    // each loss gets its own sentence — they are different absences on screen.
    anyOf: ['tasks.created_at'],
    degraded:
      'Run spans — this Orca has no tasks.created_at column, so how long a run occupied the clock cannot be measured.',
  },
  {
    // The span's *end* reads the completions too. Without them it still measures — creation to
    // latest creation — but it understates any run whose last work outlived its last task's
    // birth. A feature that quietly weakens is the same failure as one that quietly vanishes:
    // the user reading a shortened span is owed the reason (SPEC §5).
    anyOf: ['tasks.completed_at'],
    degraded:
      'Run span ends — this Orca has no tasks.completed_at column, so a finished run’s span can end only on its latest task creation, and understates any run whose work outlived it.',
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
