# Design proposals and decision records

## Choose an artifact by its job

| Need | Useful artifact |
| --- | --- |
| Explore a change with unresolved trade-offs | Design proposal or RFC |
| Record a consequential decision and why it was made | Architecture decision record (ADR) |
| Specify an integration boundary | API, event, schema, or interface contract |
| Explain how the current system fits together | Architecture overview with source references |
| Describe safe operation or change | Runbook, migration, rollout, or recovery plan |

These are options, not a required set. A small change may need a paragraph in the
spec. Reuse existing formats and paths; don't invent a parallel knowledge base.
Use domain architecture guidance when available, but don't impose a technology
stack or architecture style merely because a skill recommends one conditionally.

## Compare options against the actual need

Start with requirements, existing boundaries, and constraints. Consider the
status quo and the smallest viable change. Compare only credible alternatives
using the criteria that matter: behavior, compatibility, security, consistency,
operational load, cost, reversibility, and demonstrated complexity.

Explain why an option meets or misses a criterion. Avoid numeric scores that imply
measurement when only a judgment exists. Separate evidence from inference and
unverified assumptions. Identify experiments or decisions that would change the
recommendation. Don't perform a spike or install a dependency without permission.

Record enough design to make interfaces and risks clear: responsibilities, data
flow, state ownership, failure semantics, invariants, and test strategy. Use a
small diagram when it removes ambiguity; label current and proposed structures.
Illustrative code is not tested implementation and should not become a second,
stale source of truth for contracts already defined in the repository.

## Keep ADR status honest

For a new ADR capture context, decision drivers, viable options, the selected or
proposed option, rationale, consequences, and follow-up conditions. The default
for a recommendation without acceptance evidence is proposed, not accepted.

For an already-agreed decision, record the supplied decision and acceptance
provenance. Don't force a new selection exercise or invent rejected alternatives,
meeting dates, decision makers, or unanimous agreement. If rationale is missing,
state that gap or ask a targeted question; plausible reasoning is not history.

Follow existing numbering and status conventions. For revisions, distinguish an
editorial correction from a new decision. Preserve accepted decision history;
record supersession and links to the replacement when an authorized new decision
changes it. Don't silently rewrite an accepted ADR to look as if the new choice
was always the original one. A written ADR does not itself authorize code changes.

## Cover implementation and operation boundaries

Include only the relevant contracts and risks, but do not hide consequential ones:
- API and data contracts, validation, authorization, tenancy, and compatibility.
- Transaction/consistency boundaries, retries, deduplication, concurrency, and
  failure recovery when multiple systems or asynchronous work are involved.
- Migration/backfill, mixed-version rollout, observability, safe rollback or
  forward recovery, and irreversible operations.
- Verification strategy and required environments; label checks not yet executed.

A runbook should state prerequisites, permissions, triggers, safe actions,
observable checks, escalation, and recovery limits. Commands must be grounded in
the actual environment and marked unverified when not run. Do not invent on-call
owners, approval policies, credentials, or a rollback that cannot restore data.

## Maintain useful knowledge

Give durable decisions and contracts discoverable homes. Link from existing
indexes rather than stuffing detail into AGENTS.md. Keep a requirement's current
meaning in one place and link to it. Mark obsolete proposals and superseded
records, and identify what change would require revisiting a decision.

[OpenAI's repository-knowledge write-up](https://openai.com/index/harness-engineering/)
is an example of short entry points and maintained, linked documents. It is an
experience report, not a mandate to adopt its architecture or autonomous workflow.
