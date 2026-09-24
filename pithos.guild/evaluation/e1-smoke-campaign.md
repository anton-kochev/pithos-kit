# E1 development smoke campaign — approved decisions

## Approval and current state

The user accepted the proposed readiness decisions and smoke limits with “Okay. Sounds good. Let's continue.” This records that approval; it does not assert that the remaining implementation, independent review, or live-readiness checks have passed.

**Status: configuration approved; execution blocked on readiness. No campaign model trials have run.** The CLI still has no live-run command. This is an E1 debugging campaign, not promotion evidence or authorization for Phase 2. See [methodology.md](methodology.md) for the stable evaluation contract and [e1-foundation.md](e1-foundation.md) for delivered functionality and its verification history.

**Readiness progress:** the [child telemetry slice](e1-telemetry.md) is implemented and offline-tested. It is not independent approval or real-runtime/provider integration evidence. [Scoped Codex access-only borrowing](e1-authentication.md) is also implemented and offline-tested. A real Pi 0.83.0 SDK probe resolved a synthetic credential without network access, but confirmed that its shipped catalog lacks `gpt-6-astra`. The user subsequently approved the already-installed Node-launched **Pi 0.85.1**, retaining the model and all other campaign limits. Its [offline SDK/authentication check](e1-runtime-0851.md) resolves the catalog mismatch. The later [real CLI/Guild startup check](e1-native-startup.md) verifies registration and ordinary child startup through missing-auth preflight. Native execution/context/pricing binding, successful authenticated provider access, and independent review remain unfinished. The [persistent campaign ledger](e1-campaign-ledger.md) now has offline tests for admission, limits, checkpointing, and resume behavior; the [execution bridge](e1-execution-bridge.md) now also connects those controls to trial artifacts, deadline cancellation, and evidence-derived settlements in offline tests. A [frozen base-pricing audit](e1-pricing-audit.md) now checks each raw parent/child turn during settlement and resume. The later [raw response checkpoint](e1-response-observation.md) adds SSE/WebSocket adapters and synthetic checks against the actual SDK, including missing categories, tier loss, cached reuse, retry and fallback. Those adapters are not yet installed in campaign execution or receipts. Native runtime/context/final-request-policy/metering binding, plus independent review, remain required; serialized cost agreement is not those observations.

**Runtime approval revision:** after the [installed-catalog inventory](e1-runtime-readiness.md), the user answered “I do confirm” to changing only the evaluation runtime to Node-launched Pi 0.85.1. The table below records that explicit revision. The [compatibility record](e1-runtime-0851.md) adds narrow driver support after source inspection and synthetic checks; it is not complete live readiness. Earlier Pi 0.83.0 measurements and compatibility records remain historical, not a fallback cohort.

## Approved campaign configuration

| Item | Decision |
|---|---|
| Task bank | The six development tasks in `tasks/development.json` |
| Bank digest | `9254fe78fdf7580faf991b4936beec533a1327e54b4efa7f6ed9cffd87820f85` (canonical JSON SHA-256 from the evaluator) |
| Tasks | `fact-01`, `auth-01`, `dirty-auth-01`, `review-01`, `clean-review-01`, `blocker-01` |
| Primary arms | Main-only and naturally Guild-available; no forced pipeline |
| Repetitions | One per task/arm, at most 12 trials; no automatic retries |
| Runtime | Node-launched, already-installed Pi 0.85.1 (explicitly confirmed); record the actual Node version and runtime/implementation digests before execution |
| Model | `openai-codex/gpt-6-astra` for parent and children |
| Thinking | `high` in both arms |
| Context policy | Fresh private Pi configuration; no ambient settings/resources; production Guild entrypoint only in the Guild arm |
| Per-trial timeout | Five minutes for setup/startup/work/final synthesis; separately bounded trusted grading |
| Active campaign time | At most 60 minutes; includes in-flight work, not just gaps between admissions |
| Spend guard | Stop admitting work at $10 of provider-priced estimated usage, or immediately when spend becomes unknown |
| First checkpoint | Inspect the first paired task before admitting the remaining trials |
| Grading | Deterministic checks plus arm-blinded human review; no automatic model judge initially |
| Retention | Local raw traces in ignored `.pi/evaluation/`; only reviewed, sanitized reports enter version control |

The model identifier is a selected cohort, not proof that a hosted alias is immutable or currently available through the pinned runtime. Verify availability and record actual returned model identity. If the runtime/model/auth combination cannot work, report a blocker; do not silently switch models, reasoning level, runtime, or authentication source.

Freeze the implementation and generated schedule before execution and record their digests. The existing offline schedule command accepts a recorded seed and keeps each task's two arms adjacent. A changed bank, model, budget, or material environment policy needs renewed approval, not silent substitution.

