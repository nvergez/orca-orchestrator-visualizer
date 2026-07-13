import { statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, type RunArchive } from '../../src/shared/archive.ts';
import type { RunSnapshot, TaskDetail } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor, syntheticId } from '../fixtures/builder.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * `GET /api/run/:id/archive` — **the export** (#74, ADR 0001, SPEC §12.4), over real HTTP against
 * a real database, because the artifact *is* the contract.
 *
 * The ticket's acceptance criteria are boundary claims, and every one of them is a claim about
 * what is **not** in the file:
 *
 * - one selected run's complete evidence — every task, every attempt, both bodies in full, every
 *   gate, its whole conversation, and the raw messages attributed to it;
 * - **not** the machine-global database, another orchestrator's messages, an unattributed one, or
 *   a database path;
 * - **not** a liveness claim: a run that is running *now* does not export a green dot into next
 *   March;
 * - and nothing at all happens until a user asks — no watcher, no recorder, and not a byte written
 *   to the database that was read.
 */

const AT = new Date('2026-07-08T12:00:00Z');
const MINUTE = 60_000;

const ORCHESTRATOR = handleFor('orchestrator-a');
const OTHER = handleFor('orchestrator-b');
const AGENT = handleFor('agent-a1');
const OTHER_AGENT = handleFor('agent-b1');
/** A terminal no orchestrator in this database ever dispatched — the global, unplaced voice. */
const STRANGER = handleFor('somebody-else-entirely');

const RUN = `run_${ORCHESTRATOR}`;
const OTHER_RUN = `run_${OTHER}`;

const A1 = syntheticId('task', 'a1');
const A2 = syntheticId('task', 'a2');
const B1 = syntheticId('task', 'b1');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function at(offsetMs: number): Date {
  return new Date(AT.getTime() + offsetMs);
}

/**
 * Two orchestrators, an unattributed task, a message nothing places, a retry, a gate and a
 * dependency edge that crosses from one orchestrator into the other — the smallest database in
 * which every exclusion the ticket asks for is a thing that could actually go wrong.
 */
function twoOrchestrators(): FixtureBuilder {
  return (
    new FixtureBuilder()
      // Orchestrator A — the run under export.
      .task({ id: A1, handle: ORCHESTRATOR, title: 'Read the spec', spec: 'READ IT', result: 'read', status: 'completed', createdAt: at(0), completedAt: at(2 * MINUTE) })
      .task({ id: A2, handle: ORCHESTRATOR, title: 'Write the code', spec: 'WRITE IT', deps: [A1], status: 'dispatched', createdAt: at(MINUTE) })
      .dispatch({ taskId: A1, assigneeHandle: AGENT, status: 'completed', dispatchedAt: at(MINUTE), completedAt: at(2 * MINUTE) })
      // Two attempts on one task: the append-only retry record the archive must carry whole.
      .dispatch({ taskId: A2, assigneeHandle: AGENT, status: 'failed', failureCount: 1, dispatchedAt: at(2 * MINUTE), lastFailure: at(3 * MINUTE) })
      .dispatch({ taskId: A2, assigneeHandle: AGENT, status: 'dispatched', dispatchedAt: at(4 * MINUTE), lastHeartbeatAt: at(5 * MINUTE) })
      .message({ id: 'msg_a_done', fromHandle: AGENT, toHandle: ORCHESTRATOR, subject: 'Done', type: 'worker_done', payload: { taskId: A1, files: ['src/a.ts'], invented: { by: 'a later Orca' } }, createdAt: at(2 * MINUTE) })
      .message({ id: 'msg_a_gate', fromHandle: AGENT, toHandle: ORCHESTRATOR, subject: 'Which way?', type: 'decision_gate', payload: { taskId: A2, options: ['left', 'right'] }, createdAt: at(4 * MINUTE) })
      .message({ id: 'msg_a_beat', fromHandle: AGENT, toHandle: ORCHESTRATOR, subject: 'alive', type: 'heartbeat', createdAt: at(5 * MINUTE) })

      // Orchestrator B — a different run, and a task that depends on one of A's.
      .task({ id: B1, handle: OTHER, title: 'Ship it', spec: 'SHIP IT', deps: [A1], status: 'completed', createdAt: at(10 * MINUTE), completedAt: at(11 * MINUTE) })
      .dispatch({ taskId: B1, assigneeHandle: OTHER_AGENT, status: 'completed', dispatchedAt: at(10 * MINUTE), completedAt: at(11 * MINUTE) })
      .message({ id: 'msg_b_done', fromHandle: OTHER_AGENT, toHandle: OTHER, subject: 'Shipped', type: 'worker_done', payload: { taskId: B1 }, createdAt: at(11 * MINUTE) })

      // A task nobody attributed, and a message between two terminals no run has ever heard of:
      // the machine-global evidence an archive is forbidden to carry.
      .task({ id: syntheticId('task', 'orphan'), handle: null, title: 'Nobody’s task', createdAt: at(20 * MINUTE) })
      .message({ id: 'msg_global', fromHandle: STRANGER, toHandle: STRANGER, subject: 'Nothing to do with any of this', createdAt: at(21 * MINUTE) })
  );
}

