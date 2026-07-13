# SPEC — `orca-viz`

**A read-only web visualizer for Orca's orchestration database.**

Status: **MVP locked; live-supervision extension and post-mortem roadmap approved.** Sections 1–11 are the implementation-ready MVP specification produced by the wayfinder map ([#1](https://github.com/nvergez/orca-viz/issues/1)). The multi-session live-supervision extension was approved from roadmap [#51](https://github.com/nvergez/orca-viz/issues/51), and the quantitative post-mortem roadmap from [#52](https://github.com/nvergez/orca-viz/issues/52); neither reopens the MVP's read-only or render-what-parses invariants, and where one deliberately refines an MVP decision, that extension governs its own scope. Every decision traces to an issue, and an implementation session should be able to work one child ticket from this document alone, without reopening product scope.

Post-MVP amendments are normative where they explicitly supersede the locked MVP contract. The run-health amendment replaces the `Run.live` and `endedAt` semantics with an additive, compatibility-preserving run-health model.

> **Note (integration):** three approved extensions each landed a section numbered `## 12.` — run health (#48), live supervision (#51) and the post-mortem roadmap (#52). All three are normative; the duplicate numbering was an artifact of parallel authorship, and a renumbering pass has since resolved it into §12, §13 and §14 without dropping a section.

**Reading order for the implementer:** this document, start to finish. [`docs/reference/orca-db-schema.md`](./docs/reference/orca-db-schema.md) is verified ground truth about Orca's DB — do not re-derive it, look it up. The three research docs under [`docs/research/`](./docs/research/) are the evidence behind the rulings; consult them when you need the `file:line` citations, not to make decisions.

| Source | What it settles |
|---|---|
| [`orca-db-schema.md`](./docs/reference/orca-db-schema.md) | The DB exists, is safely readable from outside, and its v5 schema |
| [#2](https://github.com/nvergez/orca-viz/issues/2) · [`db-history.md`](./docs/research/db-history.md) | What history the DB retains; run inference; the enum traps |
| [#3](https://github.com/nvergez/orca-viz/issues/3) · [`db-discovery.md`](./docs/research/db-discovery.md) | Cross-platform DB discovery; WAL read-only rules |
| [#4](https://github.com/nvergez/orca-viz/issues/4) · [`cli-data-source.md`](./docs/research/cli-data-source.md) | Why the `orca` CLI is not the data source |
| [#5](https://github.com/nvergez/orca-viz/issues/5) | Data access: SQLite-only, `node:sqlite`, render-what-parses |
| [#6](https://github.com/nvergez/orca-viz/issues/6) · [`prototype/`](./prototype/) | Rendering: React Flow + elkjs, proven at real scale |
| [#7](https://github.com/nvergez/orca-viz/issues/7) | UI composition: run scoping, panels, history, message flow |
| [#8](https://github.com/nvergez/orca-viz/issues/8) | Server architecture, config surface, install story, OSS extras |
| [#48](https://github.com/nvergez/orca-viz/issues/48) | Post-MVP run convergence, activity evidence, health states, and wire migration (§12) |

---

## 1. Goal & non-goals

### 1.1 Goal

`orca-viz` renders **Orca's live and historical multi-agent orchestration** — the task DAG, who is working what, decision gates, and the message flow — by reading `orchestration.db` from outside the Orca app, strictly read-only (#1).

The user story: *`npx orca-viz` in a terminal, browser opens, and I can see what my agents are doing right now — and what they did yesterday.*

It is an **unofficial, third-party, shareable OSS tool** for any Orca user (#1): cross-platform, schema-tolerant, with an install story. It is not a personal one-machine script.

### 1.2 Hard invariants

These are not preferences. Violating any of them is a bug, not a trade-off.

1. **Never write to `orchestration.db`.** Every connection opens `readOnly: true` (#5). Orca's coordinator assumes it is the single writer and maintains invariants (e.g. `pending → ready` promotion) inside its own transactions (`docs/reference/orca-db-schema.md`).
2. **No mutations of any kind** — no gate resolution, no dep editing, no retries, no marking messages read (#1). Note that `orca orchestration check` *mutates* (`read = 1`); nothing in this tool may go near it (#4).
3. **Never crash on schema drift.** Render what parses (#5, §5 below).
4. **Loopback-only by default.** The DB contains task specs, agent prompts, and message bodies (#8, §6.4).

### 1.3 Non-goals (out of scope for the MVP)

From the map's Out of scope (#1) and the decision tickets:

- **Any mutation or action** — ruled out during charting to keep the tool trivially safe against a live orchestrator (#1).
- **A recorder/replay component** capturing history beyond what the DB itself stores (#1). We show what the rows retain; we do not build a shadow event store. Section 12 approves only a user-triggered archive of one selected run's rows retained at export time; it does not record past or future events.
- **Upstreaming into Orca** — this is a standalone external tool (#1).
- **Any dependency on the `orca` CLI or the running app.** Zero CLI spawns in the MVP; the tool works identically post-mortem with Orca closed (#5, #7 §2).
- **Authoritative repo/project grouping in the navigation.** The dev asked for it in #6 and, on evidence, **declined the narrow re-open** in #7 §2: no repo/worktree/path column exists anywhere in the DB (the file is global per machine, mixing every repo), and the only authoritative enrichment considered — `orca terminal list` — resolves just *2 of 12* historical handles because terminal handles are ephemeral and never persisted (#7 coordinator note). Section 12 permits only explicitly uncertain, provenance-bearing repo hints from retained task evidence; hints never define run identity or primary navigation.
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

Ground truth is [`docs/reference/orca-db-schema.md`](./docs/reference/orca-db-schema.md) (tables, columns, enums) and #2 (what the rows actually contain in practice). Restated here only where the visualizer must act on it.

### 4.1 The five tables

| Table | Role in the visualizer |
|---|---|
| `tasks` | DAG nodes. `deps` is a **JSON string array of task ids = the edges**. `parent_id` = decomposition hierarchy. `created_by_terminal_handle` = the run key (§4.3). |
| `dispatch_contexts` | Task → agent assignment. **One row per dispatch *attempt*** — the only genuinely append-only per-task history in the schema. `MAX(rowid)` = latest attempt (the source's own queries do this). Circuit breaker trips at `failure_count = 3`. |
| `messages` | The event log. `sequence` (AUTOINCREMENT, gap-free) is a total order and the poll cursor. Immutable content. |
| `decision_gates` | **Empty in practice** — see the trap in §4.2. |
| `coordinator_runs` | **Empty in practice** — written only by Orca's built-in `Coordinator` loop, which agent/CLI-driven coordination never uses. Read it and render it if rows exist; do not depend on it. |

Enums (`docs/reference/orca-db-schema.md`): `TaskStatus` = `pending | ready | dispatched | completed | failed | blocked`; `DispatchStatus` = `pending | dispatched | completed | failed | circuit_broken`; `MessageType` = `status | dispatch | worker_done | merge_ready | escalation | handoff | decision_gate | heartbeat`; `GateStatus` = `pending | resolved | timeout`; `CoordinatorStatus` = `idle | running | completed | failed`.

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
9. **A message-only ask timeout is not persisted.** `timeoutGate()` has no callers outside tests, and `orchestration.ask` returns `timedOut: true` without writing that fact. Therefore a reply-less message proves only **unanswered**, never timeout or blocking by itself. A `decision_gates.status = 'timeout'` row is nevertheless authoritative when present and must remain a distinct terminal state (#45).
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
6. Derived per run: startedAt, `lastActivityAt`, convergence, task count,
   per-status counts, the CAST (§4.3a), the WAVES, and `hasBlockingGates` (§4.5).
   Run health and the deprecated compatibility fields are defined in §12.
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
- **One gate, two records:** when a message and `decision_gates` row share `(task_id, question)`, they are a **gate twin** and must merge into one gate. Retain the message identity, attribution, question, and options; take lifecycle status and resolution from the row. The row is not discarded merely because the message was read first (#45).
- **Lifecycle state is not blocking effect.** `Gate.status` records one of four facts: a table row's `pending`, `resolved`, or `timeout`, or `unanswered` when a message has neither a threaded reply nor a matching row. A threaded reply makes a message-only gate `resolved` and supplies its body as the resolution. Never infer `timeout` from age or the absence of a reply: `orchestration.ask` does not persist its timeout result (#45).
- **Blocking is explicit and conservative.** A table-backed `pending` gate is blocking. `resolved` and `timeout` are terminal and non-blocking. An `unanswered` ask is non-blocking by default; it is blocking only while it names an existing task whose authoritative current `tasks.status` is `blocked`. Task-less, orphaned, and finished-run unanswered asks stay visible in history and conversation but raise no strip, node marker, run flag, or alert (#45).
- **Table-only gates remain additive.** If a `decision_gates` row has no matching message, add it. Messages remain the primary source because CLI-driven asks may never create rows; table state is authoritative when a row exists. This preserves both real database shapes without treating either source as mutually exclusive.

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
> **The conversation carries a capped *preview* of each — 240 characters — and says when it cut one.** The prompt an agent was dispatched with is `tasks.spec` and nothing else records it (§4.7), so the conversation cannot omit it outright; and a 400px bubble was never going to show 3 KB of agent prompt anyway. The **spec** preview is sliced **in SQL** (`substr`), so the other 3 KB never crosses the SQLite boundary, let alone the wire. The **result**, since the outcome receipts of §12.4 (#67), is read whole *into the process* — a receipt sliced to a preview is malformed JSON and recognizes as nothing — but what reaches the wire is still only its 240-character preview plus the capped recognized facts. The asymmetry is the honest one: `spec` is the unbounded column (the 172 KB dump was almost entirely spec text); `result` is the receipt a worker handed back.
>
> **What that defence is actually protecting** is the thing that grows *without limit*: `spec` is whatever a person typed at their agents. The conversation grows with the **row count** of a database that holds 76 tasks and 466 messages — which is why it is allowed on a snapshot that is re-sent whole, and 172 KB of prompt text is not. Measured on the live-shaped corpus: **~245 KB of snapshot, of which ~170 KB is the conversation** (~360 turns, ~24 KB of it the compact receipts of §12.4, capped per turn). It is a budget, and a feature that grows it has to come and say so here — as those have (`test/server/tasks.test.ts`).
>
> **The opt-in live enrichment (#61) also grows it, and says so here:** one `StreamEvent.enrichment` object, only behind `--orca-enrichment`, carrying one entry per *joined* handle the retained runs name (a couple of dozen at most — it is bounded by the cast, not the database) with every free-text field capped at the same 240 characters (`ENRICHMENT_PREVIEW_CHARS`, `src/server/enrichment.ts`). Off, it costs the wire nothing at all: the field is absent, not empty.
>
> **The evidence hints (§14.4) come and say so too.** Their readers scan the full `spec`/`result` bodies **at the SQLite boundary** — a declaration sits mid-prompt, a worktree path wherever the orchestrator typed it, so the 240-char previews are the wrong strings to read — once per *changed* tick, reduced to the hint and dropped (`hints.ts`). What reaches the **wire** is a few bytes per hint (`kindHint` / `repoHint`), optional and absent-when-default like every other optional snapshot field, on objects (cast members, runs) that number in the tens, not the hundreds.
>
> **The paged history transport (#69) then changed what "the snapshot" even means:** the full-history arrays came off the stream event entirely. The budget above is now the ceiling on the *selected-run snapshot* (`GET /api/run/:id`, one run, never windowed) rather than on every push, and a tick carries only `affected` plus the message delta.

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
  startedAt: string; lastActivityAt: string  // ISO; exact evidence set in §12
  converged: boolean                         // terminal task outcomes only; §12
  /** @deprecated Exact alias of lastActivityAt during migration. */
  endedAt: string
  taskCount: number
  cast: CastMember[]                         // the agents it spawned — §4.3a
  waves: Wave[]                              // its bursts of work. Always ≥ 1 — §4.3
  statusCounts: Record<TaskStatus, number>
  /** @deprecated Snapshot-time compatibility projection; new clients derive RunHealth (§12). */
  live: boolean
  hasBlockingGates: boolean                 // true iff any derived gate has blocking = true
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

type Gate = {                                // one normalized decision gate — §4.5
  id: string                                 // message id when present, otherwise table row id
  messageId: string | null
  runId: string | null; taskId: string | null
  question: string; options: string[]
  status: 'pending' | 'resolved' | 'timeout' | 'unanswered'
  blocking: boolean                          // drives interruption; separate from lifecycle state
  resolution: string | null
  createdAt: string                          // ISO
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
  answer?: string                            // the recorded resolution — threaded reply or row; absent ⇒ none recorded
  gateStatus?: Gate['status']                // a gate turn's lifecycle state (#45)
  blocking?: boolean                         // true ⇔ blocking now; absent when not (#45)
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
  gate: Gate | null                          // a blocking gate first, otherwise latest history — §4.5
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
│  ORCHESTRATORS   │  ⚠ GATE STRIP (blocking gates only)       │   RIGHT DOCK        │
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
- **Gate strip** — above the canvas, appearing **only** when the selected orchestrator has blocking decision gates. A proven block must interrupt, not sit in a tab you forget to open; an unanswered historical ask is not enough evidence to interrupt. It is not a standing panel.
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

### 7.3 History: the rail *is* the browser — health, not a mode (#7 §5, #48)

The DB never prunes; 13 runs across 4 days sit in it right now. There is **no "history mode"**: a past run renders through the **exact same code path** as the live one, because to us it is the same rows. The rail shows the run's `active | silent | finished` health from §12 and shows Orca process liveness separately; it never labels an unfinished silent run "ended" or treats a running Orca process as evidence that a particular run is active.

- **No auto-jump.** A new run appearing while you read an old one shows a **"new run started ↑"** chip on the rail. The canvas is never yanked out from under you.
- **Feed scope toggle: "This run" (default) / "All."** The global `sequence` timeline is the only true total-order history in the schema and costs nothing extra to expose — one click away, never the default.
  > **Superseded by §14.4 (#69).** The global scope is retired, and the second toggle is now **"Unattributed"**. It costs nothing extra to expose only while the client is *holding* the whole database, and ADR 0004 stopped it doing that: the client fetches one selected run whole and pages the rest, so a button marked "All" would show one orchestration and call it every one. What that scope is *for* — a turn nothing places must still appear, attached to nobody (§4.4 rule 3, §7.7) — is unchanged and is exactly what the new name says. Another orchestrator's conversation is a rail click away.

### 7.4 The gate strip (#7 §4, §8)

Appears above the canvas **only** when the selected run has gates whose `blocking` flag is true (§4.5). Each entry shows the question, the options, and the task it blocks (clicking selects that node). **Read-only** — it displays the gate; it never offers to resolve it (#1).

**Derived primarily from `decision_gate` messages and enriched by `decision_gates` rows** (§4.2 trap 1, §4.5). This is load-bearing in both directions: message-only asks must not vanish, and a matching row's authoritative resolution or timeout must not be discarded (#45).

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

  This **replaces** the eight-hex assignee chip. That chip was the loudest object on the card, for a value you cannot read, cannot remember and would not act on — and, worse, it was the agent's *only* name, so "the failed node and the blocking gate are the same agent" was a fact you had to work out by comparing two strings of hex. `A2` is one glance, it is the *same* `A2` in the rail and in the conversation, and the handle rides in the tooltip in full. `✗N` stays, at the end of the row, when `failureCount > 0` (the breaker trips at 3): the monogram is *who*, and that is *how badly it is going*.

  A task with **no agent** wears a faint stripe and no badge. Three true things come out the same way and all three are right: it was never dispatched, its dispatch names no assignee, or the orchestrator worked it itself — and in none of them was an *agent* spawned for the work.

- **Dimming — the central gesture** (§7.2). While an agent is selected, every node that is not theirs fades to ~18%. **Faded, never hidden:** the shape of the orchestration survives the filter, so you can see *where* your agent's work sat inside it, which is the entire difference between focusing a canvas and emptying one. An edge dims unless **both** its ends are lit. (It is a motion state and not a CSS class, and that is not taste: the entrance animation writes `opacity: 1` into the inline style, and an inline style beats a class — a dim expressed as a class is silently overridden and the canvas never fades at all.)

- **Waves — the six-hour rule, made visible** (§4.3). When an orchestrator worked in more than one burst, each is drawn in its own dashed region, captioned *"Wave 2 · after 14h idle"*. **The layout is partitioned, not merely captioned:** elkjs lays a graph out by its *dependencies*, so asking it to lay out both waves at once interleaves their nodes and a border round the result is a border round the whole canvas. Each wave is laid out on its own and the blocks are set down left to right in time order — which is the axis a wave actually means. A dependency crossing from one wave into the next still draws, as a long line between two blocks: that is exactly what "we picked the work up again 14 hours later, from where we stopped" looks like. **One wave ⇒ no region at all** — there is no boundary to point at, and a box round everything is furniture.
- **Last-seen badge** — `"last seen 12s ago"` from `dispatch.lastHeartbeatAt`, **going stale-amber past a threshold** (#7 §7). *Spec-level default: 10 minutes*, i.e. 2× the 5-minute heartbeat cadence Orca instructs its workers to keep; make it a constant, not a magic number. Shown only while the dispatch is `dispatched`.
- **Gate marker** — orange `⛔ gate` badge when the task has a gate whose `blocking` flag is true (§4.5).
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
- **A gate and its answer sit together**, threaded on `thread_id` (§4.5). The options show, and the one the answer names is ticked. An unanswered ask says **"no answer recorded"**; it says **"blocking — waiting for an answer"** only when its separate `blocking` fact is true (#45).
- **Every turn carries its `source`** — the columns it was reconstructed from, in small grey type under the bubble. Four of these turns are not messages, and a bubble that pretended otherwise would be a lie. This is not a footnote; it is the point.
- **Heartbeats collapse to one line per task** — 302 of 466 messages, all saying "alive". *"18 heartbeats · every ~5 min"*, with the cadence **measured** from two instants and a count rather than read off Orca's documentation. There is no "show heartbeats" toggle any more, and nothing is hidden: the two hundred rows the line replaces all say the same word, and their value — *liveness* — already reached the screen as the last-seen badge (§4.6).
- **Scope: "This orchestrator" (default) / "All."** An agent selected in the rail narrows it further. "All" is not a convenience: a turn the server could not place belongs to no orchestrator (§4.4, rule 3), and it must still **appear, attached to nobody**, rather than be guessed into somebody's thread.
  > **Superseded by §14.4 (#69): the second scope is now "Unattributed",** and it shows exactly the turns nothing places — which is precisely the job this bullet gives it, and now the only job it can honestly do. The client holds one selected run and those turns (ADR 0004), so "All" would have been a name for something the panel no longer has.
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
| **An aurora, drifting** | *A question is blocking work* | The gate strip, and only the gate strip. Slow (19–25 s), because it must stay bearable for as long as the gate blocks, which on a real database is hours |

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
7. A run with a blocking gate shows the gate strip — **populated from message-derived gates, enriched by authoritative matching table state**.
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

Three places in this document fill a mechanical gap the tickets did not need to reach, each marked **spec-level** inline and none of them re-litigating a ruling: the message-attribution tie rule (§4.4), the additive merge of `decision_gates` rows when they exist (§4.5), and the concrete numbers for the heartbeat-stale threshold and pulse duration (§7.5, §7.6). An implementer may change these without reopening a ticket. Issue #45 supersedes the old additive-only gate merge and the locked "no reply means open/blocking" rule with the evidence-backed state/blocking contract in §4.5; the other locked decisions remain unchanged.

---

## 12. Post-MVP amendment: run health (#48)

This section supersedes the MVP's boolean `Run.live`, its misleading `endedAt` name, the `ready | dispatched`-only in-flight set, and every UI rule that labels `live === false` as "ended." It does not change run identity, waves, task health (#47), Orca process detection, or the six-hour attribution grace.

### 12.1 Three independent facts

The implementation must keep these concepts separate:

1. **Convergence** is a property of task state. A run is converged only when every task has a known terminal status: `completed` or `failed`. `pending`, `ready`, `dispatched`, and `blocked` are not converged. An unknown status is conservatively not converged because render-what-parses cannot prove it terminal. Dispatch-attempt status does not override task status.
2. **Last activity** is retained evidence about the run. It says when recorded work last happened; it does not say that a terminal or process is currently alive.
3. **Orca process liveness** remains `Meta.liveness: 'live' | 'stale' | 'unknown'`, derived from the runtime file and process probe. It never changes convergence or run health.

The combinations are intentional. A run can be `active` while Orca process liveness is `stale` if the process just exited, or `silent` while Orca is `live` if an old dispatch remains in the database. The UI renders both facts rather than collapsing one into the other.

### 12.2 Exact last-activity evidence

`Run.lastActivityAt` is the maximum readable normalized timestamp across:

- every task's `createdAt` and `completedAt`;
- every dispatch attempt's `dispatchedAt`, `completedAt`, `lastHeartbeatAt`, and `lastFailure`.

Use every attempt, not only `Task.dispatch`/`MAX(rowid)`: an earlier attempt can contain the newest retained completion or failure evidence. Ignore null or unreadable timestamps rather than treating them as the epoch. A run always contains at least one task; if none of its candidate timestamps parses, preserve the existing unreadable empty instant rather than inventing a time.

Messages are deliberately not activity inputs. Task-id-less messages require the activity window for attribution, so feeding attributed messages back into `lastActivityAt` would be recursive and could allow a chain of weak handle matches to keep extending its own window. Heartbeat activity is still represented by `lastHeartbeatAt`, and completion/failure activity by the task and dispatch-attempt columns above.

Rows and default selection sort by `lastActivityAt`, then `startedAt`, using the existing unreadable-instant ordering. Every wave's `endedAt` uses the same evidence restricted to that wave's tasks and attempts.

### 12.3 Exact run-health states and threshold

```ts
type RunHealth = 'active' | 'silent' | 'finished'
```

Health is derived from `converged`, `lastActivityAt`, and a client wall-clock `now`:

| State | Exact condition | Meaning shown to the user |
|---|---|---|
| `finished` | `converged === true` | Every task has a terminal outcome. Recency and Orca process liveness do not change this. |
| `active` | not converged, readable `lastActivityAt`, and `max(0, now - lastActivityAt) < 10 minutes` | The run has recent activity evidence. This does not claim that a terminal is alive. |
| `silent` | not converged and activity is unreadable or at least 10 minutes old | The run is unfinished with no recent activity evidence. This does not diagnose it as dead or stuck. |

The boundary is exact: at ten minutes the state is `silent`. Clamp future evidence to age zero so modest clock skew does not create a fourth state. The ten-minute constant is the same canonical recency threshold used by task/worker health in #47; do not introduce a second run-only threshold.

The client derives health through one pure helper and a shared wall clock that advances at least every 30 seconds while relevant UI is mounted. A quiet database must visibly cross `active -> silent` without an SSE event. Do not serialize `health`: a server-computed value would freeze behind the `data_version` no-push gate and repeat #47 at run scope.

### 12.4 Wire migration from `Run.live`

The first implementation is additive:

```ts
type Run = {
  // existing fields...
  lastActivityAt: string
  converged: boolean

  /** @deprecated exact alias of lastActivityAt */
  endedAt: string

  /** @deprecated compatibility only; new clients must ignore it */
  live: boolean
}
```

For old consumers, `endedAt === lastActivityAt` byte-for-byte. At snapshot construction time, `live` is projected as `meta.liveness === 'live' && runHealth(run, snapshotNow) === 'active'`. This deliberately fixes false-positive green dots but cannot express `silent` versus `finished`; that limitation is why new consumers use the additive facts and derive `RunHealth` themselves.

The in-repo client migrates in the same change that adds the fields. The deprecated fields remain until a separately approved, versioned breaking wire contract; #48 does not remove them or repurpose them with a different type. Fixtures and canned `StreamEvent`s carry both old and new fields during the compatibility period.

### 12.5 Attribution-window effect

The existing attribution priority remains:

1. a valid `payload.taskId` attributes directly, regardless of the clock;
2. otherwise, handle membership is constrained by a run window;
3. zero or multiple matching runs produce `runId: null`.

The window becomes `[startedAt, lastActivityAt + 6 hours]`. The six-hour value remains the existing `IDLE_GAP_MS`; #48 changes the evidence anchoring the tail, not the grace period or ambiguity policy. Consequently a later dispatch, heartbeat, attempt completion, attempt failure, or task completion extends handle attribution, while old abandoned task statuses alone do not. Do not iteratively extend the window from messages attributed through that same window.

### 12.6 Acceptance criteria

- [ ] `pending`-only and `blocked`-only runs are not converged; all-`completed`/`failed` runs are converged; an unknown task status is not converged.
- [ ] `lastActivityAt` selects the newest task or dispatch-attempt evidence across all attempts, including dispatch, heartbeat, completion, and failure timestamps.
- [ ] A recent blocked or pending run is `active`; the same unfinished run becomes `silent` at the ten-minute boundary without an SSE push; a newly finished run is immediately `finished` even though its activity is recent.
- [ ] A stale dispatched row is `silent` even while `Meta.liveness === 'live'`; recent activity remains `active` even when `Meta.liveness !== 'live'`, with process state displayed separately.
- [ ] Rail ordering and initial selection use `lastActivityAt`.
- [ ] A task-id-less message after the old task-only bound but within six hours of later dispatch/heartbeat evidence attributes to the run; direct task-id attribution and ambiguous-to-null behavior remain unchanged.
- [ ] `endedAt` exactly aliases `lastActivityAt`, and `live` follows the deprecated compatibility projection for every combination of health and process liveness.
- [ ] Server/API fixture tests cover convergence, every activity timestamp source, rail ordering, and attribution; client tests cover all three states and a wall-clock-only `active -> silent` transition.

### 12.7 Out of scope

- Per-task/worker health presentation and its never-heartbeat wording (#47).
- Declaring a terminal dead, stuck, or hung; the model reports only retained activity evidence.
- Changing the ten-minute recency threshold, the six-hour wave/attribution threshold, run identity, or the `Meta.liveness` probe.
- Gate triage tiers, alerts, notifications, stream-freshness UI, or the global attention queue (#51).

---

## 13. Approved live-supervision extension (#51)

This section is an approved multi-session plan, not one implementation ticket. The seven tracer bullets are published as child issues of #51; each must fit a fresh context and preserve every hard invariant in §1.2.

### Problem Statement

The live screen reconstructs orchestration history but does not reliably answer a supervisor's first question: **does anything need intervention now?** Quiet or never-heartbeating workers can look healthy, unfinished gate-blocked work can look finished, old dispatches can look active merely because Orca is running, and urgent facts remain scattered across selected-run surfaces. The browser also cannot distinguish a reconnecting stream from old-but-still-rendered data, narrate unrecorded status transitions during the open session, or offer a glanceable multi-run view.

### Solution

Build supervision on corrected, shared evidence models, then expose one ranked attention queue across orchestrators. Add explicit connection and data-age feedback, bounded session activity, opt-in notification affordances, an optional WAL early-wake hint, optional live Orca context, and a DAG-free kiosk. SQLite remains authoritative and read-only throughout; client clocks, filesystem watches, snapshot diffs, browser notifications, and CLI output are fallible presentation aids around that authority.

### User Stories

1. As a supervisor, I want recently active, unfinished-but-silent, and finished orchestrations to look different, so that a running Orca process does not make abandoned work look healthy.
2. As a supervisor, I want pending and gate-blocked work treated as unfinished, so that quiet waiting is not mistaken for convergence.
3. As a supervisor, I want every worker-health surface to use the same evidence and clock, so that a node, cast row, and overview cannot disagree.
4. As a supervisor, I want missing heartbeats described as missing evidence, so that the tool never claims a terminal is dead.
5. As a supervisor, I want only genuinely blocking gates to demand intervention, so that unanswered, timed-out, superseded, or already-resolved questions do not create permanent noise.
6. As a supervisor, I want one cross-orchestrator attention queue, so that I do not need to inspect every run to find a blocker.
7. As a supervisor, I want an attention item to open its orchestrator and task when available, so that triage takes one action.
8. As a supervisor, I want unresolved escalations to remain visible after their animation ends, so that a one-second pulse cannot hide a request for help.
9. As a supervisor, I want repeated snapshots to preserve one attention cause rather than duplicate it, so that the queue stays trustworthy.
10. As a supervisor, I want the page title and favicon to reflect current attention even when the tab is backgrounded.
11. As a supervisor, I want desktop notifications to be explicit opt-in and non-repeating, so that supervision does not become notification spam.
12. As a supervisor, I want to see whether the stream is connected or reconnecting while the last good state remains visible.
13. As a supervisor, I want data age to advance with wall time, so that I know when the displayed snapshot last changed even on a quiet stream.
14. As a supervisor, I want transitions observed after I opened the page narrated in a ticker, so that task dispatch, retry, and status changes are legible even when Orca wrote no message row.
15. As a supervisor, I want the ticker to identify itself as session activity, so that I do not mistake it for durable replay.
16. As a supervisor, I want an optional low-latency wake path, so that urgent changes may surface before the next five-second poll without weakening correctness.
17. As a supervisor, I want optional live worktree and current-activity context when Orca can provide an exact match, so that I can understand what an active worker is doing.
18. As a supervisor, I want CLI enrichment failure to leave the SQLite view intact, so that an optional convenience cannot take down supervision.
19. As a supervisor using a wall display, I want a non-interactive overview of unfinished orchestrations, so that active and silent work is readable at a glance.
20. As a post-mortem user, I want every live-only feature to disappear or degrade honestly when Orca is closed, so that historical inspection keeps working.

### Implementation Decisions

- **Foundations stay separate.** Gate fidelity and triage tiers belong to #45; shared worker health and the client wall clock belong to #47; three-state run semantics and activity evidence belong to #48. Section 12 consumes those contracts. It does not independently choose #48's field name, evidence set, threshold application, or compatibility path.
- **Three-state semantics are locked.** An unfinished orchestration contains at least one `pending`, `ready`, `dispatched`, or `blocked` task. Unfinished work is either recently active or silent according to #48's evidence contract; an orchestration with no unfinished work is finished. `Meta.liveness` remains the separate Orca-process fact.
- **Attention is a pure derivation over the latest snapshot plus wall time and bounded session state.** Each attention cause has a stable identity, kind, explanation, severity inputs, `runId`, optional `taskId`, and occurrence time. Re-reading the same cause never duplicates it.
- **Attention rank is deterministic.** The precedence is: blocking gates, ordered oldest first; stale or never-heartbeating workers, ordered by longest silence; current dispatches with `failureCount >= 2`, highest count first; unresolved escalations, oldest first; then fresh failures, newest first. Stable ids break remaining ties. Distinct causes may coexist for one task rather than hiding evidence behind a lossy task-level merge.
- **Attention lifetimes follow evidence.** A blocking gate leaves when #45 no longer classifies it as blocking. Worker and retry-risk items follow the current health/attempt. An escalation persists until its task reaches a terminal state or starts a later dispatch attempt. A fresh failure remains fresh for the shared attention freshness window. Orphaned historical messages without a current unfinished task do not demand intervention.
- **Selection is the navigation seam.** Clicking an attention item selects its orchestrator and, when present, its task through the existing selection model; it does not introduce a parallel router or mutate Orca.
- **Notification affordances consume attention; they never derive urgency independently.** Title and favicon state reflect the queue. Desktop notifications default off, persist the user's opt-in locally, request browser permission only from a user gesture, establish the current queue as a no-notify baseline, and notify once when a trusted cause first enters. They never replay historical attention on load or on reconnect.
- **Freshness has two dimensions.** The client reports `connected` or `reconnecting` from `EventSource` lifecycle and separately shows data age from the last successfully applied snapshot. `EventSource.onerror` preserves the last good snapshot. A wall-clock ticker advances the age without requiring an SSE push; quiet data is not described as a broken connection.
- **Session activity starts from a baseline.** The first snapshot and any explicit resynchronization establish state without narrating history. Later snapshots synthesize dispatch, retry, and task-status transitions, then merge them with coherent gate, escalation, and worker-done deltas. The in-memory list is bounded to the most recent 100 entries, clears on reload, and is never persisted in browser storage, on the server, or in SQLite. #49 is required so real message deltas cannot be skipped behind their cursor.
- **The WAL path is an explicit optional wake hint.** A debounced watcher may observe the database directory so `-wal`/`-shm` deletion and recreation do not strand a file watcher, but it may only schedule the normal `data_version` tick early. The five-second poll remains authoritative and continues unchanged after watch failure; a warning explains the fallback. No watcher event becomes a snapshot fact or SSE event by itself.
- **Live enrichment is explicit opt-in and off the SQLite hot path.** A separately timed, timeout-bounded adapter may call `orca worktree ps --json` and the minimum read-only Orca metadata needed to join its result. It runs only while `Meta.liveness` is live, caches the last success, and never delays or replaces a SQLite snapshot. Worktree context is attached only through an exact terminal-handle join; current agent activity is attached only when that join is unambiguous. Ambiguous or failed joins render no activity rather than guessing. Failure retains the last SQLite snapshot and labels enrichment unavailable.
- **Kiosk is a route, not a second application.** `/kiosk` is a non-interactive, continuously updating overview of unfinished orchestrations. It shows active/silent tiles, each tile's worst worker health and blocking-gate age, the shared attention queue, and session activity. It excludes the DAG, inspector, conversation, historical finished runs, task controls, forced browser fullscreen, and a new server mode.
- **Read-only remains absolute.** No supervision feature writes to `orchestration.db`, resolves a gate, retries a task, marks a message read, or treats an Orca CLI mutation as enrichment. The server still opens every database connection with `readOnly: true`.
- **The approved delivery order is seven tracer bullets.** (1) attention derivation/queue and persistent escalation in #56, blocked by #45, #47, and #48; (2) independent stream freshness in #57; (3) session activity in #58, blocked by #49; (4) the WAL wake hint in #59, blocked by #57 so latency is observable; (5) notifications in #60, blocked by #56; (6) live enrichment in #61, blocked by #46 because enrichment pushes must not remount the DAG; and (7) kiosk in #62, blocked by #56, #57, and #58. #50 is important but is not a blocker unless a later implementation directly consumes reset-shape metadata.

### Testing Decisions

- Test external behavior at the highest existing seam and keep the number of seams small: pure derivations for evidence/ranking rules, the real SQLite/SSE server harness for transport and wake scheduling, and canned-event `App`/jsdom tests for browser behavior.
- Pure tests use an injected instant and cover threshold crossings without sleeping: never-heartbeating and stale workers, pending-only and gate-blocked orchestrations, overlapping attention causes, deterministic ranking, escalation clearing, and the no-notify baseline.
- Server tests use real fixture databases and prove that poll-only and watch-woken paths produce the same snapshots, watch failure returns to polling, optional enrichment timeout cannot delay SQLite delivery, and no tested path opens a writable database.
- Client tests drive `EventSource` open/error/message transitions, wall-clock advancement, session baseline and 100-entry bound, selection from attention, notification permission/opt-in/deduplication, ambiguous enrichment, and kiosk rendering without a DAG.
- Integration coverage must include a quiet connected stream, a reconnect retaining the last good event, a coherent message delta from #49, and a post-mortem snapshot with every live-only adapter unavailable.
- Existing prior art is the run/gate derivation suites, real database snapshot and stream harnesses, and `Live`/`App`/rail jsdom suites. New behavior extends those seams rather than adding implementation-specific tests.

### Out of Scope

- Diagnosing whether a worker terminal is alive, dead, hung, or safe to kill.
- Any mutation of Orca state, including acknowledgement or dismissal stored back into Orca.
- Durable replay, an audit log, an event store, or reconstruction of transitions that occurred before the browser session.
- Notification delivery when no browser page is open, push services, email, mobile notifications, or service-worker background operation.
- Making CLI enrichment authoritative, required, available post-mortem, or guessed across ambiguous terminal/worktree relationships.
- Replacing the poll loop with filesystem watching, changing SSE transport, or promising sub-second delivery.
- A kiosk DAG, interaction, historical browser, forced fullscreen, independent server process, or saved kiosk configuration.
- Implementing #50 as part of this roadmap unless a future ticket explicitly adopts reset-shape metadata.

### Further Notes

The MVP clauses that say there is no WAL watcher, zero CLI spawning, a boolean `Run.live`, and message-only gate resolution describe the shipped MVP and are intentionally refined by this extension and its foundational bugs. The dependency edges prevent an implementation session from applying the new UI semantics before the underlying evidence is trustworthy. Ticket bodies are the agent-sized execution briefs; this section is the cross-session specification of record.
---

## 14. Quantitative post-mortem roadmap (#52)

This section is an approved multi-session roadmap. Its slices are independently shippable and must land through separate implementation tickets; it is not permission to build the roadmap in one branch. The hard invariants in §1.2 continue to govern every slice.

### 14.1 Problem Statement

orca-viz reconstructs a strong qualitative account of an orchestrator run: its DAG, cast, gates, attempts, and conversation. It does not yet turn the retained evidence into answers for the common post-mortem questions: how long the work took, when an agent first showed life, which agent finished sooner, what each task produced, where time accumulated along dependencies, or how one task compares with the rest of retained history.

Those answers already exist in the retained timestamps, messages, task results, and completion payloads. Today they appear as point-in-time ages, similarly titled cards, or truncated JSON. The challenge is to expose the recognized facts without claiming that overwritten state transitions, unknown payload shapes, agent identity, or repository identity are more authoritative than the database allows.

The current transport also re-derives and re-sends all retained tasks and conversation turns whenever the database changes. Because the database is never pruned, quantitative history features must not make that unbounded snapshot larger.

### 14.2 Solution

Add a post-mortem report for each orchestrator run, beginning with three slices: honest duration observations, structured outcome receipts, and a per-agent scoreboard. Then add critical-path analysis, a paginated cross-history dispatch report, a dispatch timeline, evidence hints, and a versioned one-shot run archive with unmistakably offline replay.

Scale history through a cursor-paginated run index and complete on-demand selected-run snapshots. A selected run remains whole: its tasks, attempts, gates, conversation, and archive are never silently time-windowed or truncated. The live stream carries lossless message deltas and enough invalidation identity to refresh affected summaries, report pages, and the selected run without re-shipping the machine's full history.

### 14.3 User Stories

1. As an Orca user reading a completed run, I want to see its elapsed span, so that I know how long the orchestration occupied wall-clock time.
2. As an Orca user reading a task, I want to see a dispatch duration when both dispatch timestamps exist, so that the clock reflects the worker attempt rather than task setup time.
3. As an Orca user whose dispatch timestamps are incomplete, I want a clearly labelled task-span fallback, so that a useful approximation is not presented as dispatch time.
4. As an Orca user looking at an incomplete task, I want elapsed time labelled “so far,” so that a live interval is not mistaken for a completed duration.
5. As an Orca user, I want unreadable or missing timestamps to render as unknown, so that bad retained evidence never becomes zero or an epoch date.
6. As an Orca user, I want attempt durations in the inspector, so that retries can be compared without manually subtracting timestamps.
7. As an Orca user, I want recognized completion files rendered as copyable chips, so that I can inspect the produced work quickly.
8. As an Orca user, I want recognized PR, issue, ticket, and review URLs rendered as ordinary provider-neutral links, so that GitHub is not assumed to be the only outcome provider.
9. As an Orca user, I want branch, report path, ticket, and completing-agent fields surfaced when retained, so that useful receipt facts are not buried in JSON.
10. As an Orca user with a completion shape or field this build does not know, I want the raw value preserved and rendered verbatim, so that schema tolerance applies to outcomes too.
11. As an Orca user, I want the conversation to summarize recognized outcome receipts while the inspector keeps the full raw evidence, so that the story is readable without losing detail.
12. As an Orca user comparing agents in one run, I want each cast member's wall-clock span, time to first heartbeat, heartbeat count, non-heartbeat message count, failures, escalations, and outcome links, so that I can compare cost and responsiveness.
13. As an Orca user reading a one-agent run, I want a compact rollup instead of an empty comparison grid, so that the same metrics remain useful.
14. As an Orca user, I do not want a synthetic overall winner or composite score, so that agents assigned different work are not ranked by a false equivalence.
15. As an Orca user, I want a critical path over the selected run's dependency graph, so that I can see where retained duration accumulated.
16. As an Orca user, I want unknown-duration tasks to remain traversable on the critical path, so that missing timing does not sever real dependencies.
17. As an Orca user with an edgeless or cyclic dependency graph, I want critical-path analysis omitted with an honest explanation, so that the tool never invents a path.
18. As an Orca user, I want a cross-history report with one row per retained task, so that I can search and rank work without drawing every task on one canvas.
19. As an Orca user, I want never-dispatched tasks to remain in that report with an explicit missing-dispatch value, so that stalled work does not disappear.
20. As an Orca user, I want server-side sorting, filtering, and pagination over retained task history, so that the report stays usable as the database grows.
21. As an Orca user selecting a history row, I want to open its orchestrator run and task inspector, so that the table is an entry point into the existing qualitative story.
22. As an Orca user, I want to toggle the selected run's centre between DAG and timeline, so that I can switch between dependency structure and concurrency without changing scope.
23. As an Orca user, I want one timeline lane per cast member plus an honest unassigned/orchestrator lane, so that dispatch ownership stays visible.
24. As an Orca user, I want every retained dispatch attempt shown as its own bar and gate, escalation, and completion evidence shown as markers, so that retries and interruptions are not folded away.
25. As an Orca user, I want a task without enough timing evidence to remain reachable from an untimed list, so that missing timestamps cost placement rather than the task.
26. As an Orca user, I want an uncertain agent-kind label only when one known kind is supported by retained evidence, so that a useful hint never masquerades as identity.
27. As an Orca user, I want ambiguous or absent agent-kind evidence to produce no hint, so that guessing is visibly refused.
28. As an Orca user, I want a best-effort repository hint when retained absolute-path evidence agrees, so that I can recognize likely project context without making it the run key.
29. As an Orca user, I want every evidence hint marked with `?` and its provenance available, so that I know both the inference and its source.
30. As an Orca user, I want older run summaries behind explicit “Load older history” pagination, so that the default view is bounded without pretending older runs vanished.
31. As an Orca user, I want the selected run loaded completely even when it is old, so that scaling never weakens a post-mortem.
32. As an Orca user, I want to export exactly one selected run at a moment I choose, so that I can preserve or share its retained post-mortem without copying the machine-global database.
33. As an Orca user opening an archive, I want unmistakable archived/offline wording and no live controls or liveness claim, so that a saved artifact cannot be mistaken for current state.
34. As an Orca user, I want archives to include full task bodies and attempts plus only messages attributed to that run, so that they are self-contained without including unrelated or unattributed machine history.
35. As an Orca user, I want archive format mismatches to degrade visibly and safely, so that an older replay reader never crashes or silently mislabels evidence.

### 14.4 Implementation Decisions

#### First milestone: duration + outcomes + scoreboard

The first milestone answers: **who finished first, what did they produce, and at what retained cost?** It lands as three separate slices in this order where dependencies require it: duration observations and outcome receipts can proceed independently; the scoreboard consumes both.

**Duration observations** carry their clock and provenance, not just a number:

- A completed dispatch duration prefers readable `dispatch_contexts.dispatched_at → dispatch_contexts.completed_at` from the same attempt.
- When dispatch completion is unavailable, a completed task may expose `tasks.created_at → tasks.completed_at` as a visibly labelled **task span**, never as dispatch duration.
- An incomplete interval may be displayed from its readable start to the client wall clock only as **elapsed so far**. It must stop advancing when the evidence says the interval completed and must not depend on a new SSE push to age.
- Missing or unreadable endpoints make the observation absent. They never become zero, the Unix epoch, or a negative interval.
- Run duration is a **run span**, from earliest readable task creation to latest readable task completion/creation. It is wall-clock occupancy, not summed agent time or compute time.
- Every wire-level duration observation identifies its source clock, start, optional end, and whether it is complete. Derived milliseconds are optional and must agree with those endpoints.

**Outcome receipt readers** are never-throw shape readers over both `tasks.result` and `worker_done.payload`:

- Recognized facts include string file lists, report paths, branches, completing-agent fields, ticket identifiers, and valid `http:`/`https:` PR, issue, ticket, or review URLs, regardless of provider.
- Recognized fields are additive. The original parsed value or raw string remains available; unknown objects, arrays, scalars, fields, malformed JSON, and conflicting sources render verbatim rather than disappearing.
- File and path facts are copyable text, not claims that the current machine can open them. URLs are linkified only after normal URL validation.
- When a task result and worker completion message repeat the same fact, the report may deduplicate the presentation but retains source provenance. Conflicting values remain separately visible.
- Conversation turns may use a compact recognized summary. The inspector remains the source for complete raw receipts.
- A missing result column disables receipt enhancement by name through `meta.degraded`; ordinary unknown receipt shapes do not count as schema degradation.

**The per-agent scoreboard** is derived for the selected orchestrator run from all retained attempts and attributed messages:

- Agent elapsed is the wall-clock span from that cast member's first dispatch to its latest retained completion. Incomplete work is “so far”; absent endpoints are unknown.
- Time to first heartbeat is earliest attributed heartbeat minus first dispatch. No retained heartbeat is unknown, not zero.
- Heartbeat count counts retained heartbeat rows. Attributed message count excludes heartbeats because they have their own metric.
- Failure count sums the maximum retained cumulative `failure_count` per task held by the agent; it does not sum cumulative values across attempts and overcount retries.
- Escalation count counts attributed escalation messages. Outcome links are deduplicated recognized receipt URLs.
- The grid is sortable by individual facts but has no composite score, no universal winner, and no claim that agents received equivalent work.
- A single-agent cast renders the same information as a compact rollup rather than a comparison grid.

#### Critical-path analysis

- Compute a duration-weighted longest path only over dependency edges whose endpoints are tasks in the selected run.
- A task's weight is its completed dispatch duration, then its completed task-span fallback, then zero when duration is unknown. Zero-weight tasks remain traversable.
- Analysis is reported only for a completed run. In-flight work has no final critical path.
- Edgeless runs omit the result. Missing dependency nodes cost only those edges. A cycle or otherwise non-DAG retained shape omits the result under an explicit data note; it never throws or breaks the canvas.
- Equal paths resolve deterministically by retained task order and id.
- The DAG uses a static highlight. Critical-path analysis does not introduce motion and does not invent unretained status transitions.

#### Cross-history dispatch report

- The report contains one row per retained task across all loaded history, including tasks never dispatched. It is a ranking/search instrument, not an all-tasks canvas.
- Each row carries the orchestrator run, task title, latest cast member, dispatch time, honest duration observation, attempt count, non-overcounted failure count, current status, and compact outcome summary.
- Sorting and filtering are server-side and use stable cursor pagination with a deterministic id tie-break. The initial page is bounded; older pages are explicit.
- Filters may include run, status, cast member, time range, outcome presence, and evidence hints. A missing value remains filterable as missing.
- Selecting a row loads its complete selected-run snapshot and opens the existing task inspector. The report creates no second task-detail truth.

#### Dispatch timeline

- The centre gains a sibling **DAG / Timeline** toggle scoped to exactly one selected run. The DAG remains the default.
- The timeline has one lane per cast member and an explicitly named lane for work with no spawned agent or with the orchestrator as assignee.
- Every retained dispatch attempt is a separate bar because the selected-run snapshot is complete and attempts are already the retry record. Attempts for one task remain visually related.
- Gate questions, escalation messages, and retained task/attempt completions appear as point markers at their recorded instants. The timeline does not synthesize `pending → ready`, `blocked → ready`, or other unrecorded transitions.
- A bar without a readable end is open-ended and labelled “so far.” A task without enough time evidence remains in an untimed list and can still open the inspector.

#### Evidence hints

- Supported agent-kind tokens are a small, versioned allowlist. Evidence readers inspect only high-confidence token positions in retained branch/result/spec evidence; they do not search arbitrary prose for casual mentions.
- A cast member receives a hint only when exactly one supported kind survives across its evidence. The visible form is uncertain, for example `A1 · claude?`, with provenance such as `from branch` available beside it. No evidence or conflicting kinds produces no hint.
- A repo hint may be derived only when high-confidence absolute-path evidence within a run agrees on one project candidate. It is marked `?` with provenance such as `from task specs`; ambiguity produces no hint.
- Hints never change orchestrator-run identity, cast identity, dependency attribution, or the primary rail grouping. Repo hints may be displayed and used as optional report filters, but are never authoritative project grouping.
- The feature remains SQLite-only. It does not call the Orca CLI or require referenced paths to still exist.

#### History scaling and windowing

- Replace the unbounded full-history stream snapshot with a stable cursor-paginated **run index** and a complete on-demand **selected-run snapshot**.
- The default run-index page contains the 50 most recently active summaries, ordered by activity plus run id. “Load older history” follows an opaque stable cursor; there is no silent date cutoff.
- A selected-run snapshot contains the run summary, every task and dispatch attempt, all gates, the complete reconstructed conversation, coordinator-run evidence that belongs to it, and schema-degradation metadata. It is never time-windowed or truncated.
- Cross-history reports paginate independently on the server.
- SSE retains the lossless message cursor and carries enough affected-run/report identity to invalidate only relevant run summaries, pages, and the selected run. Reconnect uses the same lossless cursor contract and must recover changes that happened while disconnected.
- Introduce the new read contracts before retiring full-history arrays so a migration can remain green at every step. Unknown or missing columns continue to disable only dependent features by name.

#### One-shot run archive and archived replay

- A run archive is created only by an explicit user action on one selected run. It is a versioned, self-contained artifact containing the selected-run snapshot, full task specs/results and all attempts, and only raw messages attributed to that run at export time.
- The archive excludes the machine-global database, other runs, unattributed/global messages, future rows, and automatic retention. Export starts no watcher, recorder, or background job.
- The artifact records its format version, export instant, source schema support, and derivation provenance. It must not include a live database path as meaningful identity.
- Archived replay opens the artifact without an Orca database and uses the ordinary selected-run presentation wherever possible. It is visibly **archived/offline**, has no liveness badge that implies a process is running, performs no polling, and offers no mutation.
- A newer artifact version degrades under a visible compatibility warning. An unreadable required core fails with an actionable archive error; optional unknown fields and receipt shapes render verbatim.

### 14.5 Testing Decisions

The primary server seam is observable HTTP behavior: the selected-run contract, paginated run index, paginated cross-history report, and archive export/replay contract. Tests should make requests against live-shaped fixture databases and assert user-visible contract behavior, rather than private query structure.

Pure derivation tests are justified where a small algorithm has a dense error surface:

- dispatch versus task-span provenance, unreadable timestamps, negative intervals, and incomplete “so far” clocks;
- malformed, unknown, repeated, and conflicting outcome receipt shapes;
- cumulative failure counts across retry attempts;
- agent-kind and repo evidence that is unique, absent, or ambiguous;
- missing dependency endpoints, edgeless graphs, deterministic ties, and dependency cycles.

Client presentation continues to use canned wire events and HTTP responses. It must cover single- versus multi-agent scoreboards, missing values, report pagination and selection, DAG/timeline state, untimed tasks, uncertain hints and provenance, archived/offline wording, and reduced-motion behavior.

Archive tests perform an export-to-replay round trip and assert that full selected-run evidence survives while unrelated and unattributed messages do not. Existing fixture/schema-degradation suites remain the prior art: each missing optional column must cost only the feature that reads it, with a visible degradation reason.

### 14.6 Out of Scope

- Background recording, a shadow event store, automatic snapshots, future-row capture, or recovery of evidence Orca overwrote or deleted.
- Exporting the machine-global database, unrelated runs, unattributed/global messages, or claiming an archive is a security redaction format.
- Mutations, retries, gate resolution, or any other control-plane action.
- An all-history task canvas or a second global DAG.
- Inventing task-status transitions or attempt boundaries the retained rows do not timestamp.
- A composite agent performance score, an overall winner, or a claim that different agents received comparable work.
- Authoritative agent-kind or repository identity, primary repo-grouped navigation, CLI enrichment, or filesystem-dependent historical lookup.
- Live-supervision attention queues, notifications, kiosk mode, or task-health changes tracked by #51.
- Fixing reset-shape detection tracked by #50.

### 14.7 Further Notes

The implementation order is nine tracer-bullet sessions: durations; structured outcomes; scoreboard; scalable history transport; cross-history dispatch report; critical path; timeline; evidence hints; archive and replay. Durations and outcomes can begin independently, while the scoreboard requires both. Later slices declare only their genuine data-contract blockers; roadmap order alone is not a blocking edge.

The archive boundary is recorded in ADR 0005. The complete-selected-run history boundary is recorded in ADR 0004. The domain glossary defines retained evidence, post-mortem report, outcome receipt, run archive, archived replay, run index, selected-run snapshot, and evidence hint.

