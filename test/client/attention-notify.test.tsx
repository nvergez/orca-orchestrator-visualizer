import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.tsx';
import { NOTIFY_STORAGE_KEY } from '../../src/client/attention/notify.ts';
import type { TaskLoader } from '../../src/client/inspector/detail.ts';
import { Live } from '../../src/client/Live.tsx';
import type { Gate, Meta, Run, StreamEvent, Task, Turn } from '../../src/shared/types.ts';

/**
 * Seam 2 (#12): the desktop notification (#60) — **one ping, for a cause you have not seen**.
 *
 * Everything here is a promise about *restraint*, because a notifier that cries wolf is
 * uninstalled by the end of the day and a supervisor's tool that pings for four days of retained
 * history is worse than one that never pings at all:
 *
 * - it is **off** until the reader says otherwise, and their word is remembered locally;
 * - permission is asked for **from their click and nowhere else** — never on a snapshot, never
 *   on mount, because a page that demands a permission prompt before it has shown you anything is
 *   the page everyone denies out of reflex;
 * - the queue it **opens on, and reconnects to, is history** — the baseline — so the thirteen runs
 *   sitting in an unpruned database (SPEC §4.2, trap 10) never burst onto the desktop;
 * - a cause notifies **at most once for its stable identity** (#56's ids), whatever the snapshots,
 *   the ranking or the tab's focus do afterwards;
 * - and where it cannot work at all — no API, permission denied, permission revoked while the page
 *   is open — it says so and **degrades to the tab** (`attention-tab.test.tsx`), silently and
 *   without a single thrown error.
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

const CREW_HANDLE = 'term_9f8e7d6c-1234-4321-8888-aabbccddeeff';
const OTHER_HANDLE = 'term_1a2b3c4d-1234-4321-8888-aabbccddeeff';
const AGENT_HANDLE = 'term_agent-aaaa-4321-8888-aabbccddeeff';

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: 'run_crew',
    handle: CREW_HANDLE,
    label: 'Ship the visualizer',
    startedAt: ago(60 * 60_000),
    lastActivityAt: ago(60_000),
    converged: false,
    endedAt: ago(60_000),
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

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task_aaaaaaaa',
    runId: 'run_crew',
    parentId: null,
    title: 'A task',
    status: 'dispatched',
    deps: [],
    createdAt: ago(30 * 60_000),
    completedAt: null,
    hasSpec: true,
    hasResult: false,
    dispatch: null,
    attemptCount: 1,
    gate: null,
    ...over,
  };
}

function gate(over: Partial<Gate> = {}): Gate {
  return {
    id: 'msg_gate',
    messageId: 'msg_gate',
    runId: 'run_crew',
    taskId: 'task_aaaaaaaa',
    question: 'Which driver?',
    options: [],
    status: 'pending',
    blocking: true,
    resolution: null,
    createdAt: ago(20 * 60_000),
    ...over,
  };
}

function escalation(over: Partial<Turn> = {}): Turn {
  return {
    id: 'msg:41',
    runId: 'run_crew',
    direction: 'in',
    kind: 'escalation',
    fromHandle: AGENT_HANDLE,
    toHandle: CREW_HANDLE,
    at: ago(8 * 60_000),
    taskId: 'task_aaaaaaaa',
    subject: 'Blocked: cannot reach the registry',
    body: 'npm install fails behind the proxy.',
    source: 'messages',
    ...over,
  };
}

function event(snapshot: Partial<StreamEvent['snapshot']>, seq = 1): StreamEvent {
  return {
    seq,
    meta: META,
    snapshot: { runs: [run()], tasks: [task()], gates: [], turns: [], coordinatorRuns: [], ...snapshot },
    messages: [],
  };
}

/**
 * The browser's `Notification`, faked — jsdom has none at all, which is itself one of the three
 * degradations this ticket owes an answer to.
 *
 * It records what a real one would have *shown*, what it was asked to *permit*, and it can be told
 * to throw from its constructor: Chrome on Android does exactly that (`Illegal constructor` — the
 * platform requires a service worker), and a notifier that has never met that browser is a
 * notifier that crashes on it.
 */
