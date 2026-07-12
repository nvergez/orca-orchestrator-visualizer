import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type DiscoveryOptions, listCandidates, resolveDatabase } from '../../src/server/discovery.ts';
import { FixtureBuilder } from '../fixtures/builder.ts';
import { tempDir } from '../fixtures/temp-dir.ts';

/**
 * Discovery is what #14 is really about. The failure it exists to prevent is **silently
 * visualizing a different database than the one the user named** — so the tests that carry
 * the most weight here are the ones proving a fall-through *cannot* happen.
 *
 * Every case runs against a fake home directory holding real database files, so the
 * platform tables are exercised rather than merely restated.
 */

const AT = new Date('2026-07-08T12:00:00Z');

/** A real, openable `orchestration.db` inside `<parent>/<name>/`, as Orca lays it out. */
function orcaDir(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  return new FixtureBuilder().task({ createdAt: AT }).write(join(dir, 'orchestration.db'));
}

/** Orca's live-instance marker, written beside the database. */
function runtimeFile(dbPath: string, pid: number): void {
  writeFileSync(join(dbPath, '..', 'orca-runtime.json'), JSON.stringify({ pid, runtimeId: 'r' }));
}

/** Move a database's mtime, so the discovery tiebreak has something to break on. */
function touch(dbPath: string, at: number): void {
  utimesSync(dbPath, new Date(at), new Date(at));
}

