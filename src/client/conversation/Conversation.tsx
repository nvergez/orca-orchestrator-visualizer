import { ArrowDown } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { shortHandle } from '../../shared/handles.ts';
import type { CastMember, Run, Turn } from '../../shared/types.ts';
import { agentLook, MONOGRAM_CLASS } from '../canvas/theme.ts';
import { CHIP_CLASS } from '../chip.ts';
import { BAND_IN, DOCK_IN, EASE, enter, ROW_IN, SPRING, SPRING_FAST } from '../motion.ts';
import { useNow } from '../relative-time.ts';
import { DOCK_CLASS, PANEL_HEADER_CLASS, PANEL_TITLE_CLASS } from '../surface.ts';
import { useIsMobile } from '../viewport.tsx';
import { exchangeCount, selectTurns, unplacedTurns } from './select.ts';
import { TurnRow } from './TurnRow.tsx';

/**
 * **What the orchestrator and its agents actually said to each other.**
 *
 * This panel is what the tool is *for*. The old feed showed the `messages` table as a flat list —
 * and a flat list of messages is, precisely, half a dialogue: when the orchestrator dispatches an
 * agent it writes **no message at all** (Orca injects the prompt into the worker's PTY, and the
 * live database holds zero `dispatch` rows — SPEC §4.2, trap 2). So the panel showed agents talking
 * into the void, to an orchestrator that never answered a word, and nobody could read it.
 *
 * The server merges the four sources that make the dialogue whole (`server/conversation.ts`, SPEC
 * §4.7). What this panel adds is the shape that makes it legible without being read:
 *
 * - **The orchestrator on the right; its agents on the left.** A message has a sender and a
 *   recipient, and the one thing a reader wants from a conversation is *who is talking to whom* —
 *   which is the one thing a flat stream of rows cannot show.
 * - **A gate and its answer sit together**, because they are one exchange.
 * - **Heartbeats collapse to a line.** They are 65% of all traffic and they all say "alive".
 * - **Every turn says which columns it was reconstructed from**, because four of them are not
 *   messages and a bubble that pretended otherwise would be a lie.
 *
 * The scope is the tool's central gesture and it lives above, in `App`: the rail selects an
 * orchestrator, then an agent, and the same click that fills this panel dims the canvas to that
 * agent's tasks. The two panels are one movement.
 *
 * The only state that *is* this panel's is the second scope, and it is here because it answers a
 * question only this panel is asked: a message the server could not place lives in no
 * orchestrator's conversation (SPEC §4.4, rule 3), and it must still be reachable — an
 * unattributable message appears, attached to nobody, rather than being guessed into somebody's
 * thread.
 *
 * **That scope used to be called "All", and it is now called "Unattributed"** (#69). The name was
 * the whole of what changed, and it changed because the panel no longer holds the machine: since
 * ADR 0002 the client fetches *one selected run* whole and the rail pages the rest, so a button
 * marked "All" would have shown the reader one orchestration and called it every one — the exact
 * class of lie the `source` caption under every bubble exists to prevent. What that button was
 * *for* is untouched (SPEC §7.7: "'All' is not a convenience: a turn the server could not place
 * belongs to no orchestrator, and it must still appear, attached to nobody"), and that is what it
 * now says. Another orchestrator's conversation is a rail click away, where it always was.
 */

export type ConversationProps = {
  /**
   * The selected run's complete conversation, and beside it the turns nothing places
   * (`runId: null`) — exactly what the selected-run snapshot carries (#69). The panel picks a
   * scope; it never re-derives one.
   */
  turns: Turn[];
  /** The orchestrator the rail has open. Null only when the database holds no tasks at all. */
  run: Run | null;
  /** The agent it has selected, if any — the narrower scope, and the reason the canvas is dimmed. */
  selectedAgent: string | null;
  /** Letting the agent go: back to the whole orchestrator. */
  onClearAgent: () => void;
  /** Clicking a turn goes to the task it names — the other half of the canvas link (SPEC §7.6). */
  onSelectTask: (taskId: string) => void;
};

type Scope = 'run' | 'unplaced';

const NO_CAST: CastMember[] = [];

