import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/client/App.tsx';
import {
  STALE_HEARTBEAT_MS,
  STATUS_THEME,
  UNKNOWN_STATUS_THEME,
} from '../../src/client/canvas/theme.ts';
import type { CastMember, Dispatch, Meta, Run, StreamEvent, Task, Wave } from '../../src/shared/types.ts';

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
 * The orchestrator these tasks belong to. The server never emits a task without one, and the canvas
 * renders exactly the selected orchestrator's tasks — so a fixture that omitted it would be testing
 * an event the server cannot send.
 *
 * The **cast** is derived the way the server derives it (`server/cast.ts`): the distinct assignees
 * of the tasks' dispatches, in first-dispatch order, monogrammed A1, A2, A3. A node's stripe and
 * badge are an index into this, so a fixture with the wrong cast is a fixture with the wrong node.
 */
function runOf(tasks: Task[], over: Partial<Run> = {}): Run {
  const inRun = new Set(tasks.map((task) => task.id));

  const handles: string[] = [];
  for (const task of tasks) {
    const handle = task.dispatch?.assigneeHandle;
    if (handle && !handles.includes(handle)) handles.push(handle);
  }

  const cast: CastMember[] = handles.map((handle, index) => ({
    handle,
    monogram: `A${index + 1}`,
    taskIds: tasks.filter((task) => task.dispatch?.assigneeHandle === handle).map((task) => task.id),
    taskCount: tasks.filter((task) => task.dispatch?.assigneeHandle === handle).length,
    lastHeartbeatAt: null,
  }));

  return {
    id: RUN_ID,
    handle: HANDLE,
    label: 'A run',
    startedAt: '2026-07-08T12:00:00.000Z',
    endedAt: '2026-07-08T13:00:00.000Z',
    taskCount: tasks.length,
    cast,
    waves: [
      {
        index: 1,
        startedAt: '2026-07-08T12:00:00.000Z',
        endedAt: '2026-07-08T13:00:00.000Z',
        taskIds: tasks.map((task) => task.id),
        idleGapBeforeMs: null,
      },
    ],
    statusCounts: { pending: 0, ready: 0, dispatched: 0, completed: 0, failed: 0, blocked: 0 },
    live: false,
    hasOpenGates: false,
    // As the server counts it: only deps whose other end is in the run, so a dep left dangling by a
    // reset is not an edge here either.
    edgeCount: tasks.reduce((total, task) => total + task.deps.filter((dep) => inRun.has(dep)).length, 0),
    ...over,
  };
}

function event(tasks: Task[], over: Partial<Run> = {}): StreamEvent {
  return {
    seq: 0,
    meta: META,
    // No tasks means no orchestrator to have created them — the empty database, honestly.
    snapshot: {
      runs: tasks.length === 0 ? [] : [runOf(tasks, over)],
      tasks,
      gates: [],
      turns: [],
      coordinatorRuns: [],
    },
    messages: [],
  };
}

/** The canvas lays out asynchronously (elkjs), so the nodes arrive on a later tick. */
async function draw(tasks: Task[], over: Partial<Run> = {}): Promise<HTMLElement[]> {
  render(<App event={event(tasks, over)} />);
  await waitFor(() => expect(screen.getAllByTestId('task-node').length).toBe(tasks.length));
  return screen.getAllByTestId('task-node');
}

function node(id: string): HTMLElement {
  const found = screen.getAllByTestId('task-node').find((element) => element.dataset.task === id);
  if (!found) throw new Error(`no node for ${id} on the canvas`);
  return found;
}

