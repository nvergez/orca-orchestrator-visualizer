import type { FeedMessage, RunSnapshot, SchemaSupport } from './types.ts';

/**
 * **The run archive** (`CONTEXT.md`, ADR 0001, SPEC §12.4, #74) — the file, and the one reader
 * that decides whether a file is one.
 *
 * A run archive is a *versioned, self-contained, one-shot export of exactly one selected
 * orchestrator run's retained evidence at the moment the user asks for it*. It is written by an
 * explicit click (`GET /api/run/:id/archive`), and it is read back by `orca-viz --archive <file>`,
 * which serves an **archived replay**: the ordinary selected-run screen, with no database behind
 * it, nothing polling, and no claim that anything is still running.
 *
 * Four rules make it the thing ADR 0001 approved rather than the shadow event store it forbids:
 *
 * - **One run, and only what the database already held.** The selected-run snapshot, the two
 *   bodies of each of its tasks, every dispatch attempt, and the raw messages **attributed to
 *   that run** at export time. Nothing is watched, recorded, or captured afterwards: an archive
 *   is a photograph, and a photograph of one thing.
 * - **Never the machine.** No other run's conversation, no unattributed or global message, no
 *   `orchestration.db`, and — deliberately — **no live database path**. A path is where this
 *   file *came from* on somebody's laptop; it is not what it *is*, and an archive that carried
 *   one would be handing that around with the evidence.
 * - **Raw evidence beside the reading of it, never inside it.** `messages` is the rows as they
 *   were written — payload and all; `bodies` is `tasks.spec` / `tasks.result` in full. `turns`
 *   is this tool's *interpretation* of them (the four-source merge, SPEC §4.7), and it is stored
 *   next to the raw rows rather than in place of them, so a future orca-viz that reads a receipt
 *   better than this one can still do so from the evidence rather than from our summary of it.
 * - **Versioned, and honest about what it cannot read.** `readArchive` refuses a file whose
 *   required core it cannot understand — actionably, by name — and reads a *newer* one anyway,
 *   under a compatibility warning, returning the parsed document **verbatim**: fields this build
 *   has never heard of are not stripped, because a reader that quietly deletes what it does not
 *   understand is a reader that lies about what it was given.
 */

/** What every archive says it is. A file that does not say this is not one. */
export const ARCHIVE_FORMAT = 'orca-viz.run-archive';

/** The format this build writes, and the newest one it claims to fully understand. */
export const ARCHIVE_VERSION = 1;

/** `newer` ⇒ written by a later orca-viz: readable core, visible warning, unknown fields verbatim. */
export type ArchiveCompatibility = 'supported' | 'newer';

/**
 * The database this evidence was read from, **as a shape rather than as a place** (SPEC §12.4).
 *
 * Its schema version, how that compared with the build that exported it, and the features a
 * missing column had already cost the reader — so a replay can say "there are no attempt
 * histories here because the database had no `dispatch_contexts.task_id`" instead of showing an
 * absence and letting it read as a bug. What is *not* here is the file path: see the module note.
 */
export type ArchiveSource = {
  schemaVersion: number;
  schemaSupport: SchemaSupport;
  /** `meta.degraded` at export time — the features the source database could not serve. */
  degraded: string[];
};

/** Where this file came from, what wrote it, and when — everything except a machine's path. */
export type ArchiveProvenance = {
  format: typeof ARCHIVE_FORMAT;
  /** `ARCHIVE_VERSION` at export time. A newer one degrades under a warning; it never crashes. */
  version: number;
  /** The instant the user clicked export. ISO. */
  exportedAt: string;
  /** `orca-viz 0.5.0` — the build that derived this evidence. */
  tool: string;
  source: ArchiveSource;
  /** One sentence, for a reader who opens the JSON: what this is, and what it is not. */
  derivation: string;
};

/** The two body columns, in full — what `GET /api/task/:id` serves live (SPEC §6.3). */
export type TaskBodies = { spec: string | null; result: string | null };

/**
 * The artifact. It is the selected-run snapshot (`RunSnapshot` minus `meta`, which is a *live*
 * database's header and has no meaning here) plus the three things a replay cannot go and fetch:
 * the bodies, and the raw message rows, and the provenance that says what it is.
 */
