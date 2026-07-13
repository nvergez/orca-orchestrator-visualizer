import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/client/App.tsx';
import type { CastMember, Enrichment, Meta, Run, StreamEvent, Task } from '../../src/shared/types.ts';

/**
 * Live Orca context on the cast (#61) — seam 2: `<App>` fed a canned `StreamEvent`.
 *
 * The server has already done everything hard: the exact join, the ambiguity rule, the
 * honest states. What the client owes is exactly three things, asserted here:
 *
 * 1. A joined worker's row says where it works and — only when the server attached it —
 *    what it is doing right now.
 * 2. A failed adapter is one quiet, honest line; a disabled or suspended one is *nothing*.
 *    Post-mortem screens look exactly as they did before the feature existed.
 * 3. An enrichment-only push updates in place. The DAG neither remounts nor loses the
 *    reader's viewport (#46) — live context is a caption, not a navigation.
 */

const META: Meta = {
  dbPath: '/home/dev/.config/orca/orchestration.db',
  schemaVersion: 5,
  schemaSupport: 'supported',
  degraded: [],
  liveness: 'live',
  orcaPid: 4242,
  dbMtime: '2026-07-11T20:54:00.000Z',
  // #78 replaced the reset boolean with ordered history-loss signals; "no reset" is now "no
  // history-loss claim". This suite is about enrichment and asserts nothing on either.
  historyLoss: [],
};

const ORCHESTRATOR = 'term_9f8e7d6c-1234-4321-8888-aabbccddeeff';
const WORKER = 'term_1a2b3c4d-1234-4321-8888-aabbccddeeff';
const RUN_ID = `run_${ORCHESTRATOR}`;

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task_aaaaaaaa',
    runId: RUN_ID,
    parentId: null,
    title: 'A task',
    status: 'dispatched',
    deps: [],
    createdAt: '2026-07-11T20:54:00.000Z',
    completedAt: null,
    hasSpec: true,
    hasResult: false,
    dispatch: {
      id: 'ctx_1',
      assigneeHandle: WORKER,
      status: 'dispatched',
      failureCount: 0,
      lastFailure: null,
      dispatchedAt: '2026-07-11T20:55:00.000Z',
      completedAt: null,
      lastHeartbeatAt: null,
    },
    attemptCount: 1,
    gate: null,
    ...over,
  };
}

const CAST: CastMember[] = [
  { handle: WORKER, monogram: 'A1', taskIds: ['task_aaaaaaaa'], taskCount: 1, lastHeartbeatAt: null },
];

function runOf(tasks: Task[]): Run {
  return {
    id: RUN_ID,
    handle: ORCHESTRATOR,
    label: 'Ship it',
    startedAt: '2026-07-11T20:54:00.000Z',
    // #81's run-health model. `endedAt` is now the deprecated exact alias of `lastActivityAt`,
    // so they carry the same instant; `converged: false` matches this fixture's own
    // `dispatched: 1` — a run still working, which is the only run enrichment has anything
    // to say about.
    lastActivityAt: '2026-07-11T21:30:00.000Z',
    converged: false,
    endedAt: '2026-07-11T21:30:00.000Z',
    taskCount: tasks.length,
    cast: CAST,
    waves: [
      {
        index: 1,
        startedAt: '2026-07-11T20:54:00.000Z',
        endedAt: '2026-07-11T21:30:00.000Z',
        taskIds: tasks.map((task) => task.id),
        idleGapBeforeMs: null,
      },
    ],
    statusCounts: { pending: 0, ready: 0, dispatched: 1, completed: 0, failed: 0, blocked: 0 },
    live: true,
    // #82 dropped the merely-`open` gate flag for the one that can be proven: `blocking`.
    // This run has no gates at all, so it is false under either name.
    hasBlockingGates: false,
    edgeCount: 0,
  };
}

function event(tasks: Task[], enrichment?: Enrichment): StreamEvent {
  const streamEvent: StreamEvent = {
    seq: 0,
    meta: META,
    snapshot: { runs: [runOf(tasks)], tasks, gates: [], turns: [], coordinatorRuns: [] },
    messages: [],
  };
  if (enrichment) streamEvent.enrichment = enrichment;
  return streamEvent;
}

function enrichmentOf(over: Partial<Enrichment> = {}): Enrichment {
  return {
    state: 'ok',
    fetchedAt: '2026-07-11T21:29:50.000Z',
    workers: [
      {
        handle: WORKER,
        worktree: {
          path: '/home/dev/orca/workspaces/viz/issue-61',
          branch: 'nvergez/issue-61',
          repo: 'orca-viz',
          displayName: 'issue-61',
        },
        activity: {
          state: 'working',
          agentType: 'claude',
          lastAssistantMessage: 'Running the suite now.',
          toolName: 'Bash',
          toolInput: 'npm test',
          updatedAt: '2026-07-11T21:29:48.000Z',
        },
      },
    ],
    ...over,
  };
}

/** The one cast row this fixture has. The cast nests under the selected (only) run. */
async function agentRow(): Promise<HTMLElement> {
  return await screen.findByTestId('agent-row');
}

