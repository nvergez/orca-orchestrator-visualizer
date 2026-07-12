import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/client/App.tsx';
import type { TaskLoader } from '../../src/client/inspector/detail.ts';
import type { Gate, Meta, Run, StreamEvent, Task } from '../../src/shared/types.ts';

/**
 * Clicking a gate selects the task it blocks, which swaps the dock to the inspector (#20) — and
 * the inspector fetches. These tests are about the *strip*, so it is handed a detail rather than
 * being allowed to reach for a network.
 */
const NO_DETAIL: TaskLoader = async (id) => ({ id, spec: null, result: null, attempts: [] });

/**
 * Seam 2 (#12): `<App>` fed a canned `StreamEvent` — the client's only input, and the same
 * event a seam-1 server emits.
 *
 * The gate strip is the one panel in this tool that is allowed to *interrupt*. It appears above
 * the canvas only while the selected run has a **blocking** gate — `gate.blocking`, the
 * server's separate present-effect fact, never the mere absence of an answer (#45) — and it
 * goes away the moment nothing is blocked, so that it stays a signal and never becomes
 * furniture (SPEC §7.4). What is asserted here is exactly that: what a blocked user sees, and
 * what an unblocked one does not.
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
const RUN_ID = 'run_9f8e7d6c_1000';
const OTHER_RUN_ID = 'run_1a2b3c4d_2000';

/** The default is a blocking gate — an unanswered ask whose task is authoritatively blocked. */
function gate(over: Partial<Gate> = {}): Gate {
  return {
    id: 'msg_gate',
    messageId: 'msg_gate',
    runId: RUN_ID,
    taskId: 'task_aaaaaaaa',
    question: 'Which driver: node:sqlite or better-sqlite3?',
    options: ['node:sqlite', 'better-sqlite3'],
    status: 'unanswered',
    blocking: true,
    resolution: null,
    createdAt: '2026-07-08T12:05:00.000Z',
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task_aaaaaaaa',
    runId: RUN_ID,
    parentId: null,
    title: 'Pick the SQLite driver',
    status: 'dispatched',
    deps: [],
    createdAt: '2026-07-08T12:00:00.000Z',
    completedAt: null,
    hasSpec: true,
    hasResult: false,
    dispatch: null,
    attemptCount: 1,
    gate: null,
    ...over,
  };
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    handle: HANDLE,
    label: 'Ship the visualizer',
    startedAt: '2026-07-08T12:00:00.000Z',
    lastActivityAt: '2026-07-08T13:00:00.000Z',
    converged: false,
    endedAt: '2026-07-08T13:00:00.000Z',
    taskCount: 1,
    cast: [],
    waves: [],
    statusCounts: { pending: 0, ready: 0, dispatched: 1, completed: 0, failed: 0, blocked: 0 },
    live: true,
    hasBlockingGates: false,
    edgeCount: 0,
    ...over,
  };
}

/**
 * The event a server that has read a blocked run really sends: the gate is in `snapshot.gates`,
 * the run it blocks says `hasBlockingGates`, and the node it marks carries it — the oldest
 * blocking one, or the latest as history (`server/gates.ts`). A fixture that set only one of
 * the three would be testing an event the server cannot produce.
 */
function event(gates: Gate[], tasks: Task[] = [task()], runs: Run[] = [run()]): StreamEvent {
  const blocked = new Set(gates.filter((each) => each.blocking).map((each) => each.runId));
  const markerOf = (taskId: string): Gate | null => {
    const held = gates.filter((candidate) => candidate.taskId === taskId);
    return held.find((candidate) => candidate.blocking) ?? held[held.length - 1] ?? null;
  };

  return {
    seq: 0,
    meta: META,
    snapshot: {
      runs: runs.map((each) => ({ ...each, hasBlockingGates: blocked.has(each.id) })),
      tasks: tasks.map((each) => ({ ...each, gate: each.gate ?? markerOf(each.id) })),
      gates,
      turns: [],
      coordinatorRuns: [],
    },
    messages: [],
  };
}

function strip(): HTMLElement | null {
  return screen.queryByTestId('gate-strip');
}

/** The canvas lays out asynchronously (elkjs), so the nodes arrive on a later tick. */
async function node(id: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = screen.getAllByTestId('task-node').find((element) => element.dataset.task === id);
    if (!found) throw new Error(`no node for ${id}`);
    return found;
  });
}

