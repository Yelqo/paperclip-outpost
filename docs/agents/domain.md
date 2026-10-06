# Domain Docs

How engineering skills should consume this repository's domain documentation.

## Before exploring, read these

This repository uses a single-context layout:

- Read `CONTEXT.md` at the repository root.
- Read ADRs in `docs/adr/` relevant to the area being explored.

If these files are missing, proceed silently. Do not flag their absence
or suggest creating them upfront. The domain-modeling skill creates them
when terms or decisions are resolved.

## File structure

- `CONTEXT.md`: domain glossary.
- `docs/adr/`: architecture decision records.

## Use the glossary's vocabulary

When naming domain concepts in issue titles, proposals, hypotheses,
code, or tests, use the terms defined in `CONTEXT.md`.
Avoid synonyms the glossary explicitly discourages.

If a needed concept is absent, reconsider whether it belongs in the
domain or note the gap for domain-modeling.

## Flag ADR conflicts

If a proposal contradicts an existing ADR, identify that conflict
explicitly and explain why the decision should be reconsidered.
