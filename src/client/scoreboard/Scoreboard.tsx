import { ExternalLink, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { shortHandle } from '../../shared/handles.ts';
import type { CastMember, Run, Scorecard } from '../../shared/types.ts';
import { agentLook, MONOGRAM_CLASS } from '../canvas/theme.ts';
import { CHIP_CLASS } from '../chip.ts';
import { Duration } from '../duration.tsx';
import { BAND_IN, DOCK_IN, enter, SPRING } from '../motion.ts';
import { DOCK_CLASS, PANEL_HEADER_CLASS, PANEL_TITLE_CLASS } from '../surface.ts';
import { useIsMobile } from '../viewport.tsx';

/**
 * **The scoreboard: the cast, compared** (#68, SPEC §12.4). The dock's third panel — it swaps
 * in over the conversation the way the inspector does, and swaps back out the way it came.
 *
 * The server derived every number (`server/scoreboard.ts`); this panel's whole job is
 * presentation without editorial, and the three rules it renders under are the feature:
 *
 * - **A multi-agent cast is a grid; a one-agent cast is a rollup.** The same facts either way —
 *   a comparison with one column is an empty page pretending to be a table.
 * - **One metric sorts at a time**, and an unknown sorts *last* in either direction: a member
 *   whose failures cannot be counted must not be dressed up as the cleanest sheet on the board.
 *   There is no composite score, no winner, and no claim the agents got comparable work — the
 *   grid says so out loud rather than merely omitting it.
 * - **Unknown renders as unknown.** An absent span, heartbeat time or count is an em dash with
 *   its reason in the tooltip — never `0`, never `0s` (SPEC §12.4). The server already refused
 *   to invent the number; a dash that quietly became a zero here would undo the refusal.
 */

export type ScoreboardProps = {
  /** The selected orchestrator, whose cast is being compared. Null before anything is selected. */
  run: Run | null;
  onClose: () => void;
};

type MetricKey = 'span' | 'firstHeartbeat' | 'heartbeats' | 'messages' | 'failures' | 'escalations' | 'outcomes';

/**
 * The columns, in reading order: time first (cost), then traffic, then trouble, then what came
 * of it. `title` is each column's provenance — the same discipline every duration tooltip keeps.
 */
const METRICS: { key: MetricKey; label: string; title: string }[] = [
  { key: 'span', label: 'Elapsed', title: 'first dispatch → latest retained completion; "so far" while work is in flight' },
  { key: 'firstHeartbeat', label: 'First beat', title: 'first dispatch → earliest attributed heartbeat; unknown without one, never zero' },
  { key: 'heartbeats', label: 'Beats', title: 'retained heartbeat rows this agent sent' },
  { key: 'messages', label: 'Messages', title: 'attributed messages this agent sent, heartbeats excluded' },
  { key: 'failures', label: 'Failures', title: 'the maximum cumulative failure count per task, summed — retries never double-count' },
  { key: 'escalations', label: 'Escalations', title: 'attributed escalation messages this agent sent' },
  { key: 'outcomes', label: 'Outcomes', title: 'deduplicated recognized receipt links (#67)' },
];

type Sort = { key: MetricKey; descending: boolean };

export function Scoreboard({ run, onClose }: ScoreboardProps) {
  const isMobile = useIsMobile();
  const cast = run?.cast ?? [];

  return (
    <motion.aside
      data-testid="scoreboard"
      aria-label="Scoreboard"
      variants={isMobile ? BAND_IN : DOCK_IN}
      initial={enter('hidden')}
      animate="shown"
      transition={SPRING}
      className={DOCK_CLASS}
    >
      <header className={PANEL_HEADER_CLASS}>
        <div className="flex items-center gap-2">
          <h2 className={PANEL_TITLE_CLASS}>Scoreboard</h2>
          <span className="text-muted-foreground/70 text-[11px] tabular-nums">
            {cast.length} {cast.length === 1 ? 'agent' : 'agents'}
          </span>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Back to the conversation"
            className="text-muted-foreground hover:text-foreground ml-auto size-6 cursor-pointer pointer-coarse:size-10"
          >
            <X className="size-3.5" />
          </Button>
        </div>

        {/* The refusal, said out loud (SPEC §12.6): omitting a winner quietly would leave the
            reader free to crown one; a grid that *says* its columns do not add up will not. */}
        <p className="text-muted-foreground/70 text-[11px] text-balance">
          Cast members were dispatched different work — each metric stands alone, and none of them is a ranking.
        </p>
      </header>

      {cast.length === 0 ? (
        <p data-testid="scoreboard-empty" className="text-muted-foreground p-4 text-xs text-balance">
          No agents — no dispatch attempt in this run names an assignee, so there is nobody to compare.
        </p>
      ) : cast.length === 1 ? (
        <Rollup member={cast[0]!} cast={cast} />
      ) : (
        <Grid cast={cast} />
      )}
    </motion.aside>
  );
}

/**
 * The comparison grid. Wider than the dock on purpose — eight facts do not fit in 22rem, and
 * clipping a column would hide a metric the spec promises — so the *table* keeps its natural
 * width and scrolls inside the panel, both ways.
 */
function Grid({ cast }: { cast: CastMember[] }) {
  const [sort, setSort] = useState<Sort | null>(null);

  const sortBy = (key: MetricKey): void => {
    setSort((current) => (current?.key === key ? { key, descending: !current.descending } : { key, descending: true }));
  };

  const rows = sorted(cast, sort);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table data-testid="scoreboard-grid" className="w-max min-w-full border-separate border-spacing-0 text-[11px]">
        <thead>
          <tr>
            <th scope="col" className={cn(HEADER_CELL, 'text-left')}>
              Agent
            </th>
            {METRICS.map((metric) => (
              <th
                key={metric.key}
                scope="col"
                aria-sort={sort?.key === metric.key ? (sort.descending ? 'descending' : 'ascending') : undefined}
                className={HEADER_CELL}
              >
                <button
                  type="button"
                  aria-label={`Sort by ${metric.label.toLowerCase()}`}
                  title={metric.title}
                  onClick={() => sortBy(metric.key)}
                  className={cn(
                    'cursor-pointer whitespace-nowrap rounded-sm px-1 py-0.5 font-semibold transition-colors',
                    'hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none',
                    sort?.key === metric.key ? 'text-foreground' : 'text-muted-foreground'
                  )}
                >
                  {metric.label}
                  {sort?.key === metric.key && <span aria-hidden> {sort.descending ? '↓' : '↑'}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((member) => (
            <tr key={member.handle} data-testid="scoreboard-row" data-agent={member.monogram}>
              <td className={cn(BODY_CELL, 'text-left')}>
                <span className="flex items-center gap-1.5" title={member.handle}>
                  <span
                    className={cn(MONOGRAM_CLASS, 'size-4.5 text-[9px]')}
                    style={{ background: agentLook(member.handle, cast)?.colour ?? 'var(--muted-foreground)' }}
                  >
                    {member.monogram}
                  </span>
                  <code className="text-muted-foreground font-mono text-[10px]">{shortHandle(member.handle)}</code>
                </span>
              </td>
              {METRICS.map((metric) => (
                <td key={metric.key} className={BODY_CELL}>
                  <Fact score={member.score} metric={metric.key} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const HEADER_CELL = 'border-b border-panel-border/70 px-2 py-1.5 text-right align-bottom whitespace-nowrap';
const BODY_CELL = 'border-b border-panel-border/40 px-2 py-1.5 text-right align-top tabular-nums whitespace-nowrap';

/**
 * The same facts, one agent, no table (SPEC §12.4): a comparison grid with a single row is an
 * empty page wearing column headers, so the rollup reads top to bottom instead — and reuses the
 * grid's cell renderers, so the two presentations cannot disagree about a value.
 */
function Rollup({ member, cast }: { member: CastMember; cast: CastMember[] }) {
  return (
    <div data-testid="scoreboard-rollup" className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="group/copy flex items-center gap-2.5 pb-3" title={member.handle}>
        <span
          className={cn(MONOGRAM_CLASS, 'size-5 text-[9.5px]')}
          style={{ background: agentLook(member.handle, cast)?.colour ?? 'var(--muted-foreground)' }}
        >
          {member.monogram}
        </span>
        <span className="min-w-0 flex-1">
          <b className="block text-[12.5px] font-semibold">Agent {member.monogram.slice(1)}</b>
          <code className="text-muted-foreground block truncate font-mono text-[10px]">
            {shortHandle(member.handle)}
          </code>
        </span>
      </div>

      <dl className="flex flex-col">
        {METRICS.map((metric) => (
          <div
            key={metric.key}
            className="border-panel-border/40 flex items-baseline justify-between gap-3 border-b py-1.5 text-[11.5px]"
          >
            <dt className="text-muted-foreground" title={metric.title}>
              {metric.label}
            </dt>
            <dd className="m-0 text-right tabular-nums">
              <Fact score={member.score} metric={metric.key} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** One cell: the fact, or an honest dash. The test ids are per metric, shared by grid and rollup. */
function Fact({ score, metric }: { score: Scorecard | undefined; metric: MetricKey }) {
  switch (metric) {
    case 'span':
      return score?.span ? (
        <Duration observation={score.span} testId="score-span" />
      ) : (
        <Dash testId="score-span" why="unknown — the retained evidence supports no span" />
      );
    case 'firstHeartbeat':
      return score?.firstHeartbeat ? (
        <Duration observation={score.firstHeartbeat} testId="score-first-heartbeat" />
      ) : (
        <Dash testId="score-first-heartbeat" why="unknown — no retained heartbeat, and unknown is never zero" />
      );
    case 'outcomes':
      // The same claim discipline as the receipts they came from (`receipt.tsx`): a link is a
      // real `<a>` because the value passed URL validation server-side, and it hands the page
      // neither this window nor a referrer — a receipt is untrusted text.
      return score?.outcomeLinks ? (
        <span data-testid="score-outcomes" className="flex flex-col items-end gap-0.5">
          {score.outcomeLinks.map((link) => (
            <a
              key={link}
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              title={link}
              className={cn(CHIP_CLASS, 'max-w-44')}
            >
              <ExternalLink aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{linkLabel(link)}</span>
            </a>
          ))}
        </span>
      ) : (
        <Dash testId="score-outcomes" why="no recognized outcome links" />
      );
    default:
      return count(score?.[metric], metric);
  }
}

function count(value: number | undefined, metric: MetricKey) {
  return value === undefined ? (
    <Dash testId={`score-${testIdOf(metric)}`} why="unknown — this database cannot count it" />
  ) : (
    <span data-testid={`score-${testIdOf(metric)}`}>{value}</span>
  );
}

function Dash({ testId, why }: { testId: string; why: string }) {
  return (
    <span data-testid={testId} title={why} className="text-muted-foreground/60">
      —
    </span>
  );
}

/** `firstHeartbeat` → `first-heartbeat`: the test ids stay kebab like every other one here. */
function testIdOf(metric: MetricKey): string {
  return metric.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** A link, short enough for a cell: its host and last path segment, with the whole URL on hover. */
function linkLabel(link: string): string {
  try {
    const url = new URL(link);
    const tail = url.pathname.split('/').filter(Boolean).slice(-2).join('/');
    return tail === '' ? url.host : `${url.host}/…/${tail}`;
  } catch {
    return link;
  }
}

/**
 * One metric at a time, unknowns last in either direction. Ties keep dispatch order — the
 * grid's default — so an all-equal column is not an invitation for rows to shuffle.
 */
function sorted(cast: CastMember[], sort: Sort | null): CastMember[] {
  if (sort === null) return cast;

  // Open spans are aged against the reader's clock, exactly as their cells render them: the
  // order the reader sees must be the order of the numbers the reader sees.
  const now = Date.now();

  return cast
    .map((member, index) => ({ member, index, value: sortValue(member.score, sort.key, now) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return a.index - b.index;
      // Unknown is not a small number, and it is not a large one: it goes last, both ways.
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      const byValue = sort.descending ? b.value - a.value : a.value - b.value;
      return byValue !== 0 ? byValue : a.index - b.index;
    })
    .map(({ member }) => member);
}

function sortValue(score: Scorecard | undefined, key: MetricKey, now: number): number | null {
  if (score === undefined) return null;

  switch (key) {
    case 'span': {
      if (!score.span) return null;
      if (score.span.complete) return score.span.ms ?? null;
      const start = Date.parse(score.span.startAt);
      return Number.isNaN(start) ? null : Math.max(0, now - start);
    }
    case 'firstHeartbeat':
      return score.firstHeartbeat?.ms ?? null;
    case 'outcomes':
      // Absent links mean none were *recognized* — a real zero, unlike the counts below,
      // whose absence means the columns to count them are missing.
      return score.outcomeLinks?.length ?? 0;
    default:
      return score[key] ?? null;
  }
}
