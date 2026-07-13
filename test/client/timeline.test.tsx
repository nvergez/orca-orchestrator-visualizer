import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveTimeline, UNASSIGNED_LANE } from '../../src/client/timeline/derive.ts';
import type {
  CastMember,
  Dispatch,
  DurationObservation,
  Gate,
  Meta,
  Run,
  RunSnapshot,
  Task,
  Turn,
} from '../../src/shared/types.ts';
import { CannedApp, type CannedEvent } from './canned.tsx';

/**
 * The dispatch timeline (#72) — the selected run's centre, read along the clock instead of along
 * the dependency edges.
 *
 * The feature is a **derivation over the selected-run snapshot and nothing else**, which is not an
 * accident of convenience: ADR 0004 made that snapshot complete — every task, **every attempt**,
 * every gate and the whole conversation, never windowed and never truncated — and SPEC §14.4 says
 * every retained attempt is its own bar *because* of it. So the server needed nothing new, and the
 * two halves of this suite say so from both sides: the pure block below drives `deriveTimeline`
 * value by value (a dense error surface, SPEC §14.5), and `test/server/timeline.test.ts` proves
 * over real HTTP that the evidence it reads actually survives the wire.
 *
 * What the timeline may never do is the thing the whole roadmap is against: **it synthesizes no
 * instant Orca did not write down.** `pending → ready` was never timestamped (SPEC §4.2, trap 6),
 * so it is not on here. A bar that cannot be placed costs its task a *position*, never its
 * existence — the untimed list is where it goes, and it still opens.
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

/** The orchestrator, and the two agents it spawned. */
const BOSS = 'term_9f8e7d6c-1234-4321-8888-aabbccddeeff';
const FIRST = 'term_1a2b3c4d-1234-4321-8888-aabbccddeeff';
const SECOND = 'term_5e6f7a8b-1234-4321-8888-aabbccddeeff';
const RUN_ID = `run_${BOSS}`;

const CAST: CastMember[] = [
  { handle: FIRST, monogram: 'A1', taskIds: [], taskCount: 1, lastHeartbeatAt: null },
  { handle: SECOND, monogram: 'A2', taskIds: [], taskCount: 1, lastHeartbeatAt: null },
];

/** `2026-07-08T12:00:00Z` + n minutes — every instant in this suite is minutes off one noon. */
function at(minutes: number): string {
  return new Date(Date.UTC(2026, 6, 8, 12, 0, 0) + minutes * 60_000).toISOString();
}

function dispatchClock(fromMinutes: number, toMinutes?: number): DurationObservation {
  return toMinutes === undefined
    ? { clock: 'dispatch', startAt: at(fromMinutes), complete: false }
    : {
        clock: 'dispatch',
        startAt: at(fromMinutes),
        endAt: at(toMinutes),
        complete: true,
        ms: (toMinutes - fromMinutes) * 60_000,
      };
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    handle: BOSS,
    label: 'Ship the timeline',
    startedAt: at(0),
    // Required since #81's run-health model. This run is finished at minute 90, so that is the
    // last thing it ever did — the timeline reads neither field, but a run whose last activity
    // preceded its own end would be a fixture telling a small lie.
    lastActivityAt: at(90),
    // Also #81's. `endedAt` is now a deprecated alias of `lastActivityAt`, and this base run is
    // finished — one task, completed — so it has converged.
    converged: true,
    endedAt: at(90),
    taskCount: 1,
    cast: CAST,
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
    id: 'task_alpha',
    runId: RUN_ID,
    parentId: null,
    title: 'Chart the map',
    status: 'completed',
    deps: [],
    createdAt: at(0),
    completedAt: at(30),
    hasSpec: true,
    hasResult: true,
    dispatch: null,
    attemptCount: 1,
    gate: null,
    ...over,
  };
}

/**
 * One retained attempt, whose row and whose clock **cannot disagree** — the server derives the
 * observation from the two columns (`server/durations.ts`), so a fixture that let them drift would
 * be testing a wire this build never writes.
 *
 * `to` omitted is an attempt still out: dispatched, no completion, an open clock.
 */
