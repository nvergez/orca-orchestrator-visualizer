# Research: the `orca` CLI as a data source for the visualizer

**Ticket:** [#4 — The orca CLI as a data source](https://github.com/nvergez/orca-viz/issues/4)
**Evaluated against:** Orca app v1.4.128 on Linux (`ORCA_APP_VERSION=1.4.128`), live orchestration run in flight; Orca source read at `/home/dev/projects/orca`.
**Date:** 2026-07-11

## TL;DR / Recommendation

The CLI is a **viable but second-choice data source for the hot polling loop, and a good complement**:

- **Coverage:** 4 of 5 tables are readable (`tasks`, `messages`, `dispatch_contexts`, `decision_gates`). `coordinator_runs` has **no CLI read command at all**. `task-list` helpfully joins in `assignee_handle` + `dispatch_id` for currently-dispatched tasks, so the task→agent assignment edges come for free; the *rest* of `dispatch_contexts` (`failure_count`, `last_failure`, `last_heartbeat_at`, timestamps) is only readable **one task at a time** (`dispatch-show --task <id>` — no bulk "dispatch-list").
- **Fidelity:** the read commands return the **raw SQLite rows verbatim** (snake_case column names, `deps`/`result`/`payload` still JSON-encoded strings, `read` as 0/1 integer) wrapped in an RPC envelope. There is no stable DTO layer — the CLI's JSON is exactly as schema-coupled as reading the DB directly.
- **Liveness requirement:** every call is a unix-socket RPC to the running app. With Orca closed the CLI **fails fast (~0.4s, exit 1)** with a structured `{"ok": false, "error": {"code": "runtime_unavailable", ...}}` — it does not auto-start the app and does not hang.
- **Latency (measured):** ~0.3s per call best-case, dominated by Electron-as-Node process startup (~0.15–0.2s) + CLI bundle load, not the RPC. On this busy 2-vCPU machine a 3-command poll cycle measured **1.3–5.8s** (sequential) and **1.4–2.0s** (parallel — worse than expected due to spawn contention). A strict 1–2s polling loop via CLI subprocesses is **not dependable under load**; 3–5s is realistic. Direct SQLite reads are ~3 orders of magnitude cheaper.

**Recommended architecture:** direct read-only SQLite for the poll loop; use the CLI for (a) one-shot debugging/handheld inspection, (b) a startup sanity check (`orca status --json`), and (c) a graceful-degradation fallback if the on-disk schema version is newer than the visualizer understands. Long-term, the most interesting alternative is not the CLI binary but the runtime's own RPC endpoints (unix socket / websocket published in `orca-runtime.json`) — same data, no process-spawn cost — but that is even deeper into unversioned internals.

---

## 1. Subcommand inventory

`orca orchestration --help` lists 16 subcommands. Relevant read-only ones:

| Command | Reads | Notes |
|---|---|---|
| `task-list [--status <s>] [--ready] [--json]` | `tasks` | full table, filterable by status |
| `inbox [--limit <n>] [--terminal <handle>] [--full] [--json]` | `messages` | across all recipients, or one handle |
| `gate-list [--task <id>] [--status <s>] [--json]` | `decision_gates` | filterable |
| `dispatch-show --task <task_id> [--json]` | `dispatch_contexts` | **one task per call**; no bulk list |
| `check [--terminal <h>] [--unread\|--all] [--wait] [--json]` | `messages` | ⚠️ default `--unread` **marks messages read** — mutating; a visualizer must never use it |
| `orca status --json` | (none) | app/runtime/graph readiness — good liveness probe |

The rest are mutations (`send`, `reply`, `task-create`, `task-update`, `dispatch`, `ask`, `run`, `run-stop`, `gate-create`, `gate-resolve`, `reset`) — off-limits for a strictly read-only visualizer.

Adjacent read-only commands outside `orchestration`:

- `orca worktree ps --json` — live agent/pane view (camelCase DTO: per-worktree `agents[]` with `state`, `agentType`, `taskTitle`, `lastAssistantMessage`, current `toolName`/`toolInput`). Despite the "orchestration summary" billing it does **not** join the orchestration DB at all (`getWorktreePs`, `src/main/runtime/orca-runtime.ts:10847+`) — but it's rich **enrichment** data ("what is the agent literally doing right now") that SQLite cannot provide.
- `orca terminal list --json` — maps terminal handles to worktrees/titles; useful for resolving `assignee_handle` to something human-readable.

## 2. Output shapes (real, captured live)

All orchestration reads share one envelope:

```json
{
  "id": "<uuid of the RPC call>",
  "ok": true,
  "result": { ... },
  "_meta": { "runtimeId": "41a96d9e-378c-4587-a47c-40a092330473" }
}
```

On failure (`ok: false`) there is an `error: {code, message}` instead of `result`, and the process exits 1.

### `task-list --json` → `result.tasks[]` + `result.count`

```json
{
  "id": "task_61292583874c",
  "parent_id": null,
  "created_by_terminal_handle": "term_2ffffb19-…",
  "task_title": "DRAFT (do NOT publish) the issue breakdown…",
  "display_name": "DRAFT (do NOT publish) the issue breakdown…",
  "spec": "…full spec text…",
  "status": "completed",
  "deps": "[]",
  "result": "{\"completedBy\":\"term_44902474-…\",\"filesModified\":[],\"completedAt\":\"2026-07-08T12:38:17.798Z\"}",
  "created_at": "2026-07-08 12:32:13",
  "completed_at": "2026-07-08T12:38:28.374Z"
}
```

Note: `deps` and `result` are **JSON-encoded strings**, exactly as stored in SQLite — the consumer still double-parses, same as with direct DB reads. Note also the mixed timestamp formats (`created_at` is SQLite `datetime('now')` format, `completed_at` is an ISO string) — raw storage leaking through.

**Dispatched tasks carry two extra joined fields** (verified in the live capture):

```json
{ "id": "task_7837bec84be9", "status": "dispatched",
  "assignee_handle": "term_f627dc6f-…", "dispatch_id": "ctx_64d18723cdec", "…": "…" }
```

The server handler runs `SELECT t.*, d.assignee_handle, d.id AS dispatch_id` and strips the two fields from non-dispatched rows (`src/main/runtime/rpc/methods/orchestration.ts:389-411`, `db.ts:488-524`). So one `task-list` call gives both DAG nodes *and* current agent assignments.

### `inbox --json` → `result.messages[]` + `result.count`

```json
{
  "id": "msg_99775bbc1ab8",
  "from_handle": "term_9c0978ce-…",
  "to_handle": "term_27fe39ce-…",
  "subject": "alive",
  "body": "",
  "type": "heartbeat",
  "priority": "normal",
  "thread_id": null,
  "payload": "{\"taskId\":\"task_c7c63ad268b4\",\"dispatchId\":\"ctx_79d021e50f19\",\"phase\":\"investigating\"}",
  "read": 0,
  "sequence": 444,
  "created_at": "2026-07-11 20:56:04",
  "delivered_at": null
}
```

`read` is the raw SQLite integer 0/1; `payload` a JSON string; `sequence` present (the good poll cursor). `inbox` does **not** mark messages read (`check` does).

### `gate-list --json` → `result.gates[]` + `result.count`

No live gate existed during testing (`{"gates": [], "count": 0}`); per the handler source the rows come straight from the `decision_gates` table like the others (see §5).

### `dispatch-show --task <id> --json` → `result.dispatch` (single object)

```json
{
  "id": "ctx_79d021e50f19",
  "task_id": "task_c7c63ad268b4",
  "assignee_handle": "term_9c0978ce-…",
  "status": "dispatched",
  "failure_count": 0,
  "last_failure": null,
  "dispatched_at": "2026-07-11 20:55:14",
  "completed_at": null,
  "created_at": "2026-07-11 20:55:14",
  "last_heartbeat_at": "2026-07-11 20:56:04"
}
```

### `orca status --json`

```json
{
  "id": "local-status",
  "ok": true,
  "result": {
    "app":     { "running": true, "pid": 1589834 },
    "runtime": { "state": "ready", "reachable": true, "runtimeId": "41a96d9e-…" },
    "graph":   { "state": "ready" }
  },
  "_meta": { "runtimeId": "41a96d9e-…" }
}
```

## 3. Coverage matrix — CLI vs SQL

| Table | SQL (direct read) | CLI command | Column coverage | Gaps / notes |
|---|---|---|---|---|
| `tasks` | ✅ all rows | `task-list` | **All 11 columns, 1:1, raw names** + joined `assignee_handle`/`dispatch_id` on dispatched rows | `--status` / `--ready` filters; `deps`/`result` still JSON strings |
| `messages` | ✅ all rows | `inbox` | **All 13 columns, 1:1, raw names** (incl. `sequence`, `read`) | `--limit`, `--terminal` filters. No `--since <sequence>` cursor filter (query is `SELECT * … ORDER BY sequence DESC LIMIT ?`, `db.ts:387`) — incremental polling must over-fetch and cut client-side |
| `dispatch_contexts` | ✅ all rows | partial via `task-list` join; full row via `dispatch-show --task <id>` | All 10 columns, 1:1 (per task) | Assignment edges come free with `task-list`; but `failure_count`, `last_failure`, `last_heartbeat_at` require **one call per task** (~0.3–0.9s each). No bulk dispatch-list |
| `decision_gates` | ✅ all rows | `gate-list` | All columns (per handler source; verified empty-set live) | `--task`, `--status` filters |
| `coordinator_runs` | ✅ all rows | **none** | **0%** | The registered RPC method set (`send, check, reply, inbox, taskCreate, taskList, taskUpdate, dispatch, dispatchShow, ask, reset` in `rpc/methods/orchestration.ts` + `run, runStop, gateCreate, gateResolve, gateList` in `orchestration-gates.ts`) contains no read-back for runs; the table is only read internally (e.g. `getActiveCoordinatorRun`, `db.ts:848`). A visualizer can't show coordinator state via CLI |

Enrichment only the CLI side has: `worktree ps` (live agent activity, prompts, tool calls), `terminal list` (handle → human name), `status` (liveness). Enrichment only SQL has: everything at once, atomically-ish, in one cheap query, plus `coordinator_runs`.

## 4. Works without the app? Latency?

**Requires the running app.** Verified live with a scrubbed environment (`env -i HOME=<empty dir>` so the CLI can't find runtime metadata — equivalent to Orca not running):

```json
{
  "id": "local",
  "ok": false,
  "error": {
    "code": "runtime_unavailable",
    "message": "Could not read Orca runtime metadata at …/.config/orca/orca-runtime.json. Start the Orca app first."
  },
  "_meta": { "runtimeId": null }
}
```

Exit code 1, wall time ~0.41s. No auto-start, no hang. Discovery works via `<userData>/orca-runtime.json`, which the app writes on startup:

```json
{
  "runtimeId": "41a96d9e-…",
  "pid": 1589834,
  "transports": [
    { "kind": "unix",      "endpoint": "/home/dev/.config/orca/o-1589834-41a9.sock" },
    { "kind": "websocket", "endpoint": "ws://0.0.0.0:6768" }
  ],
  "authToken": "<48-hex-char token>",
  "startedAt": 1783682752128
}
```

(Inside Orca-managed terminals, `ORCA_USER_DATA_PATH` overrides the discovery dir — that's why a naive `HOME=` test still connects.)

Note the SQLite file **outlives the app** — direct DB reads keep working when Orca is closed (showing the last-known state), while the CLI goes dark entirely. For a visualizer that should still render "yesterday's run" post-mortem, that alone favors SQLite.

**Measured latency** (Linux, 2 vCPU / 4 GB, while a real multi-agent orchestration was running — i.e. realistic load):

| Measurement | Result |
|---|---|
| `orca orchestration task-list --json` (71 tasks, 172 KB) | 0.33–0.73s (typ. ~0.35s) |
| `gate-list --json`, `inbox --limit 20 --json` | 0.29–0.47s |
| `dispatch-show --task … --json` | 0.31–0.90s |
| `orca --help` (no RPC at all) | ~0.31s |
| Bare Electron-as-Node startup (`ELECTRON_RUN_AS_NODE=1 … -e "0"`) | 0.11–0.19s |
| Full 3-command poll cycle, sequential | **1.33s / 2.85s / 5.75s** |
| Full 3-command poll cycle, parallel (`&`+`wait`) | **1.41–1.95s** (spawn contention makes parallel no better) |

Interpretation: ~90% of per-call cost is process startup (Electron binary + CLI bundle load), not the RPC or the query. So CLI polling cost is per-*process*, roughly constant, and **a 1–2s cadence is at or beyond what the CLI can sustain on a small machine** — and that's without the O(N) `dispatch-show` calls needed for assignment edges. At a 3–5s cadence it's fine. Direct SQLite reads of all five tables take single-digit milliseconds.

## 5. Stability of the CLI surface vs the raw schema

**Bottom line: the CLI JSON is not a stability layer — it's the schema over a socket.**

Evidence from Orca source (`/home/dev/projects/orca`, read-only):

**How CLI output is produced — raw rows, no DTO.** All file:line refs are into `stablyai/orca` at the version installed here (v1.4.128); spot-verified by direct reads.

- The CLI handlers just forward the RPC result: `task-list` → `client.call('orchestration.taskList', …)` at `src/cli/handlers/orchestration.ts:478-509`; `inbox` at `:428-460`; `dispatch-show` at `:602-627`; `gate-list` at `:677-693`. Their TypeScript types are already snake_case (`task_title`, `assignee_handle`, …).
- The server-side RPC methods return **raw `SELECT *` rows**: `taskList` (`src/main/runtime/rpc/methods/orchestration.ts:389-411`) calls `db.listTasksWithDispatch()`; `inbox` (`:344-357`) returns `db.getInbox(limit)` directly; `dispatchShow` (`:513-546`) returns `db.getDispatchContext(task)` raw; `gateList` (`src/main/runtime/rpc/methods/orchestration-gates.ts:142-153`) returns `db.listGates(…)`. Representative DB code (`src/main/runtime/orchestration/db.ts:783-804`):

  ```ts
  return this.db.prepare('SELECT * FROM decision_gates ORDER BY created_at')
    .all() as DecisionGateRow[]
  ```

  Same for `getInbox` (`SELECT * FROM messages ORDER BY sequence DESC LIMIT ?`, `db.ts:387`) and `listTasks*` (`db.ts:468-524`). The **only** transform anywhere is `taskList` stripping `assignee_handle`/`dispatch_id` from non-dispatched rows.
- The envelope is minted generically in the RPC dispatcher: `successResponse(id, meta, result)` → `{ id, ok: true, result, _meta }` (`src/main/runtime/rpc/errors.ts:10-17`, called from `src/main/runtime/rpc/dispatcher.ts:85`; `meta = { runtimeId }` at `dispatcher.ts:241-243`).
- **Transport:** newline-delimited JSON over the unix socket — request `{id, authToken, method, params}\n` (`src/cli/runtime/transport.ts:173-182`), response validated against `RuntimeRpcEnvelopeSchema` (`src/shared/runtime-rpc-envelope.ts`), which uses `.strip()` — additive fields tolerated, **no version field in the payload**. Socket path built server-side as `<userData>/o-<pid>-<runtimeId4>.sock` (Windows: named pipe `\\.\pipe\orca-<pid>-<suffix>`) at `src/main/runtime/runtime-rpc.ts:1108-1128`, mode 0600.
- **Versioning that does exist:** an RPC protocol version — `RUNTIME_PROTOCOL_VERSION = 3` with min-compat bounds of 2 (`src/shared/protocol-version.ts:20-23`) — enforced only for remote (paired) runtimes (`src/cli/runtime/client.ts:157-168`). It versions the *transport handshake*, not the row shapes.
- **DB migrations:** `migrate()` (`db.ts:158-257`) reads `PRAGMA user_version`, applies incremental `if (current < N)` steps in one transaction, sets `user_version = 5` on success. History so far is purely **additive** (v2 `last_heartbeat_at`, v3 `delivered_at`, v4 `created_by_terminal_handle`, v5 `task_title`/`display_name`) — mildly reassuring for both consumers.
- **Shape-locking tests exist** — `src/main/runtime/rpc/methods/orchestration.test.ts` asserts the exact snake_case fields (`from_handle` :89, `task_title`/`display_name` :914-915, dispatched-vs-not `assignee_handle` :975-998); `src/cli/index.test.ts` asserts full envelopes. So the current shape is deliberate and regression-guarded, but that's an internal invariant, not a public compatibility promise.
- Two envelope quirks to know: `orca status --json` mints its envelope client-side with `id: "local-status"` (`src/cli/runtime/status.ts:71-80`), and `orca orchestration ask --json` prints a bare envelope-less JSON line (`src/cli/handlers/orchestration.ts:583-599`).

Implications:

- Any schema migration that renames/retypes a column (the thing we fear from `SCHEMA_VERSION = 5` → 6) changes the CLI JSON identically. The CLI only insulates against *storage* changes (file moves, WAL/locking changes, SQLite→something-else), not shape changes.
- The RPC envelope (`id`/`ok`/`result`/`_meta`) and error codes look conventions-stable, but nothing versions them either.
- Practical hedge for the visualizer regardless of source: read `PRAGMA user_version` at startup, render what parses, and label unknown-shape rows as "unknown (newer Orca?)" instead of crashing.

## 6. Binary names & locations per platform

Verified on this machine (Linux) + Orca source for the rest:

From `config/electron-builder.config.cjs` and `src/main/cli/cli-installer.ts`:

| Platform | User-facing command | Bundled launcher (inside install) | Electron executable |
|---|---|---|---|
| **Linux** | `~/.local/bin/orca-ide` (symlink; AppImage installs a wrapper file instead) | `<install>/resources/bin/orca-ide` (e.g. `/opt/Orca/resources/bin/orca-ide`) | `orca-ide` — deliberately not `orca`, to avoid clashing with GNOME Orca / `/usr/bin/orca` (`electron-builder.config.cjs:290-292`; deb/rpm `packageName: orca-ide` :328, :350) |
| **macOS** | `/usr/local/bin/orca` (symlink; falls back to `~/.local/bin/orca` on machines without `/usr/local/bin`) | `Orca.app/Contents/Resources/bin/orca` | default (`Orca`) |
| **Windows** | `%LOCALAPPDATA%/Programs/Orca/resources/bin/orca.cmd` + user-PATH entry | same `.cmd` | `Orca` (`:175`) |
| **dev builds** | `orca-dev` (`cli-installer.ts:23-26`) | — | — |

Key implementation points:

- Install-name logic: `commandName` getter (`cli-installer.ts:72-79`) — Linux gets `orca-ide`, macOS/Windows get `orca`, dev builds `orca-dev`. If the target name already exists and isn't Orca-managed, the installer **refuses** (`Refusing to replace non-Orca command…`, `cli-installer.ts:176-178`) — so `orca` on PATH is not guaranteed to be Orca on any platform.
- The launcher is a bash script (verified on disk here, 1.5 KB) that locates the Electron binary and runs the CLI bundle as plain Node: `ELECTRON_RUN_AS_NODE=1 <electron> resources/app.asar.unpacked/out/cli/index.js "$@"`. This is the source of the ~0.3s per-call floor.
- On this machine there is additionally a 99-byte `~/.local/bin/orca` wrapper (`exec /opt/Orca/resources/bin/orca-ide "$@"`, tagged `orca-serve-bare-orca-dispatcher`) — environment-specific, not standard packaging; the portable name on Linux is **`orca-ide`**.
- Practical consequence for the visualizer: to shell out portably you must probe (`orca-ide` then `orca` on Linux; `orca` elsewhere), and on headless hosts deb/rpm post-install symlinks the CLI onto PATH (`electron-builder.config.cjs:342-347`).

## Appendix: raw captures

Captured live on 2026-07-11 (scratchpad copies): `task-list.json` (172 KB, 71 tasks), `inbox.json`, `gate-list.json`, `dispatch-show.json`, `status.json`, `worktree-ps.json`. Representative excerpts inlined above; handles/tokens partially elided.
