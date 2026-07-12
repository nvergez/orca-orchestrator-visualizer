import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run, Task } from '../../src/shared/types.ts';
import { shortHandle } from '../../src/shared/handles.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { liveShapeCorpus } from '../fixtures/corpus.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve, type ServeOptions } from './harness.ts';

/**
 * Seam 1 (#12): the runs in `GET /api/snapshot`, driven by a real fixture database.
 *
 * **The schema has no run id.** A run is inferred, and every rule of the inference was paid
 * for by a shape the live database really has — so each one is asserted here against a
 * fixture that reproduces that shape:
 *
 * - **Handle is the primary key; time is only the tiebreaker.** Two handles genuinely overlap
 *   in time, and a time-first clustering would merge unrelated orchestrations.
 * - **Six hours, not minutes.** A real 13-task run spans 20:10 → 07:04 overnight.
 * - **Null handles do not vanish.** 4 of 76 live tasks have none; they are one run, not none.
 * - **The ids survive a restart**, because a rail whose rows change identity on every boot
 *   cannot hold a selection.
 */

const AT = new Date('2026-07-08T12:00:00Z');
const HOUR = 60 * 60 * 1000;

const ALPHA = handleFor('alpha');
const BETA = handleFor('beta');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** A database served with Orca *running* — one of the two things `run.live` still takes. */
async function serveLive(dbPath: string, options: ServeOptions = {}): Promise<Harness> {
  writeFileSync(join(dirname(dbPath), 'orca-runtime.json'), JSON.stringify({ pid: 4242 }));
  return serve(dbPath, { probe: (pid) => pid === 4242, ...options });
}

async function runsOf(builder: FixtureBuilder): Promise<Run[]> {
  harness = await serve(builder.write(tempDbPath()));
  return (await harness.snapshot()).snapshot.runs;
}

async function snapshotOf(builder: FixtureBuilder): Promise<{ runs: Run[]; tasks: Task[] }> {
  harness = await serve(builder.write(tempDbPath()));
  const { snapshot } = await harness.snapshot();
  return snapshot;
}

function at(offsetMs: number): Date {
  return new Date(AT.getTime() + offsetMs);
}

/** The tasks a run holds — the canvas renders exactly these and nothing else. */
function tasksOf(tasks: Task[], run: Run): Task[] {
  return tasks.filter((task) => task.runId === run.id);
}

function byId(runs: Run[], id: string): Run {
  const run = runs.find((candidate) => candidate.id === id);
  if (!run) throw new Error(`no run ${id} in the snapshot`);
  return run;
}

describe('bucketing: the handle is the key, the clock is only the tiebreaker', () => {
  it('keeps two orchestrations that genuinely overlapped in time as two runs', async () => {
    // The shape the rule exists for: alpha and beta interleave minute by minute. A
    // time-first clustering would read this as one run and merge unrelated work.
    const { runs, tasks } = await snapshotOf(
      new FixtureBuilder()
        .task({ id: 'task_a1', handle: ALPHA, createdAt: at(0) })
        .task({ id: 'task_b1', handle: BETA, createdAt: at(5 * 60_000) })
        .task({ id: 'task_a2', handle: ALPHA, createdAt: at(10 * 60_000) })
        .task({ id: 'task_b2', handle: BETA, createdAt: at(15 * 60_000) })
        .task({ id: 'task_a3', handle: ALPHA, createdAt: at(20 * 60_000) })
    );

    expect(runs).toHaveLength(2);

    const alpha = runs.find((run) => run.handle === ALPHA)!;
    const beta = runs.find((run) => run.handle === BETA)!;

    expect(tasksOf(tasks, alpha).map((task) => task.id)).toEqual(['task_a1', 'task_a2', 'task_a3']);
    expect(tasksOf(tasks, beta).map((task) => task.id)).toEqual(['task_b1', 'task_b2']);
  });

  it('gives every task a run id, and the runs between them account for every task', async () => {
    const { runs, tasks } = await snapshotOf(
      new FixtureBuilder()
        .task({ handle: ALPHA, createdAt: at(0) })
        .task({ handle: BETA, createdAt: at(60_000) })
        .task({ handle: null, createdAt: at(120_000) })
    );

    expect(tasks.every((task) => task.runId !== '')).toBe(true);
    expect(runs.reduce((total, run) => total + run.taskCount, 0)).toBe(tasks.length);
    // A run id on a task that names no run in the rail would leave the task unreachable.
    expect(new Set(tasks.map((task) => task.runId))).toEqual(new Set(runs.map((run) => run.id)));
  });
});

