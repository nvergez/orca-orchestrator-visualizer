import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/client/App.tsx';
import type { CoordinatorRun, Meta, Run, StreamEvent, Task } from '../../src/shared/types.ts';

/**
 * Seam 2 (#12): `<App>` fed a canned `StreamEvent` — the client's only input.
 *
 * The rail is where the soup resolves. 76 tasks in one graph is unreadable; the rail is what
 * makes the canvas mean something, and it carries the tool's one uncomfortable admission:
 * **the schema has no run id**, so the grouping is inferred, and the header says so.
 *
 * What is asserted here is the DOM a user reads — the header, the row, the green dot, and
 * above all *which tasks reach the canvas*. That last one is the whole ticket.
 */

const META: Meta = {
  dbPath: '/home/dev/.config/orca/orchestration.db',
  schemaVersion: 5,
  schemaSupport: 'supported',
  degraded: [],
  liveness: 'live',
  orcaPid: 4242,
  dbMtime: '2026-07-11T20:54:00.000Z',
  resetDetected: false,
};

const HANDLE = 'term_9f8e7d6c-1234-4321-8888-aabbccddeeff';
const OTHER_HANDLE = 'term_1a2b3c4d-1234-4321-8888-aabbccddeeff';

function run(over: Partial<Run> = {}): Run {
  return {
    id: 'run_9f8e7d6c_1000',
    handle: HANDLE,
    label: 'Ship the visualizer',
    startedAt: '2026-07-11T20:54:00.000Z',
    endedAt: '2026-07-11T21:30:00.000Z',
    taskCount: 1,
    statusCounts: { pending: 0, ready: 0, dispatched: 0, completed: 1, failed: 0, blocked: 0 },
    live: false,
    hasOpenGates: false,
    edgeCount: 0,
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task_aaaaaaaa',
    runId: 'run_9f8e7d6c_1000',
    parentId: null,
    title: 'A task',
    status: 'completed',
    deps: [],
    createdAt: '2026-07-11T20:54:00.000Z',
    completedAt: null,
    hasSpec: true,
    hasResult: false,
    dispatch: null,
    attemptCount: 0,
    gate: null,
    ...over,
  };
}

function event(runs: Run[], tasks: Task[], coordinatorRuns: CoordinatorRun[] = []): StreamEvent {
  return { seq: 0, meta: META, snapshot: { runs, tasks, coordinatorRuns }, messages: [] };
}

/** The rail row for a run — a button, because picking a run is the rail's whole job. */
function row(runId: string): HTMLElement {
  const found = screen.getAllByTestId('run-row').find((element) => element.dataset.run === runId);
  if (!found) throw new Error(`no rail row for ${runId}`);
  return found;
}

/** The canvas lays out asynchronously (elkjs), so the nodes arrive on a later tick. */
async function nodeTitles(count: number): Promise<string[]> {
  await waitFor(() => expect(screen.getAllByTestId('task-node')).toHaveLength(count));
  return screen.getAllByTestId('task-node').map((node) => node.textContent ?? '');
}

/** Two runs: an older finished one, and a newer live one that is therefore on top. */
const OLDER = run({
  id: 'run_older',
  handle: OTHER_HANDLE,
  label: 'Yesterday’s run',
  startedAt: '2026-07-10T09:00:00.000Z',
  endedAt: '2026-07-10T11:00:00.000Z',
  taskCount: 1,
  statusCounts: { pending: 0, ready: 0, dispatched: 0, completed: 1, failed: 0, blocked: 0 },
});

const NEWER = run({
  id: 'run_newer',
  handle: HANDLE,
  label: 'Ship the visualizer',
  startedAt: '2026-07-11T20:54:00.000Z',
  endedAt: '2026-07-11T21:30:00.000Z',
  taskCount: 2,
  statusCounts: { pending: 0, ready: 0, dispatched: 1, completed: 1, failed: 0, blocked: 0 },
  live: true,
});

