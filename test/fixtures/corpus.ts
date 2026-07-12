import { FixtureBuilder, handleFor, type MessageInput, syntheticId } from './builder.ts';
import type { SchemaOptions } from './schema.ts';

/**
 * A synthetic corpus with the *shape* of the live database — so that "it works on the
 * real thing" is something the suite checks rather than hopes (#13).
 *
 * The numbers below are the live database's, from #12 and #13: ~76 tasks in 13 inferred
 * runs, 4 of them edgeless, ~50 isolated singletons, 53 gate messages against 0
 * `decision_gates` rows, 302 of 466 messages heartbeats, 4 null-handle tasks. The
 * content is invented; only the shape is real.
 *
 * Everything here is deterministic — ids are hashes of their seed and every timestamp is
 * derived from one anchor — so the same corpus comes out of every build and out of every
 * machine.
 */

/** Day 1, noon UTC. Every timestamp in the corpus is an offset from here. */
const ANCHOR = Date.UTC(2026, 6, 8, 12, 0, 0);
const MINUTE = 60_000;

function at(offsetMinutes: number): Date {
  return new Date(ANCHOR + offsetMinutes * MINUTE);
}

type RunPlan = {
  /** How many tasks this handle created. */
  taskCount: number;
  /** How many of them form a dependency chain. 0 ⇒ an edgeless run (4 of 13 are). */
  chainLength: number;
  /** Minutes after the anchor that the run's first task was created. */
  startsAt: number;
  /** Minutes between consecutive task creations. Never > 6h, or the run would split. */
  spacing: number;
  /** Statuses of the run's *last* tasks — the work still in flight. The rest completed. */
  inFlight: string[];
};

/**
 * Twelve handles, one run each. Two of them overlap in time on purpose (runs 0 and 2):
 * handle is the run key and time is only the tiebreaker, so a time-first clustering that
 * merged them would be caught here. Run 1 is the overnight one — 13 tasks from 20:10 to
 * 06:58 the next morning, with every consecutive gap under the 6h split threshold.
 */
const RUN_PLANS: RunPlan[] = [
  { taskCount: 14, chainLength: 5, startsAt: 0, spacing: 20, inFlight: ['failed', 'dispatched', 'dispatched'] },
  { taskCount: 13, chainLength: 4, startsAt: 490, spacing: 54, inFlight: ['ready', 'ready', 'dispatched', 'dispatched'] },
  { taskCount: 12, chainLength: 4, startsAt: 60, spacing: 25, inFlight: ['pending', 'pending', 'pending', 'ready', 'ready'] },
  { taskCount: 10, chainLength: 3, startsAt: 1260, spacing: 30, inFlight: ['pending', 'pending', 'pending', 'dispatched', 'dispatched', 'dispatched'] },
  { taskCount: 6, chainLength: 3, startsAt: 1560, spacing: 40, inFlight: ['failed'] },
  { taskCount: 5, chainLength: 2, startsAt: 1800, spacing: 15, inFlight: [] },
  { taskCount: 3, chainLength: 2, startsAt: 2760, spacing: 22, inFlight: [] },
  { taskCount: 2, chainLength: 2, startsAt: 2880, spacing: 18, inFlight: [] },
  { taskCount: 2, chainLength: 0, startsAt: 3060, spacing: 12, inFlight: [] },
  { taskCount: 2, chainLength: 0, startsAt: 4140, spacing: 10, inFlight: [] },
  { taskCount: 2, chainLength: 2, startsAt: 4260, spacing: 35, inFlight: [] },
  { taskCount: 1, chainLength: 0, startsAt: 4560, spacing: 0, inFlight: [] },
];

/** The four tasks with no `created_by_terminal_handle`, which collect into one run. */
const UNATTRIBUTED_TASK_COUNT = 4;

