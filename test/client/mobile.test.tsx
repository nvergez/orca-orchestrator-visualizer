import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.tsx';
import { COPY_ON_HOVER } from '../../src/client/copy.tsx';
import type { TaskLoader } from '../../src/client/inspector/detail.ts';
import { DOCK_CLASS } from '../../src/client/surface.ts';
import type { CastMember, Gate, Meta, Run, StreamEvent, Task, Turn } from '../../src/shared/types.ts';
import { FakeMatchMedia, MOBILE_QUERY } from './fake-match-media.ts';

/**
 * **The folded shell** (`docs/design/mobile.md`) — the same `<App>`, the same three panels, below
 * Tailwind's `lg`: the rail a collapsible band on top, the canvas keeping the middle, the dock a
 * collapsible band at the bottom (SPEC §7.1 re-expressed as a column). Nothing is a new screen
 * and no panel mounts differently — which is exactly what this suite has to prove, because it is
 * the property the other suites cannot see: they run with `matchMedia` absent, where
 * `useIsMobile()` answers desktop, so every one of them goes on testing the signed-off layout.
 *
 * A mobile assertion is therefore an opt-in: `vi.stubGlobal('matchMedia', …)` with the
 * `FakeMatchMedia` (`fake-match-media.ts`), removed again in `afterEach`. And the first test is
 * the inverse — the **desktop guard**: without the stub, none of the fold's chrome exists in the
 * DOM at all, because the bands' toggles, the dock handle and the two chips are rendered on
 * `useIsMobile()` rather than hidden by classes jsdom cannot apply (mobile.md §1).
 *
 * What the tests read is behavior and markup — `aria-expanded`, mount/unmount, `inert`,
 * `data-dimmed`, class-string presence — never computed visibility: jsdom loads no stylesheet,
 * so a `max-lg:` token is a string here and a layout only in a browser (mobile.md §2.3). Canvas
 * nodes are clicked with `fireEvent`, never `user-event` — the d3-drag rule of
 * `conversation.test.tsx` — and everything outside the canvas with `userEvent`, like everywhere
 * else in the suite.
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

/** Selecting a task swaps the dock to the inspector, and the inspector fetches. */
const NO_DETAIL: TaskLoader = async (id) => ({ id, spec: null, result: null, attempts: [] });

const HANDLE = 'term_9f8e7d6c-1234-4321-8888-aabbccddeeff';
const OTHER_HANDLE = 'term_c0ffee00-1234-4321-8888-aabbccddeeff';
const ALICE = 'term_1a2b3c4d-1234-4321-8888-aabbccddeeff';
const BOB = 'term_5e6f7a8b-1234-4321-8888-aabbccddeeff';
const RUN_ID = 'run_9f8e7d6c_1000';
const OTHER_RUN_ID = 'run_c0ffee00_2000';

const TASK_A = 'task_aaaaaaaa';
const TASK_B = 'task_bbbbbbbb';

const A1: CastMember = { handle: ALICE, monogram: 'A1', taskIds: [TASK_A], taskCount: 1, lastHeartbeatAt: null };
const A2: CastMember = { handle: BOB, monogram: 'A2', taskIds: [TASK_B], taskCount: 1, lastHeartbeatAt: null };

function task(over: Partial<Task> = {}): Task {
  return {
    id: TASK_A,
    runId: RUN_ID,
    parentId: null,
    title: 'A task',
    status: 'completed',
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
    endedAt: '2026-07-08T13:00:00.000Z',
    taskCount: 2,
    cast: [A1, A2],
    waves: [],
    statusCounts: { pending: 0, ready: 0, dispatched: 0, completed: 2, failed: 0, blocked: 0 },
    live: false,
    hasOpenGates: false,
    edgeCount: 0,
    ...over,
  };
}

/** The rail has to hold more than one row for a hop to be visible — an older one, never selected. */
function otherRun(over: Partial<Run> = {}): Run {
  return run({
    id: OTHER_RUN_ID,
    handle: OTHER_HANDLE,
    label: 'The other run',
    startedAt: '2026-07-07T12:00:00.000Z',
    endedAt: '2026-07-07T13:00:00.000Z',
    taskCount: 1,
    cast: [],
    ...over,
  });
}

let nextTurn = 1;