/** A path, as a regex that matches it inside an error message. */
function mentions(path: string): RegExp {
  return new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/** Linux, an empty home, nothing running — each test adds only what it is about. */
function options(home: string, overrides: Partial<DiscoveryOptions> = {}): DiscoveryOptions {
  return {
    platform: 'linux',
    home,
    env: { XDG_CONFIG_HOME: join(home, '.config') },
    probe: () => false,
    readMounts: () => null,
    ...overrides,
  };
}

describe('an explicit database', () => {
  it('is used when it works', () => {
    const explicit = orcaDir(tempDir(), 'somewhere-else');

    expect(resolveDatabase(options(tempDir(), { db: explicit }))).toBe(explicit);
  });

  it('is a hard error when it does not exist — and never falls through to a default that does', () => {
    const home = tempDir();
    const theDefault = orcaDir(join(home, '.config'), 'orca');
    const named = join(tempDir(), 'not-here.db');

    // The whole ticket in one assertion. The user named a database, it does not work, and
    // the tool refuses — rather than quietly showing them a different one that happened to
    // be lying around.
    expect(() => resolveDatabase(options(home, { db: named }))).toThrow(mentions(named));
    expect(() => resolveDatabase(options(home, { db: named }))).not.toThrow(mentions(theDefault));
  });

  it('is a hard error when the path exists but is not a database', () => {
    const home = tempDir();
    orcaDir(join(home, '.config'), 'orca'); // A perfectly good default, which must not win.
    const notADb = join(tempDir(), 'orchestration.db');
    writeFileSync(notADb, 'this is not sqlite');

    expect(() => resolveDatabase(options(home, { db: notADb }))).toThrow(mentions(notADb));
  });

  it('reads ORCA_VIZ_DB with the same semantics as the flag, hard error included', () => {
    const home = tempDir();
    const explicit = orcaDir(tempDir(), 'from-the-env');

    expect(resolveDatabase(options(home, { env: { ORCA_VIZ_DB: explicit } }))).toBe(explicit);

    orcaDir(join(home, '.config'), 'orca'); // A default that exists…
    const missing = join(tempDir(), 'gone.db');

    expect(() =>
      // …and is still not substituted for the database the env var named.
      resolveDatabase(options(home, { env: { XDG_CONFIG_HOME: join(home, '.config'), ORCA_VIZ_DB: missing } }))
    ).toThrow(mentions(missing));
  });

  it('lets the flag win over the env var', () => {
    const fromFlag = orcaDir(tempDir(), 'flag');
    const fromEnv = orcaDir(tempDir(), 'env');

    expect(resolveDatabase(options(tempDir(), { db: fromFlag, env: { ORCA_VIZ_DB: fromEnv } }))).toBe(fromFlag);
  });
});

describe('ORCA_USER_DATA_PATH', () => {
  it('is honoured before the platform defaults — it is how Orca points us at a dev instance', () => {
    const home = tempDir();
    orcaDir(join(home, '.config'), 'orca');
    const instance = tempDir();
    const dbPath = orcaDir(instance, 'some-instance');

    const chosen = resolveDatabase(
      options(home, {
        env: { XDG_CONFIG_HOME: join(home, '.config'), ORCA_USER_DATA_PATH: join(instance, 'some-instance') },
      })
    );

    expect(chosen).toBe(dbPath);
  });

  it('is only a hint: an empty one falls through to the platform defaults rather than erroring', () => {
    const home = tempDir();
    const theDefault = orcaDir(join(home, '.config'), 'orca');

    // Orca does not reliably export it into every shell it spawns, so a miss here is not
    // the user naming a database — it is an absent hint, and falling through is right.
    const chosen = resolveDatabase(
      options(home, {
        env: { XDG_CONFIG_HOME: join(home, '.config'), ORCA_USER_DATA_PATH: join(tempDir(), 'nothing-here') },
      })
    );

    expect(chosen).toBe(theDefault);
  });
});

describe('the platform defaults', () => {
  it('mirrors Orca on Linux: ${XDG_CONFIG_HOME:-~/.config}/orca', () => {
    const home = tempDir();
    const dbPath = orcaDir(join(home, '.config'), 'orca');

    // With XDG_CONFIG_HOME unset, the fallback is ~/.config — the same directory.
    expect(resolveDatabase(options(home, { env: {} }))).toBe(dbPath);
  });

  it('mirrors Orca on macOS: ~/Library/Application Support/orca', () => {
    const home = tempDir();
    const dbPath = orcaDir(join(home, 'Library', 'Application Support'), 'orca');

    expect(resolveDatabase(options(home, { platform: 'darwin', env: {} }))).toBe(dbPath);
  });

  it('mirrors Orca on Windows: %APPDATA%\\orca', () => {
    const home = tempDir();
    const appData = join(home, 'AppData', 'Roaming');
    const dbPath = orcaDir(appData, 'orca');

    expect(resolveDatabase(options(home, { platform: 'win32', env: { APPDATA: appData } }))).toBe(dbPath);
  });

  it('prefers the instance that is actually running when packaged and dev both exist', () => {
    const home = tempDir();
    const config = join(home, '.config');
    orcaDir(config, 'orca');
    const dev = orcaDir(config, 'orca-dev');
    runtimeFile(dev, 4242); // The dev build is the one that is up.

    expect(resolveDatabase(options(home, { probe: (pid) => pid === 4242 }))).toBe(dev);
  });

  it('ignores a runtime file left behind by an Orca that is no longer running', () => {
    const home = tempDir();
    const config = join(home, '.config');
    const packaged = orcaDir(config, 'orca');
    const dev = orcaDir(config, 'orca-dev');
    runtimeFile(dev, 4242);
    touch(dev, Date.now() - 60_000);
    touch(packaged, Date.now()); // …but the packaged one is the database being written.

    // "Fresh" has to mean the pid is genuinely alive. A stale runtime.json from a crashed
    // run would otherwise pin the tool to a dead instance forever.
    expect(resolveDatabase(options(home, { probe: () => false }))).toBe(packaged);
  });

  it('tiebreaks on the most recent database mtime when nothing is live', () => {
    const home = tempDir();
    const config = join(home, '.config');
    const packaged = orcaDir(config, 'orca');
    const dev = orcaDir(config, 'orca-dev');
    touch(packaged, Date.now() - 60_000);
    touch(dev, Date.now());

    expect(resolveDatabase(options(home))).toBe(dev);
  });

  it('says where it looked when it finds nothing at all', () => {
    const home = tempDir();

    expect(() => resolveDatabase(options(home))).toThrow(/no Orca database/i);
    expect(() => resolveDatabase(options(home))).toThrow(mentions(join(home, '.config', 'orca')));
  });
});

describe('a database on a network filesystem', () => {
  it('is refused, because WAL does not cross hosts', () => {
    const mount = tempDir();
    const dbPath = orcaDir(mount, 'orca');
    const mounts = `server:/export ${join(mount, 'orca')} nfs4 rw,relatime 0 0\n`;

    expect(() => resolveDatabase(options(tempDir(), { db: dbPath, readMounts: () => mounts }))).toThrow(
      /network filesystem/i
    );
    expect(() => resolveDatabase(options(tempDir(), { db: dbPath, readMounts: () => mounts }))).toThrow(/WAL/);
  });

  it('names the filesystem it found, so the user can tell WSL from sshfs', () => {
    const mount = tempDir();
    const dbPath = orcaDir(mount, 'orca');
    const mounts = [
      '/dev/sda1 / ext4 rw 0 0', // The nearest enclosing mount wins, not merely the first that matches.
      `drvfs ${mount} 9p rw 0 0`,
    ].join('\n');

    expect(() => resolveDatabase(options(tempDir(), { db: dbPath, readMounts: () => mounts }))).toThrow(/9p/);
  });

  it('leaves an ordinary local database alone', () => {
    const home = tempDir();
    const dbPath = orcaDir(join(home, '.config'), 'orca');

    expect(resolveDatabase(options(home, { readMounts: () => '/dev/sda1 / ext4 rw,relatime 0 0\n' }))).toBe(dbPath);
  });
});

describe('--list-dbs', () => {
  it('prints every candidate with where it came from, its liveness and its mtime', () => {
    const home = tempDir();
    const packaged = orcaDir(join(home, '.config'), 'orca');
    runtimeFile(packaged, 4242);

    const found = listCandidates(options(home, { probe: (pid) => pid === 4242 })).find(
      (candidate) => candidate.dbPath === packaged
    );

    expect(found).toMatchObject({
      exists: true,
      liveness: 'live',
      orcaPid: 4242,
      schemaVersion: 5,
      source: 'platform default',
    });
    expect(found?.mtime).toBeInstanceOf(Date);
  });

  it('lists the candidates that are absent too, so the user can see where it looked', () => {
    const home = tempDir();

    const candidates = listCandidates(options(home));

    expect(candidates.map((candidate) => candidate.dbPath)).toContain(
      join(home, '.config', 'orca-dev', 'orchestration.db')
    );
    expect(candidates.every((candidate) => !candidate.exists)).toBe(true);
  });
});