function attemptAt(id: string, handle: string, from: number, to?: number, over: Partial<Dispatch> = {}): Dispatch {
  return {
    id,
    assigneeHandle: handle,
    status: to === undefined ? 'dispatched' : 'completed',
    failureCount: 0,
    lastFailure: null,
    dispatchedAt: at(from),
    completedAt: to === undefined ? null : at(to),
    lastHeartbeatAt: null,
    duration: dispatchClock(from, to),
    ...over,
  };
}

/** The plain case this suite leans on: A1, dispatched at +5, back at +30. */
function attempt(over: Partial<Dispatch> = {}): Dispatch {
  return { ...attemptAt('ctx_one', FIRST, 5, 30), ...over };
}

function turn(over: Partial<Turn> = {}): Turn {
  return {
    id: 'msg:1',
    runId: RUN_ID,
    direction: 'in',
    kind: 'status',
    fromHandle: FIRST,
    toHandle: BOSS,
    at: at(10),
    taskId: 'task_alpha',
    subject: 'working',
    body: '',
    source: 'messages',
    ...over,
  };
}

function gate(over: Partial<Gate> = {}): Gate {
  return {
    id: 'msg_gate',
    messageId: 'msg_gate',
    runId: RUN_ID,
    taskId: 'task_alpha',
    question: 'Ship it?',
    options: ['yes', 'no'],
    status: 'pending',
    blocking: true,
    resolution: null,
    createdAt: at(20),
    ...over,
  };
}

function snapshotOf(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    meta: META,
    run: run(),
    tasks: [task()],
    attempts: { task_alpha: [attempt()] },
    gates: [],
    turns: [],
    linkedTasks: [],
    coordinatorRuns: [],
    ...over,
  };
}

/**
 * The pure half. Every rule the timeline has is a rule about **what the retained rows do and do
 * not say**, so each one is a value going in and a value coming out.
 */
describe('the lanes: who held the work', () => {
  it('gives every cast member a lane, in the cast’s own order', () => {
    const { lanes } = deriveTimeline(snapshotOf());

    // A1, A2 — the server's monograms, not a second numbering (SPEC §4.3a). An agent with
    // nothing placeable still gets its lane: the cast is the run's, not the axis's.
    expect(lanes.filter((lane) => lane.kind === 'agent').map((lane) => lane.label)).toEqual(['A1', 'A2']);
    expect(lanes[0]).toMatchObject({ key: FIRST, monogram: 'A1' });
  });

  it('names a lane for the work no agent was spawned for, and puts the orchestrator’s own there', () => {
    // The orchestrator is never in its own cast (SPEC §4.3a), so a task it dispatched to *itself*
    // has no agent lane to land in — and neither has an attempt whose assignee the row never named.
    const snapshot = snapshotOf({
      tasks: [task({ id: 'task_self' }), task({ id: 'task_nobody' })],
      attempts: {
        task_self: [attemptAt('ctx_self', BOSS, 5, 30)],
        task_nobody: [attemptAt('ctx_nobody', '', 5, 30)],
      },
    });

    const lane = deriveTimeline(snapshot).lanes.find((candidate) => candidate.key === UNASSIGNED_LANE);

    expect(lane?.kind).toBe('unassigned');
    expect(lane?.bars.map((bar) => bar.id)).toEqual(['ctx_self', 'ctx_nobody']);
  });

  it('does not stand an empty unassigned lane up as furniture', () => {
    // Every attempt in this run belongs to an agent. A lane for nobody, holding nothing, would be
    // a row on screen asserting a distinction this run does not have.
    const lanes = deriveTimeline(snapshotOf()).lanes;

    expect(lanes.some((lane) => lane.kind === 'unassigned')).toBe(false);
  });

  it('packs by what is drawn, not by what elapsed — a minimum-width bar still needs its own row', () => {
    // The trap: these two do not overlap by a single millisecond of *retained evidence* — the first
    // has no end at all, and the second starts a minute later. But an `unended` bar has zero width
    // by construction and is floored to 52px on screen, so packing on the instants alone would put
    // them in one row and draw the hatched stub straight over its neighbour (issue #72 AC 3).
    const snapshot = snapshotOf({
      tasks: [task({ id: 'task_a' }), task({ id: 'task_b' })],
      attempts: {
        task_a: [attemptAt('ctx_a', FIRST, 5, undefined, { status: 'failed', duration: undefined })],
        task_b: [attemptAt('ctx_b', FIRST, 6, 60)],
      },
    });

    const lane = deriveTimeline(snapshot).lanes[0]!;

    expect(lane.bars.map((bar) => bar.row)).toEqual([0, 1]);
    expect(lane.rows).toBe(2);
  });

  it('packs attempts that overlap inside one lane onto their own sub-rows', () => {
    // One agent can hold two tasks at once. Two bars drawn over each other is one bar you can read
    // and one you cannot — so the lane grows a row rather than hiding the work.
    const snapshot = snapshotOf({
      tasks: [task({ id: 'task_a' }), task({ id: 'task_b' })],
      attempts: {
        task_a: [attemptAt('ctx_a', FIRST, 5, 40)],
        task_b: [attemptAt('ctx_b', FIRST, 10, 50)],
      },
    });

    const lane = deriveTimeline(snapshot).lanes[0]!;

    expect(lane.rows).toBe(2);
    expect(lane.bars.map((bar) => bar.row)).toEqual([0, 1]);
  });
});

