---
name: code-comments
description: Write and improve accurate, useful code comments that preserve intent, contracts, constraints, and non-obvious behavior without redundant narration. Use when writing or changing code that needs explanation, reviewing comments, or performing focused comment cleanup. Apply within the requested scope and repository conventions.
---

# Code Comments

Write for a competent maintainer unfamiliar with the repository, not solely for an AI model's token budget. Optimize comments for the decisions they support, not their count. Apply this guidance to the assigned task; do not turn ordinary implementation into a repository-wide comment audit.

## Establish scope and evidence

Honor repository instructions, local documentation conventions, and the requested mode: writing code, authorized comment cleanup, or read-only review. This skill grants no tools or permission to edit. Keep review work read-only and limit implementation changes to the authorized scope.

Read nearby code and enough connected callers, tests, interfaces, and owning documentation to understand the contract before asserting rationale. Distinguish verified constraints from assumptions. Never invent historical reasons or describe an unverified property as guaranteed.

## Decide what earns a comment

For each proposed or existing comment, ask:

> What misunderstanding, unnecessary investigation, or plausible wrong edit does this comment prevent?

Keep or improve comments that contribute accurate information not readily apparent from nearby code:

- intent and reasons an apparently simpler approach is incorrect;
- security boundaries and deliberately unsupported behavior;
- contracts involving units, ownership, ordering, side effects, or other constraints not evident from types;
- non-obvious algorithms, mechanisms, external quirks, and compatibility requirements;
- consequences of plausible changes and historical reasons that still constrain them.

“Explain why, not what” is a default, not a prohibition. Useful API contracts and concise explanations of complex what/how behavior belong beside the code too. Do not add comments to meet a density target or remove them merely because a model can read the implementation.

Usually remove or shorten narration of obvious statements, documentation that merely expands a name, vague emphasis, ordinary language tutorials, and irrelevant patch-development history. Preserve history when it still explains a current constraint. If no concrete information gap exists, leave clear code uncommented.

## Keep knowledge concise and discoverable

Prefer concrete explanations over generic warnings. Compress duplicated rationale without discarding distinct constraints. Put extended arguments in an owning document when appropriate, retaining a short local summary and a usable link. Do not replace an essential security, ordering, or compatibility warning with a bare link: a reader of a small code excerpt still needs the critical constraint.

Before relocating detail, check that every unique constraint remains discoverable and update affected owning documentation together. Keep comments close to the behavior they explain and use the repository's supported documentation syntax.

## Resolve disagreements instead of concealing them

When comments and code disagree, investigate intended behavior using contracts, tests, callers, and documentation; assume neither is automatically correct. Never update a comment to match a bug and call that a repair. If intent remains uncertain, state the uncertainty and ask for clarification or report it rather than fabricating an explanation.

Verify comments when changing the behavior they describe. Prefer types, declarative constraints, analyzers, and executable checks to enforce invariants where feasible; retain the explanation of why those protections matter. This is not authorization for unrelated refactoring, dependencies, or behavior changes. In comment-only cleanup, surface a discovered behavioral defect separately rather than silently fixing it.

## Preserve semantics and verify

Preserve licences, attribution, tooling directives, suppression justifications, and useful API documentation. Respect generated-file boundaries and required documentation formats. Comments can affect compilation, analyzers, generated documentation, doctests, and other tooling; do not assume a prose-looking edit is behavior-neutral.

Review the final diff for lost constraints, unsupported claims, stale links, misplaced warnings, and unintended executable or tooling changes. Run the relevant repository checks when authorized and warranted by the affected content; respect read-only restrictions and do not invent verification results. Summarize meaningful changes and unresolved intent concisely, distinguishing checks performed from recommendations. Lower comment count or token cost alone is not evidence of safer or better outcomes.
