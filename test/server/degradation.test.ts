import { afterEach, describe, expect, it } from 'vitest';
import { OrcaDatabase } from '../../src/server/database.ts';
import type { StreamEvent, Task } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import type { SchemaOptions } from '../fixtures/schema.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * Surviving Orca (#21). You update Orca and this tool degrades instead of dying.
 *
 * The whole strategy rests on one fact from Orca's history: the migrations are **additive**
 * (v2 `last_heartbeat_at`, v3 `delivered_at`, v4 `created_by_terminal_handle`, v5
 * `task_title`/`display_name`). So a schema version *is* a set of columns, and a missing
 * column can be made to cost exactly the one feature that needed it.
 *
 * Which is what these tests are for. It is not enough to prove a feature degrades — anyone
 * can degrade everything. The assertion that matters in almost every test below is the
 * **second** one: that the features which did *not* lose a column are all still there.
 *
 * The fixtures write the columns genuinely absent at each version (`test/fixtures/schema.ts`),
 * so this is drift as an older Orca really produces it, not a tidy database with nulls in it.
 */

const AT = new Date('2026-07-08T12:00:00Z');
const LATER = new Date('2026-07-08T12:30:00Z');
const CODER = handleFor('coder');
const WORKER = handleFor('worker');

const CHARTED = 'task_aaaaaaaaaaaa';
const BUILDING = 'task_bbbbbbbbbbbb';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/**
 * One orchestration — two tasks, an edge between them, an agent working the second one and
 * heartbeating — written at whatever schema the test names.
 *
 * Every feature #21 can take away is exercised by these rows: the titles, the handle the runs
 * are inferred from, the heartbeat behind the last-seen badge. Writing the *same* content at
 * every version is what makes "and nothing else broke" an assertion rather than a hope.
 */
function orchestration(schema: SchemaOptions): FixtureBuilder {
  return new FixtureBuilder(schema)
    .task({
      id: CHARTED,
      handle: CODER,
      title: 'Chart the map',
      status: 'completed',
      createdAt: AT,
      completedAt: LATER,
    })
    .task({
      id: BUILDING,
      handle: CODER,
      title: 'Build the thing',
      status: 'dispatched',
      deps: [CHARTED],
      createdAt: LATER,
    })
    .dispatch({
      taskId: BUILDING,
      assigneeHandle: WORKER,
      status: 'dispatched',
      dispatchedAt: LATER,
      lastHeartbeatAt: LATER,
    })
    .message({ fromHandle: WORKER, toHandle: CODER, subject: 'still here', type: 'heartbeat', createdAt: LATER });
}

async function snapshotOf(builder: FixtureBuilder): Promise<StreamEvent> {
  harness = await serve(builder.write(tempDbPath()));
  return harness.snapshot();
}

function byId(tasks: Task[], id: string): Task {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`no task ${id} in the snapshot — it was dropped, which is the one thing never allowed`);
  return task;
}

/** The three features a missing column can take away, as the user is told about them. */
const TITLES = /task titles/i;
const RUNS = /^orchestrators\b/i;
const LAST_SEEN = /last seen/i;

const matching = (degraded: string[], feature: RegExp): string[] =>
  degraded.filter((entry) => feature.test(entry));

/** What the terminal prints when the database is refused — the message *and* the hint under it. */
function refusalOf(dbPath: string): string {
  try {
    new OrcaDatabase(dbPath).close();
  } catch (error) {
    return String(error);
  }
  throw new Error('the database was opened, when it should have been refused');
}

/**
 * A newer Orca is a *banner*, not a refusal: the columns we know are still there, and the
 * ones it added are simply not asked for. Everything renders.
 */
describe('a database from a newer Orca (user_version 6)', () => {
  it('renders the whole DAG normally, with nothing degraded', async () => {
    const { meta, snapshot } = await snapshotOf(orchestration({ userVersion: 6 }));

    expect(meta.schemaVersion).toBe(6);
    // The banner the UI raises off this: "newer Orca schema — some data may be missing or
    // mislabeled." Nothing is *disabled*, so nothing is named in `degraded`.
    expect(meta.schemaSupport).toBe('newer');
    expect(meta.degraded).toEqual([]);

    expect(snapshot.tasks).toHaveLength(2);
    expect(byId(snapshot.tasks, BUILDING).title).toBe('Build the thing');
    expect(byId(snapshot.tasks, BUILDING).deps).toEqual([CHARTED]);
    expect(byId(snapshot.tasks, BUILDING).dispatch?.lastHeartbeatAt).toBe(LATER.toISOString());
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]!.handle).toBe(CODER);
  });

  it('reads a status and a message type it has never heard of without dropping either row', async () => {
    // A widened enum is what a newer Orca most plausibly looks like: the CHECK constraint
    // permits the new value, and the tool has never heard of it.
    const { snapshot, seq } = await snapshotOf(
      new FixtureBuilder({ userVersion: 6, allowUnknownEnums: true })
        .task({ id: CHARTED, handle: CODER, status: 'quarantined', createdAt: AT })
        .message({ fromHandle: CODER, toHandle: WORKER, subject: 'a new kind of note', type: 'telemetry', createdAt: AT })
    );

    // Verbatim, in a neutral style on the canvas: a task rendered in an odd colour is a far
    // smaller lie than a task missing from the graph (SPEC §5).
    expect(byId(snapshot.tasks, CHARTED).status).toBe('quarantined');
    expect(snapshot.runs[0]!.statusCounts.quarantined).toBe(1);
    // The message the feed (#18) will carry is in the file and counted, not choked on.
    expect(seq).toBe(1);
  });
});

