import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Liveness } from '../shared/types.ts';
import { databaseMtime, DB_FILE } from './db-files.ts';
import { StartupError } from './errors.ts';
import { type ProcessProbe, probeProcess, readLiveness } from './liveness.ts';

/**
 * Finding Orca's database — and refusing to guess.
 *
 * Resolution order, first hit wins, every candidate validated before it is accepted
 * (SPEC §3): `--db` → `ORCA_VIZ_DB` → `$ORCA_USER_DATA_PATH/orchestration.db` → the
 * platform defaults.
 *
 * The asymmetry in here is deliberate and is the point of the ticket. The first two are
 * **the user naming a database**: if the named one does not work, that is a hard error and
 * we stop. We do not fall through to a platform default that happens to exist, because
 * showing someone a different database than the one they asked for — with no visible
 * difference between the two — is the worst thing this tool could do.
 *
 * `ORCA_USER_DATA_PATH` is *not* in that category. Orca exports it into the processes it
 * spawns, but not reliably into every one of them, so its absence is an absent hint rather
 * than an instruction, and a miss falls through.
 */

export type CandidateSource = '--db' | 'ORCA_VIZ_DB' | 'ORCA_USER_DATA_PATH' | 'platform default';

export type Candidate = {
  dbPath: string;
  source: CandidateSource;
  exists: boolean;
  /** Is the Orca that owns this database running right now? Drives the preference order. */
  liveness: Liveness;
  orcaPid: number | null;
  /** Most recent of the database and its WAL — the WAL is part of the database. */
  mtime: Date | null;
  /** `PRAGMA user_version`, or null when the file could not be opened as a database. */
  schemaVersion: number | null;
  /** Why this candidate is unusable, in a sentence, or null when it is fine. */
  problem: string | null;
};

export type DiscoveryOptions = {
  /** `--db`. */
  db?: string | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  probe?: ProcessProbe;
  /** The mount table. Injected so the network-filesystem check is testable. */
  readMounts?: () => string | null;
};

type Resolved = Required<Omit<DiscoveryOptions, 'db'>> & { db?: string | undefined };

function withDefaults(options: DiscoveryOptions): Resolved {
  return {
    db: options.db,
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    home: options.home ?? homedir(),
    probe: options.probe ?? probeProcess,
    readMounts: options.readMounts ?? readMountTable,
  };
}

/**
 * The userData directories Orca itself would use, mirroring its own `getDefaultUserDataPath`
 * (`src/cli/runtime/metadata.ts`). The app name is **lowercase `orca` on every platform**:
 * the packaged `package.json` has `"name": "orca"` and no `productName`, so Electron
 * resolves `userData` lowercase — `~/.config/Orca` does not exist even on the machine this
 * was verified against (`docs/research/db-discovery.md` §1).
 *
 * The `-dev` sibling is the dev build's, and both can be running at once — Electron's
 * single-instance lock is keyed on the userData path, so one machine really can hold two
 * live databases.
 */
export function defaultUserDataDirs({ platform, env, home }: Pick<Resolved, 'platform' | 'env' | 'home'>): string[] {
  const roots = () => {
    if (platform === 'darwin') return join(home, 'Library', 'Application Support');
    if (platform === 'win32') return env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return env.XDG_CONFIG_HOME || join(home, '.config');
  };
  const base = roots();
  return [join(base, 'orca'), join(base, 'orca-dev')];
}

/** Every place the tool would look, in order — the answer `--list-dbs` prints. */
export function listCandidates(options: DiscoveryOptions = {}): Candidate[] {
  const resolved = withDefaults(options);
  const { env } = resolved;

  const planned: { dbPath: string; source: CandidateSource }[] = [];
  if (resolved.db) planned.push({ dbPath: resolved.db, source: '--db' });
  if (env.ORCA_VIZ_DB) planned.push({ dbPath: env.ORCA_VIZ_DB, source: 'ORCA_VIZ_DB' });
  if (env.ORCA_USER_DATA_PATH) {
    planned.push({ dbPath: join(env.ORCA_USER_DATA_PATH, DB_FILE), source: 'ORCA_USER_DATA_PATH' });
  }
  for (const dir of defaultUserDataDirs(resolved)) {
    planned.push({ dbPath: join(dir, DB_FILE), source: 'platform default' });
  }

  return planned.map(({ dbPath, source }) => inspect(resolve(dbPath), source, resolved));
}

/**
 * The database this run will read, or a `StartupError` explaining why there isn't one.
 *
 * Never returns a database the user did not ask for when they asked for a specific one.
 */
export function resolveDatabase(options: DiscoveryOptions = {}): string {
  const resolved = withDefaults(options);
  const candidates = listCandidates(options);

  // The two the user named. A problem with either one ends the run — it is never a reason
  // to go looking somewhere else.
  const named = candidates.find(({ source }) => source === '--db' || source === 'ORCA_VIZ_DB');
  if (named) {
    if (named.problem) throw explain(named);
    return checkedForNetworkFs(named.dbPath, resolved);
  }

  const hint = candidates.find(({ source }) => source === 'ORCA_USER_DATA_PATH');
  if (hint && !hint.problem) return checkedForNetworkFs(hint.dbPath, resolved);

  const usable = candidates.filter(({ source, problem }) => source === 'platform default' && !problem);
  if (usable.length === 0) throw nothingFound(candidates);

  return checkedForNetworkFs(preferred(usable).dbPath, resolved);
}

/**
 * Which of several platform defaults is *the* one: the instance that is actually running,
 * and failing that the one most recently written to.
 *
 * "Fresh `orca-runtime.json`" has to mean the pid in it is genuinely alive. A crashed Orca
 * leaves its runtime file behind, and taking the file's mere existence as freshness would
 * pin the tool to a dead instance for as long as that file sat there.
 */
