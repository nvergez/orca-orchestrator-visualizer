import { useEffect, useState } from 'react';
import { type ArchiveCompatibility, ArchiveError, readArchive, type RunArchive } from '../shared/archive.ts';
import type { RunSnapshot, TaskDetail } from '../shared/types.ts';
import type { HistoryLoaders } from './history.ts';
import type { TaskLoader } from './inspector/detail.ts';

/**
 * **The archived replay's whole transport** (#74) — one GET, once, and then nothing.
 *
 * The live client has two moving parts: an `EventSource` that rings when the database changes,
 * and loaders that fetch what the ring named (`Live.tsx`, `history.ts`). A replay has neither,
 * because there is nothing behind it that could change: `GET /api/archive` returns the file the
 * user opened — **verbatim**, as the server read it off disk — and every loader below is a pure
 * function over that one object.
 *
 * That is what makes "no polling, no liveness claim" a property of the code rather than a promise
 * about it: there is no timer here, no retry, no cursor, and no second read to be stale against.
 *
 * The file is validated *twice*, deliberately and cheaply: at boot, so an unreadable archive is an
 * actionable sentence in the terminal instead of a blank tab; and here, so the compatibility of
 * the bytes the browser actually holds is decided by the same reader that decided it in Node
 * (`src/shared/archive.ts`) rather than by a flag the server sent along beside them.
 */

/** What a replay is looking at: the artifact, and how much of it this build understands. */
export type ArchiveView = {
  archive: RunArchive;
  compatibility: ArchiveCompatibility;
};

export type ArchiveState = {
  view: ArchiveView | null;
  /** Why there is none — written for the screen, because there is no terminal to print it to. */
  error: string | null;
};

/** The real transport: the one route an archived replay has. */
export async function fetchArchive(): Promise<ArchiveView> {
  const response = await fetch('/api/archive');
  if (!response.ok) throw new Error(`The replay server could not serve this archive (${response.status}).`);

  return readArchive(await response.json());
}

/**
 * The artifact, fetched once — and never again, for as long as the tab is open.
 *
 * The empty dependency list is the feature. A live page re-reads on every push because the file
 * under it moves; nothing moves under an archive, so a second read could only ever return the
 * same bytes.
 */
export function useArchive(load: () => Promise<ArchiveView> = fetchArchive): ArchiveState {
  const [state, setState] = useState<ArchiveState>({ view: null, error: null });

  useEffect(() => {
    let current = true;

    void load().then(
      (view) => {
        if (current) setState({ view, error: null });
      },
      (error: unknown) => {
        if (!current) return;
        // The reader's refusal is already written for a person (`ArchiveError`); anything else is
        // a network or server failure, and says so.
        const failure = error instanceof ArchiveError ? error.toString() : (error as Error).message;
        setState({ view: null, error: failure });
      }
    );

    return () => {
      current = false;
    };
    // The archive is fetched once, on mount: a replay has nothing to re-read.
  }, [load]);

  return state;
}

/**
 * The run index and the selected-run snapshot, **out of the file** — the same two loaders `<App>`
 * is handed live (`history.ts`), answering from an object instead of from a database.
 *
 * The index is one page long and has no cursor, because an archive holds exactly one run: "Load
 * older history" cannot appear, because there is no older history in this file to load. An id
 * that is not that run's returns null — the same 404 the live loader turns into "this run is
 * gone", which is exactly what a run that is not in this archive is.
 */
export function archiveHistory(archive: RunArchive): HistoryLoaders {
  const snapshot: Omit<RunSnapshot, 'meta'> = {
    run: archive.run,
    tasks: archive.tasks,
    attempts: archive.attempts,
    gates: archive.gates,
    turns: archive.turns,
    linkedTasks: archive.linkedTasks,
    coordinatorRuns: archive.coordinatorRuns,
  };

  return {
    index: () => ({ runs: [archive.run], nextCursor: null, coordinatorRuns: archive.coordinatorRuns }),
    run: (runId) => (runId === archive.run.id ? snapshot : null),
  };
}

/**
 * What clicking a node fetches, in a replay: the two bodies the exporter took out of the database
 * in full, and the attempts the snapshot already carries.
 *
 * The attempts are **not** stored twice in the file (`archive.attempts` is the one copy), so they
 * are joined here rather than duplicated there — a second copy of an attempt history is a second
 * copy that can disagree with the first, which is the rule `TaskDetail` was designed around live.
 */
export function archiveTaskLoader(archive: RunArchive): TaskLoader {
  return async (taskId) => {
    const bodies = archive.bodies[taskId];
    if (bodies === undefined) {
      // Not a task of the exported run: an archive holds one run, and the far end of a dependency
      // edge that leaves it was never exported with its bodies (`server/archive.ts`).
      throw new Error('This task is not in this archive — only the exported run’s tasks are.');
    }

    const detail: TaskDetail = {
      id: taskId,
      spec: bodies.spec,
      result: bodies.result,
      attempts: archive.attempts[taskId] ?? [],
    };

    return detail;
  };
}