/**
 * The heart of the ticket. Each of these takes away one column and checks two things: the
 * feature it paid for is gone *and named*, and every other feature still works.
 */
describe('an older Orca: a missing column costs exactly one feature', () => {
  it('costs the titles, and only the titles, when pre-v5 Orca never named a task', async () => {
    const { meta, snapshot } = await snapshotOf(orchestration({ userVersion: 4 }));

    expect(meta.schemaSupport).toBe('older');
    expect(matching(meta.degraded, TITLES)).toHaveLength(1);
    expect(meta.degraded).toHaveLength(1);

    // The feature that is gone: the title falls back to the short id.
    expect(byId(snapshot.tasks, BUILDING).title).toBe('task_bbbbbbbb');

    // …and nothing else did. The runs still come from the handle, the edge is still an edge,
    // and the agent is still visibly alive.
    expect(snapshot.runs[0]!.handle).toBe(CODER);
    expect(snapshot.runs[0]!.id).not.toBe('run_unattributed');
    expect(byId(snapshot.tasks, BUILDING).deps).toEqual([CHARTED]);
    expect(byId(snapshot.tasks, BUILDING).dispatch?.lastHeartbeatAt).toBe(LATER.toISOString());
  });

  it('costs the runs, and only the runs, when pre-v4 Orca never recorded the terminal', async () => {
    const { meta, snapshot } = await snapshotOf(orchestration({ userVersion: 3 }));

    // Two columns are gone at v3, so two features are — the titles (v5) and the runs (v4).
    // Naming both is the point: each is explained on its own.
    expect(matching(meta.degraded, RUNS)).toHaveLength(1);
    expect(matching(meta.degraded, TITLES)).toHaveLength(1);
    expect(meta.degraded).toHaveLength(2);

    // The feature that is gone: with no handle to bucket by, every task lands in the one
    // synthetic run rather than vanishing off the rail.
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]!.id).toBe('run_unattributed');
    expect(snapshot.runs[0]!.label).toBe('Unattributed');
    expect(snapshot.tasks.map((task) => task.runId)).toEqual(['run_unattributed', 'run_unattributed']);

    // …and the last-seen badge, whose column arrived at v2, is untouched by any of it.
    expect(byId(snapshot.tasks, BUILDING).dispatch?.lastHeartbeatAt).toBe(LATER.toISOString());
  });

  it('costs the last-seen badge, and only the badge, when pre-v2 Orca never heard a heartbeat', async () => {
    const { meta, snapshot } = await snapshotOf(orchestration({ userVersion: 1 }));

    expect(matching(meta.degraded, LAST_SEEN)).toHaveLength(1);

    // The feature that is gone: no heartbeat, so no badge — and the client renders none,
    // because `lastHeartbeatAt` is null rather than invented.
    const building = byId(snapshot.tasks, BUILDING);
    expect(building.dispatch?.lastHeartbeatAt).toBeNull();

    // …and the dispatch it hangs off is otherwise entirely intact: who has the task, what
    // state it is in, how many attempts it took, and the DAG the whole tool is for.
    expect(building.dispatch?.assigneeHandle).toBe(WORKER);
    expect(building.dispatch?.status).toBe('dispatched');
    expect(building.attemptCount).toBe(1);
    expect(building.status).toBe('dispatched');
    expect(building.deps).toEqual([CHARTED]);
  });
});

/**
 * The version number is only ever a *banner*. What the queries are built from is the columns
 * the file really has — so a v5 database missing one column degrades exactly like the older
 * Orca that never had it. These are the same three features, isolated one at a time.
 */
