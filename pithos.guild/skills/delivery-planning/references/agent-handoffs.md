# Agent handoffs

Use this reference only when an engineer or isolated agent needs an actionable
assignment. A complete small slice can itself be the handoff; do not duplicate it.
Delegation is optional and does not imply an automatic discovery → coding → review chain.

## Make the assignment self-contained

The recipient should know what to achieve, where to look, what may change, and when
to stop without the parent's conversation. Supply the relevant subset below:

- **Outcome and authority:** original need, accepted scope and decisions with source
  provenance, and clearly separate proposals or implementer assumptions.
- **Evidence to read:** explicit local paths to specifications, decision records,
  relevant code/tests, repository instructions including applicable AGENTS.md, and
  required skill/reference material. Say which portions matter. Resolve relative
  paths against a stated repository root; use accessible paths, not ambient context.
- **State and boundaries:** relevant baseline/revision or working-tree state, allowed
  changes and output destinations, exclusions, and unrelated edits to preserve.
- **Behavior:** observable acceptance criteria, representative success and failure
  cases, compatibility requirements, and security/data invariants.
- **Dependencies:** prerequisites and their completion evidence, unresolved contracts,
  release-group membership, and any overlap needing coordination.
- **Verification:** checks to run when permitted, expected observations, required
  practices, available fixtures/environment, and known capability limits.
- **Stop conditions:** missing essential input, contradictory requirements, unsafe
  changes, unavailable prerequisites, or a need to cross the authorized boundary.
- **Return:** changed artifacts, requirement/check links, actual evidence, remaining
  risks, blockers, and unperformed checks with reasons.

Supply source contents or readable local evidence for research-dependent claims.
A URL alone is not research evidence for a child without web access. Distinguish
parent-supplied summaries from sources inspected directly and from execution logs.
Do not pass secrets or unnecessary sensitive material in the brief.

If code and accepted requirements disagree, identify the conflict and its impact.
Do not ask the implementer to treat whichever source is easiest as the new contract.
Pause affected implementation and return the decision needed to the parent.
A child must not invent product decisions, approvals, ownership, or delivery estimates.

## Respect permission and isolation boundaries

This skill is parent-discoverable, not automatically inherited by Guild children.
Children do not inherit the parent conversation, ambient skills, or AGENTS.md.
Give explicit reading paths and the essential constraints in the task; do not assume
that selecting a profile loads this skill or its references. Fixed role guidance is
not permission to add tools or expand scope.

Use existing supported roles, only when delegation is authorized:
- **Explorer:** gather repository evidence and unknowns; read-only, no shell/tests.
- **Architect:** compare options, define contracts and test strategy; read-only.
- **Reviewer:** inspect an eligible repository-connected code/change review against
  original needs; no edits or shell. Its fixed code-review gate excludes standalone
  documents without connected source; keep that scrutiny in the parent.
- **Writer/general:** write assigned prose from supplied evidence at explicit paths;
  no shell, web research, or user-question tools.
- **Coder:** implement and verify an authorized coherent scope with available tools;
  shell access does not authorize arbitrary network, deployment, or destructive work.

Choose a supported profile for domain guidance, not additional permissions. Do not
invent a planner role, modify role injection, or assume a child can delegate again.
Resolve questions and external research in the parent before dispatch when needed;
if essentials are missing and no permitted clarification tool exists, report blocked.
Child reports are claims for the parent to inspect, not host-certified verification.

In active Plan mode, do not delegate or perform ordinary writes/shell operations.
Use only its controlled planning workflow; ask the user to exit before delegation or
ordinary documentation writes. An exit or an accepted plan does not by itself grant
implementation, issue/task synchronization, commit, deployment, or publication rights.
Instructional path boundaries are not filesystem locks or a sandbox: coordinate
shared-file edits and preserve unrelated work rather than assuming process isolation.

## Separate readiness, implementation, and verification

Before dispatch, check that the recipient can read essential evidence, the requested
changes fit its tools and permissions, and acceptance checks address the actual need.
Mark consequential gaps as blockers with the decision or evidence needed to clear them.
A proposed command is not a check result. Do not promise checks unavailable to the role.
Require explicit practice compliance only through the supported contract; a planning
checklist cannot prove TDD or substitute for recorded test execution.

For actual execution, request the command, working directory, relevant configuration,
observed result, and evidence location. Report inspection separately from supplied logs
and executed checks. If a check could not run, state why and who needs to resolve it
only when ownership is known. Do not convert “not run” into “passed” or “not needed.”
Use focused verification first and broader checks as risk and permission warrant;
never describe a clean narrow check as proof that the release group is safe.

Keep technical completion, release readiness, and recorded approval distinct. Request
independent review when appropriate, not an invented mandatory role sequence or sign-off.
After new evidence, revisit affected requirements, decisions, slices, and checks with
their authority intact. Report proposed changes rather than silently expanding scope.

## Optional reading

[Spec Kit: agentic specification-driven development](https://github.github.com/spec-kit/reference/agentic-sdd.html)
is background for traceability and cross-artifact consistency, not a required command
sequence, tool installation, or authorization to implement.
