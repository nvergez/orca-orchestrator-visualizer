import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.tsx';
import type { TaskLoader } from '../../src/client/inspector/detail.ts';
import type { Gate, Meta, Run, StreamEvent, Task, Turn } from '../../src/shared/types.ts';

/**
 * Seam 2 (#12): `<App>` fed a canned `StreamEvent` — the attention queue on the rail (#56).
 *
 * The queue is the cross-orchestrator surface: one ranked list, at the top of the panel whose
 * whole job is "pick the orchestrator worth opening without opening it" (SPEC §7.2). The pure
 * ranking rules live in `attention.test.tsx`; what is asserted here is the queue *on screen* —
 * that it spans runs, that clicking an item drives the existing selection seam (run, then task,
 * hopping orchestrations when it must), that a cause survives repeated snapshots without
 * duplicating, and that it leaves on the wall clock alone when its freshness expires.
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

function queue(): HTMLElement | null {
  return screen.queryByTestId('attention-queue');
}

function row(runId: string): HTMLElement {
  const found = screen.getAllByTestId('run-row').find((element) => element.dataset.run === runId);
  if (!found) throw new Error(`no rail row for ${runId}`);
  return found;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the attention queue', () => {
  it('says nothing when nothing needs intervention', () => {
    render(<App loadTask={NO_DETAIL} event={event({})} />);

    expect(queue()).toBeNull();
  });

  it('ranks causes from every orchestrator, not only the selected one', () => {
    // The selected run is `run_crew` (most recently active, so the page opens on it) — and the
    // queue still surfaces the other orchestration's blocking gate, above this one's escalation:
    // cross-run triage is the whole point (#51 story 6).
    const other = run({
      id: 'run_other',
      handle: OTHER_HANDLE,
      label: 'The other orchestration',
      lastActivityAt: ago(5 * 60_000),
    });

    render(
      <App
        loadTask={NO_DETAIL}
        event={event({
          runs: [run(), other],
          tasks: [task(), task({ id: 'task_other', runId: 'run_other', title: 'Stuck work' })],
          gates: [gate({ id: 'msg_other_gate', runId: 'run_other', taskId: 'task_other' })],
          turns: [escalation()],
        })}
      />
    );

    const items = within(queue()!).getAllByTestId('attention-item');
    expect(items.map((item) => item.dataset.kind)).toEqual(['blocking-gate', 'escalation']);
    expect(items[0]).toHaveTextContent('Which driver?');
    // …and says whose cause it is: the label the server gave the run, reused verbatim.
    expect(items[0]).toHaveTextContent('The other orchestration');
    expect(items[1]).toHaveTextContent('Blocked: cannot reach the registry');
    expect(items[1]).toHaveTextContent('Ship the visualizer');
  });

  it('selects the orchestrator and task of a clicked item, hopping runs when it must', async () => {
    const other = run({
      id: 'run_other',
      handle: OTHER_HANDLE,
      label: 'The other orchestration',
      lastActivityAt: ago(5 * 60_000),
    });

    render(
      <App
        loadTask={NO_DETAIL}
        event={event({
          runs: [run(), other],
          tasks: [task(), task({ id: 'task_other', runId: 'run_other', title: 'Stuck work' })],
          gates: [gate({ id: 'msg_other_gate', runId: 'run_other', taskId: 'task_other' })],
        })}
      />
    );

    expect(row('run_crew')).toHaveAttribute('aria-current', 'true');

    await userEvent.click(within(queue()!).getByTestId('attention-item'));

    // One click: the other orchestrator is open in the rail, and its task's story is on screen.
    expect(row('run_other')).toHaveAttribute('aria-current', 'true');
    expect(await screen.findByTestId('inspector')).toHaveTextContent('Stuck work');
  });

  it('selects the orchestrator alone when the cause names no task', async () => {
    // 32 of 53 live gate messages carry no `payload.taskId` — they block the run, mark no node,
    // and the click still has somewhere real to go: the orchestration they block.
    const other = run({
      id: 'run_other',
      handle: OTHER_HANDLE,
      label: 'The other orchestration',
      lastActivityAt: ago(5 * 60_000),
    });

    render(
      <App
        loadTask={NO_DETAIL}
        event={event({
          runs: [run(), other],
          tasks: [task(), task({ id: 'task_other', runId: 'run_other' })],
          gates: [gate({ id: 'msg_run_gate', runId: 'run_other', taskId: null })],
        })}
      />
    );

    await userEvent.click(within(queue()!).getByTestId('attention-item'));

    expect(row('run_other')).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByTestId('inspector')).toBeNull();
  });

  it('keeps one row per cause across repeated snapshots', () => {
    const view = render(<App loadTask={NO_DETAIL} event={event({ turns: [escalation()] }, 1)} />);
    expect(within(queue()!).getAllByTestId('attention-item')).toHaveLength(1);

    // The next poll re-reads the same database rows. Same evidence, same identity, one row.
    view.rerender(<App loadTask={NO_DETAIL} event={event({ turns: [escalation()] }, 2)} />);
    expect(within(queue()!).getAllByTestId('attention-item')).toHaveLength(1);
  });

  it('keeps an escalation until its task ends, and drops it then', () => {
    // The pulse that announced it lasted a second; the queue holds it (#51 story 8) — across
    // hours and snapshots — until the evidence says it was handled.
    const view = render(
      <App loadTask={NO_DETAIL} event={event({ turns: [escalation({ at: ago(3 * 60 * 60_000) })] }, 1)} />
    );
    expect(within(queue()!).getByTestId('attention-item')).toHaveTextContent(/cannot reach the registry/);

    view.rerender(
      <App
        loadTask={NO_DETAIL}
        event={event(
          {
            tasks: [task({ status: 'completed', completedAt: ago(1_000) })],
            turns: [escalation({ at: ago(3 * 60 * 60_000) })],
          },
          2
        )}
      />
    );
    expect(queue()).toBeNull();
  });

  it('lets a fresh failure age out on the wall clock alone — no push required', () => {
    // The stream is quiet: the `data_version` gate pushes nothing when nothing writes. The
    // queue still has to let go of a failure once it stops being fresh, so the shared 30-second
    // wall clock is the only thing that may move it (the same clock run health crosses
    // `active → silent` on, SPEC §12.3).
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
    expect(within(queue()!).getByTestId('attention-item')).toHaveTextContent('Wrecked');

    // One tick later the failure is ten minutes old — stale, and gone without any SSE event.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(queue()).toBeNull();
  });
});
