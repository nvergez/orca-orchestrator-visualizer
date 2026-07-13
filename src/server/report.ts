import {
  type DurationObservation,
  REPORT_PRESENCE,
  REPORT_SORTS,
  type ReportDirection,
  type ReportPage,
  type ReportPresence,
  type ReportRow,
  type ReportSort,
  type Run,
  type Task,
} from '../shared/types.ts';
import type { RunEvidence } from './history.ts';
import { instantOf } from './time.ts';

/**
 * **The cross-history dispatch report** (#70, SPEC §14.4) — one row per retained task, across
 * every orchestrator run in the database, sorted and filtered and paged *here*, on the server.
 *
 * The tool can already draw one run and tell one task's story. What it could not do was answer
 * the questions that are about *history* rather than about a run: which task took longest, who
 * is carrying the failures, what did last Tuesday actually produce, and — the one a rail can
 * never answer — **what was never dispatched at all**. Those are a search, not a graph, and the
 * whole design follows from refusing to draw a second graph to answer them (SPEC §14.6).
 *
 * Three things this module is careful about, and each is a way it could have lied:
 *
 * 1. **A row derives nothing of its own.** The duration is the task's `DurationObservation`
 *    (#66), the outcome is the receipt readers' reading of the same two columns the inspector
 *    shows (#67), the attempts and the status are the task's. A report that re-derived any of
 *    them would be a second truth about a task, and the two would drift on exactly the odd row
 *    a post-mortem came for.
 * 2. **Missing is a value, not a gap.** A never-dispatched task has no agent and no dispatch
 *    instant, and it is *in* the report with `attemptCount: 0` saying so — and `dispatch=missing`
 *    is how you ask for exactly those. Unknown never sorts as zero: it sorts **last**, in both
 *    directions, because "no observation" is not "the shortest".
 * 3. **The order is total.** Every comparison ends in an ascending task-id tie-break, so the
 *    sort has no ties left to resolve — which is what makes a keyset cursor honest: two reads of
 *    an unchanged database tile into the same pages, no row in two of them, no row in neither.
 *
 * Pure — evidence in, rows out, no SQLite and no Node — for the reason `history.ts` is: the
 * canned client suite imports these same functions to answer its stub loader, so what a test
 * sees cannot drift from what the endpoint serves (`test/client/canned.tsx`).
 */

/** The first page is the newest 50 rows. Older pages are explicit, behind the cursor. */
export const REPORT_PAGE_SIZE = 50;

/**
 * How many recognized facts a row carries. A row is a row: three chips is what fits beside a
 * title, and the count of what was cut rides with them (`outcomeOmitted`) so the cap is never
 * silent. The whole receipt is one click away, in the inspector — which is where the report is
 * an entry point *to*, and the reason it is allowed to be compact here.
 */
export const REPORT_OUTCOME_FACTS = 3;

/** A named refusal the HTTP edge turns into a 400 rather than a 500 — or a silently wrong page. */
export class ReportQueryError extends Error {}

/**
 * What one request asks for. Everything is optional on the wire and defaulted here, and the
 * default is the useful one: the most recently dispatched work, first.
 */
export type ReportQuery = {
  cursor: string | null;
  sort: ReportSort;
  dir: ReportDirection;
  /**
   * Empty ⇒ every run. Several ⇒ any of them: a repeated key in a query string is a list, and
   * reading only the first of them would be the silent ignore this module refuses everywhere else.
   */
  runIds: string[];
  /** Raw status strings — an Orca status this build never heard of is filterable under its own name. */
  statuses: string[];
  /** Cast-member handles. A row matches on the handle of its **latest** attempt, which is the one it shows. */
  castHandles: string[];
  /**
   * **A readable dispatch time, present or missing** — and `missing` is the stalled-work filter,
   * the question a rail of runs cannot be asked.
   *
   * It reads the *instant*, not the attempt count, so it catches all three ways a task can fail to
   * have a dispatch time: nothing ever dispatched it (`attemptCount: 0`), its attempt recorded no
   * instant, or the instant it recorded is not one a clock can read (`time.ts` passes an
   * unparseable timestamp through verbatim rather than dropping the row — SPEC §5). All three are
   * "no dispatch time you can rank or range on", which is what this filter is named after, and it
   * is the same readability the sort and the time range read. The *row* still shows what the
   * column held, and says which of the three it is.
   */
  dispatch: ReportPresence;
  /**
   * **A named agent, present or missing.** Missing is a task no terminal is on record as holding:
   * never dispatched, or dispatched by a `dispatch_contexts` row that named nobody. The cast
   * refuses to name an empty handle (`cast.ts`), so there is no handle to filter it by — and a
   * value that renders as missing has to be *findable* as missing (SPEC §14.4).
   */
  agent: ReportPresence;
  /** `missing` ⇒ nothing recognized in either evidence column (#67) — not "produced nothing". */
  outcome: ReportPresence;
  /**
   * The time range, **on the dispatch clock**, inclusive. A row with no readable dispatch instant
   * cannot be shown to be inside a range, so a range excludes it — it stays reachable, and only
   * reachable, through `dispatch=missing`. Naming the clock is the whole honesty of the filter:
   * "between Tuesday and Thursday" is a different question asked of `dispatched_at` than of
   * `tasks.created_at`, and the report answers the one it says it answers.
   */
  from: string | null;
  to: string | null;
};

