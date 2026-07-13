import { describe, expect, it } from 'vitest';
import { ATTENTION_FRESHNESS_MS, deriveAttention } from '../../src/client/attention.ts';
import { shortHandle } from '../../src/shared/handles.ts';
import { STALE_HEARTBEAT_MS } from '../../src/shared/run-health.ts';
import type { Dispatch, Gate, Run, StreamEvent, Task, Turn } from '../../src/shared/types.ts';

/**
 * The one pure derivation behind the attention queue (#56, roadmap §12 of #51). It answers the
 * supervisor's first question — *does anything need intervention now?* — from the latest
 * snapshot and a wall-clock instant, and nothing else: no `Date.now()`, no fetch, no session
 * storage. All five causes are backed by durable evidence the snapshot already carries, which is
 * why the derivation needs no session state yet; the roadmap reserves that input for the tickets
 * that genuinely accumulate any (#58's ticker, #60's notification baseline).
 *
 * Asserted here once, at the seam both the shell and the kiosk (#62) will consume: what enters,
 * what never does, how ties break, and that a cause's identity never wobbles between snapshots.
 */

const NOW = Date.parse('2026-07-08T12:00:00.000Z');
const MINUTE = 60_000;

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: 'run_crew',
    handle: 'term_9f8e7d6c-1234-4321-8888-aabbccddeeff',
    label: 'Ship the visualizer',
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

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task_aaaaaaaa',
    runId: 'run_crew',
    parentId: null,
    title: 'A task',
    status: 'dispatched',
    deps: [],
    createdAt: ago(30 * MINUTE),
    completedAt: null,
    hasSpec: true,
    hasResult: false,
    dispatch: null,
    attemptCount: 1,
    gate: null,
    ...over,
  };
}

function dispatch(over: Partial<Dispatch> = {}): Dispatch {
  return {
    id: 'ctx_1',
    assigneeHandle: 'term_agent-1111-4321-8888-aabbccddeeff',
    status: 'dispatched',
    failureCount: 0,
    lastFailure: null,
    dispatchedAt: ago(5 * MINUTE),
    completedAt: null,
    lastHeartbeatAt: ago(MINUTE),
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
    options: ['node:sqlite', 'better-sqlite3'],
    status: 'pending',
    blocking: true,
    resolution: null,
    createdAt: ago(20 * MINUTE),
    ...over,
  };
}

function escalation(over: Partial<Turn> = {}): Turn {
  return {
    id: 'msg:41',
    runId: 'run_crew',
    direction: 'in',
    kind: 'escalation',
    fromHandle: 'term_agent-1111-4321-8888-aabbccddeeff',
    toHandle: 'term_9f8e7d6c-1234-4321-8888-aabbccddeeff',
    at: ago(8 * MINUTE),
    taskId: 'task_aaaaaaaa',
    subject: 'Blocked: cannot reach the registry',
    body: 'npm install fails behind the proxy.',
    source: 'messages',
    ...over,
  };
}

function snapshot(over: Partial<StreamEvent['snapshot']> = {}): StreamEvent['snapshot'] {
  return { runs: [run()], tasks: [task()], gates: [], turns: [], coordinatorRuns: [], ...over };
}

