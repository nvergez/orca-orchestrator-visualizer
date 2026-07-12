import { afterEach, describe, expect, it } from 'vitest';
import type { TaskDetail } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor, syntheticId } from '../fixtures/builder.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { selectTurns } from '../../src/client/conversation/select.ts';
import { type Harness, serve } from './harness.ts';

/**
 * `GET /api/task/:id` — the lazy detail (#20), and the one route that reads the bodies.
 *
 * Two things about it are load-bearing, and both are absences elsewhere:
 *
 * 1. **The bodies are not in the snapshot.** A live 71-task dump was 172 KB, almost entirely
 *    spec text (SPEC §6.3). They are fetched here, on click, and the snapshot goes on carrying
 *    `hasSpec` / `hasResult` and nothing more.
 * 2. **Every dispatch attempt is here, and only the latest is in the snapshot.** That split is
 *    deliberate: `dispatch_contexts` is the only genuinely append-only per-task history in this
 *    schema — the retry and circuit-breaker story lives in it, and a silent re-dispatch must not
 *    read as a first attempt.
 */

const AT = new Date('2026-07-08T12:00:00Z');
const COORDINATOR = handleFor('coordinator');
const FIRST_WORKER = handleFor('worker-1');
const SECOND_WORKER = handleFor('worker-2');

/** Minutes after the anchor — the corpus's own way of keeping a fixture's clock honest. */
function at(minutes: number): Date {
  return new Date(AT.getTime() + minutes * 60_000);
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function detailOf(id: string): Promise<TaskDetail> {
  const response = await harness!.task(id);
  expect(response.status).toBe(200);
  return (await response.json()) as TaskDetail;
}

/**
 * A task that was dispatched three times: it failed twice and the third attempt tripped the
 * circuit breaker (which is what Orca does at 3). The three rows are the *only* record anywhere
 * in this schema that any of that happened.
 */
function retriedFixture(): string {
  const taskId = syntheticId('task', 'retried');

  return new FixtureBuilder()
    .task({
      id: taskId,
      handle: COORDINATOR,
      title: 'The task that would not go',
      spec: 'Do the thing, and do it carefully.',
      status: 'failed',
      createdAt: AT,
    })
    .dispatch({
      id: 'ctx_first',
      taskId,
      assigneeHandle: FIRST_WORKER,
      status: 'failed',
      failureCount: 1,
      lastFailure: at(10),
      dispatchedAt: at(1),
      createdAt: at(1),
    })
    .dispatch({
      id: 'ctx_second',
      taskId,
      assigneeHandle: SECOND_WORKER,
      status: 'failed',
      failureCount: 2,
      lastFailure: at(20),
      dispatchedAt: at(11),
      createdAt: at(11),
    })
    .dispatch({
      id: 'ctx_third',
      taskId,
      assigneeHandle: SECOND_WORKER,
      status: 'circuit_broken',
      failureCount: 3,
      lastFailure: at(30),
      dispatchedAt: at(21),
      createdAt: at(21),
      lastHeartbeatAt: at(25),
    })
    .write(tempDbPath());
}

describe('every dispatch attempt', () => {
  it('is returned in rowid order, while the snapshot carries only the latest and the count', async () => {
    harness = await serve(retriedFixture());
    const taskId = syntheticId('task', 'retried');

    // The snapshot's half of the split: `MAX(rowid)`, and the one number that says there were
    // others. `attemptCount > 1` is the *only* visible sign of a retry anywhere in the schema.
    const task = (await harness.snapshot()).snapshot.tasks.find((candidate) => candidate.id === taskId)!;

    expect(task.attemptCount).toBe(3);
    expect(task.dispatch?.id).toBe('ctx_third');
    expect(task.dispatch?.status).toBe('circuit_broken');

    // …and the route's half: all three of them, oldest attempt first.
    const detail = await detailOf(taskId);

    expect(detail.attempts.map((attempt) => attempt.id)).toEqual(['ctx_first', 'ctx_second', 'ctx_third']);
    expect(detail.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'failed', 'circuit_broken']);
    expect(detail.attempts.map((attempt) => attempt.failureCount)).toEqual([1, 2, 3]);
  });

  it('carries what a post-mortem needs of each one — who held it, when, and how it ended', async () => {
    harness = await serve(retriedFixture());

    const [first, , third] = (await detailOf(syntheticId('task', 'retried'))).attempts;

    // A retry goes to a *new* terminal, so the assignee is a per-attempt fact and not a
    // per-task one. The badge on the node only ever shows the last of them.
    expect(first!.assigneeHandle).toBe(FIRST_WORKER);
    expect(third!.assigneeHandle).toBe(SECOND_WORKER);

    expect(first!.dispatchedAt).toBe(at(1).toISOString());
    expect(first!.lastFailure).toBe(at(10).toISOString());
    expect(third!.lastHeartbeatAt).toBe(at(25).toISOString());
  });

  it('is empty for a task that was never dispatched, rather than absent', async () => {
    harness = await serve(
      new FixtureBuilder().task({ id: 'task_never', handle: COORDINATOR, createdAt: AT }).write(tempDbPath())
    );

    const detail = await detailOf('task_never');

    expect(detail.attempts).toEqual([]);
  });
});