describe('live Orca context on the cast', () => {
  it('says where a joined worker works, and what it is doing right now', async () => {
    render(<App event={event([task()], enrichmentOf())} />);

    const row = await agentRow();
    const worktree = within(row).getByTestId('agent-worktree');
    expect(worktree).toHaveTextContent('issue-61');
    expect(worktree).toHaveTextContent('nvergez/issue-61');

    const activity = within(row).getByTestId('agent-activity');
    expect(activity).toHaveTextContent('working');
    expect(activity).toHaveTextContent('Bash');
    expect(activity).toHaveTextContent('npm test');
    // The row shows a glimpse; the hover has the rest — including which agent binary it is
    // and how current the reading is, the same convention the handle above it follows.
    expect(activity.getAttribute('title')).toContain('claude');
    expect(activity.getAttribute('title')).toContain('as of');
  });

  it('shows the worktree alone when the server attached no activity — ambiguity stays blank', async () => {
    const ambiguous = enrichmentOf();
    delete ambiguous.workers[0]!.activity;

    render(<App event={event([task()], ambiguous)} />);

    const row = await agentRow();
    expect(within(row).getByTestId('agent-worktree')).toHaveTextContent('issue-61');
    // Several terminals or agents shared that worktree: the server sent no activity, and the
    // row invents none (#61 — no guessed activity, ever).
    expect(within(row).queryByTestId('agent-activity')).toBeNull();
  });

  it('adds nothing to a worker the join could not place', async () => {
    render(<App event={event([task()], enrichmentOf({ workers: [] }))} />);

    const row = await agentRow();
    expect(within(row).queryByTestId('agent-worktree')).toBeNull();
    expect(within(row).queryByTestId('agent-activity')).toBeNull();
  });

  it('says honestly, once, that live context is unavailable when the adapter failed', async () => {
    render(<App event={event([task()], { state: 'unavailable', fetchedAt: null, workers: [] })} />);

    await agentRow();
    expect(screen.getByTestId('enrichment-unavailable')).toHaveTextContent(/unavailable/i);
  });

  it('renders nothing at all while enrichment is off, pending, or Orca is not live', async () => {
    // Off: the wire has no field. The screen must look exactly as it did before #61 existed.
    const view = render(<App event={event([task()])} />);
    await agentRow();
    expect(screen.queryByTestId('enrichment-unavailable')).toBeNull();
    expect(screen.queryByTestId('agent-worktree')).toBeNull();

    // Suspended: enabled, but Orca is closed — a live-only feature disappears honestly.
    view.rerender(<App event={event([task()], { state: 'suspended', fetchedAt: null, workers: [] })} />);
    expect(screen.queryByTestId('enrichment-unavailable')).toBeNull();
    expect(screen.queryByTestId('agent-worktree')).toBeNull();

    // Pending: enabled and live, first answer not landed. Silence, not a spinner.
    view.rerender(<App event={event([task()], { state: 'pending', fetchedAt: null, workers: [] })} />);
    expect(screen.queryByTestId('enrichment-unavailable')).toBeNull();
  });

  it('names the orchestrator’s own worktree when the join placed it', async () => {
    const withOrchestrator = enrichmentOf({
      workers: [
        {
          handle: ORCHESTRATOR,
          worktree: { path: '/home/dev/projects/viz', branch: 'main', repo: 'orca-viz', displayName: 'main' },
        },
      ],
    });

    render(<App event={event([task()], withOrchestrator)} />);
    await agentRow();

    expect(screen.getByTestId('orchestrator-worktree')).toHaveTextContent('main');
  });
});

describe('enrichment pushes against the canvas (#46)', () => {
  async function zoomToMaximum(): Promise<HTMLButtonElement> {
    const control = screen.getByRole<HTMLButtonElement>('button', { name: /zoom in/i });
    for (let step = 0; step < 20 && !control.disabled; step += 1) {
      await userEvent.click(control);
    }
    await waitFor(() => expect(control).toBeDisabled());
    return control;
  }

  it('updates live context in place without remounting the DAG or resetting its viewport', async () => {
    const tasks = [task(), task({ id: 'task_bbbbbbbb', title: 'Second task', deps: ['task_aaaaaaaa'] })];
    const view = render(<App event={event(tasks, enrichmentOf())} />);
    await waitFor(() => expect(screen.getAllByTestId('task-node')).toHaveLength(2));

    await zoomToMaximum();

    // The adapter refreshed: same graph, new tool call. The push must land as a caption
    // change — a canvas that re-entered or re-fit on every 10 s refresh would make the
    // opt-in unusable exactly when an agent is busiest.
    const updated = enrichmentOf();
    updated.workers[0]!.activity!.toolName = 'Edit';
    updated.workers[0]!.activity!.toolInput = 'src/server/enrichment.ts';
    view.rerender(<App event={event(tasks, updated)} />);

    expect(screen.queryByText(/Laying out/i)).toBeNull();
    expect(screen.getAllByTestId('task-node')).toHaveLength(2);
    expect(within(await agentRow()).getByTestId('agent-activity')).toHaveTextContent('Edit');
    // The reader's zoom is exactly where they left it — the #46 guarantee, kept under #61.
    expect(screen.getByRole('button', { name: /zoom in/i })).toBeDisabled();
  });
});
