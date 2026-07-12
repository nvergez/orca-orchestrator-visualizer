import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boot, type BootOptions, type Booted } from '../../src/server/boot.ts';
import { nodeVersionError } from '../../src/server/node-support.ts';
import { FixtureBuilder } from '../fixtures/builder.ts';
import { tempDbPath, tempDir } from '../fixtures/temp-dir.ts';

/**
 * The CLI, driven the way a user drives it: an argv in, a running (or refusing) process
 * out. Everything the terminal prints is captured, because *what the tool tells you it is
 * looking at* is half of what this ticket ships.
 */

const AT = new Date('2026-07-08T12:00:00Z');

let booted: Booted;

afterEach(async () => {
  await booted?.close();
  booted = null;
});

function fixtureDb(): string {
  return new FixtureBuilder().task({ createdAt: AT }).write(tempDbPath());
}

type Run = { lines: string[]; opened: string[]; booted: Booted };

/** Boot with everything a headed, interactive terminal has, unless a test says otherwise. */
async function run(argv: string[], overrides: Partial<BootOptions> = {}): Promise<Run> {
  const lines: string[] = [];
  const opened: string[] = [];

  booted = await boot({
    argv,
    env: {},
    platform: 'linux',
    home: tempDir(),
    probe: () => false,
    readMounts: () => null,
    isTTY: true,
    print: (line) => lines.push(line),
    openBrowser: (url) => opened.push(url),
    ...overrides,
  });

  return { lines, opened, booted };
}

