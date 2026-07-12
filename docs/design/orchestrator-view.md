# The orchestrator view — design brief

**Status:** approved by the maintainer against the mockup in `orchestrator-view.mockup.html`
(open that file in a browser before writing any code; it is the target, and it is clickable).

**One sentence:** the tool stops being a viewer of *inferred runs full of tasks* and becomes a
viewer of *an orchestrator and the agents it spawned, and what they said to each other*.

---

## 1. Why the current screen fails

The maintainer's words: *« quand je clique sur un truc, j'ai beaucoup de mal à comprendre… on
regroupe absolument tout par terminal ID et après ça fait un gros bordel à l'intérieur. »*

Three concrete failures, and they compound:

1. **The cast is invisible.** The database knows exactly who orchestrated and who worked — and
   neither ever appears on screen. The rail says "Runs (inferred)" and names the row after the
   first task's title. The orchestrator, the main character, is nowhere.
2. **The 6-hour split is an invisible boundary.** A run silently ends after six idle hours. The
   user never sees the rule, only its consequences: the same terminal producing several unrelated
   rows, for no reason the screen ever gives.
3. **The feed is a flat list.** A message has a *sender* and a *recipient*. Rendered as a flat
   stream of rows, "who is talking to whom" — the only thing the user actually wants — is the one
   thing you cannot read.

## 2. The model, which is already in the database

Nothing here needs inventing. It needs *naming*:

| Screen concept | Column |
|---|---|
| **The orchestrator** (a Claude Code session told "you are the coordinator") | `tasks.created_by_terminal_handle` |
| **The agents it spawned** | the `dispatch_contexts.assignee_handle`s of that orchestrator's tasks |
| **Who said what to whom** | `messages.from_handle` → `messages.to_handle` |

Research on the live database confirms `created_by_terminal_handle` clusters cleanly by
coordinator terminal (14, 13, 10, 10, 6, 4 tasks per handle). So a "run" already *is* "an
orchestrator session + its workers". We simply never said so.

## 3. The trap that makes or breaks this feature

**When the orchestrator dispatches an agent, it writes no message.** Orca injects the prompt
straight into the worker's PTY. The live database has **zero** `type = 'dispatch'` message rows
(SPEC §4.2, trap 2).

So a "conversation" built from the `messages` table alone shows agents talking into the void, to
an orchestrator that never answers. **The conversation must be merged from four sources:**

| Turn | Source |
|---|---|
| Orchestrator → agent (the prompt) | `tasks.spec`, timestamped by `dispatch_contexts.dispatched_at` |
| Agent → orchestrator | `messages` (`status`, `escalation`, `worker_done`) |
| Agent asks / orchestrator answers | a `decision_gate` message, and the reply whose `thread_id` = the gate message's `id` |
| The final report | `tasks.result`, timestamped by `tasks.completed_at` |

**This merge is the real work of this ticket.** Everything else is presentation.

## 4. The four decisions the maintainer signed off

1. **The rail lists orchestrators — one row per `created_by_terminal_handle`.** The 6-hour rule no
   longer decides a row's identity. A terminal reused over four days is **one** row.
2. **The 6-hour rule is demoted to a "wave".** It does not disappear — it becomes a *visible*
   grouping inside the canvas: tasks separated by more than six idle hours are drawn in separate
   bordered regions, captioned « Vague 2 · après 14 h d'inactivité ». The time gap is now
   **shown** instead of silently **imposed**.
3. **The cast is the pivot.** The orchestrator and its agents are listed under the selected rail
   row. Selecting an agent dims the rest of the canvas to its tasks and fills the conversation
   panel. This is the tool's central gesture.
4. **Status keeps the hue; the agent gets the edge.** A node's fill stays its *status* colour —
   those six were signed off on screen and retuning them is re-approval, not refactoring
   (`canvas/theme.ts`). Agent identity is a **4px left stripe + a monogram badge** (A1, A2, A3).
   Two colour systems cannot both win the same pixel.

## 5. What to build

### Server (`src/server/`) — the substance

- **`cast.ts` (new).** Per orchestrator: the coordinator handle, plus every agent handle derived
  from the `assignee_handle`s of that orchestrator's dispatch contexts. Per agent: its task count,
  its latest heartbeat (for the "vu il y a 12 s" badge), and its task ids.
- **`conversation.ts` (new).** The four-source merge of §3, ordered by normalized instant, scopable
  to one orchestrator, one agent, or one task. Every turn carries `from`, `to`, `kind`, `at`,
  `taskId`, and a `source` string naming the columns it was reconstructed from (the mockup shows
  these as a small muted caption — keep them, this project tells the truth about its derivations).
- **`runs.ts`.** Stop splitting on the 6-hour gap for *identity*. A run is now one handle. Instead
  emit `waves: {startedAt, endedAt, taskIds, idleGapBeforeMs}[]` — same threshold
  (`IDLE_GAP_MS`), new job. The run id must stay deterministic and stable across restarts (the
  rail cannot hold a selection across ids that change on every boot) — drop the epoch suffix and
  key on the handle alone.
- **Heartbeats stay out of the conversation by default**, collapsed into one summary row (they are
  ~65% of all messages — SPEC §4.2, trap 4).
- **`schema.ts` — the degradation contract must gain entries.** The cast dies without
  `dispatch_contexts.task_id` / `assignee_handle`; the orchestrator side of the conversation dies
  without `tasks.spec`. A feature with no entry in `FEATURES` degrades **silently**, which is the
  one failure that file exists to prevent. Add them, worded for a human.

### Client (`src/client/`)

- **`rail/`** — orchestrators, with the cast nested under the open one. The hierarchy is real: an
  orchestrator *contains* its agents, so nest rather than opening a fourth column.
- **`canvas/`** — the agent stripe + monogram on `TaskNode`, dimming of non-selected agents' nodes,
  and the wave regions behind the graph.
- **`feed/` → a conversation panel** — sender → recipient on every turn, incoming left / outgoing
  right, the gate and its answer threaded together, heartbeats collapsed to one line.

## 6. What must not break

- **Read-only. Always.** Every connection is `readOnly: true`; there is no write path in this tool
  and this ticket adds none. (`README.md`, SPEC §1.2.)
- **Render what parses.** Never crash on schema drift. Introspect real columns; a missing column
  costs exactly the feature that needed it, and says so on screen. (SPEC §5.)
- **No foreign keys exist.** Every `task_id` is a soft string, and after an `orchestration reset`
  messages point at tasks that are gone. **Every join must tolerate a miss** — an unattributable
  message still appears, attached to nobody. (SPEC §4.2, trap 8.)
- **Timestamps are two formats.** Normalize to an ISO-8601 UTC instant at the server boundary
  before comparing anything. The merge in §3 compares columns written by *both* writers, so this
  trap is directly in this feature's path. (SPEC §4.2, trap 5.)
- **The six status colours are approved.** Don't retune them to make room for agent colours; the
  agent takes the stripe (§4.4).
- **`Unattributed`** — tasks with a null handle — still needs a home in the rail. It is not an
  orchestrator; label it as what it is.

## 7. Done means

- The rail lists orchestrators; selecting one shows its cast.
- Selecting an agent dims the canvas to its tasks and fills the conversation.
- The conversation shows **both sides** — a dispatch prompt from the orchestrator, the agent's
  replies, a gate and its answer, the final result.
- A time gap over six hours is visible as a captioned wave, not as a second rail row.
- `SPEC.md` is updated to match (§4.3 run inference, §7.1 layout, §7.2 rail, §7.6/§7.7 feed).
- Tests pass, and the new derivations have their own.
