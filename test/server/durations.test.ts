import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchDuration, runSpan, taskDuration } from '../../src/server/durations.ts';
import type { Dispatch, Task, TaskDetail } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * Honest durations (#66, SPEC §14.4): a duration observation carries its clock and its
 * provenance, not just a number — and when the retained endpoints cannot support one, there
 * is **no observation** rather than a zero, an epoch date or a negative interval.
 *
 * This file is the pure seam SPEC §14.5 asks for: the derivation has a dense error surface
 * (dispatch versus task-span provenance, unreadable timestamps, negative intervals,
 * incomplete "so far" clocks), and these tests walk it value by value. The HTTP seam —
 * where the observations actually reach the wire — is covered beside the routes they ride
 * (`snapshot`/`task-detail` tests below in this file), against real fixture databases.
 */

const DISPATCHED = '2026-07-08T12:00:00.000Z';
const COMPLETED = '2026-07-08T12:25:00.000Z';

/** A dispatch attempt as `toDispatch` hands it over: normalized ISO, or verbatim garbage. */
function attempt(over: Partial<Dispatch> = {}): Dispatch {
  return {
    id: 'ctx_aaaaaaaaaaaa',
    assigneeHandle: 'term_1a2b3c4d-1234-4321-8888-aabbccddeeff',
    status: 'completed',
    failureCount: 0,
    lastFailure: null,
    dispatchedAt: DISPATCHED,
    completedAt: COMPLETED,
    lastHeartbeatAt: null,
    ...over,
  };
}

describe('the dispatch clock', () => {
  it('measures a completed attempt from its own dispatched → completed instants', () => {
    expect(dispatchDuration(attempt())).toEqual({
      clock: 'dispatch',
      startAt: DISPATCHED,
      endAt: COMPLETED,
      complete: true,
      ms: 25 * 60 * 1000,
    });
  });

  it('leaves an in-flight attempt open — a start, no end, and the client ages it', () => {
    const observation = dispatchDuration(attempt({ status: 'dispatched', completedAt: null }));

    // No `ms` and no `endAt`: an open interval has nothing final to say, and a number here
    // would be a duration the server computed once and let go stale (SPEC §14.4).
    expect(observation).toEqual({ clock: 'dispatch', startAt: DISPATCHED, complete: false });
  });

  it('is absent when the attempt finished but never recorded when', () => {
    // The status says the interval closed; the row does not say where. "So far" would claim
    // work still running, and any end we picked would be invented.
    expect(dispatchDuration(attempt({ status: 'completed', completedAt: null }))).toBeUndefined();
    expect(dispatchDuration(attempt({ status: 'failed', completedAt: null }))).toBeUndefined();
    expect(dispatchDuration(attempt({ status: 'circuit_broken', completedAt: null }))).toBeUndefined();
  });

  it('does not call an unknown status still-running', () => {
    // A status this build has never heard of renders verbatim elsewhere (SPEC §5) — but here it
    // is evidence of nothing: we cannot claim the interval is still open on a word we cannot read.
    expect(dispatchDuration(attempt({ status: 'paused', completedAt: null }))).toBeUndefined();
  });

  it('is absent when an endpoint is unreadable — never zero, never the epoch', () => {
    // `isoInstant` passes an unparseable column through verbatim rather than dropping the row;
    // the observation is where that honesty has to hold: garbage in, *nothing* out.
    expect(dispatchDuration(attempt({ completedAt: 'whenever' }))).toBeUndefined();
    expect(dispatchDuration(attempt({ dispatchedAt: 'whenever' }))).toBeUndefined();
  });

  it('is absent when the clock runs backwards — a negative interval is a contradiction, not a duration', () => {
    expect(
      dispatchDuration(attempt({ dispatchedAt: COMPLETED, completedAt: DISPATCHED }))
    ).toBeUndefined();
  });

  it('is absent with no start instant at all', () => {
    // `toDispatch` falls back dispatched_at → created_at → '' — the empty string is what
    // "neither column was there" looks like by the time it reaches this derivation.
    expect(dispatchDuration(attempt({ dispatchedAt: '' }))).toBeUndefined();
    expect(dispatchDuration(attempt({ dispatchedAt: '', status: 'dispatched', completedAt: null }))).toBeUndefined();
  });

  it('allows a zero-length interval — same second in, same second out is a real reading', () => {
    // Zero because both endpoints *say* zero is different from zero because nothing was read.
    expect(dispatchDuration(attempt({ completedAt: DISPATCHED }))).toMatchObject({ complete: true, ms: 0 });
  });
});

const CREATED = '2026-07-08T11:50:00.000Z';
const TASK_COMPLETED = '2026-07-08T12:30:00.000Z';

/** A task as `readTasks` hands it over — the latest attempt already on `dispatch`. */
function doneTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task_aaaaaaaaaaaa',
    runId: '',
    parentId: null,
    title: 'Chart the map',
    status: 'completed',
    deps: [],
    createdAt: CREATED,
    completedAt: TASK_COMPLETED,
    hasSpec: true,
    hasResult: true,
    dispatch: attempt(),
    attemptCount: 1,
    gate: null,
    ...over,
  };
}

