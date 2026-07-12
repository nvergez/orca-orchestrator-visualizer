import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/client/App.tsx';
import { STATUS_COLORS } from '../../src/client/canvas/theme.ts';
import type { FeedMessage, Meta, Run, StreamEvent, Task } from '../../src/shared/types.ts';

/**
 * Seam 2 (#12): `<App>` fed a canned `StreamEvent` — the client's only input.
 *
 * The feed is where the orchestration stops being a graph and starts being a conversation, and
 * the two hardest things about it are both *absences*: the 65% of traffic that must not be on
 * screen, and the run a message must not be guessed into. So the fixtures below have the live
 * database's shape — 466 messages, 302 of them heartbeats — and what is asserted is the DOM a
 * user actually reads.
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
const WORKER = 'term_1a2b3c4d-1234-4321-8888-aabbccddeeff';
const RUN_ID = 'run_9f8e7d6c_1000';
const OTHER_RUN_ID = 'run_1a2b3c4d_2000';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task_aaaaaaaa',
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
    taskCount: 1,
    statusCounts: { pending: 0, ready: 0, dispatched: 0, completed: 1, failed: 0, blocked: 0 },
    live: false,
    hasOpenGates: false,
    edgeCount: 0,
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
    fromHandle: WORKER,
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
  const tasks = over.snapshot?.tasks ?? [task()];

  return {
    seq: 0,
    meta: META,
    snapshot: { runs: [run()], tasks, gates: [], coordinatorRuns: [] },
    messages: [],
    ...over,
  };
}

/** The feed's rows, newest first — which is the order the panel renders them in. */
function rows(): HTMLElement[] {
  return screen.queryAllByTestId('feed-row');
}

function node(id: string): HTMLElement {
  const found = screen.getAllByTestId('task-node').find((element) => element.dataset.task === id);
  if (!found) throw new Error(`no node for ${id} on the canvas`);
  return found;
}

/**
 * A node is clicked with `fireEvent`, and every *control* on the page with `userEvent`.
 *
 * Not a shortcut: `userEvent` dispatches a full pointer sequence, and the `mousedown` in it
 * reaches React Flow's d3-zoom pane handler, which dereferences `event.view` — a property jsdom
 * leaves null on a synthetic event. That is a gap in the DOM implementation, in the same family
 * as the `ResizeObserver` and layout shims this suite already installs (`jsdom-gaps.ts`), and
 * not a fact about the app: in a browser the pane pans and the click still lands. `click` is
 * the event React Flow's `onNodeClick` listens for, and it is the one this asserts on.
 */
function clickNode(id: string): void {
  fireEvent.click(node(id));
}

/** The canvas lays out asynchronously (elkjs), so the nodes arrive on a later tick. */
async function drawn(count: number): Promise<void> {
  await waitFor(() => expect(screen.getAllByTestId('task-node').length).toBe(count));
}

