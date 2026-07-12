# Issue tracker: GitHub

Issues and PRDs for this repository live in GitHub Issues on `nvergez/orca-viz`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue:** `gh issue create --title "..." --body "..."`
- **Read an issue:** `gh issue view <number> --comments`
- **Read structured fields:** `gh issue view <number> --json number,title,body,labels,state`
- **List issues:** `gh issue list --state open --json number,title,body,labels,comments`
- **Comment:** `gh issue comment <number> --body "..."`
- **Apply or remove labels:** `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close:** `gh issue close <number> --comment "..."`
- **Cross-reference:** use `#<number>` in commits, issue bodies, comments, and PRs.

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says “publish to the issue tracker”

Create a GitHub issue.

## When a skill says “fetch the relevant ticket”

Run `gh issue view <number> --comments`.

## Current issue hierarchy

- **#12 — orca-viz MVP** is the parent. It contains the problem statement, user stories, and locked contracts: `StreamEvent`, `Task`, `FeedMessage`, the status colour table, and the run-inference algorithm.
- **#13–#22** are implementation tickets. Each is a vertical slice with acceptance criteria and a `Blocked by` list.

Read the parent issue before implementing or reviewing a child ticket.

## Reading order for implementation and review

`HANDOFF.md` → `SPEC.md` → parent issue **#12** → the ticket itself.

`HANDOFF.md` contains verified facts about Orca’s database; do not re-derive them. `SPEC.md` is locked and is the specification of record. If a ticket conflicts with `SPEC.md`, report the conflict rather than choosing between them.

The research documents under `docs/research/` provide evidence behind the rulings. Consult them for citations, not to reopen settled decisions.

## Branch and PR conventions for the MVP build

- Implement each ticket on its own branch.
- Open each sub-PR against `feat/orca-viz-mvp`, never directly against `main`.
- A sub-PR body closes its ticket with `Closes #<number>`.
- `feat/orca-viz-mvp` is the single main PR into `main`.

## Wayfinding operations

The `wayfinder` skill represents a map as one issue with child issues as tickets.

- **Map:** label it `wayfinder:map`; store Notes, Decisions-so-far, and Fog in its body.
- **Child:** link it using GitHub sub-issues where available. Otherwise, add it to a task list in the map and place `Part of #<map>` at the top of the child.
- **Child labels:** use `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- **Blocking:** prefer GitHub’s native issue dependencies. Where unavailable, place `Blocked by: #<number>` at the top of the child body.
- **Claim:** `gh issue edit <number> --add-assignee @me`
- **Resolve:** comment with the answer, close the child, and add a context pointer to the map’s Decisions-so-far.
