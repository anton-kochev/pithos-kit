# Requirements and specifications

## Choose the necessary depth

A short behavior spec can be enough for a feature. Use a software requirements
specification (SRS) when a broader system contract, formal review, or multiple
stakeholders need it. Follow an existing organizational template or requested
standard. Do not claim standards compliance because a document has familiar
headings; establish the required edition and criteria from available evidence.

Separate required outcomes from implementation choices. Retain genuine technical
constraints such as an existing API contract, deployment environment, or mandated
protocol, with provenance. Do not turn a preferred library into a requirement.

## Describe observable behavior

For each meaningful behavior establish the actor or caller, trigger, preconditions,
inputs, business rules, outputs, state changes, and relevant failure conditions.
Identify authorization and ownership boundaries, invalid input, concurrency,
retries, partial failure, and recovery where they affect the feature. Include
non-goals so a coding agent cannot reasonably interpret omissions as extra scope.

Use stable IDs when they help trace multiple requirements; don't create an ID
scheme for a two-sentence change. Link each requirement to its rationale/source,
status, and acceptance evidence without copying the same text into every artifact.
Acceptance criteria define observable success, not an implementation task list.

Plain language, Given/When/Then, and EARS-style "When ..., the system shall ..."
are optional notations. No notation makes vague or contradictory content precise
by itself. Avoid "fast," "secure," "user-friendly," and "handles all errors"
without the relevant observable conditions.

Illustrative structure, not an approved requirement:

> Given an authenticated requester with access to an invoice, when they export
> that invoice, the system returns a PDF containing the agreed invoice fields.
> A requester without access receives no invoice content through the response or
> download link. The exact response contract is an open question until confirmed.

Do not invent a status code, retention period, field list, or performance threshold
merely to make this example look finished. Mark missing choices and their impact.
A requirement can be drafted without being ready for implementation.

## Make quality constraints verifiable

Select relevant concerns rather than filling every category by habit:
- Security/privacy: actors, tenant boundaries, abuse cases, sensitive data,
  retention/deletion, audit and disclosure limits.
- Reliability: acceptable failure behavior, recovery, durability, idempotency,
  and availability expectations.
- Performance/capacity: workload, measurement conditions, percentile or bound,
  volume, and resource budget—not an isolated unexplained target.
- Compatibility: API/schema/client versions, migrations, coexistence, accessibility,
  supported platforms, and behavior that must not regress.
- Operations: observability, support, deployment restrictions, rollback, and ownership.

Identify whether each constraint is confirmed, externally evidenced, or proposed.
If the user has not set a consequential threshold, ask or mark it unresolved.
Keep mandatory release safeguards within the smallest release; do not treat
security or data integrity as later polish.

## Preserve authority and traceability

When existing docs disagree, record both sources and seek a decision. Do not
silently choose the newest file, infer sign-off from a checkbox, or treat passing
tests as proof of intended behavior. Retain the original need while incorporating
confirmed refinements. Distinguish a changed requirement from a clarification.

Connect requirements to design decisions, delivery slices, and planned checks
where useful. Flag requirements with no coverage, tasks with no justified need,
and acceptance criteria that verify only the happy path. Proposed checks are not
executed tests. Cross-cutting constraints apply to every affected slice even when
their authoritative definition lives in one shared document.

Before handing off, state what is ready, what remains provisional, and which
unresolved decisions block which scope. Don't require complete certainty about
unrelated future features to prepare a bounded next increment.

## Background

[Kiro's requirements-first guidance](https://kiro.dev/docs/specs/feature-specs/requirements-first/)
illustrates separating behavior, design, and tasks with review between them. Use
that separation selectively; it does not require a fixed lifecycle or notation.
