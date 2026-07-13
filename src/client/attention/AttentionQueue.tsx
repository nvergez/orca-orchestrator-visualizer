import { CircleX, HeartPulse, Megaphone, OctagonAlert, RotateCcw, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import type { AttentionItem, AttentionKind } from '../attention.ts';
import { enter, SPRING } from '../motion.ts';

/**
 * **The attention queue** — one ranked answer to "does anything need intervention now?",
 * across every orchestrator at once (#56).
 *
 * It lives at the top of the rail because the rail is already the cross-run surface: its job is
 * picking the orchestrator worth opening *without* opening it (SPEC §7.2), and this is that
 * question answered outright. The gate strip still interrupts *inside* the run you are reading;
 * the queue is how you learn which run to be inside — including one you are not looking at.
 *
 * Like the strip, it renders **nothing at all** when nothing demands attention: a queue that is
 * always there is furniture, and furniture stops being read. And like everything else in this
 * tool it only *reads* — clicking an item drives the existing selection seam (the run, and the
 * task when the cause names one) and never writes a byte back to Orca: no acknowledging, no
 * dismissing, no resolving (SPEC §1.2). The list is bounded and scrolls internally, so a noisy
 * database cannot push the orchestrator list off the panel.
 */

export type AttentionQueueProps = {
  /** Ranked, explained and stably identified by `deriveAttention` — rendered verbatim. */
  items: AttentionItem[];
  /**
   * The selection seam: the shell selects the item's run, and its task when it names one.
   *
   * **Omitted on the kiosk** (#62), which has no canvas to select into and no reader within
   * arm's reach of it — so every row renders as the fact it is rather than as a button that
   * would go nowhere. It is the same static row an item with no destination already gets, and
   * deliberately *not* a `disabled` button: a disabled control is unreachable by keyboard, and
   * being read is the whole of what these rows still have to do.
   */
  onAttend?: (item: AttentionItem) => void;
  /**
   * The panel's height budget, for the surface it stands on: the rail lends it 16rem above a
   * list it must not crowd, a wall display has a column to spare and lets it run. What it *says*
   * is never a caller's business — the order and the words are `deriveAttention`'s on both
   * screens, which is the whole of what makes them the same queue.
   */
  className?: string;
};

/**
 * Each cause wears its own icon and ink, keyed by kind so a glance separates "a question is
 * blocking" from "a worker went quiet" before a word is read. The colours are the page's
 * existing meanings: gate orange for blocking questions, the amber worker-health already wears
 * for silence and retries, the failed red for escalations and failures — no new colour, because
 * a new colour would be a new claim.
 */
const KIND_LOOK: Record<AttentionKind, { icon: LucideIcon; ink: string; label: string }> = {
  'blocking-gate': { icon: OctagonAlert, ink: 'text-gate', label: 'blocking decision gate' },
  // "Stale", never "quiet": `quiet` is a *different* worker-health state in #47 — dispatched, the
  // first beat still plausibly in flight — and it is one this tier deliberately refuses to admit.
  // Naming the row after the state it excludes is the one label that could not be right.
  'stale-worker': { icon: HeartPulse, ink: 'text-amber-700 dark:text-amber-400', label: 'stale worker' },
  'retry-risk': { icon: RotateCcw, ink: 'text-amber-700 dark:text-amber-400', label: 'retry risk' },
  escalation: { icon: Megaphone, ink: 'text-red-700 dark:text-red-400', label: 'unresolved escalation' },
  'fresh-failure': { icon: CircleX, ink: 'text-red-700 dark:text-red-400', label: 'fresh failure' },
};

export function AttentionQueue({ items, onAttend, className }: AttentionQueueProps) {
  if (items.length === 0) return null;

  return (
    <motion.section
      data-testid="attention-queue"
      // A status, not an alert — the GateStrip rule: important, and not an emergency. An
      // assertive region would interrupt a screen reader every time a worker went quiet.
      role="status"
      aria-label={`${items.length} ${items.length === 1 ? 'thing needs' : 'things need'} attention`}
      initial={enter({ opacity: 0, y: -6 })}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className={cn(
        'border-border/60 shrink-0 overflow-y-auto border-b px-2 py-1.5',
        // Bounded, and generous within the bound: a real bad day is a handful of causes, and they
        // should all be *readable* rather than clipped a row and a half in while the rail sits
        // half empty below. 16rem holds the realistic queue outright; a genuinely noisy database
        // scrolls inside it — which is the one thing it must never make the orchestrator list
        // underneath do, whose job is unaffected by how loud today is (the GateStrip's rule).
        'max-h-64',
        // …and the budget tightens with the panel, exactly as the strip's does: below `lg` the
        // rail is a 45dvh band that also owes its orchestrator list a place to stand, and a
        // queue that took 16rem of it would leave a sliver. Landscape tightens again, where
        // vertical room is the whole fight (`docs/design/mobile.md`).
        'max-lg:max-h-40 max-lg:landscape:max-h-28',
        // Last, so a caller standing it on a different surface can lift the budget the rail set
        // (`cn` is tailwind-merge: the later class wins). Only the box model — never the list.
        className
      )}
    >
      <h3 className="text-muted-foreground px-1.5 pb-1 text-[10px] font-semibold tracking-widest uppercase">
        Needs attention
        <span className="text-muted-foreground/70 ml-1.5 tabular-nums normal-case">{items.length}</span>
      </h3>

      <ul className="flex flex-col">
        {items.map((item) => (
          <AttentionRow key={item.id} item={item} onAttend={onAttend} />
        ))}
      </ul>
    </motion.section>
  );
}

const ROW_CLASS = 'flex w-full items-start gap-2 rounded-lg px-1.5 py-1 text-left';

function AttentionRow({ item, onAttend }: { item: AttentionItem; onAttend?: (item: AttentionItem) => void }) {
  // A cause the schema attributed to no run *and* no task offers nowhere to go. It is shown all
  // the same — hiding evidence over a missing join would be the queue lying about the database —
  // as a plain row rather than a dead button: a `disabled` button is unreachable by keyboard, and
  // the one thing this row still has to do is *be read*. It is the GateStrip's rule for a gate
  // that names no task, and it is the same rule.
  //
  // A screen with no `onAttend` at all — the kiosk (#62) — takes the same path for every row, and
  // for the same reason: there is nowhere for the click to land.
  const body = <AttentionBody item={item} />;

  return (
    <li>
      {onAttend === undefined || (item.taskId === null && item.runId === null) ? (
        <div data-testid="attention-item" data-kind={item.kind} data-cause={item.id} className={ROW_CLASS}>
          {body}
        </div>
      ) : (
        <button
          type="button"
          data-testid="attention-item"
          data-kind={item.kind}
          data-cause={item.id}
          onClick={() => onAttend(item)}
          className={cn(
            ROW_CLASS,
            'hover:bg-accent/60 cursor-pointer',
            'focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none'
          )}
        >
          {body}
        </button>
      )}
    </li>
  );
}

function AttentionBody({ item }: { item: AttentionItem }) {
  const look = KIND_LOOK[item.kind];
  const Icon = look.icon;

  return (
    <>
      <Icon role="img" aria-label={look.label} className={cn('size-3.5 shrink-0 translate-y-px', look.ink)} />
      <span className="min-w-0">
        <b className="block truncate text-xs font-semibold" title={item.title}>
          {item.title}
        </b>
        <span className="text-muted-foreground block truncate text-[11px]">
          {item.explanation}
          {/* Whose cause this is — the label the server already gave the run, because a cross-run
              queue that never says which orchestration it means sends every click in blind. */}
          {item.runLabel !== null && <span className="opacity-70"> · {item.runLabel}</span>}
        </span>
      </span>
    </>
  );
}