function turn(over: Partial<Turn> = {}): Turn {
  return {
    id: over.id ?? `turn_${nextTurn++}`,
    runId: RUN_ID,
    direction: 'in',
    kind: 'status',
    fromHandle: ALICE,
    toHandle: HANDLE,
    at: '2026-07-08T12:30:00.000Z',
    taskId: TASK_A,
    subject: 'A subject',
    body: 'Something was said.',
    source: 'messages · #1',
    ...over,
  };
}

function gate(over: Partial<Gate> = {}): Gate {
  return {
    id: 'msg_gate',
    messageId: 'msg_gate',
    runId: RUN_ID,
    taskId: TASK_A,
    question: 'Which driver: node:sqlite or better-sqlite3?',
    options: ['node:sqlite', 'better-sqlite3'],
    status: 'open',
    resolution: null,
    createdAt: '2026-07-08T12:05:00.000Z',
    ...over,
  };
}

function event(over: Partial<StreamEvent> = {}): StreamEvent {
  return {
    seq: 0,
    meta: META,
    snapshot: {
      runs: [run(), otherRun()],
      tasks: [task(), task({ id: TASK_B, title: 'Another task' })],
      gates: [],
      turns: [],
      coordinatorRuns: [],
    },
    messages: [],
    ...over,
  };
}

/** The default event with a conversation in it, and nothing else changed. */
function withTurns(rows: Turn[]): StreamEvent {
  const base = event();
  return { ...base, snapshot: { ...base.snapshot, turns: rows } };
}

/**
 * The opt-in: a fold-answering `matchMedia`, installed before render, removed by the
 * `afterEach` below. Every other query it is asked — `(hover: hover)`,
 * `(orientation: portrait)`, `(prefers-color-scheme: dark)` — answers `false` until a test says
 * otherwise, which keeps the theme and the hover guard exactly where the desktop suite left them.
 */
function phone(): FakeMatchMedia {
  const media = new FakeMatchMedia();
  media.set(MOBILE_QUERY, true);
  vi.stubGlobal('matchMedia', media.matchMedia);
  return media;
}

const PORTRAIT_QUERY = '(orientation: portrait)';

function conversation(): HTMLElement | null {
  return screen.queryByTestId('conversation');
}

function inspector(): HTMLElement | null {
  return screen.queryByTestId('inspector');
}

function node(id: string): HTMLElement {
  const found = screen.getAllByTestId('task-node').find((element) => element.dataset.task === id);
  if (!found) throw new Error(`no node for ${id} on the canvas`);
  return found;
}

/** See `conversation.test.tsx`: a node is clicked with `fireEvent`, because jsdom is not a browser. */
function clickNode(id: string): void {
  fireEvent.click(node(id));
}

function runRow(id: string): HTMLElement {
  const found = screen.getAllByTestId('run-row').find((element) => element.dataset.run === id);
  if (!found) throw new Error(`no rail row for ${id}`);
  return found;
}

