import { STALE_HEARTBEAT_MS } from '../shared/run-health.ts';
import type { CastMember, DispatchStatus, Task } from '../shared/types.ts';

// The one canonical recency threshold (SPEC §12.3): worker health and run health answer the same
// "is this recent?" question against the same constant, defined once in `shared/run-health.ts`.
export { STALE_HEARTBEAT_MS };

/**
 * The one ink for **a worker that has gone quiet** — the rail row wears it, and so does the kiosk
 * tile (#62). One string, in one place, for the same reason `chip.ts` is one string: two surfaces
 * making the same claim must not be able to make it in two different colours.
 *
 * Amber, and never red: the evidence says *nothing has been recorded for a while*, which is a
 * thing to go and look at, not a verdict that anything died (CONTEXT.md, *Stale Worker*).
 */
export const STALE_WORKER_INK = 'text-amber-700 dark:text-amber-400';

export type WorkerHealth =
  | { state: 'inactive' }
  | { state: 'unknown' }
  | {
      state: 'working' | 'quiet' | 'stale';
      heartbeat: 'received' | 'missing';
      evidenceAt: string;
      elapsedMs: number;
    };

export type WorkerHealthInput = {
  status: DispatchStatus | string;
  dispatchedAt: string;
  lastHeartbeatAt: string | null;
  now: number;
};

export type ActiveWorkerHealth = Extract<WorkerHealth, { state: 'working' | 'quiet' | 'stale' }>;

export function isActiveWorkerHealth(health: WorkerHealth): health is ActiveWorkerHealth {
  return health.state === 'working' || health.state === 'quiet' || health.state === 'stale';
}

/** True while the latest evidence is recent enough to justify working motion. */
export function hasCurrentActivityEvidence(health: WorkerHealth): boolean {
  return health.state === 'working' || health.state === 'quiet';
}

/**
 * The client-side truth about a dispatch's current activity evidence.
 *
 * A heartbeat is stronger evidence than the initial dispatch. Until the first beat arrives, the
 * dispatch instant still lets the UI say how long the worker has been silent without pretending it
 * has ever checked in. Settled attempts are history, not worker-health warnings.
 */
export function workerHealth(input: WorkerHealthInput): WorkerHealth {
  if (input.status !== 'dispatched') return { state: 'inactive' };

  const heartbeat = input.lastHeartbeatAt === null ? 'missing' : 'received';
  const evidenceAt = input.lastHeartbeatAt ?? input.dispatchedAt;
  const evidenceInstant = Date.parse(evidenceAt);
  if (Number.isNaN(evidenceInstant)) return { state: 'unknown' };

  const elapsedMs = Math.max(0, input.now - evidenceInstant);
  if (elapsedMs > STALE_HEARTBEAT_MS) return { state: 'stale', heartbeat, evidenceAt, elapsedMs };

  return {
    state: heartbeat === 'received' ? 'working' : 'quiet',
    heartbeat,
    evidenceAt,
    elapsedMs,
  };
}

/** The current health of a task's latest dispatch attempt. */
export function taskWorkerHealth(task: Task, now: number): WorkerHealth {
  const dispatch = task.dispatch;
  if (!dispatch) return { state: 'inactive' };

  return workerHealth({
    status: dispatch.status,
    dispatchedAt: dispatch.dispatchedAt,
    lastHeartbeatAt: dispatch.lastHeartbeatAt,
    now,
  });
}

/**
 * A worker's current health **and the attempt that decided it**.
 *
 * The health alone is what a cast row wears; *which task* held the deciding evidence is what an
 * attention item needs, because its one click has to land somewhere (#56). Both come out of the
 * same selection, so the queue and the rail cannot end up disagreeing about who has gone quiet.
 */
export type WorkerEvidence = {
  health: WorkerHealth;
  /** The task holding the deciding attempt. Null exactly when no attempt is currently active. */
  task: Task | null;
};

/**
 * The freshest current dispatch evidence among a worker's tasks — **the** rule for "how is this
 * worker doing", in one place.
 *
 * Freshest, not worst: a worker beating on one task is working, whatever an older attempt
 * elsewhere still says. Settled attempts are history and never speak; a worker with only
 * unreadable evidence is `unknown`, which claims nothing.
 */
export function workerEvidenceForTasks(tasks: Task[], now: number): WorkerEvidence {
  const scored = tasks.map((task) => ({ task, health: taskWorkerHealth(task, now) }));

  const active = scored
    .filter((entry): entry is { task: Task; health: ActiveWorkerHealth } => isActiveWorkerHealth(entry.health))
    .sort((left, right) => left.health.elapsedMs - right.health.elapsedMs);

  if (active[0]) return { health: active[0].health, task: active[0].task };
  if (scored.some((entry) => entry.health.state === 'unknown')) return { health: { state: 'unknown' }, task: null };
  return { health: { state: 'inactive' }, task: null };
}

