import { OctagonAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Gate, Task } from '../../shared/types.ts';
import { GATE_THEME } from '../canvas/theme.ts';

/**
 * The decision blocking your orchestration, above the canvas, in your way.
 *
 * It is the one panel in this tool that is allowed to **interrupt**, and everything about it
 * follows from that (SPEC §7.4):
 *
 * - **It appears only when the selected run has an open gate.** Nothing blocked, nothing on
 *   screen — a strip that is always there is furniture, and furniture stops being read. This is
 *   why it is not a tab: a tab you forget to open is exactly what a blocking question must not
 *   be behind.
 * - **It shows the question, the options, and the task it blocks**, and clicking it selects
 *   that task — straight from the question to the context that raised it.
 * - **A gate that names no task still appears.** 32 of the 53 gate messages in the live
 *   database carry no `payload.taskId`: they block the *run*, they mark no node, and there is
 *   nothing to click through to. Hiding them would hide the majority of every real blocker.
 * - **It never offers to answer.** This tool does not write to the database — not a gate
 *   resolution, not anything (SPEC §1.2). It shows you the question; you go and answer it in
 *   Orca.
 *
 * The gates arrive already derived, already scoped to the run and already open: the server owns
 * all of that (`server/gates.ts`), because a client that re-derived which questions were still
 * unanswered would be a second implementation of the ticket's whole trap.
 */

export type GateStripProps = {
  /** The selected run's **open** gates, oldest first. Empty ⇒ nothing renders at all. */
  gates: Gate[];
  /** The selected run's tasks — a gate names a task id, and a person needs its title. */
  tasks: Task[];
  /** Clicking a gate goes to the task it blocks, which centres the node and filters the feed. */
  onSelectTask: (taskId: string) => void;
};

export function GateStrip({ gates, tasks, onSelectTask }: GateStripProps) {
  if (gates.length === 0) return null;

  const titleOf = (taskId: string): string => tasks.find((task) => task.id === taskId)?.title ?? taskId;

  return (
    <section
      data-testid="gate-strip"
      // A status, not an alert: it is important, and it is not an emergency. An assertive live
      // region would interrupt a screen reader mid-sentence every time a run got blocked.
      role="status"
      aria-label={`${gates.length} open decision ${gates.length === 1 ? 'gate' : 'gates'}`}
      className={cn(
        'shrink-0 overflow-y-auto border-b px-4 py-2.5',
        // Several open gates in one run is a real shape (13 open across the live database), and
        // an unbounded strip would eat the canvas it is supposed to be pointing at.
        'max-h-40',
        GATE_THEME.surface
      )}
    >
      <ul className="flex flex-col gap-1.5">
        {gates.map((gate) => {
          // Bound once, so the narrowing survives into the callback — and so the two branches
          // are visibly the same question asked of the same value: is there a node to go to?
          const taskId = gate.taskId;

          return (
            <li key={gate.id} data-testid="gate">
              {taskId === null ? (
                <GateEntry gate={gate} blocks={null} />
              ) : (
                <button
                  type="button"
                  onClick={() => onSelectTask(taskId)}
                  className="hover:bg-gate/10 focus-visible:ring-gate/50 block w-full cursor-pointer rounded-md px-1.5 py-0.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
                >
                  <GateEntry gate={gate} blocks={titleOf(taskId)} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * One question. `blocks` is the *title* of the task it is holding up — or null, which is a fact
 * about the gate and not a gap in the data, and is said out loud rather than left blank.
 */
function GateEntry({ gate, blocks }: { gate: Gate; blocks: string | null }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[13px]">
      <OctagonAlert aria-hidden className="size-4 shrink-0 translate-y-0.5" />

      {/*
        Clamped, and not because a question is unimportant — because on the real database a
        question is often several paragraphs of an agent explaining itself, and an unclamped
        strip would swallow the canvas it exists to point at. The whole of it is one hover away,
        and the message that raised it is in the feed, in full, where a body belongs.
      */}
      <b title={gate.question} className="line-clamp-3 min-w-0 flex-[1_1_240px] leading-snug font-semibold whitespace-pre-line">
        {gate.question}
      </b>

      {gate.options.map((option) => (
        <span
          key={option}
          className="border-gate/60 bg-background/70 rounded-full border px-2 py-px text-[11px] font-medium"
        >
          {option}
        </span>
      ))}

      <span className="text-[11px] opacity-80">
        {blocks === null ? 'blocks this run — no task named' : `blocks ${blocks}`}
      </span>
    </span>
  );
}