type FakePermission = 'default' | 'granted' | 'denied';

class FakeNotification {
  static permission: FakePermission = 'default';
  /** What the *prompt* would resolve to when the reader is asked. */
  static answer: FakePermission = 'granted';
  static requests = 0;
  static shown: FakeNotification[] = [];
  static illegalConstructor = false;

  onclick: ((event: Event) => void) | null = null;
  closed = false;
  readonly title: string;
  readonly options: NotificationOptions;

  constructor(title: string, options: NotificationOptions = {}) {
    if (FakeNotification.illegalConstructor) throw new TypeError('Illegal constructor');
    this.title = title;
    this.options = options;
    FakeNotification.shown.push(this);
  }

  static async requestPermission(): Promise<FakePermission> {
    FakeNotification.requests += 1;
    FakeNotification.permission = FakeNotification.answer;
    return FakeNotification.permission;
  }

  close(): void {
    this.closed = true;
  }

  /** The reader clicks the notification on their desktop. */
  activate(): void {
    act(() => {
      this.onclick?.(new Event('click'));
    });
  }
}

/** The browser already granted, and the reader already opted in — the steady state. */
function alreadyOptedIn(): void {
  FakeNotification.permission = 'granted';
  localStorage.setItem(NOTIFY_STORAGE_KEY, 'on');
}

function shown(): FakeNotification[] {
  return FakeNotification.shown;
}

function bell(): HTMLElement {
  return screen.getByTestId('notify-toggle');
}

function row(runId: string): HTMLElement {
  const found = screen.getAllByTestId('run-row').find((element) => element.dataset.run === runId);
  if (!found) throw new Error(`no rail row for ${runId}`);
  return found;
}

