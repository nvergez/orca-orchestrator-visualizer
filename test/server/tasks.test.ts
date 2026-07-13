import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { liveShapeCorpus } from '../fixtures/corpus.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * Seam 1 (#12): the tasks in `GET /api/snapshot`, driven by a real fixture database.
 *
 * This is where every trap in the read path lands — the split timestamp formats, the
 * `MAX(rowid)` dispatch, the retry that has never happened in real data. The canvas is
 * downstream of this JSON, so a lie told here is a lie drawn on screen.
 */

const AT = new Date('2026-07-08T12:00:00Z');
const WORKER = handleFor('worker');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function tasksOf(builder: FixtureBuilder): Promise<Task[]> {
  harness = await serve(builder.write(tempDbPath()));
  return (await harness.snapshot()).snapshot.tasks;
}

function byId(tasks: Task[], id: string): Task {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`no task ${id} in the snapshot`);
  return task;
}

describe('the tasks in a snapshot', () => {
  it('names a task by its title, falling back to display_name and then to its short id', async () => {
    const tasks = await tasksOf(
      new FixtureBuilder()
        .task({ id: 'task_aaaaaaaaaaaa', title: 'Build the canvas', displayName: 'ignored', createdAt: AT })
        .task({ id: 'task_bbbbbbbbbbbb', title: null, displayName: 'Only a display name', createdAt: AT })
        .task({ id: 'task_cccccccccccc', title: null, displayName: null, createdAt: AT })
    );

    expect(byId(tasks, 'task_aaaaaaaaaaaa').title).toBe('Build the canvas');
    expect(byId(tasks, 'task_bbbbbbbbbbbb').title).toBe('Only a display name');
    // Nothing named it, so the node still says *something* you can paste into a CLI.
    expect(byId(tasks, 'task_cccccccccccc').title).toBe('task_cccccccc');
  });

  it('parses the dependency edges out of the JSON string column', async () => {
    const tasks = await tasksOf(
      new FixtureBuilder()
        .task({ id: 'task_first', createdAt: AT })
        .task({ id: 'task_second', deps: ['task_first'], createdAt: AT })
    );

    expect(byId(tasks, 'task_first').deps).toEqual([]);
    expect(byId(tasks, 'task_second').deps).toEqual(['task_first']);
  });

  it('passes an unknown status through verbatim rather than dropping the task', async () => {
    // A newer Orca that added a status we have never heard of. The task still exists, and
    // a task missing from the graph is a worse lie than a task in an odd colour (SPEC §5).
    const tasks = await tasksOf(
      new FixtureBuilder({ allowUnknownEnums: true }).task({
        id: 'task_strange',
        status: 'quarantined',
        createdAt: AT,
      })
    );

    expect(byId(tasks, 'task_strange').status).toBe('quarantined');
  });

  it('reports whether a spec and a result exist without shipping either body', async () => {
    const tasks = await tasksOf(
      new FixtureBuilder()
        .task({ id: 'task_done', spec: 'a very long agent prompt', result: 'the receipt', createdAt: AT })
        .task({ id: 'task_open', spec: 'a very long agent prompt', result: null, createdAt: AT })
    );

    expect(byId(tasks, 'task_done')).toMatchObject({ hasSpec: true, hasResult: true });
    expect(byId(tasks, 'task_open')).toMatchObject({ hasSpec: true, hasResult: false });
    // The bodies are the payload: a live 71-task dump was 172 KB, almost all spec text.
    expect(JSON.stringify(tasks)).not.toContain('a very long agent prompt');
    expect(JSON.stringify(tasks)).not.toContain('the receipt');
  });

  it('keeps the payloads bounded — the bodies stay in the file (SPEC §6.3)', async () => {
    harness = await serve(liveShapeCorpus().write(tempDbPath()));

    const event = await harness.snapshot();

    // **A budget on what a fetch of history costs**, and a feature that grows it has to come
    // here and say so. The wire stopped re-sending this on every push (#69) — the tick carries
    // `affected` and the message delta, and the graph travels one selected run at a time — but
    // the bound still matters: it is what a client pays to read the *whole* corpus back
    // through the paged contracts, and `spec` text is still the thing that must not be in it.
    //
    // Features have come and said so. The latest is the duration observations (#66): one small
    // object per run, per task and per latest attempt, absent whenever the endpoints cannot
    // support one. Like the turns, they are bounded by the *row count*, never by what anybody
    // typed — a duration cannot grow.
    //
    // The defence still holds. A dispatch turn carries the **first 240 characters** of the spec
    // and says so (`BODY_PREVIEW_CHARS`); the other 3 KB never crosses the SQLite boundary, let
    // alone the wire. The bodies are one click away, in full, on `GET /api/task/:id`.
    expect(event.snapshot.tasks).toHaveLength(76);
    expect(event.snapshot.gates).toHaveLength(53);
    expect(event.snapshot.turns.length).toBeGreaterThan(300);

    expect(JSON.stringify(event.snapshot).length).toBeLessThan(250_000);

    // …and the ceiling means nothing without the thing it is a ceiling *against*: every spec in this
    // corpus is longer than the cap, and not one full body is on the wire.
    const specs = event.snapshot.turns.filter((turn) => turn.kind === 'dispatch');
    expect(specs.length).toBeGreaterThan(50);
    for (const turn of specs) expect(turn.body.length).toBeLessThanOrEqual(240);
  });
});