export const DEFAULT_QUERY: ReportQuery = {
  cursor: null,
  sort: 'dispatched',
  dir: 'desc',
  runIds: [],
  statuses: [],
  castHandles: [],
  dispatch: 'any',
  agent: 'any',
  outcome: 'any',
  from: null,
  to: null,
};

/** Every key this endpoint reads. A key that is not one of these is a typo, and it is refused. */
const QUERY_KEYS = ['cursor', 'sort', 'dir', 'run', 'status', 'cast', 'dispatch', 'agent', 'outcome', 'from', 'to'];

/**
 * Read a query off the URL, and **refuse what it cannot honour** (SPEC §3, the
 * flag-that-does-not-work rule). An unknown sort key answered with the default sort would show
 * the user a different slice of history than the one they asked for, and nothing on screen would
 * say so — so it is a 400, with the key it did not recognize in it.
 *
 * An unknown *key* is refused for exactly the same reason a bad *value* is: `?runId=run_x` is a
 * typo for `?run=run_x`, and the whole unfiltered report answered under it looks like a report
 * with a filter on. A query string this endpoint half-understands is one it must not answer.
 *
 * `URLSearchParams` and nothing Node-only, so the client can build the same query it will be
 * answered on.
 */
export function parseReportQuery(params: URLSearchParams): ReportQuery {
  for (const key of params.keys()) {
    if (!QUERY_KEYS.includes(key)) {
      throw new ReportQueryError(
        `Not a filter this report knows: ${JSON.stringify(key)}. It reads: ${QUERY_KEYS.join(', ')}.`
      );
    }
  }

  const from = instant(params.get('from'), 'from');
  const to = instant(params.get('to'), 'to');

  // A backwards range matches nothing, and it is far likelier to be a mistake than a question.
  if (from !== null && to !== null && instantOf(from)! > instantOf(to)!) {
    throw new ReportQueryError(`The range ends before it starts: from=${from} is after to=${to}.`);
  }

  return {
    cursor: params.get('cursor'),
    sort: oneOf(params.get('sort'), REPORT_SORTS, DEFAULT_QUERY.sort, 'sort'),
    dir: oneOf(params.get('dir'), ['asc', 'desc'] as const, DEFAULT_QUERY.dir, 'dir'),
    runIds: params.getAll('run'),
    statuses: params.getAll('status'),
    castHandles: params.getAll('cast'),
    dispatch: oneOf(params.get('dispatch'), REPORT_PRESENCE, DEFAULT_QUERY.dispatch, 'dispatch'),
    agent: oneOf(params.get('agent'), REPORT_PRESENCE, DEFAULT_QUERY.agent, 'agent'),
    outcome: oneOf(params.get('outcome'), REPORT_PRESENCE, DEFAULT_QUERY.outcome, 'outcome'),
    from,
    to,
  };
}

function oneOf<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
  name: string
): T {
  if (value === null || value === '') return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new ReportQueryError(`Not a ${name} this report knows: ${JSON.stringify(value)}. Try one of: ${allowed.join(', ')}.`);
}

/** A range endpoint has to be an instant, or the range it bounds means nothing. */
function instant(value: string | null, name: string): string | null {
  if (value === null || value === '') return null;
  if (instantOf(value) === null) {
    throw new ReportQueryError(`Not a readable instant: ${name}=${JSON.stringify(value)}. Use an ISO-8601 date or timestamp.`);
  }
  return value;
}

/**
 * The report, end to end: every retained task becomes a row, the filters keep the ones asked
 * for, the total order sorts them, and the cursor cuts one page out of the result.
 *
 * `total` counts the *filtered* rows, not the page — it is the "1–50 of 214" a reader needs to
 * know whether the thing they are looking for is even in what they filtered to.
 */
