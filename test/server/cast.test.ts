import { afterEach, describe, expect, it } from 'vitest';
import type { Run } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { liveShapeCorpus } from '../fixtures/corpus.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * **The cast** — the orchestrator, and the agents it spawned (SPEC §4.3a).
 *
 * The database has always known exactly who coordinated and who did the work, and neither ever
 * appeared on screen. `tasks.created_by_terminal_handle` is the orchestrator;
 * `dispatch_contexts.assignee_handle` is an agent. That is the whole model — the tool simply never
 * named it — and every rule below is a shape the schema forces on the naming:
 *
 * - **Every attempt's assignee**, not just the surviving one: a retry goes to a *fresh* terminal.
 * - **The orchestrator is never in its own cast**, or the conversation loses its sense of direction.
 * - **The monogram is stable and ordered**, or the same agent is `A1` on the node and `A3` in the rail.
 */

const AT = new Date('2026-07-08T12:00:00Z');
const MINUTE = 60_000;

const ORCHESTRATOR = handleFor('orchestrator');
const ALICE = handleFor('alice');
const BOB = handleFor('bob');
const CAROL = handleFor('carol');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function at(offsetMs: number): Date {
  return new Date(AT.getTime() + offsetMs);
}

async function runsOf(builder: FixtureBuilder): Promise<Run[]> {
  harness = await serve(builder.write(tempDbPath()));
  return (await harness.snapshot()).snapshot.runs;
}

function byHandle(runs: Run[], handle: string | null): Run {
  const run = runs.find((candidate) => candidate.handle === handle);
  if (!run) throw new Error(`no run for handle ${handle} in the snapshot`);
  return run;
}

describe('the agents are the assignees of the orchestrator’s dispatch contexts', () => {
  it('names every terminal the orchestrator dispatched work to', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: ORCHESTRATOR, createdAt: at(0) })
        .task({ id: 'task_2', handle: ORCHESTRATOR, createdAt: at(MINUTE) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
        .dispatch({ taskId: 'task_2', assigneeHandle: BOB, dispatchedAt: at(2 * MINUTE) })
    );

    expect(byHandle(runs, ORCHESTRATOR).cast.map((member) => member.handle)).toEqual([ALICE, BOB]);
  });

  it('counts every task an agent held, and lists their ids', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: ORCHESTRATOR, createdAt: at(0) })
        .task({ id: 'task_2', handle: ORCHESTRATOR, createdAt: at(MINUTE) })
        .task({ id: 'task_3', handle: ORCHESTRATOR, createdAt: at(2 * MINUTE) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
        .dispatch({ taskId: 'task_2', assigneeHandle: ALICE, dispatchedAt: at(2 * MINUTE) })
        .dispatch({ taskId: 'task_3', assigneeHandle: BOB, dispatchedAt: at(3 * MINUTE) })
    );

    const [alice, bob] = byHandle(runs, ORCHESTRATOR).cast;

    expect(alice).toMatchObject({ handle: ALICE, taskCount: 2, taskIds: ['task_1', 'task_2'] });
    expect(bob).toMatchObject({ handle: BOB, taskCount: 1, taskIds: ['task_3'] });
  });

  it('keeps the agent a retry replaced — its handle exists nowhere else on the wire', async () => {
    // The trap: `Task.dispatch` is only the LATEST attempt (`MAX(rowid)`). A retry goes to a fresh
    // worktree with a fresh terminal handle, so a cast built from the surviving attempt alone would
    // silently delete the agent that failed — which is the one a post-mortem came looking for.
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: ORCHESTRATOR, status: 'completed', createdAt: at(0), completedAt: at(9 * MINUTE) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, status: 'failed', failureCount: 1, dispatchedAt: at(MINUTE) })
        .dispatch({ taskId: 'task_1', assigneeHandle: BOB, status: 'completed', dispatchedAt: at(5 * MINUTE) })
    );

    const cast = byHandle(runs, ORCHESTRATOR).cast;

    expect(cast.map((member) => member.handle)).toEqual([ALICE, BOB]);
    // Both held the task — so selecting either keeps the node lit on the canvas.
    expect(cast.map((member) => member.taskIds)).toEqual([['task_1'], ['task_1']]);
  });

  it('leaves the orchestrator out of its own cast when it dispatched a task to itself', async () => {
    // Direction in the conversation is decided by "did one of the agents say it?" — so an
    // orchestrator that appeared in its own cast would make its every utterance incoming.
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: ORCHESTRATOR, createdAt: at(0) })
        .task({ id: 'task_2', handle: ORCHESTRATOR, createdAt: at(MINUTE) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ORCHESTRATOR, dispatchedAt: at(MINUTE) })
        .dispatch({ taskId: 'task_2', assigneeHandle: ALICE, dispatchedAt: at(2 * MINUTE) })
    );

    expect(byHandle(runs, ORCHESTRATOR).cast.map((member) => member.handle)).toEqual([ALICE]);
  });

  it('gives the null-handle bucket a cast — no orchestrator on record is not no agents', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: null, createdAt: at(0) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
    );

    expect(byHandle(runs, null).cast.map((member) => member.handle)).toEqual([ALICE]);
  });
});

