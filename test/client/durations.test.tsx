import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDurationMs } from '../../src/client/duration.tsx';
import type { TaskLoader } from '../../src/client/inspector/detail.ts';
import type { Dispatch, DurationObservation, Meta, Run, Task, TaskDetail } from '../../src/shared/types.ts';
import { CannedApp, type CannedEvent } from './canned.tsx';

/**
 * Honest durations, on screen (#66). The server sends a `DurationObservation` — a clock, two
 * endpoints, and never an invented number — and the client's whole job is to keep that honesty
 * while making it readable:
 *
 * - the **wording carries the provenance**: a dispatch duration is a bare number, the task-span
 *   fallback says "task span" out loud, and an open interval says "so far";
 * - an **open interval ages against the reader's own wall clock** — advancing without waiting
 *   for an SSE push, and stopping the moment a push carries the completion evidence;
 * - an absent observation renders **nothing** — never zero, never "NaN ago".
 *
 * One formatter and one component serve the rail and the inspector, so the same span can never
 * read as two different numbers on one screen.
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
const WORKER = 'term_1a2b3c4d-1234-4321-8888-aabbccddeeff';
const RUN_ID = `run_${HANDLE}`;
const TASK_ID = 'task_aaaaaaaa';

const DISPATCHED_AT = '2026-07-08T12:00:00.000Z';
const DISPATCH_DONE_AT = '2026-07-08T12:25:00.000Z';

const DISPATCH_CLOCK: DurationObservation = {
  clock: 'dispatch',
  startAt: DISPATCHED_AT,
  endAt: DISPATCH_DONE_AT,
  complete: true,
  ms: 25 * 60 * 1000,
};

const TASK_SPAN: DurationObservation = {
  clock: 'task-span',
  startAt: '2026-07-08T11:50:00.000Z',
  endAt: '2026-07-08T12:30:00.000Z',
  complete: true,
  ms: 40 * 60 * 1000,
};

function run(over: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    handle: HANDLE,
    label: 'Ship the visualizer',
    startedAt: '2026-07-08T12:00:00.000Z',
    lastActivityAt: '2026-07-08T13:00:00.000Z',
    converged: true,
    endedAt: '2026-07-08T13:00:00.000Z',
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
    id: TASK_ID,
    runId: RUN_ID,
    parentId: null,
    title: 'Chart the map',
    status: 'completed',
    deps: [],
    createdAt: '2026-07-08T11:50:00.000Z',
    completedAt: '2026-07-08T12:30:00.000Z',
    hasSpec: true,
    hasResult: true,
    dispatch: null,
    attemptCount: 1,
    gate: null,
    ...over,
  };
}

function attempt(over: Partial<Dispatch> = {}): Dispatch {
  return {
    id: 'ctx_first',
    assigneeHandle: WORKER,
    status: 'completed',
    failureCount: 0,
    lastFailure: null,
    dispatchedAt: DISPATCHED_AT,
    completedAt: DISPATCH_DONE_AT,
    lastHeartbeatAt: null,
    ...over,
  };
}

function event(runs: Run[], tasks: Task[]): CannedEvent {
  return {
    seq: 0,
    affected: { all: true, runIds: [], unplaced: false },
    meta: META,
    snapshot: { runs, tasks, gates: [], turns: [], coordinatorRuns: [] },
    messages: [],
  };
}

function loaderFor(detail: TaskDetail): TaskLoader {
  return async () => detail;
}

function railRow(runId: string): HTMLElement {
  const found = screen.getAllByTestId('run-row').find((element) => element.dataset.run === runId);
  if (!found) throw new Error(`no rail row for ${runId}`);
  return found;
}

async function openInspector(id: string = TASK_ID): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getAllByTestId('task-node').length).toBeGreaterThan(0));
  const node = screen.getAllByTestId('task-node').find((element) => element.dataset.task === id);
  if (!node) throw new Error(`no node for ${id} on the canvas`);
  fireEvent.click(node);
  await waitFor(() => expect(screen.queryByTestId('inspector')).not.toBeNull());
  return screen.getByTestId('inspector');
}

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The pure half: milliseconds into words. Two units at most — a post-mortem compares attempts,
 * it does not audit seconds inside hours.
 */
