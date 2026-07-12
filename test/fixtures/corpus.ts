import { FixtureBuilder, handleFor, type MessageInput, syntheticId } from './builder.ts';
import type { SchemaOptions } from './schema.ts';

/**
 * A synthetic corpus with the *shape* of the live database — so that "it works on the
 * real thing" is something the suite checks rather than hopes (#13).
 *
 * The numbers below are the live database's, from #12 and #13: ~76 tasks under 13 orchestrators, 4
 * of them edgeless, ~50 isolated singletons, 53 gate messages against 0 `decision_gates` rows, 302
 * of 466 messages heartbeats, 4 null-handle tasks — and **one terminal that was picked up again 14
 * hours later**, which is the shape the waves exist for. The content is invented; only the shape is
 * real.
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
  /** Minutes between consecutive task creations. */
  spacing: number;
  /** Statuses of the run's *last* tasks — the work still in flight. The rest completed. */
  inFlight: string[];
  /**
   * **The second wave**: the task index at which this terminal picked its work up again after a
   * long break (SPEC §4.3). Absent ⇒ the orchestrator worked in one continuous burst.
   *
   * This is the shape the whole wave feature exists for, and it is the live database's: a terminal
   * is a Claude Code session a person comes back to, and the six-hour idle gap used to cut it into
   * several unrelated rows in the rail with nothing on screen ever saying why. A corpus with no
   * such gap in it would let a build that never drew a wave pass its tests.
   */
  secondWaveAt?: number;
  /** How long the terminal was quiet before that second wave. */
  idleHours?: number;
};

/**
 * Twelve handles, one orchestrator each. Three shapes are load-bearing and all three are here:
 *
 * - **Two of them overlap in time** (runs 0 and 2). The handle is the key and time is only the
 *   tiebreaker, so a time-first clustering that merged them would be caught here.
 * - **Run 1 is the overnight one** — 13 tasks from 20:10 to 06:58 the next morning, with every
 *   consecutive gap *under* the six-hour threshold. A shorter threshold would shred it.
 * - **Run 0 has two waves** — the same terminal, picked up again after 14 hours of silence. That
 *   used to be two unrelated rows in the rail; it is now one orchestrator with a captioned gap
 *   drawn across its canvas (SPEC §4.3).
 */
