import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { criticalPathOf } from '../../src/client/canvas/critical-path.ts';
import type { DurationObservation, Meta, Run, Task } from '../../src/shared/types.ts';
import { type CannedEvent, CannedApp } from './canned.tsx';

/**
 * The critical path (#71, SPEC §12.4): a duration-weighted longest path over the selected
 * completed run's in-run dependency edges, highlighted statically on the DAG.
 *
 * Two seams, one file. The **pure derivation** has the dense error surface SPEC §12.5 names —
 * missing dependency endpoints, zero weights, deterministic ties, edgeless graphs, cycles — and
 * is tested value by value. The **presentation** is `<CannedApp>` fed a canned world, asserting
 * the DOM the user reads: which nodes wear the highlight, and the sentence that explains a shape
 * the analysis honestly cannot support.
 *
 * The stream stopped carrying the snapshot (#69/#88) — it is the doorbell, and the run's evidence
 * is fetched. So the presentation half drives `<CannedApp>`, which serves this file's one canned
 * world through the server's own paging/snapshot functions (`canned.tsx`). The derivation still
 * reads the *selected run's* tasks and nothing else, which is exactly what that snapshot serves.
 */

const MINUTE = 60 * 1000;

/** A completed dispatch clock of `minutes` — the preferred weight (#66). */
function dispatchClock(minutes: number): DurationObservation {
  return {
    clock: 'dispatch',
    startAt: '2026-07-08T12:00:00.000Z',
    endAt: new Date(Date.parse('2026-07-08T12:00:00.000Z') + minutes * MINUTE).toISOString(),
    complete: true,
    ms: minutes * MINUTE,
  };
}

/** The visibly labelled fallback (#66) — a weight all the same, just on the task's own clock. */
function taskSpan(minutes: number): DurationObservation {
  return { ...dispatchClock(minutes), clock: 'task-span' };
}

const RUN_ID = 'run_term_9f8e7d6c-1234-4321-8888-aabbccddeeff';

function task(id: string, deps: string[], over: Partial<Task> = {}): Task {
  return {
    id,
    runId: RUN_ID,
    parentId: null,
    title: `Task ${id}`,
    status: 'completed',
    deps,
    createdAt: '2026-07-08T12:00:00.000Z',
    completedAt: '2026-07-08T13:00:00.000Z',
    hasSpec: false,
    hasResult: false,
    dispatch: null,
    attemptCount: 1,
    gate: null,
    ...over,
  };
}

