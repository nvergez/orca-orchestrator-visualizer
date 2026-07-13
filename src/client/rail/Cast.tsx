import { motion } from 'motion/react';
import { Diamond, Folder } from 'lucide-react';
import { cn } from '@/lib/utils';
import { shortHandle } from '../../shared/handles.ts';
import type { CastMember, EnrichedWorker, Enrichment, Run } from '../../shared/types.ts';
// No STALE_HEARTBEAT_MS here any more: staleness is decided once by the worker-health model
// (#47) and arrives already decided as `WorkerHealth`. The cast reads it; it no longer does
// clock arithmetic of its own, which is why this component no longer takes a `now`.
import { agentLook, MONOGRAM_CLASS } from '../canvas/theme.ts';
import { COPY_ON_HOVER, CopyButton } from '../copy.tsx';
import { enter, SECTION_IN } from '../motion.ts';
import { relativeTime } from '../relative-time.ts';
import type { WorkerHealth } from '../worker-health.ts';
import { provenanceOf } from './provenance.ts';

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
  healthByAgent: ReadonlyMap<string, WorkerHealth>;
  selectedAgent: string | null;
  onSelectAgent: (handle: string | null) => void;
  /**
   * Live Orca context (#61) — where each of these terminals works, and what its agent is
   * doing right now, joined by the server on exact handles only. Absent unless the user
   * opted in; empty-handed in every state but `ok`. The cast is the one surface that wears
   * it, because "what is A2 literally doing" is a question about a *member of the cast*.
   */
  enrichment?: Enrichment;
};

