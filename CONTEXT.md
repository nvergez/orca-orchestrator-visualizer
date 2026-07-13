# Orca Orchestration Visualizer

The visualizer describes retained evidence about Orca orchestrations without claiming more than the database can prove.

## Language

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

**Attention Item**:
One thing that currently needs a supervisor's intervention, with a stable identity, a kind, an explanation and the orchestrator and task it names. It is derived from retained evidence; it is never acknowledged, dismissed or otherwise written back to Orca.
_Avoid_: Alert, notification, warning

**Attention Cause**:
The evidence that puts an attention item in the queue: a blocking decision gate, a stale worker, a retry risk, an unresolved escalation, or a fresh failure. Distinct causes for one task coexist rather than merging.
_Avoid_: Issue, problem, error

**Retry Risk**:
A task's current dispatch attempt that has already failed at least twice, so the next failure trips Orca's circuit breaker. It reports proximity to the breaker, not a prediction that the task will fail.
_Avoid_: Failing task, flaky task

**Attention Freshness Window**:
How long a failure remains recent enough to demand intervention rather than being read as history. It is the same canonical recency threshold that turns a worker stale and a run silent.
_Avoid_: Timeout, expiry

**Stale Worker**:
A worker whose current dispatch attempt has produced no activity evidence for at least the recency threshold, whether or not it ever sent a heartbeat. It reports missing evidence, never that the terminal is dead, stuck or hung.
_Avoid_: Dead worker, hung worker, quiet worker

**Attention Tab State**:
What the browser tab reports about the attention queue to a reader who is looking at something else: the count of attention items in the document title, and a badged favicon while that count is above zero. It is derived from the queue alone, needs no permission, and returns to normal when the queue clears.
_Avoid_: Unread count, badge count

**Attention Notification**:
A desktop notification announcing one attention item, sent at most once for that item's stable identity, and only when the item enters the queue after the notification baseline. It carries no urgency the queue does not already have.
_Avoid_: Alert, toast, push, warning

**Notification Baseline**:
The attention queue as it stands on the first snapshot of a stream connection — on initial load and again on every reconnect. Its items count as already seen, so retained evidence never announces itself.
_Avoid_: Read state, acknowledged state, dismissed state

**Notification Opt-In**:
The reader's locally stored wish to receive attention notifications, off until they say otherwise. It is a separate fact from the browser's notification permission, which only an explicit user gesture may request and which may be denied, revoked or absent — in which case the attention tab state is the whole of the delivery.
_Avoid_: Notification setting, subscription