describe('the message feed', () => {
  it('is what the right dock shows by default', () => {
    render(<App event={event({ messages: [message({ subject: 'Done' })] })} />);

    expect(screen.getByRole('complementary', { name: /message feed/i })).toBeVisible();
    expect(screen.getByText('Done')).toBeVisible();
  });

  it('shows the type, who said it to whom, the subject and how long ago', () => {
    render(
      <App
        event={event({
          messages: [
            message({
              type: 'worker_done',
              subject: 'Done: the feed renders',
              fromHandle: WORKER,
              toHandle: HANDLE,
              createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
            }),
          ],
        })}
      />
    );

    const row = rows()[0]!;

    expect(within(row).getByTestId('type-chip')).toHaveTextContent('worker_done');
    expect(within(row).getByText('1a2b3c4d → 9f8e7d6c')).toBeVisible();
    expect(within(row).getByText('Done: the feed renders')).toBeVisible();
    expect(within(row).getByText(/3m ago/)).toBeVisible();
  });

  it('colours the chip the way the canvas colours the node it means', () => {
    render(
      <App
        event={event({
          messages: [
            message({ type: 'worker_done', subject: 'done' }),
            message({ type: 'escalation', subject: 'blocked' }),
            message({ type: 'decision_gate', subject: 'which way?' }),
          ],
        })}
      />
    );

    const chip = (type: string) =>
      within(rows().find((row) => row.dataset.type === type)!).getByTestId('type-chip');

    // One palette for the page: a green row and a green node mean the same thing.
    expect(chip('worker_done')).toHaveStyle({ background: STATUS_COLORS.completed.bg });
    expect(chip('escalation')).toHaveStyle({ background: STATUS_COLORS.failed.bg });
    expect(chip('decision_gate')).toHaveStyle({ background: STATUS_COLORS.dispatched.bg });
  });

  it('expands to the body and the payload, and hides them until asked', async () => {
    const user = userEvent.setup();
    render(
      <App
        event={event({
          messages: [
            message({
              type: 'worker_done',
              subject: 'Done',
              body: 'Synthetic three-sentence summary.',
              payload: { taskId: 'task_aaaaaaaa', dispatchId: 'ctx_1' },
            }),
          ],
        })}
      />
    );

    expect(screen.queryByTestId('feed-details')).toBeNull();

    await user.click(screen.getByRole('button', { name: /details/i }));

    const details = screen.getByTestId('feed-details');
    expect(within(details).getByText('Synthetic three-sentence summary.')).toBeVisible();
    expect(details).toHaveTextContent(/"dispatchId": "ctx_1"/);
  });
});

/**
 * The ruling this ticket exists for: **heartbeats are 65% of all traffic** (302 of 466). The
 * fixture below has that shape, because the assertion is worthless against one that does not.
 */
describe('heartbeats', () => {
  /** 466 messages, 302 heartbeats — the live database's ratio, as a canned event. */
  function heartbeatHeavy(): StreamEvent {
    nextSequence = 1;
    const messages: FeedMessage[] = [];

    for (let i = 0; i < 466; i++) {
      const heartbeat = i % 466 < 302;
      messages.push(
        message({
          type: heartbeat ? 'heartbeat' : ['worker_done', 'decision_gate', 'escalation', 'status'][i % 4]!,
          subject: heartbeat ? 'alive' : `Event ${i}`,
          taskId: 'task_aaaaaaaa',
          payload: { taskId: 'task_aaaaaaaa' },
        })
      );
    }

    return event({ messages });
  }

  it('are absent from the feed by default — all 302 of them', () => {
    render(<App event={heartbeatHeavy()} />);

    // 466 messages in, 164 rows out: the four types that are actually events.
    expect(rows()).toHaveLength(164);
    expect(rows().every((row) => row.dataset.type !== 'heartbeat')).toBe(true);
    expect(screen.getByText(/302 heartbeats hidden/)).toBeVisible();
  });

  it('come back when the toggle asks for them', async () => {
    const user = userEvent.setup();
    render(<App event={heartbeatHeavy()} />);

    await user.click(screen.getByRole('checkbox', { name: /show heartbeats/i }));

    expect(rows()).toHaveLength(466);
    expect(rows().some((row) => row.dataset.type === 'heartbeat')).toBe(true);
  });

  it('never pulse a node — 65% of the traffic would be a strobe, not a signal', async () => {
    const { rerender } = render(<App event={event({ messages: [] })} />);
    await drawn(1);

    rerender(
      <App
        event={event({
          messages: [message({ type: 'heartbeat', subject: 'alive', taskId: 'task_aaaaaaaa' })],
        })}
      />
    );

    await waitFor(() => expect(screen.getByText(/1 heartbeats hidden|1 message/)).toBeVisible());
    expect(node('task_aaaaaaaa')).not.toHaveAttribute('data-pulse');
  });
});

/**
 * The feed reads one orchestration at a time — but `messages.sequence` is the only true total
 * order the schema has, and a message the server could not attribute lives in "All" alone.
 */
