import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/client/App.tsx';
import { GATE_THEME, STATUS_THEME } from '../../src/client/canvas/theme.ts';
import type { TaskLoader } from '../../src/client/inspector/detail.ts';
import type { CastMember, FeedMessage, Meta, Run, StreamEvent, Task, Turn } from '../../src/shared/types.ts';

/**
 * **The conversation** — the panel this whole feature exists for (SPEC §4.7, §7.7).
 *
 * The dock used to hold a *feed*: the `messages` table, as a flat list of rows. Two things were
 * wrong with it, and they compound.
 *
 * 1. **It was half a dialogue.** When the orchestrator dispatches an agent it writes **no
 *    message** — Orca injects the prompt straight into the worker's PTY, and the live database has
 *    zero `dispatch` rows (SPEC §4.2, trap 2). So the panel showed agents reporting back to an
 *    orchestrator that never said a word to them.
 * 2. **A flat list cannot show who is talking to whom.** A message has a sender and a recipient,
 *    and that is the one thing a reader actually wants from a conversation.
 *
 * The server merges the four sources (`server/conversation.ts`); this panel puts the orchestrator
 * on one side and its agents on the other. What is asserted below is the DOM a user reads.
 */

/** Selecting a task swaps the dock to the inspector, and the inspector fetches. */
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

const HANDLE = 'term_9f8e7d6c-1234-4321-8888-aabbccddeeff';
const ALICE = 'term_1a2b3c4d-1234-4321-8888-aabbccddeeff';
const BOB = 'term_5e6f7a8b-1234-4321-8888-aabbccddeeff';
const RUN_ID = `run_${HANDLE}`;
const OTHER_RUN_ID = 'run_term_somebody_else';

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
    hasBlockingGates: false,
    edgeCount: 0,
    ...over,
  };
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

let nextSequence = 1;

function message(over: Partial<FeedMessage> = {}): FeedMessage {
  const sequence = over.sequence ?? nextSequence++;

  return {
    id: `msg_${sequence}`,
    sequence,
    type: 'status',
    fromHandle: ALICE,
    toHandle: HANDLE,
    subject: `Message ${sequence}`,
    body: '',
    priority: 'normal',
    threadId: null,
    payload: null,
    createdAt: '2026-07-08T12:30:00.000Z',
    taskId: null,
    runId: RUN_ID,
    ...over,
  };
}

function event(over: Partial<StreamEvent> = {}): StreamEvent {
  return {
    seq: 0,
    meta: META,
    snapshot: {
      runs: [run()],
      tasks: [task(), task({ id: TASK_B, title: 'Another task' })],
      gates: [],
      turns: [],
      coordinatorRuns: [],
    },
    messages: [],
    ...over,
  };
}

/** An event with a conversation in it, and nothing else to distract from it. */
function withTurns(rows: Turn[], over: Partial<StreamEvent> = {}): StreamEvent {
  const base = event(over);
  return { ...base, snapshot: { ...base.snapshot, turns: rows } };
}

function turns(): HTMLElement[] {
  return screen.queryAllByTestId('turn');
}

function node(id: string): HTMLElement {
  const element = screen.getByTestId('canvas').querySelector(`[data-task="${id}"]`);
  if (!element) throw new Error(`no node for ${id} on the canvas`);
  return element as HTMLElement;
}

/**
 * A node is clicked with `fireEvent`, and never with `user-event`, **because jsdom is not a
 * browser.** `user.click` dispatches a real `mousedown`, which bubbles into React Flow's d3-zoom
 * pane — and d3-drag reaches for `ownerDocument.defaultView.document` on a view jsdom does not
 * have. The exception is thrown inside an event listener, so it does not fail the assertion; it
 * fails the *run*, as an unhandled error, which is a far worse thing to leave lying around.
 *
 * The click is all the component needs: `onNodeClick` is a click handler.
 */
function clickNode(id: string): void {
  fireEvent.click(node(id));
}

/** The canvas lays out through elkjs, which is async — nothing is on it until that lands. */
async function drawn(count: number): Promise<void> {
  await waitFor(() => expect(screen.getAllByTestId('task-node')).toHaveLength(count));
}