describe('criticalPathOf — the pure derivation', () => {
  it('follows the heaviest chain of completed durations to its full length', () => {
    // a → b → d and a → c → d; c is where the duration accumulated.
    const tasks = [
      task('task_a', [], { duration: dispatchClock(5) }),
      task('task_b', ['task_a'], { duration: dispatchClock(10) }),
      task('task_c', ['task_a'], { duration: dispatchClock(30) }),
      task('task_d', ['task_b', 'task_c'], { duration: dispatchClock(5) }),
    ];

    expect(criticalPathOf(tasks)).toEqual({
      kind: 'path',
      taskIds: ['task_a', 'task_c', 'task_d'],
      ms: 40 * MINUTE,
    });
  });

  it('weighs the task-span fallback exactly as it weighs a dispatch clock', () => {
    // The preference between clocks was settled per task by #66; the path trusts the
    // observation it is handed rather than re-deriving it.
    const tasks = [
      task('task_a', [], { duration: taskSpan(20) }),
      task('task_b', ['task_a'], { duration: dispatchClock(10) }),
    ];

    expect(criticalPathOf(tasks)).toEqual({
      kind: 'path',
      taskIds: ['task_a', 'task_b'],
      ms: 30 * MINUTE,
    });
  });

  it('keeps unknown-duration tasks traversable at zero weight', () => {
    // The connective task retains no readable clock at all. Missing timing must cost the
    // number, never the dependency (SPEC §12.3, story 16).
    const tasks = [
      task('task_a', [], { duration: dispatchClock(10) }),
      task('task_z', ['task_a'], { status: 'failed', completedAt: null }),
      task('task_b', ['task_z'], { duration: dispatchClock(20) }),
    ];

    expect(criticalPathOf(tasks)).toEqual({
      kind: 'path',
      taskIds: ['task_a', 'task_z', 'task_b'],
      ms: 30 * MINUTE,
    });
  });

  it('weighs an incomplete observation as zero rather than inventing a number', () => {
    const open: DurationObservation = { clock: 'dispatch', startAt: '2026-07-08T12:00:00.000Z', complete: false };
    const tasks = [
      task('task_a', [], { duration: dispatchClock(10) }),
      task('task_z', ['task_a'], { status: 'failed', completedAt: null, duration: open }),
    ];

    expect(criticalPathOf(tasks)).toEqual({
      kind: 'path',
      taskIds: ['task_a', 'task_z'],
      ms: 10 * MINUTE,
    });
  });

  it('refuses a hostile negative weight instead of letting it eat the total', () => {
    const hostile: DurationObservation = { ...dispatchClock(10), ms: -5 * MINUTE };
    const tasks = [
      task('task_a', [], { duration: dispatchClock(10) }),
      task('task_z', ['task_a'], { duration: hostile }),
    ];

    expect(criticalPathOf(tasks)).toEqual({
      kind: 'path',
      taskIds: ['task_a', 'task_z'],
      ms: 10 * MINUTE,
    });
  });

  it('drops only the edge when a dependency names a task the run does not retain', () => {
    // No foreign keys (SPEC §4.2, trap 8): the ghost costs its edge, never the node.
    const tasks = [
      task('task_a', ['task_ghost'], { duration: dispatchClock(10) }),
      task('task_b', ['task_a', 'task_ghost'], { duration: dispatchClock(20) }),
    ];

    expect(criticalPathOf(tasks)).toEqual({
      kind: 'path',
      taskIds: ['task_a', 'task_b'],
      ms: 30 * MINUTE,
    });
  });

  it('counts a duplicated dependency once, so it cannot fake a cycle', () => {
    // `deps` is an unvalidated JSON column; the same edge twice is still one edge.
    const tasks = [
      task('task_a', [], { duration: dispatchClock(10) }),
      task('task_b', ['task_a', 'task_a'], { duration: dispatchClock(20) }),
    ];

    expect(criticalPathOf(tasks)).toEqual({
      kind: 'path',
      taskIds: ['task_a', 'task_b'],
      ms: 30 * MINUTE,
    });
  });

  it('resolves equal paths by retained task order', () => {
    const diamond = (firstBranch: string, secondBranch: string) => [
      task('task_a', [], { duration: dispatchClock(5) }),
      task(firstBranch, ['task_a'], { duration: dispatchClock(10) }),
      task(secondBranch, ['task_a'], { duration: dispatchClock(10) }),
      task('task_d', [firstBranch, secondBranch], { duration: dispatchClock(5) }),
    ];

    // The branch that comes first in retained order wins — whichever id it carries.
    expect(criticalPathOf(diamond('task_b', 'task_c'))).toEqual({
      kind: 'path',
      taskIds: ['task_a', 'task_b', 'task_d'],
      ms: 20 * MINUTE,
    });
    expect(criticalPathOf(diamond('task_c', 'task_b'))).toEqual({
      kind: 'path',
      taskIds: ['task_a', 'task_c', 'task_d'],
      ms: 20 * MINUTE,
    });
  });

  it('resolves equal paths by retained order, never by how many tasks they cross', () => {
    // Two source-to-sink roads of equal weight, one longer: retained order and id are the
    // tie-break SPEC §12.4 pins, and a preference for length would be a rule it does not name.
    const tasks = [
      task('task_a', [], { duration: dispatchClock(10) }),
      task('task_b', ['task_a'], { duration: dispatchClock(20) }),
      task('task_c1', ['task_a'], { duration: dispatchClock(10) }),
      task('task_c2', ['task_c1'], { duration: dispatchClock(10) }),
      task('task_d', ['task_b', 'task_c2'], { duration: dispatchClock(5) }),
    ];

    expect(criticalPathOf(tasks)).toEqual({
      kind: 'path',
      taskIds: ['task_a', 'task_b', 'task_d'],
      ms: 35 * MINUTE,
    });
  });

  it('resolves an equal-weight choice of endpoint deterministically too', () => {
    // Two sinks, same total: the earlier-retained sink is the answer, every time.
    const tasks = [
      task('task_a', [], { duration: dispatchClock(10) }),
      task('task_b', ['task_a'], { duration: dispatchClock(5) }),
      task('task_c', ['task_a'], { duration: dispatchClock(5) }),
    ];

    expect(criticalPathOf(tasks)).toEqual({
      kind: 'path',
      taskIds: ['task_a', 'task_b'],
      ms: 15 * MINUTE,
    });
  });

  it('spans source to sink even when every weight is zero', () => {
    // All timing unknown: the path is still the retained dependency chain, honestly weightless —
    // not a single arbitrary node.
    const tasks = [task('task_a', []), task('task_b', ['task_a']), task('task_c', ['task_b'])];

    expect(criticalPathOf(tasks)).toEqual({
      kind: 'path',
      taskIds: ['task_a', 'task_b', 'task_c'],
      ms: 0,
    });
  });

  it('reports an in-flight run instead of a final path', () => {
    for (const status of ['pending', 'ready', 'dispatched', 'blocked', 'paused-by-a-newer-orca']) {
      const tasks = [
        task('task_a', [], { duration: dispatchClock(10) }),
        task('task_b', ['task_a'], { status, completedAt: null }),
      ];

      expect(criticalPathOf(tasks)).toEqual({ kind: 'in-flight' });
    }
  });

  it('reports an edgeless run instead of inventing structure', () => {
    expect(criticalPathOf([task('task_a', []), task('task_b', [])])).toEqual({ kind: 'edgeless' });
    // Every dep points outside the run: the edges all drop, and the shape left is edgeless.
    expect(criticalPathOf([task('task_a', ['task_ghost'])])).toEqual({ kind: 'edgeless' });
    expect(criticalPathOf([])).toEqual({ kind: 'edgeless' });
  });

  it('reports a cycle instead of crashing or picking a path around it', () => {
    const cycle = [task('task_a', ['task_b']), task('task_b', ['task_a'])];
    expect(criticalPathOf(cycle)).toEqual({ kind: 'cycle' });

    // A clean chain beside the cycle does not rescue the analysis: the retained shape is not a
    // DAG, and a path picked around the broken part would claim the shape supports one.
    const beside = [
      ...cycle,
      task('task_x', [], { duration: dispatchClock(30) }),
      task('task_y', ['task_x'], { duration: dispatchClock(30) }),
    ];
    expect(criticalPathOf(beside)).toEqual({ kind: 'cycle' });

    // A task depending on itself is the smallest non-DAG shape.
    expect(criticalPathOf([task('task_a', ['task_a'])])).toEqual({ kind: 'cycle' });
  });
});