describe('scope', () => {
  const SCOPED = event({
    messages: [
      message({ subject: 'in this run', runId: RUN_ID }),
      message({ subject: 'in another run', runId: OTHER_RUN_ID }),
      message({ subject: 'in no run at all', runId: null }),
    ],
  });

  it('is the selected run by default', () => {
    render(<App event={SCOPED} />);

    expect(rows()).toHaveLength(1);
    expect(screen.getByText('in this run')).toBeVisible();
    expect(screen.queryByText('in another run')).toBeNull();
  });

  it('never shows an unattributed message inside a run — it is not guessed into one', () => {
    render(<App event={SCOPED} />);

    expect(screen.queryByText('in no run at all')).toBeNull();
  });

  it('shows the whole database, unattributed messages included, under "All"', async () => {
    const user = userEvent.setup();
    render(<App event={SCOPED} />);

    await user.click(screen.getByRole('button', { name: 'All' }));

    expect(rows()).toHaveLength(3);
    expect(screen.getByText('in another run')).toBeVisible();
    expect(screen.getByText('in no run at all')).toBeVisible();
  });
});

/**
 * A message whose `payload.taskId` names a task an `orchestration reset` deleted still belongs
 * in the feed. There are no foreign keys in this schema (SPEC §4.2, trap 8): a broken reference
 * costs the row its link to a node, and nothing else.
 */
describe('a message about a task that no longer exists', () => {
  it('still renders, unlinked rather than dropped', () => {
    render(
      <App
        event={event({
          messages: [
            message({
              subject: 'Progress on a task that is gone',
              // The server resolved the reference and missed: the payload still names it.
              taskId: null,
              payload: { taskId: 'task_wiped_by_a_reset' },
            }),
          ],
        })}
      />
    );

    const row = rows()[0]!;

    expect(within(row).getByText(/Progress on a task that is gone/)).toBeVisible();
    // Not a link: there is nothing on the canvas to go to.
    expect(within(row).queryByRole('button', { name: /Progress on a task/ })).toBeNull();
    expect(within(row).getByTestId('unlinked-subject')).toHaveTextContent(/unlinked/);
  });
});

/**
 * The payoff (SPEC §7.6): click a row → find the task; select a task → read its story.
 */