describe('the gate strip', () => {
  it('shows the question, the options and the task it blocks', async () => {
    render(<App loadTask={NO_DETAIL} event={event([gate()])} />);

    const shown = strip();
    expect(shown).not.toBeNull();
    expect(within(shown!).getByText(/Which driver/)).toBeVisible();
    expect(within(shown!).getByText('node:sqlite')).toBeVisible();
    expect(within(shown!).getByText('better-sqlite3')).toBeVisible();
    // *Whose* decision it is: the task that is sitting on the question, by name.
    expect(within(shown!).getByText(/Pick the SQLite driver/)).toBeVisible();
  });

  it('is not there at all when nothing in the selected run is blocked', () => {
    // The whole point of the strip: it disappears when nothing is blocked, so it is a signal
    // and not furniture (SPEC §7.4).
    render(<App loadTask={NO_DETAIL} event={event([])} />);

    expect(strip()).toBeNull();
  });

  it('is not there when every gate in the run has been answered', () => {
    render(
      <App
        loadTask={NO_DETAIL}
        event={event([gate({ status: 'resolved', blocking: false, resolution: 'node:sqlite' })])}
      />
    );

    expect(strip()).toBeNull();
  });

  it('is not there for an unanswered ask that is not blocking — history is not an interruption', () => {
    // The #45 regression, on screen: a reply-less ask on a finished or moving task proves only
    // that no answer was recorded. The strip is driven by `blocking`, never by silence — the
    // question stays reachable in the conversation and the inspector instead.
    render(<App loadTask={NO_DETAIL} event={event([gate({ status: 'unanswered', blocking: false })])} />);

    expect(strip()).toBeNull();
  });

  it('is not there for a timed-out gate — a terminal state, not a blocker', () => {
    render(<App loadTask={NO_DETAIL} event={event([gate({ status: 'timeout', blocking: false })])} />);

    expect(strip()).toBeNull();
  });

  it('shows a table-backed pending gate — durable proof the run is waiting', async () => {
    render(<App loadTask={NO_DETAIL} event={event([gate({ status: 'pending', blocking: true })])} />);

    expect(within(strip()!).getByText(/Which driver/)).toBeVisible();
  });

  it('selects the task a gate blocks when the gate is clicked', async () => {
    // Straight from the question to its context (#12, story 26): the node is selected, which
    // is what centres it on the canvas and filters the feed to its story.
    render(<App loadTask={NO_DETAIL} event={event([gate()])} />);

    await userEvent.click(within(strip()!).getByRole('button', { name: /Which driver/ }));

    expect(await node('task_aaaaaaaa')).toHaveAttribute('data-selected', 'true');
  });

  it('shows a gate that names no task, and offers nothing to click through to', async () => {
    // 32 of the 53 live gate messages carry no `payload.taskId`. They block the *run*, so they
    // still interrupt — there is simply no node to send the user to (SPEC §4.5).
    render(<App loadTask={NO_DETAIL} event={event([gate({ taskId: null })])} />);

    const shown = strip();
    expect(within(shown!).getByText(/Which driver/)).toBeVisible();
    expect(within(shown!).queryByRole('button', { name: /Which driver/ })).toBeNull();
    expect(within(shown!).getByText(/no task/i)).toBeVisible();
  });

  it('copies the id of a gate that names no task — the one place it is reachable at all', async () => {
    // The strip is where a person is standing when they decide to go and answer the question, and
    // this tool will never answer it for them (SPEC §1.2). A run-level gate opens no inspector, so
    // without this its id — the thing every `orca orchestration` command needs — appears nowhere.
    const user = userEvent.setup();
    render(<App loadTask={NO_DETAIL} event={event([gate({ id: 'msg_run_gate', taskId: null })])} />);

    await user.click(within(strip()!).getByRole('button', { name: 'Copy the gate id msg_run_gate' }));

    expect(await navigator.clipboard.readText()).toBe('msg_run_gate');
  });

  it('copies a gate’s id without selecting the task it blocks — two clicks, two intentions', async () => {
    const user = userEvent.setup();
    render(<App loadTask={NO_DETAIL} event={event([gate()])} />);

    await user.click(within(strip()!).getByRole('button', { name: 'Copy the gate id msg_gate' }));

    expect(await navigator.clipboard.readText()).toBe('msg_gate');
    // The copy button is a sibling of the row, not a child of it — so the dock is left alone.
    expect(await node('task_aaaaaaaa')).toHaveAttribute('data-selected', 'false');
  });

  it('shows only the selected run’s gates — never another run’s', async () => {
    const gates = [
      gate({ id: 'msg_here', question: 'Blocking this run' }),
      gate({ id: 'msg_there', runId: OTHER_RUN_ID, taskId: null, question: 'Blocking another run' }),
    ];
    const runs = [run(), run({ id: OTHER_RUN_ID, handle: OTHER_HANDLE, label: 'Another run' })];

    render(<App loadTask={NO_DETAIL} event={event(gates, [task()], runs)} />);

    expect(within(strip()!).getByText(/Blocking this run/)).toBeVisible();
    expect(within(strip()!).queryByText(/Blocking another run/)).toBeNull();
  });

  it('follows the selection: switching to a blocked run raises the strip, and back lowers it', async () => {
    const gates = [gate({ id: 'msg_there', runId: OTHER_RUN_ID, taskId: 'task_bbbbbbbb', question: 'Blocking the other run' })];
    const tasks = [task(), task({ id: 'task_bbbbbbbb', runId: OTHER_RUN_ID, title: 'The other task' })];
    const runs = [run(), run({ id: OTHER_RUN_ID, handle: OTHER_HANDLE, label: 'Another run' })];

    render(<App loadTask={NO_DETAIL} event={event(gates, tasks, runs)} />);

    // The rail opens on the most recently active run, which here is the unblocked one.
    expect(strip()).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Another run/ }));
    expect(within(strip()!).getByText(/Blocking the other run/)).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: /Ship the visualizer/ }));
    expect(strip()).toBeNull();
  });

  it('lists every blocking gate in the run, oldest first — the one blocking longest at the top', () => {
    const gates = [
      gate({ id: 'msg_1', question: 'Asked first', createdAt: '2026-07-08T12:05:00.000Z' }),
      gate({ id: 'msg_2', taskId: null, question: 'Asked second', createdAt: '2026-07-08T12:40:00.000Z' }),
    ];

    render(<App loadTask={NO_DETAIL} event={event(gates)} />);

    const questions = within(strip()!)
      .getAllByTestId('gate')
      .map((entry) => entry.textContent);

    expect(questions[0]).toMatch(/Asked first/);
    expect(questions[1]).toMatch(/Asked second/);
  });
});

