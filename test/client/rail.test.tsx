import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CastMember, CoordinatorRun, Dispatch, Meta, Run, Task } from '../../src/shared/types.ts';
import { CannedApp, type CannedEvent } from './canned.tsx';

/**
 * Seam 2 (#12): `<CannedApp>` fed a canned world (`CannedEvent`, canned.tsx) — the client's only input.
 *
 * **The rail lists orchestrators, and the cast is the pivot.** 76 tasks in one graph is unreadable;
 * the rail is what makes the canvas mean something. It used to be headed "Runs (inferred)" and it
 * had to be — a row *was* a guess, because the six-hour idle gap cut one terminal's tasks into
 * several unrelated rows for no reason the screen ever gave. A row is now one
 * `created_by_terminal_handle`, which is a column and not a guess, and the gap is a **wave** on the
 * canvas (SPEC §4.3).
 *
 * What that leaves the rail free to do is the thing this whole feature is for: **name the cast.**
 * The orchestrator and its agents nest under the open row, and selecting an agent dims the canvas to
 * their tasks and fills the conversation with their half of the dialogue. That single click is the
 * tool's central gesture, and it is asserted here and in `canvas.test.tsx` and `conversation.test.tsx`
 * — once from each of the three panels it moves.
 */

const META: Meta = {
  dbPath: '/home/dev/.config/orca/orchestration.db',
  schemaVersion: 5,
  schemaSupport: 'supported',
  degraded: [],
  liveness: 'live',
  orcaPid: 4242,
  dbMtime: '2026-07-11T20:54:00.000Z',
  historyLoss: [],
};

const HANDLE = 'term_9f8e7d6c-1234-4321-8888-aabbccddeeff';
const OTHER_HANDLE = 'term_1a2b3c4d-1234-4321-8888-aabbccddeeff';

