import { mergeReceipts, receiptOfWorkerDone } from '../shared/receipt.ts';
import type {
  CastMember,
  Dispatch,
  DurationObservation,
  FeedMessage,
  ReceiptFact,
  Run,
  Scorecard,
} from '../shared/types.ts';
import { RECEIPT_PREVIEW_FACTS } from './conversation.ts';
import { closed, earliest, latest, open } from './durations.ts';
import type { TaskWithHandle } from './runs.ts';
import type { Columns } from './rows.ts';
import {
  COMPLETION_RECEIPT_COLUMNS,
  FAILURE_COUNT,
  FIRST_HEARTBEAT_COLUMNS,
  hasColumn,
  RESULT_RECEIPT_COLUMN,
  SCOREBOARD_COUNT_COLUMNS,
} from './schema.ts';

/**
 * **The scoreboard: the cast, quantified** (#68, SPEC §14.4).
 *
 * The cast said *who* an orchestrator's agents were (`cast.ts`); this says what each of them
 * cost and produced, from the two kinds of evidence the schema retains about an agent — its
 * dispatch attempts, and the messages attributed to it. Nothing here is a new reading of the
 * database: the attempts are the ones the cast was cast from, the messages are the ones the
 * conversation was built from, placed by the same attribution (`attribution.ts`), the clocks are
 * `durations.ts`'s, and the receipts are #67's readers. A scoreboard derived from its own
 * private queries would be a second truth that could disagree with every panel beside it.
 *
 * It is attached in a **second pass**, the way the gates are (`gates.ts`): the cast is cast
 * while the runs are inferred, but the metrics need attributed messages, and attribution needs
 * the runs — so the scores can only land once the snapshot has read the message log.
 *
 * The honesty rules, each of which the wire shape enforces (`Scorecard`):
 *
 * - **Absence is the honest value, and it is not the same as zero.** A span whose endpoints
 *   cannot carry it, a first heartbeat that was never retained, a count whose *column* this Orca
 *   does not have — each is absent, and the client renders it unknown. A `0` that survives to
 *   the wire really counted zero rows. The two are told apart *here*, because the client cannot:
 *   a missing column and an agent that did nothing look identical by the time they are numbers.
 * - **An ambiguous message counts nowhere.** Attribution answers null when two runs match
 *   (SPEC §4.4 rule 3), and a null `runId` is in no run's scoreboard — a metric quietly fed by
 *   a guess would be a lie with a number on it.
 * - **No composite, no winner.** The module computes facts one at a time and never an
 *   aggregate over them: the agents were dispatched different work (SPEC §14.6).
 */

export type ScoreboardEvidence = {
  /** Every task, carrying its run id, its attempts and its recognized result receipt. */
  entries: TaskWithHandle[];
  /** The whole message log, already attributed (`messages.ts`). */
  messages: FeedMessage[];
  /** The columns this database really has — what decides a zero from an unknowable. */
  columns: Columns;
};

/** What an agent's clocks start at: the earliest readable dispatch across all of its attempts. */
function firstDispatch(attempts: readonly Pick<Dispatch, 'dispatchedAt'>[]): string | null {
  return earliest(attempts.map((attempt) => attempt.dispatchedAt));
}

/**
 * The agent's wall-clock span: **first dispatch → latest retained completion**, across every
 * attempt it ever held (SPEC §14.4). Open — the client ages it as "so far" — while any of its
 * attempts is still in flight; absent when the endpoints cannot carry it. It is occupancy of
 * the calendar, not summed task time: two attempts running in parallel are one interval.
 *
 * `closed`/`open` are `durations.ts`'s, so a backwards or unreadable endpoint means here exactly
 * what it means to every other clock in the tool — no observation at all (#66).
 */
export function agentSpan(
  attempts: readonly Pick<Dispatch, 'status' | 'dispatchedAt' | 'completedAt'>[]
): DurationObservation | undefined {
  const startAt = firstDispatch(attempts);
  if (startAt === null) return undefined;

  // Work still out there keeps the whole span open, whatever the finished attempts say: the
  // agent's occupancy of the clock has not ended.
  if (attempts.some((attempt) => attempt.completedAt === null && attempt.status === 'dispatched')) {
    return open('agent-span', startAt);
  }

  // No retained completion, and nothing in flight: the work stopped and the rows do not say
  // when. "So far" would claim work still running; any end picked here would be invented.
  const endAt = latest(attempts.map((attempt) => attempt.completedAt));
  return endAt === null ? undefined : closed('agent-span', startAt, endAt);
}

/**
 * **Time to first heartbeat**, measured from the first dispatch (SPEC §14.4) — how long the
 * orchestrator waited before its agent first showed life. Closed by construction: it exists
 * only when a heartbeat was retained and both instants read, and **no retained heartbeat is
 * unknown, never zero** — an agent that never beat did not respond instantly.
 *
 * A beat from *before* the dispatch is two clocks in contradiction, not a response time, and
 * `closed` refuses it for the same reason it refuses every backwards interval.
 */
export function timeToFirstHeartbeat(
  attempts: readonly Pick<Dispatch, 'dispatchedAt'>[],
  beats: readonly string[]
): DurationObservation | undefined {
  const startAt = firstDispatch(attempts);
  const endAt = earliest(beats);
  if (startAt === null || endAt === null) return undefined;

  return closed('first-heartbeat', startAt, endAt);
}

/**
 * The failure total: the **maximum** cumulative `failure_count` per task, summed across the
 * tasks — never summed across retry rows. The column is cumulative on a task's attempts (the
 * breaker trips at 3), so a task whose rows read 2 then 3 failed three times, and adding the
 * rows would count the first two failures twice (SPEC §14.4).
 */