describe('the bars: one per retained attempt', () => {
  it('draws every attempt of a retried task, in the lane of the agent that actually held it', () => {
    // A retry goes to a FRESH worktree with a FRESH handle (SPEC §4.3a). A timeline built from the
    // surviving attempt alone silently deletes the agent that failed — which is exactly the one a
    // post-mortem came for.
    const snapshot = snapshotOf({
      tasks: [task({ attemptCount: 2, status: 'completed' })],
      attempts: {
        task_alpha: [
          attemptAt('ctx_first', FIRST, 5, 12, { status: 'failed' }),
          attemptAt('ctx_second', SECOND, 20, 45),
        ],
      },
    });

    const { lanes } = deriveTimeline(snapshot);

    expect(lanes[0]!.bars).toHaveLength(1);
    expect(lanes[0]!.bars[0]).toMatchObject({ id: 'ctx_first', attemptIndex: 1, attemptCount: 2 });
    expect(lanes[1]!.bars[0]).toMatchObject({ id: 'ctx_second', attemptIndex: 2, attemptCount: 2 });
  });

  it('paints a bar with its own attempt’s status — never with how the task turned out', () => {
    // The retry is the story the bars exist to tell, and this is where a timeline quietly loses it:
    // the task *completed*, so a fill taken from the task would draw the attempt that FAILED in
    // green — hiding the failure in the very view built to show it.
    const snapshot = snapshotOf({
      tasks: [task({ status: 'completed', attemptCount: 2 })],
      attempts: {
        task_alpha: [
          attemptAt('ctx_first', FIRST, 5, 12, { status: 'failed' }),
          attemptAt('ctx_second', SECOND, 20, 45, { status: 'completed' }),
        ],
      },
    });

    const { lanes } = deriveTimeline(snapshot);

    expect(lanes[0]!.bars[0]!.status).toBe('failed');
    expect(lanes[1]!.bars[0]!.status).toBe('completed');
  });

  it('relates one task’s attempts to each other, across the lanes they were dispatched into', () => {
    const snapshot = snapshotOf({
      tasks: [task({ attemptCount: 2 })],
      attempts: {
        task_alpha: [
          attemptAt('ctx_first', FIRST, 5, 12, { status: 'failed' }),
          attemptAt('ctx_second', SECOND, 20, 45),
        ],
      },
    });

    const { links } = deriveTimeline(snapshot);

    // The link is anchored on two instants the schema really retains — an end it knows, and the
    // next dispatch — never on an end it had to invent.
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ taskId: 'task_alpha', fromAt: at(12), toAt: at(20) });
  });

  it('anchors the link on the earlier attempt’s start when its end was never recorded', () => {
    const snapshot = snapshotOf({
      tasks: [task({ attemptCount: 2 })],
      attempts: {
        task_alpha: [
          // Failed, and the row never says when. There is no end here to draw a line from.
          attemptAt('ctx_first', FIRST, 5, undefined, { status: 'failed', duration: undefined }),
          attemptAt('ctx_second', SECOND, 20, 45),
        ],
      },
    });

    const { links } = deriveTimeline(snapshot);

    expect(links[0]).toMatchObject({ fromAt: at(5), toAt: at(20) });
  });

  it('runs a still-dispatched attempt open-ended, so the bar can say “so far”', () => {
    const snapshot = snapshotOf({
      tasks: [task({ status: 'dispatched', completedAt: null })],
      attempts: { task_alpha: [attemptAt('ctx_one', FIRST, 5)] },
    });

    const bar = deriveTimeline(snapshot).lanes[0]!.bars[0]!;

    expect(bar.extent).toEqual({ kind: 'open', startAt: at(5) });
    expect(bar.duration).toMatchObject({ complete: false });
  });

  it('refuses “so far” for an attempt that stopped without saying when — and still draws it', () => {
    // The two ACs only meet here. "Every retained attempt is a separate bar" says do not drop it;
    // #66 says a clock that ticks for a worker who went home is a lie. So the bar is placed on the
    // one instant the row does retain — its dispatch — and claims **no end at all**.
    const snapshot = snapshotOf({
      attempts: {
        task_alpha: [attemptAt('ctx_one', FIRST, 5, undefined, { status: 'failed', duration: undefined })],
      },
    });

    const bar = deriveTimeline(snapshot).lanes[0]!.bars[0]!;

    expect(bar.extent).toEqual({ kind: 'unended', startAt: at(5) });
    expect(bar.duration).toBeUndefined();
  });

  it('places two agents’ overlapping attempts in two lanes, both at their own instants', () => {
    const snapshot = snapshotOf({
      tasks: [task({ id: 'task_a' }), task({ id: 'task_b' })],
      attempts: {
        task_a: [attemptAt('ctx_a', FIRST, 5, 40)],
        task_b: [attemptAt('ctx_b', SECOND, 10, 35)],
      },
    });

    const { lanes } = deriveTimeline(snapshot);

    expect(lanes[0]!.bars[0]!.extent).toMatchObject({ kind: 'closed', startAt: at(5), endAt: at(40) });
    expect(lanes[1]!.bars[0]!.extent).toMatchObject({ kind: 'closed', startAt: at(10), endAt: at(35) });
    // Concurrency is the thing the DAG cannot show, and it is legible here as two bars that
    // genuinely overlap on one axis — not as two lanes that happen to have something in them.
    expect(lanes[0]!.rows).toBe(1);
    expect(lanes[1]!.rows).toBe(1);
  });
});

