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
   * Everything below is **optional on the wire, and absent when it is the default** — which is not
   * micro-optimisation, it is the difference between a snapshot this tool can re-send every five
   * seconds and one it cannot.
   *
   * The snapshot is pushed **whole on every tick** (SPEC §6.3), and a conversation is ~360 turns on
   * a live database. `"options":[],"answer":null,"beatCount":0,"truncated":false,"endedAt":null` is
   * 75 bytes of nothing, and 75 bytes of nothing on 360 turns, five seconds apart, is 27 KB of
   * nothing. So a field that has nothing to say does not say it.
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
};

/**
 * **The agent side of an exchange, whichever way it points** — and the key every scope narrower
 * than an orchestrator is a filter on.
 *
 * Derived rather than carried. It is always one of the two handles already on the turn, so putting
 * it on the wire would be a third copy of a uuid in an object that is re-sent every five seconds —
 * 21 KB per push, to save one line of arithmetic. It lives here, beside the type, so the client and
 * the server cannot answer it differently.
 */
export function agentOfTurn(turn: Turn): string | null {
  const handle = turn.direction === 'in' ? turn.fromHandle : turn.toHandle;
  return handle === null || handle === '' ? null : handle;
}

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
 * What is *not* here is as considered: the gate Q&A, the dependencies **and now the messages** are
 * already on the wire. `snapshot.gates` carries every gate — answered ones included — with the
 * task it blocks (#19), `Task.deps` carries the edges, and `snapshot.turns` carries this task's
 * whole exchange, *both sides of it*, filtered by `taskId`. Re-sending any of them would be a
 * second copy that could disagree with the first — which is why the flat `messages` list that
 * used to live here is gone: it was the weaker half of a conversation the wire now carries whole.
 */
export type TaskDetail = {
  id: string;
  /** The prompt the agent was dispatched with. Null when the task has none. */
  spec: string | null;
  /** What came back. Null while the task is still working, or if it never reported. */
  result: string | null;
  /** **Every** dispatch attempt, oldest first — never just the latest one. */
  attempts: Dispatch[];
};

/**
 * One event type: first connect, normal tick and SSE reconnect all have this shape, so
 * there is no separate resync path to get wrong (SPEC §6.2).
 */
export type StreamEvent = {
  /** The message high-water mark — also the SSE event id. */
  seq: number;
  meta: Meta;
  /**
   * `gates` is a derived collection beside the runs and the tasks — not a field of either,
   * because a gate belongs to a *run* and only sometimes to a task (SPEC §4.5). `turns` is the
   * same, and for the same reason: a turn belongs to a run, and it is scoped down to an agent or
   * a task by the panel that shows it. The client filters both; it re-derives neither.
   */
  snapshot: { runs: Run[]; tasks: Task[]; gates: Gate[]; turns: Turn[]; coordinatorRuns: CoordinatorRun[] };
  /**
   * Only messages after the client's last-seen sequence.
   *
   * The **conversation** is `snapshot.turns`, not this: a feed of messages is exactly the half of
   * the dialogue that got written down (SPEC §4.7). What this is still for is the one thing a
   * snapshot cannot say — *what just arrived* — which is what flashes a node (SPEC §7.6).
   */
  messages: FeedMessage[];
};
