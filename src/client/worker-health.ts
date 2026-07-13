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

/** The freshest current dispatch evidence among a worker's tasks. */
export function workerHealthForTasks(tasks: Task[], now: number): WorkerHealth {
  const healths = tasks.map((task) => taskWorkerHealth(task, now));
  const activeHealths = healths
    .filter(isActiveWorkerHealth)
    .sort((left, right) => left.elapsedMs - right.elapsedMs);

  if (activeHealths[0]) return activeHealths[0];
  if (healths.some((health) => health.state === 'unknown')) return { state: 'unknown' };
  return { state: 'inactive' };
}

/** Current worker health keyed by assignee, derived in one pass over a run's tasks. */
export function workerHealthByAgent(tasks: Task[], now: number): ReadonlyMap<string, WorkerHealth> {
  const tasksByAgent = new Map<string, Task[]>();

  for (const task of tasks) {
    const handle = task.dispatch?.assigneeHandle;
    if (!handle) continue;
    const assigned = tasksByAgent.get(handle) ?? [];
    assigned.push(task);
    tasksByAgent.set(handle, assigned);
  }

  return new Map(
    [...tasksByAgent].map(([handle, assigned]) => [handle, workerHealthForTasks(assigned, now)] as const)
  );
}
