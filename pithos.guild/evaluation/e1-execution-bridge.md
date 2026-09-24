# E1 execution bridge — offline implementation record

## Status

**Native-policy follow-up:** the [v2 native specification](e1-native-policy.md) is now recognized but deliberately blocked at bridge entry before any observer/driver call or admission. Legacy v1 entry for the reviewed native cohort is also blocked. The bridge does not yet derive native receipts; it must not silently ignore the new policy and use its old receipt rules.

**Follow-up:** the user has since explicitly approved Node/Pi 0.85.1; its [offline authentication/model check](e1-runtime-0851.md) resolves the catalog mismatch noted at this checkpoint. The [real CLI startup check](e1-native-startup.md) subsequently verified registration/ordinary child startup through missing-auth preflight, and the [base-pricing slice](e1-pricing-audit.md) now audits frozen per-turn prices during settlement/resume. Native execution/metering observation and independent review still block live execution. The earlier bridge verification history below is unchanged.

**Ledger-to-execution integration implemented and offline-tested. No live campaign is enabled.** No real credentials were accessed, provider requests made, models substituted, dependencies changed, or Phase 2 work performed. The CLI still rejects `run`.

The [approved smoke configuration](e1-smoke-campaign.md) remains unchanged. Its **Pi 0.83.0 / `gpt-6-astra` catalog mismatch**, verified native runtime/model/pricing observation, production Guild registration/startup, and independent review remain pre-spend gates. Injecting matching digest strings is not native verification or human approval.

## Later milestone-1 integration: consume ledger origins

The bridge now consumes [admission origins](e1-admission-origin.md) rather than leaving that boundary unused. After admission it derives the new trial request from the locked, journal-backed inputs. After the final external observation and immediately before driver entry, it opens a fresh origin scope and compares the runner's exact request, trial identity, retention root, artifact directory and working directory with a fresh derivation.

The scope ends **before** the driver runs. Workflow/active deadlines and cancellation are checked again after scope release. Historical receipt request reconstruction is unchanged: a settled historical attempt cannot obtain a new live origin.

A test-first regression demonstrated the gap: changing retained `spec.json` during the second observation used to allow one driver call before settlement failed. The bridge now makes zero driver calls in that case and preserves the changed file; it does not repair the ledger or claim zero spending. A positive inert workflow confirms the exact handed-off inputs and that the driver can inspect the ledger without a held origin lock.

A disposable-copy mutation moved driver execution inside the origin scope. Two tests failed with unknown receipt cost instead of the expected synthetic `0.25`: the new handoff/lock test and the existing admitted-UUID/first-pair integration test. Both copies were removed by an exit trap; maintained controls were unchanged.

Follow-up checkpoint: **227 evaluator / 135 Guild / 2 root tests passed**, both typechecks passed, Bash and tracked/untracked whitespace checks passed, bank digest unchanged, seeded schedule generated without execution, dry-run package 39 files, index empty. The copied-control run had 239 tests with two expected failures.

This is an actual bridge integration, **not completed native configuration binding**. A subsequent [parent-only configuration callback](e1-admitted-native-launch.md) now routes preparation through an origin-derived constructor and original-lease/runtime requirements. Native issuance remains disabled. The later [driver hookup](e1-native-driver-configuration.md) now calls that callback behind its unchanged early stop; successful native issuance/execution remains untested. Actual producer, serialized request/continuation and native receipt/resume integration remain unfinished. No native gate, host authorization or spending limit changed.

## Execution and retention

`src/campaign-execution.ts` exports repository-only `runCampaignNext()` with an explicit existing campaign directory, frozen specification, validated development bank, driver, and provider-free observation callback. It has no default driver, authentication discovery, retry, campaign creation, or automatic first-pair acknowledgement.

The bridge:

1. Clones inputs, validates the bank against the frozen bank/schedule, and rejects missing dependencies or cancellation before admission.
2. Opens the existing ledger and checks its admission blockers.
3. Re-audits every previously settled, admissible result against its ledger receipt and retained evidence. Missing or changed evidence prevents another admission; recorded totals alone are insufficient.
4. Checks observed bindings, then atomically admits against the audited journal digest. A concurrent journal change invalidates that audit rather than allowing an unchecked slot.
5. Uses the durable admission UUID as the trial ID: `trials/<UUID>/`. This relationship exists before fixture setup. UUID validation and exclusive directories prevent unsafe paths, collisions, or result reuse. It also passes the entire campaign retention root to the native driver so scoped Codex source/transient storage is excluded from the whole campaign tree, not only the nested trials folder.
6. Rechecks observed bindings before driver entry and after execution. The callback must be provider-free, must honor cancellation, and must actually inspect the approved inputs when the eventual native campaign is enabled. Its current injected tests do not fulfill that readiness gate.
7. Derives a settlement from retained evidence, persists it through the admitting ledger handle, and preserves all attempts.

