---
name: code-review-standards
description: Reviews repository code changes with evidence-based severity, deterministic merge decisions, and a findings-first report. Use for code review requests involving a working tree, staged changes, commits, ranges, or focused repository paths.
---

# Code Review Standards

Apply this language-neutral methodology to repository-connected code review. Detect the repository's actual languages and capabilities before adding language-specific guidance. Keep the review focused, read-only, evidence-based, and compatible with the Guild code-reviewer report.

## Hard boundary: read-only review

Review only: never create, edit, or delete files; stage or commit changes; install packages; run generators or formatters; or claim to have fixed a finding. In a parent session, use shell access only for non-mutating inspection if authorized. Isolated Guild reviewers have no shell, interactive question, or delegation tools; use their read-only tools instead. Do not run builds, tests, linters, type-checkers, package managers, compilers, interpreters, or project scripts because they may mutate caches or artifacts. Recommend focused verification to the implementer instead.

Never claim a test, build, lint, type-check, or analysis command was run or passed unless its result was supplied in the review context or is visible as existing repository evidence. Clearly distinguish supplied results from commands merely recommended.

## Eligibility gate

Proceed only when both conditions hold:

1. The task is a code review request with an identifiable change set, comparison, commit, range, or focused repository path.
2. The repository contains substantive source code connected to that scope.

Refuse generic advice, pasted examples unrelated to the repository, generated-only changes, dependency inventories, and repositories without connected substantive code. In parent skill use, return `Blocked` with the missing evidence or requested scope, then stop before producing a substantive review report. Isolated Guild children must instead submit guild_submit_result even when blocked or ineligible, using existing scope, blockers, limitations, findings, and verdict fields; retain independently supported findings from inspectable eligible scope. `Blocked` is a pre-review workflow status, not a merge decision.

## Review process

### 1. Establish the exact scope

Honor an explicit commit, revision, range, base comparison, pull-request scope, or path list first. Inspect an explicit commit with read-only commands such as `git show <commit>` and an explicit range with `git diff <range>`; do not silently substitute current working-tree changes.

Without an explicit scope:

1. Run `git status --short` to identify staged, unstaged, and untracked paths.
2. Inspect unstaged changes with `git diff`.
3. Inspect staged changes with `git diff --cached`.
4. Read relevant untracked source files reported by status because Git diffs omit their contents.

State exactly which commits, range, staged changes, unstaged changes, untracked files, or paths were reviewed and what was excluded. If unrelated change groups make the intended scope ambiguous, report the precise missing comparison or path scope as a blocker rather than combining the groups. Parent skill use may ask a focused question; isolated children report the gap to the parent through the structured result.

Treat the diff as an entry point. Read complete changed files and enough affected or connected context—callers, tests, interfaces, schemas, manifests, migrations, and generated inputs—to understand observable behavior and contracts. Stay centered on changed code and affected context; do not expand into a repository-wide audit.

### 2. Detect repository-supported capabilities

Determine languages from scoped files, then confirm capabilities from repository evidence: manifests, lockfiles, language and compiler configuration, build files, source layout, package exports, and related tests. Detect supported language versions, frameworks, runtimes, module systems, databases, deployment targets, test stacks, lint policy, and generated-code boundaries where relevant.

Apply language-specific or framework-specific guidance only when that capability is detected and supported. Do not assume a modern syntax, API, framework pattern, naming convention, or runtime merely because it is familiar. Match harmless local conventions, but do not let precedent excuse a concrete correctness or security defect.

### 3. Establish intent, provenance, and context sufficiency

Start from original user needs and the original requirement, preferably verbatim, plus repository contracts. Separate explicit user constraints and decisions (with provenance) from implementer assumptions. A plan is optional, not mandatory; an existing-code review needs a clear review objective, not an invented feature request or planning artifact. Read explicit local file references and disclose inaccessible material. Use tests, public interfaces, documentation, nearby healthy code, and commit context as evidence, not substitutes for material requirements.

Assess sufficiency before judging satisfaction: missing essentials that prevent completion require taskOutcome blocked and precise blockers. Retain independently supported findings even when other dimensions cannot be assessed. Partial context allows explicitly limited review; never silently narrow the assigned scope to claim completion. Record assessed and unassessed dimensions in scope and limitations. Missing context alone is not a severity finding, and material unassessed scope cannot receive Approve.

Independently challenge both plan and implementation. Faithfully implementing a flawed plan can still warrant a finding. Seek omitted requirements, counterexamples, failure paths, compatibility, security, lifecycle risks, and unjustified complexity. Treat rationale, checklists, author reports, and tests as fallible. Evaluate tests against intended behavior independently of implementation assumptions. Distinguish planning/design gaps from implementation bugs in the existing finding text and references; no extra report fields are needed. Respect explicit user decisions; reopen them only with consequential evidence. Do not manufacture opposition, speculative severity, style objections, or preference-driven redesign. Trace changed control flow and data through success, failure, boundary, cancellation, retry, and cleanup paths that are relevant to the change.