describe('deriveAttention: blocking gates', () => {
  it('admits exactly the blocking tier — lifecycle state alone never enters', () => {
    // #45 separated the lifecycle from the present effect. The queue consumes only the effect:
    // a pending row blocks, an unanswered ask blocks only while its task is provably blocked —
    // and both arrive as `blocking: true`. Resolved, timed-out and merely-unanswered questions
    // are history, not work.
    const items = deriveAttention(
      snapshot({
        gates: [
          gate({ id: 'msg_pending', status: 'pending', blocking: true }),
          gate({ id: 'msg_ask', status: 'unanswered', blocking: true, createdAt: ago(25 * MINUTE) }),
          gate({ id: 'msg_unanswered', status: 'unanswered', blocking: false }),
          gate({ id: 'msg_resolved', status: 'resolved', blocking: false, resolution: 'node:sqlite' }),
          gate({ id: 'msg_timeout', status: 'timeout', blocking: false }),
        ],
      }),
      NOW
    );

    expect(items.map((item) => item.id)).toEqual(['gate:msg_ask', 'gate:msg_pending']);
    expect(items[0]).toMatchObject({
      kind: 'blocking-gate',
      runId: 'run_crew',
      // The run's own name, reused from the snapshot — never re-derived (#48).
      runLabel: 'Ship the visualizer',
      taskId: 'task_aaaaaaaa',
      title: 'Which driver?',
      explanation: 'asked 25m ago — blocking',
    });
  });

  it('orders blocking gates oldest first, unreadable ask instants last', () => {
    const items = deriveAttention(
      snapshot({
        gates: [
          gate({ id: 'g_young', createdAt: ago(2 * MINUTE) }),
          gate({ id: 'g_unreadable', createdAt: 'not a timestamp' }),
          gate({ id: 'g_old', createdAt: ago(40 * MINUTE) }),
        ],
      }),
      NOW
    );

    expect(items.map((item) => item.id)).toEqual(['gate:g_old', 'gate:g_young', 'gate:g_unreadable']);
  });
});

describe('deriveAttention: stale workers', () => {
  const AGENT_A = 'term_agent-aaaa-4321-8888-aabbccddeeff';
  const AGENT_B = 'term_agent-bbbb-4321-8888-aabbccddeeff';

  it('reports stale and never-heartbeating workers by longest silence, reusing the #47 contract', () => {
    const items = deriveAttention(
      snapshot({
        runs: [
          run({
            cast: [
              { handle: AGENT_A, monogram: 'A1', taskIds: ['task_stale'], taskCount: 1, lastHeartbeatAt: ago(14 * MINUTE) },
              { handle: AGENT_B, monogram: 'A2', taskIds: ['task_never'], taskCount: 1, lastHeartbeatAt: null },
            ],
          }),
        ],
        tasks: [
          // Stale: last heartbeat 14 minutes ago.
          task({
            id: 'task_stale',
            title: 'Migrate the layout engine',
            dispatch: dispatch({ id: 'ctx_a', assigneeHandle: AGENT_A, lastHeartbeatAt: ago(14 * MINUTE) }),
          }),
          // Never heartbeat: dispatched 20 minutes ago, no beat ever.
          task({
            id: 'task_never',
            title: 'Benchmark 500 nodes',
            dispatch: dispatch({
              id: 'ctx_b',
              assigneeHandle: AGENT_B,
              dispatchedAt: ago(20 * MINUTE),
              lastHeartbeatAt: null,
            }),
          }),
        ],
      }),
      NOW
    );

    expect(items.map((item) => item.id)).toEqual([
      `worker:run_crew:${AGENT_B}`,
      `worker:run_crew:${AGENT_A}`,
    ]);
    // The row is named for the task the click lands on; the agent is named in the explanation.
    expect(items[0]).toMatchObject({
      kind: 'stale-worker',
      runId: 'run_crew',
      taskId: 'task_never',
      title: 'Benchmark 500 nodes',
      heartbeat: 'missing',
      silenceMs: 20 * MINUTE,
      explanation: 'A2 · dispatched 20m ago · no heartbeat',
    });
    expect(items[1]).toMatchObject({
      kind: 'stale-worker',
      taskId: 'task_stale',
      title: 'Migrate the layout engine',
      heartbeat: 'received',
      silenceMs: 14 * MINUTE,
      explanation: 'A1 · last seen 14m ago',
    });
  });

  it('names a worker the run’s cast does not hold by its short handle', () => {
    // The cast is the server's (SPEC §4.3a) and it is the monogram's only source. A dispatch
    // whose assignee never made it into the cast still has silence worth reporting — it is
    // named by the handle rather than dropped, and never by a monogram invented here.
    const items = deriveAttention(
      snapshot({
        tasks: [
          task({
            id: 'task_orphan_agent',
            dispatch: dispatch({ id: 'ctx_x', assigneeHandle: AGENT_A, lastHeartbeatAt: ago(30 * MINUTE) }),
          }),
        ],
      }),
      NOW
    );

    expect(items[0]?.explanation).toBe(`${shortHandle(AGENT_A)} · last seen 30m ago`);
  });

  it('leaves working, quiet and settled workers out', () => {
    const items = deriveAttention(
      snapshot({
        tasks: [
          // Working: beat a minute ago.
          task({ id: 'task_working', dispatch: dispatch({ id: 'ctx_w', assigneeHandle: AGENT_A }) }),
          // Quiet: dispatched two minutes ago, first beat still plausibly in flight.
          task({
            id: 'task_quiet',
            dispatch: dispatch({
              id: 'ctx_q',
              assigneeHandle: AGENT_B,
              dispatchedAt: ago(2 * MINUTE),
              lastHeartbeatAt: null,
            }),
          }),
          // Settled: a completed attempt is history, not a worker-health warning (#47).
          task({
            id: 'task_done',
            status: 'completed',
            dispatch: dispatch({
              id: 'ctx_s',
              assigneeHandle: 'term_agent-cccc-4321-8888-aabbccddeeff',
              status: 'completed',
              dispatchedAt: ago(120 * MINUTE),
              completedAt: ago(90 * MINUTE),
              lastHeartbeatAt: ago(90 * MINUTE),
            }),
          }),
        ],
      }),
      NOW
    );

    expect(items).toEqual([]);
  });

  it('keeps one item per worker per run, anchored to its freshest active evidence', () => {
    // The same #47 rule the cast row uses: among a worker's active attempts, the freshest
    // evidence speaks for it. Two stale tasks are one silent worker, not two queue rows.
    const items = deriveAttention(
      snapshot({
        tasks: [
          task({
            id: 'task_older_evidence',
            dispatch: dispatch({ id: 'ctx_1', assigneeHandle: AGENT_A, lastHeartbeatAt: ago(30 * MINUTE) }),
          }),
          task({
            id: 'task_fresher_evidence',
            dispatch: dispatch({ id: 'ctx_2', assigneeHandle: AGENT_A, lastHeartbeatAt: ago(12 * MINUTE) }),
          }),
        ],
      }),
      NOW
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: `worker:run_crew:${AGENT_A}`,
      taskId: 'task_fresher_evidence',
      silenceMs: 12 * MINUTE,
    });
  });
});