/** As the server sends them: most recently active first. */
const BOTH_RUNS = [NEWER, OLDER];

const BOTH_RUNS_TASKS = [
  task({ id: 'task_old', runId: 'run_older', title: 'Yesterday’s only task' }),
  task({ id: 'task_new_one', runId: 'run_newer', title: 'Read the database' }),
  task({ id: 'task_new_two', runId: 'run_newer', title: 'Derive the runs', status: 'dispatched' }),
];

describe('the run rail', () => {
  it('is headed "Runs (inferred)" — the schema has no run id and the UI will not pretend it does', () => {
    render(<App event={event([NEWER], [])} />);

    expect(screen.getByRole('heading', { name: 'Runs (inferred)' })).toBeVisible();
  });

  it('shows what each run was trying to do, when, how big it was and how it went', () => {
    render(<App event={event([NEWER], [])} />);

    // Enough to pick the interesting run *without opening it* (SPEC §7.2).
    const rail = row('run_newer');
    expect(within(rail).getByText('Ship the visualizer')).toBeVisible();
    expect(rail).toHaveTextContent('2 tasks');
    expect(rail).toHaveTextContent('1 done / 1 dispatched');
    expect(rail).toHaveTextContent(/Jul/); // …and the day it ran.
  });

  it('keeps the full terminal handle in a tooltip — the row is too narrow for a uuid', () => {
    render(<App event={event([NEWER], [])} />);

    expect(row('run_newer')).toHaveAttribute('title', HANDLE);
  });

  it('marks a genuinely live run with a green dot, and a finished one without', () => {
    render(<App event={event(BOTH_RUNS, BOTH_RUNS_TASKS)} />);

    // The one thing that tells a running orchestration from a finished one — and the only
    // difference between "history" and "now" in a tool that has no history mode (SPEC §7.3).
    expect(within(row('run_newer')).getByTestId('live-dot')).toHaveAttribute('data-live', 'true');
    expect(within(row('run_older')).getByTestId('live-dot')).toHaveAttribute('data-live', 'false');
  });

  it('lists the unattributed run as a normal row rather than hiding the orphans', () => {
    const orphans = run({ id: 'run_unattributed', handle: null, label: 'Unattributed', taskCount: 4 });

    render(<App event={event([NEWER, orphans], BOTH_RUNS_TASKS)} />);

    expect(within(row('run_unattributed')).getByText('Unattributed')).toBeVisible();
    expect(row('run_unattributed')).toHaveTextContent('4 tasks');
  });

  it('says so plainly when there is nothing to list', () => {
    render(<App event={event([], [])} />);

    expect(screen.getByText(/No runs yet/i)).toBeVisible();
  });
});

describe('the canvas renders exactly one run', () => {
  it('opens on the most recently active run, before you have clicked anything', async () => {
    render(<App event={event(BOTH_RUNS, BOTH_RUNS_TASKS)} />);

    expect(row('run_newer')).toHaveAttribute('aria-current', 'true');
    // The whole ticket: the other run's task is not on the canvas. 76 tasks in one graph is
    // the soup this exists to resolve.
    const titles = await nodeTitles(2);
    expect(titles.join(' ')).toContain('Read the database');
    expect(titles.join(' ')).not.toContain('Yesterday');
  });

  it('swaps the canvas to the run you pick — yesterday through the same code path as today', async () => {
    render(<App event={event(BOTH_RUNS, BOTH_RUNS_TASKS)} />);
    await nodeTitles(2);

    await userEvent.click(row('run_older'));

    const titles = await nodeTitles(1);
    expect(titles.join(' ')).toContain('Yesterday’s only task');
    expect(row('run_older')).toHaveAttribute('aria-current', 'true');
    expect(row('run_newer')).toHaveAttribute('aria-current', 'false');
  });

  it('counts only the selected run in the edgeless note, not the whole database', async () => {
    // The note is what an edgeless run gets instead of an empty canvas (SPEC §7.5). Scoped
    // to the run, it says "2 tasks" — unscoped, it would say 3 and be a lie about this run.
    render(<App event={event(BOTH_RUNS, BOTH_RUNS_TASKS)} />);

    await nodeTitles(2);
    expect(screen.getByTestId('edgeless-note')).toHaveTextContent(
      'No dependencies in this run — 2 tasks dispatched independently.'
    );
  });
});