/**
 * Trap 5 (SPEC §4.2). Orca writes `tasks.completed_at` from JS as ISO-8601 and everything
 * else from SQL as `'YYYY-MM-DD HH:MM:SS'` **UTC**. `new Date('2026-07-08 12:32:13')` reads
 * that as *local* time — so in any timezone west of UTC a naive read moves the task's
 * creation forward past its own completion, and the tool reports a task that finished
 * before it started. The normalization is the whole defence, and it lives at the server
 * boundary: the client never sees the split.
 */
describe('timestamp normalization', () => {
  const ZONE = 'America/New_York'; // UTC-4 in July: a naive local parse lands 4h in the future.
  let realZone: string | undefined;

  afterEach(() => {
    process.env.TZ = realZone;
  });

  function inZone(zone: string): void {
    realZone = process.env.TZ;
    process.env.TZ = zone;
  }

  it('emits ISO-8601 UTC instants whatever timezone the tool is running in', async () => {
    inZone(ZONE);

    const tasks = await tasksOf(
      new FixtureBuilder().task({
        id: 'task_split',
        // The builder writes created_at as SQL and completed_at as ISO — the real split.
        createdAt: new Date('2026-07-08T12:32:13Z'),
        completedAt: new Date('2026-07-08T12:38:28.374Z'),
      })
    );

    const task = byId(tasks, 'task_split');
    expect(task.createdAt).toBe('2026-07-08T12:32:13.000Z');
    expect(task.completedAt).toBe('2026-07-08T12:38:28.374Z');
  });

  it('never reports a task as having completed before it started', async () => {
    inZone(ZONE);

    const tasks = await tasksOf(
      new FixtureBuilder().task({
        id: 'task_split',
        createdAt: new Date('2026-07-08T12:32:13Z'),
        completedAt: new Date('2026-07-08T12:38:28.374Z'),
      })
    );

    const task = byId(tasks, 'task_split');
    expect(Date.parse(task.completedAt!)).toBeGreaterThan(Date.parse(task.createdAt));
  });

  it('normalizes the dispatch timestamps too — they are SQL-written, every one of them', async () => {
    inZone(ZONE);

    const tasks = await tasksOf(
      new FixtureBuilder()
        .task({ id: 'task_worked', status: 'dispatched', createdAt: AT })
        .dispatch({
          taskId: 'task_worked',
          assigneeHandle: WORKER,
          status: 'dispatched',
          dispatchedAt: new Date('2026-07-08T12:33:00Z'),
          lastHeartbeatAt: new Date('2026-07-08T12:40:00Z'),
          lastFailure: new Date('2026-07-08T12:35:00Z'),
        })
    );

    expect(byId(tasks, 'task_worked').dispatch).toMatchObject({
      dispatchedAt: '2026-07-08T12:33:00.000Z',
      lastHeartbeatAt: '2026-07-08T12:40:00.000Z',
      lastFailure: '2026-07-08T12:35:00.000Z',
    });
  });
});

/**
 * `dispatch_contexts` is one row per *attempt* — the only genuinely append-only per-task
 * history in the schema. The latest attempt is `MAX(rowid)`, as Orca's own queries have it,
 * and the retry marker it feeds is the only visible sign anywhere that a task was retried.
 * No task has retried in real data yet, so this has to be right the first time it happens.
 */