/** ——— The presentation: `<App>` against a canned event ——— */

const META: Meta = {
  dbPath: '/home/dev/.config/orca/orchestration.db',
  schemaVersion: 5,
  schemaSupport: 'supported',
  degraded: [],
  liveness: 'stale',
  orcaPid: null,
  dbMtime: '2026-07-11T20:54:00.000Z',
  historyLoss: [],
};

const HANDLE = 'term_9f8e7d6c-1234-4321-8888-aabbccddeeff';

function runOf(tasks: Task[], over: Partial<Run> = {}): Run {
  const inRun = new Set(tasks.map((entry) => entry.id));

  return {
    id: RUN_ID,
    handle: HANDLE,
    label: 'A run',
    startedAt: '2026-07-08T12:00:00.000Z',
    lastActivityAt: '2026-07-08T13:00:00.000Z',
    // Every retained task is terminal in these fixtures unless a case says otherwise — which is
    // what a *completed* run means to the derivation, and what a critical path needs (#81's
    // convergence is the run-summary spelling of the same retained evidence).
    converged: true,
    endedAt: '2026-07-08T13:00:00.000Z',
    taskCount: tasks.length,
    cast: [],
    waves: [
      {
        index: 1,
        startedAt: '2026-07-08T12:00:00.000Z',
        endedAt: '2026-07-08T13:00:00.000Z',
        taskIds: tasks.map((entry) => entry.id),
        idleGapBeforeMs: null,
      },
    ],
    statusCounts: { pending: 0, ready: 0, dispatched: 0, completed: tasks.length, failed: 0, blocked: 0 },
    live: false,
    hasBlockingGates: false,
    edgeCount: tasks.reduce((total, entry) => total + entry.deps.filter((dep) => inRun.has(dep)).length, 0),
    ...over,
  };
}