describe('the conversation', () => {
  it('is what the right dock shows by default', async () => {
    render(<App event={event()} loadTask={NO_DETAIL} />);

    expect(await screen.findByTestId('conversation')).toBeVisible();
    expect(screen.queryByTestId('inspector')).not.toBeInTheDocument();
  });

  it('shows both sides — the orchestrator’s prompt, and the agent’s reply', async () => {
    // The whole feature in one assertion. The `dispatch` turn is not a message and never was: it is
    // `tasks.spec` at `dispatch_contexts.dispatched_at`, merged (SPEC §4.7). Without it, the panel
    // below shows an agent answering a question nobody asked.
    render(
      <App
        event={withTurns([
          turn({
            kind: 'dispatch',
            direction: 'out',
            fromHandle: HANDLE,
            toHandle: ALICE,
            body: 'Port the canvas to React Flow.',
            source: 'tasks.spec · dispatch_contexts.dispatched_at',
          }),
          turn({ kind: 'worker_done', direction: 'in', body: 'Canvas done.' }),
        ])}
        loadTask={NO_DETAIL}
      />
    );

    await waitFor(() => expect(turns()).toHaveLength(2));

    expect(turns().map((row) => row.dataset.kind)).toEqual(['dispatch', 'worker_done']);
    // Outgoing on one side, incoming on the other — which is what makes "who is talking to whom"
    // legible without being read.
    expect(turns().map((row) => row.dataset.direction)).toEqual(['out', 'in']);

    expect(screen.getByText('Port the canvas to React Flow.')).toBeVisible();
    expect(screen.getByText('Canvas done.')).toBeVisible();
  });

  it('names the two speakers — the orchestrator, and the agent by its monogram', async () => {
    render(
      <App
        event={withTurns([turn({ kind: 'dispatch', direction: 'out', fromHandle: HANDLE, toHandle: ALICE })])}
        loadTask={NO_DETAIL}
      />
    );

    const row = (await screen.findAllByTestId('turn'))[0]!;

    // `A1`, not `term_1a2b3c4d-…`: the handle is a uuid you cannot read, cannot remember and would
    // not act on — and it is the *same* `A1` on the node's stripe and in the rail (`server/cast.ts`).
    expect(row.dataset.agent).toBe('A1');
    expect(within(row).getByText('orchestrator')).toBeVisible();
    expect(within(row).getByText('A1')).toBeVisible();
  });

  it('says which columns every turn was reconstructed from', async () => {
    // The caption is not a footnote. A bubble that *looked* like a message the orchestrator sent,
    // when no such message was ever written, would be the most convincing lie this tool could tell.
    render(
      <App
        event={withTurns([
          turn({ kind: 'dispatch', direction: 'out', source: 'tasks.spec · dispatch_contexts.dispatched_at' }),
          turn({ kind: 'result', direction: 'in', source: 'tasks.result · tasks.completed_at' }),
        ])}
        loadTask={NO_DETAIL}
      />
    );

    await waitFor(() => expect(turns()).toHaveLength(2));

    expect(screen.getByText('tasks.spec · dispatch_contexts.dispatched_at')).toBeVisible();
    expect(screen.getByText('tasks.result · tasks.completed_at')).toBeVisible();
  });

  it('colours a turn the way the canvas colours the node it means', async () => {
    // One palette for the page: the entries in `conversation/theme.ts` *are* the node themes, reused
    // rather than re-picked. A green `worker_done` and a green `completed` node mean the same thing.
    render(
      <App
        event={withTurns([
          turn({ kind: 'worker_done' }),
          turn({ kind: 'escalation' }),
          turn({ kind: 'decision_gate' }),
        ])}
        loadTask={NO_DETAIL}
      />
    );

    await waitFor(() => expect(turns()).toHaveLength(3));

    const chipOf = (kind: string): HTMLElement =>
      within(
        screen.getByTestId('conversation').querySelector(`[data-kind="${kind}"]`) as HTMLElement
      ).getByTestId('kind-chip');

    expect(chipOf('worker_done').className).toContain(STATUS_THEME.completed.surface.split(' ')[0]);
    expect(chipOf('escalation').className).toContain(STATUS_THEME.failed.surface.split(' ')[0]);
    // Orange, and deliberately not the amber of `dispatched`: amber is work in flight, and a gate is
    // the exact opposite of that.
    expect(chipOf('decision_gate').className).toContain(GATE_THEME.surface.split(' ')[0]);
  });

  it('truncates a long prompt and says so — the body itself stays in the file', async () => {
    render(
      <App
        event={withTurns([turn({ kind: 'dispatch', direction: 'out', body: 'x'.repeat(240), truncated: true })])}
        loadTask={NO_DETAIL}
      />
    );

    expect((await screen.findAllByTestId('turn'))[0]!).toHaveTextContent('…');
  });
});

