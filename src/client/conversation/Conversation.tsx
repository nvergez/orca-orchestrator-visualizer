import { motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { shortHandle } from '../../shared/handles.ts';
import type { CastMember, Run, Turn } from '../../shared/types.ts';
import { agentLook, MONOGRAM_CLASS } from '../canvas/theme.ts';
import { DOCK_IN, EASE, enter, ROW_IN, SPRING, SPRING_FAST } from '../motion.ts';
import { useNow } from '../relative-time.ts';
import { DOCK_CLASS, PANEL_HEADER_CLASS, PANEL_TITLE_CLASS } from '../surface.ts';
import { exchangeCount, selectTurns } from './select.ts';
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
 * The only state that *is* this panel's is the **"All"** scope, and it is here because it answers a
 * question only this panel is asked: a message the server could not place lives in no
 * orchestrator's conversation (SPEC §4.4, rule 3), and it must still be reachable — an
 * unattributable message appears, attached to nobody, rather than being guessed into somebody's
 * thread.
 */

export type ConversationProps = {
  /** Every turn in the database. The panel picks a scope; it never re-derives one. */
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

type Scope = 'run' | 'all';

const NO_CAST: CastMember[] = [];

export function Conversation({ turns, run, selectedAgent, onClearAgent, onSelectTask }: ConversationProps) {
  const [scope, setScope] = useState<Scope>('run');

  const cast = run?.cast ?? NO_CAST;
  const agent = cast.find((member) => member.handle === selectedAgent) ?? null;

  const shown = useMemo(
    () =>
      selectTurns(turns, {
        runId: scope === 'all' ? null : (run?.id ?? null),
        // "All" is the whole log, and narrowing it by an agent of the run you happen to have open
        // would be two scopes fighting over one list.
        agentHandle: scope === 'all' ? null : selectedAgent,
      }),
    [turns, scope, run, selectedAgent]
  );

  // One clock for the whole thread, re-read when the stream pushes (`relative-time.ts`).
  const now = useNow(turns);

  return (
    <motion.aside
      data-testid="conversation"
      aria-label="Conversation"
      variants={DOCK_IN}
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
          <ScopeButton label="All" active={scope === 'all'} onClick={() => setScope('all')} />
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
        <ScrollArea className="min-h-0 flex-1">
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
          className="border-panel-border text-muted-foreground hover:text-foreground shrink-0 cursor-pointer rounded-md border px-2 py-0.5 text-[11px] transition-colors"
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
  if (scope === 'all') return 'No messages in this database yet.';
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
        'relative flex-1 cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
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
