import { agentOfTurn, type DurationObservation, type RunSnapshot, type Task } from '../../shared/types.ts';

/**
 * **The dispatch timeline** (#72, SPEC §12.4) — one selected run, read along the clock.
 *
 * The DAG answers *what depended on what*. This answers the two questions it structurally cannot:
 * **who was working when**, and **how many times we had to ask**. Both are already in the file —
 * `dispatch_contexts` is one row per *attempt*, and it is the only genuinely append-only history
 * the schema has (SPEC §4.2) — and neither has ever had an axis to be drawn against.
 *
 * ## It reads the selected-run snapshot, and nothing else
 *
 * No new endpoint, and that is a consequence rather than a shortcut. ADR 0002 made the selected run
 * **complete** — every task, every attempt, every gate, the whole conversation, never windowed and
 * never truncated — which is exactly why SPEC §12.4 can say *"every retained dispatch attempt is a
 * separate bar **because** the selected-run snapshot is complete and attempts are already the retry
 * record."* A second server-side derivation of the same rows would be a second copy of a truth that
 * can disagree with the first, which is the mistake `GET /api/task/:id` was cured of when its
 * message list was deleted (SPEC §6.4).
 *
 * ## The one rule: no instant is invented
 *
 * Everything below is a consequence of it.
 *
 * - **A bar needs a readable dispatch instant, and that is *all* it needs.** That is the only thing
 *   that puts a rectangle at a place on an axis. An attempt without one cannot be drawn anywhere —
 *   the only number available would be `0`, and a 1970 bar at the far left of every run is precisely
 *   the ghost `instantOf` returns null to prevent (`server/time.ts`).
 * - **A bar's *extent* is whatever the evidence can carry, and there are three of them** — because
 *   two acceptance criteria only meet here. "Every retained attempt is a separate bar" forbids
 *   dropping the attempt that failed without recording when; #66 forbids saying "so far" about a
 *   worker who has already gone home ("a clock ticking against nobody"). So an attempt that stopped
 *   without saying when is drawn at the instant it *was* dispatched and claims **no end at all**
 *   (`unended`) — it is neither hidden nor narrated.
 * - **A marker is a recorded instant or it is nothing.** `tasks.status` transitions are not recorded
 *   — six writers mutate the column in place and the `pending → ready` promotion is silent and
 *   untimestamped (SPEC §4.2, trap 6) — so they are not on here, and no amount of "it obviously
 *   became ready before it was dispatched" makes them so.
 * - **A task that cannot be placed keeps its story.** It loses its *position*, not its existence:
 *   the untimed list holds it, says why, and still opens the inspector.
 *
 * Pure — a snapshot in, a model out, no React and no clock. The wall clock touches only the *words*
 * on an open bar ("so far", via `<Duration>`), never the geometry, so a page of finished runs holds
 * perfectly still (SPEC §7.9) and a live one re-scales nothing under the reader.
 */

/** The lane for work no agent was spawned for. Not a handle, so it can never collide with one. */
export const UNASSIGNED_LANE = '@unassigned';

/**
 * What it is called on screen, and the name is the whole point of the AC: two different true things
 * come out here — nobody was assigned, or the orchestrator kept the work — and neither of them is
 * an agent. Naming the lane after what it *is* stops it reading as a nameless third agent.
 */
export const UNASSIGNED_LABEL = 'Unassigned · orchestrator';

/**
 * How far a bar reaches, in the only three shapes the retained evidence can support.
 *
 * `closed` is an attempt whose row carries both instants. `open` is one the file still says is out
 * (`status = 'dispatched'`, no completion) — the client ages it as "so far" against its own wall
 * clock. `unended` is the honest third: dispatched, no longer running, and the row never recorded
 * when it stopped.
 */
export type BarExtent =
  | { kind: 'closed'; startAt: string; endAt: string }
  | { kind: 'open'; startAt: string }
  | { kind: 'unended'; startAt: string };

/** One retained dispatch attempt, placed. */
export type TimelineBar = {
  /** The `dispatch_contexts` row's own id — one bar *is* one attempt row. */
  id: string;
  taskId: string;
  title: string;
  /** The **task's** status, so a bar is the colour its node is (`canvas/theme.ts`). */
  status: string;
  /** 1-based, over **every** retained attempt — not over the ones that could be placed. */
  attemptIndex: number;
  attemptCount: number;
  assigneeHandle: string | null;
  extent: BarExtent;
  /** The attempt's own clock, straight off the wire (#66). Absent ⇒ the bar states no duration. */
  duration?: DurationObservation;
  /** The packed sub-row inside its lane: an agent holding two tasks at once overlaps itself. */
  row: number;
};