async function exported(id = RUN): Promise<{ archive: RunArchive; response: Response }> {
  const response = await harness!.archive(id);
  expect(response.status).toBe(200);
  return { archive: (await response.json()) as RunArchive, response };
}

async function selected(id = RUN): Promise<RunSnapshot> {
  const response = await harness!.run(id);
  expect(response.status).toBe(200);
  return (await response.json()) as RunSnapshot;
}

describe('the artifact: one selected run, complete', () => {
  it('carries the selected-run snapshot — every task, gate, turn and attempt', async () => {
    harness = await serve(twoOrchestrators().write(tempDbPath()));

    const { archive } = await exported();
    const snapshot = await selected();

    expect(archive.run.id).toBe(RUN);
    expect(archive.tasks).toEqual(snapshot.tasks);
    expect(archive.gates).toEqual(snapshot.gates);
    expect(archive.coordinatorRuns).toEqual(snapshot.coordinatorRuns);

    // Every attempt, not the latest: the retried task exports both of its dispatch rows.
    expect(archive.attempts).toEqual(snapshot.attempts);
    expect(archive.attempts[A2]).toHaveLength(2);
    expect(archive.attempts[A2]?.map((attempt) => attempt.status)).toEqual(['failed', 'dispatched']);

    // The run's own conversation, whole — the four-source merge, exactly as the live screen has it.
    expect(archive.turns).toEqual(snapshot.turns.filter((turn) => turn.runId === RUN));
    expect(archive.turns.length).toBeGreaterThan(0);
  });

  it('carries both bodies in full, for every task — a replay has no database to go back to', async () => {
    harness = await serve(twoOrchestrators().write(tempDbPath()));

    const { archive } = await exported();
    const detail = (await (await harness.task(A1)).json()) as TaskDetail;

    expect(Object.keys(archive.bodies).sort()).toEqual([A1, A2].sort());
    expect(archive.bodies[A1]).toEqual({ spec: detail.spec, result: detail.result });
    expect(archive.bodies[A1]?.spec).toBe('READ IT');
    expect(archive.bodies[A2]).toEqual({ spec: 'WRITE IT', result: null });
  });

  it('carries the raw messages attributed to the run — payloads verbatim, beside the reading of them', async () => {
    harness = await serve(twoOrchestrators().write(tempDbPath()));

    const { archive } = await exported();

    expect(archive.messages.map((message) => message.id)).toEqual(['msg_a_done', 'msg_a_gate', 'msg_a_beat']);

    // The raw row is stored **independently of the richer interpretation** of it: `turns` is this
    // tool's reading of the receipt; `messages` is the receipt. A shape this build has never seen
    // survives in the file whether or not anything on screen knows what to do with it.
    const receipt = archive.messages.find((message) => message.id === 'msg_a_done');
    expect(receipt?.payload).toEqual({ taskId: A1, files: ['src/a.ts'], invented: { by: 'a later Orca' } });
  });

  it('carries the far end of a dependency edge that leaves the run, so a dep chip can name it', async () => {
    harness = await serve(twoOrchestrators().write(tempDbPath()));

    const { archive } = await exported();

    // B's task depends on A's, so it is an *edge* of this run — a title and a status, and nothing
    // else of orchestrator B: no bodies, no attempts, no messages, no conversation.
    expect(archive.linkedTasks.map((task) => task.id)).toEqual([B1]);
    expect(archive.tasks.map((task) => task.id)).toEqual([A1, A2]);
    expect(archive.bodies[B1]).toBeUndefined();
    expect(archive.attempts[B1]).toBeUndefined();
  });
});