Even an exception before `runTrial()` can write a result consumes its admitted slot. A private, exclusive `failure-<UUID>.json` links the failure to the admission and any completed result digest. Its settlement is failed, integrity-failed, and unknown spend. Arbitrary exception text is not copied into that sidecar, avoiding credential-bearing diagnostics. Existing partial trial files are retained; collisions are never overwritten. If the failure record or ledger settlement itself cannot be persisted, the start stays unfinished and blocks further admission.

The native controller must continue to use the approved directory; creating another directory or calling a driver directly is not a permitted limit reset. These library APIs are not an authorization boundary against arbitrary same-user code.

## Deadlines and grading

The bridge arms separate workflow and active-campaign deadlines from the ledger's decreasing allowances. It checks elapsed allowance again at cooperative boundaries before driver entry and settlement, not only when a timer callback runs.

`runTrial()` accepts reserved IDs and external workflow/active signals. The workflow deadline applies through setup and driver settlement, then is detached before grading. A workflow deadline expiring during grading must not relabel already-completed work. User cancellation and active-campaign expiry still apply to grading.

- Fixture setup, snapshots, and trusted Git inspection now accept cancellation. Git subprocesses use `SIGKILL` on cancellation/timeout; filesystem operations check cancellation between steps and pass signals where supported.
- Authorization checkers honor pre-launch and active cancellation. On POSIX, checker cancellation, limits, and early parent exit terminate the ordinary process group, not just the parent. Windows retains parent-only checker cleanup; the native campaign remains POSIX-only.
- Cancelled checks never pass. If cancellation prevents post-check inspection, `checkerMutated` is `null`, not a false claim of preservation. Cancellation before grading may leave grading absent. The repository and any preceding evidence remain retained.
- Active-budget expiry is reported as `campaign_timeout`; the first interruption is separately retained in `interruption`, and `campaignDeadlineExceeded` records the budget signal. This avoids hiding active expiry behind an earlier workflow timeout.

The active timer remains in force through grading and evidence verification. Recording failure/settlement after expiry is necessary to retain the attempt. Cleanup, OS scheduling, synchronous parsing, and filesystem persistence can overshoot a timer; overshoot is charged rather than clamped away. This is cooperative cancellation and admission enforcement, **not hard real-time scheduling, escaped-process containment, or a guaranteed billing cap**.

Pre-admission readiness/history inspection is outside the ledger's admitted active interval. During an attempt, verification before settlement is included in that interval. The ledger still excludes the final journal-flush tail after its settlement measurement.

## Evidence-derived settlements

`src/trial-receipt.ts` reads bounded, private, single-link regular artifact files without following final-component symlinks. Raw streams are bounded at 16 MiB each; metadata reads at 64 MiB. Malformed/unsafe/interrupted reads fail without echoing contents.

Settlement validation checks:

- retained result against the host-returned result, or the prior durable receipt digest on resume;
- full public request metadata and the frozen request digest;
- raw parent/child stream digests and a fresh `analyzeTrace()` result, rather than accepting a stored cost summary;
- a newly captured pre-driver `baselineDigest`;
- current final state against both the baseline's allowed mutation/index boundaries and the recorded pre-check final snapshot;
- completed, noncancelled grading with preserved scope/index and no checker mutation;
- returned model identity against the requested cohort.

Known cost additionally requires a normally recorded, zero-exit, non-expired workflow and a complete raw trace. Provider/process errors, timeout, missing usage, model mismatch, and uncertain evidence never become zero cost. Observed subtotals remain in trial artifacts even when the campaign estimate is unknown. Integrity failure prevents more admission; an ordinary deterministic task failure with intact evidence remains a failed result with its known estimate, not a retry opportunity.