describe('the monogram', () => {
  it('numbers the agents in first-dispatch order, not in task-creation order', async () => {
    // The orchestrator created the tasks in one order and handed them out in another — which is
    // ordinary, and which is why the numbering is keyed on the dispatch and not on the task.
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: ORCHESTRATOR, createdAt: at(0) })
        .task({ id: 'task_2', handle: ORCHESTRATOR, createdAt: at(MINUTE) })
        .dispatch({ taskId: 'task_2', assigneeHandle: BOB, dispatchedAt: at(2 * MINUTE) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(30 * MINUTE) })
    );

    expect(byHandle(runs, ORCHESTRATOR).cast.map((member) => [member.monogram, member.handle])).toEqual([
      ['A1', BOB],
      ['A2', ALICE],
    ]);
  });

  it('is stable across reads of an unchanged database', async () => {
    // A cast that renumbered itself between two polls would repaint every stripe on the canvas and
    // move the agent under the user's pointer. The tie-break on the handle is what prevents it: all
    // three of these were dispatched in the same second.
    const builder = new FixtureBuilder()
      .task({ id: 'task_1', handle: ORCHESTRATOR, createdAt: at(0) })
      .task({ id: 'task_2', handle: ORCHESTRATOR, createdAt: at(0) })
      .task({ id: 'task_3', handle: ORCHESTRATOR, createdAt: at(0) })
      .dispatch({ taskId: 'task_1', assigneeHandle: CAROL, dispatchedAt: at(MINUTE) })
      .dispatch({ taskId: 'task_2', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
      .dispatch({ taskId: 'task_3', assigneeHandle: BOB, dispatchedAt: at(MINUTE) });

    harness = await serve(builder.write(tempDbPath()));

    const first = (await harness.snapshot()).snapshot.runs;
    const second = (await harness.snapshot()).snapshot.runs;

    expect(byHandle(first, ORCHESTRATOR).cast).toEqual(byHandle(second, ORCHESTRATOR).cast);
  });
});

describe('last seen', () => {
  it('takes the agent’s latest heartbeat across every task it holds', async () => {
    // An agent beating on *one* task is alive, whatever its other tasks say — so the badge is the
    // agent's, and not any one dispatch row's.
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: ORCHESTRATOR, createdAt: at(0) })
        .task({ id: 'task_2', handle: ORCHESTRATOR, createdAt: at(MINUTE) })
        .dispatch({
          taskId: 'task_1',
          assigneeHandle: ALICE,
          dispatchedAt: at(MINUTE),
          lastHeartbeatAt: at(10 * MINUTE),
        })
        .dispatch({
          taskId: 'task_2',
          assigneeHandle: ALICE,
          dispatchedAt: at(2 * MINUTE),
          lastHeartbeatAt: at(40 * MINUTE),
        })
    );

    expect(byHandle(runs, ORCHESTRATOR).cast[0]!.lastHeartbeatAt).toBe(at(40 * MINUTE).toISOString());
  });

  it('is null on a pre-v2 Orca, which costs the badge and nothing else', async () => {
    const runs = await runsOf(
      liveShapeCorpus({ userVersion: 1 })
    );

    for (const run of runs) {
      for (const member of run.cast) expect(member.lastHeartbeatAt).toBeNull();
    }

    // …and the cast itself survives, which is the whole of per-feature degradation.
    expect(runs.some((run) => run.cast.length > 0)).toBe(true);
  });
});

describe('against the live-shaped corpus', () => {
  it('gives every orchestrator that dispatched anything a cast', async () => {
    const runs = await runsOf(liveShapeCorpus());

    const dispatching = runs.filter((run) => run.taskCount > 0 && run.statusCounts.pending !== run.taskCount);

    expect(dispatching.length).toBeGreaterThan(0);
    for (const run of dispatching) expect(run.cast.length).toBeGreaterThan(0);
  });

  it('never lets an agent’s task count exceed its orchestrator’s', async () => {
    const runs = await runsOf(liveShapeCorpus());

    for (const run of runs) {
      for (const member of run.cast) {
        expect(member.taskCount).toBeLessThanOrEqual(run.taskCount);
        expect(member.taskCount).toBe(member.taskIds.length);
      }
    }
  });

  it('never names an orchestrator among its own agents', async () => {
    const runs = await runsOf(liveShapeCorpus());

    for (const run of runs) {
      expect(run.cast.some((member) => member.handle === run.handle)).toBe(false);
    }
  });
});

describe('degradation (SPEC §5)', () => {
  it('loses the cast, by name, when dispatch_contexts.assignee_handle is gone', async () => {
    harness = await serve(
      liveShapeCorpus({ omitColumns: { dispatch_contexts: ['assignee_handle'] } }).write(tempDbPath())
    );

    const { meta, snapshot } = await harness.snapshot();

    // The whole point of `FEATURES`: the feature goes, and the user is told which one and why.
    expect(meta.degraded.join('\n')).toMatch(/The cast/);
    expect(snapshot.runs.every((run) => run.cast.length === 0)).toBe(true);

    // …and the graph is untouched. A missing column costs exactly the feature that needed it.
    expect(snapshot.tasks.length).toBeGreaterThan(70);
  });
});
