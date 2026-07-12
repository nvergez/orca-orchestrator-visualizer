import { useEffect, useRef, useState } from 'react';
import type { StreamEvent, TaskDetail } from '../../shared/types.ts';

/**
 * How the inspector gets a task's bodies: `GET /api/task/:id`, on the click and never before
 * (#20, SPEC §6.3).
 *
 * **The laziness is the whole design.** The snapshot omits `spec` and `result` because a live
 * 71-task dump was 172 KB, almost entirely spec text — and it is pushed every time the database
 * moves. One task's spec, fetched when someone actually looks at it, is a few kilobytes once.
 *
 * The fetch is a *value*, not an import the panel reaches for. `<App>` is handed it (defaulting
 * to the real one), which is what keeps the component testable against a canned detail — the
 * same trick that keeps `<App>` testable against a canned `StreamEvent` (seam 2, #12), and for
 * the same reason: the thing worth asserting is *when* the bodies are asked for, and a stub that
 * records its calls says that plainly where a network mock would not.
 */

export type TaskLoader = (taskId: string) => Promise<TaskDetail>;

/** The real one: one small GET, and an honest error for anything that is not a 200. */
export const fetchTaskDetail: TaskLoader = async (taskId) => {
  const response = await fetch(`/api/task/${encodeURIComponent(taskId)}`);

  if (!response.ok) {
    // A 404 is a real case, not a bug: an `orchestration reset` deletes tasks the rest of the
    // file still names (SPEC §4.2, trap 8), and the panel says which of the two happened.
    throw new Error(
      response.status === 404
        ? 'This task is no longer in the database — a reset removed it.'
        : `The server could not read this task (${response.status}).`
    );
  }

  return (await response.json()) as TaskDetail;
};

export type TaskDetailState = {
  /** The bodies, the attempts and the messages — null until the first fetch lands. */
  detail: TaskDetail | null;
  /** Why there are none. The header, the gates and the dep chips render anyway: they are the snapshot's. */
  error: string | null;
};

/**
 * The selected task's detail, kept in step with the database.
 *
 * Two things make it re-read, and they are the two things that can change what the answer is:
 *
 * - **A different task.** The previous task's spec is cleared rather than left standing under a
 *   new task's header — the wrong body under the right title is the one mistake this panel must
 *   never make.
 * - **A new `StreamEvent`.** The stream only pushes when the file really changed (#17), so this
 *   is exactly "the database moved". The task you are reading may have just completed, gained a
 *   fourth dispatch attempt, or been answered — and an inspector that asked once would go on
 *   showing "no result yet" over a result sitting in the file. The previous detail stays on
 *   screen while the new one is in flight, so a live task does not flicker every five seconds.
 *
 * The loader is held in a ref rather than being a dependency, so a caller passing an inline
 * arrow gets a re-render and not an infinite refetch loop.
 */
export function useTaskDetail(taskId: string | null, event: StreamEvent | null, load: TaskLoader): TaskDetailState {
  const [state, setState] = useState<{ id: string; detail: TaskDetail | null; error: string | null } | null>(null);

  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  }, [load]);

  useEffect(() => {
    if (taskId === null) return;

    // The response to a task you have already clicked away from is not an answer to anything.
    let current = true;

    void loader.current(taskId).then(
      (detail) => {
        if (current) setState({ id: taskId, detail, error: null });
      },
      (error: unknown) => {
        if (current) setState({ id: taskId, detail: null, error: (error as Error).message });
      }
    );

    return () => {
      current = false;
    };
  }, [taskId, event]);

  // Only ever the selected task's: state that belongs to the task before it is not a stale
  // detail, it is a different task's.
  const fresh = state !== null && state.id === taskId ? state : null;

  return { detail: fresh?.detail ?? null, error: fresh?.error ?? null };
}
