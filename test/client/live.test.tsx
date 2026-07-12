import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATUS_THEME } from '../../src/client/canvas/theme.ts';
import { Live } from '../../src/client/Live.tsx';
import { pageRuns, type RunEvidence, snapshotRun } from '../../src/server/history.ts';
import type { Affected, Meta, Run, StreamEvent, Task } from '../../src/shared/types.ts';

/**
 * The client half of the transport — #17's stream, and #69's paged history on top of it.
 *
 * What is asserted here is the *transport at the seam where it meets the screen*, against the
 * real composition: `<Live>` is the `EventSource` feeding `<App>`, and `<App>`'s default
 * loaders are the real `fetch`es. The wire is faked at both ends — a fake `EventSource` the
 * test pushes down, a fake `fetch` serving a mutable canned world — because jsdom has neither,
 * and the server's half of both is asserted over real HTTP in `test/server/history.test.ts`.
 *
 * The contract under test is #69's (ADR 0002): the stream is the doorbell and the fetches are
 * the data. A push that names a run refetches it; one that names another run does not; a
 * reconnect-shaped push (`affected.all`) re-reads what is on screen — which is how growth
 * while disconnected reaches the reader — and older history arrives only when "Load older
 * history" asks for it. Throughout, the selection is the reader's: news arrives as a chip,
 * never as a jump (SPEC §7.3).
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

function run(over: Partial<Run> = {}): Run {
  return {
    id: 'run_9f8e7d6c',
    handle: 'term_9f8e7d6c-1234-4321-8888-aabbccddeeff',
    label: 'Ship the visualizer',
    startedAt: '2026-07-11T20:54:00.000Z',
    endedAt: '2026-07-11T21:30:00.000Z',
    taskCount: 1,
    cast: [],
    waves: [],
    statusCounts: { pending: 0, ready: 0, dispatched: 1, completed: 0, failed: 0, blocked: 0 },
    live: true,
    hasOpenGates: false,
    edgeCount: 0,
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task_build',
    runId: 'run_9f8e7d6c',
    parentId: null,
    title: 'Build it',
    status: 'dispatched',
    deps: [],
    createdAt: '2026-07-11T20:54:00.000Z',
    completedAt: null,
    hasSpec: true,
    hasResult: false,
    dispatch: null,
    attemptCount: 1,
    gate: null,
    ...over,
  };
}

/** The machine's retained history, as the fake `/api/runs` and `/api/run/:id` serve it. */
type World = { runs: Run[]; tasks: Task[] };

/**
 * The mutable world behind the fake `fetch`. A test *changes* it and then rings the doorbell —
 * exactly the order the real thing happens in: Orca commits, the poll loop notices, the push
 * says what moved, and only then does the client come asking.
 */
let world: World;

/** Every URL the client fetched, for asserting what a push did — and did not — cause. */
let fetched: string[];

function evidenceOf(current: World): RunEvidence {
  return {
    runs: current.runs,
    tasks: current.tasks,
    attemptsByTask: new Map(),
    gates: [],
    turns: [],
    coordinatorRuns: [],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The real endpoints, served from the canned world by the server's own pure functions. */
function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  fetched.push(url);

  if (url.startsWith('/api/runs')) {
    const cursor = new URL(url, 'http://localhost').searchParams.get('cursor');
    const page = pageRuns(world.runs, cursor);
    return Promise.resolve(
      json({ meta: META, runs: page.runs, nextCursor: page.nextCursor, coordinatorRuns: [] })
    );
  }

  if (url.startsWith('/api/run/')) {
    const id = decodeURIComponent(url.slice('/api/run/'.length));
    const snapshot = snapshotRun(evidenceOf(world), id);
    return Promise.resolve(
      snapshot === null ? json({ error: `No run ${id}.` }, 404) : json({ meta: META, ...snapshot })
    );
  }

  return Promise.reject(new Error(`unexpected fetch: ${url}`));
}

function event(over: { meta?: Partial<Meta>; affected?: Partial<Affected>; seq?: number } = {}): StreamEvent {
  return {
    seq: over.seq ?? 0,
    affected: { all: true, runIds: [], unplaced: false, ...over.affected },
    meta: { ...META, ...over.meta },
    snapshot: { runs: [], tasks: [], gates: [], turns: [], coordinatorRuns: [] },
    messages: [],
  };
}

/**
 * A stand-in for the browser's `EventSource` — it opens, it delivers, it closes, and it
 * records all three so the test can assert on them.
 */
class FakeEventSource {
  static opened: FakeEventSource[] = [];

  readonly url: string;
  closed = false;
  onmessage: ((message: MessageEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.opened.push(this);
  }

  close(): void {
    this.closed = true;
  }

  /** The server pushes. `act` because this lands outside React's own event loop. */
  push(streamEvent: StreamEvent): void {
    act(() => {
      this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(streamEvent) }));
    });
  }
}

/** The one stream `<Live>` opened. */
function stream(): FakeEventSource {
  expect(FakeEventSource.opened).toHaveLength(1);
  return FakeEventSource.opened[0]!;
}

/** Render, push the first event, and wait for the shell to stand — most tests start here. */
async function opened(): Promise<FakeEventSource> {
  render(<Live />);
  const source = stream();
  source.push(event());
  await waitFor(() => expect(screen.getAllByTestId('task-node').length).toBeGreaterThan(0));
  return source;
}

