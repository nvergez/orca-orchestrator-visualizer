import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/client/App.tsx';
import type { CastMember, Meta, Run, Scorecard, StreamEvent, Task } from '../../src/shared/types.ts';

/**
 * The scoreboard, on screen (#68, SPEC §12.4). The server sends one scorecard per cast member
 * (`server/scoreboard.ts`) and the client's whole job is presentation without editorial:
 *
 * - a **multi-agent** cast is a comparison grid, one row per agent, each metric its own column;
 * - a **one-agent** cast is a compact rollup of the same facts — never an empty grid;
 * - metrics are **individually sortable**, and an unknown sorts last rather than as zero;
 * - an absent fact renders as unknown — never `0`, never `0s` — because the server already
 *   refused to invent it;
 * - and there is **no composite score, no winner, and no claim of equal work** anywhere.
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
const RUN_ID = `run_${HANDLE}`;

const FIRST = 'term_aaaa1111-1234-4321-8888-aabbccddeeff';
const SECOND = 'term_bbbb2222-1234-4321-8888-aabbccddeeff';
const THIRD = 'term_cccc3333-1234-4321-8888-aabbccddeeff';

function member(monogram: string, handle: string, score: Scorecard): CastMember {
  return { handle, monogram, taskIds: ['task_aaaaaaaa'], taskCount: 1, lastHeartbeatAt: null, score };
}

const COMPLETE_SPAN: Scorecard['span'] = {
  clock: 'agent-span',
  startAt: '2026-07-08T12:00:00.000Z',
  endAt: '2026-07-08T12:30:00.000Z',
  complete: true,
  ms: 30 * 60_000,
};

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

function event(runs: Run[], tasks: Task[]): StreamEvent {
  return { seq: 0, meta: META, snapshot: { runs, tasks, gates: [], turns: [], coordinatorRuns: [] }, messages: [] };
}

/** Three agents whose facts differ on every axis the grid can sort. */
function trio(): CastMember[] {
  return [
    member('A1', FIRST, {
      span: COMPLETE_SPAN,
      firstHeartbeat: {
        clock: 'first-heartbeat',
        startAt: '2026-07-08T12:00:00.000Z',
        endAt: '2026-07-08T12:02:00.000Z',
        complete: true,
        ms: 2 * 60_000,
      },
      heartbeats: 5,
      messages: 2,
      escalations: 0,
      failures: 1,
      outcomeLinks: ['https://github.com/x/y/pull/1'],
    }),
    member('A2', SECOND, {
      span: { clock: 'agent-span', startAt: '2026-07-08T12:05:00.000Z', complete: false },
      heartbeats: 0,
      messages: 4,
      escalations: 1,
      failures: 4,
    }),
    // Missing evidence end to end: no span, no beats readable, no failure column.
    member('A3', THIRD, { heartbeats: 1, messages: 0, escalations: 0 }),
  ];
}

function openScoreboard(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: /scoreboard/i }));
  return screen.getByTestId('scoreboard');
}

