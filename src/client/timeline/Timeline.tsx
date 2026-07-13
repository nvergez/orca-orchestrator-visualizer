import { AlertTriangle, CircleCheck, OctagonAlert } from 'lucide-react';
import { useMemo } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { RunSnapshot } from '../../shared/types.ts';
import { agentLook, MONOGRAM_CLASS, SELECTED_RING, themeOf } from '../canvas/theme.ts';
import { Duration } from '../duration.tsx';
import { localInstant } from '../relative-time.ts';
import { PANEL_CLASS, PANEL_TITLE_CLASS } from '../surface.ts';
import {
  deriveTimeline,
  placeBar,
  placeInstant,
  type TimelineBar,
  type TimelineLane,
  type TimelineMarker,
  type TimelineModel,
  type TimelineWindow,
} from './derive.ts';

/**
 * **The dispatch timeline** (#72) — the selected run's centre, drawn against the clock.
 *
 * The DAG is a picture of *what depended on what*, and it is the right picture — but it cannot show
 * the two things a post-mortem actually asks. **Who was working at the same time as whom** is a fact
 * about the calendar, and a layered graph deliberately throws the calendar away. **How many times we
 * had to ask** is a fact about `dispatch_contexts`, which holds one row per *attempt* and is the only
 * append-only history the schema has — and the DAG has room for exactly one of them per node.
 *
 * So: one lane per cast member, one bar per **retained attempt**, and the retry drawn as a line from
 * the attempt that failed to the one that followed it, across whatever lanes they landed in (a retry
 * goes to a fresh worktree with a fresh handle — SPEC §4.3a).
 *
 * **The geometry never reads the wall clock.** The axis is the retained instants and nothing else
 * (`derive.ts`), so a page of finished runs holds perfectly still and a live one does not re-scale
 * itself under a reader every second (SPEC §7.9). The one thing that moves is the *number* on an
 * open bar, which counts up because the work has not stopped — and that is `<Duration>`'s job
 * already (#66), so there is one "so far" on this screen and not two.
 *
 * **Nothing here is invented.** `pending → ready` was never timestamped (SPEC §4.2, trap 6) and so
 * is not on the axis; a bar with no readable end says so rather than guessing one; and a task with
 * no readable dispatch instant keeps its story in the untimed list below, where it still opens.
 */

/** The lane-label gutter. The tracks start here, and so does the link overlay's `x = 0`. */
const GUTTER = 92;

/** One packed sub-row inside a lane, and the bar that sits in it. */
const ROW_HEIGHT = 26;
const BAR_HEIGHT = 18;

/** The lane's own breathing room, and the strip its point markers stand on. */
const LANE_PADDING = 8;
const MARKER_ROW = 16;

/** Narrower than this and a bar is not a target — a two-second attempt is still a click. */
const MIN_BAR_WIDTH = 6;

/**
 * An `unended` attempt has **zero width by construction** — its start is the only instant the row
 * retains — so at 6px it is a speck nobody can see, hover or explain, and an attempt that is on
 * screen but unreadable has been lost just as surely as one that was dropped.
 *
 * So it is drawn as what it is: a **stem at the instant it was dispatched, trailing off**. The hatch
 * and the fade are the claim — *we do not know how far this goes* — and they are why the width below
 * is not a duration: nothing about a hatched, fraying stub reads as "this took 50 pixels of work",
 * the way a solid bar of the same size would.
 */
const UNENDED_WIDTH = 52;

/** The hatch: the one texture on this view, and it means "the evidence stops here". */
const UNENDED_HATCH =
  'repeating-linear-gradient(135deg, transparent, transparent 3px, color-mix(in oklch, currentColor 22%, transparent) 3px, color-mix(in oklch, currentColor 22%, transparent) 5px)';

export type TimelineProps = {
  // `meta` is the live database's, and an archived replay has none (#74) — the timeline never
  // read it anyway, so it asks for exactly the evidence it draws.
  snapshot: Omit<RunSnapshot, 'meta'>;
  selectedAgent: string | null;
  selectedTaskId: string | null;
  /** A bar is a node: clicking it again lets go (`App`'s `selectTask`). */
  onSelectTask: (taskId: string) => void;
  /** A marker or an untimed row *names* a task — it never toggles one (`App`'s `showTask`). */
  onShowTask: (taskId: string) => void;
};