const MESSAGE_TOTAL = 466;
const HEARTBEAT_TOTAL = 302;
/** Heartbeats every dispatched task gets; the rest of the 302 go to the earliest tasks. */
const HEARTBEATS_EACH = 4;
const GATE_MESSAGE_TOTAL = 53;
const GATES_WITH_A_TASK = 21;
const OPEN_GATES = 13;
const ORPHANED_MESSAGES = 3;
/**
 * Escalations — few and loud, which is the whole of what an escalation is.
 *
 * They are one of the four types the feed shows by default (SPEC §7.7) and the one it paints
 * red, so a corpus without them would leave that path asserted nowhere. They come out of the
 * plain-status filler below rather than being added on top: the message total is the live
 * database's and it does not move.
 */
const ESCALATIONS = 6;

type PlannedTask = {
  id: string;
  runIndex: number;
  indexInRun: number;
  handle: string | null;
  /** The terminal that actually worked it — null while the task has never been dispatched. */
  assignee: string | null;
  status: string;
  deps: string[];
  createdAt: Date;
  completedAt: Date | null;
};

function coordinatorOf(runIndex: number): string {
  return handleFor(`coordinator-${runIndex}`);
}

function assigneeOf(runIndex: number, indexInRun: number): string {
  return handleFor(`worker-${runIndex}-${indexInRun % 2}`);
}

/** A task is dispatched at all only when it reached one of these states. */
const DISPATCHED_STATES = new Set(['dispatched', 'completed', 'failed']);

function planTasks(): PlannedTask[] {
  const tasks: PlannedTask[] = [];

  RUN_PLANS.forEach((plan, runIndex) => {
    const ids = Array.from({ length: plan.taskCount }, (_, i) => syntheticId('task', `run-${runIndex}-task-${i}`));

    for (let i = 0; i < plan.taskCount; i++) {
      const fromTheEnd = plan.taskCount - i;
      const status = plan.inFlight[plan.inFlight.length - fromTheEnd] ?? 'completed';
      const createdAt = at(plan.startsAt + i * plan.spacing);
      // A chain: task i depends on task i-1. Everything past the chain is an isolated
      // singleton — 49 of the 76, which is why the canvas has to own the edgeless case.
      const deps = i > 0 && i < plan.chainLength ? [ids[i - 1]!] : [];

      tasks.push({
        id: ids[i]!,
        runIndex,
        indexInRun: i,
        handle: coordinatorOf(runIndex),
        assignee: DISPATCHED_STATES.has(status) ? assigneeOf(runIndex, i) : null,
        status,
        deps,
        createdAt,
        completedAt: status === 'completed' ? new Date(createdAt.getTime() + (6 + i) * MINUTE) : null,
      });
    }
  });

  for (let i = 0; i < UNATTRIBUTED_TASK_COUNT; i++) {
    const createdAt = at(2400 + i * 45);
    tasks.push({
      id: syntheticId('task', `unattributed-task-${i}`),
      runIndex: RUN_PLANS.length,
      indexInRun: i,
      handle: null, // Trap 8: no handle. These must not vanish — they are one synthetic run.
      assignee: assigneeOf(RUN_PLANS.length, i),
      status: 'completed',
      deps: [],
      createdAt,
      completedAt: new Date(createdAt.getTime() + 9 * MINUTE),
    });
  }

  return tasks;
}

/**
 * Dispatch attempts. Most tasks were dispatched once; two failed tasks burned all three
 * attempts and tripped the circuit breaker, and one completed task succeeded on its
 * second attempt — the only sign, anywhere in the schema, that a retry happened.
 */
function attemptsFor(task: PlannedTask, retriedTaskId: string): { status: string; failureCount: number }[] {
  if (!DISPATCHED_STATES.has(task.status)) return [];
  if (task.status === 'failed') {
    return [
      { status: 'failed', failureCount: 1 },
      { status: 'failed', failureCount: 2 },
      { status: 'circuit_broken', failureCount: 3 },
    ];
  }
  if (task.id === retriedTaskId) {
    return [
      { status: 'failed', failureCount: 1 },
      { status: 'completed', failureCount: 1 },
    ];
  }
  return [{ status: task.status === 'completed' ? 'completed' : 'dispatched', failureCount: 0 }];
}