/**
 * The bodies. They are omitted from the snapshot on purpose (SPEC §6.3) and this is the only
 * route that reads them — so the assertion has two halves, and the one about the *snapshot* is
 * the one that would catch someone quietly putting 172 KB back on the wire.
 */
describe('the spec and the result', () => {
  function fixture(): string {
    return new FixtureBuilder()
      .task({
        id: 'task_done',
        handle: COORDINATOR,
        title: 'Ship it',
        spec: 'The full dispatch prompt, which on a real database is several kilobytes of it.',
        status: 'completed',
        result: 'Done: three sentences about what happened.',
        createdAt: AT,
        completedAt: at(40),
      })
      .task({ id: 'task_pending', handle: COORDINATOR, spec: 'Not started.', status: 'pending', createdAt: at(5) })
      .write(tempDbPath());
  }

  it('are fetched here, on click, and nowhere else', async () => {
    harness = await serve(fixture());

    const detail = await detailOf('task_done');

    expect(detail.id).toBe('task_done');
    expect(detail.spec).toBe('The full dispatch prompt, which on a real database is several kilobytes of it.');
    expect(detail.result).toBe('Done: three sentences about what happened.');
  });

  it('never travel in the snapshot — which carries only whether they exist', async () => {
    harness = await serve(fixture());

    const tasks = (await harness.snapshot()).snapshot.tasks;
    const done = tasks.find((task) => task.id === 'task_done')!;
    const pending = tasks.find((task) => task.id === 'task_pending')!;

    expect(done.hasSpec).toBe(true);
    expect(done.hasResult).toBe(true);
    expect(pending.hasResult).toBe(false);
    // The bodies themselves are not fields of a snapshot task at all.
    expect(done).not.toHaveProperty('spec');
    expect(done).not.toHaveProperty('result');
  });

  it('are null for a task that has neither yet, rather than an empty string', async () => {
    harness = await serve(fixture());

    const detail = await detailOf('task_pending');

    expect(detail.result).toBeNull();
    expect(detail.spec).toBe('Not started.');
  });
});

/**
 * The messages that referenced the task — `payload.taskId`, which carries 83% of the traffic
 * and is the only link a message has to a node (SPEC §4.4).
 */
describe('the messages referencing the task', () => {
  function fixture(): string {
    const builder = new FixtureBuilder()
      .task({ id: 'task_one', handle: COORDINATOR, title: 'One', status: 'dispatched', createdAt: AT })
      .task({ id: 'task_two', handle: COORDINATOR, title: 'Two', status: 'completed', createdAt: at(2) })
      .dispatch({ taskId: 'task_one', assigneeHandle: FIRST_WORKER, status: 'dispatched', dispatchedAt: at(1) });

    // Interleaved in time, so "sequence-ordered" is a claim with something to fail against.
    builder.message({
      type: 'dispatch',
      fromHandle: COORDINATOR,
      toHandle: FIRST_WORKER,
      subject: 'Dispatched: One',
      payload: { taskId: 'task_one' },
      createdAt: at(1),
    });
    builder.message({
      type: 'status',
      fromHandle: FIRST_WORKER,
      toHandle: COORDINATOR,
      subject: 'About the other task',
      payload: { taskId: 'task_two' },
      createdAt: at(2),
    });
    builder.message({
      type: 'heartbeat',
      fromHandle: FIRST_WORKER,
      toHandle: COORDINATOR,
      subject: 'alive',
      payload: { taskId: 'task_one' },
      createdAt: at(3),
    });
    builder.message({
      type: 'status',
      fromHandle: FIRST_WORKER,
      toHandle: COORDINATOR,
      subject: 'Naming nobody',
      createdAt: at(4),
    });
    builder.message({
      type: 'worker_done',
      fromHandle: FIRST_WORKER,
      toHandle: COORDINATOR,
      subject: 'Done: One',
      body: 'Three sentences.',
      payload: { taskId: 'task_one' },
      createdAt: at(5),
    });

    return builder.write(tempDbPath());
  }

  it('are no longer on this route at all — the exchange is on the wire, whole', async () => {
    harness = await serve(fixture());

    const detail = await detailOf('task_one');

    // This route used to return the messages whose `payload.taskId` was this task. That list was
    // *the half of the exchange that got written down*: the prompt the agent was dispatched with,
    // the orchestrator's answer to a gate and the final receipt are not messages at all (SPEC §4.2,
    // trap 2), so they could never appear in it. `snapshot.turns` carries all four (SPEC §4.7) — so
    // the weaker list is gone rather than kept beside it, because a second copy of a truth is a
    // second copy that can disagree with the first.
    //
    // `completions` is not that list back again: it is the raw `worker_done` *payloads* — the
    // outcome-receipt evidence (#67), which no turn carries — not the exchange, which stays the
    // snapshot's alone.
    expect(detail).not.toHaveProperty('messages');
    expect(Object.keys(detail).sort()).toEqual(['attempts', 'completions', 'id', 'receipt', 'result', 'spec']);
  });

  it('are replaced by the task-scoped conversation, with both sides in it', async () => {
    harness = await serve(fixture());

    const { snapshot } = await harness.snapshot();
    const exchange = selectTurns(snapshot.turns, { runId: null, taskId: 'task_one' });

    // The agent's messages — which is all the old list had…
    expect(exchange.some((turn) => turn.kind === 'worker_done' && turn.direction === 'in')).toBe(true);
    // …and the orchestrator's dispatch, which no message anywhere records.
    expect(exchange.some((turn) => turn.kind === 'dispatch' && turn.direction === 'out')).toBe(true);

    // …and every one of them is this task's, and no other task's.
    for (const turn of exchange) expect(turn.taskId).toBe('task_one');
  });

  it('collapse the heartbeats rather than hiding them behind a toggle', async () => {
    harness = await serve(fixture());

    const { snapshot } = await harness.snapshot();
    const exchange = selectTurns(snapshot.turns, { runId: null, taskId: 'task_one' });

    // 65% of all traffic says "alive" (SPEC §4.2, trap 4). One row keeps the fact — an agent was
    // beating, this often, over this span — and throws away only the repetition. Nothing is behind
    // a toggle any more, because the rows it would reveal all say the same word.
    const beats = exchange.filter((turn) => turn.kind === 'heartbeats');
    expect(beats).toHaveLength(1);
    expect(beats[0]!.beatCount).toBeGreaterThan(0);
    expect(exchange.some((turn) => turn.kind === 'heartbeat')).toBe(false);
  });
});