export type RunArchive = Omit<RunSnapshot, 'meta'> & {
  provenance: ArchiveProvenance;
  /** `tasks.spec` and `tasks.result` in full, by task id — this run's tasks only. */
  bodies: Record<string, TaskBodies>;
  /**
   * **The raw rows**, as retained, for the messages attributed to this run at export time
   * (SPEC §4.4) — payloads included, verbatim. Never a global message, never another run's.
   */
  messages: FeedMessage[];
};

/**
 * A file this build cannot read, said in words a person can act on — the actionable failure of
 * #74's last acceptance criterion. It carries a `hint` for the same reason `StartupError` does:
 * *what went wrong* and *what to do about it* are two sentences, and a user is owed both.
 */
export class ArchiveError extends Error {
  override readonly name = 'ArchiveError';

  /** The line under the message: what to try next. */
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }

  override toString(): string {
    return this.hint === undefined ? this.message : `${this.message} ${this.hint}`;
  }
}

/** A readable archive, and how much of it this build claims to understand. */
export type ArchiveRead = {
  /** The parsed document **exactly as it was written** — unknown fields and all. */
  archive: RunArchive;
  compatibility: ArchiveCompatibility;
};

/**
 * Read a parsed JSON value as a run archive — or refuse it, by name.
 *
 * The rule the acceptance criteria draw, and the whole of what this function is:
 *
 * - **A required core that will not read is a hard, actionable failure.** Not a blank screen, not
 *   a half-drawn canvas: a sentence naming what is missing. The core is what the ordinary
 *   selected-run presentation dereferences without asking — the run, its tasks, and the shapes
 *   the collections come in.
 * - **Everything else renders verbatim, whatever version wrote it.** A newer archive is *read*,
 *   under `compatibility: 'newer'`, and returned untouched — the fields this build has never
 *   heard of are still in the object it hands back, and the raw receipts (`bodies`, `messages`)
 *   are exactly the ones the exporter wrote.
 */
export function readArchive(value: unknown): ArchiveRead {
  const document = object(value);
  if (document === null) {
    throw new ArchiveError(
      'This file is not an orca-viz run archive: its top level is not a JSON object.',
      'An archive is the file the “Export archive” button saves from an orchestrator in the rail.'
    );
  }

  const provenance = object(document.provenance);
  if (provenance === null || provenance.format !== ARCHIVE_FORMAT) {
    throw new ArchiveError(
      `This file is not an orca-viz run archive: it does not declare provenance.format "${ARCHIVE_FORMAT}".`,
      'An archive is the file the “Export archive” button saves from an orchestrator in the rail.'
    );
  }

  const version = provenance.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ArchiveError(
      `This archive declares no readable format version (provenance.version is ${JSON.stringify(version)}).`,
      `orca-viz writes and reads archive format v${ARCHIVE_VERSION}.`
    );
  }

  const problems = coreProblems(document);
  if (problems.length > 0) {
    throw new ArchiveError(
      `This archive's core cannot be read: ${problems.join('; ')}.`,
      version > ARCHIVE_VERSION
        ? `It was written by a newer orca-viz (archive format v${version}; this build reads v${ARCHIVE_VERSION}), and the parts it changed are not the optional ones. Upgrade orca-viz to open it.`
        : 'The file is truncated or was edited by hand — export the run again.'
    );
  }

  return {
    // Verbatim, deliberately: the document that was written, not a copy of the fields this build
    // happens to know the names of.
    archive: document as unknown as RunArchive,
    compatibility: version > ARCHIVE_VERSION ? 'newer' : 'supported',
  };
}

/**
 * What the ordinary selected-run presentation reads without checking first — and therefore what
 * an archive has to have before a replay of it is worth opening.
 *
 * Every problem, not the first: a user re-exporting from a build that changed two things wants
 * both names in one sentence, and a reader that stopped at the first would send them round the
 * loop twice.
 */