describe('a question, and its answer', () => {
  it('shows the options, and ticks the one that was taken', async () => {
    render(
      <App
        event={withTurns([
          turn({
            kind: 'decision_gate',
            body: 'Keep the accent, or invert it?',
            options: ['keep', 'invert'],
            answer: 'keep',
          }),
        ])}
        loadTask={NO_DETAIL}
      />
    );

    await waitFor(() => expect(turns()).toHaveLength(1));

    expect(screen.getAllByTestId('gate-option').map((option) => option.dataset.picked)).toEqual(['true', 'false']);
  });

  it('says a blocking question is blocking — waiting for an answer', async () => {
    // The blocking chip follows the server's separate `blocking` fact, never the mere absence
    // of a reply (#45): here the gate's task is authoritatively blocked right now.
    render(
      <App
        event={withTurns([
          turn({
            kind: 'decision_gate',
            body: 'A block, or inherit?',
            options: ['a block', 'inherit'],
            gateStatus: 'unanswered',
            blocking: true,
          }),
        ])}
        loadTask={NO_DETAIL}
      />
    );

    expect(await screen.findByTestId('gate-state')).toHaveTextContent(/blocking — waiting for an answer/i);
    expect(screen.getAllByTestId('gate-option').map((option) => option.dataset.picked)).toEqual(['false', 'false']);
  });

  it('says an unanswered non-blocker recorded no answer — not that anything is waiting', async () => {
    // A reply-less ask proves nothing beyond the missing answer: `orchestration.ask` never
    // persists its timeout, and the live database is full of finished runs wearing stale
    // probes (#45). "Waiting" here was the lie this issue exists to remove.
    render(
      <App
        event={withTurns([
          turn({
            kind: 'decision_gate',
            body: 'ping: can you read this?',
            options: ['yes', 'no'],
            gateStatus: 'unanswered',
          }),
        ])}
        loadTask={NO_DETAIL}
      />
    );

    const state = await screen.findByTestId('gate-state');
    expect(state).toHaveTextContent(/no answer recorded/i);
    expect(state).not.toHaveTextContent(/waiting|blocked/i);
  });

  it('names a timed-out gate as timed out — its own terminal state, never an open question', async () => {
    render(
      <App
        event={withTurns([
          turn({ kind: 'decision_gate', body: 'Ship it today?', options: ['yes', 'no'], gateStatus: 'timeout' }),
        ])}
        loadTask={NO_DETAIL}
      />
    );

    expect(await screen.findByTestId('gate-state')).toHaveTextContent(/timed out/i);
  });

  it('states the gate’s fate even when the question offered no options', async () => {
    // Half the live gate messages are hand-written escalations with no options at all. Their
    // state chip must not live inside an options list they do not have.
    render(
      <App
        event={withTurns([turn({ kind: 'decision_gate', body: 'Which base branch?', gateStatus: 'unanswered' })])}
        loadTask={NO_DETAIL}
      />
    );

    expect(await screen.findByTestId('gate-state')).toHaveTextContent(/no answer recorded/i);
  });
});

describe('heartbeats', () => {
  it('are one line, and say how many they stood in for', async () => {
    // 302 of 466 messages, and all of them say "alive" (SPEC §7.7). Rendered straight, the
    // conversation is a ticker with the real exchange lost inside it.
    render(
      <App
        event={withTurns([
          turn({
            kind: 'heartbeats',
            beatCount: 18,
            at: '2026-07-08T12:00:00.000Z',
            endedAt: '2026-07-08T13:25:00.000Z',
          }),
        ])}
        loadTask={NO_DETAIL}
      />
    );

    const beats = await screen.findByTestId('heartbeats');

    expect(beats).toHaveTextContent(/18 heartbeats/);
    // The cadence is *measured* — two instants and a count — not read off Orca's documentation.
    expect(beats).toHaveTextContent(/every ~5 min/);
  });

  it('never pulse a node — 65% of the traffic would be a strobe, not a signal', async () => {
    const { rerender } = render(<App event={event()} loadTask={NO_DETAIL} />);
    await drawn(2);

    // A *second* push, so the message is news rather than history: the 466 that come down on first
    // connect are the page, and flashing them would strobe the whole canvas at once.
    rerender(
      <App
        event={{ ...event(), seq: 1, messages: [message({ type: 'heartbeat', taskId: TASK_A })] }}
        loadTask={NO_DETAIL}
      />
    );

    await waitFor(() => expect(node(TASK_A).dataset.pulse).toBeUndefined());
  });
});