export function failureTotal(heldTasks: readonly (readonly Pick<Dispatch, 'failureCount'>[])[]): number {
  let total = 0;
  for (const attempts of heldTasks) {
    let worst = 0;
    for (const attempt of attempts) if (attempt.failureCount > worst) worst = attempt.failureCount;
    total += worst;
  }
  return total;
}

/**
 * Attach a scorecard to every cast member of every run — the snapshot's second pass, after
 * the message log has been read and attributed.
 */
export function attachScoreboards(runs: Run[], { entries, messages, columns }: ScoreboardEvidence): Run[] {
  const entriesOfRun = groupBy(entries, (entry) => entry.task.runId);
  const messagesOfRun = groupBy(
    messages.filter((message) => message.runId !== null),
    (message) => message.runId!
  );

  // What this database can actually answer, asked once rather than per cast member. Each flag
  // is the difference between a zero and an unknown, and the user is told about every one of
  // them by name in `meta.degraded` (`schema.ts`).
  const can: Capabilities = {
    counts: SCOREBOARD_COUNT_COLUMNS.every((column) => hasColumn(columns, column)),
    firstHeartbeat: FIRST_HEARTBEAT_COLUMNS.every((column) => hasColumn(columns, column)),
    failures: hasColumn(columns, FAILURE_COUNT),
    // Either source is enough to recognize a link. Neither is what makes the links *unknown*
    // rather than none — the one distinction an empty list could never carry.
    resultReceipts: hasColumn(columns, RESULT_RECEIPT_COLUMN),
    completionReceipts: COMPLETION_RECEIPT_COLUMNS.every((column) => hasColumn(columns, column)),
  };

  return runs.map((run) => {
    if (run.cast.length === 0) return run;

    const runEntries = entriesOfRun.get(run.id) ?? [];
    const runMessages = messagesOfRun.get(run.id) ?? [];

    return {
      ...run,
      cast: run.cast.map((member): CastMember => {
        const score = scorecardOf(member, runEntries, runMessages, can);
        // A database that can answer nothing about an agent gets no scorecard at all, rather
        // than an empty object that says "measured, and here is nothing" (SPEC §6.3).
        return Object.keys(score).length === 0 ? member : { ...member, score };
      }),
    };
  });
}

type Capabilities = {
  counts: boolean;
  firstHeartbeat: boolean;
  failures: boolean;
  resultReceipts: boolean;
  completionReceipts: boolean;
};

function scorecardOf(
  member: CastMember,
  entries: TaskWithHandle[],
  messages: FeedMessage[],
  can: Capabilities
): Scorecard {
  // The member's attempts, kept per task: the failure rule is per-task, and the receipts of a
  // task belong to the agent of its *surviving* attempt.
  const held = entries
    .map((entry) => ({
      entry,
      attempts: entry.attempts.filter((attempt) => attempt.assigneeHandle === member.handle),
    }))
    .filter(({ attempts }) => attempts.length > 0);
  const attempts = held.flatMap(({ attempts: own }) => own);

  const sent = messages.filter((message) => message.fromHandle === member.handle);
  const beats = sent.filter((message) => message.type === 'heartbeat');

  const score: Scorecard = {};

  const span = agentSpan(attempts);
  if (span !== undefined) score.span = span;

  if (can.counts) {
    score.heartbeats = beats.length;
    score.messages = sent.length - beats.length;
    score.escalations = sent.filter((message) => message.type === 'escalation').length;
  }

  if (can.firstHeartbeat) {
    const firstBeat = timeToFirstHeartbeat(
      attempts,
      beats.map((beat) => beat.createdAt)
    );
    if (firstBeat !== undefined) score.firstHeartbeat = firstBeat;
  }

  if (can.failures) score.failures = failureTotal(held.map(({ attempts: own }) => own));

  // Absent — unknown — only when *neither* evidence source can be read. One readable source is
  // a partial reading, and `meta.degraded` names which half went missing.
  if (can.resultReceipts || can.completionReceipts) {
    const links = outcomeLinks(member, held, sent, can);
    score.outcomeLinks = links.slice(0, RECEIPT_PREVIEW_FACTS);
    if (links.length > RECEIPT_PREVIEW_FACTS) score.outcomeLinksOmitted = links.length - RECEIPT_PREVIEW_FACTS;
  }

  return score;
}

/**
 * The agent's recognized outcome URLs, deduplicated across both evidence sources by the same
 * merge the inspector uses (#67): the worker_done payloads this agent sent, and the results of
 * tasks whose **surviving** attempt was this agent's — `tasks.result` is written at completion,
 * so the agent of the last attempt is the one the retained evidence credits, and handing the
 * receipt to a replaced predecessor would credit work the file says somebody else finished.
 */
function outcomeLinks(
  member: CastMember,
  held: { entry: TaskWithHandle; attempts: Dispatch[] }[],
  sent: FeedMessage[],
  can: Capabilities
): string[] {
  const readings: ReceiptFact[][] = [];

  if (can.resultReceipts) {
    for (const { entry } of held) {
      const surviving = entry.attempts[entry.attempts.length - 1];
      if (surviving?.assigneeHandle === member.handle) readings.push(entry.resultReceipt);
    }
  }

  if (can.completionReceipts) {
    for (const message of sent) {
      if (message.type === 'worker_done') readings.push(receiptOfWorkerDone(message.payload));
    }
  }

  return mergeReceipts(...readings)
    .filter((fact) => fact.kind === 'link')
    .map((fact) => fact.value);
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
