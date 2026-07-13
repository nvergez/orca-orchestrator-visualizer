# Reference — Orca's orchestration database (schema v5)

**Verified facts about the database `orca-viz` reads. Do not re-derive them.**

This is a lookup, not a decision document. It records what Orca's database *is* and how it behaves. What `orca-viz` *does* about that is settled in [`SPEC.md`](../../SPEC.md), and where the two ever seem to disagree, `SPEC.md` governs — it was written knowing all of this.

The facts below were established against a live `orchestration.db` during the feasibility investigation inside the Orca codebase (`github.com/stablyai/orca`), and are corroborated with `file:line` citations by [`db-history.md`](../research/db-history.md) and [`db-discovery.md`](../research/db-discovery.md).

## Verified facts

- **All orchestration state lives in one SQLite file.** `~/.config/orca/orchestration.db` on Linux (Electron's `userData` dir; an `orca-dev` variant exists for dev builds, and macOS/Windows paths differ — see `SPEC.md` §3 for the full resolution order). WAL mode.
- **External read-only access works while Orca runs and writes.** Tested live with Node 22's built-in `node:sqlite`: `new DatabaseSync(path, { readOnly: true })` read 67 tasks / 438 messages with zero dependencies. WAL is designed for concurrent readers plus one writer. (`node:sqlite` prints an experimental warning; `better-sqlite3` is the alternative.)
- **Never write to this database from outside.** Orca's coordinator keeps invariants — e.g. promoting `pending → ready` once all deps complete — inside its own write transactions, and assumes it is the single writer.
- **There are no change notifications.** The database is passive; Orca's own coordinator polls it every 2 s. Any external reader must poll too.
- **The schema is internal, and unversioned as a public API.** Currently `SCHEMA_VERSION = 5`, exposed as `PRAGMA user_version`. It can change between Orca releases, and the migration history to date is purely additive (v2 `last_heartbeat_at`, v3 `delivered_at`, v4 `created_by_terminal_handle`, v5 `task_title`/`display_name`).
- **Orchestration in Orca is experimental**, gated behind the localStorage flag `orca.orchestration.enabled`.

## The schema (v5)

From Orca source: `src/main/runtime/orchestration/db.ts` and `types.ts`.

Five tables:

| Table | Purpose | Key columns |
|---|---|---|
| `tasks` | DAG nodes | `id` (PK, `task_<hex>`), `parent_id`, `created_by_terminal_handle`, `task_title`, `display_name`, `spec`, `status`, `deps` (**JSON string array of task ids = the DAG edges**), `result`, `created_at`, `completed_at` |
| `dispatch_contexts` | task → agent assignment + circuit breaker | `id`, `task_id`, `assignee_handle`, `status`, `failure_count` (breaker trips at 3), `last_failure`, `dispatched_at`, `completed_at`, `last_heartbeat_at` |
| `messages` | threaded inter-agent mail | `id`, `from_handle`, `to_handle`, `subject`, `body`, `type`, `priority`, `thread_id`, `payload`, `read`, `sequence` (AUTOINCREMENT — the poll cursor), `created_at`, `delivered_at` |
| `decision_gates` | blocking approval checkpoints | `id`, `task_id`, `question`, `options` (JSON), `status`, `resolution`, `created_at`, `resolved_at` |
| `coordinator_runs` | coordinator loop instances | `id`, `spec`, `status`, `coordinator_handle`, `poll_interval_ms`, `created_at`, `completed_at` |

Enums:

- `TaskStatus`: `pending | ready | dispatched | completed | failed | blocked`
- `DispatchStatus`: `pending | dispatched | completed | failed | circuit_broken`
- `MessageType`: `status | dispatch | worker_done | merge_ready | escalation | handoff | decision_gate | heartbeat`
- `GateStatus`: `pending | resolved | timeout`
- `CoordinatorStatus`: `idle | running | completed | failed`

`tasks.parent_id` gives the decomposition hierarchy; `tasks.deps` gives the dependency edges; `dispatch_contexts.assignee_handle` links a task to the terminal working it; `messages.thread_id` groups conversations.

## What this reference deliberately does not tell you

The columns above are not the whole truth, and reading them naively produces a tool that is confidently wrong. **Several of these tables are empty in practice, and several of these message types are never written.** Those traps — and what to build instead — are `SPEC.md` §4.2. Read them before you query anything.

---

*Provenance: this document is the surviving half of the original `HANDOFF.md`, the context transfer from the feasibility conversation that started this repo. Its other half — a proposed MVP shape, and a snapshot of a then-empty repo — was superseded by `SPEC.md` and removed. That investigation also searched `stablyai/orca`'s issues, PRs and docs and found no orchestration visualizer existing or planned upstream, which is why this tool is a standalone external reader rather than a contribution (`SPEC.md` §1.3).*
