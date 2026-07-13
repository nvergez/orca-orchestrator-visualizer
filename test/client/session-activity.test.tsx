import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.tsx';
import type { TaskLoader } from '../../src/client/inspector/detail.ts';
import type { FeedMessage, Meta, Run, StreamEvent, Task } from '../../src/shared/types.ts';

/**
 * The ticker on screen (#58), at the canned-event seam every client suite uses: `<App>` fed a
 * sequence of `StreamEvent`s, exactly as `Live.tsx` would feed them.
 *
 * The derivation itself is proven in `activity.test.tsx`; what this suite owes the screen is the
 * ticket's *visible* clauses — the first snapshot draws no ticker, later ones narrate, a repeat
 * adds nothing, the panel says out loud that it is session-only, an entry is a way to its task,
 * and none of it ever touches browser storage.
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
  id: 'run_term_9f8e7d6c-1234-4321-8888-aabbccddeeff',
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

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task_build',
    runId: RUN.id,
    parentId: null,
    title: 'Build it',
    status: 'dispatched',
    deps: [],
    createdAt: '2026-07-11T20:54:00.000Z',
    completedAt: null,
    hasSpec: false,
    hasResult: false,
    dispatch: null,
    attemptCount: 1,
    gate: null,
    ...over,
  };
}

function doneMessage(): FeedMessage {
  return {
    id: 'msg_11',
    sequence: 11,
    type: 'worker_done',
    fromHandle: 'term_a38d266c-0000-4000-8000-000000000001',
    toHandle: RUN.handle!,
    subject: 'Done: built it',
    body: '',
    priority: 'normal',
    threadId: null,
    payload: null,
    createdAt: '2026-07-11T21:29:00.000Z',
    taskId: 'task_build',
    runId: RUN.id,
  };
}

function event(over: { seq?: number; tasks?: Task[]; messages?: FeedMessage[] } = {}): StreamEvent {
  return {
    seq: over.seq ?? 10,
    meta: META,
    snapshot: { runs: [RUN], tasks: over.tasks ?? [task()], gates: [], turns: [], coordinatorRuns: [] },
    messages: over.messages ?? [],
  };
}

const loadNothing: TaskLoader = vi.fn(async (id: string) => ({ id, spec: null, result: null, attempts: [] }));

describe('the session-activity ticker', () => {
  it('draws no ticker from the first snapshot, however much history it carries', () => {
    render(<App event={event({ messages: [doneMessage()] })} loadTask={loadNothing} />);

    expect(screen.queryByRole('log')).toBeNull();
  });

  it('narrates observed transitions and message deltas, newest first, and says it is session-only', () => {
    const { rerender } = render(<App event={event()} loadTask={loadNothing} />);

    rerender(
      <App
        event={event({ seq: 11, tasks: [task({ status: 'completed' })], messages: [doneMessage()] })}
        loadTask={loadNothing}
      />
    );

    const ticker = screen.getByRole('log', { name: /session activity/i });
    expect(ticker).toBeVisible();

    // The panel names itself as what it is: this session's observations, nothing durable.
    expect(within(ticker).getByText(/observed since this page connected/i)).toBeVisible();
    expect(within(ticker).getByText(/cleared on reload/i)).toBeVisible();

    // Newest first: the status flip was observed *now*; the worker_done was written before it.
    const rows = within(ticker).getAllByTestId('activity-entry');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Build it · dispatched → completed');
    expect(rows[1]).toHaveTextContent('Done: built it');
  });

  it('adds nothing for a repeated identical snapshot', () => {
    const { rerender } = render(<App event={event()} loadTask={loadNothing} />);

    const later = { seq: 11, tasks: [task({ status: 'completed' })] };
    rerender(<App event={event(later)} loadTask={loadNothing} />);
    rerender(<App event={event(later)} loadTask={loadNothing} />);

    expect(screen.getAllByTestId('activity-entry')).toHaveLength(1);
  });

  it('opens the task an entry names, story and all', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<App event={event()} loadTask={loadNothing} />);

    rerender(<App event={event({ seq: 11, tasks: [task({ status: 'completed' })] })} loadTask={loadNothing} />);

    await user.click(screen.getByRole('button', { name: /dispatched → completed/i }));

    expect(await screen.findByTestId('inspector')).toHaveAccessibleName('Task Build it');
  });

  it('writes nothing to browser storage, however much it narrates', () => {
    const { rerender } = render(<App event={event()} loadTask={loadNothing} />);

    rerender(
      <App
        event={event({ seq: 11, tasks: [task({ status: 'completed' })], messages: [doneMessage()] })}
        loadTask={loadNothing}
      />
    );

    expect(screen.getAllByTestId('activity-entry')).toHaveLength(2);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