## Readiness work approved before spending

### 1. Child observation

Retain correlated parent/child IDs, raw child events, tool/command outcomes, and provider-reported usage from every completed turn, including partial evidence after errors, cancellation, and timeout. Keep observation outside model context and separate from Phase 2's task/result protocol.

Prefer evaluation-only instrumentation. A small optional production-runner observer hook is acceptable if needed; it must be inactive during ordinary use, preserve execution semantics, and receive deterministic tests and review. This is not permission to introduce result schemas, practice enforcement, routing guards, or another roadmap phase.

Raw capture cannot recover usage the provider never reports. Such usage remains unknown; stop admitting further campaign work. Do not equate a saved transcript or a zero-filled aggregate with complete accounting.

### 2. Runtime verification and independent review

Verify production Guild registration and child launching through the pinned Node runtime without a live provider first. Review the evaluator in a fresh session outside the failing Guild/Bun launch path. Resolve material findings before enabling live trials; do not present self-inspection as independent approval.

The previous Bun startup failure does not authorize installing runtime patches or changing package versions. Node-based launching is the selected route for this controlled campaign.

### 3. Scoped Codex authentication

Support explicitly supplied existing Codex authentication without importing global settings, skills, extensions, or unrelated credentials. This support is now implemented as [access-only borrowing](e1-authentication.md), not source refresh-token copying. The operator supplies an explicit private file and temporary root; the token must outlive the trial plus Pi's refresh window/reserve, and near-expiry tokens are rejected. Independent review and real provider verification remain pending.

Credential material must not enter task fixtures, model prompts, command-line arguments, raw traces, invocation metadata, or retained trial artifacts. Any necessary credential storage must be private and transient, separate from retained evidence, with ownership, refresh behavior, and cleanup explicitly defined. Do not modify or consume broader global configuration merely to reproduce authentication.

### 4. Campaign admission control

The [offline ledger foundation](e1-campaign-ledger.md) persists starts and settlements, rejects frozen-input drift, and exposes separate workflow/active-time allowances. The [execution bridge](e1-execution-bridge.md) now consumes those allowances, cancels workflow/checker processes, derives receipts from retained evidence, and re-audits history before another admission. An optional base-pricing policy is now frozen with the whole specification and checked during fresh settlement and historical re-audit; absence is retained only for historical/inert compatibility, not live readiness. Its required observation callback still needs verified native implementation: matching supplied digest strings or cost numbers are not runtime/model/metering evidence.

Bind execution to the reviewed bank, schedule, implementation, runtime, cohort, and approved limits. Persist started and interrupted attempts so a resume cannot reset the allowance. Count all parent/child attempts; missing usage prevents further admission. A typed acknowledgement alone is not a budget controller.

The $10 threshold is **an estimated-usage admission guard, not a guaranteed billing cap**. In-flight requests can overshoot, provider usage may arrive late, and Codex subscription billing is not identical to model-price estimates. If a strict monetary cap is required, use a suitable provider-side control and renew the campaign decision accordingly. Do not claim such a control currently exists.

The campaign allowance does not silently absorb or authorize extra paid probes, replacement attempts, judge calls, or review calls. Account for any separately authorized paid readiness work outside the 12-trial result set and disclose it separately.

## Execution and grading rules

1. Finish the readiness work, offline tests, and independent review before any campaign provider call.
2. Verify the frozen campaign inputs and start the first scheduled pair.
3. Inspect that pair's traces, accounting, final state, and grader behavior before continuing. It counts toward the 12 trials; it is not an extra free warm-up.
4. Pause on evaluator-integrity or user-work-preservation failure. Ordinary task failures remain results rather than grounds for dropping a trial.
5. Stop on limits or unknown spend. Preserve cancelled, timed-out, malformed, interrupted, and provider-failed attempts. Do not silently retry or choose the best result.
6. Apply deterministic checks first, then arm-blinded human review of correctness, findings, verification honesty, and added-test quality. Retain pending/disputed judgments rather than inventing a successful task score.
7. Publish a sanitized development report and stop for review. No statistical superiority or Phase 2 promotion claim follows from these 12 smoke trials.

## Later promotion campaign — not yet authorized

The proposed next comparison is **eight independently selected held-out tasks × two arms × three repetitions = 48 trials**, including architecture, larger repositories, and relevant non-JS stacks. Its concrete bank, runtime/model cohort, budget, and decision criteria require separate approval after smoke validation.

Held-out means not used to tune Guild; it does not mean exempt from auditing task clarity, reference solutions, or grader correctness. The current six development cases cannot be relabeled as held-out. No additional model, legacy-version arm, forced-routing arm, or automatic judge is included in this smoke approval.
