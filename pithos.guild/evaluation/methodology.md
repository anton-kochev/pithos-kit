# Guild evaluation methodology — E1, version 1

## Status and boundaries

This is a **pre-spend evaluation foundation**, not a completed benchmark or a Phase 2 implementation. CLI commands and tests are offline. Paid model trials require separate approval of the exact task bank, model cohort, runtime, and monetary/time ceiling. There is deliberately no `run` CLI command yet. `PI_OFFLINE=1` only disables Pi startup networking; it does **not** prevent provider requests.

Campaign-specific approvals and remaining readiness work are recorded separately in [E1 smoke campaign decisions](e1-smoke-campaign.md). Its configuration has been approved, but the readiness gate is still closed. Model and spending choices there are not permanent Guild defaults.

All ten original product phases (0–9), the conditional isolation phase, and the stop/review gates remain intact. E1 is a checkpoint between Phases 1 and 2. A passing evaluation harness does not authorize Phase 2.

## Evidence and comparisons

| Evidence class | Question | Primary evidence |
|---|---|---|
| Characterization/conformance | Does the mechanical boundary work? | Ordinary deterministic tests |
| Regression | Do known capabilities still work? | Repeated known tasks |
| Component experiment | What effect does one mechanism have? | Paired single-variable ablation |
| End-to-end product evaluation | Does Guild improve the complete user workflow? | Natural parent decisions through final synthesis |
| Dogfooding | What does real use reveal? | Case study; replayable only with frozen starting state |

A01/R01 from Phase 0/1 are now regression cases, not held-out evidence. Their historical numbers are not rewritten. E01/C01 are uncontrolled acceptance examples. Q01 is a useful case study, not a benchmark.

Primary product arms are **main-only** and **Guild-available**. Both start from the same user task, tool environment, clean Pi configuration, model, and reasoning setting. The latter explicitly loads the production `extensions/index.ts` and exposes `guild_handover`. The main agent may abstain or select any available role/profile. Neither arm is told to follow a mandatory pipeline. `create_commit` is not exposed in either arm; every fixture forbids committing/staging.

The initial native driver controls ambient resources in both arms. Thus it measures a **controlled Pi configuration**, not equivalence to every deployed user's settings/skills. That limitation accompanies any result. The driver does not substitute a child-only prompt for the main-agent workflow or reimplement Guild's tool registration.

Forced routing and previous implementations are diagnostic comparisons, not primary product arms. Add them only to answer a concrete question. Keep models fixed for architecture comparisons; a model change starts a new cohort with contemporaneous bridge trials if needed.

## Offline usage

From `pithos.guild/`:

```bash
npm run eval -- validate
npm run eval -- schedule e1-development-1 1
npm run eval:test
npm run eval:typecheck
```

`validate` checks the versioned task bank and immutable fixture digests. `schedule` emits a deterministic, hash-randomized paired order and bank digest; it does not launch anything. Both arms of each task/repetition are adjacent. Reuse the recorded seed and exact bank for replay. Repetitions are limited to 1–5.

The package's ordinary `npm test` covers production tests. E1 has a separate `eval:test` command and `evaluation/tsconfig.json`; the separate checks must be run for evaluation changes. Evaluation sources, graders, task bank, and reports are excluded by the package's existing publish allowlist. No new dependency is required.

## Task manifests and fixture semantics

`tasks/development.json` uses strict version 1 objects. Every task declares:

- stable ID and `development` or `promotion` split;
- exact user prompt;
- inline, bounded fixture and its SHA-256 canonical-JSON digest;
- exact allowed changed paths, known grader ID, and review rubric;
- a separate `abstain`/`optional` delegation expectation.

Canonical JSON sorts object keys and retains array order. Fixture edits require an explicit reviewed digest update using `digest` from `src/manifest.ts`; validation never silently refreshes hashes. Unknown/missing fields, IDs, splits, graders, unsafe paths, path/case collisions, and unbounded content fail before launch. Fixtures are limited to 1 MiB and 256 entries per file map.

Fixture maps deliberately distinguish:

- `files`: initial working-tree bytes for tracked files;
- `staged`: optional **index-byte overrides** for those tracked files;
- `untracked`: additional user-owned files absent from the index.