/**
 * **The six-hour rule, demoted from an identity to a wave** (SPEC §4.3).
 *
 * It used to decide what a rail row *was*: a terminal reused across four days silently became
 * several unrelated rows, and nothing on screen ever said why. The user saw the consequences of a
 * boundary they were never shown.
 *
 * Same threshold, new job. One handle is now **one** orchestrator, and the gap is drawn on the
 * canvas as a bordered region captioned with the silence that opened it. The tests below are the
 * old splitting tests, asking the same questions of the waves.
 */
describe('waves: an idle gap of more than six hours', () => {
  it('holds one wave together across an overnight gap — a real 13-task run spans 20:10 → 07:04', async () => {
    const { runs, tasks } = await snapshotOf(
      new FixtureBuilder()
        .task({ id: 'task_evening', handle: ALPHA, createdAt: at(0) })
        .task({ id: 'task_morning', handle: ALPHA, createdAt: at(5 * HOUR) })
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]!.waves).toHaveLength(1);
    expect(tasksOf(tasks, runs[0]!).map((task) => task.id)).toEqual(['task_evening', 'task_morning']);
  });

  it('opens a second wave when the same terminal went quiet for seven — and stays ONE orchestrator', async () => {
    // The heart of the change. Before: two rows in the rail, no explanation. Now: one row, two
    // waves, and the gap written on the border of the second one.
    const { runs, tasks } = await snapshotOf(
      new FixtureBuilder()
        .task({ id: 'task_yesterday', handle: ALPHA, createdAt: at(0) })
        .task({ id: 'task_today', handle: ALPHA, createdAt: at(7 * HOUR) })
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]!.handle).toBe(ALPHA);
    // Both tasks are one orchestrator's, so the canvas draws them together…
    expect(tasksOf(tasks, runs[0]!).map((task) => task.id)).toEqual(['task_yesterday', 'task_today']);

    // …in two regions, and the second one says how long the silence was.
    expect(runs[0]!.waves).toHaveLength(2);
    expect(runs[0]!.waves[0]).toMatchObject({ index: 1, taskIds: ['task_yesterday'], idleGapBeforeMs: null });
    expect(runs[0]!.waves[1]).toMatchObject({ index: 2, taskIds: ['task_today'], idleGapBeforeMs: 7 * HOUR });
  });

  it('ends each wave at its own newest evidence — attempts included, later waves excluded', async () => {
    // The same evidence set as `lastActivityAt`, restricted to the wave's tasks and attempts
    // (SPEC §12.2): the first wave ends at its worker's last heartbeat, not at the creation
    // instant of a task that belongs to the next wave.
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_yesterday', handle: ALPHA, status: 'dispatched', createdAt: at(0) })
        .dispatch({ taskId: 'task_yesterday', assigneeHandle: handleFor('worker'), dispatchedAt: at(1), lastHeartbeatAt: at(HOUR) })
        .task({ id: 'task_today', handle: ALPHA, status: 'completed', createdAt: at(8 * HOUR), completedAt: at(9 * HOUR) })
    );

    expect(runs[0]!.waves).toHaveLength(2);
    expect(runs[0]!.waves[0]!.endedAt).toBe(at(HOUR).toISOString());
    expect(runs[0]!.waves[1]!.endedAt).toBe(at(9 * HOUR).toISOString());
  });

  it('opens a wave on *more* than six hours, so a pause of exactly six does not cut one', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ handle: ALPHA, createdAt: at(0) })
        .task({ handle: ALPHA, createdAt: at(6 * HOUR) })
    );

    expect(runs[0]!.waves).toHaveLength(1);
  });

  it('measures the gap between consecutive tasks, not from the first — a long run never cuts on its own length', async () => {
    // Ten tasks, five hours apart: 45 hours end to end, and not one gap over six.
    const builder = new FixtureBuilder();
    for (let i = 0; i < 10; i++) builder.task({ handle: ALPHA, createdAt: at(i * 5 * HOUR) });

    const runs = await runsOf(builder);

    expect(runs).toHaveLength(1);
    expect(runs[0]!.waves).toHaveLength(1);
  });

  it('gives every orchestrator at least one wave, and accounts for every task exactly once', async () => {
    // The canvas lays out wave by wave (`client/canvas/layout.ts`), so a task in no wave is a node
    // that never gets drawn — the one thing this tool must never do.
    const runs = await runsOf(liveShapeCorpus());

    for (const run of runs) {
      expect(run.waves.length).toBeGreaterThan(0);
      const inWaves = run.waves.flatMap((wave) => wave.taskIds);
      expect(inWaves).toHaveLength(run.taskCount);
      expect(new Set(inWaves).size).toBe(run.taskCount);
    }
  });

  it('does not open a wave over a task whose created_at is unreadable', async () => {
    // Nothing in this schema validates a TEXT column. An unparseable instant read as `0` would sit
    // 56 years before the next task and open a ghost wave dated 1970 — so the run is dated by the
    // tasks that *have* a readable time, and the odd one joins the wave it is beside.
    const dbPath = new FixtureBuilder()
      .task({ id: 'task_readable', handle: ALPHA, createdAt: AT })
      .task({ id: 'task_broken', handle: ALPHA, createdAt: at(60_000) })
      .write(tempDbPath());
    corruptColumn(dbPath, 'tasks', 'created_at', 'whenever', 'id', 'task_broken');
    harness = await serve(dbPath);

    const { runs, tasks } = (await harness.snapshot()).snapshot;

    expect(runs).toHaveLength(1);
    expect(runs[0]!.waves).toHaveLength(1);
    expect(runs[0]!.startedAt).toBe(AT.toISOString());
    expect(tasksOf(tasks, runs[0]!).map((task) => task.id)).toContain('task_broken');
  });

  it('gives the null-handle bucket one wave — a gap between two orphans measures nobody', async () => {
    // Those tasks share nothing but the *absence* of a handle. They were never one terminal's work,
    // so a two-day gap between two of them is not a pause anybody took.
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ handle: null, createdAt: at(0) })
        .task({ handle: null, createdAt: at(48 * HOUR) })
    );

    expect(runs[0]!.waves).toHaveLength(1);
  });
});