/** The freshest current dispatch evidence among a worker's tasks. */
export function workerHealthForTasks(tasks: Task[], now: number): WorkerHealth {
  return workerEvidenceForTasks(tasks, now).health;
}

/** Current worker evidence keyed by assignee, derived in one pass over a run's tasks. */
export function workerEvidenceByAgent(tasks: Task[], now: number): ReadonlyMap<string, WorkerEvidence> {
  const tasksByAgent = new Map<string, Task[]>();

  for (const task of tasks) {
    const handle = task.dispatch?.assigneeHandle;
    if (!handle) continue;
    const assigned = tasksByAgent.get(handle) ?? [];
    assigned.push(task);
    tasksByAgent.set(handle, assigned);
  }

  return new Map(
    [...tasksByAgent].map(([handle, assigned]) => [handle, workerEvidenceForTasks(assigned, now)] as const)
  );
}

/** Current worker health keyed by assignee — the same evidence, with the deciding task dropped. */
export function workerHealthByAgent(tasks: Task[], now: number): ReadonlyMap<string, WorkerHealth> {
  return new Map(
    [...workerEvidenceByAgent(tasks, now)].map(([handle, evidence]) => [handle, evidence.health] as const)
  );
}

/**
 * **How a whole orchestration's workers are currently doing** — the worst state among them, and
 * the tally behind it.
 *
 * *Worst*, and here the inversion is deliberate: a single worker speaks with its **freshest**
 * evidence (`workerEvidenceForTasks` — a worker beating on one task is working, whatever an older
 * attempt still says), but a *run* speaks with its **worst**, because one silent agent in a cast
 * of five is the fact a supervisor is scanning for and an average would bury it. The two rules
 * are opposite on purpose, and they are the same two rules the rail has always applied.
 *
 * It is `null` exactly when the cast has **no current dispatch attempt at all** — a run whose work
 * has all settled has no *current* worker health, and inventing one for it would be the tile
 * claiming evidence the database does not hold. Callers say that in their own words: the rail row
 * draws nothing, the kiosk tile says so out loud (#62). An attempt that *is* current but whose
 * instants will not parse is `unknown`, and never `null`: those are two different facts.
 *
 * Shared because it is the one sentence both screens make about a run's workers, and two copies
 * of it would eventually disagree — which is exactly the drift #62's tests exist to forbid.
 */
export type RunWorkerSummary = {
  /**
   * The worst current state in the cast: `stale` over `quiet` over `working` — and `unknown`
   * when the only current attempts carry instants nothing can parse, which is a different fact
   * from having no attempt at all and must never be reported as one (SPEC §5).
   */
  state: 'working' | 'quiet' | 'stale' | 'unknown';
  /** The tally behind it, worst first: `['1 stale without heartbeat', '2 active']`. */
  parts: string[];
};

export function runWorkerSummary(
  cast: CastMember[],
  healthByAgent: ReadonlyMap<string, WorkerHealth>
): RunWorkerSummary | null {
  const crew = cast.map((member) => healthByAgent.get(member.handle) ?? { state: 'inactive' as const });
  const active = crew.filter(isActiveWorkerHealth);

  if (active.length === 0) {
    // A worker whose attempt is dispatched but whose evidence instant will not parse is not a
    // worker who is *absent*. Reporting "nothing is running" over an unreadable timestamp would
    // be inventing the one fact the column failed to record — render what parses, and say plainly
    // when a thing did not (SPEC §5). Only a cast with no current attempt at all is `null`.
    const unknown = crew.filter((worker) => worker.state === 'unknown').length;
    if (unknown === 0) return null;

    return { state: 'unknown', parts: [`${unknown} with no readable dispatch evidence`] };
  }

  // A worker that never sent a beat is counted apart from one that sent some and stopped: both
  // are stale, and only the second has ever proved it could talk. The distinction is #47's, and
  // it is the difference between "it went quiet" and "it never said anything".
  const staleWithoutHeartbeat = active.filter(
    (health) => health.state === 'stale' && health.heartbeat === 'missing'
  ).length;
  const stale = active.filter((health) => health.state === 'stale' && health.heartbeat === 'received').length;
  const quiet = active.filter((health) => health.state === 'quiet').length;
  const working = active.filter((health) => health.state === 'working').length;

  return {
    state: staleWithoutHeartbeat + stale > 0 ? 'stale' : quiet > 0 ? 'quiet' : 'working',
    parts: [
      staleWithoutHeartbeat > 0 && `${staleWithoutHeartbeat} stale without heartbeat`,
      stale > 0 && `${stale} stale`,
      quiet > 0 && `${quiet} awaiting heartbeat`,
      working > 0 && `${working} active`,
    ].filter((part): part is string => part !== false),
  };
}
