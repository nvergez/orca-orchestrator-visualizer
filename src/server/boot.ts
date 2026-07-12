import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { openBrowser as launchBrowser, shouldOpenBrowser } from './browser.ts';
import { HELP, type Options, parseOptions } from './cli.ts';
import { OrcaDatabase } from './database.ts';
import { type Candidate, listCandidates, resolveDatabase } from './discovery.ts';
import { StartupError } from './errors.ts';
import { type ProcessProbe, probeProcess } from './liveness.ts';
import { createServer } from './server.ts';

/**
 * The boot path, from an argv to a listening server — everything `npx orca-viz` does.
 *
 * It is a function rather than a script, and every edge it touches (the environment, the
 * process table, the mount table, the terminal, the browser) arrives as an argument. That
 * is what lets the tests drive the *real* CLI — real discovery, real database, real HTTP —
 * instead of a paraphrase of it.
 */

export type BootOptions = {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  probe?: ProcessProbe;
  readMounts?: () => string | null;
  /** Is stdout a terminal? Decides whether a browser was implicitly asked for. */
  isTTY?: boolean;
  print?: (line: string) => void;
  openBrowser?: (url: string) => void;
};

/** A running orca-viz — or null, when the command was one that just prints and exits. */
export type Booted = { url: string; close(): Promise<void> } | null;

export async function boot(options: BootOptions): Promise<Booted> {
  const {
    argv,
    env = process.env,
    platform = process.platform,
    home = homedir(),
    probe = probeProcess,
    readMounts,
    isTTY = process.stdout.isTTY ?? false,
    print = console.log,
    openBrowser = (url: string) => launchBrowser(url, platform),
  } = options;

  const cli = parseOptions(argv);
  const discovery = { db: cli.db, env, platform, home, probe, readMounts };

  if (cli.help) {
    print(HELP);
    return null;
  }
  if (cli.version) {
    print(packageVersion());
    return null;
  }
  if (cli.listDbs) {
    for (const line of describeCandidates(listCandidates(discovery))) print(line);
    return null;
  }

  const dbPath = resolveDatabase(discovery);
  const database = new OrcaDatabase(dbPath, { probe });

  try {
    const server = createServer({ database });
    await listen(server, cli);

    const url = `http://${displayHost(cli.host)}:${(server.address() as AddressInfo).port}`;

    // Always say what you are reading (SPEC §3). It is one line, and it is the difference
    // between trusting this tool and wondering about it.
    print(`orca-viz  reading ${dbPath}`);
    print(`          ${describeState(database)}`);
    print(`          listening on ${url}`);

    if (shouldOpenBrowser({ open: cli.open, isTTY, env, platform })) openBrowser(url);

    return {
      url,
      close: async () => {
        await new Promise((resolve) => server.close(resolve));
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * **No silent port-hunting** (SPEC §6.4). A hop to another port would break the URL we
 * just opened a browser at, and any bookmark of it — so a taken port is an error the user
 * gets to decide about.
 */
function listen(server: Server, { port, host }: Options): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new StartupError(
            `Port ${port} is already in use on ${host}.`,
            'orca-viz will not hop to another port — that would break the URL it just opened and any bookmark of it. Free the port, or pass --port <n>.'
          )
        );
        return;
      }
      if (error.code === 'EADDRNOTAVAIL' || error.code === 'EACCES') {
        reject(new StartupError(`Cannot bind ${host}:${port}: ${error.message}.`));
        return;
      }
      reject(error);
    });
    server.listen(port, host, resolve);
  });
}

/** A summary of what the user is about to look at: live, or the last-known state. */
function describeState(database: OrcaDatabase): string {
  const { liveness, schemaVersion, schemaSupport, dbMtime, degraded, resetDetected } = database.snapshot().meta;

  const state =
    liveness === 'live'
      ? 'connected to a running Orca'
      : `Orca isn't running; showing last-known state from ${dbMtime}`;
  const schema =
    schemaSupport === 'supported'
      ? `schema v${schemaVersion}`
      : `schema v${schemaVersion} (${schemaSupport} than this build — ${degraded.length} feature(s) degraded)`;

  return [state, schema, resetDetected ? 'a reset has wiped part of the history' : null].filter(Boolean).join(' · ');
}

/** `0.0.0.0` is not somewhere a browser can go; `localhost` is. */
function displayHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? 'localhost' : host;
}

/** `--list-dbs`: every candidate, with the two facts you need to pick between them. */
function describeCandidates(candidates: Candidate[]): string[] {
  return [
    'orca-viz  databases it can find, in the order it would choose them:',
    '',
    ...candidates.map((candidate) => {
      const state = candidate.exists
        ? `${candidate.liveness}${candidate.orcaPid ? ` (pid ${candidate.orcaPid})` : ''} · schema v${candidate.schemaVersion} · ${candidate.mtime?.toISOString()}`
        : (candidate.problem ?? 'unusable');
      return `  ${candidate.dbPath}\n    ${candidate.source} · ${state}`;
    }),
  ];
}

/**
 * The version npm published, read from the package's own manifest — `files: ["dist"]` still
 * ships package.json, and dist/server/ sits two levels under the package root exactly as
 * src/server/ does, so one relative path works both compiled and straight from source.
 */
function packageVersion(): string {
  const manifest = new URL('../../package.json', import.meta.url);
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version;
}
