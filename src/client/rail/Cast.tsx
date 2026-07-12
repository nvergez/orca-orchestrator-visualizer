import { motion } from 'motion/react';
import { Diamond } from 'lucide-react';
import { cn } from '@/lib/utils';
import { shortHandle } from '../../shared/handles.ts';
import type { CastMember, Run } from '../../shared/types.ts';
import { agentLook, MONOGRAM_CLASS, STALE_HEARTBEAT_MS } from '../canvas/theme.ts';
import { enter, SECTION_IN } from '../motion.ts';
import { relativeTime } from '../relative-time.ts';

/**
 * **The cast — and the tool's central gesture.**
 *
 * The database has always known exactly who orchestrated and who did the work, and neither has ever
 * appeared on screen. `tasks.created_by_terminal_handle` is the orchestrator; the `assignee_handle`s
 * of its dispatch contexts are its agents (`server/cast.ts`). That is the whole model, and the tool
 * simply never named it.
 *
 * So here they are, nested under the orchestrator the rail has open — nested, and not in a fourth
 * column, because the hierarchy is *real*: an orchestrator **contains** its agents, and a list
 * beside it would be a list of people with no stated relationship to anything.
 *
 * **Clicking an agent is the gesture the whole tool turns on.** It dims the canvas to that agent's
 * tasks and fills the conversation with that agent's half of the dialogue — one click, and the
 * question "what did A2 actually do here" is answered on both panels at once. Clicking it again
 * lets go, because the way out of a filter should be where the way in was.
 */

export type CastProps = {
  run: Run;
  selectedAgent: string | null;
  onSelectAgent: (handle: string | null) => void;
  /** The clock the "last seen" badges are measured against — one clock, so the list ages in step. */
  now: number;
};

export function Cast({ run, selectedAgent, onSelectAgent, now }: CastProps) {
  if (run.cast.length === 0) {
    return (
      <p data-testid="cast-empty" className="text-muted-foreground/70 px-4 pt-1 pb-3 pl-7 text-[11px] text-balance">
        {run.handle === null
          ? 'No orchestrator on record — these tasks carry no terminal handle, so nobody was ever dispatched to them.'
          : 'No agents — this orchestrator has not dispatched any of its tasks yet.'}
      </p>
    );
  }

  return (
    <motion.div
      data-testid="cast"
      variants={SECTION_IN}
      initial={enter('hidden')}
      animate="shown"
      className="pt-0.5 pb-2"
    >
      <h3 className="text-muted-foreground/60 px-4 py-1.5 pl-7 text-[10px] font-semibold tracking-widest uppercase">
        The cast
      </h3>

      {/* The orchestrator itself, at the head of its own cast. It is not a button: there is nothing
          to filter *to* — the whole canvas is already its work, and the conversation already its
          conversation. It is here because a cast with no lead is a list of subordinates. */}
      <div className="flex items-center gap-2.5 px-4 py-1.5 pl-7">
        <span
          className={cn(MONOGRAM_CLASS, 'size-5 text-[9.5px]')}
          style={{ background: 'var(--foreground)', color: 'var(--background)' }}
        >
          <Diamond aria-hidden className="size-2.5" />
        </span>
        <span className="min-w-0 flex-1">
          <b className="block text-[12.5px] font-semibold">The orchestrator</b>
          <code className="text-muted-foreground block truncate font-mono text-[10px]" title={run.handle ?? undefined}>
            {run.handle ?? '— no handle on record —'}
          </code>
        </span>
      </div>

      <ul>
        {run.cast.map((member) => (
          <li key={member.handle}>
            <Agent
              member={member}
              cast={run.cast}
              selected={member.handle === selectedAgent}
              // Clicking the selected agent lets it go — the way out is where the way in was.
              onSelect={() => onSelectAgent(member.handle === selectedAgent ? null : member.handle)}
              now={now}
            />
          </li>
        ))}
      </ul>
    </motion.div>
  );
}

function Agent({
  member,
  cast,
  selected,
  onSelect,
  now,
}: {
  member: CastMember;
  cast: CastMember[];
  selected: boolean;
  onSelect: () => void;
  now: number;
}) {
  const look = agentLook(member.handle, cast);

  return (
    <button
      type="button"
      data-testid="agent-row"
      data-agent={member.monogram}
      aria-pressed={selected}
      onClick={onSelect}
      title={member.handle}
      className={cn(
        'hover:bg-accent/60 relative flex w-full cursor-pointer items-center gap-2.5 py-1.5 pr-3 pl-7 text-left transition-colors',
        'focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none',
        selected && 'bg-selection-soft/70'
      )}
    >
      {selected && <span aria-hidden className="bg-selection absolute top-1 bottom-1 left-0 w-[3px] rounded-full" />}

      {/* The same colour and the same two characters this agent wears on every node it worked
          (`canvas/theme.ts`) — which is the entire reason the monogram is the server's and not each
          panel's: a cast numbered twice would be two castings. */}
      <span
        className={cn(MONOGRAM_CLASS, 'size-5 text-[9.5px]')}
        style={{ background: look?.colour ?? 'var(--muted-foreground)' }}
      >
        {member.monogram}
      </span>

      <span className="min-w-0 flex-1">
        <b className="block text-[12.5px] font-semibold">Agent {member.monogram.slice(1)}</b>
        <code className="text-muted-foreground block truncate font-mono text-[10px]">
          {shortHandle(member.handle)}
        </code>
      </span>

      <LastSeen at={member.lastHeartbeatAt} now={now} taskCount={member.taskCount} />
    </button>
  );
}

/**
 * "seen 12s ago" — an agent that is still beating, and the one thing the rail can say about an
 * orchestration that has not finished (SPEC §4.6).
 *
 * It replaces the task count only while the agent is *recently* alive. A heartbeat from three hours
 * ago is not liveness, it is history — and a badge reading "seen 3h ago" beside a finished run
 * would cry wolf about work that went perfectly well. Past the threshold the row goes back to
 * saying how much the agent did, which is what a post-mortem came for.
 */
function LastSeen({ at, now, taskCount }: { at: string | null; now: number; taskCount: number }) {
  const silentFor = at === null ? null : now - Date.parse(at);
  const beating = silentFor !== null && !Number.isNaN(silentFor) && silentFor < STALE_HEARTBEAT_MS;

  if (!beating) {
    return (
      <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
        {taskCount} {taskCount === 1 ? 'task' : 'tasks'}
      </span>
    );
  }

  return (
    <span
      data-testid="agent-last-seen"
      className="bg-status-dispatched-soft text-status-dispatched-ink shrink-0 rounded-full px-1.5 py-px text-[10px] tabular-nums"
    >
      seen {relativeTime(silentFor!)} ago
    </span>
  );
}
