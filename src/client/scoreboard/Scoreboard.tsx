import { X } from 'lucide-react';
import { motion } from 'motion/react';
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { shortHandle } from '../../shared/handles.ts';
import type { CastMember, Run, Scorecard } from '../../shared/types.ts';
import { agentLook, MONOGRAM_CLASS } from '../canvas/theme.ts';
import { Duration } from '../duration.tsx';
import { BAND_IN, DOCK_IN, enter, SPRING } from '../motion.ts';
import { ReceiptLink } from '../receipt.tsx';
import { DOCK_CLASS, PANEL_HEADER_CLASS, PANEL_TITLE_CLASS } from '../surface.ts';
import { useIsMobile } from '../viewport.tsx';

/**
 * **The scoreboard: the cast, compared** (#68, SPEC §14.4). The dock's third panel — it swaps
 * in over the conversation the way the inspector does, and swaps back out the way it came.
 *
 * The server derived every number (`server/scoreboard.ts`); this panel's whole job is
 * presentation without editorial, and the three rules it renders under are the feature:
 *
 * - **A multi-agent cast is a grid; a one-agent cast is a rollup.** The same facts either way —
 *   a comparison with one row is an empty table pretending to be a comparison.
 * - **One metric sorts at a time**, and an unknown sorts *last* in either direction: a member
 *   whose failures cannot be counted must not be dressed up as the cleanest sheet on the board.
 *   There is no composite score, no winner, and no claim the agents got comparable work — the
 *   panel says so out loud rather than merely omitting it.
 * - **Unknown and none are different, and they read differently.** An absent count, span or
 *   heartbeat time is *unknown* — an em dash whose tooltip says the database could not answer —
 *   and it never renders or sorts as zero (SPEC §14.4). A metric that was read and found nothing
 *   says "none", and sorts as the zero it honestly is. The server already refused to invent the
 *   number; collapsing the two here would undo the refusal at the last possible moment.
 *
 * **`METRICS` is the one table.** How a metric is worded, how its cell renders and how it sorts
 * are three questions about one column, and answering them in three places is how a new metric
 * ends up sorting by a value its cell never shows.
 */

export type ScoreboardProps = {
  /** The selected orchestrator, whose cast is being compared. Null before anything is selected. */
  run: Run | null;
  onClose: () => void;
};

/**
 * A cell's value for sorting: a number, or `null` for **unknown** — which is not a small number
 * and not a large one, and goes last whichever way the column is pointing.
 */
type SortValue = number | null;

type Metric = {
  key: string;
  /** What the grid's header says — short, because seven of them share a narrow dock. */
  label: string;
  /**
   * The metric's real name: the sort button's accessible name, and the rollup's label. A column
   * headed `Msgs` is still "messages" to a screen reader and to anyone with the room to read it,
   * and an abbreviation is a rendering decision, never a rename.
   */
  full: string;
  /** The column's provenance — the same discipline every duration tooltip keeps. */
  title: string;
  cell: (score: Scorecard | undefined) => ReactNode;
  sort: (score: Scorecard | undefined, now: number) => SortValue;
};