/** A recorded instant, on the lane of whoever the evidence says it belongs to. */
export type TimelineMarker = {
  id: string;
  kind: 'gate' | 'escalation' | 'completion';
  at: string;
  taskId: string | null;
  /** What it says on hover — the question, the subject, or the task that was recorded complete. */
  label: string;
};

export type TimelineLane = {
  /** The agent's handle, or `UNASSIGNED_LANE`. */
  key: string;
  kind: 'agent' | 'unassigned';
  label: string;
  handle: string | null;
  /** `A1`, `A2` — **the server's** monogram (SPEC §4.3a). A second numbering would be a second cast. */
  monogram: string | null;
  bars: TimelineBar[];
  markers: TimelineMarker[];
  /** How many sub-rows the packing needed. Never below 1: an empty lane is still a lane. */
  rows: number;
};

/** Why a task has no bar. Both are absences of evidence, and they are different absences. */
export type UntimedReason = 'never dispatched' | 'no readable dispatch instant';

export type UntimedTask = { task: Task; reason: UntimedReason };

/** The axis, in epoch milliseconds. Null ⇒ nothing in this run could be placed at all. */
export type TimelineWindow = { startAt: number; endAt: number };

/**
 * One task's attempts, related across the lanes a retry scattered them into.
 *
 * Anchored on **two instants the schema really retains**: the earlier attempt's end where it has
 * one, its dispatch where it does not, and the later attempt's dispatch. It never leans on an end
 * the file never recorded, which is what keeps a line that *says* "then we tried again" from
 * quietly asserting *when* the first try stopped.
 */
export type TimelineLink = {
  taskId: string;
  fromAt: string;
  toAt: string;
  /** The two attempt rows it joins — the renderer needs their packed positions, not just their lanes. */
  fromBar: string;
  toBar: string;
  fromLane: string;
  toLane: string;
};

export type TimelineModel = {
  lanes: TimelineLane[];
  untimed: UntimedTask[];
  links: TimelineLink[];
  window: TimelineWindow | null;
  /**
   * Attempts of tasks that *are* on the axis but which could not themselves be placed. The task is
   * not untimed — its other attempts are drawn — so nothing above says these exist, and a retry
   * that vanished without a word is the silent loss this feature exists to prevent. Counted, and
   * said out loud under the untimed list.
   */
  unplacedAttempts: number;
};

/** The instant a normalized wire string names, or null — `server/time.ts`'s rule, client-side. */
function instantOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

/**
 * The extent an attempt's retained evidence can carry.
 *
 * The observation is the server's (`server/durations.ts`), and it is trusted for what it *asserts*
 * — never for what it omits: its absence means "no honest span", which for a bar means "no honest
 * end", and the attempt is still dispatched at an instant this row records.
 */
function extentOf(startAt: string, duration: DurationObservation | undefined): BarExtent {
  if (duration === undefined) return { kind: 'unended', startAt };
  if (!duration.complete) return { kind: 'open', startAt };

  // Defence, not policy: the server never writes a backwards or unreadable closed observation, so
  // a wire that carries one is one this build did not write — and a bar drawn from it would run
  // backwards across the axis. It reverts to the shape that claims least.
  const end = instantOf(duration.endAt);
  const start = instantOf(startAt);
  if (end === null || start === null || end < start) return { kind: 'unended', startAt };

  return { kind: 'closed', startAt, endAt: duration.endAt! };
}

/** The instant a bar's extent *ends* at, when the file says — otherwise the one it began at. */
function endsAt(extent: BarExtent): string {
  return extent.kind === 'closed' ? extent.endAt : extent.startAt;
}

type LaneDraft = TimelineLane & { key: string };

