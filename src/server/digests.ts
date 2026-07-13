import { createHash } from 'node:crypto';
import { indexEvidence, type RunEvidence, snapshotFrom, UNPLACED } from './history.ts';

/**
 * One fingerprint per run over exactly what its selected-run snapshot serves — the poll loop
 * diffs two of these maps to fill `StreamEvent.affected` (#69), so what invalidates a snapshot
 * is, by construction, what changes it.
 *
 * This lives apart from `history.ts` for one deliberate reason: the paging and scoping functions
 * there are pure of Node so the canned client suite can import them (`test/client/canned.tsx`),
 * and `node:crypto` — which only the server's poll loop needs — must not ride along into the
 * client's typecheck.
 */

/** The digest key for what no run claims — the same string the evidence buckets use. */
export const UNPLACED_KEY = UNPLACED;

/**
 * Fingerprint every run, and the evidence nothing places, from **one** pass over the database's
 * evidence (`indexEvidence`). This runs on every changed tick, so it is written as a lookup per
 * run rather than a scan per run: a scan would make the poll loop O(runs × history), which is
 * the cost this whole ticket exists to bound.
 *
 * The unplaced turns are digested **once, under their own key**, and not inside every run's
 * digest — they ride along in every snapshot, so folding them in would make one stray message
 * "affect" every run on the machine, and a doorbell that always rings for everything has stopped
 * being targeted.
 */
export function digestRuns(evidence: RunEvidence): Map<string, string> {
  const index = indexEvidence(evidence);
  const digests = new Map<string, string>();

  for (const run of evidence.runs) {
    const snapshot = snapshotFrom(index, run.id)!;
    digests.set(run.id, digest({ ...snapshot, turns: index.turnsByRun.get(run.id) ?? [] }));
  }

  digests.set(
    UNPLACED_KEY,
    digest({
      turns: index.unplacedTurns,
      // A coordinator row no orchestrator claims is in nobody's snapshot digest above, and the
      // index still lists it — so its changes have to ring the bell somewhere.
      coordinatorRuns: index.orphanCoordinatorRuns,
    })
  );

  return digests;
}

/**
 * sha256 of the JSON — a fingerprint, not the data: a subscriber remembers 64 hex characters
 * per run instead of the run. Key order is deterministic because the objects are built by the
 * same code on every read; nothing here canonicalizes, and nothing needs to.
 */
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