beforeEach(() => {
  localStorage.clear();
  FakeNotification.permission = 'default';
  FakeNotification.answer = 'granted';
  FakeNotification.requests = 0;
  FakeNotification.shown = [];
  FakeNotification.illegalConstructor = false;
  vi.stubGlobal('Notification', FakeNotification);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('the desktop notification', () => {
  it('is off until the reader asks for it, and asks the browser for nothing meanwhile', () => {
    // The browser has already granted permission — to a previous session, or to another page on
    // this origin. That is *not* consent to be notified: the opt-in is ours, it is off, and a
    // brand-new cause goes to the queue and the tab and no further.
    FakeNotification.permission = 'granted';

    const view = render(<App loadTask={NO_DETAIL} event={event({}, 1)} />);
    view.rerender(<App loadTask={NO_DETAIL} event={event({ gates: [gate()] }, 2)} />);

    expect(shown()).toHaveLength(0);
    expect(FakeNotification.requests).toBe(0);
    expect(screen.getByTestId('attention-queue')).toBeVisible();
  });

  it('asks for permission from the reader’s click and nowhere else, and remembers the opt-in', async () => {
    const view = render(<App loadTask={NO_DETAIL} event={event({}, 1)} />);

    // Nothing on mount, and nothing on a push: an unprompted permission dialog is the surest way
    // to be denied for ever, and the browser only allows it from a gesture anyway.
    view.rerender(<App loadTask={NO_DETAIL} event={event({ gates: [gate()] }, 2)} />);
    expect(FakeNotification.requests).toBe(0);

    await userEvent.click(bell());

    expect(FakeNotification.requests).toBe(1);
    // Remembered locally, so the choice survives the tab (`theme-mode.ts` remembers the theme the
    // same way, in the same place, for the same reason).
    expect(localStorage.getItem(NOTIFY_STORAGE_KEY)).toBe('on');
    await waitFor(() => expect(bell()).toHaveAttribute('aria-pressed', 'true'));

    // …and the cause that was already in the queue when they opted in is *not* announced: it is
    // the queue they were looking at as they clicked.
    expect(shown()).toHaveLength(0);
  });

  it('takes the queue it opens on as history, however loud it is', () => {
    alreadyOptedIn();

    // Four days of unpruned database (SPEC §4.2, trap 10): a blocking gate, an escalation and a
    // failure, all of them there before the page was. None of them is news, and a notifier that
    // announced them would announce them again at every reload for ever.
    render(
      <App
        loadTask={NO_DETAIL}
        event={event({
          tasks: [task(), task({ id: 'task_wrecked', title: 'Wrecked', status: 'failed', completedAt: ago(60_000) })],
          gates: [gate()],
          turns: [escalation()],
        })}
      />
    );

    expect(screen.getAllByTestId('attention-item')).toHaveLength(3);
    expect(shown()).toHaveLength(0);
  });

  it('announces a cause that arrives after the baseline — once, whatever the snapshots do next', () => {
    alreadyOptedIn();

    const view = render(<App loadTask={NO_DETAIL} event={event({}, 1)} />);
    expect(shown()).toHaveLength(0);

    // The gate opens while the reader is in another tab. This is the one moment the tool has
    // something to say.
    view.rerender(<App loadTask={NO_DETAIL} event={event({ gates: [gate()] }, 2)} />);

    expect(shown()).toHaveLength(1);
    expect(shown()[0]!.title).toBe('Blocking decision gate');
    expect(shown()[0]!.options.body).toContain('Which driver?');
    expect(shown()[0]!.options.body).toContain('Ship the visualizer');
    // The stable identity of the cause (#56) — so the OS itself collapses a repeat rather than
    // stacking one.
    expect(shown()[0]!.options.tag).toBe('gate:msg_gate');

    // The poll re-reads the same rows every five seconds. Same evidence, same identity, and the
    // desktop hears about it exactly once.
    view.rerender(<App loadTask={NO_DETAIL} event={event({ gates: [gate()] }, 3)} />);
    view.rerender(<App loadTask={NO_DETAIL} event={event({ gates: [gate()] }, 4)} />);

    expect(shown()).toHaveLength(1);
  });

  it('says nothing when the ranking shifts, or when the tab is focused and left again', () => {
    alreadyOptedIn();

    const older = escalation({ id: 'msg:41', at: ago(20 * 60_000), subject: 'Older escalation' });
    const newer = escalation({ id: 'msg:42', at: ago(5 * 60_000), subject: 'Newer escalation' });

    const view = render(<App loadTask={NO_DETAIL} event={event({}, 1)} />);
    view.rerender(<App loadTask={NO_DETAIL} event={event({ turns: [older] }, 2)} />);
    view.rerender(<App loadTask={NO_DETAIL} event={event({ turns: [older, newer] }, 3)} />);

    // Two causes, arriving one at a time: two notifications, and the second push announced only
    // the one that was new in it.
    expect(shown()).toHaveLength(2);
    expect(screen.getAllByTestId('attention-item')[0]).toHaveTextContent('Older escalation');

    // The queue re-ranks — the first escalation was re-sent, so the *other* one is now the oldest
    // thing waiting. Two rows swap places; nothing new has entered, and nothing is announced.
    view.rerender(
      <App
        loadTask={NO_DETAIL}
        event={event(
          { turns: [escalation({ id: 'msg:41', at: ago(60_000), subject: 'Older escalation' }), newer] },
          4
        )}
      />
    );
    expect(screen.getAllByTestId('attention-item')[0]).toHaveTextContent('Newer escalation');
    expect(shown()).toHaveLength(2);

    // And the reader comes back to the tab, and leaves again. Focus is not evidence about the
    // database, and this notifier does not listen to it at all — which is the only way to be sure
    // it can never re-announce on it.
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('blur'));
    });
    view.rerender(<App loadTask={NO_DETAIL} event={event({ turns: [older, newer] }, 5)} />);

    expect(shown()).toHaveLength(2);
  });

  it('gathers causes that arrive together into one notification, and goes to the worst of them', async () => {
    // Not hypothetical: a coordinator's several workers cross the ten-minute silence threshold on
    // one wall-clock tick, and a snapshot can carry a gate, an escalation and a failure at once. A
    // notifier that sent one per cause would be a notifier that is turned off after the first bad
    // afternoon — and five notifications are not five pieces of news. They are one: *something has
    // gone wrong over there*. The queue, one click away, is where the ranking is.
    alreadyOptedIn();

    const view = render(<App loadTask={NO_DETAIL} event={event({}, 1)} />);
    view.rerender(
      <App
        loadTask={NO_DETAIL}
        event={event(
          {
            tasks: [task(), task({ id: 'task_wrecked', title: 'Wrecked', status: 'failed', completedAt: ago(60_000) })],
            gates: [gate()],
            turns: [escalation()],
          },
          2
        )}
      />
    );

    expect(screen.getAllByTestId('attention-item')).toHaveLength(3);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]!.title).toBe('3 things need attention');
    // It names the most urgent of them — the top of #56's ranking, which is the blocking gate —
    // and counts the rest rather than reciting them.
    expect(shown()[0]!.options.body).toContain('Which driver?');
    expect(shown()[0]!.options.body).toContain('and 2 more');
    expect(shown()[0]!.options.tag).toBe('gate:msg_gate');

    // …and its click goes where that cause goes, exactly as a single one's would.
    shown()[0]!.activate();
    expect(await screen.findByTestId('inspector')).toHaveTextContent('A task');
  });

  it('never announces one identity twice, even when its evidence comes back', () => {
    alreadyOptedIn();

    const view = render(<App loadTask={NO_DETAIL} event={event({}, 1)} />);
    view.rerender(<App loadTask={NO_DETAIL} event={event({ gates: [gate()] }, 2)} />);
    expect(shown()).toHaveLength(1);

    // Answered: the gate stops blocking and the cause leaves the queue.
    view.rerender(<App loadTask={NO_DETAIL} event={event({ gates: [gate({ blocking: false, status: 'resolved' })] }, 3)} />);
    expect(screen.queryByTestId('attention-queue')).toBeNull();

    // …and the very same question blocks again — the same gate id, the same durable row. "At most
    // one notification per stable identity" is the promise, and a cause that could re-announce by
    // flickering is the promise broken.
    view.rerender(<App loadTask={NO_DETAIL} event={event({ gates: [gate()] }, 4)} />);

    expect(screen.getByTestId('attention-queue')).toBeVisible();
    expect(shown()).toHaveLength(1);
  });

  it('goes where the item goes when the reader clicks it', async () => {
    alreadyOptedIn();
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});

    const other = run({ id: 'run_other', handle: OTHER_HANDLE, label: 'The other orchestration', lastActivityAt: ago(5 * 60_000) });
    const snapshot = {
      runs: [run(), other],
      tasks: [task(), task({ id: 'task_other', runId: 'run_other', title: 'Stuck work' })],
    };

    const view = render(<App loadTask={NO_DETAIL} event={event(snapshot, 1)} />);
    view.rerender(
      <App
        loadTask={NO_DETAIL}
        event={event({ ...snapshot, gates: [gate({ id: 'msg_other_gate', runId: 'run_other', taskId: 'task_other' })] }, 2)}
      />
    );

    expect(row('run_crew')).toHaveAttribute('aria-current', 'true');
    expect(shown()).toHaveLength(1);

    shown()[0]!.activate();

    // The same destination the queue's own row has (#56): the orchestrator open, the task's story
    // on screen — and the window pulled forward first, because the reader is by definition
    // somewhere else.
    expect(focus).toHaveBeenCalled();
    expect(shown()[0]!.closed).toBe(true);
    expect(row('run_other')).toHaveAttribute('aria-current', 'true');
    expect(await screen.findByTestId('inspector')).toHaveTextContent('Stuck work');
  });

  it('degrades to the tab when the browser has denied us, and says so where it can be read', async () => {
    FakeNotification.permission = 'denied';
    localStorage.setItem(NOTIFY_STORAGE_KEY, 'on');

    const view = render(<App loadTask={NO_DETAIL} event={event({}, 1)} />);
    view.rerender(<App loadTask={NO_DETAIL} event={event({ gates: [gate()] }, 2)} />);

    // No notification, no thrown error, no permission prompt we are not allowed to raise — and the
    // count is on the tab and in the queue, where it always was.
    expect(shown()).toHaveLength(0);
    expect(FakeNotification.requests).toBe(0);
    expect(document.title).toBe('(1) orca-viz');
    expect(bell()).toHaveAttribute('aria-disabled', 'true');
    expect(bell()).toHaveAccessibleName(/blocked/i);

    // **The explanation has to be reachable**, and this is the state where that matters most: a
    // denial is the one of the two dead states the reader can go and undo, in their own browser
    // settings. `disabled` would take the bell out of the tab order *and* kill its tooltip
    // (shadcn's button carries `disabled:pointer-events-none`), so the only state with something
    // to say would be the only state that could not say it.
    expect(bell()).not.toBeDisabled();
    expect(bell()).toHaveAttribute('title', expect.stringMatching(/blocked/i));

    // …and it is inert all the same. A click neither prompts a browser that has already refused
    // nor quietly rewrites the wish the reader recorded when it had not.
    await userEvent.click(bell());

    expect(FakeNotification.requests).toBe(0);
    expect(localStorage.getItem(NOTIFY_STORAGE_KEY)).toBe('on');
    expect(shown()).toHaveLength(0);
  });

  it('degrades to the tab when the browser has no Notification at all', () => {
    vi.unstubAllGlobals();
    expect('Notification' in globalThis).toBe(false);
    localStorage.setItem(NOTIFY_STORAGE_KEY, 'on');

    const view = render(<App loadTask={NO_DETAIL} event={event({}, 1)} />);
    view.rerender(<App loadTask={NO_DETAIL} event={event({ gates: [gate()] }, 2)} />);

    expect(document.title).toBe('(1) orca-viz');
    expect(bell()).toHaveAttribute('aria-disabled', 'true');
    expect(bell()).toHaveAccessibleName(/not available/i);
  });

  it('degrades to the tab when permission is revoked while the page is open', () => {
    alreadyOptedIn();

    const view = render(<App loadTask={NO_DETAIL} event={event({}, 1)} />);
    view.rerender(<App loadTask={NO_DETAIL} event={event({ gates: [gate()] }, 2)} />);
    expect(shown()).toHaveLength(1);

    // The reader revokes the permission in the browser's own settings, with the page still open.
    // `Notification.permission` is the authority on every single send, never a value we read once
    // at startup and then trusted for the rest of the day.
    FakeNotification.permission = 'denied';

    view.rerender(<App loadTask={NO_DETAIL} event={event({ gates: [gate()], turns: [escalation()] }, 3)} />);

    expect(shown()).toHaveLength(1);
    expect(screen.getAllByTestId('attention-item')).toHaveLength(2);
    expect(document.title).toBe('(2) orca-viz');
  });

  it('degrades to the tab when the platform refuses to construct one', () => {
    // Chrome on Android throws `Illegal constructor` from `new Notification(...)`: the platform
    // has the API and requires a service worker to use it, which #60 puts out of scope. The one
    // thing that may not happen is an exception escaping into the render.
    alreadyOptedIn();
    FakeNotification.illegalConstructor = true;

    const view = render(<App loadTask={NO_DETAIL} event={event({}, 1)} />);
    view.rerender(<App loadTask={NO_DETAIL} event={event({ gates: [gate()] }, 2)} />);

    expect(shown()).toHaveLength(0);
    expect(document.title).toBe('(1) orca-viz');
    // …and having met that browser once, the tool stops claiming it can notify on it.
    expect(bell()).toHaveAttribute('aria-disabled', 'true');
    expect(bell()).toHaveAccessibleName(/not available/i);
  });

  it('stops when the reader turns it off, and remembers that too', async () => {
    alreadyOptedIn();

    const view = render(<App loadTask={NO_DETAIL} event={event({}, 1)} />);
    expect(bell()).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(bell());

    expect(localStorage.getItem(NOTIFY_STORAGE_KEY)).toBe('off');
    expect(bell()).toHaveAttribute('aria-pressed', 'false');

    view.rerender(<App loadTask={NO_DETAIL} event={event({ gates: [gate()] }, 2)} />);
    expect(shown()).toHaveLength(0);
  });

  it('keeps the opt-in off when the reader answers the prompt with no', async () => {
    FakeNotification.answer = 'denied';

    const view = render(<App loadTask={NO_DETAIL} event={event({}, 1)} />);

    await userEvent.click(bell());

    expect(FakeNotification.requests).toBe(1);
    // The wish is not recorded as granted when the browser said no: the control tells the truth
    // about what will happen, which is nothing.
    expect(localStorage.getItem(NOTIFY_STORAGE_KEY)).not.toBe('on');
    await waitFor(() => expect(bell()).toHaveAttribute('aria-disabled', 'true'));
    expect(bell()).toHaveAccessibleName(/blocked/i);

    view.rerender(<App loadTask={NO_DETAIL} event={event({ gates: [gate()] }, 2)} />);
    expect(shown()).toHaveLength(0);
    expect(document.title).toBe('(1) orca-viz');
  });
});

