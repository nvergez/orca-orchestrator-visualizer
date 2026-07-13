import { useEffect, useRef, useState } from 'react';
import type { Run } from '../../shared/types.ts';

/**
 * Which run the canvas is showing — and, just as importantly, which run it is *not* going to
 * switch to behind your back.
 *
 * Two rules, and they pull against each other, which is why this is a hook and not a
 * `useState` at the call site:
 *
 * - **The page opens on the most recently active run** (SPEC §7.2), so the tool shows you
 *   something useful before you have clicked anything.
 * - **It never auto-jumps afterwards** (SPEC §7.3). A run starting while you read a
 *   post-mortem is *news*, not an instruction: it gets a "new run started ↑" chip, and the
 *   canvas stays where you left it. A default that silently re-evaluated to "the newest run"
 *   on every tick would yank the canvas out from under you at the worst possible moment —
 *   the one where something just started going wrong.
 */

export type RunSelection = {
  /** The run the canvas renders. Null only when the database holds no tasks at all. */
  selected: Run | null;
  select: (runId: string) => void;
  /** A run that appeared *after* you started reading. Null when there is nothing to announce. */
  newRunId: string | null;
};

export function useRunSelection(runs: Run[]): RunSelection {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [announcedId, setAnnouncedId] = useState<string | null>(null);
  const known = useRef<Set<string>>(new Set());
  const opened = useRef(false);

  useEffect(() => {
    // **News is what sorts ahead of the window you had — not merely an id you had not seen.**
    //
    // `runs` is a window the reader can extend *downwards*: "Load older history" (#69) appends a
    // page of orchestrations from days ago, and every id on it is one this client has never seen.
    // Read freshness as "unseen" and paging backwards announces the newest run of the *older*
    // page as though an orchestration had just started — a chip that, followed, throws the reader
    // out of the post-mortem they were reading and into one from last week, which is the very
    // yank SPEC §7.3 exists to forbid, dressed up as an invitation.
    //
    // So the question is where a run *landed*. The list is most-recent-first, and an
    // orchestration that started while you were reading sorts ahead of every run you already
    // held: it is above the topmost row you recognise. Everything below that row is history,
    // and history arriving because you asked for it is not an event. When no row is recognised
    // at all — an `orchestration reset` wiped what we held — there is nothing left to sort
    // behind, and the list is news in its entirety.
    const recognised = runs.findIndex((run) => known.current.has(run.id));
    const ahead = recognised === -1 ? runs : runs.slice(0, recognised);
    for (const run of runs) known.current.add(run.id);
    if (runs.length === 0) return;

    // The first run list is not news — it is the page. It opens on the run at the top, which
    // the server has already sorted to be the most recently active one.
    if (!opened.current) {
      opened.current = true;
      setPickedId(runs[0]!.id);
      return;
    }

    // …and anything at the head of a run list after that is news. `runs` is most-recent-first,
    // so the first of them is the newest.
    if (ahead.length > 0) setAnnouncedId(ahead[0]!.id);
  }, [runs]);

  // A selection can outlive its run: an `orchestration reset` wipes the tasks it was made of.
  // Falling back to the top of the rail beats rendering an empty canvas for a run that is gone.
  const selected = runs.find((run) => run.id === pickedId) ?? runs[0] ?? null;

  const announced = runs.find((run) => run.id === announcedId) ?? null;

  return {
    selected,
    select(runId: string) {
      setPickedId(runId);
      if (runId === announcedId) setAnnouncedId(null);
    },
    // Nothing to announce about the run you are already looking at.
    newRunId: announced && announced.id !== selected?.id ? announced.id : null,
  };
}