function rowOrder(panel: HTMLElement): (string | undefined)[] {
  return within(panel)
    .getAllByTestId('scoreboard-row')
    .map((row) => row.dataset.agent);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('reaching the scoreboard', () => {
  it('swaps the dock from the conversation and back — the way out is where the way in was', () => {
    render(<App event={event([run({ cast: trio() })], [task()])} />);

    const panel = openScoreboard();
    expect(panel).toBeInTheDocument();
    expect(screen.queryByTestId('conversation')).toBeNull();

    fireEvent.click(within(panel).getByRole('button', { name: /back to the conversation/i }));
    expect(screen.queryByTestId('scoreboard')).toBeNull();
    expect(screen.getByTestId('conversation')).toBeInTheDocument();
  });
});

describe('the comparison grid', () => {
  it('renders one row per cast member, in dispatch order, with each metric its own column', () => {
    render(<App event={event([run({ cast: trio() })], [task()])} />);
    const panel = openScoreboard();

    expect(rowOrder(panel)).toEqual(['A1', 'A2', 'A3']);

    const first = within(panel)
      .getAllByTestId('scoreboard-row')
      .find((row) => row.dataset.agent === 'A1')!;

    // Heartbeats and other messages are separate facts in separate cells (SPEC §12.4).
    expect(within(first).getByTestId('score-heartbeats')).toHaveTextContent('5');
    expect(within(first).getByTestId('score-messages')).toHaveTextContent('2');
    expect(within(first).getByTestId('score-failures')).toHaveTextContent('1');
    expect(within(first).getByTestId('score-escalations')).toHaveTextContent('0');
    expect(within(first).getByTestId('score-span')).toHaveTextContent('30m');
    expect(within(first).getByTestId('score-first-heartbeat')).toHaveTextContent('2m');
  });

  it('labels incomplete work "so far" and renders the unknown as unknown — never zero', () => {
    render(<App event={event([run({ cast: trio() })], [task()])} />);
    const panel = openScoreboard();
    const rows = within(panel).getAllByTestId('scoreboard-row');

    const second = rows.find((row) => row.dataset.agent === 'A2')!;
    expect(within(second).getByTestId('score-span')).toHaveTextContent(/so far/);
    // No retained heartbeat: unknown, and explained — never `0s` (SPEC §12.4).
    const firstBeat = within(second).getByTestId('score-first-heartbeat');
    expect(firstBeat).toHaveTextContent('—');
    expect(firstBeat).not.toHaveTextContent(/^0/);
    expect(firstBeat.getAttribute('title')).toMatch(/unknown/i);

    const third = rows.find((row) => row.dataset.agent === 'A3')!;
    expect(within(third).getByTestId('score-span')).toHaveTextContent('—');
    expect(within(third).getByTestId('score-failures')).toHaveTextContent('—');
  });

  it('links each recognized outcome, and only claims what a receipt said', () => {
    render(<App event={event([run({ cast: trio() })], [task()])} />);
    const panel = openScoreboard();
    const rows = within(panel).getAllByTestId('scoreboard-row');

    const link = within(rows.find((row) => row.dataset.agent === 'A1')!).getByRole('link');
    expect(link).toHaveAttribute('href', 'https://github.com/x/y/pull/1');

    expect(within(rows.find((row) => row.dataset.agent === 'A2')!).queryByRole('link')).toBeNull();
  });

  it('sorts by one metric at a time, and an unknown sorts last in either direction', () => {
    render(<App event={event([run({ cast: trio() })], [task()])} />);
    const panel = openScoreboard();

    const byFailures = within(panel).getByRole('button', { name: /sort by failures/i });

    // Most failures first, and A3 — whose count is unknowable, not zero — last.
    fireEvent.click(byFailures);
    expect(rowOrder(panel)).toEqual(['A2', 'A1', 'A3']);

    // The other direction: fewest first, unknown still last, never dressed as the smallest.
    fireEvent.click(byFailures);
    expect(rowOrder(panel)).toEqual(['A1', 'A2', 'A3']);

    // A different metric is a fresh sort, not a composite of the two.
    fireEvent.click(within(panel).getByRole('button', { name: /sort by messages/i }));
    expect(rowOrder(panel)).toEqual(['A2', 'A1', 'A3']);
  });

  it('offers no composite score, no winner, and no claim that the work was comparable', () => {
    render(<App event={event([run({ cast: trio() })], [task()])} />);
    const panel = openScoreboard();

    expect(within(panel).queryByText(/winner|overall|composite|total score/i)).toBeNull();
    // The refusal is said out loud, not just omitted: different work, no ranking.
    expect(within(panel).getByText(/different work/i)).toBeInTheDocument();
  });
});

describe('the one-agent rollup', () => {
  it('shows the same facts as a compact rollup, never an empty comparison grid', () => {
    render(<App event={event([run({ cast: [trio()[0]!] })], [task()])} />);
    const panel = openScoreboard();

    expect(within(panel).queryByTestId('scoreboard-grid')).toBeNull();
    const rollup = within(panel).getByTestId('scoreboard-rollup');

    expect(within(rollup).getByText('A1')).toBeInTheDocument();
    expect(within(rollup).getByTestId('score-heartbeats')).toHaveTextContent('5');
    expect(within(rollup).getByTestId('score-messages')).toHaveTextContent('2');
    expect(within(rollup).getByTestId('score-span')).toHaveTextContent('30m');
    expect(within(rollup).getByRole('link')).toHaveAttribute('href', 'https://github.com/x/y/pull/1');
  });

  it('says why there is nothing to compare when the cast is empty', () => {
    render(<App event={event([run({ cast: [] })], [task()])} />);
    const panel = openScoreboard();

    expect(within(panel).getByTestId('scoreboard-empty')).toHaveTextContent(/no agents/i);
  });
});
