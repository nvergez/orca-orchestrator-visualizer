import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { shortHandle } from '../../shared/handles.ts';
import {
  type ReportPresence,
  type ReportRow,
  type ReportSort,
  type Run,
  type StreamEvent,
  TASK_STATUSES,
} from '../../shared/types.ts';
import { themeOf } from '../canvas/theme.ts';
import { CHIP_CLASS } from '../chip.ts';
import { Duration } from '../duration.tsx';
import { enter, SPRING } from '../motion.ts';
import { ReceiptFacts } from '../receipt.tsx';
import { PANEL_CLASS, PANEL_HEADER_CLASS, PANEL_TITLE_CLASS } from '../surface.ts';
import { useIsMobile } from '../viewport.tsx';
import { DEFAULT_VIEW, isFiltered, type ReportLoader, type ReportView, useReport } from './query.ts';

/**
 * **The cross-history report** (#70, SPEC §12.4): one row per retained task, across every
 * orchestrator this database remembers — and an entry point *into* the tool, never a second one.
 *
 * The rail lists orchestrators and the canvas draws one of them. Neither can answer a question
 * that is about history rather than about a run — *which task took longest, who carries the
 * failures, what did last week actually produce, and what did we never start at all* — and the
 * answer to none of those is another graph (SPEC §12.6). It is a table you can rank and search,
 * and a row you click is the ordinary selected run opening at the ordinary inspector.
 *
 * Three things it is careful about:
 *
 * - **It shows the missing value.** "Never dispatched" is written in the dispatch column, in
 *   words. Stalled work is the thing a rail of runs can never show you, and a blank cell would
 *   read as a rendering bug rather than as the finding it is.
 * - **It ranks nothing itself.** Every header sends a new query; the order, the filters and the
 *   pages are the server's (`report.ts`). A browser that sorted these rows would first have to
 *   hold the whole of a database that is never pruned.
 * - **It owns no task detail.** A row carries the summary the wire already tells the truth about
 *   — #66's duration observation, #67's recognized facts — and the inspector behind the click is
 *   where the whole receipt, the bodies and the attempts live.
 */

/** What each sort key is called, in the column header that asks for it. */
const COLUMNS: Record<ReportSort, string> = {
  title: 'Task',
  dispatched: 'Dispatched',
  duration: 'Duration',
  attempts: 'Attempts',
  failures: 'Failures',
};

export type ReportProps = {
  event: StreamEvent | null;
  /** The loaded run index — where the run and cast-member filter options come from. */
  runs: Run[];
  load: ReportLoader;
  /** A row was chosen: load that run whole, and open its task inspector. */
  onSelectRow: (runId: string, taskId: string) => void;
  onClose: () => void;
};