describe('deriveAttention: retry risk', () => {
  it('admits current attempts with failureCount >= 2 on unfinished work, highest count first', () => {
    const items = deriveAttention(
      snapshot({
        tasks: [
          task({
            id: 'task_two',
            title: 'Flaky build',
            dispatch: dispatch({ id: 'ctx_two', failureCount: 2, lastFailure: ago(3 * MINUTE) }),
          }),
          task({
            id: 'task_broken',
            title: 'Broken deploy',
            status: 'blocked',
            dispatch: dispatch({
              id: 'ctx_broken',
              status: 'circuit_broken',
              failureCount: 3,
              lastFailure: ago(6 * MINUTE),
            }),
          }),
          task({ id: 'task_once', dispatch: dispatch({ id: 'ctx_once', failureCount: 1 }) }),
        ],
      }),
      NOW
    );

    const retries = items.filter((item) => item.kind === 'retry-risk');
    expect(retries.map((item) => item.id)).toEqual(['retry:task_broken:ctx_broken', 'retry:task_two:ctx_two']);
    expect(retries[0]).toMatchObject({
      failureCount: 3,
      title: 'Broken deploy',
      explanation: 'circuit broken after 3 failures',
    });
    expect(retries[1]).toMatchObject({
      failureCount: 2,
      explanation: '2 failures — the breaker trips at 3',
    });
  });

  it('leaves with its evidence: a terminal task carries no retry risk', () => {
    const items = deriveAttention(
      snapshot({
        tasks: [
          task({
            id: 'task_done',
            status: 'completed',
            dispatch: dispatch({ id: 'ctx_d', status: 'completed', failureCount: 2, completedAt: ago(MINUTE) }),
          }),
          task({
            id: 'task_failed',
            status: 'failed',
            completedAt: ago(60 * MINUTE),
            dispatch: dispatch({ id: 'ctx_f', status: 'failed', failureCount: 2, lastFailure: ago(60 * MINUTE) }),
          }),
        ],
      }),
      NOW
    );

    expect(items.filter((item) => item.kind === 'retry-risk')).toEqual([]);
  });
});