describe("the task's clock, and its provenance", () => {
  it('prefers the latest attempt’s completed dispatch clock — the worker’s time, not setup time', () => {
    expect(taskDuration(doneTask())).toEqual({
      clock: 'dispatch',
      startAt: DISPATCHED,
      endAt: COMPLETED,
      complete: true,
      ms: 25 * 60 * 1000,
    });
  });

  it('falls back to the created → completed task span when the dispatch clock never closed — labelled as what it is', () => {
    const observation = taskDuration(doneTask({ dispatch: attempt({ status: 'failed', completedAt: null }) }));

    // The clock is the label: the client words a `task-span` differently on screen, so a broader
    // measurement is never presented as dispatch time (SPEC §14.4, story 3).
    expect(observation).toEqual({
      clock: 'task-span',
      startAt: CREATED,
      endAt: TASK_COMPLETED,
      complete: true,
      ms: 40 * 60 * 1000,
    });
  });

  it('falls back to the task span for a task that completed without ever being dispatched', () => {
    // The orchestrator did it itself. There is no dispatch clock to prefer, and the span is real.
    expect(taskDuration(doneTask({ dispatch: null, attemptCount: 0 }))).toMatchObject({ clock: 'task-span' });
  });

  it('leaves an undispatched, uncompleted task without any observation — nothing has started', () => {
    // created → now would measure queue time and call it work (SPEC §14.3, story 2).
    expect(taskDuration(doneTask({ dispatch: null, attemptCount: 0, completedAt: null }))).toBeUndefined();
  });

  it('keeps an in-flight task open on the dispatch clock', () => {
    const observation = taskDuration(
      doneTask({
        status: 'dispatched',
        completedAt: null,
        dispatch: attempt({ status: 'dispatched', completedAt: null }),
      })
    );

    expect(observation).toEqual({ clock: 'dispatch', startAt: DISPATCHED, complete: false });
  });

  it('never shows "so far" once the task has completion evidence — even unreadable evidence', () => {
    // The task says it finished; the attempt row never heard. An interval that keeps ticking
    // against a completed task is the lie story 4 exists to prevent — and with the one recorded
    // end unreadable, the honest value is no observation at all.
    const observation = taskDuration(
      doneTask({
        completedAt: 'whenever',
        dispatch: attempt({ status: 'dispatched', completedAt: null }),
      })
    );

    expect(observation).toBeUndefined();
  });

  it('is absent when the task span runs backwards — completion before creation is a contradiction', () => {
    expect(
      taskDuration(doneTask({ dispatch: null, createdAt: TASK_COMPLETED, completedAt: CREATED }))
    ).toBeUndefined();
  });

  it('is absent when the fallback’s own endpoints are unreadable', () => {
    expect(taskDuration(doneTask({ dispatch: null, createdAt: 'whenever' }))).toBeUndefined();
    expect(taskDuration(doneTask({ dispatch: null, completedAt: 'whenever' }))).toBeUndefined();
  });
});