export function Report({ event, runs, load, onSelectRow, onClose }: ReportProps) {
  const [view, setView] = useState<ReportView>(DEFAULT_VIEW);
  const { ready, rows, total, hasMore, loadMore, failed } = useReport(true, event, view, load);

  // Nine columns do not fit a phone, and the page may not scroll sideways to hide the fact
  // (`docs/design/mobile.md`). Below `lg` the same rows fold into cards — a *behavior* classes
  // cannot express, which is what this hook is for, and it answers `false` wherever `matchMedia`
  // is absent, so every existing jsdom test goes on rendering the table.
  const isMobile = useIsMobile();

  // Escape closes it, and focus lands inside it on open — it is a dialog over the whole tool,
  // and a reader who opened it with the keyboard has to be able to leave it with the keyboard.
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, []);

  /** A header click: the same key again flips the direction; a new key starts at its useful end. */
  function sortBy(sort: ReportSort): void {
    setView((current) =>
      current.sort === sort
        ? { ...current, dir: current.dir === 'desc' ? 'asc' : 'desc' }
        : // Descending is the useful default for every key but the title: the longest, the most
          // failed, the most recent are what a post-mortem is looking for. A title is looked up.
          { ...current, sort, dir: sort === 'title' ? 'asc' : 'desc' }
    );
  }

  return (
    <div
      data-testid="report-overlay"
      className="bg-field/85 fixed inset-0 z-50 flex flex-col p-2 backdrop-blur-sm sm:p-4"
      onKeyDown={(pressed) => {
        if (pressed.key === 'Escape') onClose();
      }}
    >
      <motion.section
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Task report"
        data-testid="report"
        initial={enter({ opacity: 0, y: 8 })}
        animate={{ opacity: 1, y: 0 }}
        transition={SPRING}
        className={cn(PANEL_CLASS, 'flex min-h-0 flex-1 flex-col overflow-hidden outline-none')}
      >
        <header className={cn(PANEL_HEADER_CLASS, 'gap-3')}>
          <div className="flex items-center gap-3">
            <h2 className={PANEL_TITLE_CLASS}>Task report</h2>
            {/* What the filters matched, across every page — so a reader knows whether the thing
                they are looking for is even in what they filtered to, before they page for it. */}
            <span data-testid="report-total" className="text-muted-foreground/70 text-[11px] tabular-nums">
              {ready ? `${rows.length} of ${total}` : 'loading…'}
            </span>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-testid="report-close"
              aria-label="Close the task report"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground ml-auto size-7 shrink-0 cursor-pointer pointer-coarse:size-10"
            >
              <X className="size-4" />
            </Button>
          </div>

          <Filters view={view} rows={rows} runs={runs} onChange={setView} />
        </header>

        {failed && rows.length === 0 ? (
          <p role="status" className="text-muted-foreground p-4 text-xs">
            Could not read the report. Retrying…
          </p>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            {/*
              **The same rows, folded** (`docs/design/mobile.md`). Nine columns do not fit a
              390px phone, and a table that ran off the side would put the duration, the failures
              and the outcome — three of the five things this report exists to show — somewhere a
              thumb cannot reach, with the page's no-horizontal-scroll rule making sure it never
              gets there. So below `lg` a row is a card: the same facts, stacked and labelled,
              in the same order, out of the same `ReportRow`. Desktop is untouched, and the sort
              controls are the same buttons under the same test ids either way.
            */}
            {isMobile ? (
              <>
                <SortChips view={view} onSort={sortBy} />
                <ul className="divide-panel-border/50 divide-y">
                  {rows.map((row) => (
                    <li key={row.taskId}>
                      <Card row={row} onSelect={() => onSelectRow(row.runId, row.taskId)} />
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <table className="w-full table-fixed border-collapse text-left text-[12px]">
                {/* Fixed, and the widths are the contract: an auto-laid table sizes itself to its
                    widest cell, and one worker that named forty files would push the status column
                    off the panel. Every cell below clips instead (`truncate`), and the whole
                    receipt is one click away. */}
                <colgroup>
                  <col className="w-[11%]" />
                  <col className="w-[20%]" />
                  <col className="w-[6%]" />
                  <col className="w-[13%]" />
                  <col className="w-[9%]" />
                  <col className="w-[6%]" />
                  <col className="w-[6%]" />
                  <col className="w-[9%]" />
                  <col className="w-[20%]" />
                </colgroup>

                <thead className="text-muted-foreground bg-panel/80 sticky top-0 z-10 backdrop-blur-sm">
                  <tr>
                    <Th>Run</Th>
                    <SortableTh sort="title" view={view} onSort={sortBy} />
                    <Th>Agent</Th>
                    <SortableTh sort="dispatched" view={view} onSort={sortBy} />
                    <SortableTh sort="duration" view={view} onSort={sortBy} />
                    <SortableTh sort="attempts" view={view} onSort={sortBy} />
                    <SortableTh sort="failures" view={view} onSort={sortBy} />
                    <Th>Status</Th>
                    <Th>Outcome</Th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((row) => (
                    <Row key={row.taskId} row={row} onSelect={() => onSelectRow(row.runId, row.taskId)} />
                  ))}
                </tbody>
              </table>
            )}

            {ready && rows.length === 0 && (
              <p data-testid="report-empty" className="text-muted-foreground p-4 text-xs">
                {isFiltered(view)
                  ? 'No retained task matches these filters.'
                  : 'No tasks in this database yet.'}
              </p>
            )}

            {hasMore && (
              <button
                type="button"
                data-testid="report-more"
                onClick={loadMore}
                className={cn(CHIP_CLASS, 'mx-3 my-3 cursor-pointer max-lg:py-1.5')}
              >
                Load older rows
              </button>
            )}
          </ScrollArea>
        )}
      </motion.section>
    </div>
  );
}

/**
 * The nine facts a row states, each written **once** — so the table and the folded card cannot
 * come to say different things about one task, which is exactly the drift a second renderer
 * invites. What differs below is the box each one sits in; what is *said* is this.
 */
const Fact = {
  agent: (row: ReportRow) =>
    row.agent === null ? (
      <Missing>none</Missing>
    ) : (
      <span title={row.agent.handle} className="whitespace-nowrap">
        {/* The cast's own numbering, so a row and the canvas name one agent alike. A handle with
            no monogram is the orchestrator working its own task (SPEC §4.3a) — it is not one of
            the agents it spawned, and it is not given a made-up name here. */}
        {row.agent.monogram ?? shortHandle(row.agent.handle)}
      </span>
    ),

  dispatched: (row: ReportRow) =>
    row.dispatchedAt === null ? (
      // The finding, in words. `attemptCount: 0` is the evidence: nothing ever dispatched this
      // task, and a blank cell would read as a rendering bug rather than as the answer.
      <Missing>{row.attemptCount === 0 ? 'never dispatched' : 'unknown'}</Missing>
    ) : (
      <span className="whitespace-nowrap tabular-nums">{formatInstant(row.dispatchedAt)}</span>
    ),

  // #66's observation, whole: the clock it read is in the tooltip, and an open interval ages
  // against the reader's own wall clock. Absent ⇒ nothing here, never a zero.
  duration: (row: ReportRow) =>
    row.duration ? (
      <Duration observation={row.duration} testId="report-duration" className="whitespace-nowrap tabular-nums" />
    ) : (
      <Missing>unknown</Missing>
    ),

  // The maximum retained cumulative count, never the sum across retries (SPEC §12.4).
  failures: (row: ReportRow) => (
    <span
      data-testid="report-failures"
      className={cn('tabular-nums', row.failureCount > 0 && 'text-status-failed-ink')}
    >
      {row.failureCount}
    </span>
  ),

  status: (row: ReportRow) => (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', themeOf(row.status).dot)} />
      {row.status}
    </span>
  ),

  outcome: (row: ReportRow) =>
    row.outcome ? (
      <ReceiptFacts facts={row.outcome} omitted={row.outcomeOmitted ?? 0} testId="report-outcome" />
    ) : (
      <Missing>none recognized</Missing>
    ),
};

/** What selecting a row *is*, on any shape of screen: open this task, in its own orchestrator. */
function selection(row: ReportRow, onSelect: () => void) {
  return {
    'data-testid': 'report-row',
    'data-task': row.taskId,
    'data-run': row.runId,
    'aria-label': `Open ${row.title} in ${row.runLabel}`,
    onClick: onSelect,
  };
}

/**
 * One task, as a row of the table. The whole row is the button, because the whole row is the
 * same act — and it is a `<tr role="button">` rather than a button *inside* a cell, so that a
 * click anywhere on the task's line means what a reader expects it to mean.
 */
function Row({ row, onSelect }: { row: ReportRow; onSelect: () => void }) {
  return (
    <tr
      {...selection(row, onSelect)}
      tabIndex={0}
      role="button"
      onKeyDown={(pressed) => {
        if (pressed.key === 'Enter' || pressed.key === ' ') {
          pressed.preventDefault();
          onSelect();
        }
      }}
      className="border-panel-border/50 hover:bg-accent/50 focus-visible:ring-ring/50 cursor-pointer border-t align-top focus-visible:ring-[3px] focus-visible:outline-none"
    >
      <Td className="text-muted-foreground truncate">{row.runLabel}</Td>
      <Td>
        <span className="block truncate font-medium">{row.title}</span>
      </Td>
      <Td className="text-muted-foreground truncate">{Fact.agent(row)}</Td>
      <Td>{Fact.dispatched(row)}</Td>
      <Td>{Fact.duration(row)}</Td>
      <Td className="tabular-nums">{row.attemptCount}</Td>
      <Td>{Fact.failures(row)}</Td>
      <Td className="truncate">{Fact.status(row)}</Td>
      <Td className="min-w-0">{Fact.outcome(row)}</Td>
    </tr>
  );
}

/**
 * The same task, folded (`docs/design/mobile.md`): the title on top, its orchestrator under it,
 * and the facts as labelled pairs that wrap. Nothing is dropped and nothing is off the side —
 * the phone pays in height, which is the axis it has.
 */
function Card({ row, onSelect }: { row: ReportRow; onSelect: () => void }) {
  return (
    <button
      type="button"
      {...selection(row, onSelect)}
      className="hover:bg-accent/50 focus-visible:ring-ring/50 w-full cursor-pointer px-4 py-3 text-left focus-visible:ring-[3px] focus-visible:outline-none"
    >
      <span className="flex items-center gap-2">
        <b className="min-w-0 flex-1 truncate text-[13px] font-semibold">{row.title}</b>
        {Fact.status(row)}
      </span>

      <span className="text-muted-foreground mt-0.5 block truncate text-[11px]">{row.runLabel}</span>

      <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <Pair label="Agent">{Fact.agent(row)}</Pair>
        <Pair label="Duration">{Fact.duration(row)}</Pair>
        <Pair label="Dispatched">{Fact.dispatched(row)}</Pair>
        <Pair label="Attempts">
          <span className="tabular-nums">
            {row.attemptCount}
            {row.failureCount > 0 && <> · {Fact.failures(row)} failed</>}
          </span>
        </Pair>
      </dl>

      <div className="text-[11px]">{Fact.outcome(row)}</div>
    </button>
  );
}

function Pair({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <dt className="text-muted-foreground/70 shrink-0">{label}</dt>
      <dd className="m-0 min-w-0 truncate">{children}</dd>
    </div>
  );
}

/**
 * The folded shell's sort control: the same buttons the table's headers are, under the same test
 * ids, in a row of chips a thumb can hit. A `<select>` would have been fewer pixels and one more
 * thing to learn — these are the columns, and tapping the active one turns it round.
 */
function SortChips({ view, onSort }: { view: ReportView; onSort: (sort: ReportSort) => void }) {
  return (
    <div className="border-panel-border/50 flex flex-wrap gap-1.5 border-b px-3 py-2">
      {(Object.keys(COLUMNS) as ReportSort[]).map((sort) => {
        const active = view.sort === sort;

        return (
          <button
            key={sort}
            type="button"
            data-testid={`report-sort-${sort}`}
            aria-pressed={active}
            onClick={() => onSort(sort)}
            className={cn(CHIP_CLASS, 'cursor-pointer py-1.5', active && 'text-foreground border-selection/40')}
          >
            {COLUMNS[sort]}
            {active && (view.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A value the database does not hold, said out loud. It is the report's most load-bearing piece
 * of styling: an em-dash in a cell is a rendering accident, and "never dispatched" is a finding.
 */
function Missing({ children }: { children: string }) {
  return (
    <span data-testid="report-missing" className="text-muted-foreground/70 italic">
      {children}
    </span>
  );
}

function Th({ children }: { children: string }) {
  return <th className="px-3 py-2 text-[10px] font-semibold tracking-widest uppercase">{children}</th>;
}

/** A column that ranks. Clicking it again turns the ranking round; the server does the ranking. */
function SortableTh({
  sort,
  view,
  onSort,
}: {
  sort: ReportSort;
  view: ReportView;
  onSort: (sort: ReportSort) => void;
}) {
  const active = view.sort === sort;

  return (
    <th
      aria-sort={active ? (view.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className="px-3 py-2 text-[10px] font-semibold tracking-widest uppercase"
    >
      <button
        type="button"
        data-testid={`report-sort-${sort}`}
        onClick={() => onSort(sort)}
        className={cn(
          'hover:text-foreground flex cursor-pointer items-center gap-1 uppercase',
          active && 'text-foreground'
        )}
      >
        {COLUMNS[sort]}
        {active &&
          (view.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn('px-3 py-2', className)}>{children}</td>;
}

/**
 * The filters — and every one of them can ask for the **absence** of the thing it filters on,
 * because a post-mortem's sharpest questions are about absences: what never went out, and what
 * came back with nothing anybody can point at.
 *
 * The run and cast-member options come from the run index the rail has **loaded**, not from all
 * of history: the index is paged (#69), and a select that pretended to list every orchestrator
 * this database ever held would be lying about the one thing it is offering. Older orchestrators
 * arrive in the list as the reader loads them.
 */
function Filters({
  view,
  rows,
  runs,
  onChange,
}: {
  view: ReportView;
  rows: ReportRow[];
  runs: Run[];
  onChange: (view: ReportView) => void;
}) {
  // Every cast member of every loaded orchestrator, deduplicated by handle — an agent that worked
  // for two orchestrators is one terminal, and it is listed once, under the run it is named in.
  const agents = useMemo(() => {
    const seen = new Map<string, { handle: string; label: string }>();
    for (const run of runs) {
      for (const member of run.cast) {
        if (!seen.has(member.handle)) {
          seen.set(member.handle, { handle: member.handle, label: `${member.monogram} · ${run.label}` });
        }
      }
    }
    return [...seen.values()];
  }, [runs]);

  // The six known statuses, plus any the loaded rows carry that this build has never heard of —
  // a status the tool cannot colour is still a status a reader can search for (SPEC §5).
  const statuses = useMemo(() => {
    const known = new Set<string>(TASK_STATUSES);
    for (const row of rows) known.add(row.status);
    return [...known];
  }, [rows]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        testId="report-filter-run"
        label="Orchestrator"
        value={view.runId}
        options={runs.map((run) => ({ value: run.id, label: run.label }))}
        onChange={(runId) => onChange({ ...view, runId })}
      />

      <Select
        testId="report-filter-status"
        label="Status"
        value={view.status}
        options={statuses.map((status) => ({ value: status, label: status }))}
        onChange={(status) => onChange({ ...view, status })}
      />

      <Select
        testId="report-filter-agent"
        label="Agent"
        value={view.agent}
        options={agents.map((agent) => ({ value: agent.handle, label: agent.label }))}
        onChange={(agent) => onChange({ ...view, agent })}
      />

      <Presence
        testId="report-filter-dispatch"
        label="Dispatch"
        value={view.dispatch}
        words={{ present: 'dispatched', missing: 'never dispatched' }}
        onChange={(dispatch) => onChange({ ...view, dispatch })}
      />

      <Presence
        testId="report-filter-outcome"
        label="Outcome"
        value={view.outcome}
        words={{ present: 'has an outcome', missing: 'none recognized' }}
        onChange={(outcome) => onChange({ ...view, outcome })}
      />

      {/* The range reads the **dispatch** clock, and says so — "between Tuesday and Thursday" is
          a different question asked of `dispatched_at` than of `tasks.created_at`, and a filter
          that did not name its clock would be answering one of them while looking like the other. */}
      <label className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
        Dispatched from
        <input
          type="date"
          data-testid="report-filter-from"
          value={view.from ?? ''}
          onChange={(typed) => onChange({ ...view, from: typed.target.value === '' ? null : typed.target.value })}
          className="border-panel-border/70 bg-transparent rounded-md border px-1.5 py-1 text-[11px]"
        />
      </label>

      <label className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
        to
        <input
          type="date"
          data-testid="report-filter-to"
          value={view.to ?? ''}
          onChange={(typed) => onChange({ ...view, to: typed.target.value === '' ? null : typed.target.value })}
          className="border-panel-border/70 bg-transparent rounded-md border px-1.5 py-1 text-[11px]"
        />
      </label>

      {isFiltered(view) && (
        <button
          type="button"
          data-testid="report-clear"
          // The sort survives: it is how the reader is *reading*, not what they are looking for.
          onClick={() => onChange({ ...DEFAULT_VIEW, sort: view.sort, dir: view.dir })}
          className={cn(CHIP_CLASS, 'cursor-pointer')}
        >
          Clear filters <X className="size-3" />
        </button>
      )}
    </div>
  );
}

/** One filter over a value that is there or is not — with `missing` as an answer, never a gap. */
function Presence({
  testId,
  label,
  value,
  words,
  onChange,
}: {
  testId: string;
  label: string;
  value: ReportPresence;
  words: { present: string; missing: string };
  onChange: (value: ReportPresence) => void;
}) {
  return (
    <Select
      testId={testId}
      label={label}
      value={value === 'any' ? null : value}
      options={[
        { value: 'present', label: words.present },
        { value: 'missing', label: words.missing },
      ]}
      onChange={(chosen) => onChange((chosen ?? 'any') as ReportPresence)}
    />
  );
}

/** A plain `<select>`: this is a filter bar, and a filter bar is a form. */
function Select({
  testId,
  label,
  value,
  options,
  onChange,
}: {
  testId: string;
  label: string;
  value: string | null;
  options: { value: string; label: string }[];
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
      {label}
      <select
        data-testid={testId}
        value={value ?? ''}
        onChange={(chosen) => onChange(chosen.target.value === '' ? null : chosen.target.value)}
        className="border-panel-border/70 max-w-[12rem] cursor-pointer rounded-md border bg-transparent px-1.5 py-1 text-[11px]"
      >
        <option value="">any</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** An instant a person can place, in their own timezone — the tool's one formatting of a date. */
function formatInstant(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}