beforeEach(() => {
  world = { runs: [run()], tasks: [task()] };
  fetched = [];
  FakeEventSource.opened = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<Live>', () => {
  it('subscribes to /api/stream, and fetches nothing until the first push rings', () => {
    render(<Live />);

    expect(stream().url).toBe('/api/stream');
    // The stream is the doorbell and the fetches are the data (#69) — and before the bell
    // rings there is nothing to ask about. A page that fetched on mount would race its own
    // stream; one that still polled `/api/snapshot` would be the old tool.
    expect(fetched).toEqual([]);
  });

  it('says it is connecting until the first push arrives', () => {
    render(<Live />);

    expect(screen.getByText(/Connecting to the database/)).toBeVisible();
  });

  it('renders the rail, the canvas and the meta banner once the first push fetches history', async () => {
    render(<Live />);

    stream().push(event());

    expect(await screen.findByText('Ship the visualizer')).toBeVisible();
    expect(screen.getByText(/connected to a running Orca \(pid 4242\)/i)).toBeVisible();
    await waitFor(() => expect(screen.getAllByTestId('task-node')).toHaveLength(1));
    expect(screen.getByText('Build it')).toBeVisible();

    // One page of the index, one selected run — never the machine's whole history.
    expect(fetched).toEqual(['/api/runs', `/api/run/${encodeURIComponent('run_9f8e7d6c')}`]);
  });

  it('refetches the selected run when a push names it — a status flip carries no message, and still lands', async () => {
    const source = await opened();

    // Orca commits: the graph moved, no message was written, `seq` did not move. All the
    // client gets is the push naming the run — and that has to be enough.
    world = { runs: [run()], tasks: [task({ status: 'completed' })] };
    source.push(event({ affected: { all: false, runIds: ['run_9f8e7d6c'] } }));

    await waitFor(() =>
      expect(screen.getByTestId('task-node')).toHaveClass(...STATUS_THEME.completed.surface.split(' '))
    );
  });

  it('does not refetch the selected run over a push that names only another run', async () => {
    const source = await opened();
    const before = fetched.filter((url) => url.startsWith('/api/run/')).length;

    source.push(event({ affected: { all: false, runIds: ['run_somebody_else'] } }));

    // The index window refreshes (the named run may have moved into it) — one bounded page…
    await waitFor(() => expect(fetched.filter((url) => url === '/api/runs').length).toBeGreaterThan(1));
    // …but the run on screen was not named, so it is not re-read. That is what "targeted" means.
    expect(fetched.filter((url) => url.startsWith('/api/run/'))).toHaveLength(before);
  });

  it('recovers growth that happened while disconnected, and never yanks the canvas', async () => {
    const source = await opened();

    // While the laptop lid was shut: a brand-new orchestration appeared. The reconnect push
    // claims the whole view (`all`), because overwritten-in-place rows leave no cursor.
    world = {
      runs: [run({ id: 'run_fresh', handle: 'term_fresh', label: 'The new one', endedAt: '2026-07-12T09:00:00.000Z' }), run()],
      tasks: [task(), task({ id: 'task_new', runId: 'run_fresh', title: 'New work' })],
    };
    source.push(event({ affected: { all: true } }));

    // The rail learns about it, as news — a chip, never a navigation (SPEC §7.3).
    expect(await screen.findByText('The new one')).toBeVisible();
    expect(await screen.findByText('new orchestration started')).toBeVisible();
    // The reader is still exactly where they were.
    expect(screen.getByTestId('task-node')).toHaveTextContent('Build it');
  });

  it('loads older history only when asked, and keeps the selection while doing it', async () => {
    // Fifty-five runs: a full first page, and five behind the explicit button.
    const older = Array.from({ length: 55 }, (_, index) =>
      run({
        id: `run_old_${String(index).padStart(2, '0')}`,
        handle: `term_old_${index}`,
        label: `Older work ${index}`,
        startedAt: '2026-07-01T00:00:00.000Z',
        // Distinct instants, newest first, all older than the run under the reader.
        endedAt: new Date(Date.parse('2026-07-10T00:00:00Z') - index * 60_000).toISOString(),
      })
    );
    world = { runs: [run(), ...older], tasks: [task()] };

    render(<Live />);
    stream().push(event());
    await screen.findByText('Ship the visualizer');

    expect(screen.getAllByTestId('run-row')).toHaveLength(50);
    expect(screen.queryByText('Older work 54')).toBeNull();

    await userEvent.click(screen.getByTestId('load-older'));

    // The tail arrived, the button retired (history ends here), and the selection never moved.
    expect(await screen.findByText('Older work 54')).toBeVisible();
    expect(screen.getAllByTestId('run-row')).toHaveLength(56);
    expect(screen.queryByTestId('load-older')).toBeNull();
    expect(screen.getByTestId('task-node')).toHaveTextContent('Build it');
  });

  it('flips the badge to stale when Orca is closed, and keeps rendering everything else', async () => {
    const source = await opened();
    expect(screen.getByText(/connected to a running Orca/i)).toBeVisible();

    // The user quits Orca mid-session. The database will never change again — this push
    // exists *only* because liveness is re-read every tick (#17), and every live run's
    // summary changed with it, which is why the digests name them (`server/digests.ts`).
    world = { runs: [run({ live: false })], tasks: [task()] };
    source.push(event({ meta: { liveness: 'stale', orcaPid: null }, affected: { all: false, runIds: ['run_9f8e7d6c'] } }));

    expect(await screen.findByText(/Orca isn't running; showing last-known state from/i)).toBeVisible();
    expect(screen.queryByText(/connected to a running Orca/i)).toBeNull();
    // …while everything else keeps working. A stale badge is not a broken page.
    expect(screen.getByText('Ship the visualizer')).toBeVisible();
    await waitFor(() => expect(screen.getAllByTestId('task-node')).toHaveLength(1));
  });

  it('closes the stream when the page goes away', () => {
    const { unmount } = render(<Live />);
    const source = stream();

    unmount();

    // An `EventSource` left open reconnects for ever, and the server would go on polling
    // SQLite for a browser that is gone.
    expect(source.closed).toBe(true);
  });
});
