import { shortHandle } from '../shared/handles.ts';
import { STALE_HEARTBEAT_MS } from '../shared/run-health.ts';
import { type Gate, isTerminalStatus, type Run, type StreamEvent, type Task, type Turn } from '../shared/types.ts';
import { relativeTime } from './relative-time.ts';
import { workerEvidenceByAgent } from './worker-health.ts';

/**
 * **The attention queue's one derivation** (#56, the roadmap's §12): does anything, in any
 * orchestration, need intervention *now* — ranked, explained, and stable from one snapshot to
 * the next.
 *
 * It is pure over the latest snapshot and a wall-clock instant, and consumes the three evidence
 * contracts it is built on rather than re-deriving any of them: a gate demands attention exactly
 * when #45's `blocking` flag says work is provably paused; a worker exactly when #47's health
 * calls its current attempt stale; and nothing here second-guesses #48's run facts. The roadmap
 * reserves a third input — bounded session state — for the tickets that genuinely accumulate
 * any (#58's ticker, #60's notification baseline); every #56 cause is backed by durable rows the
 * snapshot already carries, so this signature takes none.
 *
 * **Identity is the contract.** An item's `id` is built from the durable row identities behind
 * its evidence — a gate id, a run + assignee handle, a task + attempt id, a message sequence —
 * never from array positions or the clock. Re-reading the same cause therefore *cannot* duplicate
 * it, and a consumer that diffs successive queues (#60's "notify once when a cause first
 * enters") gets that promise for free.
 *
 * **The ranking is deterministic** (roadmap §12): blocking gates oldest first, then stale or
 * never-heartbeating workers by longest silence, then current attempts with `failureCount >= 2`
 * by highest count, then unresolved escalations oldest first, then fresh failures newest first —
 * and whatever still ties breaks on the stable id. Distinct causes for one task coexist: a task
 * that is gated, silent *and* retry-risky is three facts, and a task-level merge would hide two
 * of them.
 */

/**
 * How long a failure stays *fresh* — the queue's only time-boxed cause.
 *
 * The same canonical ten-minute recency constant that turns a worker stale (#47) and a run
 * silent (SPEC §12.3), because all three are the one question "is this evidence recent?" and a
 * second window would be a second answer to it. Everything else in the queue follows its
 * evidence instead of a clock: a blocking gate leaves when it stops blocking, a worker when it
 * beats or settles, an escalation when its task ends or is retried.
 */
export const ATTENTION_FRESHNESS_MS = STALE_HEARTBEAT_MS;

export type AttentionKind = 'blocking-gate' | 'stale-worker' | 'retry-risk' | 'escalation' | 'fresh-failure';

type AttentionBase = {
  /** Stable across snapshots — built from the durable row identities behind the evidence. */
  id: string;
  /** Where intervening starts. Null only when the schema attributed the evidence to no run. */
  runId: string | null;
  /**
   * The run's own label, verbatim from the snapshot — a cross-run queue has to say *whose*
   * cause each row is, and the server already named every orchestration (SPEC §4.3). Reused,
   * never re-derived, like every run fact here (#48).
   */
  runLabel: string | null;
  /** The task to open, when the evidence names one that still exists. */
  taskId: string | null;
  /**
   * The evidence instant the item is ranked by within its tier: the wire's own string wherever
   * one column carries the evidence, and a normalized ISO instant for the one tier whose
   * evidence is the newest of several columns (a fresh failure, §`freshFailures`).
   */
  at: string;
  /** What needs attention: the question, the worker, or the task's title. */
  title: string;
  /** Why it is in the queue, measured against the wall clock it was derived at. */
  explanation: string;
};

export type AttentionItem = AttentionBase &
  (
    | { kind: 'blocking-gate' }
    | { kind: 'stale-worker'; handle: string; heartbeat: 'received' | 'missing'; silenceMs: number }
    | { kind: 'retry-risk'; failureCount: number }
    | { kind: 'escalation' }
    | { kind: 'fresh-failure' }
  );

type Snapshot = StreamEvent['snapshot'];

/** The five tiers, in the approved precedence, each ranked internally — one concatenation. */
export function deriveAttention(snapshot: Snapshot, now: number): AttentionItem[] {
  const tasksById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const labels = new Map(snapshot.runs.map((run) => [run.id, run.label]));
  const labelOf = (runId: string | null): string | null => (runId === null ? null : (labels.get(runId) ?? null));

  return [
    ...blockingGates(snapshot.gates, labelOf, now),
    ...staleWorkers(snapshot.runs, snapshot.tasks, now),
    ...retryRisks(snapshot.tasks, labelOf),
    ...escalations(snapshot.turns, tasksById, labelOf, now),
    ...freshFailures(snapshot.tasks, labelOf, now),
  ];
}

/** Resolves a run id to the label the server gave that run — null when it names no run we hold. */
type LabelOf = (runId: string | null) => string | null;

