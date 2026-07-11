# What history does orchestration.db retain?

Resolves wayfinder ticket #2. Sources: Orca orchestration source at `/home/dev/projects/orca` (read-only), all citations `file:line` relative to `src/main/runtime/`; corroborated against the live DB `~/.config/orca/orchestration.db` (read-only, 2026-07-11, mid-run — schema `user_version = 5`).

## Answers first

1. **Nothing is ever pruned automatically.** Rows in all five tables accumulate indefinitely, across coordinator runs and across days. The only deletion paths in the entire codebase are the explicit `orchestration.reset` RPC verbs, which `DELETE FROM` whole tables with no scoping, no archive, and no soft-delete. The live DB holds 4 days of interleaved runs (72 tasks, 62 dispatch contexts, 447 messages) and has never been reset.

2. **Tasks cannot be directly associated with a coordinator run.** There is no run id on `tasks` (or any other table). Worse: `coordinator_runs` is only written by the built-in `Coordinator` class loop (`orchestration.run`), which agent-driven/CLI coordination never uses — the live DB has **zero** `coordinator_runs` rows despite 4 days of real orchestration. The practical association is indirect: `tasks.created_by_terminal_handle` (populated on 68/72 live tasks) groups tasks by the terminal that created them — in practice the coordinator terminal — plus `created_at` time clustering. Orca itself has no run scoping either: the coordinator loop operates on *every* task in the DB.

3. **Messages and dispatch attempts are append-only history; everything else is current-state-only.** The `messages` table is a true event log (insert-only content, monotonic `AUTOINCREMENT sequence` = total order); each dispatch *attempt* is a new `dispatch_contexts` row, so per-task retry history survives. But `tasks.status`, `tasks.result`, `decision_gates.status`, `coordinator_runs.status`, and the per-row dispatch fields are all overwritten in place — intermediate task states (`pending → ready`, `blocked → ready`) leave no timestamped trace of their own.

4. **Beyond HANDOFF.md's summary:** 10 explicit indexes, no views, no triggers, no foreign keys (all `task_id` references are soft), no soft-delete flags, `PRAGMA user_version = 5` as the schema-detection hook, a `sqlite_sequence` row for `messages` that lets you *detect* a past reset, meaningful `rowid` ordering on `dispatch_contexts`, mutable `read`/`delivered_at` flags on messages, and an inconsistent timestamp format split (SQL `datetime('now')` vs JS ISO-8601) that any consumer must normalize.

---

## 1. Retention: accumulate forever, delete only on explicit reset

The only `DELETE` statements in the orchestration layer are the three reset verbs (`orchestration/db.ts:878-895`):

- `resetAll()` — wipes all five tables.
- `resetTasks()` — wipes `coordinator_runs`, `decision_gates`, `dispatch_contexts`, `tasks` — but **keeps `messages`**, so message rows can reference deleted tasks/dispatches (orphans by design).
- `resetMessages()` — wipes `messages` only.

These are exposed solely via the `orchestration.reset` RPC (`rpc/methods/orchestration.ts:623-641`, scopes `--all | --tasks | --messages`). Nothing calls them automatically: no TTL, no startup cleanup, no vacuum, no cap on table size. A repo-wide grep for `DELETE FROM` / `DROP TABLE` / `VACUUM` in `src/main` finds nothing else touching this DB.

**Live corroboration:** tasks span `2026-07-08 12:32` → `2026-07-11 20:57` (21 / 24 / 11 / 16 tasks per day across four distinct working days), all coexisting in one table. And `sqlite_sequence.seq = 447` = `COUNT(messages)` = `MAX(sequence)`, with `MIN(sequence) = 1` — since `sequence` is `AUTOINCREMENT` (never reused after a delete, `db.ts:76`), this proves no message has ever been deleted from this DB.

**Visualizer implication:** you can't assume the DB contains "the current run." It contains every run since the last manual reset. Also: `sqlite_sequence.seq > COUNT(*)` or `MIN(sequence) > 1` is a cheap reset/gap detector.

## 2. Task ↔ coordinator run association

