# Orca Orchestration History

This context describes the retained orchestration history that orca-viz presents, including what can and cannot be concluded when parts of that history disappear.

## Language

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