export function Conversation({ turns, run, selectedAgent, onClearAgent, onSelectTask }: ConversationProps) {
  const [scope, setScope] = useState<Scope>('run');
  const isMobile = useIsMobile();

  const cast = run?.cast ?? NO_CAST;
  const agent = cast.find((member) => member.handle === selectedAgent) ?? null;

  const shown = useMemo(
    () =>
      scope === 'unplaced'
        ? unplacedTurns(turns)
        : selectTurns(turns, {
            runId: run?.id ?? null,
            agentHandle: selectedAgent,
          }),
    [turns, scope, run, selectedAgent]
  );

  // One clock for the whole thread, re-read when the stream pushes (`relative-time.ts`).
  const now = useNow(turns);

  /**
   * "New exchanges landed below where you are reading" — the folded shell's answer to the
   * no-auto-scroll rule. The panel has never scrolled for the reader (a live stream that yanks
   * the thread out from under you is unreadable), and on desktop the scrollbar itself is the
   * tell that more arrived. On a phone there is no scrollbar to see, so the fact gets said in
   * the new-run chip's exact grammar: news you may tap, never a navigation performed for you.
   *
   * The signal is the id of the last shown turn: when it changes while the viewport sits more
   * than 48px above the bottom, something arrived off-screen. A reader parked *at* the bottom
   * never sees the chip — the new turn is already in view — and scrolling back down retires it.
   *
   * A re-scope is not an arrival. Flipping "Unattributed", picking an agent, hopping runs — each
   * re-derives `shown` from the same turns and moves the last id without a single exchange
   * having landed, so the scope's identity is watched beside the id: a move that changed the
   * scope retires the chip instead of raising it.
   */
  const [unseen, setUnseen] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const lastTurnId = shown.at(-1)?.id ?? null;
  const scopeKey = `${scope}·${run?.id ?? ''}·${selectedAgent ?? ''}`;
  const previousLastTurnId = useRef(lastTurnId);
  const previousScopeKey = useRef(scopeKey);

  useEffect(() => {
    const previous = previousLastTurnId.current;
    const sameScope = previousScopeKey.current === scopeKey;
    previousLastTurnId.current = lastTurnId;
    previousScopeKey.current = scopeKey;

    if (sameScope && lastTurnId === previous) return;

    const viewport = viewportRef.current;
    if (!viewport) return;
    // One write, decided by the viewport: a new last turn in an unchanged scope while parked
    // >48px up is unseen news; anything else — a scope flip between two lists, the thread
    // emptying under the chip — means nothing arrived, and a stale chip must not flash.
    setUnseen(
      sameScope &&
        lastTurnId !== null &&
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 48
    );
  }, [lastTurnId, scopeKey]);

  const onViewportScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget;
    if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 48) setUnseen(false);
  };

  return (
    <motion.aside
      data-testid="conversation"
      aria-label="Conversation"
      variants={isMobile ? BAND_IN : DOCK_IN}
      initial={enter('hidden')}
      animate="shown"
      transition={SPRING}
      className={DOCK_CLASS}
    >
      <header className={PANEL_HEADER_CLASS}>
        <div className="flex items-center gap-2">
          <h2 className={PANEL_TITLE_CLASS}>Conversation</h2>
          <span className="text-muted-foreground/70 ml-auto text-[11px] tabular-nums">
            {exchangeCount(shown)} {exchangeCount(shown) === 1 ? 'exchange' : 'exchanges'}
          </span>
        </div>

        {/* A segmented control, not two buttons in a row: the scope is one choice with two sides —
            so the *thumb* is one element that slides between them, and not two that light up. */}
        <div role="group" aria-label="Conversation scope" className="bg-muted/70 flex gap-0.5 rounded-lg p-0.5">
          <ScopeButton label="This orchestrator" active={scope === 'run'} onClick={() => setScope('run')} />
          <ScopeButton label="Unattributed" active={scope === 'unplaced'} onClick={() => setScope('unplaced')} />
        </div>

        {scope === 'run' && (
          <Who run={run} cast={cast} agent={agent} onClearAgent={onClearAgent} shown={shown} />
        )}
      </header>

      {shown.length === 0 ? (
        <p data-testid="conversation-empty" className="text-muted-foreground p-4 text-xs text-balance">
          {emptyWording(run, agent, scope)}
        </p>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef} onViewportScroll={onViewportScroll}>
            <ol data-testid="turns" className="flex flex-col gap-3 p-3.5">
              {/*
                Oldest first, unlike the old feed. A conversation is a *story* — it starts at the
                beginning, and reading it backwards is how you lose the thread of who answered what.
                (The feed read newest-first because it answered "what just happened"; that question is
                now the canvas's, and a node flashes when it does.)
              */}
              {withDays(shown).map((entry) =>
                entry.day !== undefined ? (
                  <li key={`day-${entry.day}`} data-testid="day" className="flex items-center gap-2.5 py-1">
                    <span className="bg-panel-border h-px flex-1" />
                    <span className="text-muted-foreground/70 text-[10.5px]">{entry.day}</span>
                    <span className="bg-panel-border h-px flex-1" />
                  </li>
                ) : (
                  <motion.li
                    key={entry.turn.id}
                    layout="position"
                    variants={ROW_IN}
                    initial={enter('hidden')}
                    animate="shown"
                    transition={SPRING_FAST}
                    className="flex flex-col"
                  >
                    <TurnRow turn={entry.turn} cast={cast} now={now} onSelectTask={onSelectTask} />
                  </motion.li>
                )
              )}
            </ol>
          </ScrollArea>

          {/* The glide is asked about, not assumed: an explicit `behavior: 'smooth'` ignores the
              CSS `scroll-behavior` property entirely (CSSOM consults it only when the call says
              `auto`), so the reduced-motion rule in `index.css` cannot flatten this one — the
              reader who asked for stillness gets the landing without the ride, said here. */}
          {isMobile && unseen && (
            <button
              type="button"
              data-testid="new-turns-chip"
              onClick={() => {
                const viewport = viewportRef.current;
                if (!viewport) return;
                const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
                viewport.scrollTo({ top: viewport.scrollHeight, behavior: still ? 'auto' : 'smooth' });
              }}
              className={cn(CHIP_CLASS, 'absolute bottom-2 left-1/2 z-10 -translate-x-1/2 cursor-pointer py-1 shadow-lift-2')}
            >
              <ArrowDown className="size-3" />
              new exchanges below
            </button>
          )}
        </div>
      )}
    </motion.aside>
  );
}