/** The columns, in reading order: time (what it cost), then traffic, then trouble, then what came of it. */
const METRICS: Metric[] = [
  {
    key: 'span',
    label: 'Elapsed',
    full: 'Elapsed',
    title: 'first dispatch → latest retained completion; “so far” while work is in flight',
    cell: (score) =>
      score?.span ? (
        <Duration observation={score.span} testId="score-span" />
      ) : (
        <Unknown testId="score-span" why="unknown — the retained evidence supports no span" />
      ),
    sort: (score, now) => {
      if (!score?.span) return null;
      if (score.span.complete) return score.span.ms ?? null;
      // An open span is aged against the reader's clock exactly as its cell renders it: the
      // order on screen must be the order of the numbers on screen.
      const start = Date.parse(score.span.startAt);
      return Number.isNaN(start) ? null : Math.max(0, now - start);
    },
  },
  {
    key: 'firstHeartbeat',
    label: 'First beat',
    full: 'First beat',
    title: 'first dispatch → earliest attributed heartbeat; unknown without one, never zero',
    cell: (score) =>
      score?.firstHeartbeat ? (
        <Duration observation={score.firstHeartbeat} testId="score-first-heartbeat" />
      ) : (
        <Unknown testId="score-first-heartbeat" why="unknown — no retained heartbeat, and unknown is never zero" />
      ),
    sort: (score) => score?.firstHeartbeat?.ms ?? null,
  },
  {
    key: 'heartbeats',
    label: 'Beats',
    full: 'Beats',
    title: 'retained heartbeat rows this agent sent',
    cell: (score) => <Count value={score?.heartbeats} testId="score-heartbeats" />,
    sort: (score) => score?.heartbeats ?? null,
  },
  {
    // The headers are short because the dock is narrow and seven of them have to fit; the
    // *title* is the full sentence, and the rollup spells each one out in full.
    key: 'messages',
    label: 'Msgs',
    full: 'Messages',
    title: 'attributed messages this agent sent, heartbeats excluded — they have their own column',
    cell: (score) => <Count value={score?.messages} testId="score-messages" />,
    sort: (score) => score?.messages ?? null,
  },
  {
    key: 'failures',
    label: 'Fails',
    full: 'Failures',
    title: 'the maximum cumulative failure count per task, summed — a retry never double-counts',
    cell: (score) => <Count value={score?.failures} testId="score-failures" />,
    sort: (score) => score?.failures ?? null,
  },
  {
    key: 'escalations',
    label: 'Esc',
    full: 'Escalations',
    title: 'attributed escalation messages this agent sent',
    cell: (score) => <Count value={score?.escalations} testId="score-escalations" />,
    sort: (score) => score?.escalations ?? null,
  },
  {
    key: 'outcomes',
    label: 'Links',
    full: 'Outcome links',
    title: 'deduplicated recognized receipt links, from task results and worker completions',
    // The **count** here, and the links themselves on their own line under the row: a column
    // wide enough for a URL is a column that pushes four metrics off the panel, and a metric
    // you have to go looking for behind a scrollbar is a metric this panel failed to show.
    cell: (score) => <Outcomes score={score} />,
    // Absent ⇒ **unknown**: neither receipt source was readable, so this agent has no measured
    // zero to be sorted by, and it goes last like every other unknown. An empty list *is* a
    // measured zero and sorts as one (`Scorecard.outcomeLinks`).
    sort: (score) => (score?.outcomeLinks === undefined ? null : score.outcomeLinks.length),
  },
];

type Sort = { key: string; descending: boolean };

export function Scoreboard({ run, onClose }: ScoreboardProps) {
  const isMobile = useIsMobile();
  const cast = run?.cast ?? [];

  // The sort is the panel's, not the grid's: below `lg` the same ordering drives a stack of
  // cards instead of a table, and a sort that lived in the table would be lost on the fold.
  const [sort, setSort] = useState<Sort | null>(null);

  const sortBy = (key: string): void => {
    setSort((current) => (current?.key === key ? { key, descending: !current.descending } : { key, descending: true }));
  };

  return (
    <motion.aside
      data-testid="scoreboard"
      aria-label="Scoreboard"
      variants={isMobile ? BAND_IN : DOCK_IN}
      initial={enter('hidden')}
      animate="shown"
      transition={SPRING}
      // **Wider than the dock it stands in, and only while it stands there.** The dock is 22rem
      // because a conversation is a column of bubbles; a scoreboard is seven metrics across, and
      // at 22rem four of them sat behind a horizontal scrollbar nobody would have found — a
      // metric you have to discover is a metric the panel failed to show. The canvas lends the
      // width back the moment the panel closes.
      className={cn(DOCK_CLASS, 'lg:w-[35rem]')}
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

        {/* The refusal, said out loud (SPEC §14.6). Omitting a winner quietly would leave the
            reader free to crown one; a panel that *says* its columns do not add up will not. */}
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
      ) : isMobile ? (
        <Stack cast={cast} sort={sort} sortBy={sortBy} />
      ) : (
        <Grid cast={cast} sort={sort} sortBy={sortBy} />
      )}
    </motion.aside>
  );
}

type Sorting = { sort: Sort | null; sortBy: (key: string) => void };

/**
 * The comparison grid — seven metrics across, one row per agent, which is what makes them
 * comparable at a glance. It needs a wider dock than a conversation does, and it gets one.
 */
