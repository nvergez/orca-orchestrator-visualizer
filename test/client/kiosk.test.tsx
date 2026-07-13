import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.tsx';
import type { TaskLoader } from '../../src/client/inspector/detail.ts';
import { Kiosk } from '../../src/client/kiosk/Kiosk.tsx';
import { routeOf } from '../../src/client/route.ts';
import { STALE_HEARTBEAT_MS } from '../../src/shared/run-health.ts';
import type { CastMember, Dispatch, Gate, Meta, Run, StreamEvent, Task, Turn } from '../../src/shared/types.ts';

/**
 * The kiosk on screen (#62), at the canned-event seam every client suite uses.
 *
 * Two things are being proven here and they pull in opposite directions, which is the point.
 *
 * **What the kiosk shows** — only unfinished orchestrations, each one saying whether anything is
 * moving in it, how its worst worker is doing and how long it has been blocked; the shared queue;
 * the shared transport and data-age facts; the ticker. And honest presentations of the states a
 * wall display will actually spend its night in: empty, all-finished, post-mortem, degraded.
 *
 * **What the kiosk must not become** — a second implementation of any of it. So the drift tests
 * render `<App>` and `<Kiosk>` against the *same event* and compare what they say: the same
 * attention items, in the same order, with the same explanations; the same health for the same
 * run; the same worker sentence. Those assertions are the reason the shared derivations were
 * extracted at all, and they are what would fail the day someone "just tweaks" one of them for
 * the wall.
 */

const NO_DETAIL: TaskLoader = async (id) => ({ id, spec: null, result: null, attempts: [] });

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

const AGENT_A = 'term_agent-aaaa-4321-8888-aabbccddeeff';
const AGENT_B = 'term_agent-bbbb-4321-8888-aabbccddeeff';

const MINUTE = 60_000;

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function member(over: Partial<CastMember> & { handle: string }): CastMember {
  return { monogram: 'A1', taskIds: [], taskCount: 1, lastHeartbeatAt: null, ...over };
}