export function buildReport(evidence: RunEvidence, query: ReportQuery): Omit<ReportPage, 'meta'> {
  const rows = reportRows(evidence).filter((row) => matches(row, query));

  rows.sort(comparator(query.sort, query.dir));

  const after = query.cursor === null ? null : decodeCursor(query.cursor, query);
  // Strictly after the cursor's *position*, by keys rather than by finding the row it was cut
  // from: that row may have changed under the reader — a duration completing is exactly the
  // kind of write that moves one — and the page boundary belongs where the reader last saw it,
  // not wherever the row went.
  const rest = after === null ? rows : rows.filter((row) => comparePositions(after, positionOf(row, query.sort), query.dir) < 0);
  const page = rest.slice(0, REPORT_PAGE_SIZE);

  return {
    rows: page,
    // Only said when it is true: a null cursor means the filtered history ends here.
    nextCursor:
      rest.length > REPORT_PAGE_SIZE ? encodeCursor(positionOf(page[page.length - 1]!, query.sort), query) : null,
    total: rows.length,
  };
}

/**
 * One row per retained task — **every** task, in creation order, before any filter has run.
 *
 * The row is a projection, never a derivation: everything on it is already on the wire
 * somewhere else, and the report's job is to put it in one line and let a reader rank it.
 */
export function reportRows(evidence: RunEvidence): ReportRow[] {
  const runsById = new Map(evidence.runs.map((run) => [run.id, run]));

  return evidence.tasks.map((task) => rowOf(task, runsById.get(task.runId), evidence));
}

function rowOf(task: Task, run: Run | undefined, evidence: RunEvidence): ReportRow {
  const attempts = evidence.attemptsByTask.get(task.id) ?? [];
  const latest = task.dispatch;

  const row: ReportRow = {
    taskId: task.id,
    runId: task.runId,
    // A run the index has no summary for cannot happen — every task went into a bucket and every
    // bucket became a run (`runs.ts`) — but a label is not worth a crash if the invariant ever
    // moves, and the run id is a true thing to fall back to.
    runLabel: run?.label ?? task.runId,
    title: task.title,
    status: task.status,
    // Null all the way down when nothing ever dispatched this task — the explicit missing value.
    agent: latest === null || latest.assigneeHandle === '' ? null : agentOf(latest.assigneeHandle, run),
    dispatchedAt: latest === null || latest.dispatchedAt === '' ? null : latest.dispatchedAt,
    attemptCount: task.attemptCount,
    // The maximum, never the sum: `failure_count` is cumulative, so adding it across a task's
    // attempts counts the first failure again for every retry that followed it (SPEC §14.4).
    failureCount: attempts.reduce((most, attempt) => Math.max(most, attempt.failureCount), 0),
  };

  if (task.duration !== undefined) row.duration = task.duration;

  const receipt = evidence.receiptsByTask.get(task.id) ?? [];
  if (receipt.length > 0) {
    row.outcome = receipt.slice(0, REPORT_OUTCOME_FACTS);
    if (receipt.length > REPORT_OUTCOME_FACTS) row.outcomeOmitted = receipt.length - REPORT_OUTCOME_FACTS;
  }

  return row;
}

/**
 * The handle, and what the canvas calls it. A handle the run's cast does not hold belongs to the
 * orchestrator working its own task (SPEC §4.3a): it wears no monogram, because it is not one of
 * the agents that were spawned — and a made-up one would put a stranger in the cast.
 */
function agentOf(handle: string, run: Run | undefined): { handle: string; monogram: string | null } {
  const member = run?.cast.find((cast) => cast.handle === handle);
  return { handle, monogram: member?.monogram ?? null };
}

/** Every filter, ANDed; within one filter, several values are alternatives. */
function matches(row: ReportRow, query: ReportQuery): boolean {
  if (query.runIds.length > 0 && !query.runIds.includes(row.runId)) return false;
  if (query.statuses.length > 0 && !query.statuses.includes(row.status)) return false;
  if (query.castHandles.length > 0 && (row.agent === null || !query.castHandles.includes(row.agent.handle))) {
    return false;
  }

  // Each presence filter reads the **column it is named after**, so that every value the report
  // renders as missing is a value it can be *asked* for (SPEC §14.4). "Present" for a dispatch
  // time means *readable*: it is the same reading the sort and the time range make, so a row this
  // filter calls present is exactly a row those two can place. Never dispatched, no instant
  // recorded, and an instant nothing can parse all land together — and the row is where they are
  // told apart, because it shows what the column actually held.
  if (!present(query.dispatch, instantOf(row.dispatchedAt) !== null)) return false;
  if (!present(query.agent, row.agent !== null)) return false;
  if (!present(query.outcome, row.outcome !== undefined)) return false;

  if (query.from !== null || query.to !== null) {
    const at = instantOf(row.dispatchedAt);
    // Unknown is not inside a range and not outside it — it is unknown, and a range cannot claim
    // it. `dispatch=missing` is where those rows are asked for by name.
    if (at === null) return false;
    if (query.from !== null && at < instantOf(query.from)!) return false;
    if (query.to !== null && at > instantOf(query.to)!) return false;
  }

  return true;
}