function coreProblems(document: Record<string, unknown>): string[] {
  const problems: string[] = [];

  const run = object(document.run);
  if (run === null) {
    problems.push('it has no run');
  } else {
    const missing = RUN_FIELDS.filter(([field, ok]) => !ok(run[field])).map(([field]) => field);
    if (missing.length > 0) problems.push(`its run is missing ${missing.join(', ')}`);
  }

  for (const [field, ofItem] of COLLECTIONS) {
    const items = document[field];
    if (!Array.isArray(items)) {
      problems.push(`its ${field} is not a list`);
      continue;
    }
    // One complaint per collection, naming the first row that is not one — a truncated file can
    // have a thousand bad rows, and a thousand-clause sentence is not actionable, it is noise.
    const at = items.findIndex((item) => !ofItem(item));
    if (at >= 0) problems.push(`its ${field} holds something that is not a ${SINGULAR[field]} (at position ${at})`);
  }

  for (const field of RECORDS) {
    if (object(document[field]) === null) problems.push(`its ${field} is not an object keyed by task id`);
  }

  return problems;
}

/**
 * The `Run` fields the rail, the canvas and the conversation dereference on sight: a replay that
 * opened without them would not degrade, it would throw inside React and show a white page.
 * Everything else about a run — `handle`, and whatever a later version adds — is optional here
 * and rides along verbatim.
 */
const RUN_FIELDS: [field: string, ok: (value: unknown) => boolean][] = [
  ['id', isString],
  ['label', isString],
  ['startedAt', isString],
  ['endedAt', isString],
  ['taskCount', isNumber],
  ['cast', Array.isArray],
  ['waves', Array.isArray],
  ['statusCounts', (value) => object(value) !== null],
  ['edgeCount', isNumber],
];

/** The evidence lists, and what it takes for a row to be readable as one of them. */
const COLLECTIONS: [field: string, ok: (value: unknown) => boolean][] = [
  ['tasks', isTask],
  ['linkedTasks', isTask],
  ['gates', hasId],
  ['turns', hasId],
  ['coordinatorRuns', hasId],
  ['messages', hasId],
];

const SINGULAR: Record<string, string> = {
  tasks: 'task',
  linkedTasks: 'task',
  gates: 'gate',
  turns: 'turn',
  coordinatorRuns: 'coordinator run',
  messages: 'message',
};

/** Keyed by task id: the attempt histories, and the two bodies. */
const RECORDS = ['attempts', 'bodies'];

/** A task is an id and its edges: the two things the canvas walks before it draws anything. */
function isTask(value: unknown): boolean {
  const task = object(value);
  return task !== null && isString(task.id) && Array.isArray(task.deps) && isString(task.status);
}

/** Everything the client keys a list on. A row with no id is a row React cannot render twice. */
function hasId(value: unknown): boolean {
  const item = object(value);
  return item !== null && isString(item.id);
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isString(value: unknown): boolean {
  return typeof value === 'string';
}

function isNumber(value: unknown): boolean {
  return typeof value === 'number';
}

/**
 * What the browser saves it as — the run and the instant, which are the two things a person needs
 * to tell two archives apart in a downloads folder. Every other character is stripped: a filename
 * is a header the server sends, and a run id is text out of somebody's database.
 */
export function archiveFilename(runId: string, exportedAt: string): string {
  const stamp = exportedAt.replace(/[:.]/g, '-');
  return `orca-viz-${safe(runId)}-${safe(stamp)}.json`;
}

function safe(value: string): string {
  // No dots either: the only `.` in the name is the one this function's caller puts before `json`.
  // `run_../../etc/passwd` is a run id a database is perfectly capable of holding, and this string
  // becomes a `Content-Disposition` filename on somebody's machine.
  return value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'archive';
}

/** The sentence in `provenance.derivation` — what this file is, said to whoever opens the JSON. */
export function derivationSentence(schemaVersion: number): string {
  return (
    `Retained evidence for one orchestrator run, read from Orca's orchestration database ` +
    `(schema v${schemaVersion}) by orca-viz at the instant above and exported once, on request. ` +
    `It holds only what that database already contained: nothing was recorded, watched, or captured afterwards, ` +
    `and no other run, no unattributed message and no database path is in it.`
  );
}

