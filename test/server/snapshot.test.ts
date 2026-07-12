import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OrcaDatabase } from '../../src/server/database.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * `GET /api/snapshot` is the workhorse seam (#12): it returns the same `StreamEvent` a
 * poll tick pushes, so the whole server-side derivation is observable through one request.
 *
 * At #14 the snapshot *arrays* are still empty — nothing renders the DAG yet. What has to
 * be real is `meta`: which file we opened, what schema it is, whether Orca is running,
 * and whether a reset wiped the history.
 */

const AT = new Date('2026-07-08T12:00:00Z');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('GET /api/snapshot', () => {
  it('reports the database it is actually reading', async () => {
    const dbPath = new FixtureBuilder().task({ createdAt: AT }).write(tempDbPath());
    harness = await serve(dbPath);

    const snapshot = await harness.snapshot();

    expect(snapshot.meta.dbPath).toBe(dbPath);
  });

  it('reports the schema version the file carries', async () => {
    const dbPath = new FixtureBuilder().task({ createdAt: AT }).write(tempDbPath());
    harness = await serve(dbPath);

    const { meta } = await harness.snapshot();

    expect(meta.schemaVersion).toBe(5);
    expect(meta.schemaSupport).toBe('supported');
    expect(meta.degraded).toEqual([]);
  });

  it('carries the tasks, and the arrays the tickets after this one still owe', async () => {
    const dbPath = new FixtureBuilder().task({ createdAt: AT }).write(tempDbPath());
    harness = await serve(dbPath);

    const snapshot = await harness.snapshot();

    // #15 fills `tasks` (see tasks.test.ts). Runs are inferred in #16, coordinator runs
    // land with them, and the feed is #17 — an empty array is the honest thing to send
    // until each arrives.
    expect(snapshot.snapshot.tasks).toHaveLength(1);
    expect(snapshot.snapshot.runs).toEqual([]);
    expect(snapshot.snapshot.coordinatorRuns).toEqual([]);
    expect(snapshot.messages).toEqual([]);
  });

  it('carries the message high-water mark, which is the cursor #17 resumes from', async () => {
    const builder = new FixtureBuilder().task({ createdAt: AT });
    for (let i = 0; i < 3; i++) {
      builder.message({ fromHandle: 'a', toHandle: 'b', subject: `note ${i}`, createdAt: AT });
    }
    harness = await serve(builder.write(tempDbPath()));

    expect((await harness.snapshot()).seq).toBe(3);
  });
});

/**
 * Render what parses (SPEC §5). An Orca update must degrade this tool, never end it — the
 * one exception being a database with no task DAG in it, which there is no honest way to
 * draw.
 */
describe('a database from a different Orca', () => {
  it('renders a newer schema under the "newer" banner rather than refusing it', async () => {
    const dbPath = new FixtureBuilder({ userVersion: 6 }).task({ createdAt: AT }).write(tempDbPath());
    harness = await serve(dbPath);

    const { meta } = await harness.snapshot();

    expect(meta.schemaVersion).toBe(6);
    expect(meta.schemaSupport).toBe('newer');
  });

  it('degrades task labels — and only task labels — when pre-v5 Orca has no title columns', async () => {
    const dbPath = new FixtureBuilder({ userVersion: 4 }).task({ createdAt: AT }).write(tempDbPath());
    harness = await serve(dbPath);

    const { meta } = await harness.snapshot();

    expect(meta.schemaSupport).toBe('older');
    expect(meta.degraded).toHaveLength(1);
    expect(meta.degraded[0]).toContain('Task titles');
  });

  it('degrades run inference when pre-v4 Orca has no terminal handle on a task', async () => {
    const dbPath = new FixtureBuilder({ userVersion: 3 }).task({ createdAt: AT }).write(tempDbPath());
    harness = await serve(dbPath);

    const { degraded } = (await harness.snapshot()).meta;

    expect(degraded.join('\n')).toContain('Runs');
    expect(degraded.join('\n')).toContain('Unattributed');
  });

  it('degrades the last-seen badge when pre-v2 Orca has no heartbeat column', async () => {
    const dbPath = new FixtureBuilder({ userVersion: 1 }).task({ createdAt: AT }).write(tempDbPath());
    harness = await serve(dbPath);

    const { degraded } = (await harness.snapshot()).meta;

    expect(degraded.join('\n')).toContain('last seen');
  });

  it('refuses a database with no task DAG — the one legal hard-fail — and says why', () => {
    const dbPath = new FixtureBuilder({ omitColumns: { tasks: ['deps'] } })
      .task({ createdAt: AT })
      .write(tempDbPath());

    expect(() => new OrcaDatabase(dbPath)).toThrow(/no readable task DAG.*tasks\.deps/s);
  });
});

