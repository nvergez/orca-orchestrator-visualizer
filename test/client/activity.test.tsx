import { describe, expect, it } from 'vitest';
import { MAX_ACTIVITY_ENTRIES, observeActivity } from '../../src/client/activity/session.ts';
import type { Dispatch, FeedMessage, Meta, Run, StreamEvent, Task } from '../../src/shared/types.ts';

/**
 * The session-activity derivation (#58), at its pure seam: fold a `StreamEvent` into the log the
 * ticker renders, with an injected observation instant so nothing here sleeps or reads a clock.
 *
 * The contract under test is the ticket's, clause by clause: the first snapshot is a baseline and
 * narrates nothing; later snapshots synthesize the status / dispatch / retry transitions Orca
 * writes no message row for; coherent message deltas (#49) merge into the same chronological list;
 * nothing is ever narrated twice; a reconnect's replayed history is not new activity; and the log
 * holds at most the newest 100 entries, in memory and nowhere else.
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
  endedAt: '2026-07-11T21:30:00.000Z',
  taskCount: 2,
  cast: [
    {
      handle: 'term_a38d266c-0000-4000-8000-000000000001',
      monogram: 'A1',
      taskIds: ['task_build'],
      taskCount: 1,
      lastHeartbeatAt: null,
    },
    {
      handle: 'term_fd18853c-0000-4000-8000-000000000002',
      monogram: 'A2',
      taskIds: [],
      taskCount: 0,
      lastHeartbeatAt: null,
    },
  ],
  waves: [],
  statusCounts: { pending: 1, ready: 0, dispatched: 1, completed: 0, failed: 0, blocked: 0 },
  live: true,
  hasOpenGates: false,
  edgeCount: 0,
};

function task(over: Partial<Task> & { id: string }): Task {
  return {
    runId: RUN.id,
    parentId: null,
    title: over.id,
    status: 'pending',
    deps: [],
    createdAt: '2026-07-11T20:54:00.000Z',
    completedAt: null,
    hasSpec: true,
    hasResult: false,
    dispatch: null,
    attemptCount: 0,
    gate: null,
    ...over,
  };
}

function dispatch(over: Partial<Dispatch> & { id: string; assigneeHandle: string }): Dispatch {
  return {
    status: 'dispatched',
    failureCount: 0,
    lastFailure: null,
    dispatchedAt: '2026-07-11T20:55:00.000Z',
    completedAt: null,
    lastHeartbeatAt: null,
    ...over,
  };
}

function message(over: Partial<FeedMessage> & { sequence: number; type: string }): FeedMessage {
  return {
    id: `msg_${over.sequence}`,
    fromHandle: 'term_a38d266c-0000-4000-8000-000000000001',
    toHandle: RUN.handle!,
    subject: `message ${over.sequence}`,
    body: '',
    priority: 'normal',
    threadId: null,
    payload: null,
    createdAt: '2026-07-11T20:56:00.000Z',
    taskId: null,
    runId: RUN.id,
    ...over,
  };
}

function event(over: Partial<StreamEvent> & { tasks?: Task[] } = {}): StreamEvent {
  return {
    seq: over.seq ?? 10,
    meta: META,
    snapshot: {
      runs: [RUN],
      tasks: over.tasks ?? [],
      gates: [],
      turns: [],
      coordinatorRuns: [],
      ...over.snapshot,
    },
    messages: over.messages ?? [],
  };
}

const T0 = '2026-07-12T09:00:00.000Z';
const T1 = '2026-07-12T09:00:05.000Z';
const T2 = '2026-07-12T09:00:10.000Z';

describe('the baseline', () => {
  it('narrates nothing from the first snapshot, however much history it carries', () => {
    // First connect delivers the whole feed: every task the file holds and every message ever
    // written (`EventStream.subscribe` with since = 0). All of it is pre-session history.
    const first = event({
      seq: 10,
      tasks: [task({ id: 'task_build', status: 'dispatched' }), task({ id: 'task_test' })],
      messages: [message({ sequence: 9, type: 'worker_done' }), message({ sequence: 10, type: 'escalation' })],
    });

    const log = observeActivity(null, first, T0);

    expect(log.entries).toEqual([]);
  });
});

describe('snapshot diffs', () => {
  it('narrates a task status transition, naming both ends of it', () => {
    const before = event({ tasks: [task({ id: 'task_build', title: 'Build it', status: 'dispatched' })] });
    const after = event({ tasks: [task({ id: 'task_build', title: 'Build it', status: 'completed' })] });

    const log = observeActivity(observeActivity(null, before, T0), after, T1);

    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({
      kind: 'status',
      taskId: 'task_build',
      at: T1,
      text: 'Build it · dispatched → completed',
    });
  });

  it('narrates a new dispatch once, as one entry with the agent as its destination', () => {
    const before = event({ tasks: [task({ id: 'task_build', title: 'Build it', status: 'ready' })] });
    const after = event({
      tasks: [
        task({
          id: 'task_build',
          title: 'Build it',
          status: 'dispatched',
          attemptCount: 1,
          dispatch: dispatch({ id: 'ctx_1', assigneeHandle: 'term_a38d266c-0000-4000-8000-000000000001' }),
        }),
      ],
    });

    const log = observeActivity(observeActivity(null, before, T0), after, T1);

    // One entry, not two: "it is now dispatched" and "it was dispatched to A1" are the same
    // fact, and the one with a destination is the one worth keeping.
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({
      id: 'dispatch:ctx_1',
      kind: 'dispatch',
      taskId: 'task_build',
      text: 'Build it · dispatched → A1',
    });
  });

  it('narrates a retry with the attempt number and the fresh assignee', () => {
    const before = event({
      tasks: [
        task({
          id: 'task_build',
          title: 'Build it',
          status: 'failed',
          attemptCount: 1,
          dispatch: dispatch({ id: 'ctx_1', assigneeHandle: 'term_a38d266c-0000-4000-8000-000000000001' }),
        }),
      ],
    });
    const after = event({
      tasks: [
        task({
          id: 'task_build',
          title: 'Build it',
          status: 'dispatched',
          attemptCount: 2,
          dispatch: dispatch({ id: 'ctx_2', assigneeHandle: 'term_fd18853c-0000-4000-8000-000000000002' }),
        }),
      ],
    });

    const log = observeActivity(observeActivity(null, before, T0), after, T1);

    // Again one entry: the retry subsumes the failed → dispatched flip it caused.
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({
      id: 'retry:ctx_2',
      kind: 'retry',
      taskId: 'task_build',
      text: 'Build it · retry, attempt 2 → A2',
    });
  });

  it('narrates both when a dispatch appears and the status has already moved past it', () => {
    // Created, dispatched and finished inside one 5s poll: the arrival into `dispatched` was
    // never on screen, so the dispatch entry and the status entry are two different facts.
    const before = event({ tasks: [task({ id: 'task_build', title: 'Build it', status: 'pending' })] });
    const after = event({
      tasks: [
        task({
          id: 'task_build',
          title: 'Build it',
          status: 'completed',
          attemptCount: 1,
          dispatch: dispatch({ id: 'ctx_1', assigneeHandle: 'term_a38d266c-0000-4000-8000-000000000001' }),
        }),
      ],
    });

    const log = observeActivity(observeActivity(null, before, T0), after, T1);

    expect(log.entries.map((entry) => entry.kind)).toEqual(['dispatch', 'status']);
    expect(log.entries[1]!.text).toBe('Build it · pending → completed');
  });

  it('falls back to the short handle when the assignee is not in any cast', () => {
    const before = event({ tasks: [task({ id: 'task_build', title: 'Build it', status: 'ready' })] });
    const after = event({
      tasks: [
        task({
          id: 'task_build',
          title: 'Build it',
          status: 'dispatched',
          attemptCount: 1,
          dispatch: dispatch({ id: 'ctx_1', assigneeHandle: 'term_0ddba11c-9999-4999-8999-999999999999' }),
        }),
      ],
    });

    const log = observeActivity(observeActivity(null, before, T0), after, T1);

    expect(log.entries[0]!.text).toBe('Build it · dispatched → 0ddba11c');
  });

  it('narrates the dispatch of a task that appeared mid-session already dispatched', () => {
    // Created and handed out between two polls — the commonest single flow there is. The task
    // was never fingerprinted, but its dispatch is still an observed transition.
    const before = event({ tasks: [] });
    const after = event({
      tasks: [
        task({
          id: 'task_new',
          title: 'New work',
          status: 'dispatched',
          attemptCount: 1,
          dispatch: dispatch({ id: 'ctx_9', assigneeHandle: 'term_a38d266c-0000-4000-8000-000000000001' }),
        }),
      ],
    });

    const log = observeActivity(observeActivity(null, before, T0), after, T1);

    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ id: 'dispatch:ctx_9', kind: 'dispatch' });
  });

  it('says nothing about a task that appears undispatched — narration starts at its first transition', () => {
    // Creation is not one of the three transitions the ticket names, and the from-state was
    // never observed. The moment it dispatches or changes status, the ticker picks it up.
    const before = event({ tasks: [] });
    const created = event({ tasks: [task({ id: 'task_new', status: 'pending' })] });
    const promoted = event({ tasks: [task({ id: 'task_new', status: 'ready' })] });

    const quiet = observeActivity(observeActivity(null, before, T0), created, T1);
    expect(quiet.entries).toEqual([]);

    const log = observeActivity(quiet, promoted, T2);
    expect(log.entries.map((entry) => entry.text)).toEqual(['task_new · pending → ready']);
  });

  it('adds nothing for a repeated identical snapshot', () => {
    const before = event({ tasks: [task({ id: 'task_build', status: 'dispatched' })] });
    const after = event({ tasks: [task({ id: 'task_build', status: 'completed' })] });

    const once = observeActivity(observeActivity(null, before, T0), after, T1);
    const again = observeActivity(once, event({ tasks: [task({ id: 'task_build', status: 'completed' })] }), T2);

    // The same entries, by identity — nothing appended, and nothing for React to re-render.
    expect(again.entries).toBe(once.entries);
  });
});

describe('the message merge', () => {
  it('merges gate, escalation and worker-done deltas into the same chronological list', () => {
    const before = event({ seq: 10, tasks: [task({ id: 'task_build', title: 'Build it', status: 'dispatched' })] });
    const after = event({
      seq: 15,
      tasks: [task({ id: 'task_build', title: 'Build it', status: 'completed' })],
      messages: [
        message({ sequence: 11, type: 'worker_done', subject: 'Done: built it', taskId: 'task_build' }),
        message({ sequence: 12, type: 'heartbeat' }),
        message({ sequence: 13, type: 'escalation', subject: 'Blocked: no db' }),
        message({ sequence: 14, type: 'decision_gate', subject: 'Merge now?' }),
        message({ sequence: 15, type: 'status' }),
      ],
    });

    const log = observeActivity(observeActivity(null, before, T0), after, T1);

    // The three kinds the ticket names — a heartbeat is 65% of all traffic and says only
    // "alive", and a status message is not one of the coherent deltas the ticket merges.
    // Message instants (Orca's own) precede the synthesized transition (observed now).
    expect(log.entries.map((entry) => entry.id)).toEqual(['msg:11', 'msg:13', 'msg:14', 'status:task_build:1']);
    expect(log.entries.map((entry) => entry.kind)).toEqual(['worker_done', 'escalation', 'decision_gate', 'status']);
    expect(log.entries[0]).toMatchObject({ text: 'Done: built it', taskId: 'task_build', at: '2026-07-11T20:56:00.000Z' });
  });

  it('never narrates the same message twice, whatever the stream replays', () => {
    const before = event({ seq: 10, tasks: [] });
    const delta = event({ seq: 11, tasks: [], messages: [message({ sequence: 11, type: 'worker_done' })] });
    const replay = event({ seq: 11, tasks: [], messages: [message({ sequence: 11, type: 'worker_done' })] });

    const once = observeActivity(observeActivity(null, before, T0), delta, T1);
    const again = observeActivity(once, replay, T2);

    expect(once.entries.map((entry) => entry.id)).toEqual(['msg:11']);
    expect(again.entries).toBe(once.entries);
  });
});

describe('reconnect and resync', () => {
  it('narrates nothing from a reconnect that replays the whole feed', () => {
    // A resync from scratch — an `EventSource` that lost its Last-Event-ID, or an explicit
    // refetch — is shaped exactly like a first connect: full snapshot, full message history.
    // None of it is new activity.
    const before = event({
      seq: 10,
      tasks: [task({ id: 'task_build', status: 'dispatched' })],
    });
    const fullReplay = event({
      seq: 10,
      tasks: [task({ id: 'task_build', status: 'dispatched' })],
      messages: [message({ sequence: 9, type: 'worker_done' }), message({ sequence: 10, type: 'escalation' })],
    });

    const log = observeActivity(observeActivity(null, before, T0), fullReplay, T1);

    expect(log.entries).toEqual([]);
  });

  it('still narrates what genuinely happened while the connection was down', () => {
    const before = event({ seq: 10, tasks: [task({ id: 'task_build', title: 'Build it', status: 'dispatched' })] });
    // The reconnect event: everything after the browser's Last-Event-ID, plus the snapshot as
    // it stands now. The change happened mid-session — it is activity, not history.
    const reconnect = event({
      seq: 12,
      tasks: [task({ id: 'task_build', title: 'Build it', status: 'completed' })],
      messages: [message({ sequence: 11, type: 'worker_done', subject: 'Done' }), message({ sequence: 12, type: 'heartbeat' })],
    });

    const log = observeActivity(observeActivity(null, before, T0), reconnect, T1);

    expect(log.entries.map((entry) => entry.id)).toEqual(['msg:11', 'status:task_build:1']);
  });

  it('follows the cursor down after a reset instead of falling silent forever', () => {
    // An `orchestration reset` renumbers messages from 1. The event that reveals it carries
    // sequences below the session's high-water mark — indistinguishable from a replay, so they
    // are not narrated — but the mark must follow the file down, or every message written for
    // the rest of the session would be filtered as a duplicate.
    const before = event({ seq: 10, tasks: [] });
    const reset = event({ seq: 2, tasks: [], messages: [message({ sequence: 2, type: 'worker_done' })] });
    const afterReset = event({ seq: 3, tasks: [], messages: [message({ sequence: 3, type: 'escalation', subject: 'Help' })] });

    const log = observeActivity(
      observeActivity(observeActivity(null, before, T0), reset, T1),
      afterReset,
      T2
    );

    expect(log.entries.map((entry) => entry.id)).toEqual(['msg:r1:3']);
  });

  it('keeps a renumbered message from colliding with a retained pre-reset entry', () => {
    // The reset renumbers sequences from 1, but the ticker keeps its pre-reset entries — they
    // were genuinely observed. A post-reset message reusing an already-narrated sequence must
    // mint a *different* identity, or the list holds two entries under one id (and React two
    // rows under one key).
    const before = event({ seq: 10, tasks: [] });
    const delta = event({ seq: 11, tasks: [], messages: [message({ sequence: 11, type: 'worker_done', subject: 'old 11' })] });
    const reset = event({ seq: 0, tasks: [] });
    const renumbered = event({ seq: 11, tasks: [], messages: [message({ sequence: 11, type: 'worker_done', subject: 'new 11' })] });

    const log = observeActivity(
      observeActivity(observeActivity(observeActivity(null, before, T0), delta, T1), reset, T1),
      renumbered,
      T2
    );

    expect(log.entries.map((entry) => entry.id)).toEqual(['msg:11', 'msg:r1:11']);
    expect(log.entries.map((entry) => entry.text)).toEqual(['old 11', 'new 11']);
  });
});

describe('the bound', () => {
  it(`keeps only the newest ${MAX_ACTIVITY_ENTRIES} entries`, () => {
    let log = observeActivity(null, event({ seq: 0, tasks: [] }), T0);

    // Six pushes of twenty messages each: 120 narratable arrivals.
    for (let push = 0; push < 6; push++) {
      const first = push * 20 + 1;
      const batch = Array.from({ length: 20 }, (_, i) =>
        message({ sequence: first + i, type: 'worker_done', subject: `done ${first + i}` })
      );
      log = observeActivity(log, event({ seq: first + 19, tasks: [], messages: batch }), T1);
    }

    expect(log.entries).toHaveLength(MAX_ACTIVITY_ENTRIES);
    // The *newest* 100: the oldest twenty rolled off the front.
    expect(log.entries[0]!.id).toBe('msg:21');
    expect(log.entries[log.entries.length - 1]!.id).toBe('msg:120');
  });
});