/**
 * Who is talking — the orchestrator, or the orchestrator and one of its agents.
 *
 * It is the header of a thread, so it names the two people in it. When an agent is selected the
 * panel is *their* half of the conversation, and the way out of that is here, beside the name, and
 * not somewhere else on the page.
 */
function Who({
  run,
  cast,
  agent,
  onClearAgent,
  shown,
}: {
  run: Run | null;
  cast: CastMember[];
  agent: CastMember | null;
  onClearAgent: () => void;
  shown: Turn[];
}) {
  const look = agentLook(agent?.handle ?? null, cast);

  return (
    <div className="flex items-center gap-2.5">
      <span
        className={cn(MONOGRAM_CLASS, 'size-6 text-[10px]')}
        style={look ? { background: look.colour } : { background: 'var(--foreground)', color: 'var(--background)' }}
      >
        {look?.monogram ?? '◇'}
      </span>

      <span className="min-w-0 flex-1">
        <b className="block truncate text-[13px] font-semibold tracking-tight">
          {agent ? `Orchestrator ↔ ${agent.monogram}` : 'Every exchange'}
        </b>
        <small
          className="text-muted-foreground block truncate text-[11px]"
          title={agent?.handle ?? run?.handle ?? undefined}
        >
          {agent ? (
            <code className="font-mono">{shortHandle(agent.handle)}</code>
          ) : (
            <>
              {cast.length} {cast.length === 1 ? 'agent' : 'agents'} · {exchangeCount(shown)} exchanges
            </>
          )}
        </small>
      </span>

      {agent && (
        <button
          type="button"
          onClick={onClearAgent}
          className="border-panel-border text-muted-foreground hover:text-foreground shrink-0 cursor-pointer rounded-md border px-2 py-0.5 text-[11px] transition-colors max-lg:px-3 max-lg:py-1.5"
        >
          show all
        </button>
      )}
    </div>
  );
}

/**
 * Nothing to show — and *why* is the whole of what this sentence is for.
 *
 * There are three completely different reasons a conversation can be empty, and a single "no
 * messages" would flatten all three into what looks like a bug. The synthetic **Unattributed** run
 * is the sharpest: those tasks have no `created_by_terminal_handle`, so there is no orchestrator on
 * record — nobody ever said anything to anybody, and the panel should say exactly that rather than
 * looking like it failed to load.
 */
function emptyWording(run: Run | null, agent: CastMember | null, scope: Scope): string {
  if (scope === 'unplaced') {
    return 'Nothing here is unattributable: every exchange this database retains belongs to an orchestrator.';
  }
  if (agent) return `${agent.monogram} and the orchestrator never exchanged anything about these tasks.`;
  if (run && run.handle === null) {
    return 'No exchanges. These tasks were never attributed to a terminal — so there is no orchestrator on record, and nobody said anything to anybody.';
  }
  return 'No exchanges in this orchestration yet.';
}

/** A turn, or the day it was said on. The panel renders both out of one list. */
type Entry = { turn: Turn; day?: undefined } | { day: string; turn?: undefined };

/**
 * Day separators — the cheapest orientation there is, and this database is never pruned.
 *
 * Thirteen orchestrations across four days sit in it right now, and one of them ran from 20:10 to
 * 07:04 the next morning. Without a separator, "20:52" and "06:31" are two clock times with no
 * relation; with one, they are an overnight run, which is a thing that *happened* rather than a
 * list that got long.
 */
function withDays(turns: Turn[]): Entry[] {
  const entries: Entry[] = [];
  let current: string | null = null;

  for (const turn of turns) {
    const day = dayOf(turn.at);

    // A turn whose column held no readable instant gets no separator rather than a header saying
    // "Invalid Date" — the timestamp is passed through verbatim from the server (SPEC §5) and this
    // is where that honesty has to land.
    if (day !== null && day !== current) {
      current = day;
      entries.push({ day });
    }

    entries.push({ turn });
  }

  return entries;
}

function dayOf(at: string): string | null {
  const instant = new Date(at);
  if (Number.isNaN(instant.getTime())) return null;

  return instant.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function ScopeButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'relative flex-1 cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium transition-colors max-lg:py-2',
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {active && (
        <motion.span
          aria-hidden
          layoutId="conversation-scope"
          transition={EASE}
          className="bg-panel-solid shadow-lift-1 absolute inset-0 rounded-md"
        />
      )}
      <span className="relative">{label}</span>
    </button>
  );
}
