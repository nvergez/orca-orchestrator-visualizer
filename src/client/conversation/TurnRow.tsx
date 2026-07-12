import { Heart } from 'lucide-react';
import { Spotlight, useSpotlight } from '@/components/fx/spotlight';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { agentOfTurn, type CastMember, type Turn } from '../../shared/types.ts';
import { agentLook } from '../canvas/theme.ts';
import { ageOf } from '../relative-time.ts';
import { themeOfTurn } from './theme.ts';

/**
 * **One thing that was said**, and the shape of the whole panel: the orchestrator on the right,
 * its agents on the left.
 *
 * That layout is the argument. A message has a sender and a recipient, and the old feed rendered
 * both as a flat list of rows — so "who is talking to whom", the one thing a person actually wants
 * from a conversation, was the one thing you could not read. Put the two speakers on two sides and
 * it is legible without being read at all.
 *
 * **The caption under the bubble is not a footnote — it is the point.** Four of these turns are
 * not messages: the orchestrator's prompt is `tasks.spec` at `dispatch_contexts.dispatched_at`,
 * the final report is `tasks.result` at `tasks.completed_at`, and neither was ever written to the
 * `messages` table because Orca injects a dispatch straight into the worker's PTY (SPEC §4.2, trap
 * 2). A bubble that *looked* like a message the orchestrator sent, when no such message exists,
 * would be the most convincing lie this tool could tell. So every turn says which columns it was
 * reconstructed from, in small grey type, and the tool stays honest about its own derivations.
 */

export type TurnRowProps = {
  turn: Turn;
  /** The orchestrator's agents — what turns a handle into an `A2` and a colour (`canvas/theme.ts`). */
  cast: CastMember[];
  /** The instant every age in the panel is measured from — one clock, so a list ages in step. */
  now: number;
  /** Clicking a turn goes to the task it names. Absent, or a turn that names none ⇒ nowhere to go. */
  onSelectTask?: (taskId: string) => void;
};

export function TurnRow({ turn, cast, now, onSelectTask }: TurnRowProps) {
  if (turn.kind === 'heartbeats') return <Heartbeats turn={turn} />;

  const theme = themeOfTurn(turn.kind);
  const agent = agentLook(agentOfTurn(turn), cast);
  const out = turn.direction === 'out';

  return (
    <article
      data-testid="turn"
      data-kind={turn.kind}
      data-direction={turn.direction}
      data-task={turn.taskId ?? undefined}
      data-agent={agent?.monogram}
      className={cn('flex max-w-[92%] flex-col gap-1', out && 'items-end self-end')}
    >
      <header className="text-muted-foreground flex items-center gap-1.5 text-[10px]">
        {/* The raw kind, whatever it is — an Orca that invents a message type still names a real
            event, and it is rendered neutral rather than dropped (SPEC §5). */}
        <Badge
          data-testid="kind-chip"
          variant="outline"
          className={cn('rounded px-1.5 py-0 font-mono text-[9.5px] font-bold tracking-tight', theme.surface)}
        >
          {turn.kind}
        </Badge>

        <Who out={out} agent={agent?.monogram ?? null} handle={out ? turn.fromHandle : turn.toHandle} />
        <span className="font-mono opacity-70">→</span>
        <Who out={!out} agent={agent?.monogram ?? null} handle={out ? turn.toHandle : turn.fromHandle} />

        <Age at={turn.at} now={now} />
      </header>

      <Bubble turn={turn} border={theme.border} out={out} onSelectTask={onSelectTask} />

      {/* The derivation, said out loud. See the note at the top of this file. */}
      <span data-testid="turn-source" className="text-muted-foreground/70 font-mono text-[10px]">
        {turn.source}
      </span>
    </article>
  );
}

/**
 * One side of the arrow — `orchestrator`, or `A2`.
 *
 * The monogram, and never the handle. `term_f627dc6f-4a1b-…` is the agent's only identity in the
 * schema and it is unreadable, unrememberable and unactionable — which is exactly why the cast
 * gives it a name (`server/cast.ts`) and why that name is the same `A2` here, on the node's stripe,
 * and in the rail. The handle rides in the tooltip, in full, for the one time in a hundred you want
 * to paste it into a command.
 */
function Who({ out, agent, handle }: { out: boolean; agent: string | null; handle: string | null }) {
  return (
    <span title={handle ?? undefined} className="whitespace-nowrap">
      {out ? 'orchestrator' : (agent ?? 'agent')}
    </span>
  );
}

