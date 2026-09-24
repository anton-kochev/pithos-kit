# E1 ledger-backed admission origin

**Status: scoped origin and parent-input derivation implemented and inert-tested; native execution remains disabled.** No native admission was fabricated or enabled. No runtime/procfs/SDK/provider probe, host run or model trial occurred.

## Origin, not caller-supplied admission data

`campaign.withAdmissionOrigin(id, visit)` opens the existing cooperative ledger transaction, rechecks the frozen specification and journal, and requires the calling handle to own the current pending admission. Wrong IDs, reopened handles and settled attempts cannot enter the visitor. Native campaigns encounter the unchanged execution gate before origin issuance.

The visitor receives an opaque, process-local `CampaignAdmissionOrigin`. `readCampaignAdmissionOrigin(origin)` returns a recursively frozen snapshot of the actual journal-derived admission, frozen specification, campaign directory and history digest. No bank, rubric or credential is stored in that snapshot. The token is recognized by a private WeakMap, not by caller-supplied fields: copying, serializing or fabricating an object does not reproduce it.

Reads and successful visitor completion require a live allowance. The origin is revoked in `finally`, including callback failure. The operation appends no event, admits no extra attempt, changes no budget and authorizes no launch. A remaining-time check cannot interrupt a stalled callback.

**Keep the visitor short and limited to configuration derivation.** It holds the campaign lock. Do not launch a workflow or call another campaign transaction inside it; nested transactions fail locked. Callback failures propagate, so callers remain responsible for sanitizing their own arbitrary diagnostics and retaining partial evidence. There is no automatic rollback or stale-lock repair.

The origin proves only this module's in-process relationship to a replayed, cooperatively locked pending admission. It does not authenticate the operator's original specification approval, the filesystem against hostile same-user code, or evidence across processes. Frozen snapshots may outlive the visitor as data; only the opaque token loses validity. No snapshot or token should be distributed as producer authority.

## Derive, do not accept overrides

`deriveAdmittedTrialInput(origin, bank)` is a parent-only builder in `native-trial-binding.ts`. It checks the supplied bank against the snapshot's bank digest, development split and schedule, then derives:

- the exact admitted task, arm, repetition and frozen cohort;
- the original workflow timeout, not a shortened remaining allowance;
- request digest and trial identity using the journal's UUID;
- the admitted campaign's trial/artifact/repository locations.

The resulting input is frozen and **contains the private bank/rubric**. Do not serialize it into a producer configuration. Caller mutation of the public admission returned by `admit()` cannot rewrite these inputs.

`bindAdmittedNativeRuntimeRequirement(origin, bank, runtime)` uses that derivation, requires v2, invokes the existing runtime-input binder and rechecks origin liveness before returning the existing reduced requirement. It returns neither token nor snapshot nor bank. The older `bindNativeRuntimeRequirement(input, runtime)` remains an expected-input comparison, not a trusted issuance API.

**The admitted native wrapper's success path is currently unreachable.** Tests establish real inert-v1 scope/derivation and rejection of fabricated origins and inert-to-native conversion. They do not manufacture native origins to claim a successful native integration. Existing independent pure-input tests continue to cover v2 runtime requirement validation.

## Verification

Observed RED/GREEN cycles used `npm run eval:test`: missing origin API, missing parent-input builder, and missing admitted-native wrapper. Additional maintained pins cover scope revocation, frozen snapshots, ownership, deadlines, disk-spec drift, unchanged history and the closed native gate.

A disposable-copy run omitted four protections and produced four expected failures:

| Copied mutation | RED diagnostic |
| --- | --- |
| Omit origin revocation | Missing expected exception for escaped origin |
| Omit allowance check | Missing expected expiry exception (reported through the outer rejection assertion) |
| Omit snapshot freeze | Frozen snapshot assertion failed |
| Omit bank-digest comparison | Missing expected rejection for changed task prompt |

The sensitivity run reported 233 tests with four expected copied-control failures. All four copies were removed by an exit trap. Maintained controls and native gates were never weakened. Self-inspection is not independent review.

Final local checkpoint: **225 evaluator / 135 Guild / 2 root tests passed**, both typechecks passed, Bash and tracked/untracked whitespace checks passed, development-bank digest unchanged, seeded schedule generated without execution, dry-run package 39 files, index empty.

## Still required

The [execution bridge now consumes these origins](e1-execution-bridge.md): it derives new requests from the admitting handle and compares exact runner inputs under a fresh scope before driver entry, releasing the lock before running the driver. The later [admitted configuration path](e1-admitted-native-launch.md) now consumes the native origin wrapper through a parent-only bridge callback. Its native success path remains gated and untested under an issued v2 origin. Producers and native receipts/resume still lack integration. The low-level `prepareNativeLaunch()` writer retains its separate caller-input contract and is not itself an issuance authority.

Next: integrate the origin-derived expectation with actual configuration creation and the original auth lease, freeze and verify the reviewed concrete runtime/Guild selection, correlate every producer and serialized request/continuation, then enforce the same native audit on secure fresh and resumed receipts. The configuration must retain the relevant origin/history correlation without distributing the private bank. Fresh restricted integration and approved independent review remain prerequisites to the original first live pair. No spending, Phase 2, holdout promotion, staging, commit or release permission is implied.