/** A theme's surface, as the class names `toHaveClass` takes — the page's colour is a class now. */
function classes(surface: string): string[] {
  return surface.split(' ');
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

    // The one thing that lets you find the failed task by scanning rather than searching. The
    // colour is a class and not a hex, because the page has a light theme and a dark one and
    // the palette lives in CSS (`index.css`) — what a node is *asserted* to wear is the theme's
    // own class string, which is the same thing the old hex assertion said.
    expect(node('task_failed')).toHaveClass(...classes(STATUS_THEME.failed.surface));
    expect(node('task_done')).toHaveClass(...classes(STATUS_THEME.completed.surface));
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
    expect(node('task_strange')).toHaveClass(...classes(UNKNOWN_STATUS_THEME.surface));
  });

  it('badges the node with the agent that worked it, and how close they are to the breaker', async () => {
    await draw([
      task({ id: 'task_worked', status: 'dispatched', dispatch: dispatch(), attemptCount: 1 }),
      task({
        id: 'task_failing',
        status: 'dispatched',
        dispatch: dispatch({ failureCount: 2 }),
        attemptCount: 1,
      }),
    ]);

    // **`A1`, not eight hex of a uuid.** The handle chip used to be the loudest object on the card,
    // for a value nobody can read, remember or act on — and it was the agent's *only* name, so "the
    // failed node and the open gate are the same agent" was a fact you had to work out by comparing
    // two strings. The monogram is one glance, it is the same `A1` in the rail and in the
    // conversation, and the handle itself is one hover away.
    const badge = within(node('task_worked')).getByTestId('assignee');
    expect(badge).toHaveTextContent('A1');
    expect(badge).toHaveAttribute('title', HANDLE);

    expect(within(node('task_worked')).queryByTestId('failure-count')).toBeNull();
    // The circuit breaker trips at 3: this task is visibly circling the drain.
    expect(within(node('task_failing')).getByTestId('failure-count')).toHaveTextContent('✗2');
  });

  it('leaves a task nobody was dispatched to unmonogrammed — an absent agent is a fact', async () => {
    await draw([task({ id: 'task_alone', status: 'pending', dispatch: null, attemptCount: 0 })]);

    // Three true things come out the same way, and all three are right: it was never dispatched, its
    // dispatch names no assignee, or the orchestrator worked it itself. In none of them was an
    // *agent* spawned for the work — so there is no monogram, and the stripe goes quiet.
    expect(within(node('task_alone')).queryByTestId('assignee')).toBeNull();
    expect(node('task_alone').dataset.agent).toBeUndefined();
    expect(within(node('task_alone')).getByTestId('agent-stripe')).toBeInTheDocument();
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

/**
 * **The agent takes the edge; the status keeps the hue** (SPEC §7.5).
 *
 * Two colour systems want a node — what state the work is in, and who did it — and they cannot both
 * win the same pixel. The six status hexes were signed off on screen and retuning them to make room
 * is re-approval, not refactoring, so the status keeps the *fill* and the agent takes the **stripe
 * and the monogram**: a channel nothing else was using.
 */
describe('the agent stripe, and the dimming it makes possible', () => {
  const ALICE = 'term_1a2b3c4d-1234-4321-8888-aabbccddeeff';
  const BOB = 'term_5e6f7a8b-1234-4321-8888-aabbccddeeff';

  const HERS = task({
    id: 'task_hers',
    status: 'completed',
    dispatch: dispatch({ assigneeHandle: ALICE, status: 'completed' }),
    attemptCount: 1,
  });
  const HIS = task({
    id: 'task_his',
    status: 'dispatched',
    dispatch: dispatch({ assigneeHandle: BOB }),
    attemptCount: 1,
  });

  it('gives two agents two monograms, and keeps the status fill on both', async () => {
    await draw([HERS, HIS]);

    expect(node('task_hers').dataset.agent).toBe('A1');
    expect(node('task_his').dataset.agent).toBe('A2');

    // …and the fill is still the *status*, which is what a person scanning a 76-node run is
    // actually looking for.
    expect(node('task_hers')).toHaveClass(...classes(STATUS_THEME.completed.surface));
    expect(node('task_his')).toHaveClass(...classes(STATUS_THEME.dispatched.surface));
  });

  it('dims every node that is not the selected agent’s — the tool’s central gesture', async () => {
    const user = userEvent.setup();
    await draw([HERS, HIS]);

    // Nothing is dimmed until an agent is asked for.
    expect(node('task_hers').dataset.dimmed).toBe('false');
    expect(node('task_his').dataset.dimmed).toBe('false');

    await user.click(screen.getByRole('button', { name: /Agent 1/ }));

    await waitFor(() => expect(node('task_his').dataset.dimmed).toBe('true'));
    // Faded, never hidden: the shape of the orchestration survives the filter, so you can see
    // *where* your agent's work sat inside it.
    expect(node('task_hers').dataset.dimmed).toBe('false');
    expect(screen.getAllByTestId('task-node')).toHaveLength(2);

    // Clicking the agent again lets go — the way out is where the way in was.
    await user.click(screen.getByRole('button', { name: /Agent 1/ }));
    await waitFor(() => expect(node('task_his').dataset.dimmed).toBe('false'));
  });
});

/**
 * **The waves** — the six-hour rule, finally visible (SPEC §4.3, §7.5).
 *
 * It used to decide a rail row's *identity*: one terminal reused across four days silently became
 * several unrelated rows, and nothing on screen ever said why. Same threshold, new job — the gap is
 * drawn, and one orchestrator stays one row.
 */
describe('the waves', () => {
  function waves(taskIds: string[][], gaps: (number | null)[]): Wave[] {
    return taskIds.map((ids, index) => ({
      index: index + 1,
      startedAt: '2026-07-08T12:00:00.000Z',
      endedAt: '2026-07-08T13:00:00.000Z',
      taskIds: ids,
      idleGapBeforeMs: gaps[index] ?? null,
    }));
  }

  it('draws a region per wave, captioned with the silence that opened it', async () => {
    await draw([task({ id: 'task_before' }), task({ id: 'task_after' })], {
      waves: waves([['task_before'], ['task_after']], [null, 14 * 60 * 60 * 1000]),
    });

    const regions = await screen.findAllByTestId('wave-region');

    expect(regions).toHaveLength(2);
    expect(regions.map((region) => region.dataset.wave)).toEqual(['1', '2']);

    // The number that used to cut this orchestrator in two, said out loud.
    expect(screen.getByTestId('wave-gap')).toHaveTextContent('after 14h idle');
  });

  it('draws no region at all when the work never paused', async () => {
    // A single box round the whole canvas says nothing. The only thing a wave border can mean is
    // *this is where one burst of work stopped and the next started* — so it appears exactly when
    // there is a gap to point at, and never as furniture.
    await draw([task({ id: 'task_one' }), task({ id: 'task_two' })], {
      waves: waves([['task_one', 'task_two']], [null]),
    });

    expect(screen.queryAllByTestId('wave-region')).toHaveLength(0);
  });
});
