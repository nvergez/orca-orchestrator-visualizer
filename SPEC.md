# SPEC — `orca-viz`

**A read-only web visualizer for Orca's orchestration database.**

Status: **locked.** This is the implementation-ready specification produced by the wayfinder map ([#1](https://github.com/nvergez/orca-orchestrator-visualizer/issues/1)). Every decision below traces to a resolved ticket, cited inline as (#n). An implementation session should be able to build the MVP from this document plus [`HANDOFF.md`](./HANDOFF.md) without further deliberation.

**Reading order for the implementer:** `HANDOFF.md` (verified ground truth about Orca's DB — do not re-derive it) → this document. The three research docs under [`docs/research/`](./docs/research/) are the evidence behind the rulings; consult them when you need the `file:line` citations, not to make decisions.

| Source | What it settles |
|---|---|
| [`HANDOFF.md`](./HANDOFF.md) | The DB exists, is safely readable from outside, and its v5 schema |
| [#2](https://github.com/nvergez/orca-orchestrator-visualizer/issues/2) · [`db-history.md`](./docs/research/db-history.md) | What history the DB retains; run inference; the enum traps |
| [#3](https://github.com/nvergez/orca-orchestrator-visualizer/issues/3) · [`db-discovery.md`](./docs/research/db-discovery.md) | Cross-platform DB discovery; WAL read-only rules |
| [#4](https://github.com/nvergez/orca-orchestrator-visualizer/issues/4) · [`cli-data-source.md`](./docs/research/cli-data-source.md) | Why the `orca` CLI is not the data source |
| [#5](https://github.com/nvergez/orca-orchestrator-visualizer/issues/5) | Data access: SQLite-only, `node:sqlite`, render-what-parses |
| [#6](https://github.com/nvergez/orca-orchestrator-visualizer/issues/6) · [`prototype/`](./prototype/) | Rendering: React Flow + elkjs, proven at real scale |
| [#7](https://github.com/nvergez/orca-orchestrator-visualizer/issues/7) | UI composition: run scoping, panels, history, message flow |
| [#8](https://github.com/nvergez/orca-orchestrator-visualizer/issues/8) | Server architecture, config surface, install story, OSS extras |

---

## 1. Goal & non-goals

### 1.1 Goal

`orca-viz` renders **Orca's live and historical multi-agent orchestration** — the task DAG, who is working what, decision gates, and the message flow — by reading `orchestration.db` from outside the Orca app, strictly read-only (#1).

The user story: *`npx orca-viz` in a terminal, browser opens, and I can see what my agents are doing right now — and what they did yesterday.*

It is an **unofficial, third-party, shareable OSS tool** for any Orca user (#1): cross-platform, schema-tolerant, with an install story. It is not a personal one-machine script.

### 1.2 Hard invariants

These are not preferences. Violating any of them is a bug, not a trade-off.

1. **Never write to `orchestration.db`.** Every connection opens `readOnly: true` (#5). Orca's coordinator assumes it is the single writer and maintains invariants (e.g. `pending → ready` promotion) inside its own transactions (`HANDOFF.md`).
2. **No mutations of any kind** — no gate resolution, no dep editing, no retries, no marking messages read (#1). Note that `orca orchestration check` *mutates* (`read = 1`); nothing in this tool may go near it (#4).
3. **Never crash on schema drift.** Render what parses (#5, §5 below).
4. **Loopback-only by default.** The DB contains task specs, agent prompts, and message bodies (#8, §6.4).

### 1.3 Non-goals (out of scope for the MVP)

From the map's Out of scope (#1) and the decision tickets:

- **Any mutation or action** — ruled out during charting to keep the tool trivially safe against a live orchestrator (#1).
- **A recorder/replay component** capturing history beyond what the DB itself stores (#1). We show what the rows retain; we do not build a shadow event store.
- **Upstreaming into Orca** — this is a standalone external tool (#1).
- **Any dependency on the `orca` CLI or the running app.** Zero CLI spawns in the MVP; the tool works identically post-mortem with Orca closed (#5, #7 §2).
- **Repo/project grouping in the navigation.** The dev asked for it in #6 and, on evidence, **declined the narrow re-open** in #7 §2: no repo/worktree/path column exists anywhere in the DB (the file is global per machine, mixing every repo), and the only source — `orca terminal list` — resolves just *2 of 12* historical handles because terminal handles are ephemeral and never persisted (#7 coordinator note). Repo grouping is not deliverable for history at any price. **The accepted cost is explicit: you cannot filter runs by repo.**
- **Agent roster panel** — cut in #7 §4 as a panel with no unique information (assignee and failure count already live on the node badge).
- **Message-flow animation along DAG edges** — rejected on evidence in #7 §6, not deferred. See §7.6.
- **A `parent_id` hierarchy toggle** and deep compound layout — real data has zero `parent_id` rows (#7 §9).
- **Single-binary distribution** (SEA/pkg/bun compile) — our audience has a Node toolchain (#8 §5).
- **Publish-on-tag CI, coverage gates, release-please** (#8 §6).

### 1.4 Named post-MVP extensions

Recorded so the implementer knows where the seams are — **do not build these**, but do not architect them out either:

- **`orca worktree ps` enrichment** (#5, #7 §4): live agent activity — what the agent is *literally doing right now* (current tool call, last assistant message) — is invisible to SQL and only obtainable from the CLI. Named as the single most valuable post-MVP addition. It would resurrect the agent-roster panel with actual unique content.
- **Best-effort repo labels on live runs only**, via one cached `orca terminal list` call (#6, #7 §2) — offered and declined for the MVP.
- **`fs.watch` on the `-wal` file** as a sub-second wake hint (#8 §1) — a latency optimization, not a correctness one.
- **elkjs compound layout** for deep `parent_id` nesting, if real hierarchical data ever appears (#6, #7 §9).
- **`better-sqlite3`** as the driver escape hatch if `node:sqlite`'s API regresses (#5 §2).
- **dagre** as the layout fallback if bundle size ever matters (#6) — costs ~30 lines of custom component packing that we would then own forever.

---

## 2. Architecture

```
┌─────────────────────────────── orca-viz (one Node process) ──────────────────────────────┐
│                                                                                          │
│   ~/.config/orca/orchestration.db ──► node:sqlite (readOnly: true)                       │
│         (WAL, Orca is the writer)         │                                              │
│                                           ▼                                              │
│   ~/.config/orca/orca-runtime.json ──► poll loop (5s, gated on PRAGMA data_version)       │
│         (liveness: pid + socket)          │                                              │
│                                           ▼                                              │
│                              derive: runs, gates, heartbeats, graph                      │
│                                           │                                              │
│                          ┌────────────────┴──────────────────┐                           │
│                          ▼                                   ▼                           │
│              GET /api/stream (SSE)                  GET /api/task/:id                    │
│              snapshot + message delta               spec / result / all attempts         │
│                          │                                   │                           │
└──────────────────────────┼───────────────────────────────────┼───────────────────────────┘
                           ▼                                   ▼
            React + React Flow + elkjs (served from the same process, 127.0.0.1:4269)
```

**One process, one port** — it serves both the JSON API and the pre-built frontend from the package's `dist/`. No CORS, no second thing to start (#8 §4).

### 2.1 Data access: SQLite-only (#5)

Direct read-only SQLite owns **everything** in the poll loop. The `orca` CLI has **no role in the MVP** (#5 §1), because (#4): it offers zero schema insulation (it returns raw snake_case rows over a socket), it cannot read `coordinator_runs` at all, it costs ~0.3–0.9 s per spawned call (a 3-command poll cycle measured **1.3–5.8 s** under load), and it **dies with the app** — while direct reads are single-digit milliseconds and keep working post-mortem, which is precisely the case the tool exists to serve.

App liveness — *"is this data live or last-known?"* — comes from a **plain file read of `<userData>/orca-runtime.json`** plus `process.kill(pid, 0)`. No CLI spawn (#5 §1, #8 §4).

### 2.2 Driver: `node:sqlite` (#5 §2)

```js
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(dbPath, { readOnly: true })
db.exec('PRAGMA busy_timeout = 5000')   // brief locks exist around checkpoint/recovery (#3 §4.7)
```

- `engines: { node: ">=22.5" }` (#5 §2, #8 §5).
- **Zero native dependencies** — this is what makes the `npx` story work at all; a `better-sqlite3` dependency would force a compile-or-download step on first run (#8 §5).
- Suppress `node:sqlite`'s experimental warning (#5 §2). Do this by launching with `--disable-warning=ExperimentalWarning` in the `bin` shim, or by filtering `process.emitWarning`.
- **Never** `immutable=1` — it tells SQLite the file cannot change, and reads become corrupt if Orca is in fact running (#3 §4.4, #8 §4).

### 2.3 WAL operational rules (#3 §4) — enforce as startup errors, not silent weirdness (#8 §4)

- **Same host, same user.** Orca creates `userData` mode `0700`, so cross-user reads are impossible anyway; and **WAL does not work over a network filesystem** — never point `--db` at NFS/SMB/9p, at `/mnt/c` from WSL, or at an sshfs mount of a remote `orca serve` host. Detect and hard-error with an explanation.
- Reading a WAL database read-only needs SQLite ≥ 3.22 (any Node ≥ 22 satisfies this) and either readable existing `-wal`/`-shm` files, or write permission on the *directory* so they can be recreated. Same-user access satisfies both. After a clean Orca shutdown the `-wal`/`-shm` files are deleted — the directory-write path is what keeps post-mortem reads working.
- The `-wal` is part of the database. Never copy the `.db` alone (the live `-wal` was 4 MB against a 512 KB main file).

---

## 3. DB discovery (#3 §5, adopted verbatim by #8 §4)

Resolution order — **first hit wins**; every candidate must pass validation before being accepted:

1. **`--db <path>`** — explicit CLI flag.
2. **`ORCA_VIZ_DB`** — tool-specific env var, same semantics as the flag.
3. **`$ORCA_USER_DATA_PATH/orchestration.db`** — Orca exports this into every process it spawns and its own CLI honors it first, so this automatically targets a dev instance when you run inside one. Treat it as a hint: it is not reliably present in every Orca-spawned shell.
4. **Platform defaults**, in order — the userData root, with `orchestration.db` appended. Mirror Orca's own `getDefaultUserDataPath` (#3 §1):

   | Platform | Packaged | Dev build |
   |---|---|---|
   | Linux | `${XDG_CONFIG_HOME:-~/.config}/orca` | `.../orca-dev` |
   | macOS | `~/Library/Application Support/orca` | `.../orca-dev` |
   | Windows | `%APPDATA%\orca` | `%APPDATA%\orca-dev` |

   The name is **lowercase `orca` on every platform**: the packaged `package.json` has `"name": "orca"` and no `productName`, so Electron's `userData` resolves lowercase. There is **no user-facing override** in packaged builds, and Orca profiles do **not** multiply the DB — `orchestration.db` sits at the userData *root*, shared by all profiles of an install (#3 §2–3).

**An explicit `--db` / `ORCA_VIZ_DB` that doesn't work is a hard error — never a fall-through to defaults** (#8 §4). Silently visualizing a different database than the one the user named is the worst possible failure.

**When several platform defaults exist** (packaged + dev): prefer the directory containing a **fresh `orca-runtime.json`** (the live-instance marker); tiebreak on the most recent `-wal`/`.db` mtime (#3 §5, #8 §4).

**Always log the chosen DB path on startup.** Ship **`--list-dbs`** to print every candidate with its liveness and mtime — it is five lines of code and the first thing anyone debugs (#8 §4).

**Validation per candidate:** file exists and is readable → open `readOnly: true` → read `PRAGMA user_version`. A mismatch against 5 is a **warning and graceful degradation, never a refusal** (#3 §5, #5 §3).

---

## 4. The data (schema v5)

Ground truth is `HANDOFF.md` (tables, columns, enums) and #2 (what the rows actually contain in practice). Restated here only where the visualizer must act on it.

### 4.1 The five tables

| Table | Role in the visualizer |
|---|---|
| `tasks` | DAG nodes. `deps` is a **JSON string array of task ids = the edges**. `parent_id` = decomposition hierarchy. `created_by_terminal_handle` = the run key (§4.3). |
| `dispatch_contexts` | Task → agent assignment. **One row per dispatch *attempt*** — the only genuinely append-only per-task history in the schema. `MAX(rowid)` = latest attempt (the source's own queries do this). Circuit breaker trips at `failure_count = 3`. |
| `messages` | The event log. `sequence` (AUTOINCREMENT, gap-free) is a total order and the poll cursor. Immutable content. |
| `decision_gates` | **Empty in practice** — see the trap in §4.2. |
| `coordinator_runs` | **Empty in practice** — written only by Orca's built-in `Coordinator` loop, which agent/CLI-driven coordination never uses. Read it and render it if rows exist; do not depend on it. |

Enums (`HANDOFF.md`): `TaskStatus` = `pending | ready | dispatched | completed | failed | blocked`; `DispatchStatus` = `pending | dispatched | completed | failed | circuit_broken`; `MessageType` = `status | dispatch | worker_done | merge_ready | escalation | handoff | decision_gate | heartbeat`; `GateStatus` = `pending | resolved | timeout`; `CoordinatorStatus` = `idle | running | completed | failed`.

### 4.2 Traps the schema hides — get these wrong and the tool ships broken (#2, #7)

These are the highest-value findings of the entire map. Each one, implemented naively, produces a permanently empty or wrong panel.

1. **Gates must be derived from `decision_gate` *messages*, never the `decision_gates` table.** `orchestration.ask` writes a message and **no table row**. The live DB has **53 gate messages and 0 gate rows** (#2, #7 §8). A gates-from-the-table implementation renders nothing, forever, on real runs. See §4.5.
2. **`type = 'dispatch'` messages are never written.** Both dispatch paths inject the prompt straight into the worker's PTY. The dispatch *event* is reconstructible from `dispatch_contexts.dispatched_at`, not from messages. (Live: 0 `dispatch`, 0 `merge_ready`, 0 `handoff` rows.)
3. **`coordinator_runs` is empty** — it cannot be the run-scoping key. Runs must be *inferred* (§4.3).
4. **Heartbeats are ~65 % of all messages** (302 of 466). Rendered straight, the feed becomes a heartbeat ticker with the real events lost in it (#7 §7). See §7.7.
5. **Timestamp formats are split.** Columns written by SQL (`datetime('now')`) are `'YYYY-MM-DD HH:MM:SS'` **UTC**; columns written from JS are ISO-8601 `'…T…Z'`. Concretely: all `created_at`, `dispatch_contexts.dispatched_at`/`completed_at`, `messages.delivered_at`, `decision_gates.resolved_at`, `last_heartbeat_at` are the SQL format; **`tasks.completed_at`** and `coordinator_runs.completed_at` are ISO. **Normalize every timestamp to an ISO-8601 UTC instant at the server boundary** — the client must never see the raw split, and comparing them unnormalized silently produces garbage.
6. **`tasks.status` transitions are not recorded.** Six writers mutate it in place; `pending → ready` promotion is silent and untimestamped. What *is* timestamped: creation, each dispatch attempt, completion. **Do not build a status timeline that implies more than this** (#2 §3).
7. **`tasks.result` / `completed_at` use `COALESCE(new, old)`** — a re-completion overwrites the first completion time. Don't promise "first completed at".
8. **No foreign keys.** Every `task_id` reference is a soft string; after an `orchestration reset --tasks`, surviving messages point at tasks that no longer exist. **Any message → task join must tolerate a miss** (render the message in the feed, unattached to a node).
9. **`GateStatus = 'timeout'` never occurs** — `timeoutGate()` has no callers outside tests.
10. **The DB is never pruned.** It accumulates every run since the last manual reset (13 runs / 4 days in the live sample). You cannot assume the DB contains "the current run" — this is *why* run scoping exists.

### 4.3 Run inference (#2 §2, #7 §1, #7 §3) — server-side

There is **no run id in the schema**. A "run" is inferred, and the UI says so out loud (the rail header reads **"Runs (inferred)"** — #7 §1).

```
Algorithm — recompute per tick from the tasks table:

1. Read all tasks ordered by created_at.
2. Bucket by `created_by_terminal_handle`.
   → HANDLE IS THE PRIMARY KEY, TIME IS ONLY THE TIEBREAKER.
     Two handles genuinely overlap in time in real data (#7); time-first
     clustering would merge unrelated runs.
   → Tasks with a NULL handle (4 of 76 live) collect into ONE synthetic
     "Unattributed" run rather than vanishing (#7 §1).
3. Within a handle bucket, sort by created_at and split on an idle gap
   of more than 6 HOURS between consecutive tasks.
   → 6h, not minutes: a real 13-task run spans 20:10 → 07:04 overnight.
     A short gap would shred it (#7 §1).
4. Run id: deterministic and stable across restarts —
   `run_<handle-first-8-hex>_<epoch-seconds of first task>`;
   the synthetic bucket is `run_unattributed`.
5. Label = the earliest task's `task_title`, falling back to
   `display_name`, then the short handle (#7 §3). In practice a run's
   first task names the work.
6. Derived per run: startedAt (min created_at), endedAt (max of
   completed_at / created_at), task count, per-status counts,
   `live` = (meta.liveness === 'live') AND (any task is `ready` or
   `dispatched`), `hasOpenGates` (§4.5).
```

The **server owns this** — the client never re-derives it (#7 "Consequences for #9").

### 4.4 Message → run attribution (#7 §5) — server-side

1. **`payload.taskId` where present** → that task's run. This covers **83 %** of messages (100 % of `heartbeat` and `worker_done`, 21/53 `decision_gate`, 1/46 `status`).
2. **Otherwise, by handle membership**: the message's `from_handle`/`to_handle` is in the run's handle set (the run's coordinator handle ∪ the `assignee_handle`s of its dispatch contexts), **constrained to the run's time window**.
3. *(Spec-level tie rule, filling a gap the tickets left open rather than re-deciding anything:)* if more than one run still matches, leave `runId` null. An unattributed message appears in the **"All"** feed scope only — never guessed into the wrong run.

### 4.5 Gate derivation (#7 §8) — server-side

**Primary and required source: `messages` where `type = 'decision_gate'`.**

- The gate's **question and options** come from `payload` (`{question, options}`).
- The gate's **task** is `payload.taskId` when present (21/53); a gate without one attaches to its **run** (via §4.4) but to no node.
- **Resolution:** a gate is *resolved* when a reply message exists whose `thread_id` equals the gate message's `id` — `orchestration.ask` replies thread on the outbound message id (#2 §3). The reply's body is the resolution. No reply → the gate is **open**, which is what drives the gate strip (§7.4) and `run.hasOpenGates`.
- *(Spec-level, strictly additive:)* if `decision_gates` rows *do* exist — Orca's built-in `Coordinator` loop and `gateCreate` write them, even though CLI-driven runs never do — merge them in, deduplicated by `(task_id, question)`. This can only add gates, never re-introduce the empty-panel failure. Never treat the table as the primary source.

### 4.6 Heartbeat → liveness (#7 §7)

The latest `heartbeat` message per dispatch (equivalently, `dispatch_contexts.last_heartbeat_at`, which carries the last one on the row) drives a **"last seen 12 s ago"** on the node's assignee badge. The snapshot must therefore carry per-task latest-heartbeat (#7 "Consequences for #9"). Heartbeats **never** enter the feed by default and **never** pulse a node.

---

## 5. Schema handling: render-what-parses (#5 §3)

**Never crash on schema drift.** Orca's schema is internal, unversioned as a public API, and can change between releases. The migration history (v2 `last_heartbeat_at`, v3 `delivered_at`, v4 `created_by_terminal_handle`, v5 `task_title`/`display_name`) is purely **additive**, which is what makes this strategy realistic (#2, #4 §5).

At startup:

1. Read **`PRAGMA user_version`** (5 is current).
2. **Introspect the real columns** of all five tables via `PRAGMA table_info(<table>)`. Build the query set from what actually exists — do not `SELECT` a column you have not confirmed.

Then:

| Condition | Behavior |
|---|---|
| `user_version === 5` | Normal operation. |
| `user_version > 5` (newer Orca) | **Render normally, under a visible banner:** *"newer Orca schema — some data may be missing or mislabeled."* |
| `user_version < 5` (older Orca) | **Per-feature degradation.** A missing column disables exactly the feature that needs it and nothing else — e.g. no `task_title`/`display_name` (pre-v5) → fall back to the short task id for labels; no `created_by_terminal_handle` (pre-v4) → every task lands in the **Unattributed** run and the rail says so; no `last_heartbeat_at` (pre-v2) → no last-seen badge. Report the degraded feature list in `meta.degraded` and surface it in the UI. |
| Unknown enum value (a new status / message type) | **Rendered in a neutral "unknown" style — never dropped, never crashed on.** An unknown `TaskStatus` gets the neutral grey node treatment and its raw string as the chip label. |
| The DAG core (`tasks.id` / `status` / `deps`) is unreadable | **Hard-fail** with an actionable message. This is the *only* hard-fail. |

Additionally, `sqlite_sequence.seq` vs `COUNT(messages)` / `MIN(sequence)` is a cheap **reset detector** (#2 §4): a gap means someone ran `orchestration reset`. Worth a one-line note in the UI when detected, so a suddenly-empty history is explained rather than mysterious.

---

## 6. Server

### 6.1 Poll loop: 5 s, gated on `PRAGMA data_version` (#8 §1)

A fixed `setInterval` at **5000 ms** (`--poll-interval` overrides). Each tick:

```
1. Read `PRAGMA data_version`.
      unchanged  → SKIP EVERYTHING. No queries, no push.
      changed    → continue.
2. Re-read orca-runtime.json + process.kill(pid, 0)  → meta.liveness
3. Query the graph tables → build the full snapshot (§6.3)
4. Query messages WHERE sequence > <high-water mark>
5. Push one SSE event; advance the high-water mark.
```

- **`data_version` is the change detector.** Idle ticks are ~free, and the browser never receives a no-op push — no re-render, no flicker, and "a message arrived" always means something actually changed.
- **`MAX(messages.sequence)` is the incremental cursor**, not a change detector. It is AUTOINCREMENT, gap-free, and append-only — the one trustworthy cursor in the schema (#2 §3).
- **No `fs.watch` on the `-wal`.** It is deleted on clean Orca shutdown (invalidating the watcher), its semantics vary per platform, and at a 5 s cadence it buys nothing (#8 §1).
- **Accepted trade (#8 §1):** 5 s is 2.5× Orca's own 2 s coordinator cadence, so a `ready → dispatched` flip can surface up to 5 s late. Deliberate — reads are milliseconds, but a slow loop keeps the tool nearly free on battery, and "slightly behind" is fine for a watch-my-agents panel.

Liveness (#8 §4), re-read every tick:

| State | Condition | UI wording |
|---|---|---|
| `live` | runtime file present, pid alive | "connected to running Orca" |
| `stale` | no runtime file, or pid dead | "Orca isn't running; showing last-known state from `<mtime>`" |
| `unknown` | runtime file unreadable/malformed | degrade to the `stale` wording |

The `stale` case is *why* we chose SQLite over the CLI — it gets an honest label, never a pretense that the data is live.

### 6.2 Transport: SSE, not WebSocket (#8 §2)

`GET /api/stream`, `Content-Type: text/event-stream`. WebSocket's only differentiator is a bidirectional channel that #5 **contractually forbids us from using**. The decisive advantage is that `EventSource` reconnects automatically and replays **`Last-Event-ID`**, which maps exactly onto our `messages.sequence` cursor — the resume story we need arrives for free instead of hand-rolled. Plus: plain HTTP, no `ws` dependency, no upgrade handling. One push per ≥5 s to a few localhost tabs stresses neither option.

**The SSE event `id` is the message high-water mark (`seq`).** On reconnect the browser sends `Last-Event-ID: <seq>`; the server replies with **one full snapshot + all messages after that sequence** — *literally the same code path as a normal tick*, so there is no separate resync mode to get wrong (#8 §3).

### 6.3 Payload: hybrid — snapshot for the graph, append for messages (#8 §3)

The two halves of the data have opposite shapes, so they get opposite treatments.

**Graph state → a full snapshot on every push.** `tasks`, `dispatch_contexts`, `decision_gates`, `coordinator_runs` are all **overwritten in place with no `updated_at` column anywhere** (#2 §3). Computing a delta would mean reading every row anyway and diffing against server-side shadow state — zero DB savings and a whole new class of drift bugs, where one missed mutation path leaves the client silently stale forever. **Overwritten-in-place argues *for* snapshots: don't trust a delta you had to reconstruct.** The tables are small (76 tasks / 64 dispatch contexts live).

> **The snapshot omits `spec` and `result` bodies.** A live 71-task dump was **172 KB, almost entirely spec text**. Omitting them drops the snapshot to a few KB; they are fetched on demand by `GET /api/task/:id` when a node is clicked (#8 §3).

**Message feed → incremental append** (`sequence > lastSeen`). This is the one place a delta is both cheap *and correct*, because message rows are immutable once written. `messages.read` / `delivered_at` are mutable flags on otherwise-immutable rows — **we do not render them** (internal mailbox bookkeeping, not orchestration semantics), so their mutability never bites (#8 §3).

**One event type.** Every push — first connect, normal tick, reconnect — has the same shape:

```ts
type StreamEvent = {
  seq: number            // message high-water mark; also the SSE event id
  meta: Meta
  snapshot: { runs: Run[]; tasks: Task[]; coordinatorRuns: CoordinatorRun[] }
  messages: FeedMessage[]   // sequence > client's last-seen; [] on an idle-but-changed tick
}

type Meta = {
  dbPath: string
  schemaVersion: number                      // PRAGMA user_version
  schemaSupport: 'supported' | 'newer' | 'older'
  degraded: string[]                         // feature names disabled by missing columns (§5)
  liveness: 'live' | 'stale' | 'unknown'
  orcaPid: number | null
  dbMtime: string                            // ISO — powers the "last-known state from …" wording
  resetDetected: boolean                     // sqlite_sequence gap (§5)
}

type Run = {                                 // inferred — §4.3
  id: string                                 // run_<handle8>_<epoch> | run_unattributed
  handle: string | null                      // full handle, shown in a tooltip
  label: string                              // earliest task's title
  startedAt: string; endedAt: string         // ISO
  taskCount: number
  statusCounts: Record<TaskStatus, number>
  live: boolean
  hasOpenGates: boolean
  edgeCount: number                          // 0 ⇒ the edgeless empty state (§7.5)
}

type Task = {
  id: string; runId: string
  parentId: string | null
  title: string                              // task_title ?? display_name ?? short id
  status: TaskStatus | string                // unknown values pass through verbatim (§5)
  deps: string[]                             // parsed from the JSON string column
  createdAt: string; completedAt: string | null   // NORMALIZED to ISO (§4.2 trap 5)
  hasSpec: boolean; hasResult: boolean       // bodies omitted — fetch via /api/task/:id
  dispatch: {                                // LATEST attempt (MAX(rowid)); null if never dispatched
    id: string; assigneeHandle: string; status: DispatchStatus | string
    failureCount: number; lastFailure: string | null
    dispatchedAt: string; completedAt: string | null
    lastHeartbeatAt: string | null           // the last-seen badge (§4.6)
  } | null
  attemptCount: number                       // > 1 ⇒ this task was retried
  gate: { messageId: string; question: string; options: string[]
          status: 'open' | 'resolved'; resolution: string | null } | null   // §4.5
}

type FeedMessage = {
  id: string; sequence: number
  type: MessageType | string
  fromHandle: string; toHandle: string
  subject: string; body: string
  priority: string; threadId: string | null
  payload: unknown                           // parsed from the JSON string column
  createdAt: string                          // ISO
  taskId: string | null                      // payload.taskId, when it resolves to a live task
  runId: string | null                       // §4.4
}
```

Bodies in the feed are small (subjects and short bodies); ship them. `spec`/`result` are the only heavy fields and they are the ones we omit.

### 6.4 HTTP surface & config (#8 §4)

| Route | Purpose |
|---|---|
| `GET /` + `/assets/*` | The pre-built frontend, served from the package's `dist/` |
| `GET /api/stream` | SSE (§6.2). Honors `Last-Event-ID`. |
| `GET /api/task/:id` | Lazy detail: `spec`, `result`, **all** `dispatch_contexts` rows ordered by `rowid` (not just the latest — #7 §8), and all messages whose `payload.taskId` is this task, sequence-ordered. |
| `GET /api/snapshot` | *(Spec-level convenience:)* a one-shot `StreamEvent`, same code path. Costs nothing and makes the whole thing `curl`-debuggable. |

**Binding: `127.0.0.1:4269`** by default; `--port` / `--host` override.

> **Loopback-only is a security decision, not a default-by-accident** (#8 §4). The DB holds full task specs, agent prompts, and message bodies — much of it whatever you and your agents typed. That must not end up listening on `0.0.0.0` because someone ran a tool on a café network.

**Port in use → a clear error. No silent port-hunting** — a hunted port breaks the auto-open URL and any bookmark (#8 §4).

CLI surface:

| Flag / env | Effect |
|---|---|
| `--db <path>` / `ORCA_VIZ_DB` | Explicit DB. **Hard error if unusable — never falls through** (§3). |
| `--list-dbs` | Print every discovery candidate with liveness + mtime, then exit. |
| `--port <n>` / `--host <h>` | Override `127.0.0.1:4269`. |
| `--poll-interval <ms>` | Override 5000. |
| `--no-open` | Suppress the browser auto-open. |
| `--version`, `--help` | Standard. |
| `ORCA_USER_DATA_PATH` | Honored as discovery step 3 (§3). |

**Auto-open the browser by default** (#8 §5): for a one-shot `npx` tool, the user's intent in typing the command *is* "show me the thing." Auto-open **self-suppresses** when it can't or shouldn't work — `--no-open`, non-TTY stdout (piped/CI), or headless/SSH/no-`DISPLAY` — so a headless `orca serve` box just prints the URL instead of erroring.

---

## 7. Frontend

Stack: **React + Vite + TypeScript**, **React Flow (`@xyflow/react`)** for the canvas, **elkjs** for layout. React Flow is **locked** (#6): 76 custom nodes plus a minimap pan and zoom smoothly at real scale; it is not a bottleneck and needs no perf work. Dev runs Vite with a proxy to the server; the shipped artifact is the pre-built `dist/` the server serves (#8 §4).

### 7.1 Layout composition: three zones, four panels (#7 §4)

```
┌──────────────┬──────────────────────────────────────────────┬─────────────────────┐
│  RUN RAIL    │  ⚠ GATE STRIP (only when open gates exist)    │   RIGHT DOCK        │
│  (inferred)  ├──────────────────────────────────────────────┤   one panel, swaps: │
│              │                                              │                     │
│  ● run label │              DAG CANVAS                      │   • MESSAGE FEED    │
│    date·N·k  │           (exactly one run)                  │     (default)       │
│  ● run label │                                              │     ⇕               │
│    …         │   ── connected components (elkjs, TB) ──     │   • NODE INSPECTOR  │
│              │   ── isolated tasks, grid-packed below ──    │     (on selection)  │
└──────────────┴──────────────────────────────────────────────┴─────────────────────┘
```

- **Left rail** — the list of inferred runs (§7.2).
- **Centre** — the DAG canvas, showing **exactly one run** (§7.5).
- **Right dock** — **one** panel that *swaps*: the **message feed** (default, run-scoped) ⇄ the **node inspector** (on node selection). Not both stacked — at this node count the canvas deserves the width.
- **Gate strip** — above the canvas, appearing **only** when the selected run has unresolved gates. Gates *block* an orchestration; they must interrupt, not sit in a tab you forget to open. It is not a standing panel.
- **Agent roster — cut.** Everything it would show (assignee, failure count) is already on the node badge; the one thing it could uniquely add — which agent is alive *right now* — needs `orca worktree ps`, which is post-MVP (#5). A panel with no unique information.

### 7.2 The run rail (#7 §1, §3)

Header: **"Runs (inferred)"** — the schema has no run id and the UI will not pretend otherwise.

A row is:

```
● <earliest task's title, bold>
  Jul 11, 20:54 · 8 tasks · 6 done / 1 failed        [green dot if live]
```

with a status dot at the left and the **full terminal handle in a tooltip**. Rows sort by most-recent activity. The synthetic **"Unattributed"** run is a normal row.

**On open, the most recently active run is auto-selected** (#7 §1). **Not an all-tasks view** — dumping all 76 tasks at once is exactly what produced the unusable ~50-wide singleton ribbon in #6.

### 7.3 History: the rail *is* the browser — a badge, not a mode (#7 §5)

The DB never prunes; 13 runs across 4 days sit in it right now. There is **no "history mode"**: a past run renders through the **exact same code path** as the live one, because to us it is the same rows. Live-ness is a **badge** — a green dot when `meta.liveness === 'live'` and the run has `dispatched`/`ready` tasks; otherwise "ended".

- **No auto-jump.** A new run appearing while you read an old one shows a **"new run started ↑"** chip on the rail. The canvas is never yanked out from under you.
- **Feed scope toggle: "This run" (default) / "All."** The global `sequence` timeline is the only true total-order history in the schema and costs nothing extra to expose — one click away, never the default.

### 7.4 The gate strip (#7 §4, §8)

Appears above the canvas **only** when the selected run has open gates (§4.5). Each entry shows the question, the options, and the task it blocks (clicking selects that node). **Read-only** — it displays the gate; it never offers to resolve it (#1).

**Derived from `decision_gate` messages, never the `decision_gates` table** (§4.2 trap 1). This is load-bearing: the table has 0 rows and 53 gate messages exist.

### 7.5 The canvas (#6 verdict, #7 §9)

Locked by #6 against the live prototype and confirmed by the dev on screen:

| Decision | Value |
|---|---|
| **Layout engine** | **elkjs** — `layered`, `elk.direction: DOWN`, **`elk.separateConnectedComponents: true`** |
| **Rank direction** | **TB (top-to-bottom)** default |
| **Node size** | **240 × 84**, title clamped to **3 lines** |
| **Title on hover?** | **No.** Scanning a finished run for the failed node must not require interaction. |
| **Isolated tasks** | **Grid-packed below the DAG, in a collapsible block** |
| **Hidden by default?** | **Nothing.** Completed tasks especially stay visible — they are the payload of a post-mortem read. |
| **`parent_id`** | **Dashed-box containment.** No hierarchy toggle. Deep nesting deferred (zero `parent_id` rows in real data); elkjs compound layout is the escape hatch. |

**Why elkjs and not dagre** (#6): the deciding factor is *not* layered-layout quality — at 76 tasks / ~19 dep edges that is irrelevant. It is **disconnected-component handling**. About **50 of 76 tasks are fully isolated singletons**. Naive dagre puts every isolated node in rank 0 → a ~50-node-wide ribbon → `fitView` zooms out until nothing is legible. dagre only works with ~30 lines of custom grid-packing that we would then own forever. elkjs does it natively. Its costs (async API, ~1.4 MB pre-gzip, ~120–150 ms one-shot layout) are irrelevant for a local read-only tool.

**Run-scoping does not dissolve the singleton problem — it relocates it.** **4 of 13 runs are entirely edgeless** (13/13, 10/10, 10/10, 3/3 tasks isolated) (#7 §9). Therefore:

- **The isolated grid is ordered by `created_at`**, never arbitrarily. For a run with no edges, **dispatch order is the only structure it has**.
- **The edgeless case is owned, not treated as a rendering failure.** When a run has zero dep edges the canvas shows the ordered grid plus a one-liner: *"No dependencies in this run — 13 tasks dispatched independently."* That is an honest description of the orchestration, not an error.

**Node contents** (from the approved prototype — `prototype/src/`):

- **Status colour** (border / background / text), verbatim from the prototype the dev signed off on:

  | Status | bg | border | text |
  |---|---|---|---|
  | `pending` | `#f4f4f5` | `#a1a1aa` | `#3f3f46` |
  | `ready` | `#dbeafe` | `#3b82f6` | `#1e3a8a` |
  | `dispatched` | `#fef3c7` | `#f59e0b` | `#78350f` |
  | `completed` | `#dcfce7` | `#22c55e` | `#14532d` |
  | `failed` | `#fee2e2` | `#ef4444` | `#7f1d1d` |
  | `blocked` | `#f3e8ff` | `#a855f7` | `#581c87` |
  | *unknown* | neutral grey, raw status string as the chip label (§5) | | |

- **Assignee badge** — dark monospace chip, first 8 hex chars of `dispatch.assigneeHandle`; `✗N` when `failureCount > 0` (the circuit breaker trips at 3).
- **Last-seen badge** — `"last seen 12s ago"` from `dispatch.lastHeartbeatAt`, **going stale-amber past a threshold** (#7 §7). *Spec-level default: 10 minutes*, i.e. 2× the 5-minute heartbeat cadence Orca instructs its workers to keep; make it a constant, not a magic number. Shown only while the dispatch is `dispatched`.
- **Gate marker** — orange `⛔ gate` badge when the task has an open gate (§4.5).
- **Retry marker** — surface `attemptCount > 1`; it is the only visible sign of a retry, and no task has retried in real data yet, so it must be right the first time it happens.

**Edges:** dep edges from `deps`, arrowheads, **dashed + animated into `dispatched` nodes**. These are a **status affordance, never message flow** (#7 §6) — keeping them is what makes the message-flow rejection safe, because the canvas still moves when work is in flight.

### 7.6 Message flow: feed **yes**, edge animation **rejected** (#7 §6)

The map's fog item ("animation along DAG edges") is resolved as **no**, on evidence rather than taste:

> **Messages are a star between *handles*; dep edges connect *tasks*.** A `worker_done` travels worker-terminal → coordinator-terminal. It does **not** traverse the edge from task A to task B. Animating it along a dep edge would render a flow that does not exist. And the data agrees about where messages *do* belong: **83 % carry `payload.taskId`** — they attach to **nodes**, and **none** attach to an edge.

So instead:

- **Feed keyed on `messages.sequence`** — the SSE cursor (#8) is also the feed's order.
- **Node pulse:** a message referencing a task briefly flashes **that node** in its type's colour — `worker_done` **green**, `escalation` **red**, `decision_gate` **amber**. (*Spec-level default: ~1 s flash.*) Heartbeats **never** pulse (§7.7).
- **Feed ↔ node bidirectional linking** — the real payoff: **click a feed row → its node highlights and centres; select a node → the feed filters to that task's messages.**

### 7.7 The feed & heartbeats (#7 §7)

Heartbeats are **65 % of all messages** (302 of 466) and **all of them carry a `taskId`** — rendered straight, the feed becomes a heartbeat ticker with the real events lost in it, and pulsing them would strobe the canvas.

- **Heartbeats are filtered out of the feed by default**, behind a **"show heartbeats"** toggle.
- Their value is *liveness*, not event-ness: they become the **last-seen badge** (§4.6, §7.5).
- **Default feed content** is therefore `worker_done` + `decision_gate` + `escalation` + `status` — **164 rows over 4 days, which is actually readable.**
- A feed row shows: type chip, `from → to` (short handles), subject, relative time; expandable to the body/payload. `read` / `delivered_at` are **not rendered** (#8 §3).
- A message whose `taskId` does not resolve to a live task (post-reset orphan — §4.2 trap 8) still renders in the feed, simply unlinked.

### 7.8 The node inspector (#7 §8)

Node click swaps the right dock. It is exactly what `GET /api/task/:id` exists for. Top to bottom:

1. **Header** — `task_title`, status chip, **copyable `task_id`**.
2. **Spec** (the full dispatch prompt) and **result** receipt — lazy-fetched on click.
3. **Dispatch attempt history** — **all** `dispatch_contexts` rows for the task ordered by `rowid`, **not just the latest**: assignee, status, dispatched/completed times, `failure_count`, `last_failure`. This is the only genuinely append-only per-task history in the schema, and the only place a retry / circuit-breaker story ever becomes visible.
4. **Messages referencing this task** (`payload.taskId`), sequence-ordered.
5. **Gate Q&A** — derived from `decision_gate` **messages** (§4.5).
6. **Deps in / out** as chips that select the neighbour node.

---

## 8. Install story (#8 §5)

**`npx orca-viz`** is the headline and the whole pitch.

This is the payoff from the `node:sqlite` driver decision (#5 §2): **zero native dependencies → no `node-gyp`, no prebuilds, no postinstall, nothing to compile on first run** — which is exactly where `npx` stories usually die.

- **Package name: `orca-viz`, unscoped.** Verified free on npm (`orca-visualizer` is taken).
- **`npm i -g orca-viz` works for free** — same `bin` entry — but `npx` is the documented path.
- **Node floor enforced loudly:** `engines: { node: ">=22.5" }` **plus a runtime check** that prints something actionable:

  ```
  orca-viz needs Node >= 22.5 (you have v20.11.0). Try: npx -y node@22 …
  ```

  npm's `engines` warning is easy to miss, and the alternative failure mode is a cryptic `Cannot find module 'node:sqlite'`.
- **No single binary** (SEA/pkg/bun compile) in the MVP: it buys only "runs without Node," at the cost of a per-platform build matrix, a release pipeline, and macOS/Windows code signing. Our audience *is* Orca users — developers with a Node toolchain. Revisit only if "I only have Node 20" becomes a real complaint.

---

## 9. OSS repo extras (#8 §6)

- **License: MIT.** Maximally permissive, zero friction for anyone (Stably included) to pick it up.
- **CI: one minimal GitHub Actions workflow** on push/PR — install → typecheck → lint → test → build, matrix on **Node 22 + 24** (nothing below 22.5 can run this at all). Explicitly **not** MVP: publish-on-tag, coverage gates, release-please. Publish by hand with `npm publish` until there is a second contributor or a second release.
- **Versioning: independent semver, pinned to nothing, starting at `0.x`.** We are an outside observer and do not track Orca's version numbers. A hand-maintained **compatibility table** in the README records what we have actually verified:

  | orca-viz | Orca `SCHEMA_VERSION` tested against | Orca app version |
  |---|---|---|
  | 0.1.x | 5 | 1.4.128 |

  This is the *documentation* half of render-what-parses (#5 §3): the runtime banner tells the user when they are past what we verified; the table tells them what that verification was.

- **The README must say, up front and unambiguously:** this is an **unofficial, third-party, read-only** tool, **not affiliated with Stably or Orca**, that **never writes to the database**; it reads Orca's **internal, undocumented** schema, so **a minor bump may be required after an Orca update**. *"Some npm package touches my app's database"* deserves an honest paragraph on day one rather than an apology later.

---

## 10. Definition of done (MVP)

The MVP ships when, against a real `orchestration.db`:

1. `npx orca-viz` on a machine with Orca installed discovers the DB, starts on `127.0.0.1:4269`, and opens a browser.
2. The rail lists the inferred runs, most-recent auto-selected, labelled by first-task title, with a live badge when Orca is running.
3. The canvas renders that run's DAG — elkjs, TB, status colours, assignee + last-seen badges, dep edges animated into `dispatched` — and handles an **edgeless run** with the ordered grid and its one-liner.
4. The feed streams over SSE, heartbeat-free by default, and links bidirectionally with the canvas.
5. Clicking a node opens the inspector with spec, result, **every** dispatch attempt, its messages, and any gate.
6. A run with an open gate shows the gate strip — **populated from `decision_gate` messages**.
7. Closing Orca flips the badge to **stale** with an honest "last-known state from …" line, and **everything else keeps working**.
8. Pointing it at a DB with a different `user_version` does not crash it.

---

## 11. Open questions

**None.** Every question raised by the map is closed by a ticket resolution:

- Data source → #5 (SQLite-only).
- Rendering feasibility and engine → #6 (React Flow + elkjs, proven at real scale).
- Run scoping, panels, history browsing, message-flow animation → #7 (all nine sub-decisions).
- Poll/transport/payload/config/install/OSS → #8 (all six sub-decisions).
- The two graduated fog items — **history browsing** and **message-flow animation** — were both resolved in #7 (§5, §6).

Three places in this document fill a mechanical gap the tickets did not need to reach, each marked **spec-level** inline and none of them re-litigating a ruling: the message-attribution tie rule (§4.4), the additive merge of `decision_gates` rows when they exist (§4.5), and the concrete numbers for the heartbeat-stale threshold and pulse duration (§7.5, §7.6). An implementer may change these without reopening a ticket. **Everything else is locked.**
