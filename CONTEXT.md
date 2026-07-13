# Orca Orchestration Visualizer

orca-viz observes Orca's retained orchestration database and turns incomplete, fallible evidence into an honest supervision view and an honest post-mortem reading — without ever becoming part of the orchestration it observes, and without claiming more than the database can prove. That includes saying what *cannot* be concluded when parts of the retained history have disappeared.

## Language

### Orchestrators and workers

**Orchestrator**:
The terminal that created a group of tasks, together with the work it coordinated. The wire type remains `Run`, but the product names the thing an orchestrator.
_Avoid_: Coordinator, inferred run

**Worker**:
A terminal assigned at least one dispatch attempt by an orchestrator.
_Avoid_: Agent, assignee

**Orchestrator Run**:
The tasks and evidence attributed to one orchestrator terminal handle, including all of its recorded waves of work.
_Avoid_: Session, inferred run

### Activity, health and liveness

**Convergence**:
Whether every task in an orchestrator run has reached a terminal outcome. A run that still contains work which can advance or unblock has not converged.
_Avoid_: Liveness, activity

**Last Activity**:
The newest retained timestamp that evidences work on an orchestrator run. It is evidence of activity, not proof that a process is still running.
_Avoid_: End time, last seen

**Run Health**:
A run's relationship to convergence and the recency of its last activity: active, silent, or finished.
_Avoid_: Run liveness

**Active Run**:
A run that has not converged and has recent activity evidence.
_Avoid_: Alive run, working terminal

**Silent Run**:
A run that has not converged but has no recent activity evidence.
_Avoid_: Dead run, ended run, stuck run

**Finished Run**:
A run whose tasks have all converged, regardless of how recently the final activity occurred.
_Avoid_: Inactive run

**Run activity**:
The evidence-based state of an orchestrator's work: recently active, unfinished but silent, or finished. It is independent of whether the Orca process is running.
_Avoid_: Live dot, process liveness

**Worker health**:
The recency and kind of activity evidence for a dispatched worker, derived from dispatch and heartbeat times. It never diagnoses whether the worker terminal is alive or dead.
_Avoid_: Worker liveness, dead worker

**Orca Process Liveness**:
Whether the visualizer can verify that the Orca process associated with the database is currently running.
_Avoid_: Run liveness, run health

**Data age**:
Elapsed wall time since the browser successfully applied its last orchestration snapshot. It is shown separately from the stream connection state.
_Avoid_: Connection age, database age

### Decision gates

**Decision Gate**:
A recorded question whose lifecycle may affect whether an orchestration can continue. Its lifecycle state and its present blocking effect are separate facts.
_Avoid_: Open gate, unresolved gate

**Blocking Decision Gate**:
A decision gate for which current durable orchestration state proves that work is paused. A pending gate is blocking; an unanswered ask is blocking only while its named task is currently blocked.
_Avoid_: Open gate

**Unanswered Ask**:
A question sent through the ask flow with no recorded answer or gate lifecycle. It proves that no answer was retained, but not that the orchestration is still waiting.
_Avoid_: Open gate, timed-out ask

### Retained evidence and attribution

**Retained evidence**:
Rows that exist in Orca's orchestration database at the moment orca-viz reads them; it excludes events the database overwrote, deleted, or never recorded.
_Avoid_: Complete history, event log

**Attribution Window**:
The bounded period in which handle evidence may associate a task-id-less message with an orchestrator run.
_Avoid_: Run lifetime

**Evidence hint**:
An explicitly uncertain agent-kind or repository label derived from unambiguous retained evidence and accompanied by its provenance.
_Avoid_: Identity, classification

### Retained history, and its loss

**Task graph history**:
The retained tasks and the orchestration records that belong to them, including dispatch attempts, decision gates, and coordinator runs.
_Avoid_: Task history, graph tables

**Message history**:
The retained inter-agent messages, whose ordering can reveal that earlier messages were removed.
_Avoid_: Feed history, conversation history

**Orphaned task reference**:
A task reference retained in message history whose task is absent from the current task graph history. It is evidence of a missing relationship, not by itself evidence of why the task is absent.
_Avoid_: Deleted-task message, reset message

**History-loss signal**:
A conservative, user-visible statement that the retained database has a structural shape consistent with missing history. It describes observable evidence and does not claim which command or actor caused it.
_Avoid_: Reset proof, reset event

### Post-mortem reading

**Post-mortem report**:
A quantitative reading of one orchestrator run assembled from retained evidence, including durations, outcomes, and per-agent comparisons.
_Avoid_: Analytics dashboard, audit log

**Outcome receipt**:
A task result or worker completion payload whose recognized fields describe produced files, links, branches, tickets, reports, or the completing agent; unrecognized content remains retained evidence and is shown verbatim.
_Avoid_: Result blob, completion message

**Run archive**:
A versioned, self-contained, one-shot export of exactly one selected orchestrator run's retained evidence at the moment the user requests it.
_Avoid_: Recording, backup, database export

**Archived replay**:
A read-only rendering of a run archive that is explicitly offline and makes no claim of current liveness.
_Avoid_: Live replay, restored run

### What the client fetches

**Run index**:
A cursor-paginated list of lightweight orchestrator-run summaries used to navigate retained history without loading every run's evidence at once.
_Avoid_: History window, complete snapshot

**Selected-run snapshot**:
The complete retained evidence for one selected orchestrator run, fetched as a unit without time-windowing or truncation.
_Avoid_: Run page, history slice

**Invalidation notice**:
The identity a live stream event carries of the retained evidence that changed, so a reader refetches only the affected run summaries and selected run rather than the whole database. It names what to read again; it never carries the evidence itself.
_Avoid_: Delta, patch, diff

### Live supervision

**Attention item**:
One current, explainable reason a supervisor may need to intervene, with a stable identity and a destination in the orchestration view.
_Avoid_: Alert, notification

**Attention queue**:
The ranked cross-orchestrator collection of attention items. Desktop notifications are an optional delivery mechanism for new queue entries, not the queue itself.
_Avoid_: Alert feed

**Session activity**:
A bounded narration of transitions observed after the current browser session established its baseline. It is not durable orchestration history.
_Avoid_: Replay, audit log, event store

**Wake hint**:
A fallible filesystem signal that asks the authoritative SQLite poll to run early. It never supplies orchestration facts itself.
_Avoid_: Change event, WAL event source

**Live enrichment**:
Optional, ephemeral Orca CLI context joined to an exact worker identity when possible. It may add worktree or current-activity context but never changes SQLite-derived orchestration truth.
_Avoid_: Secondary data source

**Kiosk**:
A non-interactive overview of unfinished orchestrations for continuous display. It summarizes supervision state and deliberately omits the task DAG and historical browsing.
_Avoid_: Dashboard mode, fullscreen mode
