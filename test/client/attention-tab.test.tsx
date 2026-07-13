import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.tsx';
import { ATTENTION_FAVICON, IDLE_FAVICON } from '../../src/client/attention/favicon.ts';
import { BASE_TITLE } from '../../src/client/attention/tab.ts';
import type { TaskLoader } from '../../src/client/inspector/detail.ts';
import type { Gate, Meta, Run, StreamEvent, Task } from '../../src/shared/types.ts';

/**
 * Seam 2 (#12): `<App>` fed a canned `StreamEvent` — **the tab, while you are looking elsewhere**
 * (#60).
 *
 * The title and the favicon are the one channel this tool has to a reader who is in another tab,
 * and they are derived from **#56's queue and nothing else**: the same ranked causes the rail
 * shows, counted. There is no second urgency model behind the tab — a title that counted blocked
 * tasks while the queue counted causes would be two tools disagreeing on one screen.
 *
 * They are also the *floor*: notifications are opt-in, permission can be denied, and the API can
 * be missing outright — and in every one of those cases the tab still says how many things need
 * intervention (#60's degradation criterion). So this suite never grants a permission, and never
 * even defines `Notification`.
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

function event(snapshot: Partial<StreamEvent['snapshot']>, seq = 1): StreamEvent {
  return {
    seq,
    meta: META,
    snapshot: { runs: [run()], tasks: [task()], gates: [], turns: [], coordinatorRuns: [], ...snapshot },
    messages: [],
  };
}

/** What the browser tab is actually showing, right now. */
function favicon(): string | null {
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.getAttribute('href') ?? null;
}

beforeEach(() => {
  document.title = BASE_TITLE;
  document.head.querySelectorAll('link[rel="icon"]').forEach((link) => link.remove());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the tab, while the reader is somewhere else', () => {
  it('says nothing while nothing needs intervention', () => {
    render(<App loadTask={NO_DETAIL} event={event({})} />);

    expect(document.title).toBe('orca-viz');
    expect(favicon()).toBe(IDLE_FAVICON);
  });

  it('counts the queue in the title, and flags the favicon', () => {
    render(
      <App
        loadTask={NO_DETAIL}
        event={event({
          tasks: [task(), task({ id: 'task_wrecked', title: 'Wrecked', status: 'failed', completedAt: ago(60_000) })],
          gates: [gate()],
        })}
      />
    );

    // Two causes — a blocking gate and a fresh failure — and the tab says two, because the tab
    // *is* the queue, counted. It is the same number the rail's header shows.
    expect(screen.getByTestId('attention-queue')).toHaveTextContent('2');
    expect(document.title).toBe('(2) orca-viz');
    expect(favicon()).toBe(ATTENTION_FAVICON);
  });

  it('returns to normal the moment the queue clears', () => {
    const view = render(<App loadTask={NO_DETAIL} event={event({ gates: [gate()] }, 1)} />);
    expect(document.title).toBe('(1) orca-viz');

    // The question was answered: the gate stops blocking, the queue empties, and the tab has
    // nothing left to say. A badge that outlived its evidence would be the one thing a tab
    // badge may never be — a lie you cannot dismiss.
    view.rerender(<App loadTask={NO_DETAIL} event={event({ gates: [gate({ blocking: false, status: 'resolved' })] }, 2)} />);

    expect(document.title).toBe('orca-viz');
    expect(favicon()).toBe(IDLE_FAVICON);
    expect(screen.queryByTestId('attention-queue')).toBeNull();
  });

  it('tracks the queue on the wall clock alone, with no push behind it', () => {
    // The `data_version` gate pushes nothing when nothing writes, and a fresh failure still ages
    // out of the queue (#56). The tab is derived from that queue, so it has to let go with it.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-07-11T22:00:00.000Z'));

    render(
      <App
        loadTask={NO_DETAIL}
        event={event({
          tasks: [task({ id: 'task_wrecked', title: 'Wrecked', status: 'failed', completedAt: ago(9.75 * 60_000) })],
        })}
      />
    );
    expect(document.title).toBe('(1) orca-viz');

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(document.title).toBe('orca-viz');
    expect(favicon()).toBe(IDLE_FAVICON);
  });

  it('is the floor, not the feature: no Notification API, and the tab still counts', () => {
    // The whole point of deriving the tab from the queue rather than from the notifier: a browser
    // with no `Notification` at all — and this jsdom is one — loses the desktop notification and
    // loses nothing else (#60's degradation criterion).
    expect('Notification' in globalThis).toBe(false);

    render(<App loadTask={NO_DETAIL} event={event({ gates: [gate()] })} />);

    expect(document.title).toBe('(1) orca-viz');
    expect(favicon()).toBe(ATTENTION_FAVICON);
  });
});