/**
 * Where Orca's circuit breaker trips (HANDOFF.md): the third failure of an attempt strands the
 * task. So the *second* is the moment intervening is still cheap — which is what makes
 * `failureCount >= RETRY_RISK_FAILURES` the tier's threshold and not an arbitrary two.
 *
 * Named because it is Orca's number, not this tool's: if Orca ever moves its breaker, the copy
 * on screen ("the breaker trips at 3") and the threshold that admits the item have to move
 * together, and they can only do that from one place.
 */
const CIRCUIT_BREAKER_TRIPS_AT = 3;
const RETRY_RISK_FAILURES = CIRCUIT_BREAKER_TRIPS_AT - 1;

/**
 * Oldest-first ordering on wire instants, unreadable ones last, ids breaking ties — the
 * queue-wide tie rule in one place. An unreadable instant is not the epoch: it cannot claim to
 * be the oldest blocker, so it queues behind everything that can prove its age.
 */
function byOldestThenId(a: { at: string; id: string }, b: { at: string; id: string }): number {
  const atA = Date.parse(a.at);
  const atB = Date.parse(b.at);
  if (Number.isNaN(atA) !== Number.isNaN(atB)) return Number.isNaN(atA) ? 1 : -1;
  if (!Number.isNaN(atA) && atA !== atB) return atA - atB;
  return byId(a, b);
}

/** The last word on every tie: the stable id, ascending, in every tier alike. */
function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** "3m ago", or nothing to measure with — the queue never says "NaN ago". */
function age(at: string, now: number): number | null {
  const instant = Date.parse(at);
  return Number.isNaN(instant) ? null : Math.max(0, now - instant);
}

/**
 * Tier 1 — questions provably pausing work, oldest first. `blocking` is the whole criterion:
 * #45 already folded "a pending row blocks" and "an unanswered ask blocks only while its task
 * is blocked" into that one flag, and unanswered, resolved, timed-out and superseded questions
 * arrive with it false (SPEC §4.5).
 */
function blockingGates(gates: Gate[], labelOf: LabelOf, now: number): AttentionItem[] {
  return gates
    .filter((gate) => gate.blocking)
    .map((gate): AttentionItem => {
      const waited = age(gate.createdAt, now);
      return {
        kind: 'blocking-gate',
        id: `gate:${gate.id}`,
        runId: gate.runId,
        runLabel: labelOf(gate.runId),
        taskId: gate.taskId,
        at: gate.createdAt,
        title: gate.question,
        explanation: waited === null ? 'blocking — no readable ask instant' : `asked ${relativeTime(waited)} ago — blocking`,
      };
    })
    .sort(byOldestThenId);
}

/**
 * Tier 2 — workers whose current attempt has gone quiet past the canonical threshold, longest
 * silence first. The judgement is #47's, verbatim: per task through `taskWorkerHealth`, then the
 * freshest active evidence speaks for the worker — the same rule that colours its cast row, so
 * the queue and the rail cannot disagree about who is silent. What #47's aggregate deliberately
 * drops — *which task* held the deciding evidence — is kept here, because an attention item's
 * one click has to land somewhere.
 */
function staleWorkers(runs: Run[], tasks: Task[], now: number): AttentionItem[] {
  const items: Extract<AttentionItem, { kind: 'stale-worker' }>[] = [];

  for (const run of runs) {
    const runTasks = tasks.filter((task) => task.runId === run.id);

    // #47's rule, *called* rather than reproduced: which attempt speaks for a worker is one
    // question with one answer, and a second implementation of it here is how the queue and the
    // cast row would come to disagree about who has gone quiet.
    for (const [handle, evidence] of workerEvidenceByAgent(runTasks, now)) {
      const { health, task } = evidence;
      if (health.state !== 'stale' || task === null) continue;

      // The row is named for the **task**, not the worker: clicking it lands on that task, and a
      // row headed `A2` would tell a supervisor who went quiet while hiding what they went quiet
      // *on*. The agent is named in the explanation, where the cast's own monogram identifies it
      // (SPEC §4.3a) — falling back to the handle when the worker is not in this run's cast.
      const agent = run.cast.find((member) => member.handle === handle)?.monogram ?? shortHandle(handle);
      const silence =
        health.heartbeat === 'received'
          ? `last seen ${relativeTime(health.elapsedMs)} ago`
          : `dispatched ${relativeTime(health.elapsedMs)} ago · no heartbeat`;

      items.push({
        kind: 'stale-worker',
        id: `worker:${run.id}:${handle}`,
        runId: run.id,
        runLabel: run.label,
        taskId: task.id,
        at: health.evidenceAt,
        title: task.title,
        explanation: `${agent} · ${silence}`,
        handle,
        heartbeat: health.heartbeat,
        silenceMs: health.elapsedMs,
      });
    }
  }

  return items.sort((a, b) => (a.silenceMs !== b.silenceMs ? b.silenceMs - a.silenceMs : byId(a, b)));
}