function run(over: Partial<Run> & { id: string }): Run {
  return {
    handle: `term_${over.id}`,
    label: over.id,
    startedAt: ago(60 * MINUTE),
    lastActivityAt: ago(MINUTE),
    converged: false,
    endedAt: ago(MINUTE),
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

function dispatch(over: Partial<Dispatch> = {}): Dispatch {
  return {
    id: 'dispatch_1',
    assigneeHandle: AGENT_A,
    status: 'dispatched',
    failureCount: 0,
    lastFailure: null,
    dispatchedAt: ago(MINUTE),
    completedAt: null,
    lastHeartbeatAt: ago(MINUTE),
    ...over,
  };
}

function task(over: Partial<Task> & { id: string; runId: string }): Task {
  return {
    parentId: null,
    title: over.id,
    status: 'dispatched',
    deps: [],
    createdAt: ago(30 * MINUTE),
    completedAt: null,
    hasSpec: false,
    hasResult: false,
    dispatch: null,
    attemptCount: 1,
    gate: null,
    ...over,
  };
}

function gate(over: Partial<Gate> & { id: string; runId: string }): Gate {
  return {
    messageId: null,
    taskId: null,
    question: 'Ship it?',
    options: [],
    status: 'pending',
    blocking: true,
    resolution: null,
    createdAt: ago(20 * MINUTE),
    ...over,
  };
}

function event(over: Partial<StreamEvent['snapshot']> = {}, meta: Partial<Meta> = {}, seq = 1): StreamEvent {
  return {
    seq,
    meta: { ...META, ...meta },
    snapshot: { runs: [], tasks: [], gates: [], turns: [], coordinatorRuns: [], ...over },
    messages: [],
  };
}

/** A busy afternoon: one active crew, one that has gone quiet, one blocked, one already done. */
function afternoon(): StreamEvent {
  return event({
    runs: [
      run({
        id: 'run_active',
        label: 'Ship the visualizer',
        cast: [member({ handle: AGENT_A }), member({ handle: AGENT_B, monogram: 'A2' })],
        taskCount: 2,
        statusCounts: { pending: 0, ready: 0, dispatched: 2, completed: 0, failed: 0, blocked: 0 },
      }),
      run({
        id: 'run_silent',
        label: 'Migrate the schema',
        lastActivityAt: ago(STALE_HEARTBEAT_MS + 4 * MINUTE),
        endedAt: ago(STALE_HEARTBEAT_MS + 4 * MINUTE),
      }),
      // Explicitly older than `run_active`, so the active tier's freshest-first order is a fact of
      // the fixture and not of how fast the machine built it: two runs both stamped `ago(MINUTE)`
      // would straddle a millisecond under load and swap places.
      run({
        id: 'run_blocked',
        label: 'Cut the release',
        hasBlockingGates: true,
        lastActivityAt: ago(2 * MINUTE),
        endedAt: ago(2 * MINUTE),
      }),
      run({
        id: 'run_done',
        label: 'Yesterday, finished',
        converged: true,
        lastActivityAt: ago(90 * MINUTE),
        endedAt: ago(90 * MINUTE),
        statusCounts: { pending: 0, ready: 0, dispatched: 0, completed: 3, failed: 0, blocked: 0 },
      }),
    ],
    tasks: [
      // A1 is beating; A2 went quiet — the run's *worst* worker is the one the tile must wear.
      task({ id: 'task_beating', runId: 'run_active', dispatch: dispatch({ assigneeHandle: AGENT_A }) }),
      task({
        id: 'task_quiet',
        runId: 'run_active',
        dispatch: dispatch({
          id: 'dispatch_2',
          assigneeHandle: AGENT_B,
          lastHeartbeatAt: ago(STALE_HEARTBEAT_MS + 5 * MINUTE),
        }),
      }),
      task({ id: 'task_blocked', runId: 'run_blocked', status: 'blocked' }),
    ],
    gates: [
      gate({
        id: 'gate_release',
        runId: 'run_blocked',
        taskId: 'task_blocked',
        question: 'Tag v1.0 and publish?',
        createdAt: ago(20 * MINUTE),
      }),
      // Older, and blocking nothing: the wall must not read a lifecycle state as a blocker (#45).
      gate({
        id: 'gate_ancient',
        runId: 'run_blocked',
        question: 'Anyone remember this one?',
        status: 'unanswered',
        blocking: false,
        createdAt: ago(600 * MINUTE),
      }),
    ],
  });
}

function tiles(): HTMLElement[] {
  return screen.queryAllByTestId('kiosk-tile');
}

function tile(runId: string): HTMLElement {
  const found = tiles().find((element) => element.dataset.run === runId);
  if (!found) throw new Error(`no kiosk tile for ${runId}`);
  return found;
}

describe('the route', () => {
  it('names the kiosk, and nothing else', () => {
    expect(routeOf('/kiosk')).toBe('kiosk');
    expect(routeOf('/kiosk/')).toBe('kiosk');
    expect(routeOf('/')).toBe('main');
    // A typo is the main screen, never a kiosk that half-matched: the server 404s it anyway.
    expect(routeOf('/kiosc')).toBe('main');
    expect(routeOf('/kiosk/settings')).toBe('main');
  });
});

describe('<Kiosk>', () => {
  it('renders only the orchestrations #48 classifies as unfinished', () => {
    render(<Kiosk event={afternoon()} />);

    expect(tiles().map((element) => element.dataset.run)).toEqual(['run_silent', 'run_active', 'run_blocked']);
    expect(screen.queryByText('Yesterday, finished')).toBeNull();
  });

  it('says how many finished orchestrations it is leaving out, rather than lying by omission', () => {
    render(<Kiosk event={afternoon()} />);

    expect(screen.getByTestId('kiosk-finished-note')).toHaveTextContent('1 finished orchestration is not shown here');
  });

  it('distinguishes an active orchestration from a silent one, and says how long the silence is', () => {
    render(<Kiosk event={afternoon()} />);

    expect(tile('run_active').dataset.health).toBe('active');
    expect(within(tile('run_active')).getByTestId('kiosk-tile-health')).toHaveTextContent('active — recent activity');

    expect(tile('run_silent').dataset.health).toBe('silent');
    // The glossary's word and the glossary's claim: unfinished, no recent evidence. Never "dead".
    expect(within(tile('run_silent')).getByTestId('kiosk-tile-health')).toHaveTextContent(
      'silent — unfinished, no recent activity · nothing recorded for 14m'
    );
  });

  it('says a tile’s health once, not twice, to a screen reader', () => {
    // The tile writes the health out in words — with the length of the silence, which the dot
    // cannot carry — so the dot goes quiet beside it. Two voices saying "silent" about one run is
    // how an accessible page becomes a tiring one.
    render(<Kiosk event={afternoon()} />);

    expect(within(tile('run_silent')).getByTestId('health-dot')).toHaveAttribute('aria-hidden', 'true');
    expect(within(tile('run_silent')).getByTestId('kiosk-tile-health')).toBeVisible();
  });

  it('wears the worst current worker health in the cast, not the freshest', () => {
    render(<Kiosk event={afternoon()} />);

    const workers = within(tile('run_active')).getByTestId('kiosk-tile-workers');

    expect(workers.dataset.health).toBe('stale');
    expect(workers).toHaveTextContent('1 stale · 1 active');
  });

  it('says there is no dispatch attempt on record — never that nobody is running', () => {
    // The database can prove the *absence of a record*. It cannot prove the absence of a process,
    // and the wall must not say it does (CONTEXT.md; ADR 0001, run health vs process liveness).
    render(<Kiosk event={afternoon()} />);

    const workers = within(tile('run_silent')).getByTestId('kiosk-tile-workers');

    expect(workers).toHaveTextContent('no current dispatch attempt on record');
    expect(workers.textContent).not.toMatch(/running|dead|hung|stuck/i);
  });

  it('says "no readable dispatch evidence" rather than reporting an unreadable attempt as no attempt', () => {
    // A dispatched attempt whose instants will not parse is *unknown*, and unknown is not absent.
    // Reporting it as "no attempt on record" would invent the fact the column failed to record
    // (SPEC §5, render-what-parses).
    const base = afternoon();
    render(
      <Kiosk
        event={event({
          ...base.snapshot,
          runs: [run({ id: 'run_broken', cast: [member({ handle: AGENT_A })] })],
          tasks: [
            task({
              id: 'task_unreadable',
              runId: 'run_broken',
              dispatch: dispatch({ dispatchedAt: 'when the moon was high', lastHeartbeatAt: null }),
            }),
          ],
          gates: [],
        })}
      />
    );

    const workers = within(tile('run_broken')).getByTestId('kiosk-tile-workers');

    expect(workers.dataset.health).toBe('unknown');
    expect(workers).toHaveTextContent('1 with no readable dispatch evidence');
  });

  it('shows the oldest *blocking* gate and how long it has held the work', () => {
    render(<Kiosk event={afternoon()} />);

    const blocked = within(tile('run_blocked')).getByTestId('kiosk-tile-gate');

    expect(blocked).toHaveTextContent('blocked for 20m');
    expect(blocked).toHaveTextContent('Tag v1.0 and publish?');
    // The 10-hour unanswered ask is older and blocks nothing — a lifecycle state is not a blocker.
    expect(blocked).not.toHaveTextContent('Anyone remember this one?');
  });

  it('shows no gate line at all for a run nothing is provably blocking', () => {
    render(<Kiosk event={afternoon()} />);

    expect(within(tile('run_active')).queryByTestId('kiosk-tile-gate')).toBeNull();
  });

  it('contains no DAG, no inspector, no conversation, no finished-run browser and nothing to mutate', () => {
    render(<Kiosk event={afternoon()} />);

    // The four panels the kiosk exists to *not* inherit.
    expect(screen.queryByTestId('canvas')).toBeNull();
    expect(screen.queryByTestId('inspector')).toBeNull();
    expect(screen.queryByRole('heading', { name: /conversation/i })).toBeNull();
    expect(screen.queryByTestId('run-row')).toBeNull();

    // And nothing on it selects, opens, acknowledges, dismisses or resolves anything: the only
    // control on the page is the one that is about the reader rather than the data (the theme).
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName(/theme/i);
  });

  it('never asks for the browser screen', async () => {
    // A kiosk *route*, not a kiosk *mode* (#62): fullscreen, wake locks and rotation belong to
    // whoever owns the display, and a page that grabbed the screen on load could not be put on a
    // wall beside anything else.
    const requestFullscreen = vi.fn();
    vi.stubGlobal('Element', Element);
    Element.prototype.requestFullscreen = requestFullscreen;

    render(<Kiosk event={afternoon()} />);
    await act(async () => {});

    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it('wears the shared transport state and the data age, and keeps the age moving on a quiet stream', () => {
    vi.useFakeTimers();
    try {
      const appliedAt = Date.now() - 30_000;
      render(<Kiosk event={afternoon()} connection="reconnecting" appliedAt={appliedAt} />);

      expect(screen.getByTestId('stream-state')).toHaveTextContent(/reconnecting/i);
      expect(screen.getByTestId('data-age')).toHaveTextContent('30s');

      // Nothing arrives. The age must grow anyway — that is the whole of #57's claim, and on a
      // wall it is the difference between "quiet" and "this picture froze an hour ago".
      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      expect(screen.getByTestId('data-age')).toHaveTextContent('2m'); // 30s + 60s, coarsely (#57)
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells you what has happened since it connected, without offering anywhere to click', () => {
    const first = afternoon();
    const { rerender } = render(<Kiosk event={first} />);

    // The first snapshot is a baseline, never news (#58).
    expect(screen.queryByTestId('session-activity')).toBeNull();

    const moved: StreamEvent = {
      ...first,
      seq: 2,
      snapshot: {
        ...first.snapshot,
        tasks: first.snapshot.tasks.map((current) =>
          current.id === 'task_beating' ? { ...current, status: 'completed', completedAt: ago(1000) } : current
        ),
      },
    };
    rerender(<Kiosk event={moved} />);

    const entries = screen.getAllByTestId('activity-entry');
    expect(entries.length).toBeGreaterThan(0);
    // The ticker narrates; it does not navigate. There is no inspector here to open.
    expect(within(entries[0]!).queryByRole('button')).toBeNull();
  });
});

describe('<Kiosk> in the states a wall display actually spends its night in', () => {
  it('says an empty database is empty, and does not call it a good day', () => {
    render(<Kiosk event={event()} />);

    expect(screen.getByTestId('kiosk-empty')).toHaveTextContent(/no orchestrations in this database yet/i);
    expect(screen.queryByTestId('kiosk-finished-note')).toBeNull();
  });

  it('says an all-finished database has converged, and how much of it did', () => {
    render(
      <Kiosk
        event={event({
          runs: [
            run({ id: 'run_one', converged: true }),
            run({ id: 'run_two', converged: true }),
          ],
        })}
      />
    );

    expect(screen.getByTestId('kiosk-empty')).toHaveTextContent(
      /nothing unfinished: all 2 orchestrations in this database have converged/i
    );
    expect(tiles()).toHaveLength(0);
  });

  it('reads a post-mortem database as one: Orca is not running, and the runs are still unfinished', () => {
    // The two facts stay apart (SPEC §12.1). A dead Orca does not *finish* the work that was in
    // flight when it died — the rows still say `dispatched` and nothing will ever rewrite them —
    // so the tiles remain, and the top bar is where "nobody is writing to this any more" is said.
    render(<Kiosk event={event(afternoon().snapshot, { liveness: 'stale', orcaPid: null })} />);

    expect(screen.getByText(/Orca isn't running; showing last-known state from/i)).toBeVisible();
    expect(tiles().map((element) => element.dataset.run)).toEqual(['run_silent', 'run_active', 'run_blocked']);
    // …and it still refuses to fold the two facts together: a run with recent evidence is still
    // `active` on the wall, because health is about the *evidence*, not about the process.
    expect(tile('run_active').dataset.health).toBe('active');
  });

  it('carries the degraded-schema notice, so a missing column explains a missing fact', () => {
    render(
      <Kiosk
        event={event(afternoon().snapshot, {
          schemaVersion: 3,
          schemaSupport: 'older',
          degraded: ['Runs — this Orca has no created_by_terminal_handle column, so every task lands in Unattributed.'],
        })}
      />
    );

    expect(screen.getByText(/older Orca schema/i)).toBeVisible();
    expect(screen.getByText(/created_by_terminal_handle/)).toBeVisible();
    // …and the wall still draws what it *can* prove from the columns that did survive.
    expect(screen.getAllByTestId('kiosk-tile').length).toBeGreaterThan(0);
  });

  it('says outright that nothing needs attention, rather than leaving an empty column', () => {
    render(<Kiosk event={event({ runs: [run({ id: 'run_calm' })] })} />);

    // The five causes it looked for, named from the queue's own table — an empty column that says
    // *what it checked* is evidence; one that says nothing is just an empty column.
    const empty = screen.getByTestId('kiosk-attention-empty');
    expect(empty).toHaveTextContent(/nothing needs attention/i);
    expect(empty).toHaveTextContent('no blocking decision gate');
    expect(empty).toHaveTextContent('no stale worker');
    expect(empty).toHaveTextContent('no retry risk');
    expect(empty).toHaveTextContent('no unresolved escalation');
    expect(empty).toHaveTextContent('no fresh failure');
  });
});

/**
 * The reason the shared derivations were extracted (#62's last acceptance criterion): the same
 * event, through both screens, saying the same things.
 */
describe('the kiosk and the main screen do not drift', () => {
  // The clock is held still for these three, and it has to be: both screens age their evidence
  // against the shared wall clock, so the two renders happening a second apart — which is what a
  // loaded machine does — would put "escalated 30s ago" beside "escalated 31s ago" and fail an
  // assertion about *drift* over a fact that had simply moved on. Freezing time is what makes the
  // comparison a comparison of the two derivations rather than of two instants.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const attention = (): { causes: string[]; explanations: string[] } => {
    const items = screen.getAllByTestId('attention-item');
    return {
      causes: items.map((item) => item.dataset.cause ?? ''),
      explanations: items.map((item) => item.textContent ?? ''),
    };
  };

  function noisy(): StreamEvent {
    const base = afternoon();
    // Newer than its task's current dispatch attempt, so it is a request for help nobody has
    // acted on yet: an escalation *older* than the latest attempt has been superseded by that
    // retry, and the queue drops it (#56) — correctly, and it would leave nothing to compare.
    const turn: Turn = {
      id: 'msg:12',
      runId: 'run_active',
      direction: 'in',
      kind: 'escalation',
      fromHandle: AGENT_B,
      toHandle: 'term_run_active',
      at: ago(30_000),
      taskId: 'task_quiet',
      subject: 'Cannot reach the registry',
      body: 'npm 503s on every publish attempt.',
      source: 'messages',
    };

    return {
      ...base,
      snapshot: {
        ...base.snapshot,
        turns: [turn],
        tasks: base.snapshot.tasks.map((current) =>
          current.id === 'task_blocked'
            ? { ...current, dispatch: dispatch({ id: 'dispatch_retry', failureCount: 2, lastFailure: ago(2 * MINUTE) }) }
            : current
        ),
      },
    };
  }

  it('shows the same attention queue, in the same order, with the same explanations', () => {
    const both = noisy();

    const main = render(<App event={both} loadTask={NO_DETAIL} />);
    const fromMain = attention();
    main.unmount();

    render(<Kiosk event={both} />);
    const fromKiosk = attention();

    // Four causes, so the ordering assertion is actually asserting an order.
    expect(fromMain.causes.length).toBeGreaterThanOrEqual(4);
    expect(fromKiosk.causes).toEqual(fromMain.causes);
    expect(fromKiosk.explanations).toEqual(fromMain.explanations);
  });

  it("classifies every run's health exactly as the rail does", () => {
    const both = noisy();

    const main = render(<App event={both} loadTask={NO_DETAIL} />);
    const fromRail = new Map(
      screen
        .getAllByTestId('run-row')
        .map((row) => [
          row.dataset.run ?? '',
          within(row).getByTestId('health-dot').dataset.health ?? '',
        ])
    );
    main.unmount();

    render(<Kiosk event={both} />);
    const fromWall = new Map(
      tiles().map((element) => [
        element.dataset.run ?? '',
        within(element).getByTestId('health-dot').dataset.health ?? '',
      ])
    );

    // The wall shows a subset — it drops the finished — and every run it *does* show, it shows
    // exactly as the rail shows it.
    expect(fromWall.size).toBeGreaterThan(0);
    for (const [runId, health] of fromWall) expect(health).toBe(fromRail.get(runId));
    expect([...fromWall.values()]).not.toContain('finished');
  });

  it('names the same blocking question the attention queue puts first for that run', () => {
    // The tile's gate is not a second read of #45 — it is the queue's own oldest-first list of
    // blocking questions (`blockingGates`), taken off the front for this run. So the wall cannot
    // name one question while the column beside it names another, and cannot disagree about which
    // one came first.
    const both = noisy();

    const main = render(<App event={both} loadTask={NO_DETAIL} />);
    const queued = screen
      .getAllByTestId('attention-item')
      .filter((item) => item.dataset.kind === 'blocking-gate')
      .map((item) => item.textContent ?? '');
    main.unmount();

    render(<Kiosk event={both} />);
    const gate = within(tile('run_blocked')).getByTestId('kiosk-tile-gate');

    expect(queued[0]).toContain('Tag v1.0 and publish?');
    expect(queued[0]).toContain('asked 20m ago — blocking');
    // The same question, and the same age: both measure `createdAt` against the same wall clock.
    expect(gate).toHaveTextContent('Tag v1.0 and publish?');
    expect(gate).toHaveTextContent('blocked for 20m');
  });

  it('says the same sentence about a run’s workers as the rail row does', () => {
    const both = noisy();

    const main = render(<App event={both} loadTask={NO_DETAIL} />);
    const railRow = screen.getAllByTestId('run-row').find((row) => row.dataset.run === 'run_active')!;
    const fromRail = within(railRow).getByTestId('run-worker-health');
    const railText = fromRail.textContent;
    const railHealth = fromRail.dataset.health;
    main.unmount();

    render(<Kiosk event={both} />);
    const fromWall = within(tile('run_active')).getByTestId('kiosk-tile-workers');

    expect(fromWall.textContent).toBe(railText);
    expect(fromWall.dataset.health).toBe(railHealth);
  });
});
