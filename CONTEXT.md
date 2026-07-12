# Orca Orchestration Visualizer

This context describes the orchestration facts that orca-viz can faithfully present from Orca's retained state.

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
