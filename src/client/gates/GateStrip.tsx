import { OctagonAlert } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { Aurora } from '@/components/fx/aurora';
import { Spotlight, useSpotlight } from '@/components/fx/spotlight';
import { cn } from '@/lib/utils';
import type { Gate, Task } from '../../shared/types.ts';
import { GATE_THEME } from '../canvas/theme.ts';
import { COPY_ON_HOVER, CopyButton } from '../copy.tsx';
import { enter, SPRING } from '../motion.ts';
import { useIsMobile } from '../viewport.tsx';

/**
 * The decision blocking your orchestration, above the canvas, in your way.
 *
 * It is the one panel in this tool that is allowed to **interrupt**, and everything about it
 * follows from that (SPEC §7.4):
 *
 * - **It appears only when the selected run has a gate whose `blocking` flag is true.** Nothing
 *   blocked, nothing on screen — a strip that is always there is furniture, and furniture stops
 *   being read. And `blocking` is the server's separate present-effect fact (#45), never the
 *   mere absence of a reply: an unanswered historical ask is not enough evidence to interrupt.
 *   This is why it is not a tab: a tab you forget to open is exactly what a blocking question
 *   must not be behind.
 * - **It shows the question, the options, and the task it blocks**, and clicking it selects
 *   that task — straight from the question to the context that raised it.
 * - **A gate that names no task still appears.** 32 of the 53 gate messages in the live
 *   database carry no `payload.taskId`: they block the *run*, they mark no node, and there is
 *   nothing to click through to. Hiding them would hide the majority of every real blocker.
 * - **It never offers to answer.** This tool does not write to the database — not a gate
 *   resolution, not anything (SPEC §1.2). It shows you the question; you go and answer it in
 *   Orca.
 *
 * And it is the **one surface in the tool with an aurora behind it** (SPEC §7.9). Everything else
 * on this page is a fact you read and it holds still. This is a fact that is *waiting* — and a
 * light that will not sit still is what a thing that will not go away looks like. It is slow (a
 * 19-to-25-second cycle) because it has to stay bearable for as long as the gate blocks, which
 * on a real database is hours.
 *
 * The gates arrive already derived, already scoped to the run and already blocking: the server
 * owns all of that (`server/gates.ts`), because a client that re-derived which questions were
 * really blocking would be a second implementation of the ticket's whole trap.
 */

export type GateStripProps = {
  /** The selected run's **blocking** gates, oldest first. Empty ⇒ nothing renders at all. */
  gates: Gate[];
  /** The selected run's tasks — a gate names a task id, and a person needs its title. */
  tasks: Task[];
  /** Clicking a gate goes to the task it blocks, which centres the node and opens its story. */
  onSelectTask: (taskId: string) => void;
};

