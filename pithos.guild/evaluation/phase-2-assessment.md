# Phase 2 assessment — exact task/result protocol

## Decision and authority

**Recommend a reduced, invariant-driven Phase 2, subject to explicit implementation approval.** This assessment does not start implementation.

The user stopped evaluator expansion and authorized this assessment. Treat E1 as **closed for further work, with an inconclusive outcome**, not passed or completed against C1–C8. The Phase 1 role/profile product foundation remains implemented; end-to-end comparative benefit is unproven. Historical preparation reviews, tests and artifacts retain their limited scope. All native admission, execution, settlement/history and provider gates stay closed. No dormant evaluator work is a prerequisite for the proposed product change.

This document records the current progression decision. Earlier roadmap completion labels and evaluator “next implementation” suggestions are historical, not instructions to resume E1. No historical evidence is rewritten and no reviewed manifest is refreshed as an execution claim.

## What Phase 2 originally meant

Source: `.pi/plans/2026-09-03-215415-plan-343f00a4-89bf-449f-83d4-14afc73ceaf3.md`, lines 266–274 and 357–363.

Original purpose: strict versioned task/result boundaries, role-specific results, package-owned `guild_submit_result`, bounded repair, and rejection of missing/malformed/duplicate/mismatched/oversized/prose-only completion. The original exit gate also required comparative evidence showing whether reliability gains justify overhead.

That measured gate is **not available**. The roadmap permits an explicitly accepted invariant rationale (lines 280–284). Proceeding therefore requires accepting deterministic conformance as the limited product acceptance criterion, while leaving task-quality, cost, latency and context benefits unknown. It must not be described as benchmark-backed promotion or satisfaction of the old exit gate.

## Observed product gaps

These are source-level acceptance behaviors, not measured model-failure frequencies.

| Current source | Gap and consequence |
| --- | --- |
| `src/guild.ts:74–79,185–205` | Parent input resolves role/profile and nonempty task prose. There is no versioned child task identity contract. |
| `src/runner.ts:140–177`; `src/guild.ts:436–444` | Accepted completion depends on process/stop status and nonempty assistant text, not a role-result schema or exactly one matching submission. |
| `src/runner.ts:186–197` | A JSON error event records an error message, but a zero exit/non-error stop can still pass `getRunFailure`. |
| `src/runner.ts:330–360`; `src/guild.ts:419–444` | Presentation truncation is not an ingestion bound on child output/diagnostics. |
| `src/guild.ts:468–475,675–733` | Tool and direct-command failure handling do not share one typed terminal outcome. |
| `src/ui.ts:481–487` | Tool-result cancellation presentation needs examination alongside the explicit direct-lifecycle cancellation branch at 146–150. |

Preserve the existing four roles, six profiles, migration aliases, package-controlled resources, role-owned repository tool ceilings, common trust/Plan admission, non-recursive children and cancellation-safe FIFO queue. Do not add roles, parallelism or project routing.

The historic C01 missing corroboration of claimed RED/GREEN is a truth/evidence limitation. A result schema cannot repair it by asking a child to assert that verification happened.

## Smallest justified implementation target

### A. One host-owned task identity and builder

Keep existing public `{role, profile, task}` and direct-command interfaces for this slice. Both use one builder after admission. Host assigns protocol version, task/run identity and canonical role/profile; objective remains user-supplied prose.

Do not invent scope or acceptance criteria by parsing prose. Separate scope/constraint lists, if included in the schema, remain explicitly unspecified unless actually provided. Prefer omitting unused fields over mandatory empty framework scaffolding. A structured public task API is a separate compatibility decision, not necessary to establish exact completion.

Validate at the runner boundary too. Reject unknown keys and enforce explicit byte/list/string limits. Identity fields are correlation, not secrets or authentication.

### B. Bounded role-specific child results

One versioned common header: task identity, role/profile, summary, blockers and limitations; one role-discriminated payload:

- Explorer: referenced paths/facts, assumptions and unknowns.
- Architect: decisions/alternatives, contracts and implementation/test handoff.
- Coder: reported changes and reported verification outcomes.
- Reviewer: inspected scope, severity-ranked findings and verdict.

Allow honest empty findings and unperformed verification. Do not mandate filler or duplicate evidence structures. Mark commands, file changes and conclusions as child-reported, not host-certified. No schema field may imply that truth, safety or write-scope compliance has been independently proven.

TypeBox is already used by Guild; use compatible runtime validation with no new validation dependency. Exact limits and payload keys are implementation-design choices to freeze before tests, not an excuse for a new evaluator.

### C. Explicit package-owned submission capability

One minimal child-only `guild_submit_result` tool validates and submits the current result. It may not write project files, run commands, contact providers, delegate or select output destinations.

This requires an explicit tool-ceiling amendment: each role retains its repository tools and additionally gets one package-owned protocol tool. Do not silently broaden read-only repository capabilities or load the parent Guild extension in children.