**No direct link exists.**

- `tasks` columns are `id, parent_id, created_by_terminal_handle, task_title, display_name, spec, status, deps, result, created_at, completed_at` (`db.ts:85-101`) — no run id.
- `coordinator_runs` rows are created only in `Coordinator.run()` (`orchestration/coordinator.ts:128-133`) and the `orchestration.run` RPC (`rpc/methods/orchestration-gates.ts:65-69`). The CLI-verb-driven coordination pattern (`orca orchestration task-create` / `dispatch` / `send`) never writes this table. **Live DB: 0 rows** — so for real-world agent-coordinated runs, `coordinator_runs` is empty and useless as a scoping key.
- Even the built-in loop is unscoped: `decompose()` requires tasks to be pre-created and reads `listTasks()` — all tasks (`coordinator.ts:207-217`); convergence and final status likewise iterate every task in the DB (`coordinator.ts:172-181, 546-552`). A second run over an unreset DB would adopt all leftover tasks. (This is precisely why `reset` exists.)

**What works instead:**

| Signal | Quality | Notes |
|---|---|---|
| `tasks.created_by_terminal_handle` | good | v4 column (`db.ts:236-240`); set from the caller terminal in `orchestration.taskCreate` (`rpc/methods/orchestration.ts:361-387`). Live: 68/72 populated, clustering cleanly by coordinator terminal (e.g. 14, 13, 10, 10, 6, 4 tasks per handle). NULL for pre-v4 rows or handle-less callers. |
| `created_at` time clustering | fair | Runs show up as day/hour clusters; needs a gap heuristic. |
| `tasks.parent_id` | partial | Decomposition hierarchy within a run (`db.ts:104` index `idx_tasks_parent`), but roots carry no run key. |
| `coordinator_runs` join by `coordinator_handle` + time window | only for `orchestration.run` loops | Empty in practice (see above). |

**Visualizer implication:** scope a "run" as *tasks sharing `created_by_terminal_handle`, split on time gaps* — and treat it as a heuristic, honestly labeled.

## 3. Reconstructible vs. overwritten

### Append-only (full history survives)

- **`messages` content is immutable.** The only writes are `INSERT` (`db.ts:287-314`) and two flag updates — `read = 1` (`db.ts:362-368`) and `delivered_at = datetime('now')` (`db.ts:375-383`). `sequence INTEGER PRIMARY KEY AUTOINCREMENT` (`db.ts:76`) gives a gap-free total order and a perfect poll cursor. Typed rows carry structured payloads:
  - `worker_done`: payload `{taskId, dispatchId, filesModified, reportPath…}` — task completion events, attributable to the exact dispatch attempt (validated in `orchestration/lifecycle-reconciliation.ts:83-119`).
  - `heartbeat`: payload `{dispatchId}` — a liveness trail per dispatch (291 rows live).
  - `escalation`: payload `{taskId}` — failure/retry triggers (`coordinator.ts:286-325`).
  - `decision_gate`: payload `{question, options}` (`rpc/methods/orchestration.ts:574-584`).
  - `thread_id` correlates conversations; `ask` replies thread on the outbound message id (`rpc/methods/orchestration.ts:319-343, 585+`).
- **One `dispatch_contexts` row per dispatch attempt.** Retrying a task creates a *new* row (`createDispatchContext`, `db.ts:571-612`) carrying `MAX(failure_count)` forward for the circuit breaker (`db.ts:594-597`); the old attempt's row survives with its `status`, `last_failure`, `dispatched_at`, `completed_at`, `last_heartbeat_at`. So attempt count, per-attempt assignee, and per-attempt error are all reconstructible (`ORDER BY rowid` — the code itself uses `MAX(rowid)` as "latest", `db.ts:511-515, 616`). Live DB: no task has >1 context yet (no retries have occurred), 54 completed / 8 dispatched.
- **`decision_gates` rows persist after resolution** with `question`, `options`, `resolution`, `created_at`, `resolved_at` (`db.ts:748-770`).
- **`tasks.result`** stores a completion receipt JSON `{completedBy, filesModified, completedAt}` written by lifecycle reconciliation (`lifecycle-reconciliation.ts:140-145`) — per-task attribution even without joining messages.