describe('the boundary: what an archive is forbidden to carry', () => {
  it('holds no other orchestrator’s messages, and nothing global or unattributed', async () => {
    harness = await serve(twoOrchestrators().write(tempDbPath()));

    const { archive } = await exported();
    const ids = archive.messages.map((message) => message.id);

    expect(ids).not.toContain('msg_b_done'); // another run's
    expect(ids).not.toContain('msg_global'); // nobody's

    // The same rule for the *conversation*: a live selected-run snapshot carries the turns nothing
    // places, because on screen they must appear somewhere. In a file they would be exactly the
    // unattributed machine history ADR 0001 forbids exporting.
    for (const turn of archive.turns) expect(turn.runId).toBe(RUN);
    const snapshot = await selected();
    expect(snapshot.turns.some((turn) => turn.runId === null)).toBe(true);
  });

  it('holds no database path anywhere in it — a path is where it came from, not what it is', async () => {
    const dbPath = tempDbPath();
    harness = await serve(twoOrchestrators().write(dbPath));

    const { archive, response } = await exported();
    const raw = JSON.stringify(archive);

    expect(raw).not.toContain(dbPath);
    expect(raw).not.toContain(dirname(dbPath));
    expect(raw).not.toContain('dbPath');
    // `meta` is a *live* database's header: liveness, mtime, the path. None of it means anything
    // in a file, so none of it is in one.
    expect((archive as unknown as Record<string, unknown>).meta).toBeUndefined();
    expect(await (await harness.run(RUN)).json()).toHaveProperty('meta.dbPath', dbPath);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('exports no liveness claim: a run that is live *now* is archived as ended', async () => {
    const dbPath = twoOrchestrators().write(tempDbPath());
    writeFileSync(join(dirname(dbPath), 'orca-runtime.json'), JSON.stringify({ pid: 4242 }));
    harness = await serve(dbPath, { probe: (pid) => pid === 4242 });

    // The live view says this run is running: Orca is up, and A2 is still dispatched.
    expect((await selected()).run.live).toBe(true);

    // The file says nothing of the kind. "Live" means *now*, and now is not when this is opened.
    expect((await exported()).archive.run.live).toBe(false);
  });

  it('writes nothing to the database it read — an export is a photograph, not a recorder', async () => {
    const dbPath = twoOrchestrators().write(tempDbPath());
    harness = await serve(dbPath);

    const before = statSync(dbPath);
    await exported();
    await exported();
    const after = statSync(dbPath);

    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

describe('provenance: what this file is, and what wrote it', () => {
  it('records the format, the version, the instant, the tool and the source schema', async () => {
    harness = await serve(twoOrchestrators().write(tempDbPath()));

    const { provenance } = (await exported()).archive;

    expect(provenance.format).toBe(ARCHIVE_FORMAT);
    expect(provenance.version).toBe(ARCHIVE_VERSION);
    expect(Date.parse(provenance.exportedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(provenance.tool).toMatch(/^orca-viz \d+\.\d+\.\d+/);
    expect(provenance.source).toEqual({ schemaVersion: 5, schemaSupport: 'supported', degraded: [] });
    expect(provenance.derivation).toContain('one orchestrator run');
  });

  it('carries what a missing column already cost the read, so a replay can explain the absence', async () => {
    // An Orca with no `tasks.result`: the export cannot invent one, and says so where a reader of
    // the file will find it, rather than shipping an empty section that reads as a bug.
    const dbPath = new FixtureBuilder({ omitColumns: { tasks: ['result'] } })
      .task({ id: A1, handle: ORCHESTRATOR, title: 'Read the spec', createdAt: at(0) })
      .write(tempDbPath());
    harness = await serve(dbPath);

    const { provenance, bodies } = (await exported()).archive;

    expect(bodies[A1]).toEqual({ spec: expect.any(String), result: null });
    expect(provenance.source.degraded.join(' ')).toContain('tasks.result');
  });

  it('names the download after the run and the instant', async () => {
    harness = await serve(twoOrchestrators().write(tempDbPath()));

    const { response, archive } = await exported();
    const disposition = response.headers.get('content-disposition') ?? '';

    expect(disposition).toContain('attachment;');
    expect(disposition).toContain(archive.run.id);
    expect(disposition).toMatch(/filename="orca-viz-.*\.json"/);
  });

  it('is a 404 for a run id that names nothing — not an empty archive', async () => {
    harness = await serve(twoOrchestrators().write(tempDbPath()));

    const response = await harness.archive('run_nobody');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'No run run_nobody in this database.' });
  });

  it('exports the unattributed run too — it is a run in the rail, and a user may select it', async () => {
    harness = await serve(twoOrchestrators().write(tempDbPath()));

    const { archive } = await exported('run_unattributed');

    expect(archive.run.id).toBe('run_unattributed');
    expect(archive.tasks).toHaveLength(1);
    // Its own turns, and still not the ones nothing places: the synthetic run holds the tasks with
    // no handle, not the evidence with no home.
    for (const turn of archive.turns) expect(turn.runId).toBe('run_unattributed');
  });

  it('leaves the other orchestrator exportable on its own terms', async () => {
    harness = await serve(twoOrchestrators().write(tempDbPath()));

    const { archive } = await exported(OTHER_RUN);

    expect(archive.tasks.map((task) => task.id)).toEqual([B1]);
    expect(archive.messages.map((message) => message.id)).toEqual(['msg_b_done']);
    expect(archive.linkedTasks.map((task) => task.id)).toEqual([A1]);
  });
});