describe('the untimed: what an axis cannot hold, a list still can', () => {
  it('keeps a never-dispatched task reachable, and says that is why', () => {
    const snapshot = snapshotOf({
      tasks: [task({ id: 'task_waiting', status: 'pending', completedAt: null })],
      attempts: {},
    });

    const { lanes, untimed } = deriveTimeline(snapshot);

    expect(untimed).toEqual([{ task: expect.objectContaining({ id: 'task_waiting' }), reason: 'never dispatched' }]);
    expect(lanes.flatMap((lane) => lane.bars)).toHaveLength(0);
  });

  it('untimes a task whose only dispatch instant is unreadable — never at the epoch', () => {
    // `isoInstant` passes an unparseable column through verbatim so the row survives (`time.ts`).
    // Placing it would mean reading that string as a number, and the only number available is 0 —
    // a 1970 bar at the far left of every run, which is the ghost this whole roadmap refuses.
    const snapshot = snapshotOf({
      attempts: {
        task_alpha: [attemptAt('ctx_one', FIRST, 5, undefined, { dispatchedAt: 'whenever', duration: undefined })],
      },
    });

    const { lanes, untimed } = deriveTimeline(snapshot);

    expect(untimed).toEqual([
      { task: expect.objectContaining({ id: 'task_alpha' }), reason: 'no readable dispatch instant' },
    ]);
    expect(lanes.flatMap((lane) => lane.bars)).toHaveLength(0);
  });

  it('counts the attempts it could not place even when the task itself is on the axis', () => {
    // The task is placed — its second attempt is fine — so it is not untimed. But its first attempt
    // is nowhere, and a retry that vanished without a word is the silent loss this feature exists
    // to prevent. It is counted, and the count is said out loud.
    const snapshot = snapshotOf({
      tasks: [task({ attemptCount: 2 })],
      attempts: {
        task_alpha: [
          attemptAt('ctx_first', FIRST, 5, 30, { dispatchedAt: '', duration: undefined }),
          attemptAt('ctx_second', FIRST, 20, 45),
        ],
      },
    });

    const { untimed, unplacedAttempts } = deriveTimeline(snapshot);

    expect(untimed).toHaveLength(0);
    expect(unplacedAttempts).toBe(1);
  });

  it('does not also count the attempts of a task it already listed as untimed', () => {
    // The footnote's whole job is to name a loss nothing else names. A task whose *every* attempt is
    // unreadable is already named — in the untimed list, by title — so counting its attempts again
    // would report one absence twice, and the sentence ("attempts of tasks drawn above") would be
    // false about a task that is not drawn at all.
    const snapshot = snapshotOf({
      attempts: {
        task_alpha: [
          attemptAt('ctx_first', FIRST, 5, 30, { dispatchedAt: '', duration: undefined }),
          attemptAt('ctx_second', FIRST, 20, 45, { dispatchedAt: 'whenever', duration: undefined }),
        ],
      },
    });

    const { untimed, unplacedAttempts } = deriveTimeline(snapshot);

    expect(untimed).toEqual([
      { task: expect.objectContaining({ id: 'task_alpha' }), reason: 'no readable dispatch instant' },
    ]);
    expect(unplacedAttempts).toBe(0);
  });
});

