/**
 * The wire contract between the server and the browser — the locked payload of #12
 * (SPEC §6.3), transcribed here verbatim. It is the *only* thing the client is fed, which
 * is what makes `<App>` testable against a canned event and the two seams impossible to
 * drift apart.
 *
 * #14 fills `meta` for real and ships the arrays empty; #15–#22 fill the arrays. The types
 * are complete from the start so the tickets that follow have a contract to build against
 * rather than one to negotiate.
 */

/** Orca's own enums (HANDOFF.md). Unknown values pass through verbatim — never dropped. */

/**
 * The six task statuses, as a value, because two of them have to be *enumerated* and not just
 * type-checked: the per-status tally seeds a zero for each, and the node colours key off each.
 * Deriving the type from the list keeps one source of truth — an Orca that adds a seventh is
 * then a compile error in the colour table rather than a status that silently renders nowhere.
 */
export const TASK_STATUSES = ['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type DispatchStatus = 'pending' | 'dispatched' | 'completed' | 'failed' | 'circuit_broken';
export type MessageType =
  | 'status'
  | 'dispatch'
  | 'worker_done'
  | 'merge_ready'
  | 'escalation'
  | 'handoff'
  | 'decision_gate'
  | 'heartbeat';
export type CoordinatorStatus = 'idle' | 'running' | 'completed' | 'failed';

/** How the file's `PRAGMA user_version` compares to the version we were built against. */
export type SchemaSupport = 'supported' | 'newer' | 'older';

/**
 * Is the data live or last-known? Re-derived every tick from `orca-runtime.json` plus
 * `process.kill(pid, 0)` — never by spawning the `orca` CLI, which dies with the app and
 * would take post-mortem reads down with it (SPEC §2.1).
 */
export type Liveness = 'live' | 'stale' | 'unknown';

export type Meta = {
  dbPath: string;
  /** `PRAGMA user_version`. */
  schemaVersion: number;
  schemaSupport: SchemaSupport;
  /** Features a missing column disabled, phrased for a human (SPEC §5). */
  degraded: string[];
  liveness: Liveness;
  orcaPid: number | null;
  /** ISO — powers the "showing last-known state from …" wording. */
  dbMtime: string;
  /** A `sqlite_sequence` gap: someone ran `orchestration reset` (SPEC §5). */
  resetDetected: boolean;
};

/**
 * Which retained columns a duration observation read — its provenance, on the wire and on the
 * screen (SPEC §12.4, #66).
 *
 * - `dispatch` — one attempt's own `dispatch_contexts.dispatched_at → completed_at`. The
 *   preferred clock: it measures the worker's attempt, not task setup time.
 * - `task-span` — `tasks.created_at → completed_at`. A visibly labelled fallback for a completed
 *   task with no completed dispatch clock; never presented as dispatch time.
 * - `run-span` — earliest readable task creation to latest readable completion/creation. It is
 *   wall-clock occupancy, not summed agent time.
 */
export type DurationClock = 'dispatch' | 'task-span' | 'run-span';

/**
 * A wall-clock span this tool can actually stand behind — and **absence is the honest value**:
 * a missing, unreadable, negative or contradictory endpoint produces no observation at all,
 * never a zero, an epoch date or a negative interval (SPEC §12.4).
 *
 * An *open* interval (`complete: false`) carries a start and no end. The client ages it against
 * its own wall clock as "so far" — advancing without waiting for an SSE push, and stopping the
 * moment a push carries the completion evidence — because a server-derived number for a still-
 * running attempt would be stale the second after it was computed.
 */
export type DurationObservation = {
  clock: DurationClock;
  /** ISO — readable by construction, or there is no observation. */
  startAt: string;
  /** ISO. Absent ⇒ the interval is still open per retained evidence. */
  endAt?: string;
  complete: boolean;
  /** `endAt − startAt`, present only when complete — it must agree with the endpoints it rides with. */
  ms?: number;
};

/**
 * One agent an orchestrator spawned — a terminal that was dispatched at least one of its tasks
 * (SPEC §4.3a). Derived from the `assignee_handle`s of that orchestrator's dispatch contexts,
 * which is the only place in the schema that records who did the work.
 */
export type CastMember = {
  /** The worker's `dispatch_contexts.assignee_handle`. Its identity, and its only one. */
  handle: string;
  /**
   * `A1`, `A2`, `A3` — the agent's name on screen, in first-dispatch order within its run.
   *
   * The handle is a uuid nobody can read or hold in their head, and the node has room for one
   * badge. The monogram is what makes "the failed node and the gate are the same agent" a thing
   * you can *see*, and it is the server's so that the rail, the canvas and the conversation
   * cannot each number the cast differently.
   */
  monogram: string;
  /** **Every** task it ever held, including ones a later attempt re-dispatched to someone else. */
  taskIds: string[];
  taskCount: number;
  /** The latest heartbeat across its dispatches — the rail's "last seen 12s ago" (SPEC §4.6). */
  lastHeartbeatAt: string | null;
};

/**
 * A burst of work, and the silence in front of it (SPEC §4.3).
 *
 * The six-hour idle gap used to decide a run's *identity*: one terminal, reused across four
 * days, silently became several unrelated rows in the rail and nothing on screen ever said why.
 * It is now a **visible grouping inside one orchestrator**: the canvas draws each wave in its own
 * bordered region, captioned with the gap that opened it. The rule is the same rule
 * (`IDLE_GAP_MS`); what changed is that it is *shown* rather than *imposed*.
 */
export type Wave = {
  /** 1-based — the caption reads "Wave 2". */
  index: number;
  startedAt: string;
  endedAt: string;
  taskIds: string[];
  /** How long the terminal was quiet before this wave began. Null on the first: nothing precedes it. */
  idleGapBeforeMs: number | null;
};

/**
 * **An orchestrator, and everything it dispatched.**
 *
 * One row per `created_by_terminal_handle` — a Claude Code session that was told to coordinate.
 * The name on the wire is still `Run` (a run *is* an orchestrator's run, and `Task.runId` /
 * `FeedMessage.runId` are the joins the whole client is built on), but the thing it names has
 * changed and the rail says the new word: **Orchestrators**, not "Runs (inferred)".
 *
 * Nothing about the grouping is inferred any more. The column says which terminal created a task;
 * that is not a guess. What *was* the guess — the six-hour split that silently ended a run — is now
 * `waves`, drawn on the canvas with the gap that caused it written on it (SPEC §4.3).
 */
export type Run = {
  /**
   * `run_<handle>`, or `run_unattributed`.
   *
   * Keyed on the handle **alone**: the id must be the same across restarts (a rail that cannot
   * hold a selection across a reboot is a rail you cannot use for history) and it must not
   * change when the orchestrator dispatches its next task — which the old `_<epoch>` suffix,
   * taken from the first task of a six-hour segment, could not promise.
   */
  id: string;
  /** The full `created_by_terminal_handle` — the orchestrator itself. Null on the synthetic run. */
  handle: string | null;
  label: string;
  startedAt: string;
  endedAt: string;
  taskCount: number;
  /** The agents this orchestrator spawned, in first-dispatch order (`cast.ts`). */
  cast: CastMember[];
  /** Bursts of work separated by more than six idle hours. Always at least one (SPEC §4.3). */
  waves: Wave[];
  /**
   * The six known statuses are always present, at 0 when the run has none of them. An
   * unknown status counts under its own raw name rather than being dropped — the same
   * verbatim rule `Task.status` follows (SPEC §5), because a task missing from the tally is
   * a task the rail lies about.
   */
  statusCounts: Record<TaskStatus | string, number>;
  live: boolean;
  hasOpenGates: boolean;
  /** 0 ⇒ the edgeless empty state (SPEC §7.5). */
  edgeCount: number;
  /**
   * The run's wall-clock span (`run-span`): earliest readable task creation to latest readable
   * completion/creation — open while the run is live. Absent when no task creation is readable.
   */
  duration?: DurationObservation;
};

/** The latest dispatch attempt — `MAX(rowid)` for the task, as Orca's own queries do. */
export type Dispatch = {
  id: string;
  assigneeHandle: string;
  status: DispatchStatus | string;
  failureCount: number;
  lastFailure: string | null;
  dispatchedAt: string;
  completedAt: string | null;
  lastHeartbeatAt: string | null;
  /** This attempt's own clock (`dispatch`). Absent when its endpoints cannot support one. */
  duration?: DurationObservation;
};

/**
 * A decision blocking an orchestration — **derived from `decision_gate` messages, never from
 * the `decision_gates` table** (SPEC §4.5, and the trap in §4.2 that the whole of #19 is).
 *
 * The locked shape of #12 is `{ messageId, question, options, status, resolution }`, and every
 * one of those fields means exactly what it did. Four things are added to it, and each of them
 * is a thing the locked rulings *require* and the locked shape had nowhere to put:
 *
 * - **`runId` / `taskId`.** "A gate with a `payload.taskId` attaches to that task; one without
 *   attaches to its **run** and to **no node**." A gate is therefore not always a *task's*
 *   gate — but the strip has to show it anyway, so it needs a home on the wire that a task
 *   field cannot give it. They follow `FeedMessage`'s two fields exactly, and for the same
 *   reason: both are answers to "where does this belong", and both are null when the schema
 *   does not say (SPEC §4.4, rule 3).
 * - **`id`.** Identity, for a list the client renders and keys. `messageId` cannot serve: the
 *   additive `decision_gates` merge produces gates that no message ever carried.
 * - …which is also why **`messageId` is nullable** — null is precisely "this gate exists only
 *   as a table row". It is never null for a gate a real `orchestration.ask` created.
 * - **`createdAt`.** When it was asked. The strip shows the oldest blocker first, and a gate
 *   with no instant cannot be ordered against one that has one.
 */
export type Gate = {
  /** The gate message's id, or — for a table-only gate — the `decision_gates` row's. */
  id: string;
  /** The `decision_gate` message that asked it. Null when only the gate table knows about it. */
  messageId: string | null;
  /** The run it blocks. Null when nothing in the schema says which one. */
  runId: string | null;
  /** The task it blocks, when it names one that still exists. Null ⇒ it marks no node. */
  taskId: string | null;
  question: string;
  options: string[];
  /** Resolved ⇔ a reply threads on the gate message's id. There is no third state (SPEC §4.2, trap 9). */
  status: 'open' | 'resolved';
  /** The reply's body. Null while the gate is open. */
  resolution: string | null;
  /** Normalized to ISO, like every other instant on the wire. */
  createdAt: string;
};

export type Task = {
  id: string;
  runId: string;
  parentId: string | null;
  title: string;
  status: TaskStatus | string;
  /** The DAG edges, parsed out of the JSON string column. */
  deps: string[];
  /** Normalized to ISO — the client never sees Orca's split timestamp formats. */
  createdAt: string;
  completedAt: string | null;
  /** The bodies are omitted from the snapshot; `GET /api/task/:id` fetches them on click. */
  hasSpec: boolean;
  hasResult: boolean;
  dispatch: Dispatch | null;
  /** > 1 ⇒ this task was retried. */
  attemptCount: number;
  /**
   * How long the work took, on the strongest complete clock the task retains: the latest
   * attempt's `dispatch` clock, else a visibly labelled `task-span`, else the open interval
   * still running. Absent ⇒ the evidence supports no number at all (#66).
   */
  duration?: DurationObservation;
  /**
   * The gate this node wears: the open one it is blocked on, or — when nothing is blocking —
   * the last one it answered. A task can raise several, and `snapshot.gates` has them all; a
   * *node* has room for the one that decides its ⛔ marker (SPEC §7.5).
   */
  gate: Gate | null;
};

export type CoordinatorRun = {
  id: string;
  status: CoordinatorStatus | string;
  coordinatorHandle: string;
  pollIntervalMs: number;
  createdAt: string;
  completedAt: string | null;
};

export type FeedMessage = {
  id: string;
  sequence: number;
  type: MessageType | string;
  fromHandle: string;
  toHandle: string;
  subject: string;
  body: string;
  priority: string;
  threadId: string | null;
  payload: unknown;
  createdAt: string;
  /** `payload.taskId`, when it resolves to a task that still exists. */
  taskId: string | null;
  runId: string | null;
};

/**
 * One recognized outcome fact (#67, SPEC §12.4) — a thing a task verifiably produced, read out
 * of `tasks.result` or a `worker_done` message's `payload` by the never-throw readers in
 * `receipt.ts`.
 *
 * The kinds are this tool's, not Orca's: nothing anywhere validates either column, so a kind is
 * what the reader could *recognize*, and everything it could not stays on screen verbatim (the
 * raw result in the inspector, the raw payload beside it). Two rules are load-bearing:
 *
 * - **`link` is provider-neutral.** It means "a valid `http:`/`https:` URL" and nothing more —
 *   no provider name is ever consulted, so a GitLab review link and a Jira ticket link are the
 *   same kind of fact as a GitHub PR (#67).
 * - **`sources` is the provenance, and it is why deduplication is allowed at all.** A fact both
 *   columns stated is shown once with two sources; a fact they *disagree* on stays two facts.
 *   Erasing either would be inventing a certainty the file does not hold.
 */
export type ReceiptFact = {
  /**
   * `file` and `report` are paths — copyable text, never a claim this machine can open them.
   * `ticket` is an identifier (`ticket: 68`, `pr: 79` — the field name is in the provenance).
   * `agent` is a completing-agent field. `link` is a validated URL, whoever hosts it.
   */
  kind: 'link' | 'branch' | 'ticket' | 'agent' | 'report' | 'file';
  value: string;
  /** The column and field it was read from — `'tasks.result · branch'` — one per source that stated it. */
  sources: string[];
};

/**
 * One thing that was said — and **the reason this feature exists** (SPEC §4.7).
 *
 * **When the orchestrator dispatches an agent, it writes no message.** Orca injects the prompt
 * straight into the worker's PTY, and the live database holds **zero** `type = 'dispatch'` rows
 * (SPEC §4.2, trap 2). So a conversation built from the `messages` table alone shows agents
 * talking into the void, to an orchestrator that never answers — which is, very probably, the
 * real reason the old screen was unreadable.
 *
 * A turn is therefore **merged from four sources**, and it says which one it came from:
 *
 * | Turn | Reconstructed from |
 * |---|---|
 * | The orchestrator's prompt | `tasks.spec`, timestamped by `dispatch_contexts.dispatched_at` |
 * | The agent answering | `messages` (`status`, `worker_done`, `escalation`, …) |
 * | A question, and its answer | a `decision_gate` message, and the reply whose `thread_id` is its `id` |
 * | The final report | `tasks.result`, timestamped by `tasks.completed_at` |
 *
 * `source` is on the wire and on the screen, as a small muted caption under the bubble. This
 * project tells the truth about its derivations: a bubble that *looks* like a message the
 * orchestrator sent, when no such message was ever written, would be the most convincing lie the
 * tool could tell.
 */
export type Turn = {
  /** Stable across polls: `msg:<sequence>`, `dispatch:<contextId>`, `result:<taskId>`, `beats:<key>`. */
  id: string;
  /** The orchestrator whose conversation this is. Null ⇒ nothing in the schema places it (SPEC §4.4). */
  runId: string | null;
  /**
   * `out` — the orchestrator speaking. `in` — an agent speaking.
   *
   * Decided by **"did one of this run's agents say it?"**, not by "is the sender the coordinator":
   * the synthetic `run_unattributed` has no coordinator handle at all, and a rule that keyed on
   * one would leave every one of its turns undirected.
   */
  direction: 'out' | 'in';
  /**
   * `dispatch` | `result` | `answer` | `heartbeats` — the four this tool reconstructs — or the
   * message's own `type` verbatim (`status`, `worker_done`, `escalation`, `decision_gate`, and
   * whatever an Orca we have never seen invents: shown, never dropped — SPEC §5).
   */
  kind: string;
  fromHandle: string | null;
  toHandle: string | null;
  /** Normalized to ISO, like every instant on this wire. Empty ⇒ the column held no readable one. */
  at: string;
  taskId: string | null;
  subject: string;
  /**
   * What was said. For a `dispatch` or a `result` this is a **preview** of `tasks.spec` /
   * `tasks.result` — the bodies themselves stay in the file (SPEC §6.3), and a 400px bubble was
   * never going to show 3 KB of agent prompt anyway. `truncated` says so out loud, and the node
   * inspector is one click away with the whole of it.
   */
  body: string;
  /** The columns this turn was reconstructed from — rendered, verbatim, under the bubble. */
  source: string;

  /*
   * Everything below is **optional on the wire, and absent when it is the default**.
   *
   * A selected run's conversation is refetched whole every time a push names the run (#69) —
   * seconds apart, on a live orchestration — and it is ~360 turns on a live database.
   * `"options":[],"answer":null,"beatCount":0,"truncated":false,"endedAt":null` is 75 bytes of
   * nothing, and 75 bytes of nothing on 360 turns, refetch after refetch, is 27 KB of nothing.
   * So a field that has nothing to say does not say it.
   */

  /** True ⇒ `body` is the first `BODY_PREVIEW_CHARS` of a longer one. The inspector has the rest. */
  truncated?: boolean;
  /** A gate's options. Absent for everything that is not a gate. */
  options?: string[];
  /** A gate's answer, when one threaded on it. Absent ⇒ the question is still open. */
  answer?: string;
  /** How many beats a `heartbeats` row is standing in for. Absent on every other kind. */
  beatCount?: number;
  /** The last beat of a `heartbeats` row, so the panel can say "every ~5 min". Absent elsewhere. */
  endedAt?: string;
  /**
   * The recognized outcome facts of a `result` or `worker_done` turn (#67) — **compact**:
   * capped at `RECEIPT_PREVIEW_FACTS` and absent when nothing was recognized, for the same
   * reason `truncated` exists — this object is re-sent whole every five seconds. The node
   * inspector carries the whole receipt, merged across both sources, plus the raw evidence.
   */
  receipt?: ReceiptFact[];
  /** How many recognized facts the cap cut. Absent when it cut none. */
  receiptOmitted?: number;
};

/**
 * **The agent side of an exchange, whichever way it points** — and the key every scope narrower
 * than an orchestrator is a filter on.
 *
 * Derived rather than carried. It is always one of the two handles already on the turn, so putting
 * it on the wire would be a third copy of a uuid in an object a live run refetches seconds apart —
 * 21 KB per fetch, to save one line of arithmetic. It lives here, beside the type, so the client
 * and the server cannot answer it differently.
 */
export function agentOfTurn(turn: Turn): string | null {
  const handle = turn.direction === 'in' ? turn.fromHandle : turn.toHandle;
  return handle === null || handle === '' ? null : handle;
}

/**
 * **The invalidation notice** (`CONTEXT.md`): what changed since this client's previous event —
 * identity to refetch by, never the data itself (SPEC §12, ADR 0002, #69).
 *
 * The stream used to re-send every retained run, task and turn on every push, and the database
 * is never pruned — so the wire and the browser paid for the whole of history on every tick.
 * A push now *names* what moved instead: the client holds pages of the run index and one
 * selected-run snapshot, and this is how it knows which of those to fetch again.
 *
 * Over-invalidation is safe (a refetch of something unchanged) and under-invalidation is the
 * bug (a view that is silently stale forever), so every ambiguity here resolves toward naming
 * more, never less.
 */
export type Affected = {
  /**
   * True when the whole view may be out of date: a first connect, an SSE reconnect, and the
   * one-shot `/api/snapshot`. The server cannot know what a client it was not talking to has
   * missed — task rows are overwritten in place and leave no cursor — so it says so, and the
   * client refetches what it displays: its loaded index pages and its selected run. That is
   * bounded by what is on screen, never by the size of history.
   */
  all: boolean;
  /** Orchestrator runs whose retained evidence — summary, tasks, attempts, gates, turns — changed. */
  runIds: string[];
  /**
   * True when evidence *nothing places* changed: a turn no run could claim (SPEC §4.4, rule 3),
   * or a coordinator row naming a handle no orchestrator has. A selected-run snapshot carries
   * the unplaced turns so they stay reachable, so it goes stale when they change too.
   */
  unplaced: boolean;
};

/**
 * One page of the **run index** — `GET /api/runs` (SPEC §12, ADR 0002, #69).
 *
 * The navigation surface for retained history: the summaries the rail lists, most recently
 * active first, fifty at a time. It is deliberately the same `Run` shape the stream used to
 * carry — cast, waves and tallies are aggregates, not evidence — while everything that grows
 * with a run's *size* (tasks, attempts, gates, turns, bodies) lives in the selected-run
 * snapshot and is fetched for one run at a time.
 */
export type RunIndexPage = {
  meta: Meta;
  /** Most recently active first; deterministic id tie-break. The first page is the newest 50. */
  runs: Run[];
  /**
   * The opaque cursor "Load older history" follows — the keyset position after this page's last
   * row, stable under writes: a run that becomes active moves *ahead* of every cursor rather
   * than duplicating into a later page. Null ⇒ history ends here; there is no silent cutoff.
   */
  nextCursor: string | null;
  /** Every `coordinator_runs` row, rendered if any exist (SPEC §4.2, trap 3). Empty in practice. */
  coordinatorRuns: CoordinatorRun[];
};

/**
 * The **selected-run snapshot** — `GET /api/run/:id` (SPEC §12, ADR 0002, #69).
 *
 * The complete retained evidence for one orchestrator run, fetched as a unit: **never
 * time-windowed, never truncated**, however old or large the run is. Scaling bounded the
 * *index*; it is not allowed to weaken a post-mortem (the whole point of ADR 0002).
 */
export type RunSnapshot = {
  meta: Meta;
  run: Run;
  /** Every retained task of this run — all of them, in creation order. */
  tasks: Task[];
  /**
   * **Every dispatch attempt**, oldest first, by task id — not just the `MAX(rowid)` survivor a
   * `Task` carries. `dispatch_contexts` is the only genuinely append-only per-task history in
   * the schema, and a selected run is complete or it is not a selected run.
   */
  attempts: Record<string, Dispatch[]>;
  /** Every gate this run raised, answered ones included. */
  gates: Gate[];
  /**
   * The complete reconstructed conversation (SPEC §4.7) — this run's turns, **plus the turns
   * nothing places** (`runId: null`), in one chronological order. The unplaced turns ride along
   * because they must still appear *somewhere*, attached to nobody (SPEC §4.4, rule 3), and a
   * transport that paged them out of existence would be guessing by omission.
   */
  turns: Turn[];
  /**
   * Tasks *outside* this run that share a dependency edge with one inside it. `tasks.deps` is a
   * real edge that knows nothing about which terminal created which task, so an edge can cross
   * orchestrations — and the inspector's dep chips must be able to name the far end without
   * fetching the whole of history to find it.
   */
  linkedTasks: Task[];
  /** `coordinator_runs` rows whose handle is this orchestrator's — the evidence that belongs to it. */
  coordinatorRuns: CoordinatorRun[];
};

/**
 * **The cross-history dispatch report** — `GET /api/report` (SPEC §12.4, #70).
 *
 * One row per retained task, across every run in the database: a *ranking and search
 * instrument*, and deliberately **not** a second graph. The tool already draws one run's tasks
 * as a DAG and tells one task's story in the inspector; what it could not do was answer "which
 * task took longest", "who has the failures", "what did this fortnight produce" without
 * scanning every rail row by eye.
 *
 * Three rules hold it to the truth the rest of the wire tells:
 *
 * - **It duplicates no task-detail truth.** Every field on a row is one the server already
 *   derives for the canvas — the duration observation of #66, the receipt facts of #67, the
 *   attempts and status a `Task` carries. Selecting a row loads the ordinary selected-run
 *   snapshot and opens the ordinary inspector; the report has no detail model of its own.
 * - **A missing value stays visible, and stays filterable.** A task Orca never dispatched has
 *   no agent and no dispatch instant, and it is *in the report* saying so — stalled work is
 *   exactly what a search of history is for.
 * - **The order is total.** Sorting, filtering and paging are the server's, and the id
 *   tie-break makes the sort a total order — so two reads of an unchanged database tile into
 *   the same pages, with no row duplicated into two of them and no row dropped from both.
 */

/** The sort keys the report offers. Each one is a fact already on the row — nothing composite. */
export const REPORT_SORTS = ['dispatched', 'duration', 'attempts', 'failures', 'title'] as const;

export type ReportSort = (typeof REPORT_SORTS)[number];

export type ReportDirection = 'asc' | 'desc';

/**
 * A filter over a fact that may not be there: `missing` is a first-class answer, not the absence
 * of one. "Which tasks were never dispatched" and "which produced nothing we can recognize" are
 * the two questions a post-mortem asks most, and both are questions *about* an absence.
 */
export const REPORT_PRESENCE = ['any', 'present', 'missing'] as const;

export type ReportPresence = (typeof REPORT_PRESENCE)[number];

/** The terminal that held a task last — and what the canvas calls it. */
export type ReportAgent = {
  /** The latest attempt's `assignee_handle`. */
  handle: string;
  /**
   * `A1`, `A2` … — the run's own numbering (`cast.ts`), so a row and the canvas name one agent
   * the same way. **Null when the handle is not in the cast**: an orchestrator that worked its
   * own task is not one of the agents it spawned (SPEC §4.3a), and inventing an `A0` for it
   * would put a stranger in the cast.
   */
  monogram: string | null;
};

/** One retained task, as a row of the report. */
export type ReportRow = {
  taskId: string;
  runId: string;
  /** The rail's own label for the run, so a row names its orchestrator without a second fetch. */
  runLabel: string;
  title: string;
  status: TaskStatus | string;
  /**
   * The terminal the **latest** attempt went to. **Null is the explicit missing-dispatch
   * value** — no `dispatch_contexts` row ever named this task, which `attemptCount: 0` says
   * again from the other side. Never-dispatched work stays in the report saying so.
   */
  agent: ReportAgent | null;
  /**
   * The latest attempt's `dispatched_at`. Null when there is no attempt — or when the column
   * held nothing a clock could read, which `attemptCount` is what tells the two apart.
   */
  dispatchedAt: string | null;
  /** 0 ⇒ never dispatched. */
  attemptCount: number;
  /**
   * **The task's failures, not the sum of its retries' running totals** (SPEC §12.4).
   * `dispatch_contexts.failure_count` is *cumulative* — the circuit breaker counts up to 3 in
   * it — so adding it across attempts counts the same failure once per attempt that followed.
   * The maximum retained value is the count; the sum is the overcount this row refuses.
   */
  failureCount: number;
  /**
   * How long the work took, on the strongest clock the task retains (#66) — the same
   * observation the node badge and the inspector show. Absent ⇒ the evidence supports no
   * number, and the row says so rather than showing a zero.
   */
  duration?: DurationObservation;
  /**
   * The compact outcome summary (#67): the recognized facts of `tasks.result` and this task's
   * `worker_done` payloads, merged with provenance and **capped at `REPORT_OUTCOME_FACTS`** —
   * a row is a row. Absent ⇒ nothing was recognized, which is what the `outcome=missing` filter
   * selects. The inspector holds the uncapped receipt and the raw evidence beside it.
   */
  outcome?: ReceiptFact[];
  /** How many recognized facts the cap cut. Absent when it cut none. */
  outcomeOmitted?: number;
};

/**
 * One page of the report — `GET /api/report` (#70).
 *
 * Paginated on the server, independently of the run index (SPEC §12.4): the report ranks *tasks*
 * across history, and a database that is never pruned would otherwise make it grow without bound.
 */
export type ReportPage = {
  meta: Meta;
  /** This page's rows, in the requested order. The first page is the newest `REPORT_PAGE_SIZE`. */
  rows: ReportRow[];
  /**
   * The opaque keyset cursor the next page follows — the ordering position after this page's
   * last row. Null ⇒ the filtered history ends here. A cursor is minted for one sort and one
   * direction, and a request that changes either is refused rather than silently re-anchored.
   */
  nextCursor: string | null;
  /** How many rows the filters matched, across every page — the count the header reports. */
  total: number;
};

/**
 * What clicking a node fetches — `GET /api/task/:id`, and the only payload in this tool that
 * is not a `StreamEvent` (SPEC §6.4, §7.8).
 *
 * It exists because of two deliberate absences in the snapshot, and it is exactly their inverse:
 *
 * - **The bodies.** `spec` and `result` are omitted from every snapshot — a live 71-task dump
 *   was 172 KB, almost entirely spec text (SPEC §6.3). The snapshot says whether they exist
 *   (`hasSpec` / `hasResult`); this says what they are, once, for the one task you asked about.
 * - **The attempts.** A snapshot task carries the *latest* dispatch (`MAX(rowid)`) plus
 *   `attemptCount`. This carries **all** of them, in `rowid` order — `dispatch_contexts` is the
 *   only genuinely append-only per-task history in this schema, and the retry and
 *   circuit-breaker story is not visible anywhere else (SPEC §7.5, §7.8).
 *
 * What is *not* here is as considered: the gate Q&A, the dependencies **and now the messages**
 * are already in the selected-run snapshot. Its `gates` carry every gate — answered ones
 * included — with the task it blocks (#19), `Task.deps` carries the edges, and its `turns`
 * carry this task's whole exchange, *both sides of it*, filtered by `taskId`. Re-sending any of
 * them would be a second copy that could disagree with the first — which is why the flat
 * `messages` list that used to live here is gone: it was the weaker half of a conversation the
 * wire now carries whole.
 */
/**
 * One `worker_done` message that named this task — the second evidence source an outcome has
 * (#67), kept whole and raw.
 *
 * `payload` is the TEXT column **verbatim** — the bytes the worker wrote, not a parse of
 * them. A `JSON.parse → stringify` round trip looks the same and is not: it silently
 * collapses a duplicated key, reformats a number, and re-orders nothing you can prove. The
 * readers parse a *copy* to recognize facts; what reaches the screen is the evidence itself,
 * which is the only rendering the word "verbatim" allows (SPEC §12.4).
 */
export type WorkerCompletion = {
  /** The message's own id — real, Orca-written, and so copyable (SPEC §7.9). */
  messageId: string;
  /** When it was sent. ISO, like every instant on this wire. */
  at: string;
  /** The `messages.payload` column, exactly as written. */
  payload: string;
};

export type TaskDetail = {
  id: string;
  /** The prompt the agent was dispatched with. Null when the task has none. */
  spec: string | null;
  /** What came back. Null while the task is still working, or if it never reported. */
  result: string | null;
  /** **Every** dispatch attempt, oldest first — never just the latest one. */
  attempts: Dispatch[];
  /**
   * The whole outcome receipt (#67): every recognized fact from both evidence sources —
   * `tasks.result` and the completions below — merged with provenance. Agreement is one fact
   * wearing two sources; conflict stays two facts. The conversation carries a capped preview
   * of the same reading (`Turn.receipt`); this is the uncapped one.
   */
  receipt: ReceiptFact[];
  /** Every `worker_done` message that named this task, oldest first, payloads raw. */
  completions: WorkerCompletion[];
};

/**
 * One event type: first connect, normal tick and SSE reconnect all have this shape, so
 * there is no separate resync path to get wrong (SPEC §6.2).
 *
 * It used to carry the whole of retained history — every run, task, gate and turn, re-sent on
 * every push — and the database is never pruned, so that payload grew without bound (§12.1).
 * The event is now the **doorbell**: `affected` names what moved, and the data lives behind
 * `GET /api/runs` (the paged index) and `GET /api/run/:id` (one run, complete), fetched for
 * what is actually on screen (#69, ADR 0002).
 */
export type StreamEvent = {
  /** The message high-water mark — also the SSE event id. */
  seq: number;
  meta: Meta;
  /**
   * What this push means the client should fetch again (#69): run ids on a tick, `all` on a
   * connect or reconnect.
   */
  affected: Affected;
  /**
   * The messages that arrived after the client's last-seen sequence — the lossless delta a
   * reconnect replays via `Last-Event-ID`, and empty on a *first* connect, where nothing was
   * missed and the history behind it is the endpoints' to serve.
   *
   * The **conversation** is the selected-run snapshot's `turns`, not this: a feed of messages
   * is exactly the half of the dialogue that got written down (SPEC §4.7). What this is for is
   * the one thing a snapshot cannot say — *what just arrived* — which is what flashes a node
   * (SPEC §7.6).
   */
  messages: FeedMessage[];
};