function present(filter: ReportPresence, has: boolean): boolean {
  return filter === 'any' || (filter === 'present') === has;
}

/**
 * A row's position in the total order: the sort key, and the id that breaks every tie.
 *
 * `key: null` is **unknown**, and it is the whole reason this is a type and not a number. A task
 * with no duration observation has not run for zero milliseconds; a task never dispatched was not
 * dispatched at the epoch. Unknown sorts last, in both directions (`comparePositions`), so it
 * neither crowds the top of a descending sort nor pretends to be the smallest of an ascending one.
 */
type Position = { key: string | number | null; id: string };

function positionOf(row: ReportRow, sort: ReportSort): Position {
  return { key: keyOf(row, sort), id: row.taskId };
}

function keyOf(row: ReportRow, sort: ReportSort): string | number | null {
  switch (sort) {
    case 'dispatched':
      return instantOf(row.dispatchedAt);
    case 'duration':
      return lengthOf(row.duration);
    case 'attempts':
      return row.attemptCount;
    case 'failures':
      return row.failureCount;
    case 'title':
      return row.title;
  }
}

/**
 * How long a *finished* interval ran — the only kind that has a length to rank.
 *
 * An **open** interval has none: "3h so far" on a task still running would sort above a finished
 * 2h one and mean nothing by it, so it ranks as unknown and sorts last, where the absences go.
 *
 * `ms` is optional on the wire and must agree with the endpoints it rides with (`types.ts`), so
 * the endpoints are the fallback and never a second opinion — the same reading the client's
 * `readDuration` makes of the same object, because two readings of one observation is one more
 * than this tool is allowed.
 */
function lengthOf(duration: DurationObservation | undefined): number | null {
  if (duration === undefined || !duration.complete) return null;
  if (duration.ms !== undefined) return duration.ms;

  const start = instantOf(duration.startAt);
  const end = instantOf(duration.endAt ?? null);
  return start === null || end === null ? null : end - start;
}

function comparator(sort: ReportSort, dir: ReportDirection): (a: ReportRow, b: ReportRow) => number {
  return (a, b) => comparePositions(positionOf(a, sort), positionOf(b, sort), dir);
}

/**
 * The total order, and the only place it is written down — the sort, the cursor and the page
 * boundary all read it, so they cannot disagree about where a row goes.
 *
 * The id tie-break is **always ascending**, whatever the direction: it is not part of what the
 * reader asked to rank by, it is what makes the ranking a total order. Reversing it with the
 * sort would reshuffle equal rows on a direction flip for no reason a reader could name — and,
 * worse, it is compared by code point rather than by locale, because a page boundary must not
 * move with the server's `LANG`.
 */
function comparePositions(a: Position, b: Position, dir: ReportDirection): number {
  if (a.key !== b.key) {
    // Unknown last, in both directions: it is an absence, not an extreme.
    if (a.key === null) return 1;
    if (b.key === null) return -1;

    const order = a.key < b.key ? -1 : 1;
    return dir === 'desc' ? -order : order;
  }

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The cursor is opaque on the wire and boring underneath: the ordering position it was cut
 * after, plus **the sort it was cut under**. Carrying the sort is what lets a page that changed
 * ranking mid-walk be *refused* rather than answered with rows from a different order — a
 * keyset position means nothing at all in an order it was not measured in.
 */
function encodeCursor(position: Position, query: ReportQuery): string {
  return JSON.stringify({ sort: query.sort, dir: query.dir, key: position.key, id: position.id });
}

function decodeCursor(cursor: string, query: ReportQuery): Position {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cursor) as Record<string, unknown>;
  } catch {
    throw new ReportQueryError(`Not a report cursor: ${JSON.stringify(cursor)}. Follow the nextCursor a previous page returned.`);
  }

  const { sort, dir, key, id } = parsed;
  const readable =
    typeof id === 'string' && (typeof key === 'string' || typeof key === 'number' || key === null);

  if (!readable) {
    throw new ReportQueryError(`Not a report cursor: ${JSON.stringify(cursor)}. Follow the nextCursor a previous page returned.`);
  }

  if (sort !== query.sort || dir !== query.dir) {
    throw new ReportQueryError(
      `This cursor was cut under sort=${String(sort)}&dir=${String(dir)}, and the request asks for ` +
        `sort=${query.sort}&dir=${query.dir}. A keyset position means nothing in an order it was not measured in — ` +
        `start the new sort from its first page.`
    );
  }

  return { key, id };
}