/**
 * Tier 3 — unfinished tasks whose current attempt has failed twice or more, highest count
 * first. Two is the number one short of Orca's circuit breaker (HANDOFF.md): the next failure
 * strands the task, which makes *now* the moment intervening is cheap. The item follows the
 * attempt — its id names the dispatch context, so a fresh retry attempt is a fresh cause — and
 * leaves with the evidence: a terminal task carries no risk of a *next* failure.
 */
function retryRisks(tasks: Task[], labelOf: LabelOf): AttentionItem[] {
  return tasks
    .filter(
      (task) =>
        !isTerminalStatus(task.status) && task.dispatch !== null && task.dispatch.failureCount >= RETRY_RISK_FAILURES
    )
    .map((task): Extract<AttentionItem, { kind: 'retry-risk' }> => {
      const dispatch = task.dispatch!;
      return {
        kind: 'retry-risk',
        id: `retry:${task.id}:${dispatch.id}`,
        runId: task.runId,
        runLabel: labelOf(task.runId),
        taskId: task.id,
        at: dispatch.lastFailure ?? dispatch.dispatchedAt,
        title: task.title,
        explanation:
          dispatch.status === 'circuit_broken'
            ? `circuit broken after ${dispatch.failureCount} failures`
            : `${dispatch.failureCount} failures — the breaker trips at ${CIRCUIT_BREAKER_TRIPS_AT}`,
        failureCount: dispatch.failureCount,
      };
    })
    .sort((a, b) => (a.failureCount !== b.failureCount ? b.failureCount - a.failureCount : byId(a, b)));
}

/**
 * Tier 4 — requests for help nobody has acted on, oldest first, **with no freshness window**:
 * the node pulse that announced an escalation lasts a second, and #56 exists so the request
 * cannot vanish with it. It leaves on evidence of being handled — its task reaching a terminal
 * state, or a *later* dispatch attempt beginning (a retry is the coordinator acting on it) —
 * and an orphaned message whose task the snapshot no longer holds demands nothing: there is no
 * current work to intervene on (roadmap §12).
 *
 * Supersession must be *provable*: both instants have to parse before a retry is called later
 * than the escalation. Unreadable timestamps keep the item, because dropping a live request for
 * help over a timestamp nobody can read would be the queue's one unforgivable failure.
 */
function escalations(turns: Turn[], tasksById: Map<string, Task>, labelOf: LabelOf, now: number): AttentionItem[] {
  return turns
    .filter((turn) => turn.kind === 'escalation')
    .flatMap((turn): AttentionItem[] => {
      const task = turn.taskId === null ? undefined : tasksById.get(turn.taskId);
      if (!task || isTerminalStatus(task.status)) return [];

      const escalatedAt = Date.parse(turn.at);
      const retriedAt = Date.parse(task.dispatch?.dispatchedAt ?? '');
      if (!Number.isNaN(escalatedAt) && !Number.isNaN(retriedAt) && retriedAt > escalatedAt) return [];

      const waited = age(turn.at, now);
      return [
        {
          kind: 'escalation',
          id: `escalation:${turn.id}`,
          runId: task.runId,
          runLabel: labelOf(task.runId),
          taskId: task.id,
          at: turn.at,
          title: turn.subject,
          explanation: waited === null ? 'escalated — no readable instant' : `escalated ${relativeTime(waited)} ago`,
        },
      ];
    })
    .sort(byOldestThenId);
}

/**
 * Tier 5 — tasks that just failed, newest first, fresh for the shared window and then gone: an
 * old failure is post-mortem material, not an interruption. The instant is the newest readable
 * evidence across the task row and its surviving attempt — `completed_at` when Orca filled it,
 * the attempt's `last_failure`/`completed_at` when it did not — and a failure with no readable
 * instant at all never enters: freshness that cannot be measured cannot be claimed
 * (render-what-parses, SPEC §5).
 */
function freshFailures(tasks: Task[], labelOf: LabelOf, now: number): AttentionItem[] {
  return tasks
    .filter((task) => task.status === 'failed')
    .flatMap((task): AttentionItem[] => {
      const evidence = [task.completedAt, task.dispatch?.lastFailure, task.dispatch?.completedAt]
        .map((at) => (at === null || at === undefined ? NaN : Date.parse(at)))
        .filter((instant) => !Number.isNaN(instant));
      if (evidence.length === 0) return [];

      const failedAt = Math.max(...evidence);
      const elapsed = Math.max(0, now - failedAt);
      if (elapsed >= ATTENTION_FRESHNESS_MS) return [];

      return [
        {
          kind: 'fresh-failure',
          id: `failure:${task.id}`,
          runId: task.runId,
          runLabel: labelOf(task.runId),
          taskId: task.id,
          at: new Date(failedAt).toISOString(),
          title: task.title,
          explanation: `failed ${relativeTime(elapsed)} ago`,
        },
      ];
    })
    .sort((a, b) => {
      // Newest first — the tier's one inversion — with unreadable instants impossible by
      // construction (they never entered) and ties still breaking on the ascending id.
      const delta = Date.parse(b.at) - Date.parse(a.at);
      return delta !== 0 ? delta : byId(a, b);
    });
}