describe('the markers: recorded instants, and not one more', () => {
  it('marks a gate, an escalation and a completion where the rows say they happened', () => {
    const snapshot = snapshotOf({
      gates: [gate({ createdAt: at(20) })],
      turns: [turn({ id: 'msg:9', kind: 'escalation', at: at(25), subject: 'Blocked: no credits' })],
    });

    const markers = deriveTimeline(snapshot).lanes.flatMap((lane) => lane.markers);

    expect(markers.map((marker) => [marker.kind, marker.at])).toEqual([
      ['gate', at(20)],
      ['escalation', at(25)],
      // `tasks.completed_at` — the instant the task was *recorded* complete, which is a different
      // column, written by a different writer, than the attempt's own end (SPEC §4.2, trap 5).
      ['completion', at(30)],
    ]);
  });

  it('synthesizes no transition the database never timestamped', () => {
    // Six writers mutate `tasks.status` in place and none of them records when (SPEC §4.2, trap 6).
    // A `ready` task therefore has exactly one instant on this axis — its creation is not a
    // dispatch — and a timeline that drew "became ready here" would be inventing the evidence.
    const snapshot = snapshotOf({
      tasks: [task({ status: 'ready', completedAt: null })],
      attempts: { task_alpha: [attemptAt('ctx_one', FIRST, 5)] },
    });

    const markers = deriveTimeline(snapshot).lanes.flatMap((lane) => lane.markers);

    expect(markers).toHaveLength(0);
  });

  it('drops a marker whose instant cannot be read, rather than dating it 1970', () => {
    const snapshot = snapshotOf({
      tasks: [task({ completedAt: 'sometime' })],
      gates: [gate({ createdAt: '' })],
      turns: [turn({ kind: 'escalation', at: '' })],
    });

    const markers = deriveTimeline(snapshot).lanes.flatMap((lane) => lane.markers);

    expect(markers).toHaveLength(0);
  });

  it('keeps another orchestrator’s turns out of this run’s lanes', () => {
    // A selected-run snapshot carries the turns nothing places (SPEC §4.4, rule 3) so they stay
    // reachable. They belong to nobody — so they are nobody's lane, and an escalation the server
    // refused to attribute must not be quietly attributed here.
    const snapshot = snapshotOf({
      turns: [turn({ id: 'msg:44', runId: null, kind: 'escalation', at: at(25), taskId: null })],
    });

    const markers = deriveTimeline(snapshot).lanes.flatMap((lane) => lane.markers);

    expect(markers.filter((marker) => marker.kind === 'escalation')).toHaveLength(0);
  });

  it('lands a gate that names no task in the lane for work no agent holds', () => {
    // 32 of the 53 live gates name no task (SPEC §7.9). Nothing in the schema says whose work it
    // was — so it goes where the run's own unowned evidence goes, and not into an agent's lane on
    // a guess.
    const snapshot = snapshotOf({ gates: [gate({ taskId: null, createdAt: at(20) })] });

    const lane = deriveTimeline(snapshot).lanes.find((candidate) => candidate.key === UNASSIGNED_LANE);

    expect(lane?.markers.map((marker) => marker.kind)).toEqual(['gate']);
  });
});