/**
 * The reconnect baseline, driven through the real transport (`<Live>`), because the fact it turns
 * on is one only the transport knows: **the stream dropped and came back**. `EventSource`
 * reconnects on its own and replays from `Last-Event-ID` (SPEC §6.2), so the snapshot that lands
 * after a blip carries everything that happened while the page was blind — and announcing all of
 * it is exactly the burst #60 exists to prevent. A laptop lid, a sleep, a server restart: the tool
 * comes back, reads the queue, and says nothing about what it missed.
 */
class FakeEventSource {
  static opened: FakeEventSource[] = [];

  readonly url: string;
  closed = false;
  onmessage: ((message: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.opened.push(this);
  }

  close(): void {
    this.closed = true;
  }

  push(streamEvent: StreamEvent): void {
    act(() => {
      this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(streamEvent) }));
    });
  }

  /** The connection drops. The browser will retry on its own; this is what it tells us meanwhile. */
  drop(): void {
    act(() => {
      this.onerror?.(new Event('error'));
    });
  }
}

describe('the reconnect baseline', () => {
  beforeEach(() => {
    FakeEventSource.opened = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', vi.fn());
  });

  it('takes the queue it reconnects to as history, and announces what arrives after it', () => {
    alreadyOptedIn();

    render(<Live />);
    const stream = FakeEventSource.opened[0]!;

    stream.push(event({}, 1));
    stream.push(event({ gates: [gate()] }, 2));
    expect(shown()).toHaveLength(1);

    // The laptop sleeps. Work goes on without us: an escalation, and a failure.
    stream.drop();
    stream.push(
      event(
        {
          gates: [gate()],
          turns: [escalation()],
          tasks: [task(), task({ id: 'task_wrecked', title: 'Wrecked', status: 'failed', completedAt: ago(60_000) })],
        },
        3
      )
    );

    // Three causes on screen, and not one of them announced: everything the reconnect showed us is
    // history by the time we see it, exactly as the queue on first load is.
    expect(screen.getAllByTestId('attention-item')).toHaveLength(3);
    expect(document.title).toBe('(3) orca-viz');
    expect(shown()).toHaveLength(1);

    // …and the tool is not deaf afterwards. The next thing to actually happen still lands.
    stream.push(
      event(
        {
          gates: [gate(), gate({ id: 'msg_gate_2', question: 'Ship it?' })],
          turns: [escalation()],
          tasks: [task(), task({ id: 'task_wrecked', title: 'Wrecked', status: 'failed', completedAt: ago(60_000) })],
        },
        4
      )
    );

    expect(shown()).toHaveLength(2);
    expect(shown()[1]!.options.body).toContain('Ship it?');
  });
});