/**
 * A suddenly-empty history has to be explained rather than mysterious (#14). `sequence` is
 * AUTOINCREMENT, so the counter outlives the rows an `orchestration reset` deleted.
 */
describe('reset detection', () => {
  it('stays quiet on a database nobody has reset', async () => {
    const builder = new FixtureBuilder().task({ createdAt: AT });
    builder.message({ fromHandle: 'a', toHandle: 'b', subject: 'first', createdAt: AT });
    harness = await serve(builder.write(tempDbPath()));

    expect((await harness.snapshot()).meta.resetDetected).toBe(false);
  });

  it('spots the sequence gap an `orchestration reset` leaves behind', async () => {
    const builder = new FixtureBuilder().task({ createdAt: AT });
    // The survivors of a reset: the counter handed out 400 ids, and the rows that remain
    // start at 401.
    builder.message({ fromHandle: 'a', toHandle: 'b', subject: 'after the reset', sequence: 401, createdAt: AT });
    harness = await serve(builder.write(tempDbPath()));

    expect((await harness.snapshot()).meta.resetDetected).toBe(true);
  });
});

/**
 * "Orca isn't running; showing last-known state from <time>" is the wording this tool
 * exists to be able to say honestly (#12 story 22). It is derived from `orca-runtime.json`
 * and the process table — never from the `orca` CLI, which dies with the app.
 */
describe('liveness', () => {
  function withRuntimeFile(contents: string): string {
    const dbPath = new FixtureBuilder().task({ handle: handleFor('a'), createdAt: AT }).write(tempDbPath());
    writeFileSync(join(dirname(dbPath), 'orca-runtime.json'), contents);
    return dbPath;
  }

  it('is live when the runtime file names a pid that is running', async () => {
    harness = await serve(withRuntimeFile(JSON.stringify({ pid: 4242 })), { probe: (pid) => pid === 4242 });

    const { meta } = await harness.snapshot();

    expect(meta.liveness).toBe('live');
    expect(meta.orcaPid).toBe(4242);
  });

  it('is stale when the runtime file names a pid that is gone', async () => {
    harness = await serve(withRuntimeFile(JSON.stringify({ pid: 4242 })), { probe: () => false });

    expect((await harness.snapshot()).meta.liveness).toBe('stale');
  });

  it('is unknown when the runtime file is there but unreadable', async () => {
    harness = await serve(withRuntimeFile('{ not json at all'), { probe: () => true });

    const { meta } = await harness.snapshot();

    expect(meta.liveness).toBe('unknown');
    expect(meta.orcaPid).toBeNull();
  });

  it('is stale, with a database mtime to show, when Orca left no runtime file at all', async () => {
    const dbPath = new FixtureBuilder().task({ createdAt: AT }).write(tempDbPath());
    harness = await serve(dbPath, { probe: () => true });

    const { meta } = await harness.snapshot();

    expect(meta.liveness).toBe('stale');
    expect(meta.orcaPid).toBeNull();
    // The wording is "…last-known state from <time>", so there has to be a time.
    expect(Date.parse(meta.dbMtime)).toBeGreaterThan(0);
    expect(meta.dbMtime).toBe(new Date(meta.dbMtime).toISOString());
  });
});