describe('the run span', () => {
  const EARLIEST = '2026-07-08T11:00:00.000Z';
  const LATEST = '2026-07-08T13:00:00.000Z';

  it('spans from the earliest readable creation to the latest readable activity — wall clock, not summed agent time', () => {
    const observation = runSpan(
      [
        doneTask({ createdAt: CREATED, completedAt: LATEST }),
        doneTask({ createdAt: EARLIEST, completedAt: TASK_COMPLETED }),
      ],
      false
    );

    expect(observation).toEqual({
      clock: 'run-span',
      startAt: EARLIEST,
      endAt: LATEST,
      complete: true,
      ms: 2 * 60 * 60 * 1000,
    });
  });

  it('can end on a *creation* — a run whose last task never completed still ended when it last did anything', () => {
    const observation = runSpan(
      [doneTask({ createdAt: EARLIEST, completedAt: null, dispatch: null }), doneTask({ createdAt: LATEST, completedAt: null, dispatch: null })],
      false
    );

    expect(observation).toMatchObject({ startAt: EARLIEST, endAt: LATEST, complete: true });
  });

  it('stays open while the run is live — a start, and a client that ages it', () => {
    expect(runSpan([doneTask({ createdAt: EARLIEST })], true)).toEqual({
      clock: 'run-span',
      startAt: EARLIEST,
      complete: false,
    });
  });

  it('reads past unreadable instants to the ones that parse', () => {
    // The same rule the waves follow (`runs.ts`): a garbage-stamped task neither dates the run
    // nor mints a 1970 ghost — the run is dated by the tasks that *have* a readable time.
    const observation = runSpan(
      [
        doneTask({ createdAt: 'whenever', completedAt: 'whenever' }),
        doneTask({ createdAt: EARLIEST, completedAt: LATEST }),
      ],
      false
    );

    expect(observation).toMatchObject({ startAt: EARLIEST, endAt: LATEST });
  });

  it('is absent when no task creation is readable at all', () => {
    expect(runSpan([doneTask({ createdAt: 'whenever', completedAt: LATEST })], false)).toBeUndefined();
    expect(runSpan([], false)).toBeUndefined();
  });
});

/**
 * The HTTP seam (SPEC §14.5): observable wire behavior against real fixture databases —
 * what `curl /api/snapshot` and `curl /api/task/:id` actually say, both Orca timestamp
 * formats included.
 */

const CODER = handleFor('coder');
const WORKER = handleFor('worker');
const DONE = 'task_dddddddddddd';

const CREATED_AT = new Date('2026-07-08T11:50:00Z');
const DISPATCHED_AT = new Date('2026-07-08T12:00:00Z');
const DISPATCH_DONE_AT = new Date('2026-07-08T12:25:00Z');
const TASK_DONE_AT = new Date('2026-07-08T12:30:00Z');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** One completed task, worked once: the dispatch rows are SQL-format, `tasks.completed_at` is ISO. */
function completedOrchestration(): FixtureBuilder {
  return new FixtureBuilder()
    .task({
      id: DONE,
      handle: CODER,
      title: 'Chart the map',
      status: 'completed',
      createdAt: CREATED_AT,
      completedAt: TASK_DONE_AT,
    })
    .dispatch({
      taskId: DONE,
      assigneeHandle: WORKER,
      status: 'completed',
      dispatchedAt: DISPATCHED_AT,
      completedAt: DISPATCH_DONE_AT,
    });
}