describe('the window: what the axis is allowed to span', () => {
  it('spans the retained instants, and never reaches for the wall clock', () => {
    const snapshot = snapshotOf({
      tasks: [task({ completedAt: at(30) })],
      gates: [gate({ createdAt: at(70) })],
    });

    const { window } = deriveTimeline(snapshot);

    expect(window).toEqual({ startAt: Date.parse(at(5)), endAt: Date.parse(at(70)) });
  });

  it('has no window at all when nothing in the run can be placed', () => {
    const { window, lanes } = deriveTimeline(snapshotOf({ attempts: {}, tasks: [task({ completedAt: null })] }));

    expect(window).toBeNull();
    expect(lanes.flatMap((lane) => lane.bars)).toHaveLength(0);
  });
});

/**
 * The rendered half — `<CannedApp>` fed the same canned world every presentation suite is
 * (`canned.tsx`), because the timeline is a *view* of the selected run and it must be reachable
 * exactly the way a reader reaches it: by pressing the toggle above the canvas.
 */

const TIMELINE_EVENT: CannedEvent = {
  seq: 0,
  affected: { all: true, runIds: [], unplaced: false },
  meta: META,
  snapshot: {
    runs: [run({ taskCount: 3 })],
    tasks: [
      task({ id: 'task_alpha', title: 'Chart the map', attemptCount: 2 }),
      task({ id: 'task_beta', title: 'Draw the canvas', status: 'dispatched', completedAt: null }),
      task({ id: 'task_ghost', title: 'Never dispatched', status: 'pending', completedAt: null }),
      task({ id: 'task_broken', title: 'Probe the replica', status: 'failed', completedAt: null }),
    ],
    gates: [gate({ createdAt: at(20) })],
    turns: [turn({ id: 'msg:9', kind: 'escalation', at: at(25), subject: 'Blocked: out of credits' })],
    coordinatorRuns: [],
  },
  messages: [],
};

const TIMELINE_ATTEMPTS: Record<string, Dispatch[]> = {
  task_alpha: [
    attemptAt('ctx_first', FIRST, 5, 12, { status: 'failed' }),
    attemptAt('ctx_second', SECOND, 20, 45),
  ],
  // Still out, and the reader's own clock is what ages it.
  task_beta: [attemptAt('ctx_beta', SECOND, 10)],
  // Failed, and the row never recorded when. It has a beginning and no end anybody wrote down.
  task_broken: [attemptAt('ctx_broken', FIRST, 15, undefined, { status: 'failed', duration: undefined })],
};

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The centre's two views, and the button that swaps them.
 *
 * Synchronous, and that is the canned loaders' doing (`canned.tsx`): they answer in place, so the
 * shell is settled by the time `render` returns and a click on the tab is a re-render, not a fetch.
 * It matters here beyond tidiness — one of these tests runs on a fake clock, and a `waitFor` polling
 * a clock the test has frozen waits forever.
 */
function showTimeline(): HTMLElement {
  fireEvent.click(screen.getByRole('tab', { name: /timeline/i }));
  return screen.getByTestId('timeline');
}

function bar(id: string): HTMLElement {
  const found = screen.getAllByTestId('timeline-bar').find((element) => element.dataset.attempt === id);
  if (!found) throw new Error(`no bar for attempt ${id}`);
  return found;
}

/** The cast's rows, as the rail suite queries them — `A1` reads "Agent 1" on screen. */
function agentRow(index: number): HTMLElement {
  return screen.getAllByTestId('agent-row')[index]!;
}

/** The inspector names the task it is describing, and that is the assertion worth making. */
function inspectorFor(title: string): void {
  expect(screen.getByTestId('inspector')).toHaveAttribute('aria-label', `Task ${title}`);
}

