# E1 runtime requirement and executable correlation

**Current candidate update:** [owner-authorized 0.87.0 contract migration](e1-runtime-0870.md) adds unreviewed/unadmitted policy V3 and runtime requirement v2. Immutable V1, historical candidate V2, requirement v1 and the checkpoint evidence below retain their 0.85.1 meaning. All execution gates remain closed; selected bytes, SDK/auth/provider compatibility and independent acceptance are not established.

**Status: input binding, runtime-file observation and bounded package-identity verification implemented; native execution remains disabled.** This increment used synthetic filesystem/process-property fixtures. It did not read the installed runtime or real procfs, load Pi/SDK/provider code, access real credentials, run a host container or execute a model trial.

## Keep the bank out of producer inputs

`src/native-runtime-observation.ts` separates two operations:

1. `bindNativeRuntimeRequirement(input, runtime)` runs the existing v2 trial-input checks and requires the runtime inventory digest to equal the campaign's frozen `bindings.runtimeDigest`.
2. `observeNativeRuntime(requirement)` validates that reduced requirement, observes its selected files, and compares the current Node executable identity.

Only the first operation receives `NativeTrialInput`, which includes the evaluator's bank and rubric. **Do not serialize that input into a producer configuration.** The frozen requirement contains only version/kind, trial ID, trial-binding digest, runtime digest and the closed runtime inventory. It contains no task, rubric, bank, credential or retention-directory value. This minimizes supplied data; it is not a confidentiality sandbox.

The requirement is labelled `native-runtime-input-requirement`, not approval or admission. Structural validation cannot establish who issued it. A fabricated but internally consistent requirement is not authenticated by these functions. The future bridge must derive it from the actual durable admission and trusted frozen inputs, bind its digest to the actual launch/configuration, and reconcile producer records against that expectation.

## Closed selected inventory

The inventory retains the historical `offline-runtime.ts` shape and raw-byte SHA-256 convention. It must declare exactly Node `v24.20.0` at `/usr/bin/node`, Linux/arm64, and Pi/pi-ai `0.85.1`, with the original ordered 13 paths:

| Selection | Purpose |
| --- | --- |
| Node executable | Executable bytes and kernel image identity |
| Pi package, CLI, CLI setup | Package/entry/setup selection |
| HTTP dispatcher | Selected transport initialization implementation |
| Model runtime, agent session | Selected request/session implementation |
| Resource loader, system prompt | Selected resource/prompt implementation |
| Auth storage | Selected authentication-storage implementation |
| pi-ai package, Codex API, Codex catalog | Selected provider/catalog implementation |

Missing, duplicated, reordered, expanded, relocated or malformed selections are rejected, even when a caller recomputes the campaign digest. No replacement runtime, automatic inventory refresh or hash conversion is provided. This is the already documented **selected-file roster**, not a transitive dependency closure or newly approved set of concrete runtime bytes.

The original checkpoint checked Pi/pi-ai version declarations only. The manifest follow-up below now independently checks names and versions in the selected package files. It still does not establish which SDK modules were loaded. Reviewed concrete hashes must come from the trusted runtime inventory workflow; matching caller-supplied hashes alone is not review or provenance.

## Filesystem and executable observation

The producer-side observer first validates and copies the complete requirement, before any filesystem access. It then:

- checks process-reported executable path, Node version, platform, architecture and bounded PID/PPID;
- requires the kernel `/proc/self/exe` link to equal the configured Node path, rejecting alternate/deleted paths;
- obtains the executable's device/inode through that fixed procfs link;
- calls [the bounded selected-file observer](./e1-native-file-observation.md) for all 13 expected files;
- verifies both package identities with bounded, byte/identity-correlated JSON reads as described below;
- repeats the process/executable observation and requires both observations to agree, with executable device/inode matching the observed Node file.

The frozen `native-runtime-file-observation` result carries the trial ID, requirement digest, process/executable observation, selected-file observation and verified `packages` identities. It does not record argv, task text, credentials or source-home paths. The configured public Node path and private PID/file identity metadata are included.

Errors are fixed: `Native runtime binding mismatch` or `Native runtime observation mismatch`. This comparison corroborates a Node image/file relationship when run at a trusted boundary; it does not attest loaded SDK modules, shared libraries, extensions, instrumentation origin, resource contents or provider behavior. The current tests simulate that boundary, rather than proving it in an actual Pi process.

## Verification

Observed RED/GREEN cycles cover the binding API, closed inventory, filesystem-observer integration, mismatched executable inode, executable recheck after file reads, and rejection of malformed/unbound requirements before I/O.

One initial fixture searched for the substring `prompt` and incorrectly matched the selected filename `system-prompt.js`. It was corrected to check JSON data keys; the failed run is retained and is not behavioral RED evidence.

