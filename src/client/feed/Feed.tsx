import { motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { FeedMessage } from '../../shared/types.ts';
import { DOCK_IN, EASE, enter, ROW_IN, SPRING, SPRING_FAST } from '../motion.ts';
import { DOCK_CLASS, PANEL_HEADER_CLASS, PANEL_TITLE_CLASS } from '../surface.ts';
import { HeartbeatToggle } from './HeartbeatToggle.tsx';
import { MessageRow } from './MessageRow.tsx';
import { viewOf } from './select.ts';

/**
 * The right dock's **default** panel: what the agents are actually saying to each other, so that
 * an orchestration reads as a conversation and not only as a graph (#12, story 29).
 *
 * The node inspector swaps in over it on selection and swaps back out when the selection is let
 * go (#20, SPEC §7.1) — **one** panel that swaps, not both stacked, because at this node count
 * the canvas deserves the width. So the feed is the panel for *no selection*, and the two
 * controls it has left are both about which run you are reading:
 *
 * - **"Show heartbeats", off.** 65% of all traffic is heartbeats. This is the toggle that
 *   turns a heartbeat ticker back into a feed (SPEC §7.7).
 * - **Scope: this run / All.** You read one orchestration at a time — but `messages.sequence`
 *   is the only true total order the schema has, and a message the server could not attribute
 *   lives in "All" and nowhere else, so "All" is one click away and never the default.
 *
 * Both are *this panel's* state and are held here. The selection is not: a task the canvas has
 * outlined and the inspector is describing belongs to the shell (`App.tsx`), which is the only
 * thing that can see both.
 *
 * A row is a `MessageRow` — the same component the inspector renders its messages with. Here a
 * subject is a **button** into the task it names (the feed's half of the bidirectional link,
 * SPEC §7.6); there, you are already standing on that task.
 *
 * **A new message lands at the top and pushes the rest down** (SPEC §7.9) — `layout`, so the push
 * is the browser's and not a repaint. It is the one place in the tool where you can watch the
 * orchestration *happen*, and a list that simply blinked one row longer would waste it. Rows that
 * *leave* — the heartbeat toggle, a change of scope — leave instantly: they are a filter, not an
 * event, and animating a filter is animating the user's own click back at them.
 */

export type FeedProps = {
  /** Everything the client has accumulated, oldest first (`feed.ts`). */
  messages: FeedMessage[];
  /** The selected run — the default scope. */
  runId: string | null;
  /** Clicking a row: highlight and centre the task it refers to (SPEC §7.6). */
  onSelectMessage: (message: FeedMessage) => void;
};

type FeedScope = 'run' | 'all';

export function Feed({ messages, runId, onSelectMessage }: FeedProps) {
  const [scope, setScope] = useState<FeedScope>('run');
  const [showHeartbeats, setShowHeartbeats] = useState(false);

  const { shown, hidden, now } = useMemo(
    () => viewOf(messages, { runId: scope === 'all' ? null : runId, showHeartbeats }),
    [messages, runId, scope, showHeartbeats]
  );

  return (
    <motion.aside
      data-testid="feed"
      aria-label="Message feed"
      variants={DOCK_IN}
      initial={enter('hidden')}
      animate="shown"
      transition={SPRING}
      className={DOCK_CLASS}
    >
      <header className={PANEL_HEADER_CLASS}>
        <div className="flex items-center gap-2">
          <h2 className={PANEL_TITLE_CLASS}>Feed</h2>
          <span className="text-muted-foreground/70 ml-auto text-[11px] tabular-nums">
            {shown.length} {shown.length === 1 ? 'message' : 'messages'}
          </span>
        </div>

        {/* A segmented control, not two buttons in a row: the scope is one choice with two sides —
            so the *thumb* is one element that slides between them, and not two that light up. */}
        <div role="group" aria-label="Feed scope" className="bg-muted/70 flex gap-0.5 rounded-lg p-0.5">
          <ScopeButton label="This run" active={scope === 'run'} onClick={() => setScope('run')} />
          <ScopeButton label="All" active={scope === 'all'} onClick={() => setScope('all')} />
        </div>

        <HeartbeatToggle showHeartbeats={showHeartbeats} onChange={setShowHeartbeats} hidden={hidden} />
      </header>

      {shown.length === 0 ? (
        <p className="text-muted-foreground p-4 text-xs">
          {hidden > 0 ? 'Nothing here but heartbeats — turn on “Show heartbeats” to see them.' : emptyWording(scope)}
        </p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ol data-testid="feed-rows">
            {/*
              Newest first. The feed answers "what just happened" — and a live one that appended
              below the fold would have to be chased down the page, or autoscrolled away from
              under the user's own scrolling. (The inspector reads the other way round: one task's
              messages are a story, and a story starts at the beginning.)
            */}
            {[...shown].reverse().map((message) => (
              <motion.li
                key={message.sequence}
                layout="position"
                variants={ROW_IN}
                initial={enter('hidden')}
                animate="shown"
                transition={SPRING_FAST}
              >
                <MessageRow message={message} now={now} onSelect={onSelectMessage} />
              </motion.li>
            ))}
          </ol>
        </ScrollArea>
      )}
    </motion.aside>
  );
}

function emptyWording(scope: FeedScope): string {
  return scope === 'all' ? 'No messages in this database yet.' : 'No messages in this run yet.';
}

function ScopeButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'relative flex-1 cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {active && (
        <motion.span
          aria-hidden
          layoutId="feed-scope"
          transition={EASE}
          className="bg-panel-solid shadow-lift-1 absolute inset-0 rounded-md"
        />
      )}
      <span className="relative">{label}</span>
    </button>
  );
}
