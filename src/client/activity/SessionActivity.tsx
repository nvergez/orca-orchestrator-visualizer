import { Activity } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { StreamEvent, Task } from '../../shared/types.ts';
import { GATE_THEME, STATUS_THEME, themeOf } from '../canvas/theme.ts';
import { enter, SPRING } from '../motion.ts';
import { ageOf, useNow } from '../relative-time.ts';
import { PANEL_CLASS, PANEL_TITLE_CLASS } from '../surface.ts';
import { type ActivityEntry, type ActivityLog, MAX_ACTIVITY_ENTRIES, observeActivity } from './session.ts';

/**
 * The ticker (#58): what this browser session has watched happen, under the canvas it happened on.
 *
 * It renders **nothing until there is something** — the first snapshot is a baseline, not news
 * (`session.ts`), and a strip that said "no activity yet" on every fresh page would be furniture.
 * When it does appear it says exactly what it is: *session* activity, observed since this page
 * connected, cleared on reload — because a bounded in-memory diff log that looked like durable
 * replay would be the panel lying about the one thing the ticket forbids it to lie about.
 *
 * An entry that names a task that still exists is a way there (`onSelectTask`, the same seam a
 * gate or a dep chip uses); one that doesn't — a message about a task a reset deleted — still
 * renders, simply unlinked, the same tolerance every join in this tool owes a database with no
 * foreign keys (SPEC §4.2, trap 8).
 */

const NO_ENTRIES: readonly ActivityEntry[] = [];

/**
 * The log, folded up event by event. It lives in a ref — component state is exactly where the
 * ticket wants this held: in this tab's memory, nowhere else, gone on reload. The *entries* are
 * state so a fold that adds nothing re-renders nothing: `observeActivity` returns them by the
 * same reference, and React bails out on it.
 */
function useSessionActivity(event: StreamEvent | null): readonly ActivityEntry[] {
  const log = useRef<ActivityLog | null>(null);
  const [entries, setEntries] = useState(NO_ENTRIES);

  useEffect(() => {
    if (event === null) return;

    // Folding is idempotent, which is what makes this effect safe under StrictMode's double
    // run: the second fold finds every fingerprint current and every sequence already seen.
    log.current = observeActivity(log.current, event, new Date().toISOString());
    setEntries(log.current.entries);
  }, [event]);

  return entries;
}

export type SessionActivityProps = {
  /** The stream, as `<App>` holds it — the component folds it into its own session log. */
  event: StreamEvent | null;
  /** Every task in the database, so an entry can tell a live destination from a deleted one. */
  tasks: Task[];
  /**
   * Clicking an entry goes to the task it names — the same seam a gate click uses.
   *
   * **Omitted on the kiosk** (#62): there is no inspector to open it into, so every entry takes
   * the unlinked path a deleted task's entry already takes. The ticker still *ticks* — what a
   * wall display owes its reader is that the page is alive and the work is moving, and that is
   * a thing you watch, not a thing you click.
   */
  onSelectTask?: (taskId: string) => void;
};

export function SessionActivity({ event, tasks, onSelectTask }: SessionActivityProps) {
  const entries = useSessionActivity(event);
  const now = useNow(entries);

  if (entries.length === 0) return null;

  return (
    <motion.section
      role="log"
      aria-label="Session activity"
      data-testid="session-activity"
      initial={enter({ opacity: 0, y: 10 })}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className={cn(PANEL_CLASS, 'shrink-0 px-4 py-2', 'max-lg:px-3')}
    >
      <header className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className={cn(PANEL_TITLE_CLASS, 'flex items-center gap-1.5')}>
          <Activity aria-hidden className="size-3.5" />
          Session activity
        </span>
        <span className="text-muted-foreground/70 text-[11px]">
          observed since this page connected · cleared on reload
        </span>
        <span className="text-muted-foreground/70 ml-auto text-[11px] tabular-nums">
          {entries.length === MAX_ACTIVITY_ENTRIES ? `newest ${MAX_ACTIVITY_ENTRIES} kept` : entries.length}
        </span>
      </header>

      {/* Newest first: the ticker answers "what just happened", and the answer is at the top.
          The cap is a *reading* budget — the log itself is already bounded (`session.ts`). */}
      <ul className="mt-1.5 flex max-h-36 flex-col gap-0.5 overflow-y-auto max-lg:max-h-24">
        {entries
          .slice()
          .reverse()
          .map((entry) => {
            const taskId = entry.taskId;
            const onSelect =
              onSelectTask !== undefined && taskId !== null && tasks.some((task) => task.id === taskId)
                ? () => onSelectTask(taskId)
                : null;
            return <Entry key={entry.id} entry={entry} now={now} onSelect={onSelect} />;
          })}
      </ul>
    </motion.section>
  );
}

/**
 * What each kind looks like on the strip — one table, so "which dot" and "which label" cannot
 * be edited apart (the same reason `conversation/theme.ts` keeps `TURN_STYLES` whole).
 *
 * The dot is the canvas's palette, not a new one: a status entry wears its **destination**
 * status (the table's null — only the entry knows which), a dispatch the amber of work in
 * flight, and the message kinds the same colours their pulses flash — green done, red
 * escalation, gate orange. Synthesized kinds narrate themselves and carry no label chip.
 */
const KIND_STYLES: Record<ActivityEntry['kind'], { label: string | null; dot: string | null }> = {
  status: { label: null, dot: null },
  dispatch: { label: null, dot: STATUS_THEME.dispatched.dot },
  retry: { label: null, dot: STATUS_THEME.dispatched.dot },
  worker_done: { label: 'done', dot: STATUS_THEME.completed.dot },
  escalation: { label: 'escalation', dot: STATUS_THEME.failed.dot },
  decision_gate: { label: 'gate', dot: GATE_THEME.dot },
};

function Entry({
  entry,
  now,
  onSelect,
}: {
  entry: ActivityEntry;
  now: number;
  /** Null ⇒ the entry names no task that still exists, and the row is a fact, not a button. */
  onSelect: (() => void) | null;
}) {
  const age = ageOf(entry.at, now);
  const { label, dot } = KIND_STYLES[entry.kind];

  const row = (
    <>
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 translate-y-1 rounded-full', dot ?? themeOf(entry.status ?? '').dot)}
      />
      {label !== null && (
        <span className="border-panel-border bg-background/60 shrink-0 rounded-full border px-1.5 text-[10px] font-medium">
          {label}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate" title={entry.text}>
        {entry.text}
      </span>
      <span className="text-muted-foreground/70 shrink-0 text-[10px] tabular-nums" title={age.title}>
        {age.label}
      </span>
    </>
  );

  return (
    <li data-testid="activity-entry" className="text-[12px] leading-snug">
      {onSelect === null ? (
        <span className="flex items-start gap-2 px-1 py-0.5">{row}</span>
      ) : (
        <button
          type="button"
          onClick={onSelect}
          className="hover:bg-accent/50 focus-visible:ring-selection/50 flex w-full cursor-pointer items-start gap-2 rounded-md px-1 py-0.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          {row}
        </button>
      )}
    </li>
  );
}