function eventOf(tasks: Task[]): CannedEvent {
  return {
    seq: 1,
    // A first connect: the whole view may be stale, so the client fetches the index and the run
    // it selects — which is how these tasks reach the canvas at all now (#69/#88).
    affected: { all: true, runIds: [], unplaced: false },
    meta: META,
    snapshot: { runs: [runOf(tasks)], tasks, gates: [], turns: [], coordinatorRuns: [] },
    messages: [],
  };
}

async function nodeOf(taskId: string): Promise<HTMLElement> {
  const nodes = await screen.findAllByTestId('task-node');
  const node = nodes.find((candidate) => candidate.dataset.task === taskId);
  expect(node).toBeDefined();
  return node!;
}

describe('the critical path on the canvas', () => {
  it('statically highlights the path of a completed run, and says what it is', async () => {
    const tasks = [
      task('task_a', [], { duration: dispatchClock(5) }),
      task('task_b', ['task_a'], { duration: dispatchClock(10) }),
      task('task_c', ['task_a'], { duration: dispatchClock(30) }),
      task('task_d', ['task_b', 'task_c'], { duration: dispatchClock(5) }),
    ];
    render(<CannedApp event={eventOf(tasks)} />);

    expect((await nodeOf('task_a')).dataset.critical).toBe('true');
    expect((await nodeOf('task_c')).dataset.critical).toBe('true');
    expect((await nodeOf('task_d')).dataset.critical).toBe('true');
    expect((await nodeOf('task_b')).dataset.critical).toBe('false');

    // The caption names the highlight and carries the total — it explains, it does not animate.
    const caption = await screen.findByTestId('critical-path-caption');
    expect(caption.textContent).toContain('Critical path');
    expect(caption.textContent).toContain('3 of 4 tasks');
    expect(caption.textContent).toContain('40m');
  });

  it('explains a cyclic retained shape instead of highlighting anything', async () => {
    const tasks = [
      task('task_a', ['task_b'], { duration: dispatchClock(5) }),
      task('task_b', ['task_a'], { duration: dispatchClock(10) }),
    ];
    render(<CannedApp event={eventOf(tasks)} />);

    const note = await screen.findByTestId('critical-path-note');
    expect(note.textContent).toMatch(/cycle/i);

    expect((await nodeOf('task_a')).dataset.critical).toBe('false');
    expect((await nodeOf('task_b')).dataset.critical).toBe('false');
    expect(screen.queryByTestId('critical-path-caption')).toBeNull();
  });

  it('claims nothing for an in-flight run', async () => {
    const tasks = [
      task('task_a', [], { duration: dispatchClock(5) }),
      task('task_b', ['task_a'], { status: 'dispatched', completedAt: null }),
    ];
    render(<CannedApp event={eventOf(tasks)} />);

    expect((await nodeOf('task_a')).dataset.critical).toBe('false');
    expect((await nodeOf('task_b')).dataset.critical).toBe('false');
    expect(screen.queryByTestId('critical-path-caption')).toBeNull();
    expect(screen.queryByTestId('critical-path-note')).toBeNull();
  });

  it('leaves an edgeless completed run to the edgeless note', async () => {
    const tasks = [
      task('task_a', [], { duration: dispatchClock(5) }),
      task('task_b', [], { duration: dispatchClock(10) }),
    ];
    render(<CannedApp event={eventOf(tasks)} />);

    await screen.findByTestId('edgeless-note');
    expect(screen.queryByTestId('critical-path-caption')).toBeNull();
    expect(screen.queryByTestId('critical-path-note')).toBeNull();
  });
});
