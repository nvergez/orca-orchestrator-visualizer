import { describe, expect, it } from 'vitest';
import { unfinishedRuns } from '../../src/client/kiosk/unfinished.ts';
import { STALE_HEARTBEAT_MS } from '../../src/shared/run-health.ts';
import type { CastMember, Dispatch, Gate, Run, StreamEvent, Task } from '../../src/shared/types.ts';

/**
 * The kiosk's one derivation (#62), at its pure seam: a snapshot and a wall-clock instant in,
 * the tiles a wall display draws out.
 *
 * It owns **no facts of its own**. What is unfinished is #48's `runHealth`; how a run's workers
 * are doing is #47's, aggregated by the same `runWorkerSummary` the rail row wears; and what is
 * blocking is #45's `Gate.blocking` and nothing else. What this suite pins is the *selection and
 * the ranking* — that a finished run is never a tile however loud it was, that a silent run comes
 * before an active one, and that a tile can only claim an age it can actually measure.
 */

const NOW = Date.parse('2026-07-13T12:00:00.000Z');

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

const MINUTE = 60_000;

function member(over: Partial<CastMember> & { handle: string }): CastMember {
  return { monogram: 'A1', taskIds: [], taskCount: 0, lastHeartbeatAt: null, ...over };
}

function run(over: Partial<Run> & { id: string }): Run {
  return {
    handle: `term_${over.id}`,
    label: over.id,
    startedAt: ago(60 * MINUTE),
    lastActivityAt: ago(MINUTE),
    converged: false,
    endedAt: ago(MINUTE),
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

function dispatch(over: Partial<Dispatch> = {}): Dispatch {
  return {
    id: 'dispatch_1',
    assigneeHandle: 'term_agent_1',
    status: 'dispatched',
    failureCount: 0,
    lastFailure: null,
    dispatchedAt: ago(MINUTE),
    completedAt: null,
    lastHeartbeatAt: ago(MINUTE),
    ...over,
  };
}

function task(over: Partial<Task> & { id: string; runId: string }): Task {
  return {
    parentId: null,
    title: over.id,
    status: 'dispatched',
    deps: [],
    createdAt: ago(30 * MINUTE),
    completedAt: null,
    hasSpec: false,
    hasResult: false,
    dispatch: null,
    attemptCount: 1,
    gate: null,
    ...over,
  };
}

function gate(over: Partial<Gate> & { id: string; runId: string }): Gate {
  return {
    messageId: null,
    taskId: null,
    question: 'Ship it?',
    options: [],
    status: 'pending',
    blocking: true,
    resolution: null,
    createdAt: ago(5 * MINUTE),
    ...over,
  };
}

function snapshot(over: Partial<StreamEvent['snapshot']> = {}): StreamEvent['snapshot'] {
  return { runs: [], tasks: [], gates: [], turns: [], coordinatorRuns: [], ...over };
}

describe('the kiosk tiles', () => {
  it('shows only what #48 calls unfinished — a converged run is never a tile', () => {
    // However recently it finished. `converged` is a fact about task outcomes, not about the
    // clock, and a wall display asking "what needs me now" has nothing to say about a run that
    // has already ended (#48, SPEC §12.3).
    const tiles = unfinishedRuns(
      snapshot({
        runs: [
          run({ id: 'done', converged: true, lastActivityAt: ago(1000) }),
          run({ id: 'working', converged: false }),
        ],
      }),
      NOW
    );

    expect(tiles.map((tile) => tile.run.id)).toEqual(['working']);
  });

  it('distinguishes an active run from a silent one on the same evidence the rail uses', () => {
    const tiles = unfinishedRuns(
      snapshot({
        runs: [
          run({ id: 'fresh', lastActivityAt: ago(MINUTE) }),
          run({ id: 'quiet', lastActivityAt: ago(STALE_HEARTBEAT_MS + MINUTE) }),
        ],
      }),
      NOW
    );

    expect(new Map(tiles.map((tile) => [tile.run.id, tile.health]))).toEqual(
      new Map([
        ['fresh', 'active'],
        ['quiet', 'silent'],
      ])
    );
  });

  it('puts the silent runs first, longest silence first, then the active ones, freshest first', () => {
    // The one ranking the kiosk owns, and it ranks *orchestrations* — which is a different
    // question from the attention queue's ranking of *causes*, standing right beside it. A run
    // nothing is proving is moving is the one a supervisor has to look at first.
    const tiles = unfinishedRuns(
      snapshot({
        runs: [
          run({ id: 'active-old', lastActivityAt: ago(9 * MINUTE) }),
          run({ id: 'silent-recent', lastActivityAt: ago(STALE_HEARTBEAT_MS + MINUTE) }),
          run({ id: 'active-new', lastActivityAt: ago(MINUTE) }),
          run({ id: 'silent-ancient', lastActivityAt: ago(4 * STALE_HEARTBEAT_MS) }),
        ],
      }),
      NOW
    );

    expect(tiles.map((tile) => tile.run.id)).toEqual([
      'silent-ancient',
      'silent-recent',
      'active-new',
      'active-old',
    ]);
  });

  it('queues a run whose last-activity instant does not parse behind every silence it can measure', () => {
    // It is silent — an unfinished run with no readable evidence has no *recent* evidence
    // (`runHealth`) — but it cannot claim to be the longest silence on the wall, because nobody
    // can say how long it has been silent. The queue's rule for an unreadable instant, verbatim.
    const tiles = unfinishedRuns(
      snapshot({
        runs: [
          run({ id: 'unreadable', lastActivityAt: 'yesterday, probably' }),
          run({ id: 'silent', lastActivityAt: ago(2 * STALE_HEARTBEAT_MS) }),
        ],
      }),
      NOW
    );

    expect(tiles.map((tile) => tile.run.id)).toEqual(['silent', 'unreadable']);
    expect(tiles.map((tile) => tile.health)).toEqual(['silent', 'silent']);
    expect(tiles[0]?.silenceMs).toBe(2 * STALE_HEARTBEAT_MS);
    expect(tiles[1]?.silenceMs).toBeNull();
  });

  it('wears the worst current worker health in the cast, not the freshest', () => {
    // The inversion that matters (#47): a *worker* speaks with its freshest attempt, and a *run*
    // speaks with its worst worker — one silent agent among four is exactly the fact the wall
    // exists to show, and an average would bury it.
    const tiles = unfinishedRuns(
      snapshot({
        runs: [
          run({
            id: 'crew',
            cast: [member({ handle: 'term_agent_1' }), member({ handle: 'term_agent_2', monogram: 'A2' })],
          }),
        ],
        tasks: [
          task({ id: 'task_beating', runId: 'crew', dispatch: dispatch({ assigneeHandle: 'term_agent_1' }) }),
          task({
            id: 'task_quiet',
            runId: 'crew',
            dispatch: dispatch({
              id: 'dispatch_2',
              assigneeHandle: 'term_agent_2',
              lastHeartbeatAt: ago(STALE_HEARTBEAT_MS + MINUTE),
            }),
          }),
        ],
      }),
      NOW
    );

    expect(tiles[0]?.workers).toEqual({ state: 'stale', parts: ['1 stale', '1 active'] });
  });

  it('claims no worker health at all when no attempt is currently running', () => {
    // A run whose every attempt has settled has no *current* worker health, and the honest tile
    // says nothing rather than inventing a colour for it.
    const tiles = unfinishedRuns(
      snapshot({
        runs: [run({ id: 'idle', cast: [member({ handle: 'term_agent_1' })] })],
        tasks: [
          task({
            id: 'task_done',
            runId: 'idle',
            status: 'completed',
            dispatch: dispatch({ status: 'completed', completedAt: ago(MINUTE) }),
          }),
        ],
      }),
      NOW
    );

    expect(tiles[0]?.workers).toBeNull();
  });

  it('reports the oldest *blocking* gate, and never a merely unanswered one', () => {
    // #45's whole point: a question's lifecycle state and its present blocking effect are two
    // facts. `blocking` is the only one a wall may act on — an unanswered ask on a task that is
    // not blocked has stopped nothing (SPEC §4.5).
    const tiles = unfinishedRuns(
      snapshot({
        runs: [run({ id: 'gated', hasBlockingGates: true })],
        gates: [
          gate({ id: 'gate_recent', runId: 'gated', createdAt: ago(2 * MINUTE), question: 'Recent?' }),
          gate({ id: 'gate_oldest', runId: 'gated', createdAt: ago(20 * MINUTE), question: 'Oldest?' }),
          gate({
            id: 'gate_ancient_unanswered',
            runId: 'gated',
            createdAt: ago(600 * MINUTE),
            blocking: false,
            status: 'timeout',
            question: 'Never answered, blocking nothing?',
          }),
        ],
      }),
      NOW
    );

    expect(tiles[0]?.gate).toEqual({
      question: 'Oldest?',
      at: ago(20 * MINUTE),
      waitedMs: 20 * MINUTE,
      taskId: null,
    });
  });

  it('shows a blocking gate whose ask instant does not parse, and claims no age for it', () => {
    // It blocks — that is #45's flag, and the flag does not depend on a timestamp. What cannot be
    // measured is how long it has waited, and a tile that rendered "NaN" there would be inventing
    // the one number a supervisor would act on (render-what-parses, SPEC §5).
    const tiles = unfinishedRuns(
      snapshot({
        runs: [run({ id: 'gated', hasBlockingGates: true })],
        gates: [gate({ id: 'gate_broken', runId: 'gated', createdAt: 'some time ago' })],
      }),
      NOW
    );

    expect(tiles[0]?.gate).toEqual({
      question: 'Ship it?',
      at: 'some time ago',
      waitedMs: null,
      taskId: null,
    });
  });

  it('leaves the gate null when nothing is provably blocking the run', () => {
    const tiles = unfinishedRuns(
      snapshot({
        runs: [run({ id: 'open' })],
        gates: [gate({ id: 'gate_answered', runId: 'open', blocking: false, status: 'resolved' })],
      }),
      NOW
    );

    expect(tiles[0]?.gate).toBeNull();
  });
});