export function Timeline({ snapshot, selectedAgent, selectedTaskId, onSelectTask, onShowTask }: TimelineProps) {
  const model = useMemo(() => deriveTimeline(snapshot), [snapshot]);
  const { lanes, window: axis } = model;

  // Where every lane and every bar sits vertically — computed once, because the link overlay and
  // the lanes have to agree about it to the pixel, and two passes that each did their own
  // arithmetic would be two chances to disagree.
  const layout = useMemo(() => layoutOf(lanes), [lanes]);

  return (
    <section data-testid="timeline" className={cn(PANEL_CLASS, 'bg-panel-solid flex h-full w-full flex-col')}>
      {axis === null ? (
        <Empty />
      ) : (
        <>
          <Axis axis={axis} />

          <ScrollArea className="min-h-0 flex-1">
            <div className="relative" style={{ height: layout.height }}>
              <Links model={model} layout={layout} axis={axis} selectedTaskId={selectedTaskId} />

              {layout.placed.map(({ lane, top, height }) => (
                <Lane
                  key={lane.key}
                  lane={lane}
                  cast={snapshot.run.cast}
                  axis={axis}
                  top={top}
                  height={height}
                  dimmed={selectedAgent !== null && lane.key !== selectedAgent}
                  selectedTaskId={selectedTaskId}
                  onSelectTask={onSelectTask}
                  onShowTask={onShowTask}
                />
              ))}
            </div>
          </ScrollArea>
        </>
      )}

      <Untimed model={model} onShowTask={onShowTask} />
    </section>
  );
}

/**
 * Every lane's vertical extent, and every bar's — **one arithmetic, read by two renderers.** The
 * lanes lay themselves out and the link overlay draws across all of them, and if those two did their
 * own sums a connector would land a few pixels off the bar it names.
 *
 * The box travels *with* its lane rather than in a parallel array beside it: two lists indexed in
 * lockstep are two lists that can fall out of step.
 */
type PlacedLane = { lane: TimelineLane; top: number; height: number };
type Layout = { placed: PlacedLane[]; height: number; barCentres: Map<string, number> };

function layoutOf(lanes: TimelineLane[]): Layout {
  const placed: PlacedLane[] = [];
  const barCentres = new Map<string, number>();
  let offset = 0;

  for (const lane of lanes) {
    const markers = lane.markers.length > 0 ? MARKER_ROW : 0;
    const height = LANE_PADDING * 2 + lane.rows * ROW_HEIGHT + markers;

    for (const bar of lane.bars) {
      // The centre of the bar, in the scroller's own coordinates: what a link has to land on.
      barCentres.set(bar.id, offset + LANE_PADDING + bar.row * ROW_HEIGHT + BAR_HEIGHT / 2);
    }

    placed.push({ lane, top: offset, height });
    offset += height;
  }

  return { placed, height: offset, barCentres };
}

/**
 * The clock across the top. Five ticks, in the reader's own timezone — the axis is UTC on the wire
 * and nobody reads a post-mortem in UTC.
 */
function Axis({ axis }: { axis: TimelineWindow }) {
  const ticks = useMemo(() => {
    const span = axis.endAt - axis.startAt;
    return Array.from({ length: 5 }, (_, index) => {
      const at = axis.startAt + (span * index) / 4;
      return { at, left: (index / 4) * 100 };
    });
  }, [axis]);

  return (
    <header
      data-testid="timeline-axis"
      className="border-panel-border/70 relative shrink-0 border-b py-2"
      style={{ paddingLeft: GUTTER }}
    >
      <span className={cn(PANEL_TITLE_CLASS, 'absolute top-2 left-4')}>Timeline</span>

      <div className="relative h-4">
        {ticks.map((tick) => (
          <span
            key={tick.at}
            className="text-muted-foreground/70 absolute -translate-x-1/2 text-[10px] tabular-nums whitespace-nowrap first:translate-x-0 last:-translate-x-full"
            style={{ left: `${tick.left}%` }}
          >
            {timeOf(tick.at)}
          </span>
        ))}
      </div>
    </header>
  );
}

/**
 * One cast member's row, or the row for the work no agent was spawned for — and the second one is
 * **named**, not left as a nameless third agent (issue #72 AC 2).
 *
 * Dimmed when another agent is the pivot: the same gesture the canvas makes, so learning it in one
 * view teaches it in the other. **Dimmed, never hidden** — the shape of the orchestration survives
 * the filter, which is the whole difference between focusing a view and emptying one (SPEC §7.5).
 */