export function deriveTimeline(snapshot: RunSnapshot): TimelineModel {
  const { run, tasks, attempts, gates, turns } = snapshot;

  // One lane per cast member, in the cast's own order — an agent whose every attempt is unplaceable
  // still has a lane, because the cast is a fact about the *run* and not about the axis.
  const lanes = new Map<string, LaneDraft>(
    run.cast.map((member) => [
      member.handle,
      {
        key: member.handle,
        kind: 'agent' as const,
        label: member.monogram,
        handle: member.handle,
        monogram: member.monogram,
        bars: [],
        markers: [],
        rows: 1,
      },
    ])
  );

  /**
   * The lane for work no *agent* holds — created only if something lands in it. Three true things
   * arrive here and all three belong: the attempt names no assignee, the assignee is a handle this
   * run's cast never had, or the orchestrator dispatched the work to **itself** (a coordinator is
   * never in its own cast — SPEC §4.3a). In none of them was an agent spawned.
   *
   * Standing it up empty would be furniture: a row on screen asserting a distinction the run does
   * not have.
   */
  function unassigned(): LaneDraft {
    const existing = lanes.get(UNASSIGNED_LANE);
    if (existing) return existing;

    const lane: LaneDraft = {
      key: UNASSIGNED_LANE,
      kind: 'unassigned',
      label: UNASSIGNED_LABEL,
      handle: null,
      monogram: null,
      bars: [],
      markers: [],
      rows: 1,
    };
    lanes.set(UNASSIGNED_LANE, lane);
    return lane;
  }

  /** An agent's lane if the cast knows the handle; otherwise the lane for work no agent holds. */
  function laneFor(handle: string | null | undefined): LaneDraft {
    const lane = handle ? lanes.get(handle) : undefined;
    return lane ?? unassigned();
  }

  const untimed: UntimedTask[] = [];
  const links: TimelineLink[] = [];
  let unplacedAttempts = 0;

  /**
   * The lane a task's *work* last stood on — where its markers go.
   *
   * Read from the attempts the bars were built out of, and deliberately **not** from `Task.dispatch`:
   * that is the same row seen twice (`MAX(rowid)` of the very list above), and a marker that laned
   * itself off the second copy could contradict the bar it is sitting on. One reading, one lane.
   */
  const laneOfTask = new Map<string, LaneDraft>();

  for (const task of tasks) {
    const retained = attempts[task.id] ?? [];
    const placed: { bar: TimelineBar; lane: string }[] = [];

    retained.forEach((attempt, index) => {
      // The whole of placement: an instant to stand at. `dispatched_at` falls back to the row's
      // `created_at` at the query boundary (`server/tasks.ts`), so this is already the strongest
      // start the row has.
      if (instantOf(attempt.dispatchedAt) === null) {
        unplacedAttempts++;
        return;
      }

      const lane = laneFor(attempt.assigneeHandle);
      const bar: TimelineBar = {
        id: attempt.id,
        taskId: task.id,
        title: task.title,
        status: task.status,
        attemptIndex: index + 1,
        attemptCount: retained.length,
        assigneeHandle: attempt.assigneeHandle === '' ? null : attempt.assigneeHandle,
        extent: extentOf(attempt.dispatchedAt, attempt.duration),
        row: 0,
        ...(attempt.duration === undefined ? {} : { duration: attempt.duration }),
      };

      lane.bars.push(bar);
      placed.push({ bar, lane: lane.key });
      // The latest placed attempt wins: a task's markers belong beside the work as it last stood.
      laneOfTask.set(task.id, lane);
    });

    if (placed.length === 0) {
      // It loses its place on the axis, and nothing else. The reason is the difference between a
      // task nobody ever handed out and one whose dispatch row is unreadable — and a reader owed an
      // empty lane is owed which of the two it was.
      untimed.push({
        task,
        reason: retained.length === 0 ? 'never dispatched' : 'no readable dispatch instant',
      });
      continue;
    }

    // The retry, drawn: attempt 1 ended (or, failing that, began) *here*, and attempt 2 was
    // dispatched *there*. Two instants the rows actually carry, and a line between them.
    for (let index = 1; index < placed.length; index++) {
      const previous = placed[index - 1]!;
      const next = placed[index]!;
      links.push({
        taskId: task.id,
        fromAt: endsAt(previous.bar.extent),
        toAt: next.bar.extent.startAt,
        fromBar: previous.bar.id,
        toBar: next.bar.id,
        fromLane: previous.lane,
        toLane: next.lane,
      });
    }
  }

  /**
   * The lane a marker belongs on: the one its task's work last stood on.
   *
   * A marker whose task nothing placed — a gate that names no task (32 of the 53 live ones name
   * none, SPEC §7.9), or one whose task the timeline could not put on the axis — belongs to no
   * agent. Nothing in the schema says whose work it was, so it goes where the run's own unowned
   * evidence goes rather than into an agent's lane on a guess.
   */
  function laneOfMarker(taskId: string | null): LaneDraft {
    const lane = taskId === null ? undefined : laneOfTask.get(taskId);
    return lane ?? unassigned();
  }

  // The markers, in the order a reader meets them: the questions that stopped the work, the
  // trouble that was reported, and the receipts. Each one is a column with an instant in it, and
  // a column with no readable instant produces nothing at all.
  for (const gate of gates) {
    if (instantOf(gate.createdAt) === null) continue;
    laneOfMarker(gate.taskId).markers.push({
      id: `gate:${gate.id}`,
      kind: 'gate',
      at: gate.createdAt,
      taskId: gate.taskId,
      label: gate.question,
    });
  }

  for (const turn of turns) {
    // A selected-run snapshot carries the turns nothing places (SPEC §4.4, rule 3) so that they stay
    // reachable, attached to nobody. They are nobody's lane: an escalation the *server* refused to
    // attribute must not be quietly attributed here.
    if (turn.kind !== 'escalation' || turn.runId !== run.id) continue;
    if (instantOf(turn.at) === null) continue;

    laneFor(agentOfTurn(turn)).markers.push({
      id: `escalation:${turn.id}`,
      kind: 'escalation',
      at: turn.at,
      taskId: turn.taskId,
      label: turn.subject,
    });
  }

  for (const task of tasks) {
    if (instantOf(task.completedAt) === null) continue;

    // `tasks.completed_at` is a different column, written by a different writer, than the attempt's
    // own `completed_at` (SPEC §4.2, trap 5) — so this marker is not the bar's right edge repeated,
    // and where the two disagree, seeing both is the point.
    laneOfMarker(task.id).markers.push({
      id: `completion:${task.id}`,
      kind: 'completion',
      at: task.completedAt!,
      taskId: task.id,
      label: task.title,
    });
  }

  const ordered = [...lanes.values()];
  for (const lane of ordered) {
    lane.bars.sort((left, right) => instantOf(left.extent.startAt)! - instantOf(right.extent.startAt)!);
    lane.markers.sort((left, right) => instantOf(left.at)! - instantOf(right.at)!);
  }

  const window = windowOf(ordered);
  for (const lane of ordered) lane.rows = pack(lane.bars, window);

  return { lanes: ordered, untimed, links, window, unplacedAttempts };
}

