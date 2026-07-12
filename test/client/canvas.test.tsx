import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/client/App.tsx';
import {
  STALE_HEARTBEAT_MS,
  STATUS_COLORS,
  UNKNOWN_STATUS_COLOR,
} from '../../src/client/canvas/theme.ts';
import type { Dispatch, Meta, Run, StreamEvent, Task } from '../../src/shared/types.ts';

/**
 * Seam 2 (#12): `<App>` fed a canned `StreamEvent` — the client's only input, and therefore
 * the highest frontend seam there is.
 *
 * What is asserted is the DOM the user reads: the title on the node, the status chip, the
 * assignee, the retry marker, the last-seen badge, and the honest sentence an edgeless task
 * set gets. What is **not** asserted is elkjs coordinates or React Flow internals — the
 * prototype proved the layout at real scale on screen, and testing coordinates is exactly
 * the implementation-detail testing #12 forbids.
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

function dispatch(over: Partial<Dispatch> = {}): Dispatch {
  return {
    id: 'ctx_1',
    assigneeHandle: HANDLE,
    status: 'dispatched',
    failureCount: 0,
    lastFailure: null,
    dispatchedAt: '2026-07-08T12:00:00.000Z',
    completedAt: null,
    lastHeartbeatAt: null,
    ...over,
  };
}

/** The canvas draws exactly one run (#16), so every fixture task here belongs to this one. */
const RUN_ID = 'run_9f8e7d6c_1000';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task_aaaaaaaa',
    runId: RUN_ID,
    parentId: null,
    title: 'A task',
    status: 'pending',
    deps: [],
    createdAt: '2026-07-08T12:00:00.000Z',
    completedAt: null,
    hasSpec: true,
    hasResult: false,
    dispatch: null,
    attemptCount: 0,
    gate: null,
    ...over,
  };
}

/**
 * The run these tasks were inferred into. The server never emits a task without one, and the
 * canvas renders exactly the selected run's tasks — so a fixture that omitted the run would
 * be testing an event the server cannot send.
 */
function runOf(tasks: Task[]): Run {
  const inRun = new Set(tasks.map((task) => task.id));

  return {
    id: RUN_ID,
    handle: HANDLE,
    label: 'A run',
    startedAt: '2026-07-08T12:00:00.000Z',
    endedAt: '2026-07-08T13:00:00.000Z',
    taskCount: tasks.length,
    statusCounts: { pending: 0, ready: 0, dispatched: 0, completed: 0, failed: 0, blocked: 0 },
    live: false,
    hasOpenGates: false,
    // As the server counts it: only deps whose other end is in the run, so a dep left dangling
    // by a reset is not an edge here either.
    edgeCount: tasks.reduce((total, task) => total + task.deps.filter((dep) => inRun.has(dep)).length, 0),
  };
}

function event(tasks: Task[]): StreamEvent {
  return {
    seq: 0,
    meta: META,
    // No tasks means no runs to have inferred them into — the empty database, honestly.
    snapshot: { runs: tasks.length === 0 ? [] : [runOf(tasks)], tasks, coordinatorRuns: [] },
    messages: [],
  };
}

/** The canvas lays out asynchronously (elkjs), so the nodes arrive on a later tick. */
async function draw(tasks: Task[]): Promise<HTMLElement[]> {
  render(<App event={event(tasks)} />);
  await waitFor(() => expect(screen.getAllByTestId('task-node').length).toBe(tasks.length));
  return screen.getAllByTestId('task-node');
}

function node(id: string): HTMLElement {
  const found = screen.getAllByTestId('task-node').find((element) => element.dataset.task === id);
  if (!found) throw new Error(`no node for ${id} on the canvas`);
  return found;
}