describe('a task id that is not in the database', () => {
  it('is a 404, not an empty detail — the id was pasted wrong, or a reset deleted it', async () => {
    harness = await serve(new FixtureBuilder().task({ id: 'task_real', createdAt: AT }).write(tempDbPath()));

    const response = await harness.task('task_gone');

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toContain('task_gone');
  });

  it('is a 404 for an empty id, and does not fall through to the frontend bundle', async () => {
    harness = await serve(new FixtureBuilder().task({ id: 'task_real', createdAt: AT }).write(tempDbPath()));

    expect((await harness.task('')).status).toBe(404);
  });
});

/**
 * Drift (#21): an inspector that reads a column an older Orca does not have would throw, and a
 * thrown query here is a hard-fail this tool has no right to take (SPEC §5). Each body it cannot
 * read costs exactly itself, and says so on screen.
 */
describe('an Orca whose columns this build has never seen', () => {
  it('serves the detail without the body it cannot read, and names the feature in meta.degraded', async () => {
    const dbPath = new FixtureBuilder({ omitColumns: { tasks: ['result'] } })
      .task({ id: 'task_done', handle: COORDINATOR, spec: 'The prompt.', status: 'completed', createdAt: AT })
      .dispatch({ taskId: 'task_done', assigneeHandle: FIRST_WORKER, status: 'completed', dispatchedAt: at(1) })
      .write(tempDbPath());
    harness = await serve(dbPath);

    const detail = await detailOf('task_done');

    expect(detail.spec).toBe('The prompt.');
    expect(detail.result).toBeNull();
    // …and the user is told why the receipt is missing, rather than left to wonder.
    expect((await harness.snapshot()).meta.degraded.join(' ')).toContain('result');
    // The rest of the detail is untouched: one missing column, one missing feature.
    expect(detail.attempts).toHaveLength(1);
  });

  it('still answers when the dispatch table has no task_id to filter attempts by', async () => {
    const dbPath = new FixtureBuilder({ omitColumns: { dispatch_contexts: ['task_id'] } })
      .task({ id: 'task_done', handle: COORDINATOR, spec: 'The prompt.', status: 'completed', createdAt: AT })
      // The row is there; nothing in the file says which task it belongs to. An attempt that
      // cannot be attached to a task is not an attempt this route can honestly report.
      .dispatch({ taskId: 'task_done', assigneeHandle: FIRST_WORKER, status: 'completed', dispatchedAt: at(1) })
      .write(tempDbPath());
    harness = await serve(dbPath);

    const detail = await detailOf('task_done');

    expect(detail.attempts).toEqual([]);
    expect((await harness.snapshot()).meta.degraded.join(' ')).toContain('dispatch_contexts.task_id');
  });
});
