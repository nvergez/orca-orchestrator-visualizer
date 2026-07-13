import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RunArchive } from '../shared/archive.ts';
import type { Meta } from '../shared/types.ts';
import {
  archiveCompatibilitySentence,
  archivedSentence,
  livenessSentence,
  schemaSentence,
} from '../shared/wording.ts';
import { loadArchiveFile } from './archive.ts';
import { openBrowser as launchBrowser, shouldOpenBrowser } from './browser.ts';
import { HELP, type Options, parseOptions } from './cli.ts';
import { OrcaDatabase } from './database.ts';
import { type Candidate, discoveryContext, listCandidates, resolveDatabase } from './discovery.ts';
import { StartupError } from './errors.ts';
import type { ProcessProbe } from './liveness.ts';
import type { ReadMounts } from './network-fs.ts';
import { createReplayServer, createServer } from './server.ts';
import { toolVersion } from './version.ts';

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
  readMounts?: ReadMounts;
  /** Is stdout a terminal? Decides whether a browser was implicitly asked for. */
  isTTY?: boolean;
  print?: (line: string) => void;
  openBrowser?: (url: string) => void;
};

/** A running orca-viz — or null, when the command was one that just prints and exits. */
export type Booted = { url: string; close(): Promise<void> } | null;

export async function boot(options: BootOptions): Promise<Booted> {
  const { argv, isTTY = process.stdout.isTTY ?? false, print = console.log } = options;

  const cli = parseOptions(argv);

  // One resolved view of the environment for the whole boot: discovery reads the same
  // process table and mount table that the browser decision reads the terminal from.
  const context = discoveryContext({ ...options, db: cli.db });
  const { env, platform, probe } = context;
  const openBrowser = options.openBrowser ?? ((url: string) => launchBrowser(url, platform));

  if (cli.help) {
    print(HELP);
    return null;
  }
  if (cli.version) {
    print(toolVersion());
    return null;
  }
  if (cli.listDbs) {
    for (const line of describeCandidates(listCandidates(context))) print(line);
    return null;
  }

  // **The fork in the whole tool** (#74). Everything below this line opens a database, discovers
  // one, polls it and reports how alive it is. A replay does none of those things — so it does
  // not run any of them, rather than running them against nothing.
  if (cli.archive !== undefined) {
    return await replay(cli.archive, cli, { print, openBrowser, isTTY, env, platform });
  }

  const dbPath = resolveDatabase(context);
  const database = new OrcaDatabase(dbPath, { probe });

  try {
    const { server, close: stopServing } = createServer({ database, pollIntervalMs: cli.pollIntervalMs });
    await listen(server, cli);

    const url = `http://${displayHost(cli.host)}:${(server.address() as AddressInfo).port}`;

    // Always say what you are reading (SPEC §3). It is a few lines, and it is the difference
    // between trusting this tool and wondering about it.
    const meta = database.snapshot().meta;
    print(`orca-viz  reading ${dbPath}`);
    print(`          ${describeState(meta)}`);
    for (const line of describeSchema(meta)) print(`          ${line}`);
    print(`          listening on ${url}`);

    if (shouldOpenBrowser({ open: cli.open, isTTY, env, platform })) openBrowser(url);

    return {
      url,
      close: async () => {
        // Streams down, then the port, then the file — a browser holding an SSE response open
        // would otherwise keep `server.close()` waiting for as long as the tab is on screen.
        await stopServing();
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * `--archive <file>` — **the archived replay** (#74, ADR 0001): a saved run, opened offline.
 *
 * Everything a live boot does is *absent* here, and the absences are the feature. No discovery,
 * because there is nothing to find. No `OrcaDatabase`, because a replay reads a file the user
 * already has. No poll interval, no liveness probe, no process table: nothing about this screen
 * can change, and the terminal says so in the same words the page will (`wording.ts`).
 *
 * The file is read and validated *before* the server is listening, so an archive this build
 * cannot open is a sentence in the terminal — with what is wrong and what to do — rather than a
 * blank browser tab pointed at a port (`loadArchiveFile`).
 */
async function replay(path: string, cli: Options, terminal: Terminal): Promise<Booted> {
  const { print, openBrowser, isTTY, env, platform } = terminal;
  const { artifact, archive, compatibility } = loadArchiveFile(path);

  const { server, close } = createReplayServer({ artifact });
  await listen(server, cli);

  const url = `http://${displayHost(cli.host)}:${(server.address() as AddressInfo).port}`;

  print(`orca-viz  replaying ${path}`);
  print(`          ${describeArchive(archive)}`);
  // The one sentence a replay owes above all others, and the same one the page shows.
  print(`          ${archivedSentence(archive.provenance)}`);
  const incompatible = archiveCompatibilitySentence(compatibility, archive.provenance);
  if (incompatible !== null) print(`          ${incompatible}`);
  // What the *source* database's schema cost this evidence, months ago — the same list the live
  // boot prints, because it is the same fact and the archive is what still remembers it.
  for (const line of describeSchema(archive.provenance.source)) print(`          ${line}`);
  print(`          listening on ${url}`);

  if (shouldOpenBrowser({ open: cli.open, isTTY, env, platform })) openBrowser(url);

  return { url, close };
}

/**
 * What the boot path is allowed to say, and where it says it — the terminal, and the browser it
 * may open. Both boots take the same one, because "tell the user what you are looking at" (SPEC §3)
 * is owed whether the thing being looked at is a database or a file.
 */
type Terminal = {
  print: (line: string) => void;
  openBrowser: (url: string) => void;
  /** Is stdout a terminal? Decides whether a browser was implicitly asked for. */
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
};

/** Which run is in the file, how big it is, and the schema it was read through. */
function describeArchive({ run, tasks, provenance }: RunArchive): string {
  return [
    `run ${run.label}`,
    `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`,
    `exported by ${provenance.tool}`,
    `source schema v${provenance.source.schemaVersion}`,
  ].join(' · ');
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
function describeState(meta: Meta): string {
  return [
    // The same sentence the page shows — written once, in src/shared/wording.ts, so the
    // terminal and the browser cannot drift into telling the user different things. Which is
    // also why the schema is only *numbered* here: what a drifting schema means is a sentence,
    // it lives in `wording.ts`, and `describeSchema` prints that one rather than paraphrasing it.
    livenessSentence(meta),
    `schema v${meta.schemaVersion}`,
    meta.resetDetected ? 'a reset has wiped part of the history' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * What this Orca's schema costs you, **by name** (#21).
 *
 * A count would be worse than silence: "1 feature(s) degraded" tells a user that something is
 * missing and leaves them to hunt the screen for what. So the terminal prints exactly what the
 * page prints — the sentence, and then the feature, and what they get instead of it.
 */
function describeSchema(schema: Pick<Meta, 'schemaSupport' | 'degraded'>): string[] {
  const sentence = schemaSentence(schema);
  if (sentence === null) return [];

  return [sentence, ...schema.degraded.map((feature) => `  • ${feature}`)];
}

/** `0.0.0.0` is not somewhere a browser can go; `localhost` is. */
function displayHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? 'localhost' : host;
}

/**
 * `--list-dbs`: every candidate, with the facts you need to pick between them — and, when
 * a candidate is unusable, *why*.
 *
 * The problem has to win over the liveness/schema line. A file that exists but that SQLite
 * cannot open still has an mtime and a liveness, and printing those while swallowing the
 * reason would report a corrupt database as a healthy one — which is precisely the case a
 * person runs `--list-dbs` to understand.
 */
function describeCandidates(candidates: Candidate[]): string[] {
  return [
    'orca-viz  databases it can find, in the order it would choose them:',
    '',
    ...candidates.map((candidate) => {
      const state =
        candidate.problem ??
        [
          candidate.liveness + (candidate.orcaPid === null ? '' : ` (pid ${candidate.orcaPid})`),
          `schema v${candidate.schemaVersion}`,
          candidate.mtime?.toISOString(),
        ].join(' · ');
      return `  ${candidate.dbPath}\n    ${candidate.source} · ${state}`;
    }),
  ];
}