describe('how a duration reads', () => {
  it('formats across the scales, two units at most', () => {
    expect(formatDurationMs(0)).toBe('0s');
    expect(formatDurationMs(45_000)).toBe('45s');
    expect(formatDurationMs(3 * 60 * 1000)).toBe('3m');
    expect(formatDurationMs(3 * 60 * 1000 + 20_000)).toBe('3m 20s');
    expect(formatDurationMs(2 * 60 * 60 * 1000)).toBe('2h');
    expect(formatDurationMs(2 * 60 * 60 * 1000 + 5 * 60 * 1000)).toBe('2h 5m');
    expect(formatDurationMs(26 * 60 * 60 * 1000)).toBe('1d 2h');
  });

  it('never shows a negative number, whatever the clocks did', () => {
    expect(formatDurationMs(-5_000)).toBe('0s');
  });
});

describe('a wire this client did not expect', () => {
  it('falls silent on a contradictory completed observation, rather than rounding it to zero', () => {
    // The server refuses backwards clocks (`server/durations.ts`), so a negative `ms` on a
    // *complete* observation can only be a wire this build never wrote — and "0s" would be
    // exactly the invented number the whole feature exists to never show (issue #66 AC).
    const hostile: DurationObservation = {
      clock: 'dispatch',
      startAt: DISPATCH_DONE_AT,
      endAt: DISPATCHED_AT,
      complete: true,
      ms: -25 * 60 * 1000,
    };
    render(<CannedApp event={event([run({ duration: hostile })], [])} />);

    expect(within(railRow(RUN_ID)).queryByTestId('run-span')).toBeNull();
  });
});

describe('the run span on the rail', () => {
  it('shows a finished run’s span, and names its clock in the tooltip', () => {
    const span: DurationObservation = {
      clock: 'run-span',
      startAt: '2026-07-08T12:00:00.000Z',
      endAt: '2026-07-08T13:40:00.000Z',
      complete: true,
      ms: 100 * 60 * 1000,
    };
    render(<CannedApp event={event([run({ duration: span })], [])} />);

    const reading = within(railRow(RUN_ID)).getByTestId('run-span');
    expect(reading).toHaveTextContent('1h 40m');
    // The provenance rides with the number (SPEC §14.4): which clock, and which endpoints.
    expect(reading.getAttribute('title')).toMatch(/run span/i);
  });

  it('shows nothing at all when the evidence supported no observation', () => {
    render(<CannedApp event={event([run()], [])} />);

    expect(within(railRow(RUN_ID)).queryByTestId('run-span')).toBeNull();
  });

  it('ages a live run as "so far", from the reader’s wall clock, without waiting for a push', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T13:00:00.000Z'));

    const open: DurationObservation = { clock: 'run-span', startAt: '2026-07-08T12:00:00.000Z', complete: false };
    render(<CannedApp event={event([run({ live: true, duration: open })], [])} />);

    expect(within(railRow(RUN_ID)).getByTestId('run-span')).toHaveTextContent('1h so far');

    // No SSE push happens here. The clock on the wall is the only thing that moves (story 4).
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(within(railRow(RUN_ID)).getByTestId('run-span')).toHaveTextContent('1h 1m so far');
  });

  it('stops the clock the moment completion evidence arrives', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T13:00:00.000Z'));

    const open: DurationObservation = { clock: 'run-span', startAt: '2026-07-08T12:00:00.000Z', complete: false };
    const { rerender } = render(<CannedApp event={event([run({ live: true, duration: open })], [])} />);

    // The next push carries the completed observation — the interval closed at 13:10.
    const closed: DurationObservation = {
      clock: 'run-span',
      startAt: '2026-07-08T12:00:00.000Z',
      endAt: '2026-07-08T13:10:00.000Z',
      complete: true,
      ms: 70 * 60 * 1000,
    };
    rerender(<CannedApp event={event([run({ duration: closed })], [])} />);

    const reading = within(railRow(RUN_ID)).getByTestId('run-span');
    expect(reading).toHaveTextContent('1h 10m');
    expect(reading).not.toHaveTextContent(/so far/);

    // …and it stays stopped: the wall clock no longer has a say.
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(within(railRow(RUN_ID)).getByTestId('run-span')).toHaveTextContent('1h 10m');
  });
});