The fixture builder initializes a new Git repository, stages the index version, then overlays working-tree/untracked bytes. It creates **no commits**. These are unborn-HEAD repositories with real index/worktree differences, not historical commit/range-review fixtures. Review prompts explicitly ask for source review. Commit/range provenance and rename/binary-history tasks need additional fixtures before broader claims.

Each trial gets a UUID and an exclusive new directory; an existing fixture is never reset or reused. Snapshotting hashes file bytes/modes and symlink targets without following them, captures the Git index, status, and binary working-tree diff, and imposes size/count limits. Deletions and extra paths become scope changes. Index-only changes fail preservation even if working-tree bytes match.

These are **cooperative disposable copies, not an OS sandbox**. A process with unrestricted shell can inspect outside its cwd, detach from its process group, or tamper with the evaluator. Tests demonstrate independent starting states, not adversarial access isolation. Run any later model trials in a disposable environment without user work or unrelated secrets. Do not claim that filesystem placement alone makes graders secret from an adversarial agent.

## Development bank and holdout policy

| Task | Purpose | Automatic check | Human/trace review |
|---|---|---|---|
| `fact-01` | Trivial lookup; abstention opportunity | No mutation | Correct runtime/command, grounded citation, no invented verification |
| `auth-01` | Focused authorization fix | Hidden behavioral cases, exact change scope/index | Useful added tests, verification truth, restrained fix |
| `dirty-auth-01` | Same fix with user index/worktree/untracked state | Behavior plus independent baseline preservation | Attribution and verification truth |
| `review-01` | Seeded inverted TTL defect | No mutation | Recall, severity, evidence, Request changes |
| `clean-review-01` | Negative review control | No mutation | False positives, justified Approve |
| `blocker-01` | Missing .NET source; no speculative scaffold | No mutation | Correct blocker and requested inputs |

All six are **development-only** because they shaped the harness and graders. They are small, mostly JS fixtures, not proof across .NET, Angular, Rust, architecture design, or large-context work. This is a smoke bank, not a promotion bank. Do not relabel it held-out after tuning. Acquire 6–10 independently selected, audited cases before promotion; if implementation or prompts are tuned on a held-out case, retire it to regression.

The declaration `delegation: abstain` is diagnostic, not an automatic correctness veto. Optional routing has no single gold path. A review must consider whether delegation helped instead of demanding one tool trajectory.

## Graders and truth

Grader precedence is:

1. observable behavior, boundary and preservation checks;
2. tool/command evidence and final-state correlation;
3. independently reviewed qualitative rubric.

`unchanged` proves no working-tree/index mutation only. It does not certify a factual answer, review finding, or blocker. `authorization` runs a trusted Node checker outside the fixture on stdin. It tests self-update, cross-user denial before persistence, boolean-admin success, empty actor rejection, rejection of truthy non-boolean admin values, return value, and propagation of persistence errors. It does not trust the agent's edited tests as its sole oracle.

Calibration covers two structurally different correct implementations, the original defective implementation, a truthy-admin near-miss, a premature `process.exit(0)`, index-only mutation, and unrelated file changes. A per-check random completion marker prevents ordinary early exit from masquerading as success. It is not an adversarial JavaScript sandbox: code can tamper with shared runtime primitives. Adversarial evaluation would need stronger isolation/checker separation.

`review: pending` and `taskSuccess: null` remain explicit even when automatic gates pass. A human must inspect prose correctness, test quality, scope, verification honesty, and any claimed red/green sequence. The checker snapshots before/after verification to flag checker-induced mutations. It must not attribute checker effects to the agent. The harness does not execute arbitrary manifest-provided shell graders.

## Trial driver and records

`runTrial` has **no default driver**. Offline tests inject scripted behavior; the native driver is tested against an inert fake CLI, without loading a provider. This tests the OS/argv boundary, not a real-model integration.

The native POSIX adapter in `src/pi-driver.ts` uses a supplied Node Pi entrypoint and its package manifest (minimum 0.83.0), a fresh private home/agent directory, explicit tools/model/thinking, disabled ambient extensions/skills/templates/context files, disabled compaction/retries, and the real Guild entrypoint in the Guild arm. It fingerprints implementation inputs and checks for drift after execution. It records runtime/package identity, implementation hashes, exact arguments, environment policy, and credential **key names**, never credential values. The API-key path accepts explicit Anthropic/OpenAI/Gemini credential variables. The [scoped Codex path](e1-authentication.md) accepts an explicitly supplied private auth file and temporary root, borrowing only a sufficiently fresh access credential outside retained artifacts. It never copies a usable refresh token or modifies the source. Expiry is rechecked before spawn; automatic refresh/login and mixed API-key/Codex credentials are not supported. This borrowing policy is reviewed for exactly Pi 0.83.0 and 0.85.1; the [approved campaign](e1-smoke-campaign.md) separately pins 0.85.1 without fallback. Other subscription/custom-provider setup requires separate design/approval. No inherited `NODE_OPTIONS` or global provider configuration is used.