describe('the task DAG on the canvas', () => {
  it('draws a node for every task, titled, without asking to be hovered', async () => {
    await draw([
      task({ id: 'task_one', title: 'Read the database' }),
      task({ id: 'task_two', title: 'Derive the runs', deps: ['task_one'] }),
    ]);

    // Scanning a finished run for the failed node must not require interaction (SPEC §7.5).
    expect(within(node('task_one')).getByText('Read the database')).toBeVisible();
    expect(within(node('task_two')).getByText('Derive the runs')).toBeVisible();
  });

  it('colours a node by its status, from the table the dev signed off on', async () => {
    await draw([
      task({ id: 'task_failed', status: 'failed' }),
      task({ id: 'task_done', status: 'completed' }),
    ]);

    // The one thing that lets you find the failed task by scanning rather than searching.
    expect(node('task_failed')).toHaveStyle({ background: STATUS_COLORS.failed.bg });
    expect(node('task_done')).toHaveStyle({ background: STATUS_COLORS.completed.bg });
  });

  it('keeps completed work on the canvas — a finished run is the whole point of a post-mortem', async () => {
    await draw([task({ id: 'task_done', status: 'completed', title: 'Ship the thing' })]);

    expect(within(node('task_done')).getByText('Ship the thing')).toBeVisible();
  });

  it('renders a status it has never heard of in neutral grey, labelled with the raw string', async () => {
    await draw([task({ id: 'task_strange', status: 'quarantined' })]);

    // Never dropped, never crashed on: a new Orca status shows up as *something* (SPEC §5),
    // in a colour that claims nothing about it.
    expect(within(node('task_strange')).getByText('quarantined')).toBeVisible();
    expect(node('task_strange')).toHaveStyle({ background: UNKNOWN_STATUS_COLOR.bg });
  });

  it('badges the node with who is working it, and how close they are to the breaker', async () => {
    await draw([
      task({ id: 'task_worked', status: 'dispatched', dispatch: dispatch(), attemptCount: 1 }),
      task({
        id: 'task_failing',
        status: 'dispatched',
        dispatch: dispatch({ failureCount: 2 }),
        attemptCount: 1,
      }),
    ]);

    // First 8 hex of the handle — enough to know who to go talk to.
    expect(within(node('task_worked')).getByTestId('assignee')).toHaveTextContent('9f8e7d6c');
    expect(within(node('task_worked')).queryByTestId('failure-count')).toBeNull();
    // The circuit breaker trips at 3: this task is visibly circling the drain.
    expect(within(node('task_failing')).getByTestId('failure-count')).toHaveTextContent('✗2');
  });

  it('marks a retried task — the only visible sign, anywhere, that a task was re-dispatched', async () => {
    await draw([
      task({ id: 'task_retried', status: 'dispatched', dispatch: dispatch(), attemptCount: 3 }),
      task({ id: 'task_first_try', status: 'dispatched', dispatch: dispatch(), attemptCount: 1 }),
    ]);

    expect(within(node('task_retried')).getByTestId('retry-marker')).toHaveTextContent('3');
    // …and it must not cry wolf on a task that was dispatched once.
    expect(within(node('task_first_try')).queryByTestId('retry-marker')).toBeNull();
  });

  it('tells a working agent from a hung one with a last-seen badge that goes amber', async () => {
    const now = Date.now();

    await draw([
      task({
        id: 'task_alive',
        status: 'dispatched',
        dispatch: dispatch({ lastHeartbeatAt: new Date(now - 12_000).toISOString() }),
        attemptCount: 1,
      }),
      task({
        id: 'task_quiet',
        status: 'dispatched',
        dispatch: dispatch({
          lastHeartbeatAt: new Date(now - STALE_HEARTBEAT_MS - 60_000).toISOString(),
        }),
        attemptCount: 1,
      }),
    ]);

    expect(within(node('task_alive')).getByTestId('last-seen')).toHaveTextContent(/last seen 12s ago/);
    expect(within(node('task_alive')).getByTestId('last-seen')).toHaveAttribute('data-stale', 'false');
    // Past the threshold the agent has missed two beats: that is a worker to go look at.
    expect(within(node('task_quiet')).getByTestId('last-seen')).toHaveAttribute('data-stale', 'true');
  });

  it('shows the last-seen badge only while the dispatch is dispatched', async () => {
    await draw([
      // On a completed dispatch the last heartbeat is just when the work stopped. An amber
      // badge there would cry wolf about a run that finished perfectly well.
      task({
        id: 'task_done',
        status: 'completed',
        dispatch: dispatch({ status: 'completed', lastHeartbeatAt: '2026-07-08T12:00:00.000Z' }),
        attemptCount: 1,
      }),
      // And the task's status is *not* the question the badge answers: a task can still read
      // `dispatched` while its latest attempt has already tripped the breaker. A "last seen
      // 3h ago" there would report a hung agent where the schema says a burned attempt.
      task({
        id: 'task_burned',
        status: 'dispatched',
        dispatch: dispatch({ status: 'circuit_broken', lastHeartbeatAt: '2026-07-08T12:00:00.000Z' }),
        attemptCount: 3,
      }),
    ]);

    expect(within(node('task_done')).queryByTestId('last-seen')).toBeNull();
    expect(within(node('task_burned')).queryByTestId('last-seen')).toBeNull();
  });
});