function Bubble({
  turn,
  border,
  out,
  onSelectTask,
}: {
  turn: Turn;
  /** The kind's accent, as a rim and nothing else (`canvas/theme.ts`). */
  border: string;
  out: boolean;
  onSelectTask?: (taskId: string) => void;
}) {
  const spotlight = useSpotlight();
  const taskId = turn.taskId;
  const linked = taskId !== null && onSelectTask !== undefined;

  const body = (
    <>
      <p className="whitespace-pre-wrap">
        {turn.body}
        {/* The bodies stay in the file (SPEC §6.3) and a 400px bubble was never going to hold 3 KB
            of agent prompt. The ellipsis is the whole of the promise: there is more, and the node
            inspector has all of it. */}
        {turn.truncated && <span className="text-muted-foreground/70" title="The full text is in the node inspector"> …</span>}
      </p>

      {turn.options !== undefined && turn.options.length > 0 && <Options turn={turn} />}
    </>
  );

  return (
    <div
      className={cn(
        'group relative rounded-xl border px-3 py-2 text-[12.5px] leading-relaxed',
        // The bubble wears the kind's own accent as its **rim** — so a red escalation and an orange
        // gate are findable in a hundred rows without any of them being read. The *fill* stays the
        // panel's: a thread of thirty coloured slabs is a thread nobody reads twice.
        border,
        // …and the fill says which side said it. The orchestrator's turns are sunk into the panel;
        // its agents' stand on it. It is the second, quieter half of the left/right layout, and it
        // is what keeps the two speakers apart when a long body wraps to the full width.
        out ? 'bg-muted/60' : 'bg-panel-solid',
        linked && 'hover:brightness-[0.98]'
      )}
      {...spotlight}
    >
      <Spotlight />

      {linked ? (
        <button type="button" onClick={() => onSelectTask(taskId)} title="Show this task on the canvas" className="block w-full cursor-pointer text-left">
          {body}
        </button>
      ) : (
        body
      )}
    </div>
  );
}

/**
 * A gate's options, and the one that was taken.
 *
 * The answer comes from the reply that threaded on the gate message's id (`server/gates.ts`) — the
 * only record anywhere in this schema that a question was ever settled. An option is marked as
 * *picked* only when the answer really names it; an orchestrator that replied in prose rather than
 * by picking gets its answer as its own turn, below, and nothing here is ticked. Guessing which
 * option a paragraph meant would be inventing the decision.
 */
function Options({ turn }: { turn: Turn }) {
  const picked = (option: string): boolean =>
    turn.answer !== undefined && turn.answer.trim().toLowerCase() === option.trim().toLowerCase();

  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {turn.options!.map((option) => (
        <li
          key={option}
          data-testid="gate-option"
          data-picked={picked(option)}
          className={cn(
            'text-muted-foreground border-border rounded-md border px-2 py-0.5 text-[11px]',
            picked(option) && 'bg-status-completed-soft text-status-completed-ink border-status-completed font-semibold'
          )}
        >
          {option}
          {picked(option) && ' ✓'}
        </li>
      ))}

      {/* An open gate is not a gate with no answer yet — it is the reason the orchestration has
          stopped. It says so where you are reading the question. */}
      {turn.answer === undefined && (
        <li
          data-testid="gate-open"
          className="bg-gate-soft text-gate-ink border-gate rounded-md border px-2 py-0.5 text-[11px] font-medium"
        >
          waiting for an answer
        </li>
      )}
    </ul>
  );
}

/**
 * **302 of 466 messages, in one line** (SPEC §7.7).
 *
 * A heartbeat says "alive", every five minutes, and its value is *liveness* rather than
 * event-ness — which already reached the screen as the agent's "last seen 12s ago" badge. Rendered
 * straight they turn a conversation into a ticker with the real exchange lost inside it. Collapsed,
 * they keep the fact and throw away the repetition: an agent was beating, this often, over this
 * long. Nothing is hidden and nothing is behind a toggle, because there is nothing more to show —
 * the two hundred rows this row replaces all said the same word.
 */
function Heartbeats({ turn }: { turn: Turn }) {
  return (
    <p
      data-testid="heartbeats"
      data-count={turn.beatCount}
      className="border-panel-border text-muted-foreground/80 flex items-center gap-2 self-center rounded-full border border-dashed px-3 py-1 text-[11px]"
    >
      <Heart aria-hidden className="size-3" />
      {turn.beatCount} {turn.beatCount === 1 ? 'heartbeat' : 'heartbeats'}
      {cadenceOf(turn) && <span className="opacity-70">· {cadenceOf(turn)}</span>}
    </p>
  );
}

/**
 * "every ~5 min" — measured, never asserted.
 *
 * Orca instructs its workers to beat every five minutes; what they *did* is two instants and a
 * count, and that is what this says. A cadence printed from the documentation rather than from the
 * rows would be the tool telling you what should have happened.
 */
function cadenceOf(turn: Turn): string | null {
  if (turn.beatCount === undefined || turn.beatCount < 2 || turn.endedAt === undefined) return null;

  const from = Date.parse(turn.at);
  const to = Date.parse(turn.endedAt);
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return null;

  const minutes = Math.round(to - from) / (turn.beatCount - 1) / 60_000;
  if (minutes < 1) return 'every ~1 min';
  return minutes < 90 ? `every ~${Math.round(minutes)} min` : `every ~${Math.round(minutes / 60)} h`;
}

/** How long ago, with the exact instant in the tooltip for when "3m" is not enough. */
function Age({ at, now }: { at: string; now: number }) {
  const age = ageOf(at, now);
  const className = 'text-muted-foreground/70 ml-1 shrink-0 tabular-nums';

  // A string that is not a timestamp is not marked up as one: `<time datetime="…">` would be
  // claiming a machine-readable instant that this very row is saying it does not have. (An empty
  // `at` is a turn whose column held nothing readable — `server/time.ts` passes it through rather
  // than inventing one, and this is where that honesty has to land.)
  if (!age.readable) {
    return (
      <span className={className} title={age.title}>
        {at === '' ? 'no timestamp' : age.label}
      </span>
    );
  }

  return (
    <time dateTime={at} title={age.title} className={className}>
      {age.label}
    </time>
  );
}
