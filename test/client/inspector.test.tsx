import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CannedApp, type CannedEvent } from './canned.tsx';
import type { TaskLoader } from '../../src/client/inspector/detail.ts';
import type {
  CastMember,
  Dispatch,
  Gate,
  Meta,
  Run,
  Task,
  TaskDetail,
  Turn,
} from '../../src/shared/types.ts';

/**
 * Seam 2 (#12): `<CannedApp>` fed a canned world (`CannedEvent`, canned.tsx) — and, for this ticket, a canned loader.
 *
 * Clicking a task is where the graph stops being a picture and starts being an account of what
 * happened: the spec the agent was handed, the result that came back, **every** dispatch attempt
 * rather than the one the node had room for, the messages that named it, the question it raised
 * and how that was answered, and the neighbours you can walk to.
 *
 * The loader is injected rather than mocked at the `fetch` boundary, because the laziness is the
 * point: what the tests must be able to see is *when* the bodies are asked for and *how often* —
 * and a stub that records its calls says that plainly (`<CannedApp loadTask={…}>`).
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
const FIRST_WORKER = 'term_1a2b3c4d-1234-4321-8888-aabbccddeeff';
const SECOND_WORKER = 'term_5e6f7a8b-1234-4321-8888-aabbccddeeff';
const RUN_ID = 'run_9f8e7d6c_1000';
const TASK_ID = 'task_aaaaaaaa';

function task(over: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    runId: RUN_ID,
    parentId: null,
    title: 'Ship the inspector',
    status: 'failed',
    deps: [],
    createdAt: '2026-07-08T12:00:00.000Z',
    completedAt: null,
    hasSpec: true,
    hasResult: false,
    dispatch: null,
    attemptCount: 3,
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
    endedAt: '2026-07-08T13:00:00.000Z',
    taskCount: 1,
    cast: [],
    waves: [],
    statusCounts: { pending: 0, ready: 0, dispatched: 0, completed: 0, failed: 1, blocked: 0 },
    live: false,
    hasOpenGates: false,
    edgeCount: 0,
    ...over,
  };
}

function event(over: Partial<CannedEvent> = {}): CannedEvent {
  return {
    seq: 0,
    affected: { all: true, runIds: [], unplaced: false },
    meta: META,
    snapshot: { runs: [run()], tasks: [task()], gates: [], turns: [], coordinatorRuns: [] },
    messages: [],
    ...over,
  };
}

/** A turn of this task's exchange — the task-scoped slice of `snapshot.turns` (SPEC §4.7). */
function turn(over: Partial<Turn> = {}): Turn {
  return {
    id: 'turn_1',
    runId: RUN_ID,
    direction: 'in',
    kind: 'status',
    fromHandle: FIRST_WORKER,
    toHandle: HANDLE,
    at: '2026-07-11T21:00:00.000Z',
    taskId: TASK_ID,
    subject: 'A turn',
    body: 'Something was said.',
    source: 'messages · #1',
    ...over,
  };
}

function attempt(over: Partial<Dispatch> = {}): Dispatch {
  return {
    id: 'ctx_first',
    assigneeHandle: FIRST_WORKER,
    status: 'failed',
    failureCount: 1,
    lastFailure: '2026-07-08T12:10:00.000Z',
    dispatchedAt: '2026-07-08T12:01:00.000Z',
    completedAt: null,
    lastHeartbeatAt: null,
    ...over,
  };
}

function detail(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: TASK_ID,
    spec: 'Build the node inspector, and the route it exists for.',
    result: null,
    attempts: [],
    ...over,
  };
}

/** A loader that records what it was asked for — the laziness is what these tests read. */
function loaderFor(...details: TaskDetail[]): TaskLoader & ReturnType<typeof vi.fn> {
  const byId = new Map(details.map((one) => [one.id, one]));
  return vi.fn(async (id: string) => byId.get(id) ?? detail({ id })) as TaskLoader & ReturnType<typeof vi.fn>;
}

/** The right dock, whichever panel is in it. */
function inspector(): HTMLElement | null {
  return screen.queryByTestId('inspector');
}

function conversation(): HTMLElement | null {
  return screen.queryByTestId('conversation');
}

function node(id: string): HTMLElement {
  const found = screen.getAllByTestId('task-node').find((element) => element.dataset.task === id);
  if (!found) throw new Error(`no node for ${id} on the canvas`);
  return found;
}