describe('dispatch attempts', () => {
  it('carries the MAX(rowid) attempt and counts them all', async () => {
    const builder = new FixtureBuilder().task({ id: 'task_retried', status: 'completed', createdAt: AT });
    // Three attempts, inserted in attempt order — but the *last inserted* row carries the
    // earliest `dispatched_at`. A "latest by timestamp" implementation picks the wrong row
    // and reports a circuit-broken task as freshly dispatched; only MAX(rowid) survives this.
    builder.dispatch({
      id: 'ctx_one',
      taskId: 'task_retried',
      assigneeHandle: WORKER,
      status: 'failed',
      failureCount: 1,
      dispatchedAt: new Date('2026-07-08T12:10:00Z'),
    });
    builder.dispatch({
      id: 'ctx_two',
      taskId: 'task_retried',
      assigneeHandle: WORKER,
      status: 'failed',
      failureCount: 2,
      dispatchedAt: new Date('2026-07-08T12:20:00Z'),
    });
    builder.dispatch({
      id: 'ctx_three',
      taskId: 'task_retried',
      assigneeHandle: WORKER,
      status: 'circuit_broken',
      failureCount: 3,
      dispatchedAt: new Date('2026-07-08T12:05:00Z'),
    });

    const task = byId(await tasksOf(builder), 'task_retried');

    expect(task.dispatch?.id).toBe('ctx_three');
    expect(task.dispatch?.status).toBe('circuit_broken');
    expect(task.dispatch?.failureCount).toBe(3);
    expect(task.attemptCount).toBe(3);
  });

  it('leaves a never-dispatched task with no dispatch and no attempts', async () => {
    const tasks = await tasksOf(new FixtureBuilder().task({ id: 'task_waiting', status: 'pending', createdAt: AT }));

    expect(byId(tasks, 'task_waiting').dispatch).toBeNull();
    expect(byId(tasks, 'task_waiting').attemptCount).toBe(0);
  });

  it('reports a single attempt as one attempt — the retry marker must not cry wolf', async () => {
    const tasks = await tasksOf(
      new FixtureBuilder()
        .task({ id: 'task_once', status: 'dispatched', createdAt: AT })
        .dispatch({ taskId: 'task_once', assigneeHandle: WORKER, status: 'dispatched', dispatchedAt: AT })
    );

    expect(byId(tasks, 'task_once').attemptCount).toBe(1);
    expect(byId(tasks, 'task_once').dispatch?.assigneeHandle).toBe(WORKER);
  });

  it('counts every attempt of the three re-dispatched tasks in the live-shape corpus', async () => {
    harness = await serve(liveShapeCorpus().write(tempDbPath()));

    const { tasks } = (await harness.snapshot()).snapshot;
    const retried = tasks.filter((task) => task.attemptCount > 1);

    // Two tasks burned all three attempts into the circuit breaker; one completed on its
    // second. Retries are invisible everywhere else in the schema — this is the only sign.
    expect(retried.map((task) => task.attemptCount).sort((a, b) => a - b)).toEqual([2, 3, 3]);
  });
});

/** Render what parses (SPEC §5): a database from an Orca this tool has never seen. */
describe('a task from a different Orca', () => {
  it('falls back to the short id when pre-v5 Orca has no title columns at all', async () => {
    const tasks = await tasksOf(
      new FixtureBuilder({ userVersion: 4 }).task({ id: 'task_dddddddddddd', title: 'never stored', createdAt: AT })
    );

    expect(byId(tasks, 'task_dddddddddddd').title).toBe('task_dddddddd');
  });

  it('renders a task whose deps column holds something that is not JSON', async () => {
    // No column in this schema is validated. A task with an unparseable `deps` still has a
    // status worth seeing, so it renders with no edges rather than taking the graph down.
    const dbPath = new FixtureBuilder().task({ id: 'task_broken', createdAt: AT }).write(tempDbPath());
    corruptDeps(dbPath, 'task_broken', 'not json at all');
    harness = await serve(dbPath);

    const tasks = (await harness.snapshot()).snapshot.tasks;

    expect(byId(tasks, 'task_broken').deps).toEqual([]);
  });
});

/** The fixture builder always writes valid JSON, so a corrupt column has to be forged. */
function corruptDeps(dbPath: string, taskId: string, deps: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('UPDATE tasks SET deps = ? WHERE id = ?').run(deps, taskId);
  } finally {
    db.close();
  }
}

/** A guard on the guard: the corpus is the live database's shape, so these are real numbers. */
describe('the live-shape corpus', () => {
  it('renders every task in the database as one graph — the soup that motivates run scoping', async () => {
    harness = await serve(liveShapeCorpus().write(tempDbPath()));

    const { tasks } = (await harness.snapshot()).snapshot;

    expect(tasks).toHaveLength(76);
    expect(tasks.filter((task) => task.deps.length > 0)).not.toHaveLength(0);
    // ~50 of 76 are fully isolated singletons — the canvas has to own that, not fight it.
    expect(tasks.filter((task) => task.dispatch !== null).length).toBeGreaterThan(0);

    // Creation order, *within each run* — the only structure an edgeless run has, and the
    // order its canvas grid draws (SPEC §7.5). The merged view groups runs by recency (#69),
    // so the old whole-file read order is nobody's to promise any more; a run's own is.
    for (const runId of new Set(tasks.map((task) => task.runId))) {
      const created = tasks.filter((task) => task.runId === runId).map((task) => Date.parse(task.createdAt));
      for (let i = 1; i < created.length; i++) {
        expect(created[i]!).toBeGreaterThanOrEqual(created[i - 1]!);
      }
    }
  });
});