describe('deriveAttention: escalations', () => {
  it('persists an unresolved escalation with no freshness window', () => {
    // Hours old is still unresolved: the whole point (#56) is that a request for help cannot
    // age out behind a one-second pulse.
    const items = deriveAttention(
      snapshot({ turns: [escalation({ at: ago(5 * 60 * MINUTE) })] }),
      NOW
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'escalation',
      id: 'escalation:msg:41',
      runId: 'run_crew',
      taskId: 'task_aaaaaaaa',
      title: 'Blocked: cannot reach the registry',
      explanation: 'escalated 5h ago',
    });
  });

  it('leaves when its task reaches a terminal state', () => {
    for (const status of ['completed', 'failed']) {
      const items = deriveAttention(
        snapshot({ tasks: [task({ status, completedAt: ago(MINUTE) })], turns: [escalation()] }),
        NOW
      );
      expect(items.filter((item) => item.kind === 'escalation')).toEqual([]);
    }
  });

  it('leaves when a later dispatch attempt begins, and only then', () => {
    // The escalation came out of the attempt that was running at ago(8m). A retry that started
    // after it supersedes it; the attempt it came from does not.
    const superseded = deriveAttention(
      snapshot({
        tasks: [task({ dispatch: dispatch({ id: 'ctx_retry', dispatchedAt: ago(2 * MINUTE) }) })],
        turns: [escalation({ at: ago(8 * MINUTE) })],
      }),
      NOW
    );
    expect(superseded.filter((item) => item.kind === 'escalation')).toEqual([]);

    const sameAttempt = deriveAttention(
      snapshot({
        tasks: [task({ dispatch: dispatch({ id: 'ctx_orig', dispatchedAt: ago(20 * MINUTE) }) })],
        turns: [escalation({ at: ago(8 * MINUTE) })],
      }),
      NOW
    );
    expect(sameAttempt.filter((item) => item.kind === 'escalation')).toHaveLength(1);
  });

  it('never lets an orphaned historical message demand intervention', () => {
    const items = deriveAttention(
      snapshot({
        turns: [
          // No task named: nothing current to intervene on.
          escalation({ id: 'msg:50', taskId: null }),
          // Names a task the snapshot no longer holds.
          escalation({ id: 'msg:51', taskId: 'task_gone' }),
        ],
      }),
      NOW
    );

    expect(items).toEqual([]);
  });

  it('orders unresolved escalations oldest first', () => {
    const items = deriveAttention(
      snapshot({
        turns: [
          escalation({ id: 'msg:60', at: ago(3 * MINUTE) }),
          escalation({ id: 'msg:61', at: ago(9 * MINUTE) }),
        ],
      }),
      NOW
    );

    expect(items.map((item) => item.id)).toEqual(['escalation:msg:61', 'escalation:msg:60']);
  });
});

describe('deriveAttention: fresh failures', () => {
  it('admits recent failures newest first and ages them out at the shared freshness window', () => {
    const items = deriveAttention(
      snapshot({
        tasks: [
          task({ id: 'task_3m', title: 'Newest wreck', status: 'failed', completedAt: ago(3 * MINUTE) }),
          task({ id: 'task_8m', status: 'failed', completedAt: ago(8 * MINUTE) }),
          // The boundary is exact, like every recency rule in this tool: at the window, stale.
          task({ id: 'task_at_window', status: 'failed', completedAt: ago(ATTENTION_FRESHNESS_MS) }),
        ],
      }),
      NOW
    );

    expect(items.map((item) => item.id)).toEqual(['failure:task_3m', 'failure:task_8m']);
    expect(items[0]).toMatchObject({
      kind: 'fresh-failure',
      title: 'Newest wreck',
      explanation: 'failed 3m ago',
    });
  });

  it('reads the newest evidence across the task row and its surviving attempt', () => {
    // A failed task whose `completed_at` never filled still has the attempt's `last_failure`.
    const items = deriveAttention(
      snapshot({
        tasks: [
          task({
            id: 'task_attempt_evidence',
            status: 'failed',
            completedAt: null,
            dispatch: dispatch({ id: 'ctx_f', status: 'failed', failureCount: 1, lastFailure: ago(4 * MINUTE) }),
          }),
        ],
      }),
      NOW
    );

    expect(items.map((item) => item.id)).toEqual(['failure:task_attempt_evidence']);
  });

  it('cannot call a failure fresh without a readable instant', () => {
    const items = deriveAttention(
      snapshot({ tasks: [task({ id: 'task_undated', status: 'failed', completedAt: null, dispatch: null })] }),
      NOW
    );

    expect(items).toEqual([]);
  });

  it('shares the canonical freshness window rather than inventing a second one', () => {
    expect(ATTENTION_FRESHNESS_MS).toBe(STALE_HEARTBEAT_MS);
  });
});

