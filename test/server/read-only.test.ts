import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { TABLES } from '../../src/server/schema.ts';
import { liveShapeCorpus } from '../fixtures/corpus.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * **Hard invariant #1, asserted as behaviour rather than trusted as a code-review item.**
 *
 * `orca-viz` never writes to `orchestration.db`. Orca's coordinator assumes it is the
 * single writer and maintains invariants — the silent `pending → ready` promotion, above
 * all — inside its own transactions. A stray write from outside would not merely lose data;
 * it would corrupt a running orchestration.
 *
 * "Every connection opens `readOnly: true`" is a claim about code. This is the same claim
 * as an observation: drive every route the tool serves against a real database, then check
 * that the rows are what they were and the file is the bytes it was. #12 calls this the
 * single most important test in the suite, and it is.
 */

const HASH = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Every row of every table, read back through a connection of the test's own. */
function dumpRows(dbPath: string): Record<string, unknown[]> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(
      TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
    );
  } finally {
    db.close();
  }
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('the read-only invariant', () => {
  it('leaves the database byte-identical after every route has been driven', async () => {
    // The live-shape corpus, not a toy: 76 tasks, 466 messages, gates, retries, orphans.
    // If any code path in this tool can write, this is the database it would write to.
    const dbPath = liveShapeCorpus().write(tempDbPath());

    const bytesBefore = HASH(dbPath);
    const rowsBefore = dumpRows(dbPath);

    harness = await serve(dbPath);

    // Every route the server answers at this ticket, including the ones that fail.
    await harness.snapshot();
    await harness.snapshot(); // …twice: a second read must not checkpoint anything either.

    // The stream, from both ends of its cursor (#17): a first connect, which reads the whole
    // feed, and a reconnect resuming from a `Last-Event-ID`. It is the one route that holds a
    // connection open and goes on reading SQLite on a timer, so it is the one with the most
    // opportunity to write — and `PRAGMA data_version`, which it polls, is the read most
    // likely to be mistaken for a write.
    await (await harness.stream()).next();
    await (await harness.stream(400)).next();

    await fetch(`${harness.origin}/`);
    await fetch(`${harness.origin}/assets/index.js`);
    await fetch(`${harness.origin}/nothing-here.js`);
    await fetch(`${harness.origin}/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    await fetch(`${harness.origin}/api/snapshot?whatever=1`);

    await harness.close();
    harness = undefined;

    expect(HASH(dbPath)).toBe(bytesBefore);
    expect(dumpRows(dbPath)).toEqual(rowsBefore);
  });

  it('leaves it byte-identical even while the process still holds it open', async () => {
    // Closing a WAL database normally checkpoints it and deletes the -wal. A read-only
    // connection cannot, and must not — Orca may be mid-write on the other side of it. So
    // the file has to be untouched *during* the read, not merely restored after it.
    const dbPath = liveShapeCorpus().write(tempDbPath());
    const bytesBefore = HASH(dbPath);

    harness = await serve(dbPath);
    await harness.snapshot();

    expect(HASH(dbPath)).toBe(bytesBefore);
  });

  it('reports the corpus honestly — the fixture is the real shape, so the invariant is a real test', async () => {
    const dbPath = liveShapeCorpus().write(tempDbPath());
    harness = await serve(dbPath);

    // A guard on the guard: if the corpus were empty, everything above would pass
    // vacuously. 466 messages is the live database's message count.
    expect((await harness.snapshot()).seq).toBe(466);
  });
});
