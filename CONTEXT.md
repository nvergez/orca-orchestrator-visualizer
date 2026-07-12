# Orchestration History

This context describes how orca-viz turns Orca's retained orchestration evidence into live supervision and post-mortem reports without claiming facts the database does not contain.

## Language

**Orchestrator run**:
The tasks and evidence attributed to one orchestrator terminal handle, including its visible waves of work.
_Avoid_: Session, inferred run

**Retained evidence**:
Rows that exist in Orca's orchestration database at the moment orca-viz reads them; it excludes events the database overwrote, deleted, or never recorded.
_Avoid_: Complete history, event log

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

**Run index**:
A cursor-paginated list of lightweight orchestrator-run summaries used to navigate retained history without loading every run's evidence at once.
_Avoid_: History window, complete snapshot

**Selected-run snapshot**:
The complete retained evidence for one selected orchestrator run, fetched as a unit without time-windowing or truncation.
_Avoid_: Run page, history slice

**Evidence hint**:
An explicitly uncertain agent-kind or repository label derived from unambiguous retained evidence and accompanied by its provenance.
_Avoid_: Identity, classification
