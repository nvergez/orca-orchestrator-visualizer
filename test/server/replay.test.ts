import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boot, type BootOptions, type Booted } from '../../src/server/boot.ts';
import { StartupError } from '../../src/server/errors.ts';
import { ARCHIVE_VERSION, type RunArchive } from '../../src/shared/archive.ts';
import type { RunSnapshot } from '../../src/shared/types.ts';
import { createReplayServer, type Viz } from '../../src/server/server.ts';
import { FixtureBuilder, handleFor, syntheticId } from '../fixtures/builder.ts';
import { tempDbPath, tempDir } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * **The archived replay** (#74, ADR 0005) — `orca-viz --archive <file>`, and the round trip that
 * is the whole ticket: *export one run, open the file, and find the run.*
 *
 * The claims under test are the ones a saved artifact could most easily break:
 *
 * - **It opens with no Orca database.** No discovery, no `orchestration.db`, no probe of the
 *   process table — the file is the only thing read.
 * - **It cannot poll, and it cannot claim liveness.** The live routes do not exist in this server,
 *   and neither does the live *page*: `/` and `/index.html` both serve the replay bundle, so
 *   there is no way to reach a page that would open an `EventSource`.
 * - **The evidence survives, and the machine's does not.** Every task, attempt, gate, turn, body
 *   and attributed message of the exported run comes back through the replay; the other
 *   orchestrator's messages and the unattributed ones were never in the file to come back.
 * - **A file it cannot read fails in the terminal, actionably** — never as a blank tab.
 */

const AT = new Date('2026-07-08T12:00:00Z');
const MINUTE = 60_000;

const ORCHESTRATOR = handleFor('orchestrator-a');
const OTHER = handleFor('orchestrator-b');
const AGENT = handleFor('agent-a1');
const STRANGER = handleFor('somebody-else');

const RUN = `run_${ORCHESTRATOR}`;
const A1 = syntheticId('task', 'a1');
const B1 = syntheticId('task', 'b1');

let harness: Harness | undefined;
let booted: Booted;
let replayServer: Viz | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await booted?.close();
  booted = null;
  await replayServer?.close();
  replayServer = undefined;
});

function at(offsetMs: number): Date {
  return new Date(AT.getTime() + offsetMs);
}

/** One orchestrator worth exporting, and the machine history that must not travel with it. */
function database(): string {
  return new FixtureBuilder()
    .task({ id: A1, handle: ORCHESTRATOR, title: 'Read the spec', spec: 'READ IT', result: '{"files":["src/a.ts"],"shape":{"nobody":"knows"}}', status: 'completed', createdAt: at(0), completedAt: at(2 * MINUTE) })
    .dispatch({ taskId: A1, assigneeHandle: AGENT, status: 'failed', failureCount: 1, dispatchedAt: at(MINUTE), lastFailure: at(90_000) })
    .dispatch({ taskId: A1, assigneeHandle: AGENT, status: 'completed', dispatchedAt: at(100_000), completedAt: at(2 * MINUTE) })
    .message({ id: 'msg_a_done', fromHandle: AGENT, toHandle: ORCHESTRATOR, subject: 'Done', type: 'worker_done', payload: { taskId: A1 }, createdAt: at(2 * MINUTE) })
    .task({ id: B1, handle: OTHER, title: 'Somebody else’s work', createdAt: at(10 * MINUTE) })
    .message({ id: 'msg_global', fromHandle: STRANGER, toHandle: STRANGER, subject: 'Nothing to do with any of this', createdAt: at(11 * MINUTE) })
    .write(tempDbPath());
}

/** Export a run from a live server and save the file, exactly as a browser's download would. */
async function exportToFile(runId = RUN): Promise<{ path: string; archive: RunArchive; snapshot: RunSnapshot }> {
  const response = await harness!.archive(runId);
  expect(response.status).toBe(200);
  const body = await response.text();

  const path = join(tempDir(), 'export.json');
  writeFileSync(path, body);

  const snapshot = (await (await harness!.run(runId)).json()) as RunSnapshot;
  return { path, archive: JSON.parse(body) as RunArchive, snapshot };
}

type Replay = { origin: string; lines: string[]; opened: string[] };

/** Boot the real CLI on an archive — no database anywhere in the arguments. */
async function replay(path: string, overrides: Partial<BootOptions> = {}): Promise<Replay> {
  const lines: string[] = [];
  const opened: string[] = [];

  booted = await boot({
    argv: ['--archive', path, '--port', '0'],
    env: {},
    platform: 'linux',
    home: tempDir(),
    // The process table is not consulted at all in a replay. If it ever is, this throws.
    probe: () => {
      throw new Error('a replay must not probe for a running Orca');
    },
    readMounts: () => null,
    isTTY: true,
    print: (line) => lines.push(line),
    openBrowser: (url) => opened.push(url),
    ...overrides,
  });

  return { origin: booted!.url, lines, opened };
}

