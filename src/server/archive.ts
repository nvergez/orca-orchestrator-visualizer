import { readFileSync } from 'node:fs';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  type ArchiveCompatibility,
  ArchiveError,
  type ArchiveSource,
  derivationSentence,
  readArchive,
  type RunArchive,
  type TaskBodies,
} from '../shared/archive.ts';
import type { FeedMessage, RunSnapshot } from '../shared/types.ts';
import { StartupError } from './errors.ts';

/**
 * **The export, and the file it comes back in** (#74, ADR 0001, SPEC §12.4).
 *
 * One user, one click, one run: `GET /api/run/:id/archive` assembles the artifact and hands it
 * over, and that is the entire lifecycle. Nothing here watches, schedules, retains or resumes —
 * the export is a photograph, and this module is the shutter.
 *
 * What it does that a `JSON.stringify(snapshot)` would not, and why each of them is a rule
 * rather than a nicety:
 *
 * - **It takes the run's evidence out of the machine's.** The messages it is handed are every
 *   retained message in the database (one read, `database.ts`); the ones it *writes* are the ones
 *   attributed to this run (SPEC §4.4). Same for the conversation: a live selected-run snapshot
 *   carries the turns nothing places, because on screen they must still appear *somewhere*
 *   (§4.4, rule 3) — but in a file they would be exactly the unattributed, machine-global
 *   evidence ADR 0001 forbids exporting, so they stay behind.
 * - **It refuses to carry a liveness claim.** `Run.live` means "this run is running **now**", and
 *   now is not export time when the file is opened next March. An archive that carried a green
 *   dot forward would be this tool's worst lie, told into the future, so the exported run is
 *   `live: false` and the replay says *archived* in words instead.
 * - **It records what it is, and not where it was.** Format version, export instant, the source
 *   schema and what a missing column had already cost it — but never the database path. A path
 *   is not identity; it is somebody's laptop.
 */

/** Everything one export needs, already read: the query layer's, so this stays pure and testable. */
export type ArchiveInput = {
  /** The complete selected-run snapshot (`history.ts`) — never windowed, never truncated. */
  snapshot: Omit<RunSnapshot, 'meta'>;
  /** **Every** retained message the database holds. Filtering to the run is this module's job. */
  messages: FeedMessage[];
  /** `tasks.spec` / `tasks.result`, in full, for this run's tasks (`task-detail.ts`). */
  bodies: Record<string, TaskBodies>;
  source: ArchiveSource;
  exportedAt: Date;
  /** `orca-viz 0.5.0` — the build that derived this. */
  tool: string;
};

export function assembleArchive({ snapshot, messages, bodies, source, exportedAt, tool }: ArchiveInput): RunArchive {
  const runId = snapshot.run.id;

  return {
    provenance: {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      exportedAt: exportedAt.toISOString(),
      tool,
      source,
      derivation: derivationSentence(source.schemaVersion),
    },

    // The run, minus the one field that would be a claim about the future rather than a fact
    // about the past. Everything else on it — the cast, the waves, the tallies — is an aggregate
    // over evidence that is right here in the file.
    run: { ...snapshot.run, live: false },

    tasks: snapshot.tasks,
    // The append-only retry record, whole: every attempt of every task, not the `MAX(rowid)`
    // survivor a `Task` carries.
    attempts: snapshot.attempts,
    gates: snapshot.gates,
    // This run's conversation. **Not** the turns nothing places: see the module note.
    turns: snapshot.turns.filter((turn) => turn.runId === runId),
    // The far ends of dependency edges that cross out of this run — titles and status, no bodies,
    // no attempts, no conversation. They are this run's *edges*, which is why the snapshot carries
    // them at all: without them the inspector's dep chips would call a task that exists deleted.
    linkedTasks: snapshot.linkedTasks,
    coordinatorRuns: snapshot.coordinatorRuns,

    bodies,
    // The raw rows, attributed to this run at export time — and nothing global, nothing
    // unattributed, nothing another orchestrator said.
    messages: messages.filter((message) => message.runId === runId),
  };
}

/** A file on disk, read as an archive — the bytes, the document, and how much of it we understand. */
export type LoadedArchive = {
  /** The file's bytes, verbatim — what `GET /api/archive` serves, unreshaped (`server.ts`). */
  artifact: string;
  archive: RunArchive;
  compatibility: ArchiveCompatibility;
};

/**
 * `--archive <file>`, read at boot — where an unreadable archive becomes an *actionable* failure
 * rather than a blank browser tab.
 *
 * The three ways a file fails are three different things to have happened, and the user is told
 * which: it is not there, it is not JSON, or it is JSON that is not an archive this build can
 * read (`readArchive`, `src/shared/archive.ts`). A *newer* archive is not a failure at all — it
 * boots, and the replay says so on screen.
 */
export function loadArchiveFile(path: string): LoadedArchive {
  let artifact: string;
  try {
    artifact = readFileSync(path, 'utf8');
  } catch (error) {
    throw new StartupError(
      `Could not read the archive ${path}: ${(error as Error).message}`,
      'Pass --archive <file>, where the file is the JSON an orca-viz “Export archive” saved.'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact);
  } catch (error) {
    throw new StartupError(
      `${path} is not valid JSON: ${(error as Error).message}`,
      'A run archive is the JSON file the “Export archive” button saves. This file is something else, or it is truncated.'
    );
  }

  try {
    const { archive, compatibility } = readArchive(parsed);
    return { artifact, archive, compatibility };
  } catch (error) {
    // The reader's refusal is already written for a person — it only has to reach the terminal
    // as the one error this boot path knows how to print.
    if (error instanceof ArchiveError) throw new StartupError(`${path}: ${error.message}`, error.hint);
    throw error;
  }
}