function Lane({
  lane,
  cast,
  axis,
  top,
  height,
  dimmed,
  selectedTaskId,
  onSelectTask,
  onShowTask,
}: {
  lane: TimelineLane;
  cast: RunSnapshot['run']['cast'];
  axis: TimelineWindow;
  top: number;
  height: number;
  dimmed: boolean;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onShowTask: (taskId: string) => void;
}) {
  const look = agentLook(lane.handle, cast);

  return (
    <div
      data-testid="timeline-lane"
      data-lane={lane.key}
      data-dimmed={dimmed}
      className={cn('absolute inset-x-0 transition-opacity', dimmed && 'opacity-[0.18]')}
      style={{ top, height }}
    >
      <div className="text-muted-foreground absolute top-2 left-4 flex items-center gap-1.5 text-[11px]">
        {look === null ? (
          <span className="truncate font-medium" title={lane.label}>
            {lane.label}
          </span>
        ) : (
          <>
            <span
              className={cn(MONOGRAM_CLASS, 'size-5 text-[10px]')}
              style={{ background: look.colour }}
              title={lane.handle ?? undefined}
            >
              {look.monogram}
            </span>
            <span className="sr-only">Agent {look.monogram.slice(1)}</span>
          </>
        )}
      </div>

      {/* The track: percentages inside it are the axis, which is why the gutter is a margin on it
          and not a column beside it — one coordinate system, shared with the link overlay. */}
      <div className="relative h-full" style={{ marginLeft: GUTTER, marginRight: 16 }}>
        {lane.bars.map((bar) => (
          <Bar
            key={bar.id}
            bar={bar}
            axis={axis}
            selected={bar.taskId === selectedTaskId}
            onSelect={() => onSelectTask(bar.taskId)}
          />
        ))}

        {lane.markers.map((marker) => (
          <Marker
            key={marker.id}
            marker={marker}
            axis={axis}
            top={LANE_PADDING + lane.rows * ROW_HEIGHT}
            onShow={marker.taskId === null ? undefined : () => onShowTask(marker.taskId!)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One retained dispatch attempt.
 *
 * **The fill is the task's status**, exactly as its node's is (`canvas/theme.ts`) — a bar and a node
 * are the same task seen twice, and a second palette for the second view would be a second meaning
 * for one colour. The lane already says *who*, so the bar does not have to.
 *
 * The right edge says what the evidence says: a hard stop when the row recorded one, a fade into the
 * axis when the attempt is still out, and — for an attempt that stopped without recording when — a
 * fade **and no claim of an end at all**.
 */
function Bar({
  bar,
  axis,
  selected,
  onSelect,
}: {
  bar: TimelineBar;
  axis: TimelineWindow;
  selected: boolean;
  onSelect: () => void;
}) {
  const theme = themeOf(paletteStatus(bar.status));
  const { left, width } = placeBar(bar.extent, axis);
  const unended = bar.extent.kind === 'unended';
  const sentence = describe(bar);

  return (
    <button
      type="button"
      data-testid="timeline-bar"
      data-attempt={bar.id}
      data-task={bar.taskId}
      data-extent={bar.extent.kind}
      onClick={onSelect}
      // One sentence, said once: a tooltip and a label that composed the same facts in two orders
      // would eventually disagree about one of them.
      title={sentence}
      aria-label={sentence}
      className={cn(
        'absolute flex cursor-pointer items-center gap-1 overflow-hidden rounded border px-1.5 text-[10px] whitespace-nowrap',
        theme.surface,
        selected && SELECTED_RING,
        // An open or unended bar does not end where it is drawn to end, so it does not draw an end:
        // the right edge dissolves instead of closing.
        bar.extent.kind !== 'closed' && 'border-r-0 [mask-image:linear-gradient(to_right,black_60%,transparent)]'
      )}
      style={{
        left: `${left}%`,
        width: `${width}%`,
        minWidth: unended ? UNENDED_WIDTH : MIN_BAR_WIDTH,
        top: LANE_PADDING + bar.row * ROW_HEIGHT,
        height: BAR_HEIGHT,
        // The texture *is* the claim: this attempt has a beginning and the file records no end.
        ...(unended ? { backgroundImage: UNENDED_HATCH } : {}),
      }}
    >
      {/* The retry, said on the bar itself: which attempt of how many. Only when there was more
          than one — "1/1" on every bar in the run would be noise on the 99% case. */}
      {bar.attemptCount > 1 && (
        <b className="shrink-0 font-mono font-semibold tabular-nums">
          {bar.attemptIndex}/{bar.attemptCount}
        </b>
      )}

      {/* The third extent is the one that must not speak: it is not running, so "so far" would be a
          clock ticking against nobody (#66), and it did not stop where it is drawn to. It says the
          only thing it can — that the evidence runs out here — and the hatch says it without words,
          because at 52px there is no room for any. The tooltip and the label carry the sentence. */}
      {unended ? (
        <span data-testid="bar-unended" aria-hidden className="font-semibold opacity-80">
          ?
        </span>
      ) : (
        <>
          <span className="truncate">{bar.title}</span>

          {bar.duration !== undefined && (
            <Duration observation={bar.duration} testId="bar-duration" className="ml-auto shrink-0 tabular-nums" />
          )}
        </>
      )}
    </button>
  );
}

/**
 * What the bar says in full, where a 52px rectangle cannot — and it is the **only** place those
 * facts are composed, so the tooltip and the accessible name cannot drift apart.
 *
 * It names the attempt's own status, because that is what the fill is now saying and a colour is not
 * a word: `circuit_broken` and `failed` are two different things that wear one red.
 */
function describe(bar: TimelineBar): string {
  const who = `${bar.title} — attempt ${bar.attemptIndex} of ${bar.attemptCount} (${bar.status})`;
  const from = `dispatched ${localInstant(bar.extent.startAt)}`;

  if (bar.extent.kind === 'closed') return `${who} · ${from}, completed ${localInstant(bar.extent.endAt)}`;
  if (bar.extent.kind === 'open') return `${who} · ${from}, still out per retained evidence`;
  return `${who} · ${from}; the row never recorded when it stopped`;
}

/**
 * An attempt's `DispatchStatus`, on the six-status palette (`canvas/theme.ts`).
 *
 * Four of the five land on it by name. `circuit_broken` does not exist as a *task* status, and it is
 * emphatically not an *unknown* one — it is the breaker tripping after three failures (HANDOFF.md),
 * which is a failure and must look like one. Neutral grey for the loudest thing a dispatch row can
 * say would be the one degradation SPEC §5 never meant: the raw string is still in the tooltip.
 */
function paletteStatus(status: string): string {
  return status === 'circuit_broken' ? 'failed' : status;
}

/** How each marker reads, and what it is *for*: a recorded instant, and nothing more. */
const MARKERS = {
  gate: { icon: OctagonAlert, className: 'text-gate', noun: 'gate opened' },
  escalation: { icon: AlertTriangle, className: 'text-status-failed', noun: 'escalation' },
  completion: { icon: CircleCheck, className: 'text-status-completed', noun: 'task recorded complete' },
} as const;

/**
 * A point marker: a gate's question, an escalation, or the instant a task was **recorded** complete.
 *
 * All three are instants Orca actually wrote down. What is deliberately *not* here is every status
 * change in between: six writers mutate `tasks.status` in place and none of them records when, so a
 * marker for "became ready" would be this tool's own invention presented as the database's evidence
 * (SPEC §4.2, trap 6).
 *
 * A marker that names no task — 32 of the 53 live gates name none — still shows. It simply does not
 * open anything, because there is nothing for it to open.
 */
function Marker({
  marker,
  axis,
  top,
  onShow,
}: {
  marker: TimelineMarker;
  axis: TimelineWindow;
  top: number;
  onShow?: () => void;
}) {
  const { icon: Icon, className, noun } = MARKERS[marker.kind];
  const label = `${noun} · ${localInstant(marker.at)}${marker.label === '' ? '' : ` · ${marker.label}`}`;

  return (
    <button
      type="button"
      data-testid="timeline-marker"
      data-kind={marker.kind}
      data-task={marker.taskId ?? undefined}
      disabled={onShow === undefined}
      onClick={onShow}
      title={label}
      aria-label={label}
      className={cn(
        'absolute flex size-4 -translate-x-1/2 items-center justify-center',
        className,
        onShow === undefined ? 'cursor-default' : 'cursor-pointer'
      )}
      style={{ left: `${placeInstant(marker.at, axis)}%`, top }}
    >
      <Icon className="size-3" />
    </button>
  );
}

/**
 * **The retry, drawn.** One task's attempts, joined across the lanes a fresh worktree scattered them
 * into — because "this was tried twice" is exactly the story `dispatch_contexts` exists to tell and
 * exactly the one the DAG's single node cannot.
 *
 * It is a line and not a colour, deliberately: the fill is already the status and the lane is already
 * the agent (SPEC §7.5), and a third colour system fighting for the same pixel is how a canvas stops
 * meaning anything. A line is a channel nothing else on this view was using.
 *
 * `preserveAspectRatio="none"` is what lets one `viewBox` hold both coordinate systems at once: `x`
 * is a percentage of the axis (0–100, stretched to the track), `y` is pixels down the scroller
 * (1:1, because the SVG's own height is the scroller's). `non-scaling-stroke` keeps the line from
 * being stretched into a smear by the same transform.
 */
function Links({
  model,
  layout,
  axis,
  selectedTaskId,
}: {
  model: TimelineModel;
  layout: Layout;
  axis: TimelineWindow;
  selectedTaskId: string | null;
}) {
  if (model.links.length === 0) return null;

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-y-0 z-10"
      style={{ left: GUTTER, right: 16, width: `calc(100% - ${GUTTER + 16}px)` }}
      height={layout.height}
      viewBox={`0 0 100 ${layout.height}`}
      preserveAspectRatio="none"
    >
      {model.links.map((link) => {
        const fromY = layout.barCentres.get(link.fromBar);
        const toY = layout.barCentres.get(link.toBar);
        if (fromY === undefined || toY === undefined) return null;

        return (
          <line
            key={`${link.fromBar}->${link.toBar}`}
            data-testid="attempt-link"
            data-task={link.taskId}
            x1={placeInstant(link.fromAt, axis)}
            y1={fromY}
            x2={placeInstant(link.toAt, axis)}
            y2={toY}
            stroke="var(--muted-foreground)"
            strokeWidth={1}
            strokeDasharray="3 2"
            vectorEffect="non-scaling-stroke"
            opacity={link.taskId === selectedTaskId ? 0.9 : 0.4}
          />
        );
      })}
    </svg>
  );
}

/**
 * **What an axis cannot hold, a list still can** (issue #72 AC 4).
 *
 * A task with no readable dispatch instant cannot be *placed* — the only number available would be
 * zero, and a 1970 bar at the far left of every run is the ghost this whole roadmap refuses. What it
 * must not lose is its **existence**: it is here, it says which of the two absences it suffered, and
 * it still opens the inspector.
 *
 * Below it, the attempts that could not be placed even though their *task* could. They are counted
 * rather than listed, because the task they belong to is already on the axis above and the inspector
 * lists every attempt it has with its own instants — but a retry that vanished without a word would
 * be the silent loss this feature exists to prevent, so the number is said.
 */
function Untimed({ model, onShowTask }: { model: TimelineModel; onShowTask: (taskId: string) => void }) {
  const { untimed, unplacedAttempts } = model;
  if (untimed.length === 0 && unplacedAttempts === 0) return null;

  return (
    <section
      data-testid="untimed"
      aria-label="Tasks with no readable dispatch instant"
      className="border-panel-border/70 max-h-32 shrink-0 overflow-y-auto border-t px-4 py-2.5"
    >
      <h3 className={cn(PANEL_TITLE_CLASS, 'mb-1.5')}>Untimed · {untimed.length}</h3>

      <ul className="flex flex-wrap gap-1.5">
        {untimed.map(({ task, reason }) => (
          <li key={task.id}>
            <button
              type="button"
              data-testid="untimed-task"
              data-task={task.id}
              data-reason={reason}
              onClick={() => onShowTask(task.id)}
              title={`${task.title} — ${reason}`}
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]',
                themeOf(task.status).surface
              )}
            >
              <span className="max-w-40 truncate font-medium">{task.title}</span>
              <span className="opacity-70">{reason}</span>
            </button>
          </li>
        ))}
      </ul>

      {unplacedAttempts > 0 && (
        <p data-testid="unplaced-attempts" className="text-muted-foreground/80 mt-1.5 text-[11px]">
          {unplacedAttempts} {unplacedAttempts === 1 ? 'attempt' : 'attempts'} of{' '}
          {unplacedAttempts === 1 ? 'a task' : 'tasks'} drawn above could not be placed — no readable dispatch instant.
          The inspector lists {unplacedAttempts === 1 ? 'it' : 'them'}.
        </p>
      )}
    </section>
  );
}

/**
 * A run with nothing to place. It is not an error and it is not empty of *history* — it is a run
 * whose dispatch rows carry no readable instant, or one that was never dispatched at all — so it
 * says which, rather than showing a blank axis that reads as a bug.
 */
function Empty() {
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <p data-testid="timeline-empty" className="text-muted-foreground max-w-sm text-center text-xs text-balance">
        Nothing in this run carries a readable dispatch instant, so there is no clock to draw it
        against. Its tasks are below, and each one still opens.
      </p>
    </div>
  );
}

/** A tick on the axis, in the reader's own timezone — the wire is UTC and nobody reads one in UTC. */
function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
