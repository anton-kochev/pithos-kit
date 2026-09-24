# E1 admitted native configuration path

**Milestone 1 remains in progress.** The bridge now exposes a parent-only configuration callback backed by its live admission scope. The native constructor is implemented, but successful native issuance is still unreachable under the unchanged v2 admission gate. No native admission was fabricated, no real SDK/provider probe or host run occurred, and no spending was authorized.

## Configuration entry point

Campaign drivers receive an optional `prepareNativeLaunch(options)` callback. Direct `runTrial()` drivers do not receive it. The callback opens a fresh origin scope, checks the active driver window, deadlines and cancellation, and calls `prepareAdmittedNativeLaunch()` while the ledger lock is held for configuration preparation only. The window closes when the driver returns or throws; an escaped callback cannot be reused afterward. The lock is not held across the driver workflow.

`src/admitted-native-launch.ts` is parent-only. Its inputs select runtime inventory, Guild root, exact parent invocation and auth lease. It does **not** accept artifact directory, working directory, arm or pricing overrides:

- derive those values from the journal-backed trial input and frozen campaign;
- validate the exact parent command/argv/cwd/identity;
- bind the runtime requirement through the admitted-origin wrapper;
- retain campaign/history/admission/trial/invocation/runtime-requirement digests;
- check lease freshness and origin liveness around asynchronous writes;
- exclusively write `runtime-requirement.json` and `native-config.json`, retaining partial files on failure.

The private bank and rubric remain in the parent derivation, not either configuration file. The runtime requirement is the existing reduced inventory contract. Its digest is canonical-object correlation, not a new raw-file or loaded-module attestation. No process is launched by this constructor, and it does not dispose a lease owned by its caller.

## Auth cannot silently be recaptured

The shared configuration writer now accepts a previously observed `scopedAuthIdentity`. When present, it must match the current file before artifacts are created and after configuration writes. Changed bytes and equal-content inode replacement cannot be adopted as a new expected identity. The admitted constructor always supplies the lease identity and invokes its original freshness check; issued lease objects are now frozen against replacing their directory, identity or methods.

The legacy synthetic writer can still capture an identity when no expectation is supplied. That path is not admitted-native authority. Lease object freezing alone was not issuer authentication. The later [lease-origin check](e1-auth-lease-origin.md) now requires the exact live module-issued object and the admitted timeout/exclusion declarations. This is process-local provenance, not operator/provider authentication; final native driver and producer authority still require integration and review.

The optional `admissionBinding` configuration field has a closed scalar schema: version/kind, trial UUID, and six digest fields. The later [runtime loader](e1-runtime-input-loading.md) adds a seventh hash field, the raw-byte `runtimeRequirementSha256`, while preserving the canonical requirement digest. It requires an explicit auth expectation. Unknown fields, malformed hashes/IDs and explicitly undefined binding metadata fail before configuration creation. These serialized fields are correlations, not an unforgeable grant.

## Deliberately closed producer boundary

The current preload rejects any configuration containing `admissionBinding` **before SDK imports**. It must not silently interpret a campaign-bound configuration through its legacy synthetic path. The later [configuration reader](e1-native-config-reading.md) adds bounded stable-file reads and mandatory raw-byte digest correlation before this stop. The later [runtime input loader](e1-runtime-input-loading.md) also checks the retained sibling's byte/semantic/trial correlations before the unchanged stop. Complete schema/issuer binding, runtime/file observations and reconciliation remain integration work.

`createPiDriver()` still stops at the existing native gate before native setup. The later [driver hookup](e1-native-driver-configuration.md) adds the callback call behind that unchanged stop; successful native issuance/execution remains untested. There is no claim of successful native configuration issuance, producer execution, authentic transport credential use or native receipt/resume validation.

## Verification scope

Observed RED/GREEN cycles cover expected-auth replacement, retained binding metadata, malformed/unanchored metadata, missing admitted constructor, rejection before launch/auth input access, unsupported bound-config rejection at an inert import tripwire, immutable leases, and the bridge configuration window. The initial bridge RED surfaced as a failed receipt because the runner caught the missing callback assertion; the diagnostic rerun exposed `undefined` instead of `function`.

Positive configuration-writer fixtures contain synthetic digest metadata only; they are explicitly **not ledger-issued native admissions**. Real inert-v1 admission scopes test callback availability and rejection of inert-to-native conversion. The native constructor's successful write/freshness sequence has not been executed under an issued v2 origin. The import tripwire is a one-line local print-and-throw file, not SDK/provider code.

Disposable-copy sensitivity produced three expected failures:

| Copied mutation | RED diagnostic |
| --- | --- |
| Recapture instead of checking expected auth | Missing rejection after byte drift |
| Same mutation | Missing rejection after equal-content inode replacement |
| Omit closed binding validation | Missing rejection for malformed binding metadata |

The run had 246 tests with three expected copied-control failures. Both copies were removed by an exit trap; maintained controls were never weakened. Self-inspection is not independent review.

Final local checkpoint: **235 evaluator / 135 Guild / 2 root tests passed**, both typechecks passed, Bash and tracked/untracked whitespace checks passed, development-bank digest unchanged, seeded schedule generated without execution, dry-run package 39 files, index empty. Existing admission/driver/probe gates and the new bound-config preload stop were checked.

## Remaining path

Next: connect the native driver and producer loader to these requirements, establish reviewed concrete runtime/Guild configuration provenance, correlate parent/children and final serialized requests/continuations, then enforce the same secure audit in fresh native receipts and historical resume. Approved independent review and separately authorized fresh restricted integration still precede the original live comparison pair. Historical artifacts/checkpoints are not rewritten or promoted. No dependency, package-version, network/container/resource-limit, commit or release change is implied.