function preferred(candidates: Candidate[]): Candidate {
  return [...candidates].sort((a, b) => {
    const live = Number(b.liveness === 'live') - Number(a.liveness === 'live');
    if (live !== 0) return live;
    return (b.mtime?.getTime() ?? 0) - (a.mtime?.getTime() ?? 0);
  })[0]!;
}

/** Existence, openability, `PRAGMA user_version`, liveness, mtime — for one path. */
function inspect(dbPath: string, source: CandidateSource, { probe }: Resolved): Candidate {
  const mtime = databaseMtime(dbPath);
  const base: Candidate = {
    dbPath,
    source,
    exists: mtime !== null,
    mtime,
    schemaVersion: null,
    problem: null,
    ...readLiveness(dbPath, probe),
  };

  if (!base.exists) return { ...base, problem: 'no such file' };

  // Validation is an actual read-only open, not a stat: a file called orchestration.db
  // that SQLite cannot open is not a database, and finding that out now is the difference
  // between a clear error and a mystery three seconds later.
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    return { ...base, problem: (error as Error).message };
  }

  try {
    // A version we do not recognise is a banner, never a refusal (SPEC §3) — so this
    // records the version and judges nothing.
    const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
    return { ...base, schemaVersion: user_version };
  } catch (error) {
    return { ...base, problem: (error as Error).message };
  } finally {
    db.close();
  }
}

function explain(candidate: Candidate): StartupError {
  return new StartupError(
    `${candidate.source} points at ${candidate.dbPath}, which cannot be read: ${candidate.problem}.`,
    'Refusing to fall back to a different database — you asked for this one. Run `orca-viz --list-dbs` to see what is available.'
  );
}

function nothingFound(candidates: Candidate[]): StartupError {
  const looked = candidates.map((candidate) => `    ${candidate.dbPath} — ${candidate.problem}`).join('\n');
  return new StartupError(
    `Found no Orca database. Looked in:\n${looked}`,
    'Point at one explicitly with --db <path>, or set ORCA_VIZ_DB.'
  );
}

/* ---------------------------------------------------------------------------------------
 * Network filesystems
 *
 * SQLite is explicit: "All processes using a database must be on the same host computer;
 * WAL does not work over a network filesystem." Reading Orca's database across NFS, SMB,
 * 9p, `/mnt/c` from WSL, or an sshfs mount does not fail loudly — it fails *quietly*, with
 * a reader that sees a torn view of the WAL. So this is a startup error, by design.
 * ------------------------------------------------------------------------------------- */

const NETWORK_FILESYSTEMS = new Set([
  'nfs',
  'nfs4',
  'cifs',
  'smbfs',
  'smb3',
  '9p', // WSL's /mnt/c, and Plan 9 shares generally.
  'drvfs', // WSL 1's Windows drive mount.
  'sshfs',
  'fuse.sshfs',
  'fuse.rclone',
  'davfs',
  'fuse.davfs',
  'afs',
  'ceph',
  'glusterfs',
  'lustre',
  'ncpfs',
  'coda',
]);

function readMountTable(): string | null {
  try {
    return readFileSync('/proc/mounts', 'utf8');
  } catch {
    return null; // Not Linux, or a kernel without procfs.
  }
}

/**
 * The filesystem type the path sits on, when the platform can tell us and it is a network
 * one; null otherwise.
 *
 * Linux (which is also WSL, and so covers `/mnt/c`) is answered exactly, from the kernel's
 * own mount table. Windows answers the case it can see without shelling out — a UNC path.
 *
 * **macOS is a known gap:** telling an NFS mount from a local one there needs `statfs`,
 * which Node does not expose and which we will not spawn a subprocess to reach. Every case
 * the ticket enumerates — NFS/SMB/9p, `/mnt/c` from WSL, sshfs — is a Linux mount and is
 * caught here.
 */
export function networkFilesystem(
  dbPath: string,
  { platform, readMounts }: Pick<Resolved, 'platform' | 'readMounts'>
): string | null {
  if (platform === 'win32') {
    return dbPath.startsWith('\\\\') || dbPath.startsWith('//') ? 'a UNC network share' : null;
  }

  const table = readMounts();
  if (!table) return null;

  const target = resolve(dbPath);
  let deepest: { point: string; type: string } | null = null;

  for (const line of table.split('\n')) {
    // `/proc/mounts`: device, mount point, fs type, options… Spaces in a mount point are
    // written as the octal escape `\040`.
    const [, point, type] = line.split(' ');
    if (!point || !type) continue;

    const mountPoint = point.replace(/\\040/g, ' ');
    const contains = target === mountPoint || target.startsWith(mountPoint.endsWith(sep) ? mountPoint : mountPoint + sep);
    if (!contains) continue;

    // The *nearest enclosing* mount owns the file: `/` matches everything, so the longest
    // matching mount point is the one that actually holds the database.
    if (!deepest || mountPoint.length > deepest.point.length) deepest = { point: mountPoint, type };
  }

  return deepest && NETWORK_FILESYSTEMS.has(deepest.type) ? deepest.type : null;
}

function checkedForNetworkFs(dbPath: string, resolved: Resolved): string {
  const type = networkFilesystem(dbPath, resolved);
  if (!type) return dbPath;

  throw new StartupError(
    `${dbPath} is on a network filesystem (${type}), which SQLite's WAL mode does not support.`,
    'All processes using a WAL database must be on one host. Run orca-viz on the machine Orca runs on, and browse to it over HTTP.'
  );
}
