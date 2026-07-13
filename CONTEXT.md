# Orca Orchestration Supervision

orca-viz observes Orca orchestration state and turns incomplete, fallible evidence into an honest supervision view without becoming part of the orchestration itself.

It also presents the retained orchestration history, including what can and cannot be concluded when parts of that history disappear. It describes retained evidence about Orca orchestrations without claiming more than the database can prove.

## Language
**Orchestrator**:
The terminal that created a group of tasks, together with the work it coordinated. The wire type remains `Run`, but the product names the thing an orchestrator.
_Avoid_: Coordinator, inferred run

**Worker**:
A terminal assigned at least one dispatch attempt by an orchestrator.
_Avoid_: Agent, assignee

**Run activity**:
The evidence-based state of an orchestrator's work: recently active, unfinished but silent, or finished. It is independent of whether the Orca process is running.
_Avoid_: Live dot, process liveness

**Worker health**:
The recency and kind of activity evidence for a dispatched worker, derived from dispatch and heartbeat times. It never diagnoses whether the worker terminal is alive or dead.
_Avoid_: Worker liveness, dead worker

**Attention item**:
One current, explainable reason a supervisor may need to intervene, with a stable identity and a destination in the orchestration view.
_Avoid_: Alert, notification

**Attention queue**:
The ranked cross-orchestrator collection of attention items. Desktop notifications are an optional delivery mechanism for new queue entries, not the queue itself.
_Avoid_: Alert feed

**Session activity**:
A bounded narration of transitions observed after the current browser session established its baseline. It is not durable orchestration history.
_Avoid_: Replay, audit log, event store

**Data age**:
Elapsed wall time since the browser successfully applied its last orchestration snapshot. It is shown separately from the stream connection state.
_Avoid_: Connection age, database age

**Wake hint**:
A fallible filesystem signal that asks the authoritative SQLite poll to run early. It never supplies orchestration facts itself.
_Avoid_: Change event, WAL event source

**Live enrichment**:
Optional, ephemeral Orca CLI context joined to an exact worker identity when possible. It may add worktree or current-activity context but never changes SQLite-derived orchestration truth.
_Avoid_: Secondary data source

**Kiosk**:
A non-interactive overview of unfinished orchestrations for continuous display. It summarizes supervision state and deliberately omits the task DAG and historical browsing.
_Avoid_: Dashboard mode, fullscreen mode

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

**Decision Gate**:
A recorded question whose lifecycle may affect whether an orchestration can continue. Its lifecycle state and its present blocking effect are separate facts.
_Avoid_: Open gate, unresolved gate

**Blocking Decision Gate**:
A decision gate for which current durable orchestration state proves that work is paused. A pending gate is blocking; an unanswered ask is blocking only while its named task is currently blocked.
_Avoid_: Open gate

**Unanswered Ask**:
A question sent through the ask flow with no recorded answer or gate lifecycle. It proves that no answer was retained, but not that the orchestration is still waiting.
_Avoid_: Open gate, timed-out ask

**Orchestrator Run**:
The tasks attributed to one orchestrator terminal, including all of its recorded waves of work.
_Avoid_: Session, inferred run

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

**Orca Process Liveness**:
Whether the visualizer can verify that the Orca process associated with the database is currently running.
_Avoid_: Run liveness, run health

**Attribution Window**:
The bounded period in which handle evidence may associate a task-id-less message with an orchestrator run.
_Avoid_: Run lifetime