export function GateStrip({ gates, tasks, onSelectTask }: GateStripProps) {
  const isMobile = useIsMobile();
  // The one task-less gate whose question is currently unclamped. On desktop the full text is a
  // hover away (the `title` tooltip); on touch there is no hover, so a tap holds it open instead.
  // One at a time, because the strip's whole budget is a few lines above the canvas — two
  // multi-paragraph questions open at once would be the unbounded strip all over again.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (gates.length === 0) return null;

  const titleOf = (taskId: string): string => tasks.find((task) => task.id === taskId)?.title ?? taskId;

  return (
    <motion.section
      data-testid="gate-strip"
      // A status, not an alert: it is important, and it is not an emergency. An assertive live
      // region would interrupt a screen reader mid-sentence every time a run got blocked.
      role="status"
      aria-label={`${gates.length} blocking decision ${gates.length === 1 ? 'gate' : 'gates'}`}
      initial={enter({ opacity: 0, y: -10 })}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className={cn(
        'relative shrink-0 overflow-hidden rounded-xl border px-4 py-2.5',
        // Several blocking gates in one run is a real shape, and an unbounded strip would eat
        // the canvas it is supposed to be pointing at.
        'max-h-40 overflow-y-auto',
        // A phone's canvas is the scarcer one, so the budget tightens with it — and tightens
        // again in landscape, where vertical room is the whole fight.
        'max-lg:max-h-28 max-lg:px-3 max-lg:py-2 max-lg:landscape:max-h-20',
        GATE_THEME.surface
      )}
      // A rim of its own orange, and no more. The strip is already the brightest surface on the
      // page by virtue of being the only *coloured* one; a halo on top of that read as a strip
      // that was on fire, which is a louder claim than the data makes. The run is stopped, not
      // burning — and a warning that overstates itself is a warning that gets turned off.
      style={{ boxShadow: '0 0 0 1px color-mix(in oklch, var(--gate) 35%, transparent), var(--lift-2)' }}
    >
      <Aurora colour="var(--gate)" />

      <ul className="relative flex flex-col gap-1">
        {gates.map((gate) => {
          // Bound once, so the narrowing survives into the callback — and so the two branches
          // are visibly the same question asked of the same value: is there a node to go to?
          const taskId = gate.taskId;

          return (
            // The copy button sits **beside** the row rather than inside it: the row is a button,
            // and a button inside a button is not a thing HTML has.
            <li key={gate.id} data-testid="gate" className="group/copy flex items-start gap-1">
              {taskId === null ? (
                isMobile ? (
                  // On touch the `title` tooltip inside GateEntry is dead, and a task-less gate
                  // has no inspector to click through to — so the row itself becomes the way to
                  // the full question: tap to unclamp, tap to fold it back. This is *reading*,
                  // not resolving — the strip still offers to answer nothing (SPEC §1.2).
                  <button
                    type="button"
                    aria-expanded={expandedId === gate.id}
                    onClick={() => setExpandedId((current) => (current === gate.id ? null : gate.id))}
                    className="min-w-0 flex-1 cursor-pointer rounded-lg px-1.5 py-1 text-left"
                  >
                    <GateEntry gate={gate} blocks={null} clamp={expandedId !== gate.id} />
                  </button>
                ) : (
                  <div className="min-w-0 flex-1 px-1.5 py-1">
                    <GateEntry gate={gate} blocks={null} />
                  </div>
                )
              ) : (
                <GateButton
                  gate={gate}
                  blocks={titleOf(taskId)}
                  onSelect={() => onSelectTask(taskId)}
                  className="min-w-0 flex-1"
                />
              )}

              {/*
                The id of the question — which is what you need to go and *answer* it, and the strip
                is where a person is standing when they decide to. **A gate that names no task is the
                only place this is reachable at all**: 32 of the 53 gate messages on the live database
                carry no `payload.taskId`, they open no inspector, and until now their id appeared
                nowhere in the tool.
              */}
              <CopyButton value={gate.id} label="gate id" className={cn('mt-1', COPY_ON_HOVER, 'hover:bg-gate/15')} />
            </li>
          );
        })}
      </ul>
    </motion.section>
  );
}

/** A gate with a node at the other end of it: the whole row is the way there. */
function GateButton({
  gate,
  blocks,
  onSelect,
  className,
}: {
  gate: Gate;
  blocks: string;
  onSelect: () => void;
  className?: string;
}) {
  const spotlight = useSpotlight();

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative block w-full cursor-pointer rounded-lg px-1.5 py-1 text-left',
        'hover:bg-gate/10 focus-visible:ring-gate/50 transition-colors focus-visible:ring-2 focus-visible:outline-none',
        className
      )}
      {...spotlight}
    >
      <Spotlight colour="var(--gate)" />
      <GateEntry gate={gate} blocks={blocks} />
    </button>
  );
}

/**
 * One question. `blocks` is the *title* of the task it is holding up — or null, which is a fact
 * about the gate and not a gap in the data, and is said out loud rather than left blank.
 * `clamp` is true everywhere except a tapped-open task-less row on mobile, where the tooltip
 * that normally carries the full text does not exist.
 */
function GateEntry({ gate, blocks, clamp = true }: { gate: Gate; blocks: string | null; clamp?: boolean }) {
  return (
    <span className="relative flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[13px]">
      <OctagonAlert aria-hidden className="size-4 shrink-0 translate-y-0.5" />

      {/*
        Clamped, and not because a question is unimportant — because on the real database a
        question is often several paragraphs of an agent explaining itself, and an unclamped
        strip would swallow the canvas it exists to point at. The whole of it is one hover away,
        and the message that raised it is in the conversation, in full, where a body belongs.
      */}
      <b
        title={gate.question}
        className={cn('min-w-0 flex-[1_1_240px] leading-snug font-semibold whitespace-pre-line', clamp && 'line-clamp-3')}
      >
        {gate.question}
      </b>

      {gate.options.map((option) => (
        <span
          key={option}
          className={cn(
            'border-gate/60 bg-background/70 rounded-full border px-2 py-px text-[11px] font-medium',
            // The options are the shape of the answer, and the shape is the fastest thing on this
            // strip to read — so they brighten under the pointer with the row that holds them.
            'transition-colors group-hover:border-gate group-hover:bg-background'
          )}
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
