import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunSnapshot } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * **The evidence the dispatch timeline is drawn from** (#72), asserted where it actually lives: on
 * the wire, from a real fixture database, through `GET /api/run/:id`.
 *
 * The timeline itself is a client derivation (`src/client/timeline/derive.ts`, and the suite beside
 * it) — deliberately, because ADR 0002 already made the selected-run snapshot **complete**: every
 * task, **every attempt**, every gate and the whole conversation, never windowed and never
 * truncated. That is precisely why SPEC §12.4 can say every retained attempt is its own bar. A
 * second server-side derivation of the same rows would be a second copy of a truth that can
 * disagree with the first, which is the mistake `GET /api/task/:id` was cured of (SPEC §6.4).
 *
 * So what the server owes this feature is not a new endpoint — it is a **contract**, and this file
 * is where that contract is nailed down. Every test below is a claim the timeline makes on screen,
 * traced back to the HTTP response it can only make because of:
 *
 * | The timeline draws | Because the wire carries |
 * |---|---|
 * | one bar per attempt, retries included | `attempts[taskId]` — *all* the rows, not `MAX(rowid)` |
 * | concurrent lanes | each attempt's own assignee and its own instants |
 * | "so far", or no claim at all | each attempt's own `DurationObservation`, or its absence (#66) |
 * | markers | `gates[].createdAt`, escalation turns' `at`, `tasks.completedAt` |
 * | **nothing else** | a schema that timestamps no status transition, and a wire that invents none |
 *
 * A regression in any row of that table would empty or falsify the timeline in a way its own canned
 * tests, fed a canned world, could never catch. This is the seam SPEC §12.5 asks for: requests
 * against live-shaped fixture databases, asserting user-visible contract behavior.
 */

const BOSS = handleFor('orchestrator');
const FIRST = handleFor('worker-one');
const SECOND = handleFor('worker-two');
const RUN_ID = `run_${BOSS}`;

const TASK = 'task_retried';
const OTHER = 'task_concurrent';

/** Noon, plus n minutes — every instant in this file is minutes off one clock. */
function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 6, 8, 12, 0, 0) + minutes * 60_000);
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/**
 * One orchestrator: a task that had to be dispatched **twice** (to two different terminals — a retry
 * goes to a fresh worktree with a fresh handle), and a second task the other agent held *at the same
 * time*. Plus the three instants a marker can stand on.
 */
function orchestration(): FixtureBuilder {
  return (
    new FixtureBuilder()
      .task({ id: TASK, handle: BOSS, title: 'Chart the map', status: 'completed', createdAt: at(0), completedAt: at(47) })
      .task({ id: OTHER, handle: BOSS, title: 'Draw the canvas', status: 'dispatched', createdAt: at(2) })
      // The retry, as `dispatch_contexts` records it: two rows, one task, in rowid order.
      .dispatch({
        id: 'ctx_first',
        taskId: TASK,
        assigneeHandle: FIRST,
        status: 'failed',
        failureCount: 1,
        dispatchedAt: at(5),
        completedAt: at(12),
      })
      .dispatch({
        id: 'ctx_second',
        taskId: TASK,
        assigneeHandle: SECOND,
        status: 'completed',
        dispatchedAt: at(20),
        completedAt: at(45),
      })
      // Concurrency: A1 is out on this one while A2 is working the retry above.
      .dispatch({
        id: 'ctx_other',
        taskId: OTHER,
        assigneeHandle: FIRST,
        status: 'dispatched',
        dispatchedAt: at(18),
      })
      .message({
        id: 'msg_gate',
        fromHandle: FIRST,
        toHandle: BOSS,
        type: 'decision_gate',
        subject: 'Which way?',
        payload: { taskId: TASK, question: 'Which way?', options: ['left', 'right'] },
        createdAt: at(9),
      })
      .message({
        fromHandle: FIRST,
        toHandle: BOSS,
        type: 'escalation',
        subject: 'Blocked: out of credits',
        payload: { taskId: OTHER },
        createdAt: at(30),
      })
  );
}

async function snapshotOf(builder: FixtureBuilder): Promise<RunSnapshot> {
  harness = await serve(builder.write(tempDbPath()));
  const response = await harness.run(RUN_ID);
  expect(response.status).toBe(200);
  return (await response.json()) as RunSnapshot;
}