### Overwritten in place (only latest state survives)

- **`tasks.status`** — mutated by at least six writers, none of which log a transition record: `updateTaskStatus` (`db.ts:526-541`), `promoteReadyTasks` (`pending → ready`, silent, `db.ts:548-567`), `createDispatchContext` (`→ dispatched`, `db.ts:607`), `failDispatch` (`→ ready` or `failed`, `db.ts:725-726`), `createGate` (`→ blocked`, `db.ts:743`), `resolveGate` (`→ ready`, `db.ts:765`).
- **`tasks.result` / `tasks.completed_at`** use `COALESCE(new, old)` (`db.ts:531`) — a later completed/failed transition *overwrites* `completed_at` with the newer timestamp and replaces `result` if one is supplied; the first completion time is lost.
- **`dispatch_contexts` per-row fields** — `failDispatch` updates `status`/`failure_count`/`last_failure` in place on the same row (`db.ts:715-719`); `recordHeartbeat` overwrites `last_heartbeat_at` (only while `status = 'dispatched'`, `db.ts:676-682`), so only the *last* heartbeat time is on the row (the full trail is in `messages`).
- **`decision_gates.status`**, **`coordinator_runs.status`/`completed_at`** — in-place (`db.ts:756-770, 834-843`).
- **`messages.read` / `messages.delivered_at`** — in-place flags; a poller will observe them flip on otherwise-immutable rows.

### Transitions you can and cannot reconstruct

| Transition | Reconstructible? | From |
|---|---|---|
| task created (and initial `pending` vs `ready` — dep-less tasks start `ready`, `db.ts:441`) | yes | `tasks.created_at` + `deps` |
| `pending → ready` (dep promotion) | **no** | silent in-place flip, no timestamp |
| `ready → dispatched` (each attempt) | yes | `dispatch_contexts.dispatched_at`, per attempt |
| worker liveness | yes | `heartbeat` messages (sequence-ordered); last-only on the ctx row |
| dispatch failed / retried | yes | old ctx row (`status`, `last_failure`) + escalation message |
| `→ blocked` on gate | partially | `decision_gates.created_at` — **but only when a gate row exists** (see gotcha below) |
| gate resolved / task unblocked | same caveat | `decision_gates.resolved_at`, `resolution` |
| `→ completed` | yes | `worker_done` message (+ `tasks.completed_at`, `tasks.result`) |
| re-completion / status churn after first completion | no | `COALESCE` overwrite |
| coordinator run start/end | only for `orchestration.run` loops | `coordinator_runs` (empty in CLI-driven practice) |

### Gotchas the enum hides

- **`type = 'dispatch'` messages are never written by the runtime.** Both dispatch paths inject the preamble directly into the worker's PTY via `sendTerminalAgentPrompt` — the `Coordinator` loop (`coordinator.ts:464-498`) and the `orchestration.dispatch` RPC (`rpc/methods/orchestration.ts:427-511`) — with no message row. Live DB: 0 `dispatch` rows (also 0 `merge_ready`, 0 `handoff`). The dispatch *event* is reconstructible from `dispatch_contexts.dispatched_at`, not from messages.
- **`orchestration.ask` writes a `decision_gate` *message* but no `decision_gates` row** (`rpc/methods/orchestration.ts:549-584`). A gates-table row is created only by `orchestration.gateCreate` or when the built-in `Coordinator` loop consumes a `decision_gate` message (`coordinator.ts:327-351`). Live DB: 53 `decision_gate` messages, **0** `decision_gates` rows. A visualizer that renders gates from the table alone will show nothing for CLI-driven runs — derive gates from messages instead.
- **`timeoutGate()` (`db.ts:772-781`) has no callers** anywhere in `src` outside tests — `status = 'timeout'` never occurs in practice; `ask` timeouts simply return with the message left unread.

## 4. Queryable things HANDOFF.md's summary missed

