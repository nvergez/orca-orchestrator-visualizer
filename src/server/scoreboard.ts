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
import type { TaskWithHandle } from './runs.ts';
import type { Columns } from './rows.ts';
import { hasColumn, MESSAGE_SEQUENCE, MESSAGE_TYPE } from './schema.ts';
import { instantOf } from './time.ts';

/**
 * **The scoreboard: the cast, quantified** (#68, SPEC §12.4).
 *
 * The cast said *who* an orchestrator's agents were (`cast.ts`); this says what each of them
 * cost and produced, from the two kinds of evidence the schema retains about an agent — its
 * dispatch attempts, and the messages attributed to it. Nothing here is a new reading of the
 * database: the attempts are the ones the cast was cast from, the messages are the ones the
 * conversation was built from, placed by the same attribution (`attribution.ts`), and the
 * receipts are #67's readers verbatim. A scoreboard derived from its own private queries would
 * be a second truth that could disagree with every panel beside it.
 *
 * It is attached in a **second pass**, the way the gates are (`gates.ts`): the cast is cast
 * while the runs are inferred, but the metrics need attributed messages, and attribution needs
 * the runs — so the scores can only land once the snapshot has read the message log.
 *
 * The honesty rules, each of which the wire shape enforces (`Scorecard`):
 *
 * - **Absence is the honest value.** A span whose endpoints cannot carry it, a first heartbeat
 *   that was never retained, a count whose column this Orca does not have — each is *absent*,
 *   never zero, never the epoch (SPEC §12.4). A zero that survives really counts zero rows.
 * - **An ambiguous message counts nowhere.** Attribution answers null when two runs match
 *   (SPEC §4.4 rule 3), and a null `runId` is in no run's scoreboard — a metric quietly fed by
 *   a guess would be a lie with a number on it.
 * - **No composite, no winner.** The module computes facts one at a time and never an
 *   aggregate over them: the agents were dispatched different work (SPEC §12.6).
 */

/** The failure column is degradation-guarded: its 0 default is indistinguishable from absence. */
const FAILURE_COUNT = 'dispatch_contexts.failure_count';

/**
 * What the per-message metrics need before a zero is a real zero: `sequence` for the log to be
 * readable at all, `type` to tell a heartbeat from everything else, `from_handle` to tie a row
 * to the cast member who sent it. Missing any of them, every count would read 0 — not "none
 * retained" but "none readable", and the scoreboard must not conflate the two.
 */
const MESSAGE_COUNT_COLUMNS = [MESSAGE_SEQUENCE, MESSAGE_TYPE, 'messages.from_handle'] as const;

/** …and placing a heartbeat *in time* additionally needs the instant it was written. */
export const FIRST_HEARTBEAT_COLUMNS = [...MESSAGE_COUNT_COLUMNS, 'messages.created_at'] as const;

export type ScoreboardEvidence = {
  /** Every task, carrying its run id, its attempts and its recognized result receipt. */
  entries: TaskWithHandle[];
  /** The whole message log, already attributed (`messages.ts`). */
  messages: FeedMessage[];
  /** The columns this database really has — what decides a zero from an unknowable. */
  columns: Columns;
};

/**
 * The earliest readable dispatch instant across an agent's attempts — where its clock starts.
 * Null when no attempt retains one: a span or a heartbeat time with no start measures nothing.
 */
function firstDispatch(attempts: readonly Pick<Dispatch, 'dispatchedAt'>[]): string | null {
  let earliest: { at: number; iso: string } | null = null;

  for (const attempt of attempts) {
    const at = instantOf(attempt.dispatchedAt);
    if (at !== null && (earliest === null || at < earliest.at)) earliest = { at, iso: attempt.dispatchedAt };
  }

  return earliest?.iso ?? null;
}

/**
 * The agent's wall-clock span: **first dispatch → latest retained completion**, across every
 * attempt it ever held (SPEC §12.4). Open — the client ages it as "so far" — while any of its
 * attempts is still in flight; absent when the endpoints cannot carry it. It is occupancy of
 * the calendar, not summed task time: two attempts running in parallel are one interval.
 */
