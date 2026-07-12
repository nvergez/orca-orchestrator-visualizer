import type { DatabaseSync } from 'node:sqlite';
import type { CoordinatorRun } from '../shared/types.ts';
import { type Columns, selectPresent, text } from './rows.ts';
import { isoInstant } from './time.ts';

/**
 * `coordinator_runs` — the table that looks like the run key and is not.
 *
 * It is written only by Orca's built-in `Coordinator` loop, which agent- and CLI-driven
 * coordination never uses: the live database has **zero rows** in it (SPEC §4.2, trap 3).
 * Scoping the canvas by it would render nothing, forever, on real runs — which is exactly why
 * runs are *inferred* from the task handles instead (`runs.ts`).
 *
 * So it is read and rendered **if rows exist**, and **nothing depends on it**. That is the
 * whole contract: a coordinator row is a fact worth showing when one is there, and it buys
 * the inferred runs nothing when it is not.
 */

/**
 * `spec` is not among them, and that is not an oversight: it is the coordinator's prompt — the
 * same kind of body the task snapshot omits, and for the same reason (SPEC §6.3).
 */
const COORDINATOR_RUN_COLUMNS = [
  'id',
  'status',
  'coordinator_handle',
  'poll_interval_ms',
  'created_at',
  'completed_at',
] as const;

export function readCoordinatorRuns(db: DatabaseSync, columns: Columns): CoordinatorRun[] {
  return selectPresent(db, 'coordinator_runs', columns.coordinator_runs, COORDINATOR_RUN_COLUMNS).map(
    (row): CoordinatorRun => ({
      id: text(row.id) ?? '',
      // Verbatim, like every other enum in this schema: an unfamiliar status names a real state.
      status: text(row.status) ?? '',
      coordinatorHandle: text(row.coordinator_handle) ?? '',
      pollIntervalMs: Number(row.poll_interval_ms ?? 0),
      createdAt: isoInstant(row.created_at) ?? '',
      // The second of the two ISO-written columns in the schema (SPEC §4.2, trap 5) — the
      // normalization is what keeps it comparable with the SQL-written `created_at` above it.
      completedAt: isoInstant(row.completed_at),
    })
  );
}
