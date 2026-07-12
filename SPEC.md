# SPEC — `orca-viz`

**A read-only web visualizer for Orca's orchestration database.**

Status: **locked.** This is the implementation-ready specification produced by the wayfinder map ([#1](https://github.com/nvergez/orca-viz/issues/1)). Every decision below traces to a resolved ticket, cited inline as (#n). An implementation session should be able to build the MVP from this document plus [`HANDOFF.md`](./HANDOFF.md) without further deliberation.

**Reading order for the implementer:** `HANDOFF.md` (verified ground truth about Orca's DB — do not re-derive it) → this document. The three research docs under [`docs/research/`](./docs/research/) are the evidence behind the rulings; consult them when you need the `file:line` citations, not to make decisions.

| Source | What it settles |
|---|---|
| [`HANDOFF.md`](./HANDOFF.md) | The DB exists, is safely readable from outside, and its v5 schema |
| [#2](https://github.com/nvergez/orca-viz/issues/2) · [`db-history.md`](./docs/research/db-history.md) | What history the DB retains; run inference; the enum traps |
| [#3](https://github.com/nvergez/orca-viz/issues/3) · [`db-discovery.md`](./docs/research/db-discovery.md) | Cross-platform DB discovery; WAL read-only rules |
| [#4](https://github.com/nvergez/orca-viz/issues/4) · [`cli-data-source.md`](./docs/research/cli-data-source.md) | Why the `orca` CLI is not the data source |
| [#5](https://github.com/nvergez/orca-viz/issues/5) | Data access: SQLite-only, `node:sqlite`, render-what-parses |
| [#6](https://github.com/nvergez/orca-viz/issues/6) · [`prototype/`](./prototype/) | Rendering: React Flow + elkjs, proven at real scale |
| [#7](https://github.com/nvergez/orca-viz/issues/7) | UI composition: run scoping, panels, history, message flow |
| [#8](https://github.com/nvergez/orca-viz/issues/8) | Server architecture, config surface, install story, OSS extras |

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
2. **`type = 'dispatch'` messages are never written.** Both dispatch paths inject the prompt straight into the worker's PTY. The dispatch *event* is reconstructible from `dispatch_contexts.dispatched_at`, and what was *said* only from `tasks.spec` — never from messages. (Live: 0 `dispatch`, 0 `merge_ready`, 0 `handoff` rows.) **This is the trap the conversation turns on: see §4.7.** A dialogue read out of `messages` alone is agents talking into the void, to an orchestrator that never answers.
3. **`coordinator_runs` is empty** — it cannot be the run-scoping key. Runs must be *inferred* (§4.3).
4. **Heartbeats are ~65 % of all messages** (302 of 466). Rendered straight, the feed becomes a heartbeat ticker with the real events lost in it (#7 §7). See §7.7.
5. **Timestamp formats are split.** Columns written by SQL (`datetime('now')`) are `'YYYY-MM-DD HH:MM:SS'` **UTC**; columns written from JS are ISO-8601 `'…T…Z'`. Concretely: all `created_at`, `dispatch_contexts.dispatched_at`/`completed_at`, `messages.delivered_at`, `decision_gates.resolved_at`, `last_heartbeat_at` are the SQL format; **`tasks.completed_at`** and `coordinator_runs.completed_at` are ISO. **Normalize every timestamp to an ISO-8601 UTC instant at the server boundary** — the client must never see the raw split, and comparing them unnormalized silently produces garbage.
6. **`tasks.status` transitions are not recorded.** Six writers mutate it in place; `pending → ready` promotion is silent and untimestamped. What *is* timestamped: creation, each dispatch attempt, completion. **Do not build a status timeline that implies more than this** (#2 §3).
7. **`tasks.result` / `completed_at` use `COALESCE(new, old)`** — a re-completion overwrites the first completion time. Don't promise "first completed at".
8. **No foreign keys.** Every `task_id` reference is a soft string; after an `orchestration reset --tasks`, surviving messages point at tasks that no longer exist. **Any message → task join must tolerate a miss** (render the message in the feed, unattached to a node).
9. **`GateStatus = 'timeout'` never occurs** — `timeoutGate()` has no callers outside tests.
10. **The DB is never pruned.** It accumulates every run since the last manual reset (13 runs / 4 days in the live sample). You cannot assume the DB contains "the current run" — this is *why* run scoping exists.

### 4.3 The orchestrator, and its waves — server-side

**A row in the rail is one `created_by_terminal_handle`: a Claude Code session that was told to coordinate.** That is not a guess — the column says which terminal created a task — and the rail says the word: **"Orchestrators"**.

It used to say *"Runs (inferred)"*, and it had to. A "run" was a bucket of tasks by handle, **cut wherever six idle hours fell**, so one terminal reused across four days silently became several unrelated rows and nothing on screen ever gave the reason. The user saw only the consequences of a boundary they were never shown.

**The six-hour rule is demoted, not deleted.** Same threshold, new job: it cuts an orchestrator's tasks into **waves**, which the canvas draws as bordered regions captioned with the gap that opened each one — *"Wave 2 · after 14h idle"*. The time gap is now **shown** instead of **imposed**.

```
Algorithm — recompute per tick from the tasks table:

1. Read all tasks ordered by created_at.
2. Bucket by `created_by_terminal_handle`. ONE HANDLE IS ONE ORCHESTRATOR.
   → THE HANDLE IS THE KEY, TIME IS NOT. Two handles genuinely overlap in
     time in real data (#7); a time-first clustering would merge two
     unrelated orchestrations into one.
   → Tasks with a NULL handle (4 of 76 live) collect into ONE synthetic
     "Unattributed" row rather than vanishing (#7 §1). It is not an
     orchestrator, and it is labelled as what it is.
3. WAVES. Within a handle, sort by created_at and cut on an idle gap of
   MORE than 6 HOURS between consecutive tasks.
   → 6h, not minutes: a real 13-task run spans 20:10 → 07:04 overnight,
     and any shorter threshold shreds it (#7 §1).
   → A cut opens a wave; it no longer opens a ROW. Each wave carries
     {index, startedAt, endedAt, taskIds, idleGapBeforeMs}, and the gap is
     drawn on the canvas (§7.5).
   → The null-handle bucket gets exactly one wave: those tasks were never
     one terminal's work, so a gap between two of them measures nobody.
4. Run id: `run_<handle>` — the handle ALONE — or `run_unattributed`.
   → The old `_<epoch of the first task>` suffix existed only to tell one
     handle's several segments apart, and there are none now. It was also a
     liability: it keyed a rail row's identity on a TASK, so an orchestrator
     picking its work back up would have changed id under the user's
     selection. The id must be deterministic AND stable across restarts —
     a rail that cannot hold a selection cannot be used for history.
   → The whole handle, not its first 8 hex: this string is a join key and a
     React key, never a label (the row shows the handle; the tooltip has it
     in full). Two terminals sharing a prefix would silently merge two
     orchestrators into one row, which is a lie that costs nothing to make
     impossible.
5. Label = the earliest task's `task_title`, falling back to `display_name`,
   then the short handle (#7 §3). In practice a run's first task names the work.
6. Derived per run: startedAt (min created_at), endedAt (max of completed_at /
   created_at), task count, per-status counts, the CAST (§4.3a), the WAVES,
   `live` = (meta.liveness === 'live') AND (any task is `ready` or
   `dispatched`), `hasOpenGates` (§4.5).
```

The **server owns this** — the client never re-derives it (#7 "Consequences for #9").

### 4.3a The cast: the orchestrator, and the agents it spawned — server-side

**The database has always known exactly who coordinated and who did the work, and neither has ever appeared on screen.** The old rail named a row after its first task's title and stopped there, so the two characters a reader is actually following were nowhere at all. Both are columns:

| Screen concept | Column |
|---|---|
| **The orchestrator** | `tasks.created_by_terminal_handle` (the run's own `handle`) |
| **Its agents** | the `assignee_handle`s of that orchestrator's `dispatch_contexts` |

```
Per orchestrator, from its tasks' dispatch attempts:

1. EVERY attempt's assignee, not just the surviving one. `Task.dispatch` is
   MAX(rowid) — the latest attempt — and a retry goes to a FRESH worktree
   with a FRESH terminal handle. A cast built from the surviving attempt
   alone silently deletes the agent that failed, which is exactly the one a
   post-mortem came for.
2. The orchestrator is NEVER in its own cast. A coordinator that dispatched
   a task to itself would otherwise appear twice, and the conversation's
   notion of direction (§4.7) would have nothing left to hang on. Such a
   task simply wears no agent stripe — no agent was spawned for it.
3. MONOGRAM: A1, A2, A3 … in FIRST-DISPATCH order (the dispatch instant, not
   the task's creation — an orchestrator can create five tasks up front and
   hand them out over an hour). Ties break on the handle, so a cast cannot
   renumber itself between two polls of an unchanged database.
4. Per agent: `taskIds` (every task it ever held), `taskCount`, and
   `lastHeartbeatAt` — the latest beat ACROSS its tasks, because an agent
   beating on one task is alive whatever its other tasks say (§4.6).
```

**The monogram is the server's**, and that is load-bearing: the rail, the node's stripe and the conversation all name the same agent, and a cast numbered three times would be three castings. `term_f627dc6f-4a1b-…` is the agent's only identity in this schema and it is unreadable, unrememberable and unactionable; `A2` is the same fact in two characters.

**Selecting an agent is the tool's central gesture** — it dims the canvas to that agent's tasks and fills the conversation with that agent's half of the dialogue (§7.2, §7.5, §7.7).

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

The latest `heartbeat` message per dispatch (equivalently, `dispatch_contexts.last_heartbeat_at`, which carries the last one on the row) drives a **"last seen 12 s ago"** on the node, and — rolled up per *agent* (§4.3a) — a **"seen 12s ago"** badge in the rail's cast. The snapshot carries both. Heartbeats **never** pulse a node, and they never appear one-per-row in the conversation (§4.7).

### 4.7 The conversation: the four-source merge — server-side

**This is the substance of the tool, and the trap it turns on.**

> **When the orchestrator dispatches an agent, it writes no message.** Orca injects the prompt straight into the worker's PTY. The live database contains **zero** `type = 'dispatch'` rows (§4.2, trap 2).

So a conversation built from the `messages` table alone renders **agents talking into the void, to an orchestrator that never answers a word** — half a dialogue, and the half that makes no sense on its own. That is, very probably, the real reason the old flat feed was unreadable. And it would pass an unwitting test suite, because a tidy fixture full of `dispatch` messages makes it look correct.

The other half is in the schema. It was simply never called a conversation. **A turn is merged from four sources:**

| Turn | Reconstructed from |
|---|---|
| **The orchestrator's prompt** (`dispatch`) | `tasks.spec`, timestamped by `dispatch_contexts.dispatched_at` |
| **The agent answering** (`status`, `worker_done`, `escalation`, …) | `messages` |
| **A question and its answer** (`decision_gate`, `answer`) | a `decision_gate` message (§4.5), and the reply whose `thread_id` is that message's `id` |
| **The final report** (`result`) | `tasks.result`, timestamped by `tasks.completed_at` |

```
Rules the schema forces:

1. ONE `dispatch` TURN PER *ATTEMPT*, not per task. `dispatch_contexts` is
   one row per attempt, and a retry is a genuinely separate thing the
   orchestrator did — to a fresh worktree, with a fresh handle. Folding them
   into one turn hides the only retry story the schema has.

2. DIRECTION is "did one of this run's AGENTS say it?" — never "is the sender
   the coordinator". The synthetic `run_unattributed` has no coordinator
   handle at all, so a rule keyed on the coordinator would leave every one of
   its turns undirected. `out` = the orchestrator; `in` = an agent.

3. THE TWO TIMESTAMP FORMATS MEET HERE. `dispatch_contexts.dispatched_at` is
   SQL-format and `tasks.completed_at` is ISO (§4.2, trap 5). This merge
   orders columns written by BOTH writers against each other — the exact
   comparison that trap exists to break. Everything is normalized at the
   query boundary and compared through one comparator, which sorts an
   unreadable instant LAST rather than pretending it is the epoch.

4. EVERY JOIN TOLERATES A MISS (§4.2, trap 8). A message naming a task a
   reset deleted still becomes a turn — it just carries no `taskId`. A turn
   no run could claim (§4.4, rule 3) carries no `runId`, appears in the
   "All" scope and nowhere else, and is never guessed into somebody's thread.

5. HEARTBEATS COLLAPSE TO ONE ROW PER TASK — 302 of 466 messages, all saying
   "alive" (§4.2, trap 4). By TASK and not by adjacency: a task belongs to
   exactly one agent and one orchestrator, so a summary keyed on it is wholly
   inside every scope the panel can ask for (§7.7). It carries the count and
   the span, so the panel can say "every ~5 min" from two instants and a
   count rather than asserting a cadence nobody measured.

6. `source` — EVERY turn names the columns it was built from, on screen.
   Four of these turns are not messages. A bubble that LOOKED like a message
   the orchestrator sent, when no such message was ever written, would be the
   most convincing lie this tool could tell.
```

**Scopes** — nested, and each one is a filter over `runId` / the agent side / `taskId`. One orchestrator (the default) → one agent inside it (the central gesture) → one task (the node inspector, §7.8).

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
| `user_version < 5` (older Orca) | **Per-feature degradation.** A missing column disables exactly the feature that needs it and nothing else — e.g. no `task_title`/`display_name` (pre-v5) → fall back to the short task id for labels; no `created_by_terminal_handle` (pre-v4) → every task lands in the **Unattributed** row and the rail says so; no `last_heartbeat_at` (pre-v2) → no last-seen badge; no `dispatch_contexts.task_id`/`assignee_handle` → **no cast** (§4.3a), so no agents in the rail, no stripe on a node and nobody for the conversation to name; no `tasks.spec` → **the orchestrator's side of the conversation** goes (§4.7), and it is a *different* loss from the inspector's spec section, so it gets its own sentence; no `tasks.created_at` → **no waves**, and the orchestrator draws as one undivided burst. Report the degraded feature list in `meta.degraded` and surface it in the UI. **A feature with no entry in that list degrades silently, which is the one failure the list exists to prevent — so a new feature that reads a column outside the DAG core must add one.** |
| Unknown enum value (a new status / message type) | **Rendered in a neutral "unknown" style — never dropped, never crashed on.** An unknown `TaskStatus` gets the neutral grey node treatment and its raw string as the chip label. |
| The DAG core (`tasks.id` / `status` / `deps`) is unreadable | **Hard-fail** with an actionable message. This is the *only* hard-fail. |

### 5.1 History-loss signals (#50)

The visualizer reports **what retained history is observably missing**, not that it witnessed a reset command. A reset is not an event in this database, and several external actions can produce the same rows. The wire contract is therefore an ordered list of affected history surfaces:

```ts
type HistoryLoss = 'message-history' | 'task-graph-history'

type Meta = {
  // ...the other metadata fields...
  historyLoss: HistoryLoss[] // stable order: message history, then task graph history
}
```

This replaces the ambiguous `resetDetected: boolean`. An empty list means there is no safe history-loss claim to make. Separate values let the terminal and browser use evidence-specific wording, and leave room for both signals when a database has experienced the two reset shapes at different times.

**Message history.** Preserve the existing detector: `sqlite_sequence.seq` ahead of the surviving `messages.sequence` range, or a surviving range whose minimum is greater than 1, emits `message-history`. This is evidence that message rows once held by this database were removed.

**Task graph history.** Emit `task-graph-history` only when one coherent SQLite read observes both halves of this exact shape:

1. `tasks`, `dispatch_contexts`, `decision_gates`, and `coordinator_runs` all contain zero rows; and
2. at least one retained `messages.payload` parses as an object with a non-empty string `taskId`.

The four emptiness checks and the retained payloads must belong to the same read snapshot. Combining counts and references observed on different poll ticks could briefly announce loss while Orca is creating new work.

This is deliberately narrower than “many message task ids do not resolve.” Orphaned task references are already a normal, supported shape after an earlier reset, and a ratio threshold would keep warning forever after new work began. The task-graph signal therefore stays quiet when:

- any row remains in any of the four graph-owned tables;
- messages remain but none contains a readable, non-empty string `taskId`;
- payload JSON is malformed or its `taskId` has another shape; or
- a required table/column cannot be verified through schema introspection.

The first boundary accepts a false negative as soon as any new graph work exists. That is intentional: this signal explains the otherwise-mysterious **empty canvas beside a retained conversation**; it is not a forensic classifier for every historical reset.

Task-graph detection requires the readable DAG core, `messages.payload`, `dispatch_contexts.id`, `decision_gates.id`, and `coordinator_runs.id`. If any non-core requirement is missing, do not guess: omit `task-graph-history` and add a dedicated `meta.degraded` entry:

> Task graph history-loss detection — this Orca is missing message payloads or a graph-table identity, so the visualizer cannot safely recognize the empty-graph shape left by a tasks-only reset.

Render one notice per emitted value, using these exact evidence-first sentences in both the browser and terminal:

- `message-history`: **“Message history is incomplete: sequence gaps show that this database once held messages which are now missing. This matches an orchestration reset.”**
- `task-graph-history`: **“Task graph history is missing: the graph is empty, but retained messages still refer to tasks. This matches `orchestration reset --tasks`.”**

“Matches” is load-bearing: the database proves the loss shape, not its cause.

**Deterministic fixtures.** Extend the SQL fixture builder with a semantic tasks-only reset operation. It first writes a complete synthetic orchestration containing tasks, a dispatch attempt, a gate row, a coordinator run, and task-bearing messages; after those deterministic rows are inserted, it deletes the four graph-owned tables in the same fixture transaction and preserves `messages` and its sequence state. The primary positive fixture must start message sequences at 1 so only `task-graph-history` fires—reusing the existing sequence-gap fixture would hide a detector coupled incorrectly to message loss.

The fixture/test matrix must also pin the conservative boundary:

- an untouched orchestration emits `[]`;
- a message-sequence gap with a non-empty graph emits `['message-history']`;
- the tasks-only reset fixture emits `['task-graph-history']`;
- a sequence gap followed by the tasks-only shape emits both values in the specified order;
- an empty graph with messages but no readable task reference emits `[]`;
- any surviving row in any graph-owned table suppresses `task-graph-history`, even if every readable message reference is orphaned;
- malformed payload JSON never throws and is not evidence; and
- a fixture missing any required non-core column suppresses the signal and names the degraded detector.

Client and boot-output tests assert the exact sentence for each value and both sentences when both values are present. These fixtures model rows and operations; they never depend on wall-clock time, random identifiers, or a committed copy of a real database.

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

> **The snapshot omits the `spec` and `result` bodies.** A live 71-task dump was **172 KB, almost entirely spec text**. They are fetched on demand by `GET /api/task/:id` when a node is clicked (#8 §3).
>
> **The conversation carries a capped *preview* of each — 240 characters — and says when it cut one.** The prompt an agent was dispatched with is `tasks.spec` and nothing else records it (§4.7), so the conversation cannot omit it outright; and a 400px bubble was never going to show 3 KB of agent prompt anyway. The preview is sliced **in SQL** (`substr`), so the other 3 KB never crosses the SQLite boundary, let alone the wire.
>
> **What that defence is actually protecting** is the thing that grows *without limit*: `spec` is whatever a person typed at their agents. The conversation grows with the **row count** of a database that holds 76 tasks and 466 messages — which is why it is allowed on a snapshot that is re-sent whole, and 172 KB of prompt text is not. Measured on the live-shaped corpus: **~221 KB of snapshot, of which ~147 KB is the conversation** (~360 turns). It is a budget, and a feature that grows it has to come and say so here — as this one has (`test/server/tasks.test.ts`).

**Message feed → incremental append** (`sequence > lastSeen`). This is the one place a delta is both cheap *and correct*, because message rows are immutable once written. `messages.read` / `delivered_at` are mutable flags on otherwise-immutable rows — **we do not render them** (internal mailbox bookkeeping, not orchestration semantics), so their mutability never bites (#8 §3).

**One event type.** Every push — first connect, normal tick, reconnect — has the same shape:

```ts
type StreamEvent = {
  seq: number            // message high-water mark; also the SSE event id
  meta: Meta
  snapshot: { runs: Run[]; tasks: Task[]; gates: Gate[]; turns: Turn[]; coordinatorRuns: CoordinatorRun[] }
  // The append-only delta. It is no longer what the dock renders — that is `turns` — and what it
  // is still for is the one thing a snapshot cannot say: WHAT JUST ARRIVED, which is what flashes
  // a node (§7.6).
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
  historyLoss: HistoryLoss[]                 // evidence-specific, stable order (§5.1)
}

type Run = {                                 // AN ORCHESTRATOR, and everything it dispatched — §4.3
  id: string                                 // run_<handle> | run_unattributed. The handle ALONE.
  handle: string | null                      // the orchestrator itself; null on the synthetic row
  label: string                              // earliest task's title
  startedAt: string; endedAt: string         // ISO
  taskCount: number
  cast: CastMember[]                         // the agents it spawned — §4.3a
  waves: Wave[]                              // its bursts of work. Always ≥ 1 — §4.3
  statusCounts: Record<TaskStatus, number>
  live: boolean
  hasOpenGates: boolean
  edgeCount: number                          // 0 ⇒ the edgeless empty state (§7.5)
}

type CastMember = {                          // §4.3a
  handle: string                             // dispatch_contexts.assignee_handle
  monogram: string                           // A1, A2, A3 — first-dispatch order, the SERVER's
  taskIds: string[]                          // EVERY task it held, retries included
  taskCount: number
  lastHeartbeatAt: string | null             // the "seen 12s ago" badge (§4.6)
}

type Wave = {                                // the six-hour rule, made visible — §4.3
  index: number                              // 1-based: "Wave 2"
  startedAt: string; endedAt: string         // ISO
  taskIds: string[]
  idleGapBeforeMs: number | null             // null on the first — nothing precedes it
}

type Turn = {                                // THE CONVERSATION — the four-source merge, §4.7
  id: string                                 // msg:<seq> | dispatch:<ctxId> | result:<taskId> | beats:<key>
  runId: string | null                       // null ⇒ nothing in the schema places it (§4.4 rule 3)
  direction: 'out' | 'in'                    // out = the orchestrator; in = an agent
  kind: string                               // dispatch | result | answer | heartbeats, or the
                                             // message's own `type`, verbatim (§5)
  fromHandle: string | null; toHandle: string | null
  at: string                                 // ISO. '' ⇒ the column held no readable instant
  taskId: string | null
  subject: string
  body: string                               // a dispatch/result body is a 240-char PREVIEW
  source: string                             // the columns it was reconstructed from — RENDERED
  // Absent when default — the snapshot is re-sent whole every tick, and 75 bytes of nothing on
  // 360 turns is 27 KB of nothing:
  truncated?: boolean                        // body was cut; the inspector has the rest
  options?: string[]                         // a gate's options
  answer?: string                            // the reply that threaded on it; absent ⇒ still open
  beatCount?: number; endedAt?: string       // a `heartbeats` row: how many, over what span
  // The AGENT side of the turn is DERIVED (`agentOfTurn`), never carried: it is always one of the
  // two handles already here, and a third copy of a uuid in an object re-sent every five seconds
  // is 21 KB per push to save one line of arithmetic.
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

Bodies in the message log are small (subjects and short bodies); ship them. `spec`/`result` are the only heavy fields, and the conversation takes 240 characters of each (§4.7).

### 6.4 HTTP surface & config (#8 §4)

| Route | Purpose |
|---|---|
| `GET /` + `/assets/*` | The pre-built frontend, served from the package's `dist/` |
| `GET /api/stream` | SSE (§6.2). Honors `Last-Event-ID`. |
| `GET /api/task/:id` | Lazy detail: the **full** `spec` and `result`, and **all** `dispatch_contexts` rows ordered by `rowid` (not just the latest — #7 §8). It no longer carries the task's messages: that list was *the half of the exchange that got written down*, and `snapshot.turns` filtered by `taskId` carries all four sources of it (§4.7). A second copy of a truth is a second copy that can disagree with the first. |
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

Stack: **React + Vite + TypeScript**, **React Flow (`@xyflow/react`)** for the canvas, **elkjs** for layout, **Tailwind + shadcn/ui** for everything that is not the canvas, and **`motion`** for the movement §7.9 spends its budget on. React Flow is **locked** (#6): 76 custom nodes plus a minimap pan and zoom smoothly at real scale; it is not a bottleneck and needs no perf work. Dev runs Vite with a proxy to the server; the shipped artifact is the pre-built `dist/` the server serves (#8 §4).

Every dependency here is bundled at build time and **none of them is a runtime dependency** — `dependencies` is empty and stays empty, because `npx orca-viz` promises nothing to install and nothing to compile (§8). A shadcn component is *this repo's source file* (`src/client/components/ui/`), not an import, which is the entire reason it is allowed in a package that ships zero deps.

**The palette is CSS, not TypeScript** (`src/client/index.css`). The six status colours of §7.5 are the signed-off hexes, verbatim, as custom properties — and `.dark` redefines the *fill* and the *ink* of each while keeping the **accent**, so a green node is one green in both themes and the canvas, the feed chips and the inspector cannot drift into two palettes. `canvas/theme.ts` is the only seam that hands them out: Tailwind class strings for anything Tailwind can paint, and a `var(--…)` value for the three places that need a colour and not a class — React Flow's minimap fill, the box-shadow of a message pulse (§7.6), and the conic ring of a node with an agent working inside it (§7.9).

### 7.1 Layout composition: three zones, four panels (#7 §4)

```
┌──────────────────┬──────────────────────────────────────────┬─────────────────────┐
│  ORCHESTRATORS   │  ⚠ GATE STRIP (only when open gates exist)│   RIGHT DOCK        │
│                  ├──────────────────────────────────────────┤   one panel, swaps: │
│  ● label         │              DAG CANVAS                   │                     │
│    term_2ffffb19 │        (exactly one orchestrator)         │   • CONVERSATION    │
│    N agents · …  │                                           │     (default)       │
│  ● label ◄ open  │   ┌ Wave 1 ┐      ┌ Wave 2 · after 14h ┐  │     ⇕               │
│    THE CAST      │   │ ── elkjs, TB ─┤ ── elkjs, TB ──    │  │   • NODE INSPECTOR  │
│      ◇ orchestr. │   │ ── isolated ──┤ ── isolated ───    │  │     (on selection)  │
│      A1 agent 1  │   └────────────┘  └────────────────────┘  │                     │
│      A2 agent 2  │                                           │                     │
└──────────────────┴──────────────────────────────────────────┴─────────────────────┘
```

- **Left rail** — the list of **orchestrators**, with **the cast nested under the open one** (§7.2).
- **Centre** — the DAG canvas, showing **exactly one orchestrator**, in **waves** (§7.5).
- **Right dock** — **one** panel that *swaps*: the **conversation** (default, §7.7) ⇄ the **node inspector** (on node selection, §7.8). Not both stacked — at this node count the canvas deserves the width.
- **Gate strip** — above the canvas, appearing **only** when the selected orchestrator has unresolved gates. Gates *block* an orchestration; they must interrupt, not sit in a tab you forget to open. It is not a standing panel.
- **Agent roster — no longer cut, and no longer a roster.** #7 cut it because everything it would show was already on the node badge. What it could not see then is that the *agent* is the pivot the whole screen turns on, and that "which of these nodes are A2's" is a question the badges could never answer without you reading eight hex on every card. So it is not a panel: it is the **cast**, nested under the orchestrator that spawned it, and clicking a member re-scopes the canvas *and* the dock at once.

### 7.2 The orchestrator rail, and the cast (#7 §1, §3; §4.3, §4.3a)

Header: **"Orchestrators."**

It used to read *"Runs (inferred)"*, and it had to: a row **was** a guess, because the six-hour idle gap cut one terminal's tasks into several unrelated rows. The gap is now a **wave** on the canvas (§4.3), one terminal is one orchestrator, and there is nothing inferred about a column. The admission is retired because the thing it was admitting to is gone.

A row is:

```
● <earliest task's title, bold>                       [green dot if live] [⛔ if blocked]
  term_6ffbd32d-4b14-3a39-4182-a139ace0f47f
  Jul 11, 20:54 · 2 agents · 8 tasks · 6 done / 1 failed
```

The **handle is on the row**, not only in the tooltip: it is the orchestrator's *name* — the one identity it has anywhere in the schema — and a rail that lists orchestrators and never shows one has not quite said what it is listing. Rows sort by most-recent activity. The synthetic **"Unattributed"** row is a normal row, labelled as what it is.

**The cast nests under the open row** (§4.3a) — nested, and not in a fourth column, because the hierarchy is *real*: an orchestrator **contains** its agents, and a list beside it would state no relationship at all.

```
THE CAST
  ◇  The orchestrator     term_6ffbd32d-…            ← not a button: the whole canvas is already its
  A1 Agent 1              fd18853c        7 tasks
  A2 Agent 2              a38d266c        seen 12s ago   ← the badge replaces the count only while
                                                            the agent is *recently* alive (§4.6)
```

**Selecting an agent is the tool's central gesture.** One click: the canvas dims to that agent's tasks (§7.5), and the conversation fills with that agent's half of the dialogue (§7.7). Two panels, one movement. Clicking it again lets go — the way out is where the way in was. Changing orchestrator drops the selection: an `A1` in one orchestration is a different terminal from the `A1` in the next.

**On open, the most recently active orchestrator is auto-selected** (#7 §1). **Not an all-tasks view** — dumping all 76 tasks at once is exactly what produced the unusable ~50-wide singleton ribbon in #6.

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

  **The three hexes are locked; the word "border" in that table is not.** A node is no longer *outlined* in its status — a coloured rectangle drawn all the way around a coloured fill is three ways of saying one thing, and the loudest of them is a hard edge closing the card off on the side furthest from anything you read. The accent column is now painted as a **spine**: a soft, glowing bar of it down the left of the card, with the colour bleeding rightwards and running out before the far edge. The card is held together by its fill, a 1px top sheen and a shadow — the way a lit object is. Nothing about *which* hex a status wears has changed, and a node is still found by colour from across a 76-node run, because that was never the border's job: it was the fill's. The accent is still a real border wherever a **chip** wears the same token (the feed, the inspector), which is why it stays in `theme.surface`.

  Consequently a node carries **no outline at all** unless it is *selected* — which is exactly what makes the selection outline legible (§7.9).

- **The agent: a 4px stripe and a monogram** (§4.3a). Two colour systems want this card — what state the work is in, and who did it — and **they cannot both win the same pixel**. So they take different channels: the **status keeps the fill** (those six hexes were signed off on screen, and retuning them to make room is re-approval, not refactoring), and the **agent takes the left stripe and an `A1` badge**, in a palette nothing else on the card was using (four hues, cycled). A canvas legend says it in five words: *fill = status · stripe = agent*.

  This **replaces** the eight-hex assignee chip. That chip was the loudest object on the card, for a value you cannot read, cannot remember and would not act on — and, worse, it was the agent's *only* name, so "the failed node and the open gate are the same agent" was a fact you had to work out by comparing two strings of hex. `A2` is one glance, it is the *same* `A2` in the rail and in the conversation, and the handle rides in the tooltip in full. `✗N` stays, at the end of the row, when `failureCount > 0` (the breaker trips at 3): the monogram is *who*, and that is *how badly it is going*.

  A task with **no agent** wears a faint stripe and no badge. Three true things come out the same way and all three are right: it was never dispatched, its dispatch names no assignee, or the orchestrator worked it itself — and in none of them was an *agent* spawned for the work.

- **Dimming — the central gesture** (§7.2). While an agent is selected, every node that is not theirs fades to ~18%. **Faded, never hidden:** the shape of the orchestration survives the filter, so you can see *where* your agent's work sat inside it, which is the entire difference between focusing a canvas and emptying one. An edge dims unless **both** its ends are lit. (It is a motion state and not a CSS class, and that is not taste: the entrance animation writes `opacity: 1` into the inline style, and an inline style beats a class — a dim expressed as a class is silently overridden and the canvas never fades at all.)

- **Waves — the six-hour rule, made visible** (§4.3). When an orchestrator worked in more than one burst, each is drawn in its own dashed region, captioned *"Wave 2 · after 14h idle"*. **The layout is partitioned, not merely captioned:** elkjs lays a graph out by its *dependencies*, so asking it to lay out both waves at once interleaves their nodes and a border round the result is a border round the whole canvas. Each wave is laid out on its own and the blocks are set down left to right in time order — which is the axis a wave actually means. A dependency crossing from one wave into the next still draws, as a long line between two blocks: that is exactly what "we picked the work up again 14 hours later, from where we stopped" looks like. **One wave ⇒ no region at all** — there is no boundary to point at, and a box round everything is furniture.
- **Last-seen badge** — `"last seen 12s ago"` from `dispatch.lastHeartbeatAt`, **going stale-amber past a threshold** (#7 §7). *Spec-level default: 10 minutes*, i.e. 2× the 5-minute heartbeat cadence Orca instructs its workers to keep; make it a constant, not a magic number. Shown only while the dispatch is `dispatched`.
- **Gate marker** — orange `⛔ gate` badge when the task has an open gate (§4.5).
- **Retry marker** — surface `attemptCount > 1`; it is the only visible sign of a retry, and no task has retried in real data yet, so it must be right the first time it happens.

**Edges:** dep edges from `deps`, arrowheads, **dashed + animated into `dispatched` nodes**. These are a **status affordance, never message flow** (#7 §6) — keeping them is what makes the message-flow rejection safe, because the canvas still moves when work is in flight.

### 7.6 Message flow: node pulse **yes**, edge animation **rejected** (#7 §6)

The map's fog item ("animation along DAG edges") is resolved as **no**, on evidence rather than taste:

> **Messages are a star between *handles*; dep edges connect *tasks*.** A `worker_done` travels worker-terminal → coordinator-terminal. It does **not** traverse the edge from task A to task B. Animating it along a dep edge would render a flow that does not exist. And the data agrees about where messages *do* belong: **83 % carry `payload.taskId`** — they attach to **nodes**, and **none** attach to an edge.

So instead:

- **Node pulse:** a message that has **just arrived** briefly flashes **the node it names**, in its type's colour — `worker_done` **green**, `escalation` **red**, `decision_gate` **orange** (the gate colour, which is deliberately *not* the amber a `dispatched` node wears: amber is work in flight, and a gate is the exact opposite of that). *Spec-level default: ~1 s.* Heartbeats **never** pulse, and neither does a reconstructed `dispatch` or `result` — those are readings of columns the file has always held, not events that *arrived*, and a node cannot flash at the moment a row was read.
- **This is the whole remaining job of `StreamEvent.messages`** (§6.3). The conversation is re-derived whole on every push, so nothing on the page has to *remember* a message — except this: which of these rows landed a second ago is the one thing a snapshot, being a photograph, cannot tell you.
- **Conversation ↔ node bidirectional linking** — the real payoff: **click a turn → its node highlights and centres; select a node → the dock swaps to that task's story, exchange included (§7.8).**

### 7.7 The conversation, and heartbeats (#7 §7; §4.7)

**The dock's default panel is the conversation, not a feed.** The feed was the `messages` table as a flat list of rows, and it was wrong twice over:

1. **It was half a dialogue.** The orchestrator writes **no message** when it dispatches (§4.2, trap 2), so the panel showed agents reporting back to an orchestrator that never said a word to them. The merge (§4.7) is what makes it whole.
2. **A flat list cannot show who is talking to whom.** A message has a sender and a recipient, and that is the one thing a reader actually wants from a conversation.

- **The orchestrator on one side, its agents on the other.** `out` right, `in` left. That layout *is* the argument: put the two speakers on two sides and "who is talking to whom" is legible without being read.
- **Oldest first.** A conversation is a *story*; the feed read newest-first because it answered "what just happened", and that question is now the canvas's — a node flashes when it does (§7.6).
- **A gate and its answer sit together**, threaded on `thread_id` (§4.5). The options show, and the one the answer names is ticked; an unanswered gate says **"waiting for an answer"**, which is why the run is stopped.
- **Every turn carries its `source`** — the columns it was reconstructed from, in small grey type under the bubble. Four of these turns are not messages, and a bubble that pretended otherwise would be a lie. This is not a footnote; it is the point.
- **Heartbeats collapse to one line per task** — 302 of 466 messages, all saying "alive". *"18 heartbeats · every ~5 min"*, with the cadence **measured** from two instants and a count rather than read off Orca's documentation. There is no "show heartbeats" toggle any more, and nothing is hidden: the two hundred rows the line replaces all say the same word, and their value — *liveness* — already reached the screen as the last-seen badge (§4.6).
- **Scope: "This orchestrator" (default) / "All."** An agent selected in the rail narrows it further. "All" is not a convenience: a turn the server could not place belongs to no orchestrator (§4.4, rule 3), and it must still **appear, attached to nobody**, rather than be guessed into somebody's thread.
- A turn whose `taskId` does not resolve to a live task (post-reset orphan — §4.2, trap 8) still renders, simply unlinked. `read` / `delivered_at` are **not rendered** (#8 §3).

### 7.8 The node inspector (#7 §8)

Node click swaps the right dock. It is exactly what `GET /api/task/:id` exists for. Top to bottom:

1. **Header** — `task_title`, status chip, **copyable `task_id`** (§7.9 — and it is not the only id in the panel that copies: so do the assignee's handle on each attempt, and the id of every gate the task raised).
2. **Spec** (the full dispatch prompt) and **result** receipt — lazy-fetched on click, and **in full**: the conversation below shows the first 240 characters of each (§6.3), and this is where the rest of them are.
3. **Dispatch attempt history** — **all** `dispatch_contexts` rows for the task ordered by `rowid`, **not just the latest**: assignee, status, dispatched/completed times, `failure_count`, `last_failure`. This is the only genuinely append-only per-task history in the schema, and the only place a retry / circuit-breaker story ever becomes visible.
4. **The exchange** — this task's slice of the conversation, oldest first (§4.7), rendered with the same turn component the dock uses. It **replaces** the flat list of messages that used to sit here, and the upgrade is the whole feature: that list was *the half of the exchange that got written down*. The prompt the agent was dispatched with, the orchestrator's answer to a gate and the final receipt are not messages at all, so they could never have appeared in it. It comes from the **snapshot**, so a failed `GET /api/task/:id` costs the two bodies and the attempt history and leaves the conversation readable.
5. **Gate Q&A** — derived from `decision_gate` **messages** (§4.5).
6. **Deps in / out** as chips that select the neighbour node.

### 7.9 The visual language: a field, panels on it, and motion that means something

§7.1–§7.8 fix **what is on screen**. This fixes **what it looks like**, and it changes nothing above: the six status hexes, the elkjs/top-down layout and the 240 × 84 node are exactly as §7.5 locked them. What changed is the chrome around them.

**Borders are for chips, not for cards.** The shell was four regions divided by 1px rules, and every task node was a rectangle outlined in its own status. Both are gone. A *card* — a panel, a task node — is now defined by **fill, a top sheen and a shadow**; the only hard edges left on the canvas are the two that *mean* something, and they are the selection outline (§7.5) and the turning ring of a node with an agent inside it. A **chip** still wears a border, because a chip is small enough that a border is its shape.

**Every identifier Orca wrote is one click from the clipboard** (`src/client/copy.tsx`). The tool is read-only (§1.2), so everything a person *does* with what they read here happens in `orca orchestration` — and every one of those commands takes an id. So the id of the task in the inspector's header, the handle of an orchestrator, of each of its agents, of the terminal that held a dispatch attempt, and the id of a decision gate (in the strip **and** the inspector — a run-level gate opens no inspector at all, and 32 of the 53 live ones name no task) each carry a copy affordance: the header's shows the id and *is* the button; the rest are an icon beside a value the row already shows shortened, quiet until the row is hovered and always reachable by keyboard. **The ids this tool invented are not copyable** — `run_<handle>`, `msg:<sequence>`, `dispatch:<contextId>` are ours (§4.3, §4.7) and no `orca` command has ever heard of one; offering them would be offering a string that looks like an id and works nowhere.

**A field, with panels standing on it.** It is now a **field** (dark, a 32px grid at ~4% opacity, a soft glow above the work) with **panels** floating on it: rounded, translucent, hairline-bordered, lifted by a shadow, separated by a gap the field shows through. The tokens are `--field`, `--panel`, `--panel-border` and a three-step `--lift-*` scale, and the one class every panel wears is `PANEL_CLASS` (`src/client/surface.ts`). No layout moved to get this; it is a border, a radius and a shadow.

**Motion is a channel, and it is spent on meaning — not on arrival.** The rule the whole system is built on:

> **If it moves, it is happening.**

Which buys exactly three gestures, and forbids a fourth:

| Gesture | Means | Where |
|---|---|---|
| **A conic ring, turning** | *An agent is inside this node right now* | The `dispatched` node, and **nothing else in the tool** — a second spinning thing would make this one read as "decorated" instead of "working" (`ALIVE_STATUS`, `.orca-alive`) |
| **A radar ping** | *This is not finished* | The liveness pill, and a live run on the rail — one `RadarDot`, so learning it in one panel teaches it in the other. Not on the node: the node says it by *spinning*, and a card that pinged **and** spun would be shouting the same word twice |
| **An aurora, drifting** | *A question is unanswered* | The gate strip, and only the gate strip. Slow (19–25 s), because it must stay bearable for as long as the gate stays open, which on a real database is hours |

Everything else on the page **holds perfectly still**, which is what makes those three worth looking at. A glow is the static half of the same budget: only `dispatched` and `failed` nodes carry one, because they are the two a person scanning 76 nodes is actually hunting for, and a canvas where every node glows is a canvas with a haze on it.

**Entrances are short, and they never gate a fact.** Panels, nodes and feed rows arrive with one calm spring (nodes stagger, capped at 280 ms however big the run). New messages land at the top of the feed and *push* the rest down (`layout`) — the one place you can watch an orchestration happen. Rows that **leave** leave instantly: a heartbeat toggle is a filter, not an event, and animating a filter is animating the user's own click back at them.

**Every entrance goes through `enter()`** (`src/client/motion.ts`). An entrance starts at `opacity: 0`, so anything that turns animation off has to be able to say so *before the first paint* — otherwise the panel is simply invisible. `enter()` reads `MotionGlobalConfig.skipAnimations` and hands motion `false` instead of a starting state, so the tool renders finished, on frame one. That is what the suite runs against (`test/client/setup.ts`), and it is why a reader who kills animation gets a working tool rather than an empty one. Transform-driven motion additionally respects `prefers-reduced-motion` through one `<MotionConfig reducedMotion="user">` at the top of `<App>`; the CSS keyframes respect it through one media query in `index.css`.

**`motion` is a devDependency, like everything else here** — bundled at build, ~100 KB raw on top of React Flow and elkjs, and still zero runtime dependencies (§7 preamble, §8).

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
- **Versioning: independent semver, pinned to nothing, starting at `0.x`.** We are an outside observer and do not track Orca's version numbers. **There is no compatibility table.** The README used to carry one, hand-maintained, a row per orca-viz release — and every row said the same thing, because the fact only changes when *Orca's* schema moves. A table that grows on every publish while restating one unchanged fact is a maintenance tax on the author and noise for the reader, and the reader it was written for does not exist: the README says `npx orca-viz@latest`, so nobody is sitting on an old build wondering what it supports. Compatibility is a **runtime** answer, not a documented one — render-what-parses (#5 §3) already introspects the columns and banners exactly what this build could not find in *your* database, which is more precise than any row we could have written in advance.

- **The README must say, up front and unambiguously:** this is an **unofficial, third-party, read-only** tool, **not affiliated with Stably or Orca**, that **never writes to the database**; it reads Orca's **internal, undocumented** schema, so **a minor bump may be required after an Orca update**. *"Some npm package touches my app's database"* deserves an honest paragraph on day one rather than an apology later.

---

## 10. Definition of done (MVP)

The MVP ships when, against a real `orchestration.db`:

1. `npx orca-viz` on a machine with Orca installed discovers the DB, starts on `127.0.0.1:4269`, and opens a browser.
2. **The rail lists orchestrators** — one row per `created_by_terminal_handle` — most-recent auto-selected, with a live badge when Orca is running, and **the cast of the open one nested under it** (§4.3a).
3. **Selecting an agent dims the canvas to its tasks and fills the conversation.** This is the tool's central gesture, and it is what the whole screen is for.
4. The canvas renders that orchestrator's DAG — elkjs, TB, status colours, **agent stripe + monogram**, last-seen badges, dep edges animated into `dispatched` — handles an **edgeless run** with the ordered grid and its one-liner, and draws a **captioned wave region** wherever the terminal went quiet for more than six hours (§4.3).
5. **The conversation shows both sides** (§4.7): the orchestrator's dispatch prompt, the agent's replies, a gate and the answer threaded on it, and the final result — each turn naming the columns it was reconstructed from, and heartbeats collapsed to one line.
6. Clicking a node opens the inspector with the full spec, the result, **every** dispatch attempt, **that task's exchange**, and any gate.
7. A run with an open gate shows the gate strip — **populated from `decision_gate` messages**.
8. Closing Orca flips the badge to **stale** with an honest "last-known state from …" line, and **everything else keeps working**.
9. Pointing it at a DB with a different `user_version` does not crash it — and a missing column costs **exactly** the feature that needed it, by name (§5): the cast, the orchestrator's side of the conversation and the waves each have their own entry in the degradation contract.
10. A tasks-only reset that preserves task-bearing messages reports `task-graph-history` and explains the empty graph without relying on a message-sequence gap; ordinary orphaned task references in a non-empty graph do not trigger it (§5.1).

---

## 11. Open questions

**None.** Every question raised by the map is closed by a ticket resolution:

- Data source → #5 (SQLite-only).
- Rendering feasibility and engine → #6 (React Flow + elkjs, proven at real scale).
- Run scoping, panels, history browsing, message-flow animation → #7 (all nine sub-decisions).
- Poll/transport/payload/config/install/OSS → #8 (all six sub-decisions).
- The two graduated fog items — **history browsing** and **message-flow animation** — were both resolved in #7 (§5, §6).

Three places in this document fill a mechanical gap the tickets did not need to reach, each marked **spec-level** inline and none of them re-litigating a ruling: the message-attribution tie rule (§4.4), the additive merge of `decision_gates` rows when they exist (§4.5), and the concrete numbers for the heartbeat-stale threshold and pulse duration (§7.5, §7.6). An implementer may change these without reopening a ticket. **Everything else is locked.**
