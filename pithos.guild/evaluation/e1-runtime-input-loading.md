# E1 retained runtime-requirement loading

**Current candidate update:** [owner-authorized 0.87.0 contract migration](e1-runtime-0870.md) adds unreviewed/unadmitted policy V3 and runtime requirement v2. Immutable V1, historical candidate V2, requirement v1 and the checkpoint evidence below retain their 0.85.1 meaning. All execution gates remain closed; selected bytes, SDK/auth/provider compatibility and independent acceptance are not established.

**Milestone 1 remains in progress.** The producer preload now validates the retained runtime requirement before its unchanged unsupported-bound-configuration stop. This is input validation, not runtime observation, native issuance, SDK startup or model execution.

## Parent output and shared contracts

The admitted constructor serializes the reduced runtime requirement once. Its closed `admissionBinding` now includes `runtimeRequirementSha256`, the raw-byte SHA256 of that exact sibling file, in addition to the existing canonical-object `runtimeRequirementDigest`. The parent uses the same serialized string for hashing and exclusive writing. Missing raw hashes are rejected; no native admission with the older draft binding was issued or backfilled.

`native-input-contracts.ts` contains the shared closed binding/runtime validators and selected-path table. Parent binders, the existing runtime observer and the new loader reuse them. It has no runtime ledger, bank-loading, filesystem or SDK dependency; its reference to `offline-runtime.ts` is type-only. The thirteen selected paths and reviewed tuple are unchanged. The legacy runtime-observation module retains its public binder/observer entry points.

Binding validation now returns the checked snapshot rather than reading accessors again while constructing the result. A regression demonstrated an unchecked second getter value before the fix. These validators establish structural consistency, not an authenticated issuer or approved concrete bytes.

## Producer loading

`readNativeRuntimeInput(configFile, expectedConfigSha256)`:

1. Requires the `native-config.json` basename and reads it using the bounded private-file reader and explicit raw-byte hash.
2. Validates its closed binding metadata.
3. Reads only the fixed `runtime-requirement.json` sibling using the bound raw-byte hash and the same bounded/private/stable-file checks.
4. Validates the closed runtime tuple, ordered inventory, requirement shape and internal runtime digest.
5. Requires canonical requirement digest, trial UUID and trial-binding digest agreement with the configuration.
6. Returns the frozen reduced requirement, or the fixed error `Native runtime input mismatch`.

The reader's hashes do not grant authority. A caller who changes both inputs and expectations is not contained. Full configuration schema/issuer validation and historical receipt authority are still pending. There is no claim of continuous filesystem monitoring or a previously bound configuration inode.

The native preload consumes this function for bound configurations and then **unconditionally stops before any runtime observation or SDK import**. The installed-runtime observer is not invoked. The native campaign and driver gates also remain unchanged, and the later [driver hookup](e1-native-driver-configuration.md) calls its admitted preparation callback only behind that unchanged stop.

## Local evidence

All requirements are synthetic input fixtures, not issued native admissions or observations of installed files. The positive loader test allows only two file opens: configuration and its sibling. The bound-preload test supplies valid synthetic input metadata, records the sibling read at the filesystem boundary, and still requires rejection before the inert SDK import tripwire. Its shim also blocks and flags installed-runtime/procfs observation attempts. No installed-runtime, procfs, SDK/provider or real-credential probe occurred.

RED/GREEN covered the additional binding field, missing loader API, missing preload sibling read, binding getter re-read, and missing mock-Docker assets. Parent serialization/freshness under an actual v2 origin remains unexecuted because issuance is closed. Shared-validator extraction was a green refactor; it was not counted as new behavioral RED.

Negative fixtures cover missing/aliased files, byte corruption, rehashed trial and trial-binding mismatches, altered tuple/inventory, unexpected private-bank marker fields, missing raw hash, wrong raw/canonical/internal digests and extra binding fields. These pins initially passed. A disposable loader copy omitting schema and canonical/trial correlation produced seven expected `Missing expected exception` failures:

| Omitted control | Rejecting cases |
| --- | --- |
| Trial correlations | Different UUID, different trial binding |
| Closed requirement/runtime validation | Wrong architecture, incomplete inventory, extra field |
| Canonical digest checks | Wrong requirement digest, wrong internal inventory digest |

That run had 271 tests and seven expected copied-control failures. Both copies were removed by an exit trap; maintained controls were never weakened. Self-inspection is not independent review.

The future restricted synthetic roster adds `native-input-contracts.ts`, `native-policy.ts` and `native-runtime-input.ts`. Only mocked asset checks have exercised that update. Historical host evidence remains unchanged and does not certify it; no container/network/resource-limit change was made.

Final local checkpoint: **258 evaluator / 135 Guild / 2 root tests passed**, both typechecks passed, Bash and tracked/untracked whitespace checks passed, unchanged development-bank digest, schedule generation only, dry-run package 39 files, index empty. Existing admission/driver/probe gates and the post-validation preload stop remain closed.

## Remaining milestones

Successful native driver/admission integration remains untested. Next are reviewed concrete runtime/Guild selections and producer observations, final serialized requests/continuations, secure same-auditor native receipts/resume, approved independent review and separately authorized fresh restricted integration. Only then can the original comparison pair proceed. No host run, spending, dependency/version/runtime change, staging, commit or release occurred.