Both arms load the evaluation-only `src/child-observer.ts` Node preload. It subscribes to the production runner's internal `pithos.guild.child` diagnostics channel and synchronously records observations to an exclusively created, mode-0600 `children.jsonl` file through descriptor 3. It does not write observations to parent/model stdout or load another Pi extension. Guild children inherit neither the preload nor descriptor 3. With no subscriber, ordinary Guild use creates no observation file or event stream. The preload and its shared limits are included in the implementation fingerprint; recording overhead is part of measured workflow latency.

The driver kills its POSIX process group on cancellation/timeout and on parent exit. Escaped/detached processes and hostile code are outside this assurance. Windows is unsupported in this initial adapter.

Use an ignored repository-local `.pi/evaluation/runs/` directory for eventual retained trials. The low-level API accepts a caller-owned storage directory for isolated tests; it does not enforce Git ignore policy itself.

Records are private and append/exclusive-create rather than replaced:

- `request.json`: run identity, public task/context and request digest, runtime/time;
- `baseline.json`: original index, file hashes, status and diff;
- `invocation.json`: native adapter provenance (absent for injected offline drivers);
- `parent.jsonl` and `stderr.txt`: bounded raw parent output, including partial failure evidence;
- `children.jsonl`: private observer lifecycle and correlated raw child stdout/stderr chunks, plus runner terminal observations (native adapter only);
- `task-manifest.json`: full rubric only after execution settles;
- `result.json`: outcome classification, trace digest, usage, grade and final snapshot;
- `repo/`: retained final worktree and Git state; never automatically reverted.

Raw parent output caps are 16 MiB stdout and 1 MiB stderr; child observation has a separate 16 MiB cap including framing/base64 overhead. At its cap the recorder writes an explicit limit marker and stops recording, not the workflow; missing terminal evidence makes the trace incomplete after settlement. Recording failures likewise cannot certify a total. The post-run reader rejects oversized/non-regular child artifacts and preserves them rather than deleting them. These capture limits are not monetary controls; a live admission/budget controller is still required. Over-limit trials are classified, not silently treated as complete. The workflow timeout excludes trusted grading; the checker has a separate five-second/64-KiB bound. `workflowElapsedMs` includes setup/startup/work/synthesis; `elapsedMs` additionally includes grading/record construction. Abrupt harness/host termination can leave an unfinished directory without `result.json`; retain it as interrupted, not a skipped trial. No automatic retry or best-of-k selection is performed.

## Usage accounting and child observation

Count authoritative parent `message_end` events only, not `message_update`, `turn_end`, or the `agent_end.messages` replay. Identical finalized-message duplication is flagged and not silently double-counted. Exact duplicate messages without distinct timestamps are ambiguous and therefore invalidate completeness rather than asserting certainty.

Count each Guild `tool_execution_end` aggregate once per call ID. Intermediate updates and repeated terminal events cannot inflate totals. Expose parent totals and `childReported` totals separately, then their `totalReported` sum. Missing/invalid numeric fields remain `null`, not invented zero. Record cache reads/writes explicitly; provider-specific final context is not cumulative usage.

The [telemetry follow-up](e1-telemetry.md) adds opt-in raw observation without changing Guild's free-form task/result API, role prompts, tools, or normal aggregate reporting. Each runner invocation has a child UUID, parent tool-call/direct-command `runId`, canonical target, and contiguous sequence numbers. Raw stdout/stderr bytes are base64-framed before normal parsing; start/end observations distinguish setup failure, process completion, and cancellation. A killed process may leave no terminal record. The evaluator still reads retained evidence when a driver throws.