export function agentSpan(
  attempts: readonly Pick<Dispatch, 'status' | 'dispatchedAt' | 'completedAt'>[]
): DurationObservation | undefined {
  const startAt = firstDispatch(attempts);
  if (startAt === null) return undefined;
  const start = instantOf(startAt)!;

  // Work still out there keeps the whole span open, whatever the finished attempts say:
  // the agent's occupancy of the clock has not ended.
  if (attempts.some((attempt) => attempt.completedAt === null && attempt.status === 'dispatched')) {
    return { clock: 'agent-span', startAt, complete: false };
  }

  let end: { at: number; iso: string } | null = null;
  for (const attempt of attempts) {
    if (attempt.completedAt === null) continue;
    const at = instantOf(attempt.completedAt);
    if (at !== null && (end === null || at > end.at)) end = { at, iso: attempt.completedAt };
  }

  // No retained completion, and nothing in flight: the work stopped and the rows do not say
  // when. "So far" would claim work still running; any end picked here would be invented.
  // A completion before the first dispatch is a contradiction, and a contradiction is not a
  // duration anybody experienced (#66's rule, held here too).
  if (end === null || end.at < start) return undefined;

  return { clock: 'agent-span', startAt, endAt: end.iso, complete: true, ms: end.at - start };
}

/**
 * **Time to first heartbeat**, measured from the first dispatch (SPEC §12.4) — how long the
 * orchestrator waited before its agent first showed life. Closed by construction: it exists
 * only when a heartbeat was retained and both instants read, and **no retained heartbeat is
 * unknown, never zero** — an agent that never beat did not respond instantly.
 */
export function timeToFirstHeartbeat(
  attempts: readonly Pick<Dispatch, 'dispatchedAt'>[],
  beats: readonly string[]
): DurationObservation | undefined {
  const startAt = firstDispatch(attempts);
  if (startAt === null) return undefined;
  const start = instantOf(startAt)!;

  let earliest: { at: number; iso: string } | null = null;
  for (const beat of beats) {
    const at = instantOf(beat);
    if (at !== null && (earliest === null || at < earliest.at)) earliest = { at, iso: beat };
  }

  // No readable beat — or one from *before* the dispatch, which is two clocks contradicting
  // each other, not a response time.
  if (earliest === null || earliest.at < start) return undefined;

  return { clock: 'first-heartbeat', startAt, endAt: earliest.iso, complete: true, ms: earliest.at - start };
}

/**
 * The failure total: the **maximum** cumulative `failure_count` per task, summed across the
 * tasks — never summed across retry rows. The column is cumulative on a task's attempts (the
 * breaker trips at 3), so a task whose rows read 2 then 3 failed three times, and adding the
 * rows would count the first two failures twice (SPEC §12.4).
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

  const canCountMessages = MESSAGE_COUNT_COLUMNS.every((column) => hasColumn(columns, column));
  const canCountFailures = hasColumn(columns, FAILURE_COUNT);

  return runs.map((run) => {
    if (run.cast.length === 0) return run;

    const runEntries = entriesOfRun.get(run.id) ?? [];
    const runMessages = messagesOfRun.get(run.id) ?? [];

    return {
      ...run,
      cast: run.cast.map(
        (member): CastMember => ({
          ...member,
          score: scorecardOf(member, runEntries, runMessages, { canCountMessages, canCountFailures }),
        })
      ),
    };
  });
}

type Capabilities = { canCountMessages: boolean; canCountFailures: boolean };

function scorecardOf(
  member: CastMember,
  entries: TaskWithHandle[],
  messages: FeedMessage[],
  { canCountMessages, canCountFailures }: Capabilities
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

  if (canCountMessages) {
    score.heartbeats = beats.length;
    score.messages = sent.length - beats.length;
    score.escalations = sent.filter((message) => message.type === 'escalation').length;

    const firstBeat = timeToFirstHeartbeat(
      attempts,
      beats.map((beat) => beat.createdAt)
    );
    if (firstBeat !== undefined) score.firstHeartbeat = firstBeat;
  }

  if (canCountFailures) score.failures = failureTotal(held.map(({ attempts: own }) => own));

  const links = outcomeLinks(member, held, sent);
  if (links.length > 0) score.outcomeLinks = links;

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
  sent: FeedMessage[]
): string[] {
  const readings: ReceiptFact[][] = [];

  for (const { entry } of held) {
    const surviving = entry.attempts[entry.attempts.length - 1];
    if (surviving?.assigneeHandle === member.handle) readings.push(entry.resultReceipt);
  }

  for (const message of sent) {
    if (message.type === 'worker_done') readings.push(receiptOfWorkerDone(message.payload));
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
