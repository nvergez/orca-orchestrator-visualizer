import { runHealth } from '../../shared/run-health.ts';
import type { Gate, Run, StreamEvent } from '../../shared/types.ts';
import { blockingGates } from '../attention.ts';
import { elapsedSince } from '../relative-time.ts';
import { type RunWorkerSummary, runWorkerSummary, workerHealthByAgent } from '../worker-health.ts';

/**
 * **What the wall is for** (#62): the orchestrations that have *not finished*, and the two things
 * about each one a supervisor ten feet away has to be able to read — is anything still moving in
 * it, and is anything stopping it.
 *
 * It is a **selection and a ranking, and it invents no facts.** Every claim a tile makes was
 * already made somewhere on the main screen, by the same function:
 *
 * - **unfinished** is `runHealth(run, now) !== 'finished'` (#48) — the rail's own dot, filtered.
 *   Convergence wins over the clock, so a run that ended an hour ago is off the wall however
 *   busy it was, and a run that is still open is on it however quiet it has gone.
 * - **worst worker health** is `runWorkerSummary` (#47) — the same sentence the rail row wears,
 *   worst-first across the cast, so a wall and a rail cannot come to different conclusions about
 *   the same crew.
 * - **blocking** is `Gate.blocking` (#45), and nothing else. Not "pending", not "unanswered", not
 *   "old" — the one flag that means *durable state proves this work is paused* (SPEC §4.5).
 *
 * **The tiles are ranked, and the ranking is not the queue's.** They rank *orchestrations*; the
 * attention queue standing beside them ranks *causes* (#56), and the two are different questions
 * with different right answers. Here it is silence first — the runs nothing is proving are moving,
 * longest silence at the top — and then the active ones, freshest first. A silent run is not a
 * dead one and this never says it is; it is simply the one a supervisor has to go and look at,
 * because it is the one the evidence has stopped talking about.
 */

/** The oldest question provably pausing a run (#45) — and how long it has been waiting. */
export type BlockingGateAge = {
  question: string;
  /** The wire's own ask instant, verbatim. */
  at: string;
  /** The task it names, when it names one that still exists. */
  taskId: string | null;
  /**
   * How long it has blocked, in ms — **null when the ask instant does not parse**. The gate still
   * blocks (that is a flag, not a timestamp); what cannot be measured is how long it has, and a
   * tile that printed "NaN ago" would be inventing the one number worth acting on (SPEC §5).
   */
  waitedMs: number | null;
};

export type KioskTile = {
  run: Run;
  /** #48's health, narrowed to the two states a tile can be: `finished` never reaches here. */
  health: 'active' | 'silent';
  /**
   * How long the evidence has been quiet, in ms — null when `lastActivityAt` does not parse.
   * It is what the silent tiles are ranked by, and what the silent ones say out loud.
   */
  silenceMs: number | null;
  /** The worst current worker health in the cast — null when no attempt is currently running. */
  workers: RunWorkerSummary | null;
  /** The oldest blocking gate, or null when nothing is provably pausing this run. */
  gate: BlockingGateAge | null;
};

type Snapshot = StreamEvent['snapshot'];

export function unfinishedRuns(snapshot: Snapshot, now: number): KioskTile[] {
  // Ranked once, for the whole wall: the queue's own oldest-first list of every question provably
  // pausing work (#45/#56). Each tile takes the first one that names its run.
  const blocking = blockingGates(snapshot.gates);

  return snapshot.runs
    .flatMap((run): KioskTile[] => {
      const health = runHealth(run, now);
      if (health === 'finished') return [];

      const tasks = snapshot.tasks.filter((task) => task.runId === run.id);

      return [
        {
          run,
          health,
          silenceMs: elapsedSince(run.lastActivityAt, now),
          workers: runWorkerSummary(run.cast, workerHealthByAgent(tasks, now)),
          gate: oldestBlockingGate(blocking, run.id, now),
        },
      ];
    })
    .sort(bySilenceThenFreshness);
}

/**
 * Tier 1 the silent, tier 2 the active. Inside the silent tier the longest silence leads, and
 * inside the active tier the freshest evidence does — because in the first the question is "what
 * has stopped talking to me", and in the second it is "what is happening right now".
 *
 * A run whose `lastActivityAt` does not parse is silent (an unfinished run with no *readable*
 * evidence has no *recent* evidence) but it can never lead the tier: it cannot prove how long it
 * has been quiet, and the top of a wall belongs to the silence that can. It is the attention
 * queue's rule for an unreadable instant, held to here so the two surfaces agree. Ties break on
 * the run id, so a wall does not reshuffle itself on a tick that changed nothing.
 */
function bySilenceThenFreshness(a: KioskTile, b: KioskTile): number {
  if (a.health !== b.health) return a.health === 'silent' ? -1 : 1;

  if (a.silenceMs !== b.silenceMs) {
    if (a.silenceMs === null) return 1;
    if (b.silenceMs === null) return -1;
    return a.health === 'silent' ? b.silenceMs - a.silenceMs : a.silenceMs - b.silenceMs;
  }

  return a.run.id < b.run.id ? -1 : a.run.id > b.run.id ? 1 : 0;
}

/**
 * The oldest gate this run is provably paused on — and it is the attention queue's own list, taken
 * off the front (`blockingGates`, #56/#45).
 *
 * Not a second `.filter(blocking).sort(oldest)` — that is the one thing this file must not contain.
 * The queue already ranks every blocking question in the database oldest-first, with an unreadable
 * ask instant queued behind everything that can prove its age; the first one that belongs to this
 * run is, by construction, the oldest question stopping it. So the tile and the queue standing
 * beside it cannot name different questions, and cannot disagree about which came first.
 */
function oldestBlockingGate(ranked: Gate[], runId: string, now: number): BlockingGateAge | null {
  const oldest = ranked.find((gate) => gate.runId === runId);
  if (!oldest) return null;

  return {
    question: oldest.question,
    at: oldest.createdAt,
    taskId: oldest.taskId,
    waitedMs: elapsedSince(oldest.createdAt, now),
  };
}