describe('scope', () => {
  it('shows the selected orchestrator, and not another one', async () => {
    render(
      <App
        event={withTurns([
          turn({ id: 'mine', body: 'From this orchestrator.' }),
          turn({ id: 'theirs', runId: OTHER_RUN_ID, body: 'From another one.' }),
        ])}
        loadTask={NO_DETAIL}
      />
    );

    await waitFor(() => expect(turns()).toHaveLength(1));
    expect(screen.getByText('From this orchestrator.')).toBeVisible();
    expect(screen.queryByText('From another one.')).not.toBeInTheDocument();
  });

  it('shows the whole database, unplaceable turns included, under "All"', async () => {
    // A message the server could not place belongs to no orchestrator (SPEC §4.4, rule 3). It must
    // still *appear* — attached to nobody — rather than be guessed into somebody's conversation.
    const user = userEvent.setup();

    render(
      <App
        event={withTurns([
          turn({ id: 'mine', body: 'From this orchestrator.' }),
          turn({ id: 'nobodys', runId: null, taskId: null, body: 'From nobody at all.' }),
        ])}
        loadTask={NO_DETAIL}
      />
    );

    await waitFor(() => expect(turns()).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: 'All' }));

    await waitFor(() => expect(turns()).toHaveLength(2));
    expect(screen.getByText('From nobody at all.')).toBeVisible();
  });

  it('narrows to one agent when the rail selects one, and lets go again', async () => {
    // **The tool's central gesture.** One click fills this panel with that agent's half of the
    // dialogue and dims the canvas to their tasks — two panels, one movement.
    const user = userEvent.setup();

    render(
      <App
        event={withTurns([
          turn({ id: 'alices', fromHandle: ALICE, taskId: TASK_A, body: 'Alice said this.' }),
          turn({ id: 'bobs', fromHandle: BOB, taskId: TASK_B, body: 'Bob said this.' }),
        ])}
        loadTask={NO_DETAIL}
      />
    );

    await waitFor(() => expect(turns()).toHaveLength(2));

    await user.click(screen.getByRole('button', { name: /Agent 1/ }));

    await waitFor(() => expect(turns()).toHaveLength(1));
    expect(screen.getByText('Alice said this.')).toBeVisible();
    expect(screen.queryByText('Bob said this.')).not.toBeInTheDocument();

    // …and the header names the two people in the thread.
    expect(screen.getByText('Orchestrator ↔ A1')).toBeVisible();

    // The way out is beside the name, and not somewhere else on the page.
    await user.click(screen.getByRole('button', { name: /show all/i }));
    await waitFor(() => expect(turns()).toHaveLength(2));
  });
});

describe('a turn and its node', () => {
  it('selects the task a turn names when the turn is clicked', async () => {
    const user = userEvent.setup();

    render(<App event={withTurns([turn({ taskId: TASK_B, body: 'About the other task.' })])} loadTask={NO_DETAIL} />);
    await drawn(2);

    await user.click(screen.getByText('About the other task.'));

    // The dock gives way to the inspector, and the canvas outlines the node the turn named.
    expect(await screen.findByTestId('inspector')).toBeVisible();
    await waitFor(() => expect(node(TASK_B).dataset.selected).toBe('true'));
  });

  it('gives the dock up to the inspector when a node is selected, and takes it back when it is let go', async () => {
    render(<App event={event()} loadTask={NO_DETAIL} />);
    await drawn(2);

    clickNode(TASK_A);
    expect(await screen.findByTestId('inspector')).toBeVisible();
    expect(screen.queryByTestId('conversation')).not.toBeInTheDocument();

    // The way out is the way in: clicking the same node again.
    clickNode(TASK_A);
    expect(await screen.findByTestId('conversation')).toBeVisible();
    expect(screen.queryByTestId('inspector')).not.toBeInTheDocument();
  });
});

describe('the empty conversation', () => {
  it('says why an unattributed orchestration has nothing in it', async () => {
    // Not "no messages": these tasks have no `created_by_terminal_handle`, so there is no
    // orchestrator on record. Nobody said anything to anybody, and the panel says exactly that.
    render(
      <App
        event={event({
          snapshot: {
            runs: [run({ id: 'run_unattributed', handle: null, label: 'Unattributed', cast: [], taskCount: 1 })],
            tasks: [task({ runId: 'run_unattributed' })],
            gates: [],
            turns: [],
            coordinatorRuns: [],
          },
        })}
        loadTask={NO_DETAIL}
      />
    );

    expect(await screen.findByTestId('conversation-empty')).toHaveTextContent(/never attributed to a terminal/i);
  });
});
