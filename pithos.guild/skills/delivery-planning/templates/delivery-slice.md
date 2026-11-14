# <Slice ID or outcome>

Optional scaffold, not a required heading set. Remove this note and fields that do
not help the reader. A small outcome plus acceptance checks and boundaries may be
enough; add handoff detail only when needed. Link canonical facts instead of copying.
Do not fill unknowns with invented estimates, ownership, or approval.

## Outcome and authority

- Beneficiary and observable result:
- Type, if useful: delivery slice / spike / enabler / migration.
- Requirements and decisions: <links/IDs, source revision, accepted vs proposed>.
- Status and provenance: <draft/ready/blocked; recorded decision evidence, if any>.
- Deferred accepted scope: <links; not silently removed from the plan>.

## Boundaries

- Included behavior:
- Non-goals and excluded changes:
- Relevant compatibility, security, data integrity, and operational constraints:

## Acceptance and evidence

- Given <relevant context>, when <action>, then <observable result>.
- Failure or edge cases that affect the contract:
- Checks linked to requirements: <planned method, expected observation>.
- Evidence already available: <inspection/supplied/executed; source and limitations>.
- For a spike: <question, permitted investigation, stop condition, decision unlocked>.

## Dependencies and release

- Prerequisites: <reason, completion condition, evidence link>.
- Release boundary: <independently releasable or grouped with … because …>.
- Rollout, compatibility, migration, and recovery conditions, as relevant:
- Readiness blockers: <missing decision/evidence/permission; what clears each>.
- Unknowns and next reconsideration trigger:

## Optional implementation handoff

Use the slice itself as the handoff when sufficient; no separate file is required.

- Authorized outcome and allowed changes: <exact paths/scope; preserve unrelated work>.
- Read first: <repository root, explicit local source/instruction/reference paths>.
- Baseline and known working-tree changes:
- Existing role/profile, permitted actions, and capability limits, if delegating:
- Verification: <checks/commands if known, environment, expected observations,
  explicitly required practices; do not label planned checks as executed>.
- Stop and report if: <conflict, missing essential input, unsafe or out-of-scope work>.
- Return: <artifacts, actual checks and evidence, blockers, risks, unperformed checks>.
