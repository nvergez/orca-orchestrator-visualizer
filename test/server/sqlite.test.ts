import { describe, expect, it } from 'vitest';
import { BUSY_TIMEOUT_MS, openReadOnly } from '../../src/server/sqlite.ts';
import { FixtureBuilder } from '../fixtures/builder.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';

/**
 * `openReadOnly` is the *only* way this tool opens a database — the boot connection and
 * every discovery probe both go through it. So the two settings SPEC §2.2 makes
 * non-negotiable are asserted once, here, where they cannot be forgotten by a new caller.
 */

const AT = new Date('2026-07-08T12:00:00Z');

function fixture(): string {
  return new FixtureBuilder().task({ createdAt: AT }).write(tempDbPath());
}

describe('every connection orca-viz opens', () => {
  it('refuses to write, whatever it is asked to do', () => {
    const db = openReadOnly(fixture());

    try {
      expect(() => db.exec("UPDATE tasks SET status = 'failed'")).toThrow(/readonly|read-only/i);
      expect(() => db.exec('DELETE FROM tasks')).toThrow(/readonly|read-only/i);
    } finally {
      db.close();
    }
  });

  it('waits out a lock rather than failing the read', () => {
    // Without a busy timeout, a read landing inside one of Orca's checkpoint or recovery
    // windows fails instantly with SQLITE_BUSY. In a discovery probe that would mark a
    // perfectly good database "unusable" and move on to a *different* one — the exact
    // failure this ticket exists to prevent. Five seconds, on every connection (SPEC §2.2).
    const db = openReadOnly(fixture());

    try {
      expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: BUSY_TIMEOUT_MS });
      expect(BUSY_TIMEOUT_MS).toBe(5000);
    } finally {
      db.close();
    }
  });
});