/** The fixture builder always writes a real timestamp, so a corrupt column has to be forged. */
function corruptColumn(
  dbPath: string,
  table: 'tasks' | 'dispatch_contexts',
  column: string,
  value: string,
  keyColumn: string,
  key: string
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${keyColumn} = ?`).run(value, key);
  } finally {
    db.close();
  }
}

describe('the tasks Orca never attributed to a terminal', () => {
  it('collects every null-handle task into exactly one run, however far apart they are', async () => {
    // 4 of 76 live tasks have no `created_by_terminal_handle`. They must not vanish — and
    // they are one run, so the six-hour split does not apply to them: two days separate the
    // first from the last here, and there is still exactly one `run_unattributed`.
    const { runs, tasks } = await snapshotOf(
      new FixtureBuilder()
        .task({ id: 'task_orphan_one', handle: null, createdAt: at(0) })
        .task({ id: 'task_orphan_two', handle: null, createdAt: at(20 * HOUR) })
        .task({ id: 'task_orphan_three', handle: null, createdAt: at(48 * HOUR) })
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe('run_unattributed');
    expect(runs[0]!.handle).toBeNull();
    expect(tasksOf(tasks, runs[0]!)).toHaveLength(3);
  });

  it('names it Unattributed rather than dressing it up as an orchestration', async () => {
    // The row is honest about what it is: these tasks have no terminal, and the rail says so.
    const runs = await runsOf(
      new FixtureBuilder().task({ handle: null, title: 'Some titled task', createdAt: AT })
    );

    expect(runs[0]!.label).toBe('Unattributed');
  });

  it('sits in the rail beside the real runs rather than replacing them', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ handle: ALPHA, createdAt: at(0) })
        .task({ handle: null, createdAt: at(60_000) })
    );

    expect(runs.map((run) => run.id)).toContain('run_unattributed');
    expect(runs).toHaveLength(2);
  });
});

describe('the run id: the handle, and nothing else', () => {
  it('is the same across a restart, so the rail can hold a selection', async () => {
    // The rail holds a selection across a restart only if the ids do. Two servers, one file.
    const dbPath = new FixtureBuilder()
      .task({ handle: ALPHA, createdAt: at(0) })
      .task({ handle: BETA, createdAt: at(HOUR) })
      .task({ handle: null, createdAt: at(2 * HOUR) })
      .write(tempDbPath());

    const first = await serve(dbPath);
    const before = (await first.snapshot()).snapshot.runs.map((run) => run.id);
    await first.close();

    harness = await serve(dbPath);
    const after = (await harness.snapshot()).snapshot.runs.map((run) => run.id);

    expect(after).toEqual(before);
    expect(new Set(after).size).toBe(3);
  });

  it('reads `run_<handle>`', async () => {
    const runs = await runsOf(new FixtureBuilder().task({ handle: ALPHA, createdAt: AT }));

    expect(runs[0]!.id).toBe(`run_${ALPHA}`);
  });

  it('does not change when the orchestrator dispatches its next task', async () => {
    // The old id carried the epoch seconds of a *segment's* first task, which the six-hour split
    // made necessary. It also made a row's identity depend on a task — so an orchestrator picking
    // its work up again after a long night would have had its id change under the user's selection.
    const before = await runsOf(new FixtureBuilder().task({ handle: ALPHA, createdAt: at(0) }));

    await harness!.close();
    harness = undefined;

    const after = await runsOf(
      new FixtureBuilder()
        .task({ handle: ALPHA, createdAt: at(0) })
        .task({ handle: ALPHA, createdAt: at(7 * HOUR) })
    );

    expect(after.map((run) => run.id)).toEqual(before.map((run) => run.id));
  });
});

describe('the run label: what the orchestration was trying to do', () => {
  it('falls back from the earliest task title, to its display name, to the short handle', async () => {
    const GAMMA = handleFor('gamma');

    const runs = await runsOf(
      new FixtureBuilder()
        // The *earliest* task names the run — a later one must not steal the label.
        .task({ handle: ALPHA, title: 'Ship the visualizer', createdAt: at(0) })
        .task({ handle: ALPHA, title: 'A later task', createdAt: at(60_000) })
        .task({ handle: BETA, title: null, displayName: 'Only a display name', createdAt: at(0) })
        .task({ handle: GAMMA, title: null, displayName: null, createdAt: at(0) })
    );

    expect(runs.find((run) => run.handle === ALPHA)!.label).toBe('Ship the visualizer');
    expect(runs.find((run) => run.handle === BETA)!.label).toBe('Only a display name');
    // Nothing named it, so the rail says which terminal ran it — never a blank row.
    expect(runs.find((run) => run.handle === GAMMA)!.label).toBe(shortHandle(GAMMA));
  });
});

describe('what a rail row has to show without opening the run', () => {
  it('carries the window, the task count and the status breakdown', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ handle: ALPHA, status: 'completed', createdAt: at(0), completedAt: at(30 * 60_000) })
        .task({ handle: ALPHA, status: 'completed', createdAt: at(60_000), completedAt: at(20 * 60_000) })
        .task({ handle: ALPHA, status: 'failed', createdAt: at(120_000) })
        .task({ handle: ALPHA, status: 'dispatched', createdAt: at(180_000) })
    );

    expect(runs[0]).toMatchObject({
      taskCount: 4,
      startedAt: AT.toISOString(),
      // The run ends at its last *completion*, not its last creation — the work outlives
      // the dispatch that started it.
      endedAt: at(30 * 60_000).toISOString(),
    });
    expect(runs[0]!.statusCounts).toMatchObject({ completed: 2, failed: 1, dispatched: 1, pending: 0 });
  });

  it('ends a run at its last creation when nothing in it ever completed', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ handle: ALPHA, status: 'pending', createdAt: at(0) })
        .task({ handle: ALPHA, status: 'ready', createdAt: at(90 * 60_000) })
    );

    expect(runs[0]!.endedAt).toBe(at(90 * 60_000).toISOString());
  });

  it('counts a status it has never heard of rather than dropping the task from the tally', async () => {
    const runs = await runsOf(
      new FixtureBuilder({ allowUnknownEnums: true })
        .task({ handle: ALPHA, status: 'quarantined', createdAt: at(0) })
        .task({ handle: ALPHA, status: 'completed', createdAt: at(60_000) })
    );

    expect(runs[0]!.taskCount).toBe(2);
    expect(runs[0]!.statusCounts.quarantined).toBe(1);
  });

  it('sorts the rail by most-recent activity, so the run to open is the one on top', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ handle: ALPHA, createdAt: at(0) })
        .task({ handle: BETA, createdAt: at(2 * HOUR) })
        .task({ handle: null, createdAt: at(HOUR) })
    );

    expect(runs.map((run) => run.handle)).toEqual([BETA, null, ALPHA]);
  });

  it('sorts by lastActivityAt, so a run still producing evidence outranks a merely newer one', async () => {
    // Alpha's last *task* is older than beta's, but its worker kept beating for three hours.
    // Ordering on task timestamps alone would bury the run that is actually moving (SPEC §12.2).
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_a', handle: ALPHA, status: 'dispatched', createdAt: at(0) })
        .dispatch({ taskId: 'task_a', assigneeHandle: handleFor('worker'), dispatchedAt: at(1), lastHeartbeatAt: at(3 * HOUR) })
        .task({ handle: BETA, createdAt: at(2 * HOUR) })
    );

    expect(runs.map((run) => run.handle)).toEqual([ALPHA, BETA]);
  });
});

/**
 * Convergence is a property of task state alone (SPEC §12.1): every task terminal —
 * `completed` or `failed` — and nothing else. It is not recency and it is not Orca's process;
 * those are the other two facts, and keeping the three apart is the whole of #48.
 */
describe('convergence: terminal task outcomes only', () => {
  it('does not converge a run that is only pending, or only blocked — that work can still move', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ handle: ALPHA, status: 'pending', createdAt: at(0) })
        .task({ handle: BETA, status: 'blocked', createdAt: at(60_000) })
    );

    expect(runs.find((run) => run.handle === ALPHA)!.converged).toBe(false);
    expect(runs.find((run) => run.handle === BETA)!.converged).toBe(false);
  });

  it('converges a run whose every task is completed or failed', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ handle: ALPHA, status: 'completed', createdAt: at(0), completedAt: at(60_000) })
        .task({ handle: ALPHA, status: 'failed', createdAt: at(120_000) })
    );

    expect(runs[0]!.converged).toBe(true);
  });

  it('holds convergence back while any task is still in flight', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ handle: ALPHA, status: 'completed', createdAt: at(0), completedAt: at(60_000) })
        .task({ handle: ALPHA, status: 'dispatched', createdAt: at(120_000) })
    );

    expect(runs[0]!.converged).toBe(false);
  });

  it('treats a status it has never heard of as not converged — render-what-parses cannot prove it terminal', async () => {
    const runs = await runsOf(
      new FixtureBuilder({ allowUnknownEnums: true }).task({
        handle: ALPHA,
        status: 'quarantined',
        createdAt: at(0),
      })
    );

    expect(runs[0]!.converged).toBe(false);
  });

  it('never lets a dispatch attempt outvote the task status', async () => {
    // The attempt says `completed`; the task row still says `dispatched`. The task is the
    // record of the outcome, and an attempt that finished is not a task that did (SPEC §12.1).
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_a', handle: ALPHA, status: 'dispatched', createdAt: at(0) })
        .dispatch({ taskId: 'task_a', assigneeHandle: BETA, status: 'completed', dispatchedAt: at(1), completedAt: at(60_000) })
    );

    expect(runs[0]!.converged).toBe(false);
  });
});

/**
 * `lastActivityAt` — the newest readable evidence that recorded work happened (SPEC §12.2). Task
 * creation and completion were already counted; what #48 adds is every dispatch attempt's four
 * timestamps, because dispatch, heartbeat, completion and failure evidence can all be newer than
 * anything on the task rows — and rail ordering, default selection and the attribution tail all
 * hang off this one instant.
 */
describe('last activity: every task and every dispatch attempt gets a vote', () => {
  it('counts a dispatch newer than every task timestamp', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_a', handle: ALPHA, status: 'dispatched', createdAt: at(0) })
        .dispatch({ taskId: 'task_a', assigneeHandle: BETA, dispatchedAt: at(20 * 60_000) })
    );

    expect(runs[0]!.lastActivityAt).toBe(at(20 * 60_000).toISOString());
  });

  it('counts a heartbeat — the run was producing evidence long after its last task was created', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_a', handle: ALPHA, status: 'dispatched', createdAt: at(0) })
        .dispatch({ taskId: 'task_a', assigneeHandle: BETA, dispatchedAt: at(1), lastHeartbeatAt: at(3 * HOUR) })
    );

    expect(runs[0]!.lastActivityAt).toBe(at(3 * HOUR).toISOString());
  });

  it('counts an attempt completion and an attempt failure', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_a', handle: ALPHA, status: 'completed', createdAt: at(0), completedAt: at(60_000) })
        .dispatch({ taskId: 'task_a', assigneeHandle: BETA, dispatchedAt: at(1), completedAt: at(30 * 60_000) })
        .task({ id: 'task_b', handle: BETA, status: 'failed', createdAt: at(0) })
        .dispatch({ taskId: 'task_b', assigneeHandle: ALPHA, dispatchedAt: at(1), lastFailure: at(45 * 60_000) })
    );

    expect(runs.find((run) => run.handle === ALPHA)!.lastActivityAt).toBe(at(30 * 60_000).toISOString());
    expect(runs.find((run) => run.handle === BETA)!.lastActivityAt).toBe(at(45 * 60_000).toISOString());
  });

  it('reads every attempt, not only the surviving one — an earlier retry can hold the newest evidence', async () => {
    // Attempt 1 kept beating until 90 minutes in; attempt 2 — the `MAX(rowid)` the node badge
    // shows — was dispatched at 20 and never spoke again. Folding to the latest attempt would
    // erase the newest activity this run ever recorded (SPEC §12.2).
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_a', handle: ALPHA, status: 'dispatched', createdAt: at(0) })
        .dispatch({ taskId: 'task_a', assigneeHandle: BETA, dispatchedAt: at(1), lastHeartbeatAt: at(90 * 60_000) })
        .dispatch({ taskId: 'task_a', assigneeHandle: BETA, dispatchedAt: at(20 * 60_000) })
    );

    expect(runs[0]!.lastActivityAt).toBe(at(90 * 60_000).toISOString());
  });

  it('ignores an unreadable timestamp — it is not the epoch, and it must not win either', async () => {
    // Nothing in this schema validates a TEXT column. Read as `0` the garbage would date the
    // run in 1970; and the unreadable-sorts-last convention (`time.ts`) means that taken at
    // face value it would *out-sort* every real instant. Neither: it simply does not vote
    // (SPEC §12.2), and the readable dispatch beside it does.
    const dbPath = new FixtureBuilder()
      .task({ id: 'task_a', handle: ALPHA, status: 'dispatched', createdAt: AT })
      .dispatch({ taskId: 'task_a', assigneeHandle: BETA, dispatchedAt: at(10 * 60_000) })
      .write(tempDbPath());
    corruptColumn(dbPath, 'dispatch_contexts', 'last_heartbeat_at', 'whenever', 'task_id', 'task_a');
    harness = await serve(dbPath);

    const runs = (await harness.snapshot()).snapshot.runs;

    expect(runs[0]!.lastActivityAt).toBe(at(10 * 60_000).toISOString());
  });

  it('preserves the existing unreadable instant when nothing on the run parses at all', async () => {
    // A run always has a first task, and `startedAt` already reports its unreadable column
    // verbatim. When no candidate parses, `lastActivityAt` says the same thing rather than
    // inventing a time the database cannot support (SPEC §12.2).
    const dbPath = new FixtureBuilder()
      .task({ id: 'task_a', handle: ALPHA, status: 'dispatched', createdAt: AT })
      .write(tempDbPath());
    corruptColumn(dbPath, 'tasks', 'created_at', 'whenever', 'id', 'task_a');
    harness = await serve(dbPath);

    const runs = (await harness.snapshot()).snapshot.runs;

    expect(runs[0]!.lastActivityAt).toBe('whenever');
    expect(runs[0]!.lastActivityAt).toBe(runs[0]!.startedAt);
  });

  it('keeps the deprecated endedAt as an exact alias of lastActivityAt', async () => {
    // Byte-for-byte (SPEC §12.4): old consumers keep reading the field they know, and it now
    // tells them the truth the new field tells everyone else.
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_a', handle: ALPHA, status: 'dispatched', createdAt: at(0) })
        .dispatch({ taskId: 'task_a', assigneeHandle: BETA, dispatchedAt: at(1), lastHeartbeatAt: at(2 * HOUR) })
        .task({ handle: BETA, status: 'completed', createdAt: at(0), completedAt: at(60_000) })
    );

    for (const run of runs) expect(run.endedAt).toBe(run.lastActivityAt);
  });
});

/** `edgeCount: 0` is the edgeless empty state — 4 of 13 real runs have no dependencies at all. */
describe('the edge count', () => {
  it('counts the dependency edges inside the run', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_one', handle: ALPHA, createdAt: at(0) })
        .task({ id: 'task_two', handle: ALPHA, deps: ['task_one'], createdAt: at(60_000) })
        .task({ id: 'task_three', handle: ALPHA, deps: ['task_one', 'task_two'], createdAt: at(120_000) })
    );

    expect(runs[0]!.edgeCount).toBe(3);
  });

  it('reports zero for a run whose tasks were all dispatched independently', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ handle: ALPHA, createdAt: at(0) })
        .task({ handle: ALPHA, createdAt: at(60_000) })
    );

    expect(runs[0]!.edgeCount).toBe(0);
  });

  it('does not count an edge whose other end is in another run, or was deleted by a reset', async () => {
    // No foreign keys in this schema (SPEC §4.2, trap 8): `deps` can name a task in a
    // different orchestration, or one that no longer exists. The canvas draws neither, so
    // neither may raise the count that decides whether the canvas is edgeless.
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_elsewhere', handle: BETA, createdAt: at(0) })
        .task({
          id: 'task_here',
          handle: ALPHA,
          deps: ['task_elsewhere', 'task_wiped_by_reset'],
          createdAt: at(60_000),
        })
    );

    expect(runs.find((run) => run.handle === ALPHA)!.edgeCount).toBe(0);
  });
});

/**
 * The deprecated `live` flag, kept as a snapshot-time compatibility projection:
 * `meta.liveness === 'live' && runHealth(run, snapshotNow) === 'active'` (SPEC §12.4). It can
 * no longer claim an abandoned dispatch is running just because Orca is open — the fix #48
 * exists for — and new clients ignore it entirely, deriving `RunHealth` themselves.
 */
describe('the deprecated live projection', () => {
  const builder = () =>
    new FixtureBuilder()
      .task({ handle: ALPHA, status: 'dispatched', createdAt: at(0) })
      .task({ handle: BETA, status: 'completed', createdAt: at(60_000), completedAt: at(120_000) });

  it('projects true for the active run, and only that one, while Orca is running', async () => {
    harness = await serveLive(builder().write(tempDbPath()), { now: () => at(5 * 60_000).getTime() });

    const { runs } = (await harness.snapshot()).snapshot;

    expect(runs.find((run) => run.handle === ALPHA)!.live).toBe(true);
    // A finished run is a finished run, however alive Orca is and however fresh its activity.
    expect(runs.find((run) => run.handle === BETA)!.live).toBe(false);
  });

  it('projects false for a stale dispatched row, even while Orca is running', async () => {
    // The false green dot this whole amendment exists to kill: the row has read `dispatched`
    // for four days, nothing will ever rewrite it, and a running Orca is not evidence that
    // *this run* is doing anything (SPEC §12.1). Silent, so not live.
    harness = await serveLive(builder().write(tempDbPath()), { now: () => at(4 * 24 * HOUR).getTime() });

    const { runs } = (await harness.snapshot()).snapshot;

    expect(runs.every((run) => run.live === false)).toBe(true);
  });

  it('projects false when Orca is not running, however recent the evidence', async () => {
    // Recent activity with a dead Orca is still an *active* run — health and process are
    // independent facts (SPEC §12.1) — but the old flag meant both at once, so it stays false.
    harness = await serve(builder().write(tempDbPath()), {
      probe: () => false,
      now: () => at(5 * 60_000).getTime(),
    });

    const { meta, snapshot } = await harness.snapshot();

    // No runtime file: Orca isn't running — `stale`, the last-known-state wording.
    expect(meta.liveness).toBe('stale');
    expect(snapshot.runs.every((run) => run.live === false)).toBe(true);
  });

  it('projects false when liveness is unknown — not-live means exactly `live`, nothing looser', async () => {
    // A malformed runtime file is the one state where the tool genuinely does not know. The
    // projection takes `liveness === 'live'` verbatim (SPEC §12.4), so `unknown` lands with
    // `stale`, however active the run's evidence is.
    const dbPath = builder().write(tempDbPath());
    writeFileSync(join(dirname(dbPath), 'orca-runtime.json'), 'not json at all');
    harness = await serve(dbPath, { probe: () => false, now: () => at(5 * 60_000).getTime() });

    const { meta, snapshot } = await harness.snapshot();

    expect(meta.liveness).toBe('unknown');
    expect(snapshot.runs.every((run) => run.live === false)).toBe(true);
  });
});

/**
 * `coordinator_runs` is **empty in practice** (SPEC §4.2, trap 3) — written only by Orca's
 * built-in Coordinator loop, which agent-driven coordination never uses. It is read and
 * rendered when rows exist, and **nothing depends on it**: it cannot be the run-scoping key.
 */
describe('coordinator_runs', () => {
  it('is empty, and the runs are inferred anyway', async () => {
    harness = await serve(new FixtureBuilder().task({ handle: ALPHA, createdAt: AT }).write(tempDbPath()));

    const { snapshot } = await harness.snapshot();

    expect(snapshot.coordinatorRuns).toEqual([]);
    expect(snapshot.runs).toHaveLength(1);
  });

  it('is carried through when a row does exist, with its timestamps normalized', async () => {
    harness = await serve(
      new FixtureBuilder()
        .task({ handle: ALPHA, createdAt: AT })
        .coordinatorRun({
          id: 'run_coordinator',
          spec: 'Decompose and dispatch',
          status: 'running',
          coordinatorHandle: ALPHA,
          pollIntervalMs: 2000,
          createdAt: AT,
          completedAt: at(HOUR),
        })
        .write(tempDbPath())
    );

    const { coordinatorRuns } = (await harness.snapshot()).snapshot;

    expect(coordinatorRuns).toEqual([
      {
        id: 'run_coordinator',
        status: 'running',
        coordinatorHandle: ALPHA,
        pollIntervalMs: 2000,
        createdAt: AT.toISOString(),
        completedAt: at(HOUR).toISOString(),
      },
    ]);
  });

  it('does not scope the canvas — a coordinator row buys the inferred runs nothing', async () => {
    // The trap: it looks like the run key and it is not. Two handles, one coordinator row,
    // still two inferred runs.
    const { runs } = await snapshotOf(
      new FixtureBuilder()
        .task({ handle: ALPHA, createdAt: at(0) })
        .task({ handle: BETA, createdAt: at(60_000) })
        .coordinatorRun({ spec: 'one row', coordinatorHandle: ALPHA, createdAt: AT })
    );

    expect(runs).toHaveLength(2);
  });
});

/** The corpus has the live database's shape: 76 tasks, 13 runs, 4 of them edgeless. */
describe('the live-shape corpus', () => {
  it('resolves 76 tasks into the 13 runs the live database holds', async () => {
    harness = await serve(liveShapeCorpus().write(tempDbPath()));

    const { runs, tasks } = (await harness.snapshot()).snapshot;

    expect(tasks).toHaveLength(76);
    expect(runs).toHaveLength(13);
    // The soup is gone: no run is the whole database, and the largest is 14 tasks.
    expect(Math.max(...runs.map((run) => run.taskCount))).toBeLessThan(20);
    expect(runs.reduce((total, run) => total + run.taskCount, 0)).toBe(76);
  });

  it('finds the four edgeless runs the canvas has to own', async () => {
    harness = await serve(liveShapeCorpus().write(tempDbPath()));

    const { runs } = (await harness.snapshot()).snapshot;

    expect(runs.filter((run) => run.edgeCount === 0)).toHaveLength(4);
  });

  it('finds the four null-handle tasks, in exactly one run', async () => {
    harness = await serve(liveShapeCorpus().write(tempDbPath()));

    const { runs, tasks } = (await harness.snapshot()).snapshot;
    const unattributed = byId(runs, 'run_unattributed');

    expect(unattributed.taskCount).toBe(4);
    expect(tasksOf(tasks, unattributed)).toHaveLength(4);
  });
});