/** The canvas lays out through elkjs, which is async — nothing is on it until that lands. */
async function drawn(count: number): Promise<void> {
  await waitFor(() => expect(screen.getAllByTestId('task-node')).toHaveLength(count));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The whole discipline in one negative: the fold's chrome is *conditionally rendered* on
 * `useIsMobile()`, never class-hidden — so where `matchMedia` does not exist (every other client
 * test), none of it exists either (mobile.md §1, §8 rule 4).
 */
describe('the desktop guard', () => {
  it('renders no fold chrome at all where matchMedia is absent', async () => {
    render(<App event={withTurns([turn()])} loadTask={NO_DETAIL} />);
    await drawn(2);

    expect(screen.queryByTestId('rail-band-toggle')).toBeNull();
    expect(screen.queryByTestId('dock-band-toggle')).toBeNull();
    expect(screen.queryByTestId('rail-agent-chip')).toBeNull();
    expect(screen.queryByTestId('new-turns-chip')).toBeNull();
  });

  it('pins the class strings jsdom cannot see working', () => {
    // The `toHaveClass(...STATUS_THEME…)` idiom of canvas.test.tsx, one level up: jsdom applies
    // no stylesheet, so a `pointer-coarse:` or `max-lg:` token is only checkable as a string —
    // and these two are the tokens the touch and fold layers hang off (mobile.md §4.2, §4.4).
    expect(COPY_ON_HOVER).toContain('pointer-coarse:opacity-100');
    expect(DOCK_CLASS).toContain('max-lg:w-full');
  });
});

describe('the fold', () => {
  it('keeps every panel a singleton — bands clamp, they never duplicate', async () => {
    // The summary row repeats the selected run's *label* by design, so this suite counts by
    // testid, never by text. One conversation, one strip, one canvas; a rail row per run, plus
    // nothing for the band's own header.
    phone();
    render(
      <App
        event={event({
          snapshot: {
            runs: [run({ hasOpenGates: true }), otherRun()],
            tasks: [task({ gate: gate() }), task({ id: TASK_B, title: 'Another task' })],
            gates: [gate()],
            turns: [],
            coordinatorRuns: [],
          },
        })}
        loadTask={NO_DETAIL}
      />
    );
    await drawn(2);

    expect(screen.getAllByTestId('conversation')).toHaveLength(1);
    expect(screen.getAllByTestId('gate-strip')).toHaveLength(1);
    expect(screen.getAllByTestId('canvas')).toHaveLength(1);
    expect(screen.getAllByTestId('run-row')).toHaveLength(2);
  });

  it('adds the band chrome mid-session when the viewport crosses the fold, without remounting a panel', async () => {
    // A window dragged narrow, a tablet rotated: the stub is installed but answers *desktop*
    // first, so the app renders today's layout — then the MQL fires. The fold must arrive as
    // chrome around the same living panels, not as a remount (mobile.md §1: "no panel is
    // mounted differently"). Element identity is the proof: `.toBe`, not a fresh query match.
    const media = new FakeMatchMedia();
    vi.stubGlobal('matchMedia', media.matchMedia);
    render(<App event={event()} loadTask={NO_DETAIL} />);
    await drawn(2);

    expect(screen.queryByTestId('rail-band-toggle')).toBeNull();
    expect(screen.queryByTestId('dock-band-toggle')).toBeNull();
    const before = screen.getByTestId('conversation');

    media.dispatchChange(MOBILE_QUERY, true);

    expect(screen.getByTestId('rail-band-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('dock-band-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('conversation')).toBe(before);
  });

  it('floors what the over-asked column may take: the rail keeps its row, the open dock yields', async () => {
    // jsdom lays out nothing, so this pins the *classes* the real flexbox negotiation runs on.
    // The folded column can be asked for more than a phone has — an open dock band wants 60dvh
    // while the gate strip, the canvas floor and the rail all stand their ground — and without a
    // floor the rail, the one shrinkable child, was the panel flexbox took to zero (found on a
    // real 390px viewport, invisible here). So: the rail band may never fall below its summary
    // row, and the dock band's open height is an ask (`shrink`, floored) — the pressure lands on
    // the largest panel, not the one whose whole folded self is 48px.
    const user = userEvent.setup();
    phone();
    render(<App event={event()} loadTask={NO_DETAIL} />);
    await drawn(2);

    expect(screen.getByRole('navigation', { name: 'Orchestrators' }).className).toContain('max-lg:min-h-12');

    const band = screen.getByTestId('dock-band-toggle').parentElement!;
    expect(band.className).toContain('max-lg:shrink-0');

    await user.click(screen.getByTestId('dock-band-toggle'));

    expect(band.className).toContain('max-lg:min-h-24');
    expect(band.className).toContain('max-lg:shrink');
    expect(band.className).not.toContain('max-lg:shrink-0');
  });
});

describe('the rail band', () => {
  it('folds and unfolds by clamping — the rows stay mounted, and leave the tab order while clipped', async () => {
    const user = userEvent.setup();
    phone();
    render(<App event={event()} loadTask={NO_DETAIL} />);
    await drawn(2);

    // Collapsed is the resting state (mobile.md §3): first sight is the canvas.
    const toggle = screen.getByTestId('rail-band-toggle');
    const body = screen.getByTestId('rail-body');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Folding is a height clamp, never an unmount — scroll position and the layoutId
    // highlights survive — so the clipped rows must leave the tab order and the a11y tree
    // explicitly, or they linger as focusable ghosts under the clamp.
    expect(body).toHaveAttribute('inert');
    expect(body).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getAllByTestId('run-row')).toHaveLength(2);

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(body).not.toHaveAttribute('inert');
    expect(body).not.toHaveAttribute('aria-hidden');
    expect(screen.getAllByTestId('run-row')).toHaveLength(2);

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(body).toHaveAttribute('inert');
    expect(screen.getAllByTestId('run-row')).toHaveLength(2);
  });

  it('folds on the pivot, wears the agent chip, and the chip un-dims the canvas', async () => {
    // The tool's central gesture (SPEC §7.2), folded: tapping an agent means "show me the
    // dimmed canvas and the dialogue", both of which are behind the expanded rail — so the rail
    // folds itself, and the escape from the dimming moves onto the band's summary row, where it
    // stays reachable while the canvas is showing. The dimmed canvas is never a dead zone.
    const user = userEvent.setup();
    phone();
    render(<App event={event()} loadTask={NO_DETAIL} />);
    await drawn(2);

    await user.click(screen.getByTestId('rail-band-toggle'));
    await user.click(screen.getByRole('button', { name: /Agent 1/ }));

    expect(screen.getByTestId('rail-band-toggle')).toHaveAttribute('aria-expanded', 'false');
    // The fold makes `rail-body` inert around the row that was just activated, and a browser
    // blurs focus inside a subtree that goes inert — so the fold has to hand focus somewhere
    // on purpose, or a keyboard pivot drops it to <body> and Tab restarts from the top of the
    // page. It goes to the toggle: the chrome that undoes the fold.
    expect(screen.getByTestId('rail-band-toggle')).toHaveFocus();
    const chip = screen.getByTestId('rail-agent-chip');
    expect(chip).toHaveTextContent('A1');

    // The motion-variant dim is desktop's, untouched — what the fold owns is the way out.
    await waitFor(() => expect(node(TASK_B)).toHaveAttribute('data-dimmed', 'true'));
    expect(node(TASK_A)).toHaveAttribute('data-dimmed', 'false');

    await user.click(chip);

    await waitFor(() => expect(node(TASK_B)).toHaveAttribute('data-dimmed', 'false'));
    expect(screen.queryByTestId('rail-agent-chip')).toBeNull();
  });

  it('says "new orchestration started" in words on the folded summary row, not only in colour', async () => {
    // While the band is folded, the textual chip that announces a new run is inert behind the
    // clamp — the summary row's blue dot is the only surfaced signal, and a dot is aria-hidden
    // colour. The sr-only twin (the `live-dot` pattern) is what keeps the news reachable to a
    // screen reader at the resting state (mobile.md §4.7).
    phone();
    const base = event();
    const { rerender } = render(<App event={base} loadTask={NO_DETAIL} />);
    await drawn(2);

    const toggle = screen.getByTestId('rail-band-toggle');
    expect(within(toggle).queryByText('new orchestration started')).toBeNull();

    // A run appears after the reader started reading: news, never a navigation (SPEC §7.3).
    const fresh = run({
      id: 'run_fresh',
      handle: 'term_00c0ffee-1234-4321-8888-aabbccddeeff',
      label: 'A brand new run',
      startedAt: '2026-07-09T09:00:00.000Z',
      endedAt: '2026-07-09T09:30:00.000Z',
      taskCount: 0,
      cast: [],
    });
    rerender(
      <App
        event={{ ...base, seq: 1, snapshot: { ...base.snapshot, runs: [fresh, run(), otherRun()] } }}
        loadTask={NO_DETAIL}
      />
    );

    const note = within(toggle).getByText('new orchestration started');
    expect(note).toHaveClass('sr-only');
  });
});

describe('the dock band', () => {
  it('opens on a node tap, already swapped to the inspector, and the handle names the task', async () => {
    // The inspector is what a selection *is* on screen (SPEC §7.1) — on the fold it would
    // otherwise arrive behind a collapsed handle. The swap itself is byte-identical to
    // desktop's: conversation unmounts, inspector mounts, one panel at a time.
    phone();
    render(<App event={event()} loadTask={NO_DETAIL} />);
    await drawn(2);

    expect(screen.getByTestId('dock-band-toggle')).toHaveAttribute('aria-expanded', 'false');

    clickNode(TASK_A);

    await waitFor(() => expect(inspector()).not.toBeNull());
    expect(conversation()).toBeNull();

    const toggle = screen.getByTestId('dock-band-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(toggle).getByText('A task')).toBeInTheDocument();
    expect(screen.getByTestId('dock-band-body')).not.toHaveAttribute('inert');
  });

  it('says what the folded dock would show at rest: the conversation, counted without heartbeats', async () => {
    // The handle's count is the panel's own run-scoped exchange count (`exchangeCount`,
    // `conversation/select.ts`): the heartbeats row stands in for hundreds of "alive"s and must
    // not inflate what the orchestrator is said to have said.
    phone();
    render(
      <App
        event={withTurns([
          turn({ id: 'turn_one', body: 'First.' }),
          turn({ id: 'turn_two', body: 'Second.' }),
          turn({ id: `beats:${TASK_A}`, kind: 'heartbeats', beatCount: 12, endedAt: '2026-07-08T13:25:00.000Z' }),
        ])}
        loadTask={NO_DETAIL}
      />
    );
    await drawn(2);

    const toggle = screen.getByTestId('dock-band-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(toggle).getByText('Conversation')).toBeInTheDocument();
    expect(toggle).toHaveTextContent('2 exchanges');

    // …and the folded band's panel is clipped, inert, out of the tab order — like the rail's.
    const body = screen.getByTestId('dock-band-body');
    expect(body).toHaveAttribute('inert');
    expect(body).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('the gate strip on the fold', () => {
  it('interrupts over the canvas while both bands are folded, and a task-less gate unclamps on tap', async () => {
    // The strip keeps its slot whatever the bands do (SPEC §7.4): a blocking question is never
    // foldable. And a task-less gate — the majority on the live database — has no inspector to
    // click through to and a dead `title` tooltip on touch, so the row itself becomes the way
    // to the full question: tap to unclamp, tap to fold it back. Reading, never resolving.
    const user = userEvent.setup();
    phone();
    render(
      <App
        event={event({
          snapshot: {
            runs: [run({ hasOpenGates: true }), otherRun()],
            tasks: [task(), task({ id: TASK_B, title: 'Another task' })],
            gates: [gate({ taskId: null, question: 'A question that runs to several paragraphs on a real database.' })],
            turns: [],
            coordinatorRuns: [],
          },
        })}
        loadTask={NO_DETAIL}
      />
    );
    await drawn(2);

    expect(screen.getByTestId('gate-strip')).toBeInTheDocument();
    expect(screen.getByTestId('rail-band-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('dock-band-toggle')).toHaveAttribute('aria-expanded', 'false');

    const row = screen.getByTestId('gate');
    const expand = row.querySelector('button[aria-expanded]') as HTMLElement;
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(expand.querySelector('b')).toHaveClass('line-clamp-3');

    await user.click(expand);

    expect(expand).toHaveAttribute('aria-expanded', 'true');
    expect(expand.querySelector('b')).not.toHaveClass('line-clamp-3');

    await user.click(expand);

    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(expand.querySelector('b')).toHaveClass('line-clamp-3');
  });
});

describe('the cross-run hop', () => {
  it('moves the rail selection and narrates where the reader came from, until the rail is used again', async () => {
    // The dep-chip flow of inspector.test.tsx, re-run under the fold — plus the one thing the
    // fold owes on top: the rail's moving `aria-current` is behind a collapsed band, so a
    // silent run-hop reads as the canvas replacing itself for no reason. The inspector's
    // `cross-run-note` says it out loud; picking a run yourself retires it (mobile.md §4.6).
    const user = userEvent.setup();
    phone();
    render(
      <App
        event={event({
          snapshot: {
            runs: [run({ taskCount: 1 }), otherRun()],
            tasks: [
              task({ deps: ['task_elsewhere'] }),
              task({ id: 'task_elsewhere', title: 'Over in another run', runId: OTHER_RUN_ID }),
            ],
            gates: [],
            turns: [],
            coordinatorRuns: [],
          },
        })}
        loadTask={NO_DETAIL}
      />
    );
    await drawn(1);

    clickNode(TASK_A);
    await waitFor(() => expect(inspector()).not.toBeNull());

    await user.click(within(inspector()!).getByRole('button', { name: /Over in another run/ }));

    await waitFor(() => expect(node('task_elsewhere')).toHaveAttribute('data-selected', 'true'));
    expect(runRow(OTHER_RUN_ID)).toHaveAttribute('aria-current', 'true');
    expect(runRow(RUN_ID)).toHaveAttribute('aria-current', 'false');
    expect(screen.getByTestId('cross-run-note')).toHaveTextContent('followed here from Ship the visualizer');

    // Picking a run in the rail is standing somewhere on purpose — nothing to narrate.
    await user.click(screen.getByTestId('rail-band-toggle'));
    await user.click(runRow(OTHER_RUN_ID));

    await waitFor(() => expect(conversation()).not.toBeNull());
    expect(screen.queryByTestId('cross-run-note')).toBeNull();
  });

  it('stops narrating the hop when the viewport widens to desktop', async () => {
    // The narration is the folded shell's — on desktop the rail's moving `aria-current` is in
    // plain sight and the note is chrome the byte-identical layout must never wear
    // (mobile.md §4.11, §8 rule 3). The read is guarded like the writes: a hop made on a
    // phone is not still narrating after the window widens into the desktop dock.
    const user = userEvent.setup();
    const media = phone();
    render(
      <App
        event={event({
          snapshot: {
            runs: [run({ taskCount: 1 }), otherRun()],
            tasks: [
              task({ deps: ['task_elsewhere'] }),
              task({ id: 'task_elsewhere', title: 'Over in another run', runId: OTHER_RUN_ID }),
            ],
            gates: [],
            turns: [],
            coordinatorRuns: [],
          },
        })}
        loadTask={NO_DETAIL}
      />
    );
    await drawn(1);

    clickNode(TASK_A);
    await waitFor(() => expect(inspector()).not.toBeNull());
    await user.click(within(inspector()!).getByRole('button', { name: /Over in another run/ }));
    await screen.findByTestId('cross-run-note');
    const panel = inspector();

    media.dispatchChange(MOBILE_QUERY, false);

    // Same living inspector — no panel remounts on a viewport flip — but the mobile-only
    // narration is gone from the desktop dock.
    expect(inspector()).toBe(panel);
    expect(screen.queryByTestId('cross-run-note')).toBeNull();
  });
});

describe('the conversation on the fold', () => {
  it('announces exchanges that land below the reader, scrolls down on tap, and stays quiet at the bottom', async () => {
    // The no-auto-scroll rule (SPEC §7.3) kept, and its gap closed: on desktop the scrollbar is
    // the tell that more arrived; a phone has none, so the fact gets said in the new-run chip's
    // grammar — news you may tap, never a navigation performed for you. jsdom has no scroll
    // geometry at all, so it is stubbed onto the real viewport element the panel reads.
    const user = userEvent.setup();
    phone();
    const { rerender } = render(
      <App event={withTurns([turn({ id: 'turn_one', body: 'First.' })])} loadTask={NO_DETAIL} />
    );
    await screen.findByTestId('conversation');

    const viewport = screen
      .getByTestId('conversation')
      .querySelector('[data-slot="scroll-area-viewport"]') as HTMLDivElement;
    let scrollTop = 0;
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (top: number) => {
        scrollTop = top;
      },
    });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 200 });
    const scrollTo = vi.fn();
    (viewport as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;

    // A turn lands while the reader sits 800px above the bottom: news, announced.
    rerender(
      <App
        event={withTurns([turn({ id: 'turn_one', body: 'First.' }), turn({ id: 'turn_two', body: 'Second.' })])}
        loadTask={NO_DETAIL}
      />
    );

    const chip = await screen.findByTestId('new-turns-chip');
    await user.click(chip);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });

    // Scrolling back within 48px of the bottom retires the chip…
    scrollTop = 800;
    fireEvent.scroll(viewport);
    expect(screen.queryByTestId('new-turns-chip')).toBeNull();

    // …and a turn landing while the reader is already at the bottom never raises it: the new
    // turn is in view, and a chip pointing at it would be noise.
    rerender(
      <App
        event={withTurns([
          turn({ id: 'turn_one', body: 'First.' }),
          turn({ id: 'turn_two', body: 'Second.' }),
          turn({ id: 'turn_three', body: 'Third.' }),
        ])}
        loadTask={NO_DETAIL}
      />
    );
    expect(screen.queryByTestId('new-turns-chip')).toBeNull();
  });

  it('never raises the chip for the reader’s own re-scope — a filter is not an arrival', async () => {
    // Flipping "All" re-derives the list from the same turns: the last shown id moves, but
    // nothing landed. The chip is arrival news in the new-run chip's grammar (mobile.md §4.10),
    // and announcing the reader's own tap back at them would make it furniture — so a move
    // that changed the scope retires the chip instead of raising it.
    const user = userEvent.setup();
    phone();
    render(
      <App
        event={withTurns([
          turn({ id: 'turn_here', body: 'Said in this run.' }),
          turn({ id: 'turn_elsewhere', runId: OTHER_RUN_ID, taskId: null, at: '2026-07-08T14:00:00.000Z' }),
        ])}
        loadTask={NO_DETAIL}
      />
    );
    await screen.findByTestId('conversation');

    // The reader parks 800px above the bottom of a long thread…
    const viewport = screen
      .getByTestId('conversation')
      .querySelector('[data-slot="scroll-area-viewport"]') as HTMLDivElement;
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => 0, set: () => {} });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 200 });

    // …and re-scopes. The global log ends on another run's turn, so the last shown id changes
    // in both directions — and neither direction is news.
    await user.click(screen.getByTestId('dock-band-toggle'));
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.queryByTestId('new-turns-chip')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'This orchestrator' }));
    expect(screen.queryByTestId('new-turns-chip')).toBeNull();
  });

  it('lands the chip’s tap without the glide for a reader who asked for stillness', async () => {
    // The CSS reduced-motion rule cannot flatten an explicit `behavior: 'smooth'` — CSSOM
    // consults the `scroll-behavior` property only when the call says `auto` — so the handler
    // asks the media query itself. Same landing, no ride.
    const user = userEvent.setup();
    const media = phone();
    media.set('(prefers-reduced-motion: reduce)', true);
    const { rerender } = render(
      <App event={withTurns([turn({ id: 'turn_one', body: 'First.' })])} loadTask={NO_DETAIL} />
    );
    await screen.findByTestId('conversation');

    const viewport = screen
      .getByTestId('conversation')
      .querySelector('[data-slot="scroll-area-viewport"]') as HTMLDivElement;
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => 0, set: () => {} });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 200 });
    const scrollTo = vi.fn();
    (viewport as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;

    rerender(
      <App
        event={withTurns([turn({ id: 'turn_one', body: 'First.' }), turn({ id: 'turn_two', body: 'Second.' })])}
        loadTask={NO_DETAIL}
      />
    );

    await user.click(await screen.findByTestId('new-turns-chip'));
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' });
  });
});

