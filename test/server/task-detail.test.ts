import { afterEach, describe, expect, it } from 'vitest';
import type { TaskDetail } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor, syntheticId } from '../fixtures/builder.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
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

  it('are this task\'s, in sequence order, and no other task\'s', async () => {
    harness = await serve(fixture());

    const detail = await detailOf('task_one');

    expect(detail.messages.map((message) => message.subject)).toEqual([
      'Dispatched: One',
      'alive',
      'Done: One',
    ]);
    expect(detail.messages.map((message) => message.sequence)).toEqual([1, 3, 5]);
  });

  it('include the heartbeats — hiding 65% of the traffic is the client\'s call, not the wire\'s', async () => {
    harness = await serve(fixture());

    const detail = await detailOf('task_one');

    // The same rule the feed follows (SPEC §7.7): the server sends every message, and the
    // panel decides what to show. A payload that dropped them would put rows behind a filter
    // the user can turn off.
    expect(detail.messages.some((message) => message.type === 'heartbeat')).toBe(true);
  });

  it('carry the same shape the feed rows do, so one row component renders both', async () => {
    harness = await serve(fixture());

    const done = (await detailOf('task_one')).messages.find((message) => message.type === 'worker_done')!;

    expect(done).toMatchObject({
      fromHandle: FIRST_WORKER,
      toHandle: COORDINATOR,
      subject: 'Done: One',
      body: 'Three sentences.',
      taskId: 'task_one',
      payload: { taskId: 'task_one' },
      createdAt: at(5).toISOString(),
    });
    // Placed in the same run the task was inferred into — a gate or a feed row would be too.
    expect(done.runId).not.toBeNull();
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