Intentional pins were checked with disposable copies only:

| Copied control omitted | Test that went RED | Diagnostic |
| --- | --- | --- |
| Campaign runtime-digest equality | Frozen runtime binding | Missing expected binding rejection |
| Current process tuple comparison | Process drift | Missing expected rejection for `execPath` |
| Kernel executable path comparison | Alternate/deleted image paths | Missing expected observation rejection |
| Selected-file expected-hash comparison | Changed inert CLI bytes | Missing expected observation rejection |

All three copies were removed by an exit trap. Maintained controls were never weakened. The filesystem fixtures map every permitted runtime/procfs read to inert data or fail; no installed SDK or real kernel-image evidence was collected. Self-inspection is not independent review.

Original local checkpoint: **202 evaluator / 135 Guild / 2 root tests passed**, both typechecks passed, Bash syntax and whitespace checks passed, development-bank digest unchanged, seeded schedule generated without execution, dry-run package 39 files, index empty.

## Manifest verification follow-up

The observer no longer accepts a wrong actual package name/version merely because a caller supplies matching file hashes while declaring `0.85.1`. It now checks `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`, each at the frozen policy version, in their selected JSON files.

After the general file-hashing pass, each semantic JSON read is limited to **64 KiB plus one growth-detection byte**, with `O_NOFOLLOW | O_NONBLOCK`. This extra-read bound does not replace the generic hash-pass bounds. Descriptor device/inode/UID/mode/size must match the selected-file observation; before/after descriptor/path stamps and canonical paths must agree. Raw-byte SHA-256 must match that observation. Fatal UTF-8 decoding and JSON parsing occur without importing or executing package code. Descriptors close on success and failure.

Only frozen `{ id, name, version }` entries enter the new `packages` result array. Unrelated package fields are neither returned nor executed. Missing/malformed JSON, invalid UTF-8, wrong identities, oversized documents, equal-content replacement, changed bytes and during-read replacement are tested with inert files. These remain separate, non-atomic reads—not continuous monitoring or loaded-code attestation.

Observed RED/GREEN cycles demonstrated the missing actual-name/version check and the missing retained package identity result. New negative pins initially exposed fixture problems: raw-buffer setup writes were going through the runtime-read mock, and nested `openSync` mocks complicated restoration. Explicit inert-file setup writes and open-boundary hooks fixed the fixture; the failed run is retained, not counted as behavioral RED.

A second disposable-copy sensitivity run produced six expected failures:

| Copied mutation | Test that went RED | Diagnostic |
| --- | --- | --- |
| Nonfatal UTF-8 | Invalid byte in an otherwise valid package document | Missing expected rejection |
| Permit 65,537-byte documents | Exact document bound | Missing expected rejection |
| Omit inode comparison | Equal-content replacement before semantic open | Missing expected rejection |
| Omit byte-hash comparison | Same-size key-order rewrite before semantic open | Missing expected rejection |
| Omit during-read stamp checks | Replacement during semantic read | Missing expected rejection |
| Omit descriptor close | Invalid-JSON cleanup | Missing expected `EBADF` |

Both copies were removed by an exit trap; maintained controls were unchanged. Earlier records/checkpoints are not backfilled or promoted to package-identity verification.

Follow-up checkpoint: **210 evaluator / 135 Guild / 2 root tests passed**, both typechecks passed, Bash/whitespace checks passed, bank digest unchanged, seeded schedule generated without execution, dry-run package 39 files, index empty.

## Still closed

The later [admission-origin wrapper](./e1-admission-origin.md), `bindAdmittedNativeRuntimeRequirement()`, derives its parent inputs from the actual ledger scope. Native scopes remain disabled, so its successful native path has not been exercised. The original pure binder remains input correlation only. The later [admitted configuration constructor](e1-admitted-native-launch.md) now consumes the origin wrapper and would retain its reduced requirement, but successful native issuance, producer observation and native receipt execution remain gated/unverified.

The admitted parent constructor now imports the binder. Shared pure validators have since moved to `native-input-contracts.ts`, and the [producer loader](e1-runtime-input-loading.md) now validates retained requirements before its unchanged stop. No launched producer, preload, receipt, resume or host harness invokes this runtime observer yet. Existing fixed synthetic checkpoints and source inventories remain unchanged, not backfilled or promoted.

Next: trusted concrete inventory/configuration provenance, closed Guild implementation/resource selection, actual producer/launch/auth correlation, serialized instructions and continuation, and secure native receipt/resume integration. Fresh restricted integration and approved independent review remain required before live readiness. Filesystem observations are cooperative and non-atomic; they do not defeat hostile same-user code or replace namespace/transport/timeout controls, spending authorization or billing evidence.
