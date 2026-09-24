# E1 original auth-lease provenance

**Milestone 1 remains incomplete.** Native configuration preparation now looks up the exact issued lease, rather than trusting a caller-provided directory, identity or freshness method. Native issuance/execution gates remain closed.

## Process-local issuance and scope

`createCodexAuthLease()` registers its frozen return object in a private WeakMap only after private credential creation and identity capture succeed. The record retains the original immutable observation, freshness closure, trial timeout and ordered retention-exclusion declarations. It does not expose the source credential, source path or refresh token.

`readCodexAuthLease(lease, expectedScope?)` accepts only the exact still-live issued object. Copies, proxies, structural substitutes and unissued objects fail without consulting their getters. It invokes the original freshness check, including the original timeout plus refresh reserve and the captured scoped file identity. An optional scope expectation must match the original timeout and ordered exclusion paths exactly; it cannot shorten the lease's freshness requirement or replace its exclusions. The returned directory/identity observation is frozen, not a reusable issuance grant.

The admitted constructor always supplies a scope expectation derived from the admitted request and paths plus selected Guild root. This matches the driver's existing lease-acquisition declaration: trial parent directory, campaign retention root, fixture cwd and Guild root, with the original workflow timeout. All constructor freshness checks use issuer lookup with that scope. This closes structural lease substitution and mismatched-window/exclusion declarations at this input boundary.

The check concerns the original declared scope; it is not continuous monitoring of directory topology or authenticated operator approval of the credential source. Registry identity is module-instance/process-local, not serialized provider authentication, entitlement, a persistent capability, or hostile-code containment. Two matching observations do not recreate an issued object. Fresh native receipts/resume and producer-side authority are still unfinished.

## Disposal is revocation

Disposal invalidates both issuer lookup and the original public freshness method **before** starting filesystem cleanup. They remain invalid even if cleanup fails and the private file still exists. There is no automatic reactivation, stale-lease recovery or cleanup retry in production code. A retained observation cannot be used as an issuance reference after disposal.

The ordinary Pi driver retains its existing public freshness call and useful token-lifetime diagnostics. An attempted switch to the generic issuer lookup caused its existing `outlive the trial` regression test to fail because the new API intentionally emits `Codex authentication lease mismatch`; that driver-only change was reverted. It already creates and owns the genuine frozen lease itself, and its public freshness method now also observes disposal revocation. The native constructor uses the stricter lookup because it accepts a lease argument.

## Evidence and limitations

Synthetic credentials and temporary private files only. Tests demonstrate exact-object issuance, immutable observations, refusal of copied/proxied/getter-controlled substitutes, scope mismatch, scoped-byte drift, and expiry that still satisfies the six-minute reserve alone but no longer the original full workflow window.

A mocked filesystem removal boundary inspects the lease before any deletion and tests both successful and failed cleanup. RED showed both issuer lookup and public freshness were still accepted at that point; GREEN rejects both. Failure leaves the synthetic file present, without a fabricated cleanup-success claim. Node's built-in filesystem exports are restored after these tests.

A disposable auth-module copy added a structural fallback, skipped issuer freshness and omitted revocation. Its six expected failures were:

| Copied control omission | Diagnostic |
| --- | --- |
| Exact issued-object requirement | Copied lease accepted |
| No getter inspection | Getter read count increased |
| Original freshness | Byte drift and original-window expiry accepted |
| Disposal revocation | Both checks still accepted at cleanup entry, for success and failure |

That run had 276 tests and six expected copied failures; both copies were removed by an exit trap. A subsequent scope test separately went RED when a different timeout/exclusion declaration was accepted, then GREEN after scope binding. Maintained controls were never weakened. Self-inspection is not independent review.

Final local checkpoint: **265 evaluator / 135 Guild / 2 root tests passed**, both typechecks passed, Bash and tracked/untracked whitespace checks passed, development-bank digest unchanged, schedule generation only, dry-run package 39 files, index empty. Existing native stops remain in place.

Successful native preparation remains unexecuted under an issued v2 origin. This change does not claim actual runtime/Guild selection, producer/request/continuation integrity, native receipt validation or comparative benefit. No real credential, SDK/provider, procfs or host probe; no spending, resource/runtime/dependency/version change, staging, commit or release occurred.
