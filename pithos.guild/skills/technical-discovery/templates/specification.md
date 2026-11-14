# <Feature or system> specification

Optional scaffold for a feature spec or SRS, not a standards-compliance claim.
Use the requested/local format; remove unused sections and these instructions.
Do not fill gaps with invented facts. Mark placeholders as unresolved if they
remain material to the draft.

## Purpose, scope, and status

Problem, beneficiaries, goals, non-goals, current/proposed behavior, source brief,
and confirmed constraints. State draft/review/accepted status with real provenance.

## Behavior and acceptance

Repeat only for meaningful requirements; use stable IDs where links need them.

### <Requirement ID and outcome>

- Source/rationale and confirmed/proposed status:
- Actor, trigger, preconditions, inputs, and expected behavior:
- Business rules, outputs/state changes, and relevant failure behavior:
- Observable acceptance criteria and verification method:
- Unresolved choices and impact:

## Quality and compatibility constraints

Relevant security, privacy, reliability, performance, accessibility, platform,
compatibility, or operational requirements. Include workload/measurement
conditions for numeric targets and distinguish confirmed from proposed values.

## Interfaces and decisions

Link authoritative contracts and ADRs. Separate fixed constraints from design
recommendations; avoid copying contracts maintained elsewhere.

## Delivery and verification links

Link slices and planned checks when they exist. Identify unallocated requirements
and cross-cutting safeguards. Proposed tests are not executed evidence.

## Open questions and maintenance

Blockers, safe assumptions, decision/evidence needed, affected downstream artifacts,
and review triggers or ownership only when known. State what is ready and what is not.