function Grid({ cast, sort, sortBy }: { cast: CastMember[] } & Sorting) {
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
                  aria-label={`Sort by ${metric.full.toLowerCase()}`}
                  title={metric.title}
                  onClick={() => sortBy(metric.key)}
                  className={cn(
                    'cursor-pointer rounded-sm px-1 py-0.5 font-semibold whitespace-nowrap transition-colors',
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
        {/* One `<tbody>` per agent, holding that agent's two lines: the metrics, and the links
            underneath them at full width. A row is the agent, so it is the tbody that carries
            the row's identity — and the links stay part of the row they belong to. */}
        {sorted(cast, sort).map((member) => (
          <tbody key={member.handle} data-testid="scoreboard-row" data-agent={member.monogram}>
            <tr>
              <td className={cn(BODY_CELL, 'border-b-0 text-left')}>
                <Who member={member} cast={cast} />
              </td>
              {METRICS.map((metric) => (
                <td key={metric.key} className={cn(BODY_CELL, 'border-b-0')}>
                  {metric.cell(member.score)}
                </td>
              ))}
            </tr>

            <tr>
              <td colSpan={METRICS.length + 1} className="border-panel-border/40 border-b px-2 pb-1.5 text-left">
                <OutcomeLinks score={member.score} />
              </td>
            </tr>
          </tbody>
        ))}
      </table>
    </div>
  );
}

const HEADER_CELL = 'border-b border-panel-border/70 px-2 py-1.5 text-right align-bottom whitespace-nowrap';
const BODY_CELL = 'border-b border-panel-border/40 px-2 py-1.5 text-right align-top tabular-nums whitespace-nowrap';

/**
 * The same facts, one agent, no table (SPEC §14.4): a comparison grid with a single row is an
 * empty page wearing column headers, so the rollup reads top to bottom instead — through the
 * *same* `METRICS` cells, so the two presentations cannot disagree about a value.
 */
function Rollup({ member, cast }: { member: CastMember; cast: CastMember[] }) {
  return (
    <div data-testid="scoreboard-rollup" className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="pb-3">
        <Who member={member} cast={cast} big />
      </div>

      <Facts member={member} />
    </div>
  );
}

/**
 * **The fold's comparison** (`docs/design/mobile.md`). A seven-column table in a 374px band puts
 * four of its metrics behind a horizontal scrollbar with nothing on screen to say they are
 * there — which is the same failure as not rendering them. So the phone gets one **card per
 * agent**, every metric spelled out, and the sort chips above still order them: the comparison
 * survives the fold, and it is the *layout* that folds rather than the facts.
 */
function Stack({ cast, sort, sortBy }: { cast: CastMember[] } & Sorting) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-panel-border/70 flex flex-wrap gap-1 border-b px-3 py-2">
        <span className="text-muted-foreground/70 w-full pb-0.5 text-[10px]">Sort by</span>
        {METRICS.map((metric) => (
          <button
            key={metric.key}
            type="button"
            aria-label={`Sort by ${metric.full.toLowerCase()}`}
            aria-pressed={sort?.key === metric.key}
            title={metric.title}
            onClick={() => sortBy(metric.key)}
            className={cn(
              'border-panel-border/70 cursor-pointer rounded-full border px-2 py-1 text-[11px] font-medium transition-colors',
              'focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none',
              sort?.key === metric.key ? 'bg-selection-soft text-selection-ink' : 'text-muted-foreground'
            )}
          >
            {metric.full}
            {sort?.key === metric.key && <span aria-hidden> {sort.descending ? '↓' : '↑'}</span>}
          </button>
        ))}
      </div>

      <ul>
        {sorted(cast, sort).map((member) => (
          <li
            key={member.handle}
            data-testid="scoreboard-row"
            data-agent={member.monogram}
            className="border-panel-border/40 border-b p-3.5"
          >
            <div className="pb-2">
              <Who member={member} cast={cast} big />
            </div>
            <Facts member={member} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One agent's metrics, read top to bottom — the rollup's body, and each card's on the fold. It
 * renders through the same `METRICS` cells the grid does, so a fact cannot say one thing in a
 * table and another in a card.
 */
function Facts({ member }: { member: CastMember }) {
  return (
    <>
      <dl className="flex flex-col">
        {METRICS.map((metric) => (
          <div
            key={metric.key}
            className="border-panel-border/40 flex items-baseline justify-between gap-3 border-b py-1.5 text-[11.5px] last:border-b-0"
          >
            {/* Away from the grid there is room for the metric's real name, so it gets it. */}
            <dt className="text-muted-foreground" title={metric.title}>
              {metric.full}
            </dt>
            <dd className="m-0 text-right tabular-nums">{metric.cell(member.score)}</dd>
          </div>
        ))}
      </dl>

      <div className="pt-2 empty:hidden">
        <OutcomeLinks score={member.score} />
      </div>
    </>
  );
}


/** The agent, wearing the monogram and colour it wears on every node it worked (`theme.ts`). */
function Who({ member, cast, big = false }: { member: CastMember; cast: CastMember[]; big?: boolean }) {
  return (
    <span className="flex items-center gap-2" title={member.handle}>
      <span
        className={cn(MONOGRAM_CLASS, big ? 'size-5 text-[9.5px]' : 'size-4.5 text-[9px]')}
        style={{ background: agentLook(member.handle, cast)?.colour ?? 'var(--muted-foreground)' }}
      >
        {member.monogram}
      </span>
      <span className="min-w-0">
        {big && <b className="block text-[12.5px] font-semibold">Agent {member.monogram.slice(1)}</b>}
        <code className="text-muted-foreground block truncate font-mono text-[10px]">
          {shortHandle(member.handle)}
        </code>
      </span>
    </span>
  );
}

/**
 * A count the database could answer — or **unknown**, when the column it would have been counted
 * from is not there. The distinction is the server's (`Scorecard`), and this is where it has to
 * survive contact with a cell that would happily have printed `0`.
 */
function Count({ value, testId }: { value: number | undefined; testId: string }) {
  return value === undefined ? (
    <Unknown testId={testId} why="unknown — this database has no column to count it from" />
  ) : (
    <span data-testid={testId}>{value}</span>
  );
}

/**
 * How many links this agent's receipts named — **the honest none and the honest unknown being
 * different cells**, which is the whole reason this is not a plain number. The links themselves
 * are underneath (`OutcomeLinks`); this is the sortable, comparable fact.
 */
function Outcomes({ score }: { score: Scorecard | undefined }) {
  if (score?.outcomeLinks === undefined) {
    return <Unknown testId="score-outcomes" why="unknown — this database cannot read outcome receipts" />;
  }

  if (score.outcomeLinks.length === 0) {
    return (
      <span data-testid="score-outcomes" className="text-muted-foreground/60" title="the receipts named no link">
        none
      </span>
    );
  }

  const total = score.outcomeLinks.length + (score.outcomeLinksOmitted ?? 0);
  return <span data-testid="score-outcomes">{total}</span>;
}

/** The links themselves, on their own line — where a URL has the width to be readable. */
function OutcomeLinks({ score }: { score: Scorecard | undefined }) {
  if (score?.outcomeLinks === undefined || score.outcomeLinks.length === 0) return null;

  return (
    <span className="flex flex-wrap items-center gap-1">
      {score.outcomeLinks.map((link) => (
        <ReceiptLink key={link} href={link} label={linkLabel(link)} />
      ))}

      {/* The cap, said out loud — the same sentence a turn's receipt uses, for the same reason. */}
      {score.outcomeLinksOmitted !== undefined && (
        <span data-testid="score-outcomes-omitted" className="text-muted-foreground text-[10px]">
          +{score.outcomeLinksOmitted} more · the inspector has the whole receipt
        </span>
      )}
    </span>
  );
}

/** Unknown, and *why* — never a zero, never an empty cell that reads as one (SPEC §14.4). */
function Unknown({ testId, why }: { testId: string; why: string }) {
  return (
    <span data-testid={testId} title={why} className="text-muted-foreground/60">
      —
    </span>
  );
}

/** A link short enough for a cell: its host and last path segments, with the whole URL on hover. */
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
 * One metric at a time, unknowns last in either direction. Ties keep first-dispatch order — the
 * cast's own order, and the grid's default — so an all-equal column is not an invitation for
 * rows to shuffle between two polls of an unchanged database.
 */
function sorted(cast: CastMember[], sort: Sort | null): CastMember[] {
  if (sort === null) return cast;

  const metric = METRICS.find((candidate) => candidate.key === sort.key);
  if (metric === undefined) return cast;

  const now = Date.now();

  return cast
    .map((member, index) => ({ member, index, value: metric.sort(member.score, now) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return a.index - b.index;
      // Unknown is not a small number and not a large one. It goes last, both ways — anything
      // else would rank an agent on a fact nobody measured.
      if (a.value === null) return 1;
      if (b.value === null) return -1;

      const byValue = sort.descending ? b.value - a.value : a.value - b.value;
      return byValue !== 0 ? byValue : a.index - b.index;
    })
    .map(({ member }) => member);
}