Check contracts that callers or deployments rely on: public APIs, command behavior, wire formats, persisted data, schemas, authorization, configuration, ordering, error semantics, accessibility, and supported platforms. If missing intent materially determines correctness, parent skill use may ask one focused question instead of inventing a finding. An isolated child cannot ask the user: report the missing information through blockers/limitations and submit its structured result.

### 4. Review by concrete risk

Prioritize correctness, security, data integrity, and compatibility before concurrency, resources, tests, performance, and maintainability. Concentrate on changed trust boundaries, authority checks, persistence, process boundaries, resource ownership, and concurrency.

Look for high-confidence defects supported by evidence, including:

- invalid state transitions, boundary errors, partial writes, duplicate side effects, swallowed failures, and misleading success;
- injection, traversal, secret exposure, missing authentication or object-level authorization, unsafe deserialization, and attacker-controlled resource growth;
- races, deadlocks, unobserved async failures, lost cancellation, unbounded queues, and cleanup failures;
- incompatible API, schema, migration, serialization, configuration, package, runtime, or generated-artifact changes;
- framework lifecycle, rendering, server/client, accessibility, and error-state regressions when the detected framework makes them relevant;
- regression-test gaps only when a concrete changed behavior could escape, and performance issues only with evidence about complexity, I/O, allocation, contention, or likely scale;
- maintainability weaknesses only when they obscure behavior or create a concrete defect risk, not merely because code differs from a preferred style.

Resolve uncertainty by inspecting connected code. If uncertainty remains material, report it as a concise residual risk or question, not as a severity finding. Exclude pre-existing or unrelated defects unless the reviewed change makes them reachable, materially worsens them, or depends on them.

## Impact-calibrated severity

Assign the narrowest defensible severity from the triggering scenario and concrete impact:

- **Critical** — a directly exploitable security failure, irreversible broad data loss, or catastrophic production impact with a credible trigger.
- **High** — a likely correctness, authorization, availability, data-integrity, or public-compatibility failure that materially affects users or operations.
- **Medium** — a concrete defect with a narrower trigger or impact, including meaningful regression risk that is not stylistic.
- **Low** — a real, actionable maintainability, observability, test, or efficiency weakness with limited immediate impact.

A resource leak, race, or logic error is not automatically Critical; classify it by exploitability, reachability, frequency, scope, recoverability, and demonstrated impact. Likewise, do not classify complexity thresholds, naming preferences, missing comments, optional modernization, or speculative optimization as findings without repository policy or a concrete consequence.

## Finding discipline

Every finding must:

- identify one actionable root cause without duplicating it across files;
- cite an exact repository-relative path and line or compact line range overlapping the relevant change when possible;
- explain the evidence and triggering scenario;
- state the user, security, operational, compatibility, or maintenance impact;
- recommend the smallest sound remediation without implementing it;
- name focused validation only when it adds useful confidence.

Lead with findings ordered by severity and then file path. Report only high-confidence issues; do not pad the report with praise, style preferences, hypothetical concerns, or unrelated cleanup. If no issue meets the threshold, say `No findings.` This means no actionable finding was identified within the inspected scope, not that the code is perfect.

## Deterministic decision

Keep taskOutcome separate from verdict: Request changes does not itself mean blocked. Missing essentials preventing completion do. Even blocked children choose exactly one verdict from supported findings and material limitations:

- **Request changes** — one or more Critical, High, or Medium findings. This includes exactly one Medium finding.
- **Comment** — Low findings only, or no actionable finding but a material unresolved question or verification limitation.
- **Approve** — no actionable findings and no material unresolved question within the fully inspected scope.

The decision summarizes the findings and must not conflict with them. Never approve scope that could not be inspected. Do not assign a numeric quality score: inspected scope and issue counts do not prove perfect code, and a separate score can conflict with the merge decision.

## Required output

In an isolated Guild child, the exact completion protocol takes precedence: submit guild_submit_result once, alone, including blocked results. Map review scope to payload.scope, findings to payload.findings, decision to payload.verdict, and gaps to blockers/limitations; use summary for capabilities. Do not stop with prose alone. In parent skill use, use this findings-first presentation:

### Findings

For each finding:

`#### [Severity] Short problem statement — path/to/file.ext:line`

Write one compact paragraph covering evidence, trigger, impact, and the smallest remediation. Add a focused validation sentence only when useful.

If there are no findings, write `No findings.`

### Summary

- **Language(s):** detected languages and relevant supported frameworks or runtimes
- **Review Scope:** exact commits, range, staged or unstaged state, untracked paths, explicit paths, and exclusions
- **Decision:** Request changes, Comment, or Approve
- **Residual Risks:** verification limitations, assumptions, or unreviewed boundaries; write `None identified` only when there are none

Keep the result concise, respectful, deterministic, and suitable for a pull-request review.

## Final check

Before returning, confirm that the scope and repository were eligible, capabilities came from evidence, complete changed files and connected context were inspected, every finding is concrete and severity-calibrated, the decision follows the table, verification claims are truthful, exclusions and residual risks are disclosed, and no repository state was modified.