describe('the gate marker on a node', () => {
  it('marks a task that is blocked on a blocking gate', async () => {
    render(<App loadTask={NO_DETAIL} event={event([gate()])} />);

    expect(within(await node('task_aaaaaaaa')).getByTestId('gate-marker')).toBeVisible();
  });

  it('does not mark a task whose gate has been answered', async () => {
    render(
      <App
        loadTask={NO_DETAIL}
        event={event([gate({ status: 'resolved', blocking: false, resolution: 'node:sqlite' })])}
      />
    );

    expect(within(await node('task_aaaaaaaa')).queryByTestId('gate-marker')).toBeNull();
  });

  it('does not mark a task over an unanswered ask that is not blocking it', async () => {
    // The ⛔ is a warning that work is paused *now*. The unanswered question is still the
    // task's history — the inspector shows it — but the node stays quiet (#45).
    render(<App loadTask={NO_DETAIL} event={event([gate({ status: 'unanswered', blocking: false })])} />);

    expect(within(await node('task_aaaaaaaa')).queryByTestId('gate-marker')).toBeNull();
  });

  it('does not mark a task that has no gate at all', async () => {
    render(<App loadTask={NO_DETAIL} event={event([])} />);

    expect(within(await node('task_aaaaaaaa')).queryByTestId('gate-marker')).toBeNull();
  });
});

describe('the rail', () => {
  it('flags a run that is blocked, so the blocked one can be picked without opening it', () => {
    const gates = [gate({ id: 'msg_there', runId: OTHER_RUN_ID, taskId: null, status: 'pending' })];
    const runs = [run(), run({ id: OTHER_RUN_ID, handle: OTHER_HANDLE, label: 'Another run' })];

    render(<App loadTask={NO_DETAIL} event={event(gates, [task()], runs)} />);

    const rows = screen.getAllByTestId('run-row');
    const blocked = rows.find((row) => row.dataset.run === OTHER_RUN_ID)!;
    const unblocked = rows.find((row) => row.dataset.run === RUN_ID)!;

    expect(within(blocked).getByTestId('run-gate-marker')).toBeVisible();
    expect(within(unblocked).queryByTestId('run-gate-marker')).toBeNull();
  });

  it('does not flag a run over non-blocking gate history', () => {
    // Four live runs — two of them days finished — wore this flag before #45, over stale
    // probes nobody was waiting on.
    const gates = [
      gate({ id: 'msg_a', status: 'unanswered', blocking: false, taskId: null }),
      gate({ id: 'msg_b', status: 'timeout', blocking: false, taskId: null }),
      gate({ id: 'msg_c', status: 'resolved', blocking: false, resolution: 'done', taskId: null }),
    ];

    render(<App loadTask={NO_DETAIL} event={event(gates)} />);

    expect(within(screen.getByTestId('run-row')).queryByTestId('run-gate-marker')).toBeNull();
  });
});