const RUN_PLANS: RunPlan[] = [
  // The terminal that was picked up again the next morning, 14 hours later — and went on to depend
  // on the work it had stopped in the middle of. One orchestrator, two waves, one cross-wave edge.
  {
    taskCount: 14,
    chainLength: 5,
    startsAt: 0,
    spacing: 20,
    inFlight: ['failed', 'dispatched', 'dispatched'],
    secondWaveAt: 8,
    idleHours: 14,
  },
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
/**
 * Of the gates that name a task, the ones a worker wrote by hand — `payload = {taskId,
 * dispatchId}`, question in the **subject**. Half the live database's gate messages are this
 * shape, and a payload-only reader shows every one of them as a blank question.
 */
const HAND_WRITTEN_GATES = 15;
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

      // The silence in front of a second wave. Everything from `secondWaveAt` on is pushed back by
      // it, so the gap between two *consecutive* tasks of one terminal really is > 6h — which is
      // the only thing that opens a wave (`server/runs.ts`).
      const idle = plan.secondWaveAt !== undefined && i >= plan.secondWaveAt ? (plan.idleHours ?? 0) * 60 : 0;
      const createdAt = at(plan.startsAt + i * plan.spacing + idle);

      // A chain: task i depends on task i-1. Everything past the chain is an isolated singleton —
      // most of the 76, which is why the canvas has to own the edgeless case.
      //
      // …except the first task of a second wave, which depends on the last of the first. That is a
      // dependency edge *crossing a wave border*, and it is what a terminal picking its work back up
      // actually looks like: the canvas lays each wave out on its own and joins them with a long
      // line, and a build that dropped the edge instead would call a real dependency a dead end.
      const bridges = plan.secondWaveAt !== undefined && i === plan.secondWaveAt;
      const deps = (i > 0 && i < plan.chainLength) || bridges ? [ids[i - 1]!] : [];

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
    //
    // A *completed* worker's payload carries the live shape verbatim: every real worker_done
    // in the live database is `{taskId, dispatchId, filesModified, reportPath?}` — which is
    // what makes the corpus exercise the outcome-receipt readers (#67) and what the snapshot
    // budget in `tasks.test.ts` is priced against.
    if (task.status === 'completed' || task.status === 'failed') {
      messages.push({
        type: 'worker_done',
        fromHandle: assignee,
        toHandle: coordinator,
        subject: task.status === 'completed' ? 'Done' : 'Failed: circuit breaker tripped',
        body: `Synthetic three-sentence summary for ${task.id}.`,
        payload: {
          taskId: task.id,
          dispatchId: syntheticId('ctx', `${task.id}-attempt-0`),
          ...(task.status === 'completed' && {
            filesModified: [`src/${task.id}.ts`, `test/${task.id}.test.ts`],
            reportPath: `docs/reports/${task.id}.md`,
          }),
        },
        createdAt: new Date(finishedAt.getTime() - 0.2 * MINUTE),
      });
    }
  });

  // Gates. 53 gate messages against 0 decision_gates rows — the trap that empties the
  // gate panel of a gates-from-the-table implementation, forever, on real runs.
  //
  // And a gate message comes in more than one shape, which is a trap inside that trap. Both of
  // these are `type = 'decision_gate'`, and they put the question in different places:
  //
  // - **`orchestration ask`** writes `payload = {question, options}` (`rpc/methods/
  //   orchestration.ts:574-584`, docs/research/db-history.md §2) — with a `taskId` when the
  //   asker named one, and without when it did not.
  // - **A worker escalating by hand** with `orchestration send --type decision_gate` writes
  //   `payload = {taskId, dispatchId}` and puts the **question in the subject** — there is no
  //   `payload.question` at all. (In this very project `ask` is broken in the agent runtime, so
  //   this is what its workers actually produce, and it is not a hypothetical.)
  //
  // Measured on the live database — 58 gate messages, `SELECT payload FROM messages WHERE
  // type='decision_gate'` tallied by shape: **25** `{question, options}`, **4** `{question}`,
  // **22** `{taskId, dispatchId}` with the question in the subject, and **7** with no payload
  // at all. So **half of them carry no `payload.question`**, and a reader that takes the
  // question from the payload alone renders a blank question over half the gates it shows.
  //
  // The corpus carries all three shapes, in the proportions the live database has: the ones
  // that name a task are mostly the hand-written kind, but not all — because a working `ask`
  // that names a task produces `{question, options, taskId}`, which is the shape SPEC §4.5
  // describes, and the fixture must not stop exercising it.
  const gateHosts = dispatchedTasks.filter((task) => task.status !== 'failed');
  for (let i = 0; i < GATE_MESSAGE_TOTAL; i++) {
    const host = gateHosts[(i * 7) % gateHosts.length]!;
    const gateId = syntheticId('msg', `gate-message-${i}`);
    const askedAt = new Date(host.createdAt.getTime() + (2 + i) * MINUTE);
    // 21 of 53 name a task. 15 of those are hand-written (the question is in the subject); the
    // other 6 are `ask` gates that named one. The remaining 32 are `ask` gates that did not.
    const namesATask = i < GATES_WITH_A_TASK;
    const handWritten = i < HAND_WRITTEN_GATES;
    const question = `Question ${i + 1}: which way should this go?`;

    messages.push({
      id: gateId,
      type: 'decision_gate',
      fromHandle: host.assignee!,
      toHandle: host.handle ?? coordinatorOf(host.runIndex),
      // The hand-written kind has nowhere else to put the question.
      subject: handWritten ? question : `Decision needed on ${host.id}`,
      body: handWritten ? 'The worker cannot proceed without a decision.' : 'Synthetic gate question.',
      payload: handWritten
        ? { taskId: host.id, dispatchId: syntheticId('ctx', `${host.id}-attempt-0`) }
        : {
            question,
            options: ['option A', 'option B'],
            ...(namesATask ? { taskId: host.id } : {}),
          },
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