`analyzeTrace(parentJsonl, childJsonl)` checks observer readiness/termination, per-child sequencing, parent-call correlation, target identity, process outcome, encoding, and finalized child messages. It exposes `childRuns`, `childObserved`, and `totalObserved` separately from the old reported aggregates. It counts child `message_end` usage, not streamed/replayed copies or a second copy of Guild aggregates. Unfinished assistant attempts after an earlier final turn also invalidate completeness. Both parent and child model identities participate in cohort checks.

`parent` and per-child usage retain observed finalized-turn subtotals after failures; they are not a complete bill. Missing fields or missing child runs remain unknown. `totalObserved` is unknown when the trace has any issue; `totalReported` remains diagnostic only. Without raw observation, delegated runs still have `child_raw_usage_unavailable` and cannot certify accounting. Even with a complete recording, usage the provider never reports cannot be recovered. Provider-reported zero-price estimates are not proof of zero subscription cost or absence of hidden provider work.

Raw child tool events support later command-order/verification review, but capture alone does not corroborate an agent's claimed RED run or establish task success. This is cooperative observation, not tamper-proof telemetry or a Phase 2 result protocol.

Payload bytes measure actual text returned by the handover, not parent-token savings. `parentContextTokensAdded` stays `null` until measured at the next parent call. Model identities, malformed input, provider errors, unfinished handovers, missing terminal stops, and truncation remain explicit diagnostics.

Raw capture has offline real-runner/inert-CLI integration tests, not live-provider verification. After the earlier Pi 0.83.0 catalog mismatch, the explicitly approved Node/Pi 0.85.1 passed [synthetic SDK auth/model checks](e1-runtime-0851.md) and [production Guild registration/ordinary child startup checks](e1-native-startup.md) through missing-auth preflight. These remain separate from successful provider requests and native execution binding. The [campaign ledger foundation](e1-campaign-ledger.md) now persists admissions, limits, first-pair inspection, and monotonic active-time settlements across clean resumes. Unfinished attempts remain counted and block further admission. The [execution bridge](e1-execution-bridge.md) now enforces cooperative workflow/active-time cancellation, binds artifacts before setup, derives receipts from raw evidence/final-state inspection, and re-audits settled history before admission. Grading cancellation may leave checks/preservation unknown; it must not certify skipped work. The required provider-free observation callback is still an unverified native integration seam. The [base-pricing audit](e1-pricing-audit.md) freezes an optional policy with new specifications and checks every finalized parent/raw-child turn during fresh settlement and history re-audit; unexplained cost remains unknown. Unpriced historical/inert compatibility is not live readiness. Independent review and actual native runtime/context/model/metering/service-tier observation remain **pre-spend blockers**. Native SDK zero defaults and missing service-tier metadata cannot be repaired by serialized cost agreement. Do not start a large or promotion campaign using partial totals. Per-trial driver acknowledgement is an operator guard, not proof of human approval or a hard dollar cap. A live campaign controller must stop admission on unknown spend, bind the approved bank/cohort, and acknowledge in-flight overshoot; it is not enabled by this CLI.

## Reporting and promotion

Correctness, safety/preservation and implemented conformance are hard gates. Beyond them, prioritize reliability, parent-context/cost, then latency. Do not compress these into one Guild score.

Report every task/arm/repetition, including timeout, provider error, malformed completion, cancellation, setup/grader failure, missing evidence, and interrupted directory. Keep infrastructure-invalid trials and reasons in an audit denominator even when reporting a separate capability denominator. A replacement needs predeclared paired treatment; never replace only unfavorable results.

Smoke: 4–6 development cases, one paired trial, debugging only. Promotion: initially 6–10 held-out cases, three paired trials. If the predeclared result is borderline, expand the entire relevant comparison to five repetitions within the approved budget, or report **inconclusive**. Use paired differences/distributions and uncertainty appropriate to the sample; do not present three trials as guaranteed statistical power. Larger 15–30-task suites remain periodic, not mandatory on each edit.

Human graders should receive arm-blinded randomized reports and outcomes; preserve disagreement and calibration. An uncalibrated model judge is not ground truth. A01/R01's saturated scores cannot show improvement.

Before Phase 2, test whether free-form boundary failures occur often or consequentially enough to justify a protocol. Later compare free-form/structured boundaries while keeping role/profile behavior fixed, and measure repair burden, useful-result false rejection, task success, claim/evidence agreement, total cost and latency. Shape validation never substitutes for truth. Stop for explicit review after E1; a negative or inconclusive result may postpone or simplify Phase 2.