describe('durations in the inspector', () => {
  it('shows the task’s dispatch duration as a bare number — the preferred clock needs no apology', async () => {
    render(
      <CannedApp
        event={event([run()], [task({ duration: DISPATCH_CLOCK, dispatch: attempt() })])}
        loadTask={loaderFor({ id: TASK_ID, spec: null, result: null, receipt: [], completions: [], attempts: [attempt()] })}
      />
    );
    const inspector = await openInspector();

    const reading = within(inspector).getByTestId('task-duration');
    expect(reading).toHaveTextContent('25m');
    expect(reading).not.toHaveTextContent(/task span|so far/);
    expect(reading.getAttribute('title')).toMatch(/dispatch/i);
  });

  it('labels the task-span fallback as what it is — a broader clock is never passed off as dispatch time', async () => {
    render(
      <CannedApp
        event={event([run()], [task({ duration: TASK_SPAN })])}
        loadTask={loaderFor({ id: TASK_ID, spec: null, result: null, receipt: [], completions: [], attempts: [] })}
      />
    );
    const inspector = await openInspector();

    expect(within(inspector).getByTestId('task-duration')).toHaveTextContent('40m task span');
  });

  it('times every attempt on its own clock — the retry story, compared without arithmetic', async () => {
    const first = attempt({
      id: 'ctx_first',
      status: 'failed',
      failureCount: 1,
      dispatchedAt: '2026-07-08T11:52:00.000Z',
      completedAt: '2026-07-08T11:58:00.000Z',
      duration: {
        clock: 'dispatch',
        startAt: '2026-07-08T11:52:00.000Z',
        endAt: '2026-07-08T11:58:00.000Z',
        complete: true,
        ms: 6 * 60 * 1000,
      },
    });
    const second = attempt({ id: 'ctx_second', duration: DISPATCH_CLOCK });

    render(
      <CannedApp
        event={event([run()], [task({ dispatch: second, attemptCount: 2, duration: DISPATCH_CLOCK })])}
        loadTask={loaderFor({ id: TASK_ID, spec: null, result: null, receipt: [], completions: [], attempts: [first, second] })}
      />
    );
    const inspector = await openInspector();

    await waitFor(() => expect(within(inspector).getAllByTestId('attempt')).toHaveLength(2));
    const readings = within(inspector).getAllByTestId('attempt-duration');
    expect(readings.map((reading) => reading.textContent)).toEqual(['6m', '25m']);
  });

  it('says nothing for an attempt whose clock never closed readably, and "so far" for one still out', async () => {
    // The first attempt failed without recording when — the server sent no observation, and no
    // number is invented for it here. The second is still running, and says so.
    const broken = attempt({ id: 'ctx_broken', status: 'failed', completedAt: null });
    const running = attempt({
      id: 'ctx_running',
      status: 'dispatched',
      completedAt: null,
      duration: { clock: 'dispatch', startAt: DISPATCHED_AT, complete: false },
    });

    render(
      <CannedApp
        event={event([run()], [task({ status: 'dispatched', completedAt: null, dispatch: running, attemptCount: 2 })])}
        loadTask={loaderFor({ id: TASK_ID, spec: null, result: null, receipt: [], completions: [], attempts: [broken, running] })}
      />
    );
    const inspector = await openInspector();

    await waitFor(() => expect(within(inspector).getAllByTestId('attempt')).toHaveLength(2));
    const readings = within(inspector).getAllByTestId('attempt-duration');
    expect(readings).toHaveLength(1);
    expect(readings[0]).toHaveTextContent(/so far$/);
  });
});