/**
 * Dependency edges are a **status affordance, never message flow** (SPEC §7.6): an edge into
 * a dispatched task is dashed and animated, which is how the canvas shows where work is
 * actually in flight.
 *
 * The assertions below read React Flow's *rendered output* — the `data-id` and `animated`
 * class it documents for styling — never its store, its internals or any coordinate. What
 * an edge is *worth* is that you can see the work moving, and that is a DOM fact.
 */
describe('the dependency edges', () => {
  /** An edge is drawn only once both its nodes have been measured — a tick after they appear. */
  function edge(id: string): Promise<Element> {
    return waitFor(() => {
      const found = document.querySelector(`.react-flow__edge[data-id="${id}"]`);
      if (!found) throw new Error(`no edge ${id} on the canvas`);
      return found;
    });
  }

  it('animates an edge into work that is in flight, and leaves the settled ones still', async () => {
    await draw([
      task({ id: 'task_done', status: 'completed' }),
      task({ id: 'task_running', status: 'dispatched', deps: ['task_done'], dispatch: dispatch() }),
      task({ id: 'task_next', status: 'pending', deps: ['task_running'] }),
    ]);

    expect(await edge('task_done->task_running')).toHaveClass('animated');
    // Nothing is in flight into a pending task, and a canvas that animated everything would
    // be telling you nothing.
    expect(await edge('task_running->task_next')).not.toHaveClass('animated');
  });
});

/**
 * ~50 of 76 live tasks touch no edge at all, and 4 of 13 real runs are entirely edgeless.
 * The canvas owns that shape rather than treating it as a rendering failure (SPEC §7.5).
 */
describe('tasks that depend on nothing', () => {
  it('describes an edgeless task set honestly instead of looking broken', async () => {
    await draw([
      task({ id: 'task_one', title: 'One' }),
      task({ id: 'task_two', title: 'Two' }),
      task({ id: 'task_three', title: 'Three' }),
    ]);

    expect(screen.getByTestId('edgeless-note')).toHaveTextContent(
      'No dependencies in this run — 3 tasks dispatched independently.'
    );
  });

  it('says nothing of the sort when the tasks actually do depend on each other', async () => {
    await draw([task({ id: 'task_one' }), task({ id: 'task_two', deps: ['task_one'] })]);

    expect(screen.queryByTestId('edgeless-note')).toBeNull();
  });

  it('collects the singletons into a block that collapses, and starts expanded', async () => {
    await draw([
      task({ id: 'task_one', title: 'In the DAG' }),
      task({ id: 'task_two', title: 'Also in the DAG', deps: ['task_one'] }),
      task({ id: 'task_lonely', title: 'Depends on nothing' }),
      task({ id: 'task_lonelier', title: 'Also depends on nothing' }),
    ]);

    // Nothing is hidden by default (SPEC §7.5) — the block is a way to get 50 singletons
    // out of the way, not a way to hide work you did not ask about.
    const toggle = screen.getByRole('button', { name: /Isolated tasks \(2\)/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(node('task_lonely')).toBeVisible();

    await userEvent.click(toggle);

    await waitFor(() => expect(screen.getAllByTestId('task-node')).toHaveLength(2));
    expect(screen.getByRole('button', { name: /Isolated tasks \(2\)/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    // The DAG itself never collapses.
    expect(node('task_one')).toBeVisible();
  });

  it('drops an edge whose other end a reset deleted, and keeps the node', async () => {
    // No foreign keys anywhere in this schema (SPEC §4.2, trap 8): `deps` can name a task
    // that no longer exists. That costs one line, never the graph.
    await draw([task({ id: 'task_survivor', title: 'Survivor', deps: ['task_wiped_by_reset'] })]);

    expect(within(node('task_survivor')).getByText('Survivor')).toBeVisible();
    expect(screen.getByTestId('edgeless-note')).toBeVisible();
  });
});

describe('a database with nothing in it', () => {
  it('says so rather than drawing an empty canvas', async () => {
    render(<App event={event([])} />);

    expect(await screen.findByText(/No tasks in this database/i)).toBeVisible();
  });
});