This reuses the raw parent-plus-child analyzer; tool-result aggregates remain diagnostic. Verified **pricing metadata** and actual native input fingerprints still need an approved native observer. Trace shape, hashes, and returned model labels do not prove provider billing, report truth, or test quality. Human review remains pending, and candidate code still runs with ordinary same-user filesystem access.

The new baseline/interruption fields apply to newly captured trials. Historical measurements are unchanged and are not silently backfilled or admitted as new verified campaign evidence.

## Test-first evidence

Focused command throughout: `npm run eval:test` from `pithos.guild/`.

| Slice | Observed RED |
|---|---|
| Reserved trial UUID | Returned random ID instead of the admitted ID |
| Checker cancellation | Missing cancellation result; checker launched/ran instead |
| External workflow/active deadlines | `driver_error` / `recorded` instead of deadline outcomes |
| Workflow deadline detached before grading | Completed work incorrectly became `timeout` |
| Active-expiry precedence with original interruption retained | `timeout` instead of `campaign_timeout` |
| Cancellable fixture/Git/snapshot entry | Missing expected rejection |
| Evidence receipt API | Missing `trial-receipt.ts` module |
| Missing/altered/unsafe evidence | Stored-summary alteration was accepted |
| Cohort/process/final-state verification | Known cost for wrong model; late allowed-file mutation accepted |
| Execution bridge API | Missing `campaign-execution.ts` module |
| Pre-result failure retention | `EEXIST` escaped without a settled failure record |
| Required inputs / observation rechecks | Missing rejection; driver entered after drift |
| Active timer through native inert CLI | Ordinary workflow `timeout` instead of earlier `campaign_timeout` |
| Audit/admission concurrency | Stale audited history was accepted |
| Re-audit retained evidence on resume | Another admission proceeded after prior raw evidence was removed |
| Whole-campaign credential exclusion | Missing retention-root propagation; inert CLI launched with transient auth beneath the campaign root instead of rejecting it |

Each returned GREEN with the same command after implementation. The native test launches the existing Node/POSIX adapter with an inert CLI, verifies that its descendant actually started, and checks that the descendant's delayed write never occurs. It imports no provider and is not production Pi/Guild registration verification.

Two existing tests needed explicit contract/timing corrections:

- With cancellable fixture setup, the old 10 ms timeout test can end before grading exists. It now permits absent or explicitly unknown task success, never a fabricated score.
- Under added parallel filesystem load, the inert early-parent-exit test sometimes hit its 200 ms setup deadline. Only that non-timeout test case now has 2000 ms startup room; the cancellation case keeps 200 ms. No real campaign limit changed, and this unrelated test timing failure is not counted as behavioral RED evidence.

Final verification observed on Node.js 24.20.0:

| Command/check | Result |
|---|---|
| Guild `npm test` | 135/135 passed |
| Guild `npm run typecheck` | Passed |
| `npm run eval:test` | 69/69 passed |
| `npm run eval:typecheck` | Passed |
| `npm run eval -- validate` | Six tasks valid; approved bank digest unchanged |
| `npm run eval -- schedule e1-development-1 1` | Offline schedule generated; no execution |
| Repository root `npm test` | 2/2 passed |
| Guild `npm pack --dry-run --json` | 39 files; evaluation/private artifacts excluded |
| `git diff --check` | Passed |

Runtime code changes are confined to evaluation: new `campaign-execution.ts` / `trial-receipt.ts` and changes to `campaign.ts`, `runner.ts`, `pi-driver.ts`, `grading.ts`, and `fixture.ts`. Corresponding tests and evaluation documentation were updated. No production Guild source, tool/prompt/skill, dependency, lockfile, version, or publish metadata changed. Nothing was staged or committed; independent review remains pending.

## Remaining gates

1. Resolve the runtime/model mismatch with explicit approval; do not silently substitute models, runtimes, or pricing.
2. Implement and review actual native runtime/implementation/context/auth-policy/model/pricing observation. The current required callback is a seam, not assurance that this work is done.
3. Verify production Guild registration and ordinary child launching under the selected runtime without provider calls where possible.
4. Obtain fresh independent review outside the failed Bun launch route and resolve material findings.
5. Only then freeze inputs and enable the first approved smoke pair. No extra probes, retries, judges, or replacement campaigns are included.

Held-out promotion, Phase 2, staging, commits, versioning, and publishing remain separately gated.
