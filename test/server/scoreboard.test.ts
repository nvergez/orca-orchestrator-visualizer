import { afterEach, describe, expect, it } from 'vitest';
import { agentSpan, failureTotal, timeToFirstHeartbeat } from '../../src/server/scoreboard.ts';
import type { CastMember, Dispatch, Run } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * The per-agent scoreboard (#68, SPEC §14.4): the cast, quantified — what each member of one
 * orchestrator's cast cost and produced, derived from **all retained attempts and attributed
 * messages** and never from a guess.
 *
 * The honesty rules are the feature, and every one of them is a test below:
 *
 * - an agent's elapsed span runs first dispatch → latest retained completion, is *open* ("so
 *   far") while work is in flight, and is **absent** when the endpoints cannot carry it;
 * - time to first heartbeat is measured from the first dispatch, and **no retained heartbeat
 *   is unknown — never zero**;
 * - message counts exclude heartbeats, which are counted on their own;
 * - failures sum the **maximum** cumulative `failure_count` per task, never the sum across
 *   retry rows — a breaker that counted to 3 failed three times, not six;
 * - escalations are *attributed* escalation messages, and an ambiguous message counts nowhere;
 * - outcome links are deduplicated recognized receipt URLs (#67's readers, re-used verbatim).
 *
 * The pure seam walks the dense error surfaces value by value (SPEC §14.5); the HTTP seam
 * covers single-agent, multi-agent, retried, ambiguous-attribution and missing-evidence runs
 * against real fixture databases, exactly as `curl` would see them.
 */

const DISPATCHED = '2026-07-08T12:00:00.000Z';
const COMPLETED = '2026-07-08T12:25:00.000Z';

function attempt(over: Partial<Dispatch> = {}): Dispatch {
  return {
    id: 'ctx_aaaaaaaaaaaa',
    assigneeHandle: 'term_1a2b3c4d-1234-4321-8888-aabbccddeeff',
    status: 'completed',
    failureCount: 0,
    lastFailure: null,
    dispatchedAt: DISPATCHED,
    completedAt: COMPLETED,
    lastHeartbeatAt: null,
    ...over,
  };
}

describe('the agent span', () => {
  it('runs from the first dispatch to the latest retained completion, across attempts', () => {
    const observation = agentSpan([
      attempt({ dispatchedAt: '2026-07-08T12:10:00.000Z', completedAt: '2026-07-08T12:20:00.000Z' }),
      attempt({ dispatchedAt: '2026-07-08T12:00:00.000Z', completedAt: '2026-07-08T12:05:00.000Z' }),
      attempt({ dispatchedAt: '2026-07-08T12:30:00.000Z', completedAt: '2026-07-08T13:00:00.000Z' }),
    ]);

    expect(observation).toEqual({
      clock: 'agent-span',
      startAt: '2026-07-08T12:00:00.000Z',
      endAt: '2026-07-08T13:00:00.000Z',
      complete: true,
      ms: 60 * 60 * 1000,
    });
  });

  it('stays open — "so far" — while any of the agent’s attempts is still in flight', () => {
    const observation = agentSpan([
      attempt(),
      attempt({ status: 'dispatched', dispatchedAt: '2026-07-08T12:30:00.000Z', completedAt: null }),
    ]);

    expect(observation).toEqual({ clock: 'agent-span', startAt: DISPATCHED, complete: false });
  });

  it('is absent when no dispatch instant is readable — never zero, never the epoch', () => {
    expect(agentSpan([attempt({ dispatchedAt: '' })])).toBeUndefined();
    expect(agentSpan([attempt({ dispatchedAt: 'whenever' })])).toBeUndefined();
    expect(agentSpan([])).toBeUndefined();
  });

  it('is absent when the work stopped but no completion was retained', () => {
    // The statuses say the attempts closed; the rows do not say when. "So far" would claim
    // work still running, and any end this tool picked would be invented.
    expect(agentSpan([attempt({ status: 'failed', completedAt: null })])).toBeUndefined();
  });

  it('reads past an unreadable completion to the latest readable one', () => {
    const observation = agentSpan([
      attempt({ completedAt: 'whenever' }),
      attempt({ dispatchedAt: '2026-07-08T12:05:00.000Z', completedAt: '2026-07-08T12:15:00.000Z' }),
    ]);

    expect(observation).toMatchObject({ complete: true, endAt: '2026-07-08T12:15:00.000Z' });
  });

  it('refuses a span that ends before it starts — a contradiction is not a duration', () => {
    expect(
      agentSpan([attempt({ dispatchedAt: '2026-07-08T12:30:00.000Z', completedAt: '2026-07-08T12:00:00.000Z' })])
    ).toBeUndefined();
  });
});

describe('time to first heartbeat', () => {
  it('is the earliest attributed heartbeat minus the first dispatch', () => {
    const observation = timeToFirstHeartbeat(
      [attempt(), attempt({ dispatchedAt: '2026-07-08T12:10:00.000Z' })],
      ['2026-07-08T12:07:00.000Z', '2026-07-08T12:03:00.000Z']
    );

    expect(observation).toEqual({
      clock: 'first-heartbeat',
      startAt: DISPATCHED,
      endAt: '2026-07-08T12:03:00.000Z',
      complete: true,
      ms: 3 * 60 * 1000,
    });
  });

  it('is unknown when no heartbeat was retained — never zero', () => {
    expect(timeToFirstHeartbeat([attempt()], [])).toBeUndefined();
  });

  it('is unknown when the beats or the dispatch cannot be read', () => {
    expect(timeToFirstHeartbeat([attempt({ dispatchedAt: 'whenever' })], ['2026-07-08T12:03:00.000Z'])).toBeUndefined();
    expect(timeToFirstHeartbeat([attempt()], ['whenever'])).toBeUndefined();
  });

  it('refuses a heartbeat from before the dispatch — two clocks in contradiction measure nothing', () => {
    expect(timeToFirstHeartbeat([attempt()], ['2026-07-08T11:00:00.000Z'])).toBeUndefined();
  });
});

describe('the failure total', () => {
  it('sums the maximum cumulative failure_count per task — retry rows are not double-counted', () => {
    // The column is cumulative on a task's attempts: 2 then 3 is three failures, not five.
    expect(
      failureTotal([
        [attempt({ failureCount: 2 }), attempt({ failureCount: 3 })],
        [attempt({ failureCount: 1 })],
      ])
    ).toBe(4);
  });

  it('is zero for an agent whose attempts never failed', () => {
    expect(failureTotal([[attempt()], [attempt()]])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The HTTP seam: the scoreboard as `curl` sees it, on the snapshot's cast.
// ---------------------------------------------------------------------------

const COORDINATOR = handleFor('coordinator');
const FIRST_AGENT = handleFor('agent-first');
const SECOND_AGENT = handleFor('agent-second');

const RUN_ID = `run_${COORDINATOR}`;

function at(minutes: number): Date {
  return new Date(Date.parse('2026-07-08T12:00:00.000Z') + minutes * 60_000);
}

function iso(minutes: number): string {
  return at(minutes).toISOString();
}

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function castOfRun(dbPath: string, runId: string = RUN_ID): Promise<CastMember[]> {
  harness = await serve(dbPath);
  const event = await harness.snapshot();
  const run = event.snapshot.runs.find((candidate: Run) => candidate.id === runId);
  if (!run) throw new Error(`no run ${runId} on the wire`);
  return run.cast;
}

function member(cast: CastMember[], handle: string): CastMember {
  const found = cast.find((candidate) => candidate.handle === handle);
  if (!found) throw new Error(`no cast member ${handle}`);
  return found;
}

/** Two agents, one run: the comparison the scoreboard exists for. */
function multiAgentRun(): FixtureBuilder {
  return (
    new FixtureBuilder()
      .task({
        id: 'task_alpha',
        handle: COORDINATOR,
        title: 'Chart the map',
        status: 'completed',
        createdAt: at(0),
        completedAt: at(40),
        result: JSON.stringify({ pr: 'https://github.com/x/y/pull/1', branch: 'work/alpha' }),
      })
      .dispatch({ taskId: 'task_alpha', assigneeHandle: FIRST_AGENT, status: 'completed', dispatchedAt: at(1), completedAt: at(31) })
      .task({ id: 'task_beta', handle: COORDINATOR, title: 'Build the thing', status: 'dispatched', createdAt: at(2) })
      .dispatch({ taskId: 'task_beta', assigneeHandle: SECOND_AGENT, status: 'dispatched', dispatchedAt: at(5) })
      // The first agent beats twice, reports once, and hands back a receipt naming a second URL
      // plus the one the task result already named — the link must arrive deduplicated.
      .message({ fromHandle: FIRST_AGENT, toHandle: COORDINATOR, subject: 'alive', type: 'heartbeat', payload: { taskId: 'task_alpha' }, createdAt: at(3) })
      .message({ fromHandle: FIRST_AGENT, toHandle: COORDINATOR, subject: 'alive', type: 'heartbeat', payload: { taskId: 'task_alpha' }, createdAt: at(8) })
      .message({ fromHandle: FIRST_AGENT, toHandle: COORDINATOR, subject: 'progress', type: 'status', payload: { taskId: 'task_alpha' }, createdAt: at(10) })
      .message({
        fromHandle: FIRST_AGENT,
        toHandle: COORDINATOR,
        subject: 'done',
        type: 'worker_done',
        payload: { taskId: 'task_alpha', pr: 'https://github.com/x/y/pull/1', report: 'https://ci.example.com/build/7' },
        createdAt: at(31),
      })
      // The second agent never beats; it escalates once.
      .message({ fromHandle: SECOND_AGENT, toHandle: COORDINATOR, subject: 'blocked', type: 'escalation', payload: { taskId: 'task_beta' }, createdAt: at(12) })
  );
}

describe('the scoreboard on the wire — a multi-agent run', () => {
  it('spans each agent from its first dispatch, open where the work is, closed where it finished', async () => {
    const cast = await castOfRun(multiAgentRun().write(tempDbPath()));

    expect(member(cast, FIRST_AGENT).score?.span).toEqual({
      clock: 'agent-span',
      startAt: iso(1),
      endAt: iso(31),
      complete: true,
      ms: 30 * 60_000,
    });

    // Still out there: a start and no end, which the client ages as "so far".
    expect(member(cast, SECOND_AGENT).score?.span).toEqual({
      clock: 'agent-span',
      startAt: iso(5),
      complete: false,
    });
  });

  it('measures time to first heartbeat from the first dispatch — and unknown, not zero, without one', async () => {
    const cast = await castOfRun(multiAgentRun().write(tempDbPath()));

    expect(member(cast, FIRST_AGENT).score?.firstHeartbeat).toEqual({
      clock: 'first-heartbeat',
      startAt: iso(1),
      endAt: iso(3),
      complete: true,
      ms: 2 * 60_000,
    });

    // No retained heartbeat: the fact is absent, never `0` (SPEC §14.4).
    expect(member(cast, SECOND_AGENT).score?.firstHeartbeat).toBeUndefined();
  });

  it('counts heartbeats on their own and every other attributed message beside them', async () => {
    const cast = await castOfRun(multiAgentRun().write(tempDbPath()));

    // 2 heartbeats, and 2 messages that are not heartbeats (the status and the worker_done).
    expect(member(cast, FIRST_AGENT).score).toMatchObject({ heartbeats: 2, messages: 2, escalations: 0 });

    // The escalation is a message too — counted once as a message, once as an escalation.
    expect(member(cast, SECOND_AGENT).score).toMatchObject({ heartbeats: 0, messages: 1, escalations: 1 });
  });

  it('links each agent to its recognized outcomes, deduplicated across both evidence sources', async () => {
    const cast = await castOfRun(multiAgentRun().write(tempDbPath()));

    // The PR URL appears in `tasks.result` *and* the worker_done payload — one link, not two.
    expect(member(cast, FIRST_AGENT).score?.outcomeLinks).toEqual([
      'https://github.com/x/y/pull/1',
      'https://ci.example.com/build/7',
    ]);

    // Read, and named no link: an empty list is a **measured zero**, and it is a different fact
    // from the absent list a database that cannot read receipts produces (below).
    expect(member(cast, SECOND_AGENT).score?.outcomeLinks).toEqual([]);
  });

  it('caps the links it puts on a re-sent snapshot, and says how many it cut', async () => {
    // The one ingredient of a scorecard that grows without limit is a URL an agent *typed*
    // (SPEC §6.3). Nine of them cost eight and a count, exactly as a turn's receipt does.
    // A link is recognized by its *value* in any top-level string field (#67), so nine fields
    // each holding a URL is nine recognized links.
    const links = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`link${index + 1}`, `https://github.com/x/y/pull/${index + 1}`])
    );
    const dbPath = new FixtureBuilder()
      .task({
        id: 'task_many',
        handle: COORDINATOR,
        title: 'Named nine links',
        status: 'completed',
        createdAt: at(0),
        completedAt: at(20),
        result: JSON.stringify(links),
      })
      .dispatch({ taskId: 'task_many', assigneeHandle: FIRST_AGENT, status: 'completed', dispatchedAt: at(1), completedAt: at(19) })
      .write(tempDbPath());

    const score = member(await castOfRun(dbPath), FIRST_AGENT).score;

    expect(score?.outcomeLinks).toHaveLength(8);
    expect(score?.outcomeLinksOmitted).toBe(1);
  });

  it('never mints a composite score or a winner — the wire carries facts, not a ranking', async () => {
    const cast = await castOfRun(multiAgentRun().write(tempDbPath()));

    for (const agent of cast) {
      expect(agent.score).toBeDefined();
      expect(JSON.stringify(agent.score)).not.toMatch(/winner|rank|overall|composite/i);
    }
  });
});

describe('the scoreboard on the wire — a retried run', () => {
  /**
   * One task, three attempts: the first agent failed once and was replaced; the second failed
   * twice more on its first try and completed on its second, the breaker's cumulative count
   * reading 1 then 3 on its two rows. A second task of the second agent's failed once.
   */
  function retriedRun(): FixtureBuilder {
    return new FixtureBuilder()
      .task({
        id: 'task_gamma',
        handle: COORDINATOR,
        title: 'Survive the retry',
        status: 'completed',
        createdAt: at(0),
        completedAt: at(60),
        result: JSON.stringify({ pr: 'https://github.com/x/y/pull/9' }),
      })
      .dispatch({ taskId: 'task_gamma', assigneeHandle: FIRST_AGENT, status: 'failed', failureCount: 1, dispatchedAt: at(1), completedAt: at(10) })
      .dispatch({ taskId: 'task_gamma', assigneeHandle: SECOND_AGENT, status: 'failed', failureCount: 2, dispatchedAt: at(15), completedAt: at(25) })
      .dispatch({ taskId: 'task_gamma', assigneeHandle: SECOND_AGENT, status: 'completed', failureCount: 3, dispatchedAt: at(30), completedAt: at(55) })
      .task({ id: 'task_delta', handle: COORDINATOR, title: 'Another go', status: 'failed', createdAt: at(2) })
      .dispatch({ taskId: 'task_delta', assigneeHandle: SECOND_AGENT, status: 'failed', failureCount: 1, dispatchedAt: at(3), completedAt: at(6) });
  }

  it('sums the maximum cumulative failure count per task, never across retry rows', async () => {
    const cast = await castOfRun(retriedRun().write(tempDbPath()));

    expect(member(cast, FIRST_AGENT).score?.failures).toBe(1);
    // gamma's cumulative max is 3 (not 2 + 3 = 5), plus delta's 1.
    expect(member(cast, SECOND_AGENT).score?.failures).toBe(4);
  });

  it('spans each agent across its own attempts only', async () => {
    const cast = await castOfRun(retriedRun().write(tempDbPath()));

    expect(member(cast, FIRST_AGENT).score?.span).toMatchObject({ startAt: iso(1), endAt: iso(10) });
    expect(member(cast, SECOND_AGENT).score?.span).toMatchObject({ startAt: iso(3), endAt: iso(55) });
  });

  it('credits a task result’s links to the agent of the surviving attempt, not to the one it replaced', async () => {
    const cast = await castOfRun(retriedRun().write(tempDbPath()));

    expect(member(cast, SECOND_AGENT).score?.outcomeLinks).toEqual(['https://github.com/x/y/pull/9']);
    // The agent that was replaced produced no receipt of its own — a measured zero, not unknown.
    expect(member(cast, FIRST_AGENT).score?.outcomeLinks).toEqual([]);
  });
});

describe('the scoreboard on the wire — ambiguous attribution', () => {
  const OTHER_COORDINATOR = handleFor('coordinator-other');
  const SHARED_WORKER = handleFor('worker-shared');

  /** One worker, hired by two overlapping orchestrators — the case attribution refuses to guess. */
  function overlappingRuns(): FixtureBuilder {
    return new FixtureBuilder()
      .task({ id: 'task_one', handle: COORDINATOR, title: 'First engagement', status: 'dispatched', createdAt: at(0) })
      .dispatch({ taskId: 'task_one', assigneeHandle: SHARED_WORKER, status: 'dispatched', dispatchedAt: at(1) })
      .task({ id: 'task_two', handle: OTHER_COORDINATOR, title: 'Second engagement', status: 'dispatched', createdAt: at(2) })
      .dispatch({ taskId: 'task_two', assigneeHandle: SHARED_WORKER, status: 'dispatched', dispatchedAt: at(3) })
      // Names no task, sent while both engagements were open: nothing in the schema says which
      // run it belongs to, so it is counted in *neither* — never guessed into one.
      .message({ fromHandle: SHARED_WORKER, toHandle: COORDINATOR, subject: 'progress', type: 'status', createdAt: at(10) })
      // Names a task: attributed outright, and counted exactly once.
      .message({ fromHandle: SHARED_WORKER, toHandle: COORDINATOR, subject: 'alive', type: 'heartbeat', payload: { taskId: 'task_one' }, createdAt: at(11) });
  }

  it('counts an ambiguous message in neither run, and a task-named one exactly once', async () => {
    harness = await serve(overlappingRuns().write(tempDbPath()));
    const event = await harness.snapshot();

    const first = event.snapshot.runs.find((run: Run) => run.id === RUN_ID);
    const second = event.snapshot.runs.find((run: Run) => run.id === `run_${OTHER_COORDINATOR}`);

    // The status message went to no run at all; the heartbeat's `payload.taskId` placed it.
    expect(member(first!.cast, SHARED_WORKER).score).toMatchObject({ heartbeats: 1, messages: 0 });
    expect(member(second!.cast, SHARED_WORKER).score).toMatchObject({ heartbeats: 0, messages: 0 });
  });
});

describe('the scoreboard on the wire — missing evidence', () => {
  it('shows no span for an agent whose work stopped without a retained completion', async () => {
    const dbPath = new FixtureBuilder()
      .task({ id: 'task_lost', handle: COORDINATOR, title: 'Vanished', status: 'failed', createdAt: at(0) })
      .dispatch({ taskId: 'task_lost', assigneeHandle: FIRST_AGENT, status: 'failed', dispatchedAt: at(1) })
      .write(tempDbPath());

    const cast = await castOfRun(dbPath);
    const score = member(cast, FIRST_AGENT).score;

    expect(score?.span).toBeUndefined();
    expect(score?.firstHeartbeat).toBeUndefined();
    // The columns *are* readable and named no link: zero, measured. (A database that cannot read
    // receipts at all leaves this absent instead — `degradation.test.ts` holds that line.)
    expect(score?.outcomeLinks).toEqual([]);
    // The counts are real zeros — zero retained rows — not unknowns.
    expect(score).toMatchObject({ heartbeats: 0, messages: 0, escalations: 0, failures: 0 });
  });

  it('keeps a single-agent cast scored — the rollup shows the same facts the grid would', async () => {
    const dbPath = new FixtureBuilder()
      .task({ id: 'task_solo', handle: COORDINATOR, title: 'Alone', status: 'completed', createdAt: at(0), completedAt: at(20) })
      .dispatch({ taskId: 'task_solo', assigneeHandle: FIRST_AGENT, status: 'completed', dispatchedAt: at(1), completedAt: at(19) })
      .message({ fromHandle: FIRST_AGENT, toHandle: COORDINATOR, subject: 'alive', type: 'heartbeat', payload: { taskId: 'task_solo' }, createdAt: at(2) })
      .write(tempDbPath());

    const cast = await castOfRun(dbPath);

    expect(cast).toHaveLength(1);
    expect(cast[0]!.score).toMatchObject({ heartbeats: 1, messages: 0 });
    expect(cast[0]!.score?.span).toMatchObject({ complete: true, ms: 18 * 60_000 });
  });
});