describe('the link between the feed and the canvas', () => {
  it('highlights the task a row refers to when the row is clicked', async () => {
    const user = userEvent.setup();
    render(
      <App
        event={event({
          snapshot: {
            runs: [run()],
            tasks: [task({ id: 'task_one', title: 'One' }), task({ id: 'task_two', title: 'Two' })],
            gates: [],
            coordinatorRuns: [],
          },
          messages: [message({ type: 'worker_done', subject: 'Done with two', taskId: 'task_two' })],
        })}
      />
    );
    await drawn(2);

    expect(node('task_two')).toHaveAttribute('data-selected', 'false');

    await user.click(screen.getByRole('button', { name: 'Done with two' }));

    expect(node('task_two')).toHaveAttribute('data-selected', 'true');
    expect(node('task_one')).toHaveAttribute('data-selected', 'false');
  });

  it('filters the feed to a task when its node is clicked, and lets go on a second click', async () => {
    render(
      <App
        event={event({
          snapshot: {
            runs: [run()],
            tasks: [task({ id: 'task_one', title: 'One' }), task({ id: 'task_two', title: 'Two' })],
            gates: [],
            coordinatorRuns: [],
          },
          messages: [
            message({ type: 'worker_done', subject: 'about one', taskId: 'task_one' }),
            message({ type: 'worker_done', subject: 'about two', taskId: 'task_two' }),
            message({ subject: 'about neither' }),
          ],
        })}
      />
    );
    await drawn(2);

    clickNode('task_one');

    // One task's story, end to end — and nothing else's.
    expect(rows()).toHaveLength(1);
    expect(screen.getByText('about one')).toBeVisible();
    expect(screen.getByTestId('task-filter')).toHaveTextContent('One');

    clickNode('task_one');

    expect(rows()).toHaveLength(3);
    expect(screen.queryByTestId('task-filter')).toBeNull();
  });

  it('clears the task filter when the ✕ on the chip is clicked', async () => {
    const user = userEvent.setup();
    render(
      <App
        event={event({
          messages: [
            message({ type: 'worker_done', subject: 'about the task', taskId: 'task_aaaaaaaa' }),
            message({ subject: 'about nothing' }),
          ],
        })}
      />
    );
    await drawn(1);

    clickNode('task_aaaaaaaa');
    expect(rows()).toHaveLength(1);

    await user.click(screen.getByTestId('task-filter'));

    expect(rows()).toHaveLength(2);
  });

  it('follows a row into another run rather than pointing at a task that is not on the canvas', async () => {
    // A row in the "All" scope can name a task in a run the canvas is not showing. Clicking it
    // is the user *asking* to go there — quite unlike a run that started on its own, which is
    // news and gets a chip (#16).
    const user = userEvent.setup();
    render(
      <App
        event={event({
          snapshot: {
            runs: [run(), run({ id: OTHER_RUN_ID, label: 'The other run', startedAt: '2026-07-07T12:00:00.000Z' })],
            tasks: [
              task({ id: 'task_here', title: 'Here' }),
              task({ id: 'task_there', title: 'There', runId: OTHER_RUN_ID }),
            ],
            gates: [],
            coordinatorRuns: [],
          },
          messages: [
            message({ type: 'escalation', subject: 'Blocked over there', taskId: 'task_there', runId: OTHER_RUN_ID }),
          ],
        })}
      />
    );
    await drawn(1);

    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.click(screen.getByRole('button', { name: 'Blocked over there' }));

    // The canvas now holds the task the row named, highlighted…
    await waitFor(() => expect(node('task_there')).toHaveAttribute('data-selected', 'true'));
    // …and the rail followed it, so the run being read is the run the task belongs to.
    expect(screen.getAllByTestId('run-row').find((row) => row.dataset.run === OTHER_RUN_ID)).toHaveAttribute(
      'aria-current',
      'true'
    );
  });
});

/**
 * The pulse (SPEC §7.6): a message referencing a task briefly flashes **that node**, in the
 * colour of what happened. Messages are a star between *handles* and dep edges connect *tasks*,
 * so nothing is ever animated along an edge — the flow that would draw does not exist.
 */
