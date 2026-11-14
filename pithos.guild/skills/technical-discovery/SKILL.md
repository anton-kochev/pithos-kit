---
name: technical-discovery
description: >-
  Turn software ideas and evidence into proportionate technical documentation.
  Use to clarify a problem, investigate a repository or external constraints,
  elicit requirements, compare designs, or create, revise, and review SDLC
  artifacts such as problem briefs, specifications, SRSs, RFCs, and ADRs.
  Supports both early ideas without a repository and focused work on existing
  documents. Keep facts, assumptions, proposals, and accepted decisions distinct;
  do not force a full lifecycle or begin implementation.
---

# Technical discovery

Establish what should be built, why, and under which constraints. Produce only
what helps the intended readers make or carry out a decision. Documentation is
not evidence by itself, and a detailed spec does not guarantee correct software.

## Enter at the requested point

Identify the requested outcome: explore an idea, research a question, define
requirements, compare options, record a decision, draft an artifact, or review
existing material. Respect the audience, requested format, scope, and stopping
point. A standalone ADR does not require a discovery interview or an SRS.

Read supplied material before asking questions. For existing software, inspect
relevant repository instructions, documents, manifests, source, tests, and release
constraints; trace only the behavior needed for this task. For an early idea,
work from available evidence without requiring a repository or inventing a stack.
Locate the existing source of requirements and document conventions. Observed
code establishes current behavior, not necessarily intended behavior. Flag
conflicts between code, documents, and user decisions instead of silently choosing
one or rewriting the requirement to match the implementation.

## Work from evidence to a useful artifact

1. **Frame the problem.** Establish affected people or systems, their goal, the
   present difficulty, success signals, constraints, and non-goals. Separate a
   requested solution from the need behind it. Reuse answers already supplied.
2. **Resolve consequential unknowns.** Inspect local evidence and research through
   permitted tools when external or current facts matter. Ask small, focused
   batches of questions that change scope, safety, feasibility, or acceptance.
   Explain the trade-off when offering choices. Avoid an exhaustive questionnaire.
3. **Choose the smallest useful output.** Follow the requested artifact and local
   conventions. A brief may be enough; a larger change may need requirements,
   design, and decisions. Propose additional documents only for a clear reader or
   risk. Agree on a safe destination before writing when it is not established.
4. **Draft with traceable status.** Distinguish sourced observations, user-confirmed
   requirements, assumptions, proposals, accepted decisions, and open questions.
   Attach source paths or URLs to material claims. Record who accepted a decision
   and the evidence of acceptance only when supplied; generated text is not approval.
5. **Check and stop.** Challenge the draft against the original need, evidence,
   constraints, and failure cases. Report unresolved blockers and checks actually
   performed. A useful outcome may be proceed, clarify, or stop; none authorizes
   implementation. Revisit earlier sections when new evidence changes the result.

Unknowns need not prevent a clearly labelled draft. Do not present affected scope
as implementation-ready while a material requirement or safety decision is
unresolved. Label provisional assumptions and their impact rather than filling
gaps with invented metrics, budgets, deadlines, compliance claims, or sign-off.

## Load only the material needed

- [Discovery and evidence](references/discovery-and-evidence.md): interviews,
  repository investigation, external research, conflicting sources, and stopping.
- [Requirements](references/requirements.md): behavior, quality constraints,
  acceptance criteria, SRS scope, and traceability.
- [Design and decisions](references/design-and-decisions.md): options, RFCs,
  ADRs, contracts, rollout, and operational documents.
- [Artifact review](references/artifact-review.md): completeness, consistency,
  independent scrutiny, change impact, and maintenance.

Optional starting points, not required headings or a required document set:
[brief](templates/brief.md), [specification](templates/specification.md), and
[ADR](templates/adr.md). Adapt or omit irrelevant sections; do not leave example
facts or placeholders disguised as approved content. Reuse the repository's
format when it already works. Use [content-craft](../content-craft/SKILL.md) for
writing quality and available domain skills for substantive technical decisions.
Use [delivery-planning](../delivery-planning/SKILL.md) when asked to split scope
into shippable increments and implementation handoffs; do not start it automatically.

## Permissions, delegation, and completion

This skill supplies guidance, not tools or enforceable permissions. Respect the
active role, repository instructions, and host controls. In active Plan mode,
use its permitted checkpoint mechanism; do not bypass write or delegation blocks.
Ask the user to exit Plan mode before ordinary artifact writes or delegation.
Exiting Plan mode is not authorization to implement.

Keep user questions and web research in the parent. Delegate only when useful:
explorer for repository evidence, architect for design analysis, writer/general
for prose from supplied local evidence at explicit output paths, and reviewer
for eligible repository-connected code/change reviews. Keep standalone document
scrutiny without connected source code in the parent; Guild's reviewer has a fixed
code-review eligibility gate. Explorer, architect, and reviewer stay read-only;
writer has no shell or web. Guild children do not inherit this conversation,
ambient skills, or repository instructions. Supply self-contained assignments,
original requirements, constraints, source excerpts or local paths, relevant
instruction/reference paths, and acceptance criteria; URLs alone are not read
sources for a writer. Check returned artifacts and claims yourself.

Preserve unrelated work and accepted decision history. Do not change source code,
install dependencies, create issues or task-manager entries, commit, or publish
merely because you documented a plan. Keep secrets and private material out of
public searches and shared documents. Return artifact paths or the requested
in-chat draft, key decisions, blockers, and verification limits—not a claim that
implementation, stakeholder approval, or release readiness has been established.