function run(over: Partial<Run> = {}): Run {
  return {
    id: 'run_9f8e7d6c_1000',
    handle: HANDLE,
    label: 'Ship the visualizer',
    startedAt: '2026-07-11T20:54:00.000Z',
    lastActivityAt: '2026-07-11T21:30:00.000Z',
    converged: true,
    endedAt: '2026-07-11T21:30:00.000Z',
    taskCount: 1,
    cast: [],
    waves: [],
    statusCounts: { pending: 0, ready: 0, dispatched: 0, completed: 1, failed: 0, blocked: 0 },
    live: false,
    hasBlockingGates: false,
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

function dispatch(assigneeHandle: string, over: Partial<Dispatch> = {}): Dispatch {
  return {
    id: `ctx_${assigneeHandle}`,
    assigneeHandle,
    status: 'dispatched',
    failureCount: 0,
    lastFailure: null,
    dispatchedAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: null,
    lastHeartbeatAt: null,
    ...over,
  };
}

function event(runs: Run[], tasks: Task[], coordinatorRuns: CoordinatorRun[] = []): CannedEvent {
  return {
    seq: 0,
    affected: { all: true, runIds: [], unplaced: false },
    meta: META,
    snapshot: { runs, tasks, gates: [], turns: [], coordinatorRuns },
    messages: [],
  };
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
  cast: [],
  waves: [],
  statusCounts: { pending: 0, ready: 0, dispatched: 0, completed: 1, failed: 0, blocked: 0 },
});

const NEWER = run({
  id: 'run_newer',
  handle: HANDLE,
  label: 'Ship the visualizer',
  startedAt: '2026-07-11T20:54:00.000Z',
  lastActivityAt: '2026-07-11T21:30:00.000Z',
  converged: false,
  endedAt: '2026-07-11T21:30:00.000Z',
  taskCount: 2,
  cast: [],
  waves: [],
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
  it('is headed "Orchestrators" — because a row is a column, and no longer a guess', () => {
    render(<CannedApp event={event([NEWER], [])} />);

    // It used to read "Runs (inferred)", and it had to: a row *was* a guess, because the six-hour
    // idle gap cut one terminal's tasks into several unrelated rows. The gap is now a **wave** drawn
    // on the canvas (SPEC §4.3), one terminal is one orchestrator, and there is nothing inferred
    // about `tasks.created_by_terminal_handle`.
    expect(screen.getByRole('heading', { name: 'Orchestrators' })).toBeVisible();
  });

  it('shows the terminal that ran it — the orchestrator’s only name in the schema', () => {
    render(<CannedApp event={event([NEWER], [])} />);

    expect(row('run_newer')).toHaveTextContent(HANDLE);
  });

  it('shows what each run was trying to do, when, how big it was and how it went', () => {
    render(<CannedApp event={event([NEWER], [])} />);

    // Enough to pick the interesting run *without opening it* (SPEC §7.2).
    const rail = row('run_newer');
    expect(within(rail).getByText('Ship the visualizer')).toBeVisible();
    expect(rail).toHaveTextContent('2 tasks');
    expect(rail).toHaveTextContent('1 done / 1 dispatched');
    expect(rail).toHaveTextContent(/Jul/); // …and the day it ran.
  });

  it('keeps the full terminal handle in a tooltip — the row is too narrow for a uuid', () => {
    render(<CannedApp event={event([NEWER], [])} />);

    expect(row('run_newer')).toHaveAttribute('title', HANDLE);
  });

  // The `live-dot` test that stood here is deliberately gone (#48/#81). `Run.live` was the lie
  // the issue was filed about — "Orca is running and something is dispatched" is not "this run
  // is alive" — and the dot it drove is replaced by the three-state health model asserted in
  // "run health on the rail" below (`active | silent | finished`), which says strictly more and
  // says it honestly. `Run.live` survives only as a deprecated wire alias; nothing renders it.

  it('lists the unattributed run as a normal row rather than hiding the orphans', () => {
    const orphans = run({ id: 'run_unattributed', handle: null, label: 'Unattributed', taskCount: 4 });

    render(<CannedApp event={event([NEWER, orphans], BOTH_RUNS_TASKS)} />);

    expect(within(row('run_unattributed')).getByText('Unattributed')).toBeVisible();
    expect(row('run_unattributed')).toHaveTextContent('4 tasks');
  });

  it('says so plainly when there is nothing to list', () => {
    render(<CannedApp event={event([], [])} />);

    expect(screen.getByText(/No orchestrators yet/i)).toBeVisible();
  });
});

/**
 * Run health on the rail (SPEC §12.3): `active | silent | finished`, derived on the client from
 * `converged`, `lastActivityAt` and a wall clock — never from `run.live`, which is deprecated
 * wire compatibility the new client ignores (SPEC §12.4). The words are the glossary's
 * (CONTEXT.md): a silent run is never called "ended", "dead" or "stuck" — the tool reports
 * evidence, not a diagnosis.
 */
describe('run health on the rail', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function healthDot(runId: string): HTMLElement {
    return within(row(runId)).getByTestId('health-dot');
  }

  it('shows all three states for what they are — evidence about the run, not the process', () => {
    // Orca itself is `live` in META, and that must not drag the silent run to active — nor may
    // the active run's recency drag the finished one away from finished (SPEC §12.1).
    const active = run({
      id: 'run_active',
      converged: false,
      lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const silent = run({
      id: 'run_silent',
      handle: OTHER_HANDLE,
      converged: false,
      lastActivityAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      statusCounts: { pending: 0, ready: 0, dispatched: 1, completed: 0, failed: 0, blocked: 0 },
    });
    const finished = run({
      id: 'run_finished',
      handle: 'term_3c4d5e6f-1234-4321-8888-aabbccddeeff',
      converged: true,
      lastActivityAt: new Date(Date.now() - 30_000).toISOString(),
    });

    render(<CannedApp event={event([active, silent, finished], [])} />);

    expect(healthDot('run_active')).toHaveAttribute('data-health', 'active');
    expect(healthDot('run_silent')).toHaveAttribute('data-health', 'silent');
    expect(healthDot('run_finished')).toHaveAttribute('data-health', 'finished');
    // The old vocabulary is gone: an unfinished silent run is not "ended" (SPEC §7.3).
    expect(row('run_silent')).not.toHaveTextContent('ended');
  });

  it('keeps recent activity active when Orca itself is stale — the process is a separate fact', () => {
    const active = run({
      id: 'run_active',
      converged: false,
      lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
    });

    render(<CannedApp event={{ ...event([active], []), meta: { ...META, liveness: 'stale', orcaPid: null } }} />);

    // Health says what the evidence says; the shell's liveness pill says the process just
    // exited. Both are on screen, and neither is folded into the other (SPEC §12.1).
    expect(healthDot('run_active')).toHaveAttribute('data-health', 'active');
    expect(screen.getByText(/showing last-known state/i)).toBeVisible();
  });

  it('crosses active → silent on the wall clock alone — a quiet database pushes no event', () => {
    // Nine and a half minutes of silence at render; nothing further ever arrives on the
    // stream. The shared wall clock must carry the run across the ten-minute boundary by
    // itself (SPEC §12.3) — this is exactly the crossing a server-computed value would freeze
    // behind the data_version gate.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-07-11T22:00:00.000Z'));

    const quiet = run({
      id: 'run_quiet',
      converged: false,
      lastActivityAt: new Date(Date.now() - (9 * 60_000 + 30_000)).toISOString(),
    });

    render(<CannedApp event={event([quiet], [])} />);
    expect(healthDot('run_quiet')).toHaveAttribute('data-health', 'active');

    // One minute of wall-clock time later — no push, no re-render from outside.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(healthDot('run_quiet')).toHaveAttribute('data-health', 'silent');
  });
});

describe('the canvas renders exactly one run', () => {
  it('opens on the most recently active run, before you have clicked anything', async () => {
    render(<CannedApp event={event(BOTH_RUNS, BOTH_RUNS_TASKS)} />);

    expect(row('run_newer')).toHaveAttribute('aria-current', 'true');
    // The whole ticket: the other run's task is not on the canvas. 76 tasks in one graph is
    // the soup this exists to resolve.
    const titles = await nodeTitles(2);
    expect(titles.join(' ')).toContain('Read the database');
    expect(titles.join(' ')).not.toContain('Yesterday');
  });

  it('swaps the canvas to the run you pick — yesterday through the same code path as today', async () => {
    render(<CannedApp event={event(BOTH_RUNS, BOTH_RUNS_TASKS)} />);
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
    render(<CannedApp event={event(BOTH_RUNS, BOTH_RUNS_TASKS)} />);

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
    const { rerender } = render(<CannedApp event={event([OLDER], [BOTH_RUNS_TASKS[0]!])} />);
    await nodeTitles(1);

    rerender(<CannedApp event={event(BOTH_RUNS, BOTH_RUNS_TASKS)} />);

    // Still reading yesterday. The new run announces itself; it does not interrupt.
    expect(row('run_older')).toHaveAttribute('aria-current', 'true');
    expect(await nodeTitles(1)).toEqual([expect.stringContaining('Yesterday’s only task')]);
    expect(screen.getByRole('button', { name: /new orchestration started/i })).toBeVisible();
  });

  it('takes you there when you ask, and stops nagging once you have arrived', async () => {
    const { rerender } = render(<CannedApp event={event([OLDER], [BOTH_RUNS_TASKS[0]!])} />);
    await nodeTitles(1);
    rerender(<CannedApp event={event(BOTH_RUNS, BOTH_RUNS_TASKS)} />);

    await userEvent.click(screen.getByRole('button', { name: /new orchestration started/i }));

    expect(row('run_newer')).toHaveAttribute('aria-current', 'true');
    await nodeTitles(2);
    expect(screen.queryByRole('button', { name: /new orchestration started/i })).toBeNull();
  });

  it('says nothing when the runs are the ones you already knew about', async () => {
    const { rerender } = render(<CannedApp event={event([...BOTH_RUNS], BOTH_RUNS_TASKS)} />);
    await nodeTitles(2);

    // A tick that changed a task's status, not the run list. A chip here would be furniture.
    //
    // The arrays are rebuilt rather than re-passed: the server sends a *fresh* snapshot every
    // tick, and an implementation that re-announced every run it was handed would sail through
    // a test that quietly gave it the same array object twice.
    rerender(<CannedApp event={event([...BOTH_RUNS], [...BOTH_RUNS_TASKS])} />);

    expect(screen.queryByRole('button', { name: /new orchestration started/i })).toBeNull();
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
    render(<CannedApp event={event([NEWER], BOTH_RUNS_TASKS, [COORDINATOR])} />);

    const panel = screen.getByTestId('coordinator-runs');
    expect(within(panel).getByText(/running/)).toBeVisible();
    expect(within(panel).getByText(/9f8e7d6c/)).toBeVisible();
  });

  it('is not furniture on the ~100% of databases that have none', () => {
    render(<CannedApp event={event([NEWER], BOTH_RUNS_TASKS)} />);

    expect(screen.queryByTestId('coordinator-runs')).toBeNull();
    // …and the runs are still there, because nothing about them depended on that table.
    expect(screen.getAllByTestId('run-row')).toHaveLength(1);
  });

  it('copies the coordinator’s handle, which is shortened here like every other one', async () => {
    const user = userEvent.setup();
    render(<CannedApp event={event([NEWER], BOTH_RUNS_TASKS, [COORDINATOR])} />);

    await user.click(screen.getByRole('button', { name: `Copy the coordinator handle ${HANDLE}` }));

    expect(await navigator.clipboard.readText()).toBe(HANDLE);
  });
});

/**
 * **The cast** — the orchestrator, and the agents it spawned (SPEC §4.3a, §7.2).
 *
 * The database has always known exactly who coordinated and who did the work, and neither has ever
 * appeared on screen. Both are columns: `tasks.created_by_terminal_handle` is the orchestrator, and
 * the `assignee_handle`s of its dispatch contexts are its agents.
 *
 * They nest under the open row, and not in a fourth column, because the hierarchy is *real*: an
 * orchestrator **contains** its agents.
 */
describe('the cast', () => {
  const ALICE = 'term_a11ce000-1234-4321-8888-aabbccddeeff';
  const BOB = 'term_b0b00000-1234-4321-8888-aabbccddeeff';

  const A1: CastMember = { handle: ALICE, monogram: 'A1', taskIds: ['task_1'], taskCount: 1, lastHeartbeatAt: null };
  const A2: CastMember = { handle: BOB, monogram: 'A2', taskIds: ['task_2'], taskCount: 2, lastHeartbeatAt: null };

  const CREW = run({ id: 'run_crew', cast: [A1, A2], taskCount: 3 });
  const CREW_TASKS = [
    task({ id: 'task_1', runId: 'run_crew' }),
    task({ id: 'task_2', runId: 'run_crew' }),
    task({ id: 'task_3', runId: 'run_crew' }),
  ];

  it('lists the orchestrator and its agents under the open row', () => {
    render(<CannedApp event={event([CREW], CREW_TASKS)} />);

    const cast = screen.getByTestId('cast');

    expect(within(cast).getByText('The orchestrator')).toBeVisible();
    expect(within(cast).getByText(HANDLE)).toBeVisible();

    expect(screen.getAllByTestId('agent-row').map((agent) => agent.dataset.agent)).toEqual(['A1', 'A2']);
  });

  it('counts the agents on the row, so you can pick an orchestration without opening it', () => {
    render(<CannedApp event={event([CREW], CREW_TASKS)} />);

    expect(within(row('run_crew')).getByTestId('agent-count')).toHaveTextContent('2 agents');
  });

  it('shows only the open orchestrator’s cast — an A1 in one is a different terminal from the next', () => {
    const other = run({ id: 'run_other', handle: OTHER_HANDLE, cast: [], label: 'Another orchestration' });

    render(<CannedApp event={event([CREW, other], CREW_TASKS)} />);

    // Exactly one cast is on screen, and it belongs to the row the rail has open.
    expect(screen.getAllByTestId('cast')).toHaveLength(1);
    expect(screen.getAllByTestId('agent-row')).toHaveLength(2);
  });

  it('says so when the orchestrator has no agents, rather than showing an empty list', () => {
    render(<CannedApp event={event([run({ id: 'run_quiet', cast: [] })], [task({ runId: 'run_quiet' })])} />);

    expect(screen.getByTestId('cast-empty')).toHaveTextContent(/has not dispatched/i);
  });

  it('says what an Unattributed row really is — no orchestrator on record, so nobody was dispatched', () => {
    render(
      <CannedApp
        event={event(
          [run({ id: 'run_unattributed', handle: null, label: 'Unattributed', cast: [] })],
          [task({ runId: 'run_unattributed' })]
        )}
      />
    );

    expect(screen.getByTestId('cast-empty')).toHaveTextContent(/no terminal handle/i);
  });

  it('badges an agent with current task evidence, and counts settled work instead of crying wolf', () => {
    const now = Date.now();
    const beating: CastMember = { ...A1, lastHeartbeatAt: new Date(now - 12_000).toISOString() };
    const historical: CastMember = { ...A2, lastHeartbeatAt: new Date(now - 3 * 60 * 60 * 1000).toISOString() };
    const tasks = [
      task({
        id: 'task_1',
        runId: 'run_crew',
        status: 'dispatched',
        dispatch: dispatch(ALICE, { lastHeartbeatAt: beating.lastHeartbeatAt }),
      }),
      task({
        id: 'task_2',
        runId: 'run_crew',
        status: 'completed',
        dispatch: dispatch(BOB, { status: 'completed', lastHeartbeatAt: historical.lastHeartbeatAt }),
      }),
    ];

    render(<CannedApp event={event([run({ id: 'run_crew', cast: [beating, historical] })], tasks)} />);

    const [alice, bob] = screen.getAllByTestId('agent-row');

    expect(within(alice!).getByTestId('agent-last-seen')).toHaveTextContent(/seen 12s ago/);
    expect(within(bob!).queryByTestId('agent-last-seen')).toBeNull();
    expect(bob!).toHaveTextContent('2 tasks');
  });

  it('shows never-heartbeating health consistently in the cast and run summary', () => {
    const now = Date.now();
    const tasks = [
      task({
        id: 'task_1',
        runId: 'run_crew',
        status: 'dispatched',
        dispatch: dispatch(ALICE, { dispatchedAt: new Date(now - 2 * 60_000).toISOString() }),
      }),
      task({
        id: 'task_2',
        runId: 'run_crew',
        status: 'dispatched',
        dispatch: dispatch(BOB, { dispatchedAt: new Date(now - 11 * 60_000).toISOString() }),
      }),
    ];

    const crew = run({
      id: 'run_crew',
      cast: [A1, A2],
      converged: false,
      lastActivityAt: new Date(now - 2 * 60_000).toISOString(),
    });
    render(<CannedApp event={event([crew], tasks)} />);

    const [alice, bob] = screen.getAllByTestId('agent-row');
    expect(alice).toHaveAttribute('data-health', 'quiet');
    expect(alice).toHaveTextContent(/dispatched 2m ago · no heartbeat/);
    expect(bob).toHaveAttribute('data-health', 'stale');
    expect(bob).toHaveTextContent(/dispatched 11m ago · no heartbeat/);

    const summary = within(row('run_crew')).getByTestId('run-worker-health');
    expect(summary).toHaveAttribute('data-health', 'stale');
    expect(summary).toHaveTextContent('1 stale without heartbeat · 1 awaiting heartbeat');
    // #48 owns run health (`converged` + `lastActivityAt`); worker health is additive and does
    // not rewrite that semantic — a stale worker leaves a recently active run `active`.
    expect(within(row('run_crew')).getByTestId('health-dot')).toHaveAttribute('data-health', 'active');
  });

  it('drops the agent when the rail moves to another orchestrator', async () => {
    // An `A1` in one orchestration is a different terminal from the `A1` in the next. Carrying the
    // selection across would silently dim the new canvas to a stranger.
    const user = userEvent.setup();
    const other = run({ id: 'run_other', handle: OTHER_HANDLE, cast: [A1], label: 'Another orchestration' });

    render(<CannedApp event={event([CREW, other], [...CREW_TASKS, task({ id: 'task_x', runId: 'run_other' })])} />);

    await user.click(screen.getAllByTestId('agent-row')[0]!);
    expect(screen.getAllByTestId('agent-row')[0]!.getAttribute('aria-pressed')).toBe('true');

    await user.click(row('run_other'));

    await waitFor(() => expect(screen.getAllByTestId('agent-row')[0]!.getAttribute('aria-pressed')).toBe('false'));
  });

  /**
   * **The handles, in full, one click away** (`src/client/copy.tsx`).
   *
   * A handle is a uuid, the rail is 18rem wide, and so the cast shows eight hex of it and keeps the
   * rest in a tooltip. That is right for *reading* and useless for *acting*: a handle is what you
   * hand `orca orchestration` when you go and ask an agent what it is doing. The row shows the short
   * one and copies the whole one — and copying must not select the agent, because they are two
   * different intentions and one of them re-scopes the entire screen.
   */
  it('copies an agent’s handle in full — never the eight hex the row has room for', async () => {
    const user = userEvent.setup();
    render(<CannedApp event={event([CREW], CREW_TASKS)} />);

    await user.click(screen.getByRole('button', { name: `Copy the agent handle ${BOB}` }));

    expect(await navigator.clipboard.readText()).toBe(BOB);
    // The copy button is a *sibling* of the row, not a child of it: clicking it must not dim the
    // canvas to A2's tasks.
    expect(screen.getAllByTestId('agent-row')[1]!.getAttribute('aria-pressed')).toBe('false');
  });

  it('copies the orchestrator’s handle from the head of its own cast', async () => {
    const user = userEvent.setup();
    render(<CannedApp event={event([CREW], CREW_TASKS)} />);

    await user.click(screen.getByRole('button', { name: `Copy the orchestrator handle ${HANDLE}` }));

    expect(await navigator.clipboard.readText()).toBe(HANDLE);
  });

  it('offers nothing to copy on the synthetic run — it has no handle, which is why it exists', () => {
    const orphans = run({ id: 'run_unattributed', handle: null, label: 'Unattributed', cast: [A1] });

    render(<CannedApp event={event([orphans], [task({ id: 'task_1', runId: 'run_unattributed' })])} />);

    expect(screen.queryByRole('button', { name: /copy the orchestrator handle/i })).toBeNull();
    // …and its agents, who *do* have handles, are copyable as any others are.
    expect(screen.getByRole('button', { name: `Copy the agent handle ${ALICE}` })).toBeVisible();
  });
});