describe('--help and --version', () => {
  it('prints the flags and starts nothing', async () => {
    const { lines, booted } = await run(['--help']);

    expect(booted).toBeNull();
    const help = lines.join('\n');
    for (const flag of ['--db', '--list-dbs', '--port', '--host', '--poll-interval', '--no-open', '--version']) {
      expect(help).toContain(flag);
    }
  });

  it('prints the package version and starts nothing', async () => {
    const { lines, booted } = await run(['--version']);

    expect(booted).toBeNull();
    expect(lines.join('\n')).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('--list-dbs', () => {
  it('prints every candidate with its liveness and mtime, and starts nothing', async () => {
    const home = tempDir();
    const dir = join(home, '.config', 'orca');
    mkdirSync(dir, { recursive: true });
    new FixtureBuilder().task({ createdAt: AT }).write(join(dir, 'orchestration.db'));

    const { lines, booted } = await run(['--list-dbs'], { home, env: { XDG_CONFIG_HOME: join(home, '.config') } });

    expect(booted).toBeNull();
    const printed = lines.join('\n');
    expect(printed).toContain(join(dir, 'orchestration.db'));
    expect(printed).toContain('stale'); // Nothing is running in a temp directory.
    expect(printed).toContain(join(home, '.config', 'orca-dev', 'orchestration.db')); // Absent, and still listed.
  });

  it('says *why* a candidate is unusable, rather than reporting it as healthy', async () => {
    const home = tempDir();
    const dir = join(home, '.config', 'orca');
    mkdirSync(dir, { recursive: true });
    // A file in exactly the right place that SQLite cannot open. It still has an mtime and
    // a liveness — so printing those and swallowing the reason would describe a corrupt
    // database as a fine one, which is the case you run --list-dbs to understand.
    writeFileSync(join(dir, 'orchestration.db'), 'this is not sqlite');

    const { lines } = await run(['--list-dbs'], { home, env: { XDG_CONFIG_HOME: join(home, '.config') } });

    const printed = lines.join('\n');
    expect(printed).toContain(join(dir, 'orchestration.db'));
    expect(printed).not.toContain('schema vnull');
    expect(printed).toMatch(/not a database|file is encrypted|malformed/i);
  });
});

describe('booting', () => {
  it('serves the snapshot of the database it was pointed at', async () => {
    const dbPath = fixtureDb();

    const { booted } = await run(['--db', dbPath, '--port', '0']);

    const response = await fetch(`${booted!.url}/api/snapshot`);
    const snapshot = (await response.json()) as { meta: { dbPath: string } };
    expect(snapshot.meta.dbPath).toBe(dbPath);
  });

  it('logs the database it chose, so you always know what you are looking at', async () => {
    const dbPath = fixtureDb();

    const { lines } = await run(['--db', dbPath, '--port', '0']);

    expect(lines.join('\n')).toContain(dbPath);
  });

  it('prints the URL it is listening on', async () => {
    const { lines, booted } = await run(['--db', fixtureDb(), '--port', '0']);

    expect(lines.join('\n')).toContain(booted!.url);
  });

  it("tells the terminal what it tells the page: Orca isn't running, and from when the data is", async () => {
    // The same spec'd sentence the browser shows (SPEC §6.1). Asserted here as a literal,
    // and in `app.test.tsx` as a literal, so the two sides are pinned to the same words by
    // the tests and not merely by sharing a function.
    const { lines } = await run(['--db', fixtureDb(), '--port', '0']);

    expect(lines.join('\n')).toContain("Orca isn't running; showing last-known state from");
  });

  it('says it is connected when Orca really is running', async () => {
    const dbPath = fixtureDb();
    writeFileSync(join(dbPath, '..', 'orca-runtime.json'), JSON.stringify({ pid: 4242 }));

    const { lines } = await run(['--db', dbPath, '--port', '0'], { probe: (pid) => pid === 4242 });

    expect(lines.join('\n')).toContain('connected to a running Orca (pid 4242)');
  });

  /**
   * The terminal gets the same truth as the page (#21). A user who starts the tool against an
   * Orca it does not quite fit should learn that *here*, before they go hunting the browser
   * for a badge that was never going to render.
   */
  it('names the features an older Orca cost you, rather than counting them', async () => {
    const dbPath = new FixtureBuilder({ userVersion: 4 }).task({ createdAt: AT }).write(tempDbPath());

    const { lines } = await run(['--db', dbPath, '--port', '0']);

    const printed = lines.join('\n');
    expect(printed).toContain('older Orca schema');
    // Which feature, and what you get instead — not "1 feature(s) degraded".
    expect(printed).toContain('Task titles');
    expect(printed).toContain('short id');
  });

  it('warns that a newer Orca may be mislabeled, and starts anyway', async () => {
    const dbPath = new FixtureBuilder({ userVersion: 6 }).task({ createdAt: AT }).write(tempDbPath());

    const { lines, booted } = await run(['--db', dbPath, '--port', '0']);

    expect(booted).not.toBeNull(); // A newer schema is a banner, never a refusal.
    // The same sentence the page puts in its banner, written once in `shared/wording.ts`.
    expect(lines.join('\n')).toContain('newer Orca schema — some data may be missing or mislabeled');
  });

  it('names a feature a missing column cost you even at the version it was built for', async () => {
    // The columns decide, not the version number (#21): a v5 Orca that renamed or dropped one
    // still costs a feature, and the terminal owes the user that as much as an older Orca does.
    const dbPath = new FixtureBuilder({ omitColumns: { dispatch_contexts: ['last_heartbeat_at'] } })
      .task({ createdAt: AT })
      .write(tempDbPath());

    const { lines } = await run(['--db', dbPath, '--port', '0']);

    expect(lines.join('\n')).toContain('last seen');
  });

  it('says nothing about the schema when the schema is the one it was built for', async () => {
    const { lines } = await run(['--db', fixtureDb(), '--port', '0']);

    expect(lines.join('\n')).not.toMatch(/degraded|mislabeled/i);
  });

  it('refuses a port that is taken rather than silently hopping to another one', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as AddressInfo).port;

    try {
      // A hunted port would break the URL it just auto-opened, and any bookmark of it.
      await expect(run(['--db', fixtureDb(), '--port', String(taken)])).rejects.toThrow(
        new RegExp(`${taken}.*(in use|already)`, 'is')
      );
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('rejects a port that is not a port', async () => {
    await expect(run(['--db', fixtureDb(), '--port', 'banana'])).rejects.toThrow(/--port/);
  });

  it('carries no enrichment on the wire unless --orca-enrichment asked for it (#61)', async () => {
    const { booted } = await run(['--db', fixtureDb(), '--port', '0']);

    const snapshot = (await (await fetch(`${booted!.url}/api/snapshot`)).json()) as Record<string, unknown>;
    expect('enrichment' in snapshot).toBe(false);
  });

  it('turns the live-context adapter on behind --orca-enrichment, and says so', async () => {
    // `probe: () => false` keeps this honest to run anywhere: Orca is stale in a temp home,
    // so the live-only adapter suspends and no real `orca` process is ever spawned by a test.
    const { lines, booted } = await run(['--db', fixtureDb(), '--port', '0', '--orca-enrichment']);

    const snapshot = (await (await fetch(`${booted!.url}/api/snapshot`)).json()) as {
      enrichment?: { state: string; workers: unknown[] };
    };
    expect(snapshot.enrichment).toEqual({ state: 'suspended', fetchedAt: null, workers: [] });
    expect(lines.join('\n')).toContain('live Orca context');
  });

  it('rejects a poll interval that is not a duration', async () => {
    await expect(run(['--db', fixtureDb(), '--poll-interval', '-5'])).rejects.toThrow(/--poll-interval/);
  });
});

describe('the browser auto-open', () => {
  it('opens the URL it just printed, because typing the command *is* the request to see it', async () => {
    const { opened, booted } = await run(['--db', fixtureDb(), '--port', '0'], { env: { DISPLAY: ':0' } });

    expect(opened).toEqual([booted!.url]);
  });

  it('suppresses itself on --no-open', async () => {
    const { opened } = await run(['--db', fixtureDb(), '--port', '0', '--no-open'], { env: { DISPLAY: ':0' } });

    expect(opened).toEqual([]);
  });

  it('suppresses itself when stdout is not a terminal — a pipe or CI did not ask for a browser', async () => {
    const { opened } = await run(['--db', fixtureDb(), '--port', '0'], { env: { DISPLAY: ':0' }, isTTY: false });

    expect(opened).toEqual([]);
  });

  it('suppresses itself over SSH', async () => {
    const { opened } = await run(['--db', fixtureDb(), '--port', '0'], {
      env: { DISPLAY: ':0', SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' },
    });

    expect(opened).toEqual([]);
  });

  it('suppresses itself on a headless box with no display', async () => {
    // A headless `orca serve` host: print the URL, do not fail trying to open a browser
    // that is not there.
    const { opened, lines, booted } = await run(['--db', fixtureDb(), '--port', '0'], { env: {} });

    expect(opened).toEqual([]);
    expect(lines.join('\n')).toContain(booted!.url);
  });
});

describe('the Node floor', () => {
  it('tells a Node 20 user the version they need and how to get it', () => {
    const message = nodeVersionError('20.11.0');

    // The alternative failure is a cryptic `Cannot find module 'node:sqlite'`, which is
    // exactly the npx story dying at the first step.
    expect(message).toContain('22.5');
    expect(message).toContain('20.11.0');
    expect(message).toMatch(/npx -y node@22/);
  });

  it('is silent on a Node that can actually run this', () => {
    expect(nodeVersionError('22.5.0')).toBeNull();
    expect(nodeVersionError('24.0.1')).toBeNull();
    expect(nodeVersionError('22.4.1')).not.toBeNull(); // The floor is 22.5, not 22.
  });
});
