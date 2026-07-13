import { STALE_HEARTBEAT_MS } from '../shared/run-health.ts';
import type { DispatchStatus, Task } from '../shared/types.ts';

// The one canonical recency threshold (SPEC §12.3): worker health and run health answer the same
// "is this recent?" question against the same constant, defined once in `shared/run-health.ts`.
export { STALE_HEARTBEAT_MS };

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
