# Handoff: Orca Orchestration Visualizer

Context transferred from a prior Claude Code conversation inside the Orca codebase (`/home/dev/projects/orca`, github.com/stablyai/orca). That conversation established feasibility; this repo (`nvergez/orca-orchestrator-visualizer`) is where the MVP gets built.

## The idea

A standalone web-based visualizer for Orca's multi-agent orchestration: render the live task DAG (nodes = tasks colored by status, edges = dependencies), which agent is working each task, decision gates, and the inter-agent message flow — by reading Orca's orchestration database from outside the app.

## Verified facts (do not re-derive)

- **All orchestration state lives in one SQLite file**: `~/.config/orca/orchestration.db` on this Linux machine (Electron `userData` dir; an `orca-dev` variant exists for dev builds; macOS/Windows paths differ). WAL mode.
- **External read-only access works while Orca runs and writes.** Tested live with Node 22's built-in `node:sqlite`: `new DatabaseSync(path, { readOnly: true })` read 67 tasks / 438 messages with zero deps. WAL is designed for concurrent readers + one writer. (`node:sqlite` prints an experimental warning; `better-sqlite3` is the alternative.)
- **Never write to this DB from outside.** Orca's coordinator keeps invariants (e.g. promoting `pending → ready` when all deps complete) inside its own write transactions and assumes it is the single writer. Mutations go through the `orca orchestration ...` CLI if ever needed.
- **No change notifications.** The DB is passive; Orca's own coordinator polls it every 2s. A visualizer can poll every 1–2s, optionally using `fs.watch` on the `-wal` file as a cheap "something changed" hint.
- **Schema is internal and unversioned as a public API** — currently `SCHEMA_VERSION = 5`; it can change between Orca releases. Degrade gracefully (check schema at startup). A more stable but app-dependent alternative: shell out to `orca orchestration task-list / inbox / gate-list --json` (on Linux the binary is `orca-ide`), which hits the same DB via Orca's unix-socket RPC.
- **Not in Orca's upstream plans.** Searched stablyai/orca issues/PRs/docs: no orchestration visualizer exists or is planned. Closest: PR #6746 (Git commit graph, unrelated), issues #7430/#7434 (CLI editing of task deps — people are working with the DAG blind today). Orca's only live orchestration UI is a sidebar agent-lineage tree; its renderer has no graph library (only mermaid for static diagrams).
- Orchestration in Orca is experimental, gated by localStorage flag `orca.orchestration.enabled`.

## The schema (v5, from Orca source `src/main/runtime/orchestration/db.ts` + `types.ts`)

Five tables:

| Table | Purpose | Key columns |
|---|---|---|
| `tasks` | DAG nodes | `id` (PK, `task_<hex>`), `parent_id`, `created_by_terminal_handle`, `task_title`, `display_name`, `spec`, `status`, `deps` (**JSON string array of task ids = the DAG edges**), `result`, `created_at`, `completed_at` |
| `dispatch_contexts` | task → agent assignment + circuit breaker | `id`, `task_id`, `assignee_handle`, `status`, `failure_count` (breaker trips at 3), `last_failure`, `dispatched_at`, `completed_at`, `last_heartbeat_at` |
| `messages` | threaded inter-agent mail | `id`, `from_handle`, `to_handle`, `subject`, `body`, `type`, `priority`, `thread_id`, `payload`, `read`, `sequence` (AUTOINCREMENT — good poll cursor), `created_at`, `delivered_at` |
| `decision_gates` | blocking approval checkpoints | `id`, `task_id`, `question`, `options` (JSON), `status`, `resolution`, `created_at`, `resolved_at` |
| `coordinator_runs` | coordinator loop instances | `id`, `spec`, `status`, `coordinator_handle`, `poll_interval_ms`, `created_at`, `completed_at` |

Enums:
- `TaskStatus`: `pending | ready | dispatched | completed | failed | blocked`
- `DispatchStatus`: `pending | dispatched | completed | failed | circuit_broken`
- `MessageType`: `status | dispatch | worker_done | merge_ready | escalation | handoff | decision_gate | heartbeat`
- `GateStatus`: `pending | resolved | timeout`; `CoordinatorStatus`: `idle | running | completed | failed`

`tasks.parent_id` gives the decomposition hierarchy; `tasks.deps` gives dependency edges; `dispatch_contexts.assignee_handle` links a task to the terminal/agent working it; `messages.thread_id` groups conversations, and typed messages (`worker_done`, `escalation`, `heartbeat`…) can be animated along graph edges.

## Proposed MVP shape (from the feasibility discussion — open to revision)

- Small Node server: opens the DB read-only, polls 1–2s (or `fs.watch` on `-wal`), pushes snapshots to the browser via SSE or WebSocket. DB path configurable with per-platform defaults.
- Web frontend: React Flow (`@xyflow/react`) + dagre or elkjs auto-layout for the DAG. Task nodes colored by status, dep edges, agent-assignment badges from dispatch contexts, decision-gate markers, message/event feed panel (keyed on `messages.sequence`).
- Live data is available right now on this machine at `~/.config/orca/orchestration.db` for development against real orchestration runs.

## Repo state

Fresh repo: only the agent-skills setup is committed (`.claude/skills/`, `.agents/`, `skills-lock.json`). No app code yet. Remote: `github.com/nvergez/orca-orchestrator-visualizer` — usable as the wayfinder issue tracker.