/**
 * The rail *is* the history browser (SPEC §7.3). A run that starts while you are reading an
 * old one must never yank the canvas out from under you — you are told, and you decide.
 */
describe('a new run arriving while you read an old one', () => {
  it('leaves your selection alone and offers the jump instead of taking it', async () => {
    const { rerender } = render(<App event={event([OLDER], [BOTH_RUNS_TASKS[0]!])} />);
    await nodeTitles(1);

    rerender(<App event={event(BOTH_RUNS, BOTH_RUNS_TASKS)} />);

    // Still reading yesterday. The new run announces itself; it does not interrupt.
    expect(row('run_older')).toHaveAttribute('aria-current', 'true');
    expect(await nodeTitles(1)).toEqual([expect.stringContaining('Yesterday’s only task')]);
    expect(screen.getByRole('button', { name: /new run started/i })).toBeVisible();
  });

  it('takes you there when you ask, and stops nagging once you have arrived', async () => {
    const { rerender } = render(<App event={event([OLDER], [BOTH_RUNS_TASKS[0]!])} />);
    await nodeTitles(1);
    rerender(<App event={event(BOTH_RUNS, BOTH_RUNS_TASKS)} />);

    await userEvent.click(screen.getByRole('button', { name: /new run started/i }));

    expect(row('run_newer')).toHaveAttribute('aria-current', 'true');
    await nodeTitles(2);
    expect(screen.queryByRole('button', { name: /new run started/i })).toBeNull();
  });

  it('says nothing when the runs are the ones you already knew about', async () => {
    const { rerender } = render(<App event={event([...BOTH_RUNS], BOTH_RUNS_TASKS)} />);
    await nodeTitles(2);

    // A tick that changed a task's status, not the run list. A chip here would be furniture.
    //
    // The arrays are rebuilt rather than re-passed: the server sends a *fresh* snapshot every
    // tick, and an implementation that re-announced every run it was handed would sail through
    // a test that quietly gave it the same array object twice.
    rerender(<App event={event([...BOTH_RUNS], [...BOTH_RUNS_TASKS])} />);

    expect(screen.queryByRole('button', { name: /new run started/i })).toBeNull();
  });
});

/**
 * `coordinator_runs` is empty in practice (SPEC §4.2, trap 3) — it cannot be the run-scoping
 * key, and nothing above depends on it. It is rendered *if rows exist*, and that is all.
 */
describe('coordinator runs', () => {
  const COORDINATOR: CoordinatorRun = {
    id: 'run_coordinator',
    status: 'running',
    coordinatorHandle: HANDLE,
    pollIntervalMs: 2000,
    createdAt: '2026-07-11T20:54:00.000Z',
    completedAt: null,
  };

  it('shows a coordinator row when Orca actually wrote one', () => {
    render(<App event={event([NEWER], BOTH_RUNS_TASKS, [COORDINATOR])} />);

    const panel = screen.getByTestId('coordinator-runs');
    expect(within(panel).getByText(/running/)).toBeVisible();
    expect(within(panel).getByText(/9f8e7d6c/)).toBeVisible();
  });

  it('is not furniture on the ~100% of databases that have none', () => {
    render(<App event={event([NEWER], BOTH_RUNS_TASKS)} />);

    expect(screen.queryByTestId('coordinator-runs')).toBeNull();
    // …and the runs are still there, because nothing about them depended on that table.
    expect(screen.getAllByTestId('run-row')).toHaveLength(1);
  });
});