export function Cast({ run, healthByAgent, selectedAgent, onSelectAgent, enrichment }: CastProps) {
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

      {/*
        The one honest sentence a failed adapter gets (#61): the CLI timed out, exited, or
        answered something this build cannot read. Everything around it is SQLite's and is
        untouched — which is exactly why this is a caption and not a banner. Every other
        non-`ok` state renders nothing at all: off, pending and suspended are all "there is
        no live context", and a post-mortem screen must look as it did before #61 existed.
      */}
      {enrichment?.state === 'unavailable' && (
        <p data-testid="enrichment-unavailable" className="text-muted-foreground/70 px-4 pb-1 pl-7 text-[10px]">
          Live Orca context is unavailable — showing the database alone.
        </p>
      )}

      {/* The orchestrator itself, at the head of its own cast. It is not a button: there is nothing
          to filter *to* — the whole canvas is already its work, and the conversation already its
          conversation. It is here because a cast with no lead is a list of subordinates. */}
      <div className="group/copy flex items-center gap-2.5 px-4 py-1.5 pl-7">
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
          <OrcaContext worker={workerOf(enrichment, run.handle)} owner="orchestrator" />
        </span>

        {/* The handle is the orchestrator's only identity in the schema, it is a uuid, and the row
            is 18rem wide — so it is shown truncated and copied whole (`copy.tsx`). Nothing to copy
            on the synthetic run: it has no handle, which is the entire reason it exists. */}
        {run.handle !== null && (
          <CopyButton value={run.handle} label="orchestrator handle" className={COPY_ON_HOVER} />
        )}
      </div>

      <ul>
        {run.cast.map((member) => (
          // The copy button is a **sibling** of the row, not a child of it: the row is a button, and
          // a button inside a button is not a thing HTML has. It rides on top of the space the row
          // keeps clear for it (`pr-9`), so nothing shifts when it appears.
          <li key={member.handle} className="group/copy relative">
            <Agent
              member={member}
              cast={run.cast}
              selected={member.handle === selectedAgent}
              // Clicking the selected agent lets it go — the way out is where the way in was.
              onSelect={() => onSelectAgent(member.handle === selectedAgent ? null : member.handle)}
              health={healthByAgent.get(member.handle) ?? { state: 'inactive' }}
              worker={workerOf(enrichment, member.handle)}
            />

            <CopyButton
              value={member.handle}
              label="agent handle"
              className={cn('absolute top-1/2 right-1.5 -translate-y-1/2', COPY_ON_HOVER)}
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
  health,
  worker,
}: {
  member: CastMember;
  cast: CastMember[];
  selected: boolean;
  onSelect: () => void;
  health: WorkerHealth;
  /** This agent's live Orca context, when the server joined one to it exactly (#61). */
  worker: EnrichedWorker | null;
}) {
  const look = agentLook(member.handle, cast);

  return (
    <button
      type="button"
      data-testid="agent-row"
      data-agent={member.monogram}
      data-health={health.state}
      aria-pressed={selected}
      onClick={onSelect}
      title={member.handle}
      className={cn(
        // `pr-9` is the room the copy button rides in (`Cast`, above) — kept clear at all times, so
        // the last-seen badge does not jump sideways the moment the pointer arrives.
        'hover:bg-accent/60 relative flex w-full cursor-pointer items-center gap-2.5 py-1.5 pr-9 pl-7 text-left transition-colors',
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
        <b className="block truncate text-[12.5px] font-semibold">
          Agent {member.monogram.slice(1)}
          {/* The kind hint (SPEC §14.4) — worn with its question mark, because the uncertainty is
              the point: the schema has no agent-kind column, and this is one surviving reading of
              retained evidence, not an identity. The provenance sits on the line below, beside the
              handle, so the inference and its source are read together. */}
          {member.kindHint && (
            <span data-testid="agent-kind-hint" className="text-muted-foreground font-normal">
              {' '}
              · {member.kindHint.value}?
            </span>
          )}
        </b>
        <code className="text-muted-foreground block truncate font-mono text-[10px]">
          {shortHandle(member.handle)}
          {member.kindHint && (
            // The 18rem rail can truncate the visible copy after the handle; the title keeps the
            // full sentence one hover away. (The row's own title stays the handle — this span is
            // above it in the tree, so the more specific wording wins under the pointer.)
            <span
              data-testid="agent-kind-provenance"
              title={`Kind hint — uncertain, read ${provenanceOf(member.kindHint)}. Not an identity.`}
              className="opacity-75"
            >
              {' '}
              · {provenanceOf(member.kindHint)}
            </span>
          )}
        </code>
        <OrcaContext worker={worker} owner="agent" />
      </span>

      <LastSeen health={health} taskCount={member.taskCount} />
    </button>
  );
}

/** Nothing unless the adapter's last good answer placed this handle. Null renders null. */
function workerOf(enrichment: Enrichment | undefined, handle: string | null): EnrichedWorker | null {
  if (enrichment?.state !== 'ok' || handle === null) return null;
  return enrichment.workers.find((worker) => worker.handle === handle) ?? null;
}

/**
 * The live context itself (#61): the worktree this terminal works in, and — only when the
 * server could say so without guessing — what its agent is doing this second. Two quiet
 * lines under the handle; the full path and the full tool input ride in the `title`, the
 * way the handle itself does. It never animates: it is a caption, not an event (SPEC §7.9).
 */
function OrcaContext({ worker, owner }: { worker: EnrichedWorker | null; owner: 'orchestrator' | 'agent' }) {
  if (worker === null) return null;

  const { worktree, activity } = worker;

  return (
    <>
      <span
        data-testid={`${owner}-worktree`}
        className="text-muted-foreground/80 flex min-w-0 items-center gap-1 text-[10px]"
        title={worktree.path}
      >
        <Folder aria-hidden className="size-2.5 shrink-0 opacity-70" />
        <span className="truncate">
          {worktree.displayName ?? worktree.path}
          {worktree.branch !== null && <span className="opacity-70"> · {worktree.branch}</span>}
        </span>
      </span>

      {activity !== undefined && (
        <span
          data-testid={`${owner}-activity`}
          className="text-muted-foreground block truncate text-[10px]"
          // The row shows a glimpse; the hover has the rest — which agent binary, the whole
          // tool input, and how current the reading is. Same convention as the handle above.
          title={
            [
              activity.agentType,
              [activity.toolName, activity.toolInput].filter(Boolean).join(' — ') || activity.lastAssistantMessage,
              activity.updatedAt === null ? null : `as of ${new Date(activity.updatedAt).toLocaleTimeString()}`,
            ]
              .filter(Boolean)
              .join(' · ') || undefined
          }
        >
          {/* The pane's own word for its state, verbatim — `working`, `done`, or whatever a
              newer Orca says (SPEC §5) — then the most current thing known about it. */}
          <span className="font-medium">{activity.state}</span>
          {activity.toolName !== null ? (
            <>
              {' · '}
              {activity.toolName}
              {activity.toolInput !== null && <span className="font-mono opacity-80"> — {activity.toolInput}</span>}
            </>
          ) : (
            activity.lastAssistantMessage !== null && <> · {activity.lastAssistantMessage}</>
          )}
        </span>
      )}
    </>
  );
}

/**
 * "seen 12s ago" — an agent that is still beating, and the one thing the rail can say about an
 * orchestration that has not finished (SPEC §4.6).
 *
 * It replaces the task count only while the agent has a currently dispatched attempt. Settled work
 * always returns to its historical task count; a stale current attempt stays visible and amber.
 * Before the first heartbeat, the dispatch time is named explicitly instead of being mistaken for
 * a check-in.
 */
function LastSeen({ health, taskCount }: { health: WorkerHealth; taskCount: number }) {
  if (health.state === 'inactive' || health.state === 'unknown') {
    return (
      <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
        {taskCount} {taskCount === 1 ? 'task' : 'tasks'}
      </span>
    );
  }

  const stale = health.state === 'stale';
  const label =
    health.heartbeat === 'received'
      ? `seen ${relativeTime(health.elapsedMs)} ago`
      : `dispatched ${relativeTime(health.elapsedMs)} ago · no heartbeat`;

  return (
    <span
      data-testid="agent-last-seen"
      className={cn(
        'shrink-0 rounded-full px-1.5 py-px text-[10px] tabular-nums',
        stale
          ? 'bg-amber-100 font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-300'
          : 'bg-status-dispatched-soft text-status-dispatched-ink'
      )}
    >
      {label}
    </span>
  );
}