Current child startup disables ambient extensions (`src/runner.ts:69–80`). Supported explicit package-only loading and completion-control hooks must be checked in the applicable Pi documentation/source **before implementation**. Their availability has not been established by this assessment. Preserve ambient-resource isolation; if unsupported, stop for a concrete reduced design instead of installing runtime patches.

A child stdout/tool event is cooperative evidence, especially for coder children that have shell access. Schema validation does not authenticate hostile code. Do not import the dormant E1 containment/receipt architecture into this product protocol.

### D. One terminal state machine

Exactly one host-owned terminal record per admitted run:

- `completed`: one valid matching submission plus clean completion, no protocol failure or cancellation.
- `failed`: setup/process/provider/protocol failure with a stable reason.
- `cancelled`: host cancellation, including queued cancellation.

Cancellation/process failure overrides an earlier valid submission; late events cannot resurrect a settled run. Retain known usage and bounded diagnostics, leaving missing values unknown. Keep queue ownership until actual shutdown/cleanup settles. Observational callbacks must not break lifecycle ownership or launch cancelled work.

Reject missing, malformed, mismatched, duplicate, oversized and prose-only results. At most one corrective opportunity in the **same child**, with bounded validation feedback; never respawn or re-enter the queue as repair. Same-child completion repair remains dependent on supported Pi hooks. If unavailable, propose zero repair explicitly rather than invent automatic retries.

### E. Concise presentation

Render accepted envelopes deterministically for the parent. Do not pass raw stdout through as a successful structured result. Keep bounded diagnostics outside normal result text and distinguish failed/cancelled presentation. Existing best-effort logging is not a durable authority store.

## Acceptance for the reduced slice

Provider-free tests using the existing production runner/queue seams and authored child fixtures:

1. All 24 role/profile identities; strict nested schemas, Unicode/byte/count boundaries and mismatches.
2. One builder and equivalent tool/direct/editor input handling; aliases unchanged.
3. Valid, invalid, missing, duplicate, prose-only and oversized results; exact repair bound if supported.
4. Error/nonzero exit/cancellation after valid submission cannot pass.
5. One terminal outcome on setup failure, queued/active cancellation, shutdown and cleanup failure; preserve partial known usage.
6. FIFO remains occupied until cleanup; reentrant cancellation and observer exceptions are controlled.
7. Fragmented JSON events, bounded ingestion and late events.
8. Child submission resource/tool isolation, no recursion and unchanged repository capabilities.
9. Parent rendering and existing historical detail handling remain compatible.

Run package and root checks, typecheck, and package dry-run when published file metadata changes. Independent review covers the connected slice and fixes. These establish protocol conformance only; no stochastic benefit, overhead reduction, host isolation or E1 acceptance follows.

## Bounded work order and stopping rule

One product increment, not a revived evaluation program:

1. Verify explicit child extension/loading and same-child completion hooks through static documentation/source review; resolve package compatibility.
2. Freeze small task/result shapes, limits and terminal semantics; implement test-first.
3. Connect submission, runner, queue, shared tool/direct outcomes and rendering together.
4. Update package prompts/docs/packaging, run validation, obtain independent review and fix findings.
5. Stop with a conformance report and honest unknown benefits. No provider trials unless separately requested and approved.

Do not restart E1 to justify this increment. If plumbing requires runtime patches, new process orchestration or another general framework, stop and propose a narrower change. No numeric quality/overhead promise is justified by current evidence.

## Risks and unresolved implementation decisions

- The package declares Pi `>=0.83.0`, while static assessment found an older installed lock entry; neither historical tests nor the E1 0.87.0 target proves new hook compatibility. Establish the supported range without an implicit dependency upgrade.
- Tool submission and final-turn completion may need different hooks; verify both, including print/JSON mode.
- Strict results may reject useful prose and add tokens/repair latency. Value remains unknown.
- A result can be valid and false. Main must still verify claims and own synthesis.
- This assessment does not inventory or clean the mixed worktree; no staging, commits or release are authorized.

## Explicitly out of scope

Evaluator expansion/revival, native gate changes, paid/holdout/provider trials, runtime/dependency upgrades, Phase 3 skill/practice injection or TDD proof, Phase 4 routing, Phase 5 mutation guards, Phase 6 leases/audits, additional roles, parallel children, dashboards, generic protocol frameworks and hostile-code containment.

## Review and next decision

Static source assessment only; no implementation or new test execution. Independent read-only review returned **Approve, no findings — assessment only**. The reviewer checked the roadmap and production runner, agents, queue, admission, UI and package metadata; Pi hook compatibility and comparative value remain unverified. This is not implementation authorization.

Requested next decision after review: authorize the single reduced product increment **for deterministic completion guarantees**, explicitly accepting inconclusive E1 and unknown comparative value, and permitting the one child-only submission-tool ceiling amendment. This assessment alone grants none of that implementation authority.