async function refuse(argv: string[]): Promise<Error> {
  try {
    booted = await boot({ argv, env: {}, platform: 'linux', home: tempDir(), print: () => {}, openBrowser: () => {} });
  } catch (error) {
    return error as Error;
  }
  throw new Error(`boot accepted ${argv.join(' ')} — it should have refused`);
}

describe('export → replay: the round trip', () => {
  it('gives the run back whole — tasks, attempts, bodies, gates, turns and its own messages', async () => {
    harness = await serve(database());
    const { path, snapshot } = await exportToFile();

    const { origin } = await replay(path);
    const served = (await (await fetch(`${origin}/api/archive`)).json()) as RunArchive;

    expect(served.tasks).toEqual(snapshot.tasks);
    expect(served.gates).toEqual(snapshot.gates);
    expect(served.attempts[A1]).toHaveLength(2);
    expect(served.turns).toEqual(snapshot.turns.filter((turn) => turn.runId === RUN));
    expect(served.messages.map((message) => message.id)).toEqual(['msg_a_done']);

    // The receipt this build cannot interpret is *still in the file*, character for character —
    // raw evidence, stored independently of any richer reading of it.
    expect(served.bodies[A1]?.result).toBe('{"files":["src/a.ts"],"shape":{"nobody":"knows"}}');
    expect(served.bodies[A1]?.spec).toBe('READ IT');
  });

  it('does not give back what was never in the file: another run, and the unattributed', async () => {
    harness = await serve(database());
    const { path } = await exportToFile();

    const { origin } = await replay(path);
    const served = (await (await fetch(`${origin}/api/archive`)).text()).toString();

    expect(served).not.toContain('msg_global');
    expect(served).not.toContain('Somebody else’s work');
    expect(served).not.toContain(harness.dbPath);
  });

  it('serves the artifact byte for byte — the wire *is* the file, so an unknown field survives it', async () => {
    harness = await serve(database());
    const { archive } = await exportToFile();

    // An archive written by an orca-viz that does not exist yet: a field this build has never
    // heard of, in a file it can still read. Nothing between the disk and the browser reshapes it.
    const bytes = JSON.stringify({ ...archive, receipts: [{ kind: 'invented-later' }] }, null, 2);
    const path = join(tempDir(), 'doctored.json');
    writeFileSync(path, bytes);

    const { origin } = await replay(path);
    const response = await fetch(`${origin}/api/archive`);

    expect(await response.text()).toBe(bytes);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});

describe('a replay opens no database, and cannot poll', () => {
  it('boots with no Orca database, and says archived and offline in the terminal', async () => {
    harness = await serve(database());
    const { path, archive } = await exportToFile();
    await harness.close();
    harness = undefined;

    // A headed Linux terminal — the browser opens for a replay exactly as it does for a database.
    const { lines, opened, origin } = await replay(path, { env: { DISPLAY: ':0' } });
    const printed = lines.join('\n');

    expect(printed).toContain(`replaying ${path}`);
    expect(printed).toContain('archived');
    expect(printed).toContain('offline');
    expect(printed).toContain(archive.run.label);
    expect(printed).toContain('source schema v5');
    // Nothing about a live Orca, and no database path, because neither exists here.
    expect(printed).not.toContain('orchestration.db');
    expect(printed).not.toMatch(/connected to a running Orca|isn't running/);
    expect(opened).toEqual([origin]);
  });

  it('prints what the source database’s schema cost this evidence, months after the fact', async () => {
    // An Orca with no `tasks.result`: the export recorded what that cost, because by replay time
    // the database is gone and the archive is the only thing that still knows.
    harness = await serve(
      new FixtureBuilder({ omitColumns: { tasks: ['result'] } })
        .task({ id: A1, handle: ORCHESTRATOR, title: 'Read the spec', createdAt: at(0) })
        .write(tempDbPath())
    );
    const { path } = await exportToFile();

    const { lines } = await replay(path);
    const printed = lines.join('\n');

    expect(printed).toContain('missing columns this build expects');
    expect(printed).toContain('tasks.result');
  });

  it('has no live routes at all — there is no stream, no index and no task detail to ask for', async () => {
    harness = await serve(database());
    const { path } = await exportToFile();

    const { origin } = await replay(path);

    for (const route of ['/api/stream', '/api/snapshot', '/api/runs', `/api/run/${RUN}`, `/api/task/${A1}`]) {
      const response = await fetch(`${origin}${route}`);
      expect(response.status, route).toBe(404);
      expect((await response.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining('no Orca database'),
      });
    }
  });

  it('serves the replay page where the live page would be, so nothing can open a stream', async () => {
    const clientDir = tempDir();
    mkdirSync(join(clientDir, 'assets'));
    writeFileSync(join(clientDir, 'index.html'), '<h1>live page: opens an EventSource</h1>');
    writeFileSync(join(clientDir, 'replay.html'), '<h1>archived replay</h1>');
    writeFileSync(join(clientDir, 'assets', 'replay.js'), 'export const replay = true;');

    replayServer = createReplayServer({ artifact: '{"hello":"world"}', clientDir });
    await new Promise<void>((resolve) => replayServer!.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(replayServer.server.address() as AddressInfo).port}`;

    // The live page is not merely unused: it is unreachable, at both of the paths that would
    // otherwise serve it. A replay that could load it would poll a stream that is not there.
    for (const path of ['/', '/index.html']) {
      const response = await fetch(`${origin}${path}`);
      expect(await response.text(), path).toContain('archived replay');
    }

    expect(await (await fetch(`${origin}/assets/replay.js`)).text()).toContain('replay');
    expect(await (await fetch(`${origin}/api/archive`)).text()).toBe('{"hello":"world"}');
    expect((await fetch(`${origin}/../secret`)).status).not.toBe(200);
  });
});

describe('a file this build cannot read fails in the terminal, not in the browser', () => {
  it('refuses an archive that is not there', async () => {
    const error = await refuse(['--archive', join(tempDir(), 'nowhere.json')]);

    expect(error.message).toContain('Could not read the archive');
    expect(error.toString()).toContain('Export archive');
  });

  it('refuses a file that is not JSON', async () => {
    const path = join(tempDir(), 'not.json');
    writeFileSync(path, 'this is not an archive, it is a note to self');

    expect((await refuse(['--archive', path])).message).toContain('not valid JSON');
  });

  it('refuses JSON that is not an archive, and says what an archive is', async () => {
    const path = join(tempDir(), 'other.json');
    writeFileSync(path, JSON.stringify({ tasks: [], runs: [] }));

    const error = await refuse(['--archive', path]);
    expect(error.message).toContain('not an orca-viz run archive');
    expect(error.toString()).toContain('Export archive');
  });

  it('refuses an archive whose required core is unreadable, and names what is wrong', async () => {
    harness = await serve(database());
    const { archive } = await exportToFile();

    const broken = { ...archive, tasks: undefined, run: undefined };
    const brokenPath = join(tempDir(), 'broken.json');
    writeFileSync(brokenPath, JSON.stringify(broken));

    const error = await refuse(['--archive', brokenPath]);
    expect(error.message).toContain('core cannot be read');
    expect(error.message).toContain('tasks');
    expect(error.message).toContain('run');
    expect(error.toString()).toContain('export the run again');
  });

  it('refuses a newer archive whose provenance it cannot read, instead of crashing on it', async () => {
    harness = await serve(database());
    const { archive } = await exportToFile();

    // The shape a later orca-viz could plausibly ship: a bumped version, and a provenance whose
    // source moved. It must fail as an *archive error*, not as a TypeError thrown while printing.
    const path = join(tempDir(), 'v2.json');
    writeFileSync(
      path,
      JSON.stringify({ ...archive, provenance: { format: archive.provenance.format, version: 2 } })
    );

    const error = await refuse(['--archive', path]);
    expect(error).toBeInstanceOf(StartupError);
    expect(error.message).toContain('provenance is missing');
    expect(error.toString()).toContain('Upgrade orca-viz');
  });

  it('opens a *newer* archive anyway, under a compatibility warning', async () => {
    harness = await serve(database());
    const { archive } = await exportToFile();

    const newerPath = join(tempDir(), 'newer.json');
    writeFileSync(
      newerPath,
      JSON.stringify({ ...archive, provenance: { ...archive.provenance, version: ARCHIVE_VERSION + 1 } })
    );

    const { lines, origin } = await replay(newerPath);
    const printed = lines.join('\n');

    expect(printed).toContain(`archive format v${ARCHIVE_VERSION + 1}`);
    expect(printed).toContain('upgrade orca-viz');
    // And it really did open: the evidence is being served.
    expect(((await (await fetch(`${origin}/api/archive`)).json()) as RunArchive).run.id).toBe(RUN);
  });

  it('refuses --archive beside --db: one of the two flags would do nothing', async () => {
    harness = await serve(database());
    const { path } = await exportToFile();

    const error = await refuse(['--archive', path, '--db', harness.dbPath]);

    expect(error.message).toContain('--archive and --db cannot be used together');
    expect(error.toString()).toContain('opens no Orca database');
  });
});