export function liveShapeCorpus(schema: SchemaOptions = {}): FixtureBuilder {
  const builder = new FixtureBuilder(schema);
  const tasks = planTasks();

  for (const task of tasks) {
    builder.task({
      id: task.id,
      handle: task.handle,
      title: `Task ${task.indexInRun + 1} of run ${task.runIndex + 1}`,
      displayName: `run ${task.runIndex + 1} · task ${task.indexInRun + 1}`,
      spec: `Synthetic spec for ${task.id}. No real agent prompt ever lands in this repo.`,
      status: task.status,
      deps: task.deps,
      result: task.status === 'completed' ? `Synthetic result receipt for ${task.id}.` : null,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
    });
  }

  // The task that had to be retried before it completed.
  const retriedTaskId = syntheticId('task', 'run-0-task-6');
  const messages: MessageInput[] = [];
  const dispatchedTasks = tasks.filter((task) => DISPATCHED_STATES.has(task.status));

  dispatchedTasks.forEach((task, taskIndex) => {
    const assignee = task.assignee!;
    const coordinator = task.handle ?? coordinatorOf(task.runIndex);
    const attempts = attemptsFor(task, retriedTaskId);

    // Heartbeats: 302 of 466 messages. Every dispatched task gets a base four, and the
    // remainder is handed out one apiece to the earliest tasks until 302 is exact. The
    // last beat of the latest attempt is what the dispatch row's last_heartbeat_at
    // carries, and what drives the node's "last seen" badge.
    const heartbeats = HEARTBEATS_EACH + (taskIndex < HEARTBEAT_TOTAL - HEARTBEATS_EACH * dispatchedTasks.length ? 1 : 0);
    const dispatchedAt = new Date(task.createdAt.getTime() + 0.5 * MINUTE);
    const finishedAt = task.completedAt ?? new Date(dispatchedAt.getTime() + 30 * MINUTE);
    const beat = (n: number) =>
      new Date(dispatchedAt.getTime() + ((finishedAt.getTime() - dispatchedAt.getTime()) * (n + 1)) / (heartbeats + 1));

    attempts.forEach((attempt, attemptIndex) => {
      const isLatest = attemptIndex === attempts.length - 1;
      const attemptStart = new Date(dispatchedAt.getTime() + attemptIndex * MINUTE);
      builder.dispatch({
        id: syntheticId('ctx', `${task.id}-attempt-${attemptIndex}`),
        taskId: task.id,
        assigneeHandle: assignee,
        status: attempt.status,
        failureCount: attempt.failureCount,
        lastFailure: attempt.status === 'failed' || attempt.status === 'circuit_broken' ? attemptStart : null,
        dispatchedAt: attemptStart,
        completedAt: attempt.status === 'completed' ? finishedAt : null,
        createdAt: attemptStart,
        lastHeartbeatAt: isLatest ? beat(heartbeats - 1) : null,
      });
    });

    for (let n = 0; n < heartbeats; n++) {
      messages.push({
        type: 'heartbeat',
        fromHandle: assignee,
        toHandle: coordinator,
        subject: 'alive',
        payload: { taskId: task.id, phase: 'implementing' },
        createdAt: beat(n),
      });
    }

    // worker_done: one per completed task, plus the failure receipts — a failed worker
    // still reports, it just reports a failure.
    if (task.status === 'completed' || task.status === 'failed') {
      messages.push({
        type: 'worker_done',
        fromHandle: assignee,
        toHandle: coordinator,
        subject: task.status === 'completed' ? 'Done' : 'Failed: circuit breaker tripped',
        body: `Synthetic three-sentence summary for ${task.id}.`,
        payload: { taskId: task.id, dispatchId: syntheticId('ctx', `${task.id}-attempt-0`) },
        createdAt: new Date(finishedAt.getTime() - 0.2 * MINUTE),
      });
    }
  });

  // Gates. 53 gate messages against 0 decision_gates rows — the trap that empties the
  // gate panel of a gates-from-the-table implementation, forever, on real runs.
  //
  // And they come in the live database's **two shapes**, which is a trap inside that trap:
  //
  // - `orchestration ask` writes `payload = {question, options}` and **no taskId**.
  // - a worker escalating by hand with `orchestration send --type decision_gate` writes
  //   `payload = {taskId, dispatchId}` and puts the **question in the subject** — no
  //   `payload.question` at all.
  //
  // On the live database every gate that names a task is of the second kind, so a reader that
  // takes the question from the payload alone renders an empty question on *every gate that
  // marks a node*. The corpus reproduces the correlation, not just the counts.
  const gateHosts = dispatchedTasks.filter((task) => task.status !== 'failed');
  for (let i = 0; i < GATE_MESSAGE_TOTAL; i++) {
    const host = gateHosts[(i * 7) % gateHosts.length]!;
    const gateId = syntheticId('msg', `gate-message-${i}`);
    const askedAt = new Date(host.createdAt.getTime() + (2 + i) * MINUTE);
    // Only 21 of 53 gates name a task — and those are exactly the hand-written ones, whose
    // question lives in the subject. The rest come from `ask`: a question, options, no task.
    const namesATask = i < GATES_WITH_A_TASK;
    const question = `Question ${i + 1}: which way should this go?`;

    messages.push({
      id: gateId,
      type: 'decision_gate',
      fromHandle: host.assignee!,
      toHandle: host.handle ?? coordinatorOf(host.runIndex),
      subject: namesATask ? question : `Decision needed on ${host.id}`,
      body: namesATask ? 'The worker cannot proceed without a decision.' : 'Synthetic gate question.',
      payload: namesATask
        ? { taskId: host.id, dispatchId: syntheticId('ctx', `${host.id}-attempt-0`) }
        : { question, options: ['option A', 'option B'] },
      createdAt: askedAt,
    });

    // A gate is resolved when a reply threads on the gate *message's* id. The last 13
    // gates never got an answer — those are what raise the gate strip.
    if (i < GATE_MESSAGE_TOTAL - OPEN_GATES) {
      messages.push({
        type: 'status',
        fromHandle: host.handle ?? coordinatorOf(host.runIndex),
        toHandle: host.assignee!,
        subject: 'Re: decision',
        body: 'option A',
        threadId: gateId,
        createdAt: new Date(askedAt.getTime() + 3 * MINUTE),
      });
    }
  }

  // A worker that cannot proceed says so, and names the task it is stuck on.
  for (let i = 0; i < ESCALATIONS; i++) {
    const host = dispatchedTasks[(i * 13) % dispatchedTasks.length]!;
    messages.push({
      type: 'escalation',
      priority: 'high',
      fromHandle: host.assignee!,
      toHandle: host.handle ?? coordinatorOf(host.runIndex),
      subject: `Blocked on ${host.id}`,
      body: 'Synthetic escalation: the worker cannot proceed without a decision.',
      payload: { taskId: host.id },
      createdAt: new Date(host.createdAt.getTime() + 5 * MINUTE),
    });
  }

  // Messages whose payload.taskId points at a task an `orchestration reset` deleted. No
  // foreign keys: the join has to miss without taking the feed row down with it.
  for (let i = 0; i < ORPHANED_MESSAGES; i++) {
    messages.push({
      type: 'status',
      fromHandle: handleFor(`worker-0-${i % 2}`),
      toHandle: coordinatorOf(0),
      subject: 'Progress on a task that no longer exists',
      payload: { taskId: syntheticId('task', `wiped-by-reset-${i}`) },
      createdAt: at(30 + i),
    });
  }

  // The remaining plain status traffic, filling the log out to its 466 rows — one of
  // which is the single status message that does carry a taskId (1 of 46 live).
  const plainStatus = MESSAGE_TOTAL - messages.length;
  for (let i = 0; i < plainStatus; i++) {
    const host = dispatchedTasks[(i * 11) % dispatchedTasks.length]!;
    messages.push({
      type: 'status',
      fromHandle: host.assignee ?? coordinatorOf(host.runIndex),
      toHandle: host.handle ?? coordinatorOf(host.runIndex),
      subject: `Progress note ${i + 1}`,
      body: 'Synthetic status body.',
      payload: i === 0 ? { taskId: host.id } : undefined,
      createdAt: new Date(host.createdAt.getTime() + 4 * MINUTE),
    });
  }

  // `sequence` is AUTOINCREMENT: inserting in time order is what makes it the total
  // order over the event log that the real database has.
  messages
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .forEach((message) => builder.message(message));

  return builder;
}
