import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run, Task } from '../../src/shared/types.ts';
import { shortHandle } from '../../src/shared/handles.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { liveShapeCorpus } from '../fixtures/corpus.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

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

/** A database served with Orca *running* — the only way `run.live` can be true. */
async function serveLive(dbPath: string): Promise<Harness> {
  writeFileSync(join(dirname(dbPath), 'orca-runtime.json'), JSON.stringify({ pid: 4242 }));
  return serve(dbPath, { probe: (pid) => pid === 4242 });
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

describe('splitting: an idle gap of more than six hours', () => {
  it('holds a run together across an overnight gap — a real 13-task run spans 20:10 → 07:04', async () => {
    const { runs, tasks } = await snapshotOf(
      new FixtureBuilder()
        .task({ id: 'task_evening', handle: ALPHA, createdAt: at(0) })
        .task({ id: 'task_morning', handle: ALPHA, createdAt: at(5 * HOUR) })
    );

    expect(runs).toHaveLength(1);
    expect(tasksOf(tasks, runs[0]!).map((task) => task.id)).toEqual(['task_evening', 'task_morning']);
  });

  it('splits the same handle into two runs when it went quiet for seven', async () => {
    const { runs, tasks } = await snapshotOf(
      new FixtureBuilder()
        .task({ id: 'task_yesterday', handle: ALPHA, createdAt: at(0) })
        .task({ id: 'task_today', handle: ALPHA, createdAt: at(7 * HOUR) })
    );

    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((run) => run.id)).size).toBe(2);
    // Same terminal, two orchestrations — the handle survives on both rows.
    expect(runs.every((run) => run.handle === ALPHA)).toBe(true);
    expect(tasksOf(tasks, byId(runs, runs[0]!.id))).toHaveLength(1);
  });

  it('splits on *more* than six hours, so a gap of exactly six does not shred a run', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ handle: ALPHA, createdAt: at(0) })
        .task({ handle: ALPHA, createdAt: at(6 * HOUR) })
    );

    expect(runs).toHaveLength(1);
  });

  it('measures the gap between consecutive tasks, not from the first — a long run never splits on its own length', async () => {
    // Ten tasks, five hours apart: 45 hours end to end, and not one gap over six.
    const builder = new FixtureBuilder();
    for (let i = 0; i < 10; i++) builder.task({ handle: ALPHA, createdAt: at(i * 5 * HOUR) });

    expect(await runsOf(builder)).toHaveLength(1);
  });
});

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

describe('the run id: deterministic, and stable across a restart', () => {
  it('is the handle and the first task, so the same file yields the same ids twice', async () => {
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

  it('reads `run_<handle8>_<epoch seconds of the first task>`', async () => {
    const runs = await runsOf(new FixtureBuilder().task({ handle: ALPHA, createdAt: AT }));

    expect(runs[0]!.id).toBe(`run_${shortHandle(ALPHA)}_${Math.floor(AT.getTime() / 1000)}`);
  });

  it('gives the two halves of a split handle two different ids', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ handle: ALPHA, createdAt: at(0) })
        .task({ handle: ALPHA, createdAt: at(7 * HOUR) })
    );

    expect(runs.map((run) => run.id)).toEqual([
      `run_${shortHandle(ALPHA)}_${Math.floor(at(7 * HOUR).getTime() / 1000)}`,
      `run_${shortHandle(ALPHA)}_${Math.floor(AT.getTime() / 1000)}`,
    ]);
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
 * The green dot: a running orchestration told from a finished one. There is no history
 * mode — yesterday's run renders through this exact code path, and the dot is the whole
 * difference (SPEC §7.3).
 */
describe('the live badge', () => {
  const builder = () =>
    new FixtureBuilder()
      .task({ handle: ALPHA, status: 'dispatched', createdAt: at(0) })
      .task({ handle: BETA, status: 'completed', createdAt: at(60_000), completedAt: at(120_000) });

  it('marks the run with work in flight, and only that one, while Orca is running', async () => {
    harness = await serveLive(builder().write(tempDbPath()));

    const { runs } = (await harness.snapshot()).snapshot;

    expect(runs.find((run) => run.handle === ALPHA)!.live).toBe(true);
    // A finished run is a finished run, however alive Orca is.
    expect(runs.find((run) => run.handle === BETA)!.live).toBe(false);
  });

  it('marks a run with ready work as live too — the orchestration is still going somewhere', async () => {
    const dbPath = new FixtureBuilder().task({ handle: ALPHA, status: 'ready', createdAt: AT }).write(tempDbPath());
    harness = await serveLive(dbPath);

    expect((await harness.snapshot()).snapshot.runs[0]!.live).toBe(true);
  });

  it('calls nothing live when Orca is not running, whatever the rows still say', async () => {
    // Orca was killed mid-run: the task rows still read `dispatched` and always will —
    // nothing rewrites them. A green dot here would be the tool's worst lie.
    harness = await serve(builder().write(tempDbPath()), { probe: () => false });

    const { runs } = (await harness.snapshot()).snapshot;

    expect(runs.every((run) => run.live === false)).toBe(true);
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