/** See `feed.test.tsx`: a node is clicked with `fireEvent`, because jsdom is not a browser. */
function clickNode(id: string): void {
  fireEvent.click(node(id));
}

/** The canvas lays out asynchronously (elkjs), so the nodes arrive on a later tick. */
async function drawn(count: number): Promise<void> {
  await waitFor(() => expect(screen.getAllByTestId('task-node').length).toBe(count));
}

/** Select a node and wait for the panel that swapped in to have its bodies. */
async function open(id: string = TASK_ID): Promise<HTMLElement> {
  clickNode(id);
  await waitFor(() => expect(inspector()).not.toBeNull());
  return inspector()!;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * **One panel that swaps** (SPEC §7.1) — not both stacked. At this node count the canvas
 * deserves the width, and a dock holding a feed *and* an inspector would take it back.
 */
describe('the right dock', () => {
  it('swaps the conversation for the inspector when a node is selected', async () => {
    render(<CannedApp event={event({ })} loadTask={loaderFor(detail())} />);
    await drawn(1);

    expect(conversation()).not.toBeNull();
    expect(inspector()).toBeNull();

    await open();

    expect(inspector()).not.toBeNull();
    expect(conversation()).toBeNull();
  });

  it('goes back to the conversation when the selection is let go', async () => {
    render(<CannedApp event={event({ })} loadTask={loaderFor(detail())} />);
    await drawn(1);

    await open();
    // The way out is the way in: clicking the same node again.
    clickNode(TASK_ID);

    await waitFor(() => expect(conversation()).not.toBeNull());
    expect(inspector()).toBeNull();
  });

  it('closes from the inspector itself, and the canvas lets the node go with it', async () => {
    const user = userEvent.setup();
    render(<CannedApp event={event()} loadTask={loaderFor(detail())} />);
    await drawn(1);

    const panel = await open();
    await user.click(within(panel).getByRole('button', { name: /close/i }));

    await waitFor(() => expect(conversation()).not.toBeNull());
    expect(node(TASK_ID)).toHaveAttribute('data-selected', 'false');
  });
});

/**
 * The header (SPEC §7.8, item 1). The id is **copyable** because the next thing you do with a
 * task you are looking at is paste it into an `orca orchestration` command.
 */
describe('the header', () => {
  it('names the task, its status, and its id in full', async () => {
    render(<CannedApp event={event()} loadTask={loaderFor(detail())} />);
    await drawn(1);

    const panel = await open();

    expect(within(panel).getByRole('heading', { name: 'Ship the inspector' })).toBeVisible();
    expect(within(panel).getByTestId('status-chip')).toHaveTextContent('failed');
    // Not the short id the node shows: what goes into a command line is the whole thing.
    expect(within(panel).getByText(TASK_ID)).toBeVisible();
  });

  it('copies the id to the clipboard', async () => {
    // `userEvent.setup()` installs the clipboard the browser would have — so what is asserted
    // here is the id landing in it, and not a spy standing where the clipboard should be.
    const user = userEvent.setup();
    render(<CannedApp event={event()} loadTask={loaderFor(detail())} />);
    await drawn(1);

    const panel = await open();
    await user.click(within(panel).getByRole('button', { name: /copy the task id/i }));

    // The whole thing, ready to paste into `orca orchestration` — never the short id the node
    // shows, which no command line will take.
    expect(await navigator.clipboard.readText()).toBe(TASK_ID);
    expect(await within(panel).findByText(/copied/i)).toBeVisible();
  });
});

/**
 * **The identifiers this panel is standing on** (`src/client/copy.tsx`).
 *
 * The tool is read-only, so everything a person *does* with a post-mortem happens in
 * `orca orchestration` — and every one of those commands takes an id. The task's is the header's
 * (above); the other two the inspector knows are the handle of the agent that held each attempt and
 * the id of the question the task raised, and both were shown as text nobody could retype.
 */
describe('the identifiers', () => {
  const GATE: Gate = {
    id: 'msg_gate',
    messageId: 'msg_gate',
    runId: RUN_ID,
    taskId: TASK_ID,
    question: 'Which driver — node:sqlite or better-sqlite3?',
    options: [],
    status: 'open',
    resolution: null,
    createdAt: '2026-07-08T12:20:00.000Z',
  };

  it('copies the whole handle of the agent that held an attempt — the badge shows eight hex of it', async () => {
    const user = userEvent.setup();
    render(<CannedApp event={event()} loadTask={loaderFor(detail({ attempts: [attempt()] }))} />);
    await drawn(1);

    const panel = await open();
    await within(panel).findByTestId('attempt');

    await user.click(within(panel).getByRole('button', { name: `Copy the agent handle ${FIRST_WORKER}` }));

    // The uuid in full. `1a2b3c4d` — what the badge has room for — is not an identity anything
    // outside this screen would accept.
    expect(await navigator.clipboard.readText()).toBe(FIRST_WORKER);
  });

  it('copies the id of a gate the task raised', async () => {
    const user = userEvent.setup();
    render(
      <CannedApp
        event={event({
          snapshot: { runs: [run()], tasks: [task({ gate: GATE })], gates: [GATE], turns: [], coordinatorRuns: [] },
        })}
        loadTask={loaderFor(detail())}
      />
    );
    await drawn(1);

    const panel = await open();

    await user.click(within(panel).getByRole('button', { name: `Copy the gate id ${GATE.id}` }));

    expect(await navigator.clipboard.readText()).toBe(GATE.id);
  });
});

/**
 * The bodies (SPEC §6.3, §7.8 item 2). They are **not in the snapshot** — a live 71-task dump
 * was 172 KB of it — so the inspector is the only thing that ever asks for them, and it asks on
 * the click.
 */
describe('the spec and the result', () => {
  it('are not fetched until a node is clicked', async () => {
    const load = loaderFor(detail());
    render(<CannedApp event={event()} loadTask={load} />);
    await drawn(1);

    expect(load).not.toHaveBeenCalled();

    await open();

    expect(load).toHaveBeenCalledWith(TASK_ID);
  });

  it('are shown once they land', async () => {
    const load = loaderFor(
      detail({ spec: 'Build the node inspector.', result: 'Done: it swaps with the feed.' })
    );
    render(<CannedApp event={event()} loadTask={load} />);
    await drawn(1);

    const panel = await open();

    expect(await within(panel).findByText('Build the node inspector.')).toBeVisible();
    expect(within(panel).getByText('Done: it swaps with the feed.')).toBeVisible();
  });

  it('say so honestly when the task has none — a blank panel looks like a bug', async () => {
    const load = loaderFor(detail({ spec: null, result: null }));
    render(<CannedApp event={event()} loadTask={load} />);
    await drawn(1);

    const panel = await open();

    expect(await within(panel).findByText(/no result yet/i)).toBeVisible();
  });

  it('are re-read when the database changes, so an open inspector is not a stale one', async () => {
    const load = loaderFor(detail({ result: null }));
    const { rerender } = render(<CannedApp event={event()} loadTask={load} />);
    await drawn(1);

    await open();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    // A push arrives (the poll loop only pushes when the file really changed — #17). The task
    // being read may have just completed, and an inspector that never asked again would go on
    // showing "no result yet" over a result that is sitting in the database.
    rerender(<CannedApp event={event({ seq: 1 })} loadTask={load} />);

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('leave the rest of the panel standing when the fetch fails', async () => {
    const load = vi.fn(async () => {
      throw new Error('the database was deleted');
    }) as unknown as TaskLoader;
    render(<CannedApp event={event()} loadTask={load} />);
    await drawn(1);

    const panel = await open();

    expect(await within(panel).findByText(/the database was deleted/)).toBeVisible();
    // The header comes from the snapshot, which is still perfectly good.
    expect(within(panel).getByRole('heading', { name: 'Ship the inspector' })).toBeVisible();
  });
});

/**
 * **Every** dispatch attempt (SPEC §7.8, item 3) — the ticket's whole reason for existing.
 * `dispatch_contexts` is the only genuinely append-only per-task history in the schema, and a
 * silent re-dispatch must not read as a first attempt.
 */
describe('the dispatch attempts', () => {
  const THREE = [
    attempt({ id: 'ctx_first', assigneeHandle: FIRST_WORKER, status: 'failed', failureCount: 1 }),
    attempt({ id: 'ctx_second', assigneeHandle: SECOND_WORKER, status: 'failed', failureCount: 2 }),
    attempt({ id: 'ctx_third', assigneeHandle: SECOND_WORKER, status: 'circuit_broken', failureCount: 3 }),
  ];

  it('are all there, in the order they were made — not just the latest', async () => {
    render(<CannedApp event={event()} loadTask={loaderFor(detail({ attempts: THREE }))} />);
    await drawn(1);

    const panel = await open();
    const attempts = await within(panel).findAllByTestId('attempt');

    expect(attempts).toHaveLength(3);
    expect(attempts[0]).toHaveTextContent(/Attempt 1 of 3/);
    expect(attempts[0]).toHaveTextContent('failed');
    expect(attempts[2]).toHaveTextContent(/Attempt 3 of 3/);
    expect(attempts[2]).toHaveTextContent('circuit_broken');
  });

  it('name the terminal that held each one — a retry goes to a new worktree, and a new agent', async () => {
    render(<CannedApp event={event()} loadTask={loaderFor(detail({ attempts: THREE }))} />);
    await drawn(1);

    const panel = await open();
    const attempts = await within(panel).findAllByTestId('attempt');

    expect(within(attempts[0]!).getByTestId('assignee')).toHaveTextContent('1a2b3c4d');
    expect(within(attempts[2]!).getByTestId('assignee')).toHaveTextContent('5e6f7a8b');
    // How close this task came to the circuit breaker, which trips at 3.
    expect(within(attempts[2]!).getByTestId('failure-count')).toHaveTextContent('✗3');
  });

  it('say plainly when a task was never dispatched at all', async () => {
    render(
      <CannedApp
        event={event({
          snapshot: {
            runs: [run()],
            tasks: [task({ status: 'pending', attemptCount: 0 })],
            gates: [],
            turns: [],
            coordinatorRuns: [],
          },
        })}
        loadTask={loaderFor(detail({ attempts: [] }))}
      />
    );
    await drawn(1);

    const panel = await open();

    expect(await within(panel).findByText(/never dispatched/i)).toBeVisible();
  });
});

/**
 * **The exchange** (SPEC §7.8, item 4) — this task's slice of the conversation, both sides of it.
 *
 * It replaces the flat list of messages this panel used to fetch, and the upgrade is the whole
 * feature: a list of messages is *the half of the exchange that got written down*. The prompt the
 * agent was dispatched with is `tasks.spec`, and Orca injects it straight into the worker's PTY
 * (SPEC §4.2, trap 2) — so it could never have been in that list, and the panel showed an agent
 * reporting back to nobody.
 */
describe('the exchange', () => {
  const AGENT: CastMember = {
    handle: FIRST_WORKER,
    monogram: 'A1',
    taskIds: [TASK_ID],
    taskCount: 1,
    lastHeartbeatAt: null,
  };

  const EXCHANGE: Turn[] = [
    turn({
      id: 'dispatch:ctx_1',
      kind: 'dispatch',
      direction: 'out',
      fromHandle: HANDLE,
      toHandle: FIRST_WORKER,
      body: 'Ship the visualizer.',
      source: 'tasks.spec · dispatch_contexts.dispatched_at',
      at: '2026-07-11T20:54:00.000Z',
    }),
    turn({
      id: 'beats:' + TASK_ID,
      kind: 'heartbeats',
      direction: 'in',
      fromHandle: FIRST_WORKER,
      toHandle: HANDLE,
      beatCount: 12,
      at: '2026-07-11T21:00:00.000Z',
      endedAt: '2026-07-11T21:55:00.000Z',
    }),
    turn({
      id: 'msg:3',
      kind: 'worker_done',
      direction: 'in',
      fromHandle: FIRST_WORKER,
      toHandle: HANDLE,
      body: 'Failed: circuit breaker tripped',
      source: 'messages · #3',
      at: '2026-07-11T22:00:00.000Z',
    }),
  ];

  function withExchange(): CannedEvent {
    return event({
      snapshot: {
        runs: [run({ cast: [AGENT] })],
        tasks: [task()],
        gates: [],
        turns: EXCHANGE,
        coordinatorRuns: [],
      },
    });
  }

  it('shows both sides — including the prompt, which no message anywhere records', async () => {
    render(<CannedApp event={withExchange()} loadTask={loaderFor(detail())} />);
    await drawn(1);

    const panel = await open();
    const turns = await within(panel).findAllByTestId('turn');

    // The story reads forwards: a task's exchange is a story, and a story starts at the beginning.
    expect(turns.map((row) => row.dataset.kind)).toEqual(['dispatch', 'worker_done']);
    expect(turns.map((row) => row.dataset.direction)).toEqual(['out', 'in']);

    // The orchestrator's half — reconstructed from two columns, and it says so on screen.
    expect(within(panel).getByText('Ship the visualizer.')).toBeVisible();
    expect(within(panel).getByText('tasks.spec · dispatch_contexts.dispatched_at')).toBeVisible();
  });

  it('collapses the heartbeats into one line, and says how many it stood in for', async () => {
    render(<CannedApp event={withExchange()} loadTask={loaderFor(detail())} />);
    await drawn(1);

    const panel = await open();
    await within(panel).findAllByTestId('turn');

    // 65% of all traffic says "alive" (SPEC §7.7). One row keeps the fact and loses the repetition —
    // and there is nothing behind a toggle any more, because the rows it would reveal all say the
    // same word.
    const beats = within(panel).getByTestId('heartbeats');
    expect(beats).toHaveTextContent(/12 heartbeats/);
    expect(beats).toHaveTextContent(/every ~5 min/);
  });

  it('says so when a task was never dispatched — nobody was ever given it, so nobody spoke', async () => {
    render(<CannedApp event={event()} loadTask={loaderFor(detail())} />);
    await drawn(1);

    const panel = await open();

    expect(await within(panel).findByTestId('exchange-empty')).toBeVisible();
  });
});

/**
 * The gate Q&A (SPEC §7.8, item 5) — **including gates that were already answered**, which is the
 * whole point: it is how you reconstruct what was decided, and why the run went the way it did.
 * The node's ⛔ marker only ever shows an *open* gate; this is where the answered one lives.
 */
describe('the gate Q&A', () => {
  function gate(over: Partial<Gate> = {}): Gate {
    return {
      id: 'msg_gate',
      messageId: 'msg_gate',
      runId: RUN_ID,
      taskId: TASK_ID,
      question: 'Which driver — node:sqlite or better-sqlite3?',
      options: ['node:sqlite', 'better-sqlite3'],
      status: 'resolved',
      resolution: 'node:sqlite — zero native dependencies.',
      createdAt: '2026-07-08T12:20:00.000Z',
      ...over,
    };
  }

  function withGates(gates: Gate[]): CannedEvent {
    return event({
      snapshot: { runs: [run()], tasks: [task({ gate: gates[0] ?? null })], gates, turns: [], coordinatorRuns: [] },
    });
  }

  it('shows an answered question, and the answer', async () => {
    render(<CannedApp event={withGates([gate()])} loadTask={loaderFor(detail())} />);
    await drawn(1);

    const panel = await open();
    const asked = within(panel).getByTestId('gate-qa');

    expect(within(asked).getByText(/Which driver/)).toBeVisible();
    expect(within(asked).getByText(/node:sqlite — zero native dependencies\./)).toBeVisible();
  });

  it('shows an open one as still waiting, rather than as answered with nothing', async () => {
    render(
      <CannedApp
        event={withGates([gate({ status: 'open', resolution: null })])}
        loadTask={loaderFor(detail())}
      />
    );
    await drawn(1);

    const panel = await open();

    expect(within(panel).getByTestId('gate-qa')).toHaveTextContent(/waiting/i);
  });

  it('shows every gate this task raised, not only the one the node marks', async () => {
    render(
      <CannedApp
        event={withGates([
          gate({ id: 'msg_one', question: 'Asked first, and answered' }),
          gate({ id: 'msg_two', question: 'Asked second, still open', status: 'open', resolution: null }),
        ])}
        loadTask={loaderFor(detail())}
      />
    );
    await drawn(1);

    const panel = await open();

    expect(within(panel).getAllByTestId('gate-qa')).toHaveLength(2);
  });

  it('says nothing at all when the task never raised one', async () => {
    render(<CannedApp event={event()} loadTask={loaderFor(detail())} />);
    await drawn(1);

    const panel = await open();

    expect(within(panel).queryByTestId('gate-qa')).toBeNull();
  });
});

/** Dependencies, in and out, as chips you can walk (SPEC §7.8, item 6). */
describe('the dependencies', () => {
  const BEFORE = task({ id: 'task_before', title: 'The one before', status: 'completed', deps: [] });
  const HERE = task({ id: TASK_ID, deps: ['task_before'] });
  const AFTER = task({ id: 'task_after', title: 'The one after', status: 'pending', deps: [TASK_ID] });

  function chain(): CannedEvent {
    return event({
      snapshot: {
        runs: [run({ edgeCount: 2, taskCount: 3 })],
        tasks: [BEFORE, HERE, AFTER],
        gates: [],
        turns: [],
        coordinatorRuns: [],
      },
    });
  }

  it('shows what this task waited for, and what waited on it', async () => {
    render(<CannedApp event={chain()} loadTask={loaderFor(detail())} />);
    await drawn(3);

    const panel = await open();

    expect(within(within(panel).getByTestId('deps-in')).getByRole('button', { name: /The one before/ })).toBeVisible();
    expect(within(within(panel).getByTestId('deps-out')).getByRole('button', { name: /The one after/ })).toBeVisible();
  });

  it('walks to the neighbour when its chip is clicked — the inspector follows the selection', async () => {
    const user = userEvent.setup();
    render(<CannedApp event={chain()} loadTask={loaderFor(detail(), detail({ id: 'task_after' }))} />);
    await drawn(3);

    const panel = await open();
    await user.click(within(panel).getByRole('button', { name: /The one after/ }));

    await waitFor(() => expect(node('task_after')).toHaveAttribute('data-selected', 'true'));
    expect(within(inspector()!).getByRole('heading', { name: 'The one after' })).toBeVisible();
    expect(node(TASK_ID)).toHaveAttribute('data-selected', 'false');
  });

  it('follows a dependency into another run rather than calling it deleted', async () => {
    // Runs are *inferred* — buckets of `created_by_terminal_handle`, split on a six-hour idle
    // gap, with the null-handle tasks in a synthetic run of their own (`runs.ts`). A `deps` edge
    // is a real edge in the schema and knows nothing about any of that, so it can cross from one
    // inferred run into the next. The task is right there in the database; a chip that resolved
    // only against the canvas would announce it as deleted.
    const user = userEvent.setup();
    const ELSEWHERE = task({
      id: 'task_elsewhere',
      title: 'Over in another run',
      runId: 'run_1a2b3c4d_2000',
      deps: [],
    });

    render(
      <CannedApp
        event={event({
          snapshot: {
            runs: [
              run(),
              run({ id: 'run_1a2b3c4d_2000', label: 'The other run', startedAt: '2026-07-07T12:00:00.000Z' }),
            ],
            tasks: [task({ deps: ['task_elsewhere'] }), ELSEWHERE],
            gates: [],
            turns: [],
            coordinatorRuns: [],
          },
        })}
        loadTask={loaderFor(detail(), detail({ id: 'task_elsewhere' }))}
      />
    );
    await drawn(1);

    const panel = await open();
    await user.click(within(panel).getByRole('button', { name: /Over in another run/ }));

    // The canvas went to it, and so did the rail — naming a task is asking to go to it.
    await waitFor(() => expect(node('task_elsewhere')).toHaveAttribute('data-selected', 'true'));
    expect(within(inspector()!).getByRole('heading', { name: 'Over in another run' })).toBeVisible();
    expect(screen.getAllByTestId('run-row').find((row) => row.dataset.run === 'run_1a2b3c4d_2000')).toHaveAttribute(
      'aria-current',
      'true'
    );
  });

  it('shows a dependency the database no longer has as a dead end, not as a link', async () => {
    // No foreign keys in this schema (SPEC §4.2, trap 8): `deps` can name a task an
    // `orchestration reset` deleted. The canvas drops that edge; the chip has to admit it.
    render(
      <CannedApp
        event={event({
          snapshot: {
            runs: [run()],
            tasks: [task({ deps: ['task_wiped_by_a_reset'] })],
            gates: [],
            turns: [],
            coordinatorRuns: [],
          },
        })}
        loadTask={loaderFor(detail())}
      />
    );
    await drawn(1);

    const panel = await open();
    const depsIn = within(panel).getByTestId('deps-in');

    expect(within(depsIn).getByText(/task_wiped_by_a_reset/)).toBeVisible();
    expect(within(depsIn).queryByRole('button')).toBeNull();
  });

  it('says so when a task has no dependencies at all — 4 of 13 real runs have none', async () => {
    render(<CannedApp event={event()} loadTask={loaderFor(detail())} />);
    await drawn(1);

    const panel = await open();

    expect(within(panel).getByTestId('deps-in')).toHaveTextContent(/nothing/i);
    expect(within(panel).getByTestId('deps-out')).toHaveTextContent(/nothing/i);
  });
});