describe('deriveAttention: ranking and identity', () => {
  const AGENT = 'term_agent-aaaa-4321-8888-aabbccddeeff';

  /** One of each cause, all live at NOW, spread across two runs. */
  function crowdedSnapshot(): StreamEvent['snapshot'] {
    return snapshot({
      runs: [run(), run({ id: 'run_other', handle: 'term_other-2222-4321-8888-aabbccddeeff' })],
      tasks: [
        task({ id: 'task_gated', status: 'blocked' }),
        task({
          id: 'task_silent',
          runId: 'run_other',
          dispatch: dispatch({ id: 'ctx_silent', assigneeHandle: AGENT, lastHeartbeatAt: ago(15 * MINUTE) }),
        }),
        task({ id: 'task_retry', dispatch: dispatch({ id: 'ctx_retry', failureCount: 2, lastFailure: ago(MINUTE) }) }),
        task({ id: 'task_escalated', dispatch: dispatch({ id: 'ctx_esc', dispatchedAt: ago(30 * MINUTE) }) }),
        task({ id: 'task_wrecked', status: 'failed', completedAt: ago(2 * MINUTE) }),
      ],
      gates: [gate({ taskId: 'task_gated' })],
      turns: [escalation({ taskId: 'task_escalated', at: ago(6 * MINUTE) })],
    });
  }

  it('ranks tiers in the approved precedence', () => {
    const items = deriveAttention(crowdedSnapshot(), NOW);

    expect(items.map((item) => item.kind)).toEqual([
      'blocking-gate',
      'stale-worker',
      'retry-risk',
      'escalation',
      'fresh-failure',
    ]);
  });

  it('breaks remaining ties on the stable id', () => {
    const items = deriveAttention(
      snapshot({
        gates: [
          gate({ id: 'g_b', createdAt: ago(5 * MINUTE) }),
          gate({ id: 'g_a', createdAt: ago(5 * MINUTE) }),
        ],
      }),
      NOW
    );

    expect(items.map((item) => item.id)).toEqual(['gate:g_a', 'gate:g_b']);
  });

  it('lets distinct causes for one task coexist without a lossy merge', () => {
    const items = deriveAttention(
      snapshot({
        tasks: [
          task({
            id: 'task_everything',
            dispatch: dispatch({ id: 'ctx_e', failureCount: 2, dispatchedAt: ago(30 * MINUTE), lastHeartbeatAt: ago(11 * MINUTE) }),
          }),
        ],
        gates: [gate({ taskId: 'task_everything' })],
        turns: [escalation({ taskId: 'task_everything', at: ago(6 * MINUTE) })],
      }),
      NOW
    );

    expect(items.map((item) => item.kind)).toEqual(['blocking-gate', 'stale-worker', 'retry-risk', 'escalation']);
    expect(items.every((item) => item.taskId === 'task_everything')).toBe(true);
  });

  it('derives the same identities from repeated snapshots — a cause never duplicates', () => {
    const first = deriveAttention(crowdedSnapshot(), NOW);
    const second = deriveAttention(crowdedSnapshot(), NOW + 30_000);

    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
    expect(new Set(first.map((item) => item.id)).size).toBe(first.length);
  });
});
