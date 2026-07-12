import { readFileSync } from 'node:fs';
import type { Liveness } from '../shared/types.ts';
import { runtimeFilePath } from './db-files.ts';

/**
 * Is this data live, or is it the last-known state of an Orca that is no longer running?
 *
 * Answered from a plain file read of `orca-runtime.json` plus `process.kill(pid, 0)` —
 * **never by spawning the `orca` CLI** (SPEC §2.1). The CLI dies with the app, so asking
 * it would fail in exactly the case this answer exists to describe: Orca is closed and we
 * are reading yesterday's run. The file, and the process table, keep working.
 */

/** `orca-runtime.json`, as the running app writes it (verified live: `{ runtimeId, pid, transports, authToken, startedAt }`). */
type RuntimeFile = { pid?: unknown };

export type LivenessReport = { liveness: Liveness; orcaPid: number | null };

/** Does this pid exist? Signal 0 checks for the process without touching it. */
export type ProcessProbe = (pid: number) => boolean;

export const probeProcess: ProcessProbe = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process is there and simply belongs to someone else — which is
    // still alive. Only ESRCH ("no such process") means dead.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * - runtime file present, pid alive → `live`
 * - runtime file absent, or its pid is dead → `stale` ("Orca isn't running; showing
 *   last-known state from …")
 * - runtime file unreadable or malformed → `unknown`, which the UI degrades to the same
 *   stale wording: we genuinely do not know, and pretending otherwise is the one thing
 *   this tool must not do.
 *
 * A dead pid is still reported in `orcaPid` — we read it, it is what `--list-dbs` and a
 * bug report want to see, and hiding it would make a stale instance indistinguishable
 * from one that never ran.
 */
export function readLiveness(dbPath: string, probe: ProcessProbe = probeProcess): LivenessReport {
  let contents: string;
  try {
    contents = readFileSync(runtimeFilePath(dbPath), 'utf8');
  } catch {
    return { liveness: 'stale', orcaPid: null };
  }

  let runtime: RuntimeFile;
  try {
    runtime = JSON.parse(contents) as RuntimeFile;
  } catch {
    return { liveness: 'unknown', orcaPid: null };
  }

  const pid = runtime?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return { liveness: 'unknown', orcaPid: null };
  }

  return { liveness: probe(pid) ? 'live' : 'stale', orcaPid: pid };
}