describe('the node pulse', () => {
  async function push(first: StreamEvent, next: StreamEvent): Promise<void> {
    const { rerender } = render(<App event={first} />);
    await drawn(1);
    rerender(<App event={next} />);
  }

  it('flashes the node a message just arrived about, in its type\'s colour', async () => {
    await push(
      event({ messages: [] }),
      event({ messages: [message({ type: 'worker_done', subject: 'Done', taskId: 'task_aaaaaaaa' })] })
    );

    await waitFor(() => expect(node('task_aaaaaaaa')).toHaveAttribute('data-pulse', 'worker_done'));
    expect(node('task_aaaaaaaa')).toHaveStyle({ boxShadow: `0 0 0 3px ${STATUS_COLORS.completed.border}` });
  });

  it('flashes an escalation red', async () => {
    await push(
      event({ messages: [] }),
      event({ messages: [message({ type: 'escalation', subject: 'Blocked', taskId: 'task_aaaaaaaa' })] })
    );

    await waitFor(() =>
      expect(node('task_aaaaaaaa')).toHaveStyle({ boxShadow: `0 0 0 3px ${STATUS_COLORS.failed.border}` })
    );
  });

  it('flashes a decision gate amber', async () => {
    await push(
      event({ messages: [] }),
      event({
        messages: [message({ type: 'decision_gate', subject: 'Which way?', taskId: 'task_aaaaaaaa' })],
      })
    );

    await waitFor(() => expect(node('task_aaaaaaaa')).toHaveAttribute('data-pulse', 'decision_gate'));
    expect(node('task_aaaaaaaa')).toHaveStyle({ boxShadow: `0 0 0 3px ${STATUS_COLORS.dispatched.border}` });
  });

  it('does not flash a plain status message — three colours were agreed, and only three', async () => {
    await push(
      event({ messages: [] }),
      event({ messages: [message({ type: 'status', subject: 'Progress note', taskId: 'task_aaaaaaaa' })] })
    );

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(node('task_aaaaaaaa')).not.toHaveAttribute('data-pulse');
  });

  it('stops flashing about a second later — a pulse that stayed would just be a colour', async () => {
    await push(
      event({ messages: [] }),
      event({ messages: [message({ type: 'worker_done', subject: 'Done', taskId: 'task_aaaaaaaa' })] })
    );

    await waitFor(() => expect(node('task_aaaaaaaa')).toHaveAttribute('data-pulse', 'worker_done'));
    await waitFor(() => expect(node('task_aaaaaaaa')).not.toHaveAttribute('data-pulse'), { timeout: 3000 });
  });

  it('does not flash the four days of history that arrive on first connect', async () => {
    // The first event is the *page*, not news. Flashing 164 nodes at once would be a strobe
    // announcing nothing.
    render(
      <App
        event={event({
          messages: [message({ type: 'worker_done', subject: 'Done last Tuesday', taskId: 'task_aaaaaaaa' })],
        })}
      />
    );
    await drawn(1);

    expect(node('task_aaaaaaaa')).not.toHaveAttribute('data-pulse');
  });
});

/**
 * A run starting while you read another one is *news*, not an instruction (#16, SPEC §7.3). The
 * chip is the rail's; what is asserted here is that the feed obeys the same rule — the canvas
 * and the panel beside it are never yanked out from under you together.
 */
describe('a new run arriving while you are reading', () => {
  it('announces itself without changing the selection or the feed', async () => {
    const first = event({ messages: [message({ subject: 'this run' })] });
    const { rerender } = render(<App event={first} />);
    await drawn(1);

    const withNewRun = event({
      snapshot: {
        runs: [
          run({ id: OTHER_RUN_ID, label: 'Something new', startedAt: '2026-07-09T12:00:00.000Z', live: true }),
          run(),
        ],
        tasks: [task(), task({ id: 'task_new', runId: OTHER_RUN_ID, status: 'dispatched' })],
        gates: [],
        coordinatorRuns: [],
      },
      messages: [message({ subject: 'the new run says hello', runId: OTHER_RUN_ID })],
    });

    rerender(<App event={withNewRun} />);

    expect(await screen.findByRole('button', { name: /new run started/i })).toBeVisible();
    // The canvas is still the run you were reading…
    expect(screen.getAllByTestId('run-row').find((row) => row.dataset.run === RUN_ID)).toHaveAttribute(
      'aria-current',
      'true'
    );
    // …and so is the feed.
    expect(screen.getByText('this run')).toBeVisible();
    expect(screen.queryByText('the new run says hello')).toBeNull();
  });
});

/**
 * The feed remembers; `StreamEvent.messages` is only ever the delta after the client's cursor
 * (SPEC §6.3). Nobody else on the client is holding the messages that already arrived.
 */
describe('the feed accumulates', () => {
  it('keeps what it has already been sent when a push carries only the new rows', async () => {
    const { rerender } = render(<App event={event({ messages: [message({ subject: 'the first thing' })] })} />);

    rerender(<App event={event({ messages: [message({ subject: 'the second thing' })] })} />);

    await waitFor(() => expect(rows()).toHaveLength(2));
    // Newest first: the feed answers "what just happened".
    expect(rows()[0]).toHaveTextContent('the second thing');
    expect(rows()[1]).toHaveTextContent('the first thing');
  });
});