describe('the centre’s two views', () => {
  it('opens on the DAG, and swaps to the timeline only when asked', async () => {
    render(<CannedApp event={TIMELINE_EVENT} attempts={TIMELINE_ATTEMPTS} />);

    await waitFor(() => expect(screen.queryByTestId('canvas')).not.toBeNull());
    expect(screen.queryByTestId('timeline')).toBeNull();
    expect(screen.getByRole('tab', { name: /dag/i })).toHaveAttribute('aria-selected', 'true');

    showTimeline();

    expect(screen.queryByTestId('canvas')).toBeNull();
    expect(screen.getByRole('tab', { name: /timeline/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('never lights the timeline tab above a DAG — with no run, the timeline says so itself', () => {
    // The toggle's one duty is that the tab and the centre agree. A fallback to the canvas when
    // there is nothing to draw would leave "Timeline" selected above a dependency graph.
    render(<CannedApp event={{ ...TIMELINE_EVENT, snapshot: { ...TIMELINE_EVENT.snapshot, runs: [], tasks: [] } }} />);

    // Not `showTimeline()`: there is no run, so there is no timeline panel to wait for — which is
    // precisely the state under test.
    fireEvent.click(screen.getByRole('tab', { name: /timeline/i }));

    expect(screen.getByRole('tab', { name: /timeline/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('canvas')).toBeNull();
    expect(screen.getByTestId('timeline-no-run')).toBeInTheDocument();
  });

  it('keeps the run, the agent and the task exactly where they were across a toggle', async () => {
    // The toggle is a *view*, and a view that moved the reader's scope would be a navigation
    // pretending to be a lens (issue #72 AC 1).
    render(<CannedApp event={TIMELINE_EVENT} attempts={TIMELINE_ATTEMPTS} />);

    await waitFor(() => expect(screen.getAllByTestId('task-node').length).toBeGreaterThan(0));

    fireEvent.click(agentRow(0));
    const node = screen.getAllByTestId('task-node').find((element) => element.dataset.task === 'task_alpha')!;
    fireEvent.click(node);
    await waitFor(() => expect(screen.queryByTestId('inspector')).not.toBeNull());

    const runRow = screen.getAllByTestId('run-row').find((element) => element.dataset.run === RUN_ID)!;
    expect(runRow).toHaveAttribute('aria-current', 'true');

    showTimeline();

    // All three survive: the same run is open, the same agent is still the pivot, and the
    // inspector is still describing the same task.
    expect(screen.getAllByTestId('run-row').find((element) => element.dataset.run === RUN_ID)).toHaveAttribute(
      'aria-current',
      'true'
    );
    expect(agentRow(0)).toHaveAttribute('aria-pressed', 'true');
    inspectorFor('Chart the map');

    // …and back again, unchanged. A toggle that only preserved state in one direction would be
    // half a toggle.
    fireEvent.click(screen.getByRole('tab', { name: /dag/i }));
    await waitFor(() => expect(screen.queryByTestId('canvas')).not.toBeNull());
    expect(agentRow(0)).toHaveAttribute('aria-pressed', 'true');
    inspectorFor('Chart the map');
  });
});

describe('the timeline on screen', () => {
  it('lays one lane per agent and draws every attempt as its own bar', async () => {
    render(<CannedApp event={TIMELINE_EVENT} attempts={TIMELINE_ATTEMPTS} />);
    const timeline = showTimeline();

    expect(within(timeline).getAllByTestId('timeline-lane').map((lane) => lane.dataset.lane)).toEqual([FIRST, SECOND]);

    // The retry: two bars, in two lanes, for one task — and each says which attempt it is.
    expect(bar('ctx_first')).toHaveAttribute('data-task', 'task_alpha');
    expect(bar('ctx_second')).toHaveAttribute('data-task', 'task_alpha');
    expect(within(bar('ctx_second')).getByText('2/2')).toBeInTheDocument();

    // …and the line that says they are one task's story, drawn across the lanes it crossed.
    expect(within(timeline).getByTestId('attempt-link')).toHaveAttribute('data-task', 'task_alpha');
  });

  it('draws the failed attempt of a completed task in failure’s colour, not the task’s', () => {
    // The screen half of the retry story: `task_alpha` completed, and its first attempt did not.
    render(<CannedApp event={TIMELINE_EVENT} attempts={TIMELINE_ATTEMPTS} />);
    showTimeline();

    // The six-status palette, keyed by the *attempt's* status (`canvas/theme.ts`).
    expect(bar('ctx_first').className).toContain('status-failed');
    expect(bar('ctx_second').className).toContain('status-completed');
    // …and the word beside the colour, because red is not a sentence.
    expect(bar('ctx_first').getAttribute('aria-label')).toMatch(/attempt 1 of 2 \(failed\)/i);
  });

  it('says “so far” on a bar the evidence never closed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at(40)));

    render(<CannedApp event={TIMELINE_EVENT} attempts={TIMELINE_ATTEMPTS} />);
    showTimeline();

    // Dispatched at +10 and still out; the reader's clock says +40. The *geometry* never reads that
    // clock — the axis is the retained instants (`derive.ts`) — so the only thing aging here is the
    // number, which is exactly the division of labour #66 established.
    expect(within(bar('ctx_beta')).getByTestId('bar-duration')).toHaveTextContent('30m so far');
    expect(bar('ctx_beta')).toHaveAttribute('data-extent', 'open');
  });

  it('draws the attempt that stopped without saying when — and refuses to call it “so far”', () => {
    // The bar exists, because "every retained attempt is a separate bar". It states no duration,
    // because #66 forbids a clock ticking against a worker who has already gone home. Both, at once,
    // is the only honest reading of a row that has a dispatch instant and no completion.
    render(<CannedApp event={TIMELINE_EVENT} attempts={TIMELINE_ATTEMPTS} />);
    showTimeline();

    const stub = bar('ctx_broken');
    expect(stub).toHaveAttribute('data-extent', 'unended');
    expect(within(stub).queryByTestId('bar-duration')).toBeNull();
    expect(stub).not.toHaveTextContent(/so far/);
    // It cannot fit the sentence at 52px, so it must still *say* it — to a screen reader, and on hover.
    expect(stub.getAttribute('aria-label')).toMatch(/never recorded when it stopped/i);
  });

  it('keeps a task it cannot place in a list that still opens it', async () => {
    render(<CannedApp event={TIMELINE_EVENT} attempts={TIMELINE_ATTEMPTS} />);
    const timeline = showTimeline();

    const untimed = within(timeline).getByTestId('untimed');
    expect(untimed).toHaveTextContent(/never dispatched/i);

    const entry = within(untimed)
      .getAllByTestId('untimed-task')
      .find((element) => element.dataset.task === 'task_ghost')!;
    fireEvent.click(entry);

    // The whole point of the list: a missing timestamp costs the task its *placement*, not its
    // story (SPEC §14.4).
    await waitFor(() => expect(screen.queryByTestId('inspector')).not.toBeNull());
    inspectorFor('Never dispatched');
  });

  it('opens the task behind a bar, and behind a marker', async () => {
    render(<CannedApp event={TIMELINE_EVENT} attempts={TIMELINE_ATTEMPTS} />);
    const timeline = showTimeline();

    fireEvent.click(bar('ctx_first'));
    await waitFor(() => expect(screen.queryByTestId('inspector')).not.toBeNull());
    inspectorFor('Chart the map');

    // A marker is evidence about a task too — an escalation names one, and clicking it lands in
    // the same story the bar does (issue #72 AC 6).
    const escalation = within(timeline)
      .getAllByTestId('timeline-marker')
      .find((marker) => marker.dataset.kind === 'escalation')!;
    fireEvent.click(escalation);
    await waitFor(() => expect(screen.queryByTestId('inspector')).not.toBeNull());
    inspectorFor('Chart the map');
  });

  it('dims the lanes that are not the selected agent’s, the way the canvas dims its nodes', async () => {
    render(<CannedApp event={TIMELINE_EVENT} attempts={TIMELINE_ATTEMPTS} />);
    showTimeline();

    fireEvent.click(agentRow(0));

    const lanes = screen.getAllByTestId('timeline-lane');
    expect(lanes.find((lane) => lane.dataset.lane === FIRST)).toHaveAttribute('data-dimmed', 'false');
    expect(lanes.find((lane) => lane.dataset.lane === SECOND)).toHaveAttribute('data-dimmed', 'true');
  });
});