/**
 * The axis: **the retained instants, and not one more.** The wall clock is not consulted — a window
 * that grew every second would re-scale every bar on the page under a reader who was reading them,
 * and an open bar has a better way to say it is still going (it runs to the edge, and its label
 * counts up).
 *
 * A task's *creation* is deliberately not on it. This is a **dispatch** timeline; a task that was
 * created and never handed out has no dispatch instant, and stretching the axis back to reach it
 * would silently widen every run by its queue time.
 */
function windowOf(lanes: TimelineLane[]): TimelineWindow | null {
  let start: number | null = null;
  let end: number | null = null;

  const see = (at: number): void => {
    if (start === null || at < start) start = at;
    if (end === null || at > end) end = at;
  };

  for (const lane of lanes) {
    for (const bar of lane.bars) {
      see(instantOf(bar.extent.startAt)!);
      if (bar.extent.kind === 'closed') see(instantOf(bar.extent.endAt)!);
    }
    for (const marker of lane.markers) see(instantOf(marker.at)!);
  }

  if (start === null || end === null) return null;

  // One instant is not a span, and dividing by its zero width would put every bar at NaN%. A run
  // whose whole retained history is a single instant gets a minute of axis to draw it on.
  return { startAt: start, endAt: end > start ? end : start + MIN_WINDOW_MS };
}

/** The axis a run gets when every instant it retains is the same instant. */
const MIN_WINDOW_MS = 60_000;

/**
 * Greedy sub-row packing inside one lane. An agent can hold two tasks at once, and two bars drawn
 * over each other is one bar you can read and one you cannot — so the lane grows a row rather than
 * hiding the work.
 *
 * An `open` bar reaches the end of the axis (it has not finished), and an `unended` one occupies
 * only the instant it was dispatched at (the file says nothing else). Bars arrive sorted by start.
 */
function pack(bars: TimelineBar[], window: TimelineWindow | null): number {
  if (window === null || bars.length === 0) return 1;

  const rowEnds: number[] = [];

  for (const bar of bars) {
    const start = instantOf(bar.extent.startAt)!;
    const end = bar.extent.kind === 'closed' ? instantOf(bar.extent.endAt)! : bar.extent.kind === 'open' ? window.endAt : start;

    const row = rowEnds.findIndex((occupied) => occupied <= start);
    if (row === -1) {
      bar.row = rowEnds.length;
      rowEnds.push(end);
    } else {
      bar.row = row;
      rowEnds[row] = end;
    }
  }

  return Math.max(1, rowEnds.length);
}

/** Where a bar sits on the axis, as percentages — the one piece of geometry, said once. */
export function placeBar(extent: BarExtent, window: TimelineWindow): { left: number; width: number } {
  const span = window.endAt - window.startAt;
  const start = instantOf(extent.startAt)!;
  const end = extent.kind === 'closed' ? instantOf(extent.endAt)! : extent.kind === 'open' ? window.endAt : start;

  return {
    left: ((start - window.startAt) / span) * 100,
    width: ((end - start) / span) * 100,
  };
}

/** Where an instant sits on the axis, as a percentage — a marker, and a link's two ends. */
export function placeInstant(at: string, window: TimelineWindow): number {
  const span = window.endAt - window.startAt;
  return ((instantOf(at)! - window.startAt) / span) * 100;
}
