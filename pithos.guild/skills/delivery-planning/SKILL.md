---
name: delivery-planning
description: >-
  Split accepted scope into safe delivery increments, sequence dependencies and
  learning, and prepare bounded implementation handoffs. Use from an existing
  spec, requirements, user stories, or an agreed outcome when planning releases,
  slicing work, or assigning an AI coding agent. No mandatory discovery pipeline
  or automatic implementation.
---

# Delivery planning

Plan the smallest useful outcome that can be checked and released safely.
Start from existing material; do not require a new interview, ADR, or specification.
User stories remain useful but optional. Match the format to the work, not a framework.
A small slice can be the entire plan and its own implementation handoff.

## Establish authority and boundaries

Confirm the requested planning scope, audience, source material, and output destination.
Read existing target documents before revising; preserve unrelated work.
Identify accepted requirements and decisions, their source/revision, and open questions.
Distinguish confirmed scope, proposals, assumptions, and observed repository behavior.
Code shows what exists, not what was authorized: if it conflicts with requirements,
record both sources and seek an authorized resolution. Do not silently redefine scope.
Block affected implementation readiness, not necessarily all useful planning.

This skill grants no tools or permissions. Planning does not authorize code changes,
issue creation, task-manager updates or synchronization, commits, or publication.
In active Plan mode, stay within its read-only and controlled checkpoint/publication
workflow. Ask the user to exit before ordinary documentation writes or delegation;
never bypass the guard. Exiting Plan mode does not authorize implementation.
Ask focused questions in the parent when needed; a restricted child reports missing
inputs to the parent rather than assuming access to questions, web, or shell.
Do not invent estimates, schedules, assigned owners, decisions, or approvals.

## Load only what the work needs

- Read [slicing and sequencing](references/slicing-and-sequencing.md) for choosing
  slice boundaries, learning work, dependencies, and release groups.
- Read [agent handoffs](references/agent-handoffs.md) when preparing an isolated
  implementation assignment or selecting a permitted Guild role.
- Use the optional [delivery slice template](templates/delivery-slice.md) for a
  near-term slice; remove irrelevant fields rather than filling them with guesses.
- Reuse [content-craft](../content-craft/SKILL.md) for audience, structure, and prose.
  Use relevant domain architecture guidance for technical constraints, not a new
  document hierarchy. Use [technical-discovery](../technical-discovery/SKILL.md)
  for unresolved requirements or design questions when needed, not as a prerequisite.
  No reference, heading set, or full artifact set is mandatory.

## Slice outcomes, not layers

Identify who benefits, what changes observably, and what evidence would establish it.
Prefer a thin end-to-end behavior over separate database, API, and UI “deliveries.”
Implementation tasks can sit beneath a slice; they are not substitutes for its outcome.
Split by workflow, operation, business rule, or data variant while preserving invariants.
Story mapping can expose a journey and release cut; job stories clarify situation and
motivation; Shape Up-style integrated scopes help find finishable boundaries. These
complement stories or plain outcome statements; none is a required framework.

Name spikes, enablers, and migrations honestly instead of forcing user-story wording.
Pull consequential uncertainty forward: define a spike's question, evidence, stop
condition, and decision it unlocks. A spike is learning, not a promised feature.
Never defer security or data integrity needed for safe release as “polish.”

## Sequence learning and safe delivery

Separate genuine prerequisites from convenient ordering or team preferences.
Give each dependency a reason and an observable completion condition; identify cycles
and missing decisions. Prioritize risk reduction and useful feedback, not only ease.
State which slices can ship independently and which must form a release group.
Mergeable is not releasable: check compatibility, migrations, rollout, recovery,
operational visibility, and required safeguards for the proposed release boundary.
A feature flag can limit exposure; it does not prove safety or remove prerequisites.

Detail only the next slices: outcome, non-goals, acceptance checks, dependencies,
release conditions, and unresolved blockers. Keep later work coarse and revisable.
Mark a slice ready only when consequential decisions, prerequisites, permissions,
and a feasible verification route are clear. Otherwise state the exact blocker and
what evidence or decision would clear it; do not disguise assumptions as readiness.

## Preserve traceability and prepare the handoff

Use existing IDs or stable links to connect requirements → decisions → slices → checks.
Link canonical material instead of copying it into competing specifications.
Keep source revisions, status, unknowns, and recorded approval provenance visible.
When evidence or accepted scope changes, revisit affected slices and checks; do not
mark a proposal accepted or implemented without supporting evidence.

For an agent assignment, supply one coherent outcome, explicit source/instruction
paths, allowed changes, non-goals, acceptance checks, verification expectations,
and stop conditions. A child must not need the parent conversation to proceed.
Guild delegation is optional. Children do not inherit this skill, its references,
the conversation, or ambient AGENTS.md; supply needed constraints and reading paths.
Use existing roles within their tool limits; do not create a new planner role or chain.

## Review and report

Check coverage against accepted scope, dependency order, release safety, and whether
another engineer or isolated agent could act without inventing product decisions.
Report the proposed next slice or release group, readiness blockers, and remaining
uncertainty in the requested format; do not manufacture extra documents.
Separate planned checks, supplied evidence, inspection, and observed execution.
Report checks actually performed and checks not run with reasons. A plausible plan,
a checklist, or a child report is not proof of verified implementation or release.
