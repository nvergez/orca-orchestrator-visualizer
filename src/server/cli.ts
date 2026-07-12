import { parseArgs } from 'node:util';
import { StartupError } from './errors.ts';

/** SPEC §6.4: loopback only, and a port nobody else wants. */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4269;
export const DEFAULT_POLL_INTERVAL_MS = 5000;

export type Options = {
  /** `--db`. An explicit database: a hard error if it does not work (SPEC §3). */
  db: string | undefined;
  listDbs: boolean;
  port: number;
  host: string;
  /** The poll loop's cadence (SPEC §6.1) — how often the SSE stream looks for a change. */
  pollIntervalMs: number;
  /** `--watch` (#59): also watch the database directory, to wake that poll early on a change. */
  watch: boolean;
  /** Auto-open the browser. `--no-open` turns it off; so do a pipe, CI and SSH. */
  open: boolean;
  help: boolean;
  version: boolean;
};

export const HELP = `orca-viz — a read-only web visualizer for Orca's orchestration database.

Usage: npx orca-viz [options]

Options:
  --db <path>            The orchestration.db to read. A database that does not work is an
                         error — orca-viz will never quietly show you a different one.
                         Also settable as ORCA_VIZ_DB.
  --list-dbs             Print every database orca-viz can find, with its liveness and
                         mtime, and exit.
  --port <n>             Port to listen on (default ${DEFAULT_PORT}). A port that is taken is an
                         error, not a hop to another one — a hunted port would break the
                         URL orca-viz just opened for you.
  --host <host>          Address to bind (default ${DEFAULT_HOST}). Loopback by design: the
                         database holds your task specs, agent prompts and message bodies.
  --poll-interval <ms>   How often to re-read the database (default ${DEFAULT_POLL_INTERVAL_MS}).
  --watch                Also watch the database directory, and run the normal poll early
                         when a file changes. A hint, never a source: the poll stays
                         authoritative, and if watching fails orca-viz warns once and
                         carries on polling.
  --no-open              Do not open a browser. Also suppressed automatically when stdout
                         is not a terminal, or over SSH, or with no display.
  --version              Print the version and exit.
  --help                 Print this and exit.

Discovery order, first hit wins:
  --db → ORCA_VIZ_DB → $ORCA_USER_DATA_PATH/orchestration.db → the platform defaults
  (~/.config/orca on Linux, ~/Library/Application Support/orca on macOS, %APPDATA%\\orca on
  Windows, each with an orca-dev sibling).

orca-viz is unofficial, third-party, and strictly read-only. It never writes to the database.`;

/** Whole, non-negative, and actually a number — `--port banana` is a typo, not a port. */
function integerOption(flag: string, raw: string, { min, max }: { min: number; max: number }): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new StartupError(`${flag} expects a whole number between ${min} and ${max}, but got "${raw}".`);
  }
  return value;
}

export function parseOptions(argv: string[]): Options {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTION_SPEC }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTION_SPEC, allowPositionals: false });
  } catch (error) {
    throw new StartupError((error as Error).message, 'Run `orca-viz --help` for the flags.');
  }

  const { values } = parsed;
  return {
    db: values.db,
    listDbs: values['list-dbs'] ?? false,
    // 0 is legal and means "any free port" — the OS picks and orca-viz prints what it got.
    port: values.port === undefined ? DEFAULT_PORT : integerOption('--port', values.port, { min: 0, max: 65535 }),
    host: values.host ?? DEFAULT_HOST,
    pollIntervalMs:
      values['poll-interval'] === undefined
        ? DEFAULT_POLL_INTERVAL_MS
        : integerOption('--poll-interval', values['poll-interval'], { min: 100, max: 3_600_000 }),
    watch: values.watch ?? false,
    open: !(values['no-open'] ?? false),
    help: values.help ?? false,
    version: values.version ?? false,
  };
}

const OPTION_SPEC = {
  db: { type: 'string' },
  'list-dbs': { type: 'boolean' },
  port: { type: 'string' },
  host: { type: 'string' },
  'poll-interval': { type: 'string' },
  watch: { type: 'boolean' },
  'no-open': { type: 'boolean' },
  version: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;
