import type { CastMember } from '../shared/types.ts';
import type { TaskWithHandle } from './runs.ts';
import { byInstant } from './time.ts';

/**
 * **The cast: an orchestrator, and the agents it spawned.**
 *
 * This is the thing the database has always known and the screen has never said. The old rail
 * named a row after its first task's title and stopped there — so the two characters the user was
 * actually trying to follow, *who coordinated* and *who did the work*, appeared nowhere at all.
 *
 * Both are columns:
 *
 * | Screen concept | Column |
 * |---|---|
 * | The orchestrator | `tasks.created_by_terminal_handle` (the run's own `handle`) |
 * | Its agents | the `assignee_handle`s of that orchestrator's `dispatch_contexts` |
 *
 * Three decisions, and each one is paid for by a shape the schema really has:
 *
 * 1. **Every attempt's assignee, not just the surviving one.** A retry is re-dispatched to a fresh
 *    worktree with a fresh terminal handle, so the first worker exists *only* in the attempt the
 *    node badge folded away (`tasks.ts`). An agent that failed and was replaced is exactly the
 *    agent a post-mortem is looking for; dropping it would delete the most interesting member of
 *    the cast.
 *
 * 2. **The orchestrator is never in its own cast.** A coordinator that dispatched a task to
 *    itself would otherwise appear twice — once as the orchestrator and once as `A1` — and the
 *    conversation's whole notion of direction (`out` = the orchestrator, `in` = an agent) would
 *    have nothing left to hang on. Such a task simply wears no agent stripe, which is the honest
 *    answer: no agent was spawned for it.
 *
 * 3. **The monogram is the server's.** `A1`, `A2`, `A3` — in **first-dispatch order**, so the
 *    numbering is a fact about when each agent started rather than about how a map happened to
 *    iterate. It has to be one number: the rail, the node stripe and the conversation all name the
 *    same agent, and a cast numbered three times would be three castings.
 */

/** `A1`, `A2`, `A3` … — short enough for a 20px badge, unique for as many agents as a run has. */
function monogramFor(index: number): string {
  return `A${index + 1}`;
}

/**
 * The agents of one orchestrator, in the order they were first dispatched work.
 *
 * `entries` are that orchestrator's tasks, already sorted by creation (`runs.ts`). The ordering
 * that decides the monograms is the **dispatch** instant and not the task's creation, because
 * those come apart: an orchestrator can create five tasks up front and hand them out over an
 * hour, and the agent that got the *first* task is the one a reader will call "the first agent".
 *
 * `coordinator` is the run's own handle — null for the synthetic `run_unattributed`, whose tasks
 * are in it precisely because Orca never recorded who created them. Those tasks were still
 * *worked* by somebody, and that somebody is still a cast: an orchestration with no orchestrator
 * on record is not an orchestration with no agents.
 */
export function castOf(coordinator: string | null, entries: TaskWithHandle[]): CastMember[] {
  type Draft = { handle: string; taskIds: string[]; firstDispatchAt: string; lastHeartbeatAt: string | null };

  const drafts = new Map<string, Draft>();

  for (const entry of entries) {
    for (const attempt of entry.attempts) {
      const handle = attempt.assigneeHandle;

      // A dispatch row with no assignee names nobody. And the orchestrator working its own task
      // is the orchestrator, not one of its agents (decision 2 above).
      if (handle === '' || handle === coordinator) continue;

      const draft = drafts.get(handle);

      if (draft === undefined) {
        drafts.set(handle, {
          handle,
          taskIds: [entry.task.id],
          firstDispatchAt: attempt.dispatchedAt,
          lastHeartbeatAt: attempt.lastHeartbeatAt,
        });
        continue;
      }

      // The same agent can hold a task across several attempts — it is still one task it held.
      if (!draft.taskIds.includes(entry.task.id)) draft.taskIds.push(entry.task.id);

      // The earliest dispatch is what the monogram order is decided on…
      if (byInstant(attempt.dispatchedAt, draft.firstDispatchAt) < 0) {
        draft.firstDispatchAt = attempt.dispatchedAt;
      }

      // …and the latest heartbeat is what "last seen 12s ago" is. It is the agent's, across every
      // task it holds: an agent beating on one task is alive, whatever its other tasks say. A
      // pre-v2 Orca has no such column and every beat here is null — which costs the badge and
      // nothing else (`schema.ts`).
      if (
        draft.lastHeartbeatAt === null ||
        (attempt.lastHeartbeatAt !== null && byInstant(attempt.lastHeartbeatAt, draft.lastHeartbeatAt) > 0)
      ) {
        draft.lastHeartbeatAt = attempt.lastHeartbeatAt ?? draft.lastHeartbeatAt;
      }
    }
  }

  return [...drafts.values()]
    // First dispatched, first named. The handle breaks a tie, so two agents dispatched in the
    // same second do not swap monograms between two polls of an unchanged database — a cast that
    // renumbered itself under the pointer would repaint every stripe on the canvas for nothing.
    .sort((a, b) => byInstant(a.firstDispatchAt, b.firstDispatchAt) || a.handle.localeCompare(b.handle))
    .map((draft, index): CastMember => ({
      handle: draft.handle,
      monogram: monogramFor(index),
      taskIds: draft.taskIds,
      taskCount: draft.taskIds.length,
      lastHeartbeatAt: draft.lastHeartbeatAt,
    }));
}
