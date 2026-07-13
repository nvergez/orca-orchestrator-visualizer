import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATUS_THEME } from '../../src/client/canvas/theme.ts';
import { Live } from '../../src/client/Live.tsx';
import type { Meta, Run, StreamEvent, Task } from '../../src/shared/types.ts';

/**
 * The client half of #17: the page keeps up with the agents on its own.
 *
 * What is asserted here is the *transport*, at the seam where it meets the screen — because
 * the two halves of this ticket fail in different ways. The server half can push a perfect
 * `StreamEvent` at a page that renders the first one and then sits there. So this suite
 * renders the real composition (`<Live>` = the `EventSource` feeding `<App>`), pushes events
 * down a fake `EventSource`, and reads the DOM a user would be looking at.
 *
 * The fake is the honest seam: jsdom has no `EventSource`, and a real one would mean a real
 * server, which is seam 1's job (`test/server/stream.test.ts` drives the wire end to end).
 * What is left to prove here is the half that is *ours* — that a push re-renders, that the
 * one-shot fetch is gone, and that the stream is not left open behind us.
 *
 * `Last-Event-ID` is deliberately **not** tested here: the browser replays it, no code of
 * ours does. Faking it would test the fake. The server side of that resume — the half we do
 * own — is asserted over real HTTP in `test/server/stream.test.ts`.
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

const RUN: Run = {
  id: 'run_9f8e7d6c_1000',
  handle: 'term_9f8e7d6c-1234-4321-8888-aabbccddeeff',
  label: 'Ship the visualizer',
  startedAt: '2026-07-11T20:54:00.000Z',
  lastActivityAt: '2026-07-11T21:30:00.000Z',
  converged: false,
  endedAt: '2026-07-11T21:30:00.000Z',
  taskCount: 1,
  cast: [],
  waves: [],
  statusCounts: { pending: 0, ready: 0, dispatched: 1, completed: 0, failed: 0, blocked: 0 },
  live: true,
  hasBlockingGates: false,
  edgeCount: 0,
};

const TASK: Task = {
  id: 'task_build',
  runId: RUN.id,
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
};

function event(over: { meta?: Partial<Meta>; runs?: Run[]; tasks?: Task[]; seq?: number } = {}): StreamEvent {
  return {
    seq: over.seq ?? 0,
    meta: { ...META, ...over.meta },
    snapshot: { runs: over.runs ?? [RUN], tasks: over.tasks ?? [TASK], gates: [], turns: [], coordinatorRuns: [] },
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

beforeEach(() => {
  FakeEventSource.opened = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  // Stubbed to prove a negative: nothing in the client fetches a snapshot any more.
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<Live>', () => {
  it('subscribes to /api/stream, and never fetches a snapshot', () => {
    render(<Live />);

    // The swap this ticket is named for: one long-lived subscription in place of the
    // one-shot fetch #14 shipped. A page that still polled `/api/snapshot` could pass every
    // other assertion in this file and still be the old tool.
    expect(stream().url).toBe('/api/stream');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says it is connecting until the first push arrives', () => {
    render(<Live />);

    expect(screen.getByText(/Connecting to the database/)).toBeVisible();
  });

  it('renders the run rail, the canvas and the meta banner from the first push', async () => {
    render(<Live />);

    stream().push(event());

    expect(screen.getByText(/connected to a running Orca \(pid 4242\)/i)).toBeVisible();
    expect(screen.getByText('Ship the visualizer')).toBeVisible();
    await waitFor(() => expect(screen.getAllByTestId('task-node')).toHaveLength(1));
    expect(screen.getByText('Build it')).toBeVisible();
  });

  it('updates the canvas on a later push — a status flip carries no message, and still lands', async () => {
    render(<Live />);
    const source = stream();

    source.push(event());
    await waitFor(() => expect(screen.getAllByTestId('task-node')).toHaveLength(1));

    // The `ready → dispatched` case, from the screen's end: the graph moved and the cursor
    // did not (`seq` is unchanged), so a client that re-rendered only on new messages would
    // show this task as `dispatched` for ever. The colour is how a user actually reads a
    // status off the canvas, so it is what the test reads too.
    source.push(event({ tasks: [{ ...TASK, status: 'completed' }] }));

    await waitFor(() =>
      expect(screen.getByTestId('task-node')).toHaveClass(...STATUS_THEME.completed.surface.split(' '))
    );
  });

  it('flips the badge to stale when Orca is closed, and keeps rendering everything else', async () => {
    render(<Live />);
    const source = stream();

    source.push(event());
    expect(screen.getByText(/connected to a running Orca/i)).toBeVisible();

    // The user quits Orca mid-session. The database will never change again — this push
    // exists *only* because liveness is re-read every tick (#17), and it is the difference
    // between reading history and being fooled by it.
    source.push(event({ meta: { liveness: 'stale', orcaPid: null }, runs: [{ ...RUN, live: false }] }));

    expect(screen.getByText(/Orca isn't running; showing last-known state from/i)).toBeVisible();
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
