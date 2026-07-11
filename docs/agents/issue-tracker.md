# Issue tracker

This project tracks work in **GitHub Issues** on `nvergez/orca-orchestrator-visualizer`.

## Fetching an issue

Use the `gh` CLI (authenticated in agent worktrees):

```bash
gh issue view <number>                              # title + body
gh issue view <number> --comments                   # + resolution comments
gh issue view <number> --json number,title,body,labels,state
```

Cross-references in commit messages and PR bodies use `#<number>`.

## The issue hierarchy

- **#12 — orca-viz MVP** is the parent. It carries the problem statement, the user stories, and the **locked contracts** — `StreamEvent`, `Task`, `FeedMessage`, the status colour table, the run-inference algorithm. Every implementation ticket refers back to it, so read it before implementing or reviewing any child ticket.
- **#13 – #22** are the implementation tickets. Each is a vertical slice with its own acceptance criteria and a `Blocked by` list.

## Reading order for an implementer or a reviewer

`HANDOFF.md` → `SPEC.md` → the parent issue **#12** → the ticket itself.

`HANDOFF.md` holds verified facts about Orca's database; do not re-derive them. `SPEC.md` is **locked** and is the spec of record. Where a ticket and `SPEC.md` disagree, that is a finding to report — not a licence to choose between them. The research docs under `docs/research/` are the evidence behind the rulings; consult them for `file:line` citations, not to reopen decisions.

## Labels

- `ready-for-agent` — specified well enough to be picked up and implemented.

## Branch and PR conventions for this build

- Each ticket is implemented on its own branch and opened as a **sub-PR against the integration branch `feat/orca-viz-mvp`** — never against `main`.
- A sub-PR body closes its ticket (`Closes #<n>`).
- `feat/orca-viz-mvp` is the single **main PR** into `main`; it accumulates the sub-PRs.