describe('the selected-run contract, read as the timeline reads it', () => {
  it('carries every retained attempt of a retried task — not just the one that survived', async () => {
    const snapshot = await snapshotOf(orchestration());

    // `Task.dispatch` is `MAX(rowid)`: the attempt that finished the work. A timeline built from it
    // would draw one bar and silently delete the agent that failed — which is exactly the one a
    // post-mortem came for. The bars come from here instead.
    expect(snapshot.tasks.find((task) => task.id === TASK)?.dispatch?.id).toBe('ctx_second');

    const attempts = snapshot.attempts[TASK]!;
    expect(attempts.map((attempt) => attempt.id)).toEqual(['ctx_first', 'ctx_second']);

    // Two attempts, two *agents* — and each timed on its own row's clock, never a start from one
    // against an end from another (SPEC §12.4, #66).
    expect(attempts[0]).toMatchObject({
      assigneeHandle: FIRST,
      status: 'failed',
      failureCount: 1,
      duration: { clock: 'dispatch', complete: true, ms: 7 * 60_000 },
    });
    expect(attempts[1]).toMatchObject({
      assigneeHandle: SECOND,
      status: 'completed',
      duration: { clock: 'dispatch', complete: true, ms: 25 * 60_000 },
    });
  });

  it('carries two agents’ overlapping attempts, so concurrency survives the wire', async () => {
    const snapshot = await snapshotOf(orchestration());

    // The one thing a layered DAG structurally cannot show: these two ran *at the same time*. The
    // wire has to carry both terminals and both pairs of instants, or no lane can prove it.
    const retry = snapshot.attempts[TASK]![1]!;
    const concurrent = snapshot.attempts[OTHER]![0]!;

    expect(retry.assigneeHandle).not.toBe(concurrent.assigneeHandle);
    expect(Date.parse(concurrent.dispatchedAt)).toBeLessThan(Date.parse(retry.dispatchedAt));

    // …and the one still out is *open*, not closed at some invented instant: the client ages it as
    // "so far" against its own clock (#66), which is the only honest way to time work in flight.
    expect(concurrent.completedAt).toBeNull();
    expect(concurrent.duration).toEqual({ clock: 'dispatch', startAt: at(18).toISOString(), complete: false });

    // Both agents are in the cast, in first-dispatch order — the lanes, and their monograms.
    expect(snapshot.run.cast.map((member) => [member.monogram, member.handle])).toEqual([
      ['A1', FIRST],
      ['A2', SECOND],
    ]);
  });

  it('invents no instant for an attempt whose dispatch time is unreadable', async () => {
    const dbPath = orchestration().write(tempDbPath());
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare('UPDATE dispatch_contexts SET dispatched_at = ?, created_at = ? WHERE id = ?').run(
        'whenever',
        'whenever',
        'ctx_first'
      );
    } finally {
      db.close();
    }

    harness = await serve(dbPath);
    const snapshot = (await (await harness.run(RUN_ID)).json()) as RunSnapshot;
    const broken = snapshot.attempts[TASK]![0]!;

    // The row **survives** — a dropped attempt is a worse lie than an unplaceable one (SPEC §5) —
    // and its garbage comes through verbatim rather than as an epoch date the client would draw a
    // 1970 bar from. There is no observation, because the endpoints cannot support one.
    expect(broken.id).toBe('ctx_first');
    expect(broken.dispatchedAt).toBe('whenever');
    expect(broken.duration).toBeUndefined();

    // The task keeps its other attempt, so it is not untimed — only that one bar cannot be placed.
    expect(snapshot.attempts[TASK]![1]!.duration).toMatchObject({ complete: true });
  });

  it('keeps a never-dispatched task on the wire, with no attempts to place it by', async () => {
    const snapshot = await snapshotOf(
      orchestration().task({ id: 'task_ghost', handle: BOSS, title: 'Never handed out', createdAt: at(1) })
    );

    // It has no dispatch instant anywhere, so the timeline cannot give it a position — and the wire
    // must still give it a *task*, or the untimed list would have nothing to keep reachable.
    expect(snapshot.tasks.map((task) => task.id)).toContain('task_ghost');
    expect(snapshot.attempts['task_ghost']).toBeUndefined();
    expect(snapshot.tasks.find((task) => task.id === 'task_ghost')?.dispatch).toBeNull();
  });

  it('carries the recorded instants every marker stands on — and the gate the table never held', async () => {
    const snapshot = await snapshotOf(orchestration());

    // The gate, from the *messages* — the `decision_gates` table has zero rows in real data, and a
    // gate strip read from it renders nothing forever (SPEC §4.2, trap 1). The timeline's gate
    // marker rides on the same derivation.
    expect(snapshot.gates.map((gate) => [gate.taskId, gate.createdAt])).toEqual([[TASK, at(9).toISOString()]]);

    // The escalation, as a turn, with the instant it was sent at and the agent that sent it — which
    // is what puts the marker in a *lane*.
    const escalation = snapshot.turns.find((turn) => turn.kind === 'escalation')!;
    expect(escalation).toMatchObject({ at: at(30).toISOString(), taskId: OTHER, fromHandle: FIRST, direction: 'in' });

    // The completion: `tasks.completed_at`, which Orca writes from JS as ISO while the attempt's own
    // `completed_at` comes from SQL (SPEC §4.2, trap 5). They are different columns and they
    // disagree here by two minutes — which is exactly why the marker is not the bar's right edge
    // repeated, and why both are worth seeing.
    const task = snapshot.tasks.find((candidate) => candidate.id === TASK)!;
    expect(task.completedAt).toBe(at(47).toISOString());
    expect(snapshot.attempts[TASK]![1]!.completedAt).toBe(at(45).toISOString());
  });

  it('timestamps no status transition anywhere, because Orca never wrote one down', async () => {
    const snapshot = await snapshotOf(orchestration());
    const task = snapshot.tasks.find((candidate) => candidate.id === OTHER)!;

    // Six writers mutate `tasks.status` in place and not one of them records when: the
    // `pending → ready` promotion is silent and untimestamped (SPEC §4.2, trap 6). This task is
    // `dispatched` *now*; the file does not say when it stopped being `pending`.
    //
    // The timeline therefore has exactly three instants it may mark, and this is the assertion that
    // keeps a future push from quietly adding a fourth: a task's whole retained chronology is its
    // creation, its completion, and its attempts' own two columns.
    expect(task.status).toBe('dispatched');
    expect(Object.keys(task).filter((key) => /at$|At$/.test(key)).sort()).toEqual(['completedAt', 'createdAt']);
    expect(Object.keys(snapshot.attempts[OTHER]![0]!).filter((key) => /At$/.test(key)).sort()).toEqual([
      'completedAt',
      'dispatchedAt',
      'lastHeartbeatAt',
    ]);
  });
});