describe('the canvas on the fold', () => {
  it('wires a rotation listener, and holds still while a task is selected', async () => {
    // The fitView math is React Flow's, not ours to test — what is ours is the wiring
    // (`Refit`, `canvas/Canvas.tsx`): the folded canvas listens for the orientation flip, and
    // stands down while a task is selected, because a selection is centred and a fit that
    // zoomed away from it would trade the reader's place for a tidier frame.
    const media = phone();
    render(<App event={event()} loadTask={NO_DETAIL} />);
    await drawn(2);

    expect(media.listenerCount(PORTRAIT_QUERY)).toBeGreaterThan(0);

    clickNode(TASK_A);
    await waitFor(() => expect(inspector()).not.toBeNull());

    // Still wired (the effect re-subscribes around the selection), and the flip lands without
    // incident — the guard swallows it rather than re-framing away from the centred node.
    expect(media.listenerCount(PORTRAIT_QUERY)).toBeGreaterThan(0);
    expect(() => media.dispatchChange(PORTRAIT_QUERY, true)).not.toThrow();
    expect(node(TASK_A)).toHaveAttribute('data-selected', 'true');
  });

  it('holds the selection through a push tick landing while the deferred centring is in flight', async () => {
    // On the fold, the centre is deferred two frames so React Flow's ResizeObserver has
    // reported the band-shrunken canvas before `setCenter` does its arithmetic
    // (mobile.md §4.9). The arithmetic itself is React Flow's, not ours to assert — what is
    // ours is that a push rebuilding the nodes inside that gap cancels and reschedules rather
    // than dropping the claim: the selection, the ring and the inspector all survive.
    phone();
    const { rerender } = render(<App event={event()} loadTask={NO_DETAIL} />);
    await drawn(2);

    clickNode(TASK_A);
    await waitFor(() => expect(inspector()).not.toBeNull());

    // The very next push, before two frames have passed.
    rerender(<App event={{ ...event(), seq: 1 }} loadTask={NO_DETAIL} />);
    await drawn(2);

    // Two frames and change: the rescheduled centring has run against the fresh nodes.
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));

    expect(node(TASK_A)).toHaveAttribute('data-selected', 'true');
    expect(inspector()).not.toBeNull();
  });
});