- **Indexes (10 explicit, all confirmed live):** `idx_messages_id` (UNIQUE on `messages.id` — `id` is *not* the PK; `sequence` is), `idx_inbox (to_handle, read)`, `idx_messages_undelivered_inbox (to_handle, read, delivered_at, sequence)` (`db.ts:264-272`), `idx_thread (thread_id)`, `idx_tasks_status`, `idx_tasks_parent`, `idx_dispatch_task`, `idx_dispatch_status`, `idx_gates_task`, `idx_gates_status` (`db.ts:81-136`). No views, no triggers.
- **No foreign keys, no soft-delete flags.** `dispatch_contexts.task_id`, `decision_gates.task_id`, message payload ids are all unenforced strings; after `resetTasks()`, surviving messages point at nonexistent tasks. Handles in `messages` survive terminal deletion by design (`db.ts:391-394`).
- **`PRAGMA user_version = 5`** is the schema version (`db.ts:44, 159, 251`) — the visualizer's compatibility check. Migration history: v2 `last_heartbeat_at` + heartbeat type, v3 `delivered_at`, v4 `created_by_terminal_handle`, v5 `task_title`/`display_name` (`db.ts:37-43`).
- **`sqlite_sequence`** (from `messages` AUTOINCREMENT): `seq` vs `COUNT(*)`/`MIN(sequence)` detects historical resets.
- **`rowid` ordering on `dispatch_contexts` is load-bearing** — the source's own "latest dispatch" queries use `MAX(rowid)` (`db.ts:511-515, 616, 653`); safe for a visualizer to use for attempt ordering.
- **Timestamp formats are split** (verified live): columns written by SQL defaults or `datetime('now')` — all `created_at`s, `dispatch_contexts.dispatched_at/completed_at`, `messages.delivered_at`, `decision_gates.resolved_at`, `last_heartbeat_at` — are `'YYYY-MM-DD HH:MM:SS'` UTC; columns written from JS — `tasks.completed_at`, `coordinator_runs.completed_at` (`db.ts:527-528, 835-836`) — are ISO-8601 `'…T…Z'` (live: 55/55 ISO). Normalize before comparing across columns.
- **DB location:** `join(app.getPath('userData'), 'orchestration.db')` (`orca-runtime.ts:2891-2898`), lazily opened, WAL + `synchronous=NORMAL` + `busy_timeout=5000` (`db.ts:49-56`). Matches HANDOFF.md.

## What this means for the visualizer

- **Honest history offering:** a full, ordered event feed (messages by `sequence`) + per-attempt dispatch history + gate Q&A — but task *status timelines* can only be approximated (creation, per-attempt dispatch, completion are timestamped; `ready` promotions and re-transitions are not).
- **Run scoping must be inferred**, not queried: cluster by `created_by_terminal_handle` + time gaps; don't rely on `coordinator_runs` or a `dispatch`-typed message stream — both are empty in real usage.
- **Render gates from `decision_gate` messages**, not the `decision_gates` table.
- **Expect unbounded growth and multi-run mixing**; offer time-window filtering, and treat `sequence` observed at startup as a natural "live from here" cursor.

## Live DB snapshot used for corroboration (read-only, 2026-07-11)

| Metric | Value |
|---|---|
| `user_version` | 5 |
| tables | the 5 documented + `sqlite_sequence`; no views/triggers |
| rows | 72 tasks, 62 dispatch_contexts, 447 messages, 0 decision_gates, 0 coordinator_runs |
| message types | 291 heartbeat, 58 worker_done, 53 decision_gate, 45 status; 0 dispatch/merge_ready/escalation/handoff |
| task statuses | 54 completed, 7 dispatched, 6 pending, 4 ready, 1 failed |
| date span | 2026-07-08 → 2026-07-11 (4 distinct days of runs coexisting) |
| reset evidence | none ever: `sqlite_sequence.seq` = 447 = `COUNT` = `MAX(sequence)`, `MIN(sequence)` = 1 |
| `created_by_terminal_handle` | 68/72 populated |
| retries | none yet (no task with >1 dispatch context) |
