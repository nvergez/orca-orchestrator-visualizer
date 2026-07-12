# Orca Orchestration Visualizer

The visualizer describes retained evidence about Orca orchestrations without claiming more than the database can prove.

## Language

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