describe('durations on the wire', () => {
  it('carries the dispatch clock on the task and its latest attempt, and the run span on the run', async () => {
    harness = await serve(completedOrchestration().write(tempDbPath()));

    const { runs, tasks } = (await harness.snapshot()).snapshot;
    const task = tasks.find((candidate) => candidate.id === DONE)!;

    // The endpoints arrive normalized to ISO like every other instant on this wire — the
    // fixture wrote them as `'2026-07-08 12:00:00'` (trap 5), and the client never sees that.
    expect(task.duration).toEqual({
      clock: 'dispatch',
      startAt: DISPATCHED_AT.toISOString(),
      endAt: DISPATCH_DONE_AT.toISOString(),
      complete: true,
      ms: 25 * 60 * 1000,
    });
    expect(task.dispatch?.duration).toEqual(task.duration);

    expect(runs[0]!.duration).toEqual({
      clock: 'run-span',
      startAt: CREATED_AT.toISOString(),
      endAt: TASK_DONE_AT.toISOString(),
      complete: true,
      ms: 40 * 60 * 1000,
    });
  });

  it('crosses the two timestamp formats in one task span — the SQL created_at against the ISO completed_at', async () => {
    // Trap 5 is exactly this comparison: `tasks.created_at` is written by SQL, `tasks.completed_at`
    // by JS. The attempt never closed its clock, so the fallback has to bridge the split.
    const dbPath = new FixtureBuilder()
      .task({
        id: DONE,
        handle: CODER,
        status: 'completed',
        createdAt: CREATED_AT,
        completedAt: TASK_DONE_AT,
      })
      .dispatch({ taskId: DONE, assigneeHandle: WORKER, status: 'failed', dispatchedAt: DISPATCHED_AT })
      .write(tempDbPath());
    harness = await serve(dbPath);

    const { tasks } = (await harness.snapshot()).snapshot;

    expect(tasks.find((candidate) => candidate.id === DONE)!.duration).toEqual({
      clock: 'task-span',
      startAt: CREATED_AT.toISOString(),
      endAt: TASK_DONE_AT.toISOString(),
      complete: true,
      ms: 40 * 60 * 1000,
    });
  });

  it('serves every attempt’s own duration on GET /api/task/:id — the retry story, timed', async () => {
    const dbPath = completedOrchestration()
      .dispatch({
        taskId: DONE,
        assigneeHandle: handleFor('first-worker'),
        status: 'failed',
        failureCount: 1,
        dispatchedAt: new Date('2026-07-08T11:52:00Z'),
        completedAt: new Date('2026-07-08T11:58:00Z'),
      })
      .write(tempDbPath());
    harness = await serve(dbPath);

    const detail = (await (await harness.task(DONE)).json()) as TaskDetail;

    // Oldest first, as the route orders them — but the *fixture* appended the failed attempt
    // second, so `rowid` order puts the completed one first here. Each attempt carries its own
    // clock: both endpoints from its own row, never one attempt's start against another's end.
    expect(detail.attempts.map((attempt) => attempt.duration?.ms)).toEqual([25 * 60 * 1000, 6 * 60 * 1000]);
    for (const attempt of detail.attempts) {
      expect(attempt.duration).toMatchObject({ clock: 'dispatch', complete: true });
    }
  });

  it('keeps the run span open while the run is unfinished', async () => {
    const dbPath = new FixtureBuilder()
      .task({ id: DONE, handle: CODER, status: 'dispatched', createdAt: CREATED_AT })
      .dispatch({ taskId: DONE, assigneeHandle: WORKER, status: 'dispatched', dispatchedAt: DISPATCHED_AT })
      .write(tempDbPath());
    writeFileSync(join(dirname(dbPath), 'orca-runtime.json'), JSON.stringify({ pid: 4242 }));
    // The clock is held a minute past the dispatch — the run's newest activity evidence — so the
    // deprecated `live` projection is true (#48 narrowed it from "Orca is up and something is
    // dispatched" to "Orca is up *and this run has recent activity*"; a fixture dated in the past
    // is `silent` against a real wall clock, which is the whole point of the correction).
    harness = await serve(dbPath, {
      probe: (pid) => pid === 4242,
      now: () => DISPATCHED_AT.getTime() + 60_000,
    });

    const { runs, tasks } = (await harness.snapshot()).snapshot;

    expect(runs[0]!.live).toBe(true);
    // The span itself is open because the run has **not converged** — never because `live` says
    // so. Quitting Orca must not retroactively close a span over work that never finished.
    expect(runs[0]!.converged).toBe(false);
    expect(runs[0]!.duration).toEqual({ clock: 'run-span', startAt: CREATED_AT.toISOString(), complete: false });
    // …and the in-flight task is open on its dispatch clock, for the client to age as "so far".
    expect(tasks[0]!.duration).toEqual({
      clock: 'dispatch',
      startAt: DISPATCHED_AT.toISOString(),
      complete: false,
    });
  });

  it('renders a corrupted endpoint unknown on the wire — the task falls back to its span, the attempt says nothing', async () => {
    const dbPath = completedOrchestration().write(tempDbPath());
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare('UPDATE dispatch_contexts SET completed_at = ?').run('whenever');
    } finally {
      db.close();
    }
    harness = await serve(dbPath);

    const { tasks } = (await harness.snapshot()).snapshot;
    const task = tasks.find((candidate) => candidate.id === DONE)!;

    expect(task.duration).toMatchObject({ clock: 'task-span', complete: true });
    expect(task.dispatch?.duration).toBeUndefined();

    const detail = (await (await harness.task(DONE)).json()) as TaskDetail;
    expect(detail.attempts[0]!.duration).toBeUndefined();
  });

  it('renders a backwards clock unknown — never a negative interval', async () => {
    const dbPath = new FixtureBuilder()
      .task({ id: DONE, handle: CODER, status: 'completed', createdAt: CREATED_AT })
      .dispatch({
        taskId: DONE,
        assigneeHandle: WORKER,
        status: 'completed',
        dispatchedAt: DISPATCH_DONE_AT,
        completedAt: DISPATCHED_AT,
      })
      .write(tempDbPath());
    harness = await serve(dbPath);

    const { tasks } = (await harness.snapshot()).snapshot;
    const task = tasks.find((candidate) => candidate.id === DONE)!;

    // The attempt's clock runs backwards and the task never wrote `completed_at`: there is no
    // honest number here at all, and the wire says so by carrying none.
    expect(task.dispatch?.duration).toBeUndefined();
    expect(task.duration).toBeUndefined();
  });
});