describe('the columns decide, not the version number', () => {
  it('degrades only the last-seen badge when just the heartbeat column is gone', async () => {
    const { meta, snapshot } = await snapshotOf(
      orchestration({ omitColumns: { dispatch_contexts: ['last_heartbeat_at'] } })
    );

    expect(matching(meta.degraded, LAST_SEEN)).toHaveLength(1);
    expect(meta.degraded).toHaveLength(1);

    expect(byId(snapshot.tasks, BUILDING).dispatch?.lastHeartbeatAt).toBeNull();
    expect(byId(snapshot.tasks, BUILDING).title).toBe('Build the thing');
    expect(snapshot.runs[0]!.handle).toBe(CODER);
  });

  it('degrades only the runs when just the terminal handle is gone', async () => {
    const { meta, snapshot } = await snapshotOf(
      orchestration({ omitColumns: { tasks: ['created_by_terminal_handle'] } })
    );

    expect(matching(meta.degraded, RUNS)).toHaveLength(1);
    expect(meta.degraded).toHaveLength(1);

    expect(snapshot.runs[0]!.id).toBe('run_unattributed');
    expect(byId(snapshot.tasks, BUILDING).title).toBe('Build the thing');
    expect(byId(snapshot.tasks, BUILDING).dispatch?.lastHeartbeatAt).toBe(LATER.toISOString());
  });

  it('keeps the titles when only one of the two title columns is gone', async () => {
    // Either column alone still names the task, so losing one is not a lost feature — and
    // claiming it was would send the user hunting for a badge that is right there.
    const { meta, snapshot } = await snapshotOf(
      new FixtureBuilder({ omitColumns: { tasks: ['task_title'] } }).task({
        id: CHARTED,
        handle: CODER,
        displayName: 'Chart the map',
        createdAt: AT,
      })
    );

    expect(meta.degraded).toEqual([]);
    expect(byId(snapshot.tasks, CHARTED).title).toBe('Chart the map');
  });
});

/**
 * **The DAG core is the only legal hard-fail** (SPEC §5). Everything else — every other
 * column, every other table — degrades. These are the two halves of that rule, and the second
 * is the one worth writing: a database this tool *could* have refused, and does not.
 */
describe('the only legal hard-fail', () => {
  it('refuses a tasks table with no dependency edges, and says what to do about it', () => {
    const dbPath = orchestration({ omitColumns: { tasks: ['deps'] } }).write(tempDbPath());

    expect(() => new OrcaDatabase(dbPath)).toThrow(/no readable task DAG.*tasks\.deps/s);
    // Actionable, not just true: what the terminal prints tells the user what to try next.
    expect(refusalOf(dbPath)).toMatch(/--list-dbs/);
  });

  it('refuses a tasks table with no status, because a colourless DAG says nothing', () => {
    const dbPath = orchestration({ omitColumns: { tasks: ['status'] } }).write(tempDbPath());

    expect(() => new OrcaDatabase(dbPath)).toThrow(/no readable task DAG.*tasks\.status/s);
  });

  it('still renders the DAG when the message stream is unreadable', async () => {
    // `messages.sequence` is the poll cursor and the reset detector, and it is *not* the DAG.
    // An Orca that renamed it — or dropped the table, which introspects to the same empty
    // column set — costs the feed and nothing more. Querying it unasked would turn a schema
    // change we survive by design into a tool that will not open at all.
    const { meta, snapshot } = await snapshotOf(orchestration({ omitColumns: { messages: ['sequence'] } }));

    expect(snapshot.tasks).toHaveLength(2);
    expect(byId(snapshot.tasks, BUILDING).deps).toEqual([CHARTED]);
    expect(snapshot.runs[0]!.handle).toBe(CODER);

    // The history-loss detector says nothing rather than guessing, and the user is told
    // which feature that cost them.
    expect(meta.historyLoss).toEqual([]);
    expect(matching(meta.degraded, /message history-loss detection/i)).toHaveLength(1);
  });

  it('reports a zero cursor rather than crashing when there is no sequence to read', async () => {
    const { seq } = await snapshotOf(orchestration({ omitColumns: { messages: ['sequence'] } }));

    expect(seq).toBe(0);
  });
});

/**
 * The task-graph history-loss detector degrades like a feature (#50, SPEC §5.1). Each case
 * below is the tasks-only reset shape itself, written at a schema missing exactly one of the
 * detector's requirements — the loss is really there, and the tool suppresses the claim it
 * can no longer verify rather than guessing, while the rest of the snapshot still renders.
 */
describe('task graph history-loss detection degrades like a feature', () => {
  const DETECTOR = /task graph history-loss detection/i;

  it.each([
    ['messages', 'payload'],
    ['dispatch_contexts', 'id'],
    ['decision_gates', 'id'],
    ['coordinator_runs', 'id'],
  ] as const)('suppresses the signal and names the detector when %s.%s is missing', async (table, column) => {
    const { meta, messages } = await snapshotOf(
      new FixtureBuilder({ omitColumns: { [table]: [column] } }).tasksOnlyReset(AT)
    );

    expect(meta.historyLoss).toEqual([]);
    expect(matching(meta.degraded, DETECTOR)).toHaveLength(1);
    // The retained conversation is still served: suppressing one detector costs exactly
    // that detector, never the messages it would have read.
    expect(messages).toHaveLength(2);
  });

  it('keeps detecting on a database that is missing nothing', async () => {
    const { meta } = await snapshotOf(new FixtureBuilder().tasksOnlyReset(AT));

    expect(matching(meta.degraded, DETECTOR)).toHaveLength(0);
    expect(meta.historyLoss).toEqual(['task-graph-history']);
  });
});
