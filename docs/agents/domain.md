# Domain docs

This repository uses a single-context domain-documentation layout.

## Before exploring

Read these resources when they exist:

- `CONTEXT.md` at the repository root
- Relevant ADRs under `docs/adr/`

If either resource is absent, proceed silently. The domain-modeling workflows create these documents lazily when terminology or architectural decisions are resolved.

## Layout

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── src/
```

## Use the glossary vocabulary

When naming a domain concept in issues, proposals, hypotheses, tests, or code, use the term defined in `CONTEXT.md`. Avoid synonyms that the glossary explicitly rejects.

If a required concept is absent, reconsider whether the term belongs to the project or note the gap for the `domain-modeling` skill.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, identify the conflict explicitly instead of silently overriding the decision.
