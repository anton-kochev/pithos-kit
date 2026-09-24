# E1 scoped-auth file identity

**Status: filesystem observation, lease/invocation metadata and launch/prepared-request auth wiring implemented; native execution remains disabled.** All verification in this increment used synthetic credentials and inert executables. No real credentials, Pi/SDK/provider probe, host run or model trial was involved.

## Observation and recheck

`src/scoped-auth-identity.ts` operates only on an explicitly supplied transient auth file:

- `captureScopedAuth(file, remainingMs)` opens one descriptor with `O_NOFOLLOW | O_NONBLOCK`, reads at most the initial file size plus one byte, and rejects sizes above 1 MiB. It requires an owned, private, single-link regular file and an absolute, canonical path (at most 4096 UTF-8 bytes), with no symlink aliases.
- Metadata and bytes come from the same descriptor. Before/after descriptor stamps and the current path's metadata are compared, detecting ordinary replacement, same-size rewriting, growth or permission changes during the read. The descriptor is closed on every path.
- The copied store must contain only the closed access-only Codex OAuth entry, with empty refresh and consistent account/JWT/expiry fields. The copied expiry cannot exceed the JWT expiry. The requested remaining window must be an integer from zero to one hour; expiry must strictly exceed that window plus the existing six-minute reserve. Zero is the per-request case, not an invented workflow allowance.
- The frozen result contains a version/kind, lossless decimal device/inode strings, UID, exact-file-byte digest, account digest and expiry. It returns no token, raw account ID or path.
- `assertScopedAuth(file, expected, remainingMs)` rereads and matches the whole identity. Changed bytes—including whitespace—or an equal-content replacement inode fail.
- `assertScopedAuthAccess(file, expected, access)` additionally matches a supplied prepared access value against the freshly read store, with the six-minute per-request reserve. It returns identity metadata, not that access value. The native preload now calls it through `verifyNativePreparedAuth()`; actual producer/receipt binding and restricted integration verification remain unfinished.

Errors are fixed (`Scoped Codex authentication mismatch`) and do not echo file contents, paths or caller-supplied comparison diagnostics. This is structural JWT consistency, not signature verification, provider authentication, account entitlement or billing evidence.

## Lease and driver integration

`createCodexAuthLease()` still borrows only access/account/conservative expiry, never usable refresh or unrelated provider/settings values. It now snapshots caller options, captures identity after creating the private file, and exposes the frozen identity. Its existing `assertFresh()` checks both the original lifetime requirement and the current file identity immediately before driver launch. Caller mutation cannot shorten the original workflow reserve.

New Codex `invocation.json` records include `scopedAuthIdentity`. Inert parent/child executables independently read the actual temporary file and verify the recorded byte digest and device/inode/UID, on completion, failure and timeout. Tests also scan retained fixtures for token, refresh, raw account and source-path leakage. Cleanup and source preservation remain tested.

This metadata is an acquisition observation, followed by the pre-spawn recheck—not proof that a provider request used the credential. It is private identity/correlation data and must not be published without review. Transient credential files are still deleted on disposal; historical records are not backfilled, and resume must not retain or reconstruct credentials to manufacture missing evidence.

## Test-first evidence

Package command: `npm run eval:test`.

Observed RED/GREEN cycles cover capture API, strict store/JWT policy, exact freshness boundary, unsafe paths, mutation/replacement races, identity/access rechecks, lease identity, invocation metadata, immutable lifetime options and sanitized comparison failures.

One existing integration fixture advanced its clock after a fixed number of reads. The new acquisition snapshot exposed that assumption: it expired during creation rather than before spawn. The fixture now advances when its invocation record exists, preserving the intended pre-spawn check. The failed run is retained and is not counted as behavioral RED for the feature.

Sensitivity was verified only in disposable copies; maintained controls were never weakened:

| Controlled mutation | Test that went RED | Diagnostic |
| --- | --- | --- |
| Remove copied private-mode check | Unsafe-file rejection | Missing expected exception for mode 0644 |
| Remove copied driver's pre-spawn `assertFresh()` | Lifetime recheck after invocation recording | `incomplete_trace` instead of `driver_error`; inert CLI entered |

An exit trap removed all four copies, followed by maintained-suite verification. No real campaign, paid review, staging, commit, dependency/version change or isolation/resource-limit change was made.

Original local checkpoint: **180 evaluator / 135 Guild / 2 root tests passed**, both typechecks passed, Bash syntax/diff checks passed, the development-bank digest was unchanged, the seeded schedule generated without execution, and the dry-run package retained 39 files. The index remained empty. Self-inspection is not independent review.

## Launch and prepared-request wiring follow-up

`prepareNativeLaunch()` now snapshots caller inputs before asynchronous work, captures strict scoped identity before creating artifacts, records `scopedAuthIdentity` instead of the legacy numeric `authIdentity`, and rechecks the same file after configuration writes. The retained legacy `GUILD_EVAL_AUTH_DIGEST` is derived from that capture, not a separate unbound read. Drift fails without deleting partial launch evidence. These launch checks use the six-minute reserve only; they do not replace the lease's original workflow lifetime requirement.

For matching CLI invocations, the preload requires the configuration's digest to match that environment value and rechecks the full scoped identity before reading package metadata or importing SDK modules. Legacy configurations without scoped identity fail closed. Its prepared-request callback retains the session/runtime and stored-auth-source checks, then invokes `verifyNativePreparedAuth()` from `native-request.ts`. That helper checks fresh scoped identity and access, rejects alternative model/options headers and nonempty options environments, and sanitizes failures to `Native authentication policy mismatch`.

This is comparison at the prepared-request boundary, not proof of the credential ultimately sent over a transport. The configuration's trusted origin, relationship to the original lease/durable admission, actual parent/child observations, and receipt/resume checks remain unbound. No new auth identity event is claimed from an actual producer.

Observed RED/GREEN cycles cover missing launch identity, asynchronous input mutation, auth drift, prepared access/alternative inputs, and startup rejection before an import boundary. One RED intentionally reached a one-line **inert local import tripwire** that prints and throws; it contains no SDK/provider/network implementation. GREEN blocks it. Direct prepared-request tests use synthetic files and plain objects; the real SDK callback has not been exercised by this follow-up.

The future restricted harness now copies `scoped-auth-identity.ts` and constructs synthetic JWTs with matching integral expiry claims. Mock-Docker copy tests and a provider-free fixture-construction test pass. No fresh host run occurred, and earlier fixed runs/configurations/auth fixtures are not rewritten or promoted.

| Disposable copied mutation | Test that went RED | Diagnostic |
| --- | --- | --- |
| Move initial auth capture after asynchronous directory creation | Invalid auth before artifacts | Unexpected `native` directory |
| Same mutation | Auth drift during preparation | Missing expected rejection |

Both copies were removed by an exit trap; maintained controls were not weakened. Self-inspection is not independent review.

Follow-up checkpoint: **217 evaluator / 135 Guild / 2 root tests passed**, both typechecks passed, Bash and tracked/untracked whitespace checks passed, bank digest unchanged, seeded schedule generated without execution, dry-run package 39 files, index empty.

## Remaining boundary and limits

The later [admitted configuration path](e1-admitted-native-launch.md) passes the expected lease identity to the shared writer rather than permitting recapture, and issued lease objects are now frozen. Its bridge callback remains closed to inert/native conversion, and successful v2 preparation/producer integration has not been exercised. Legacy synthetic configuration capture remains a separate non-authoritative path. The later [lease-origin check](e1-auth-lease-origin.md) now ties admitted preparation to an exact live issued lease and its original timeout/exclusion declarations, with revocation before cleanup.

Follow-up: [bounded selected-file observations](./e1-native-file-observation.md) can compare filesystem bytes with explicit runtime/implementation expectations. They are not yet connected to native producers and do not establish reviewed selection or loaded-code identity.

The native policy/admission/driver/probe gates remain closed. Actual runtime/implementation fingerprint binding, trusted launch/config/producer correlation to this identity, actual prepared-request integration verification, serialized instructions and parent continuation, secure native receipts and resume re-audit are still required, followed by approved independent review and the original first-pair gate. Legacy fixed synthetic evidence was not upgraded or promoted by either increment.

These are cooperative filesystem snapshots, not hostile-code containment, continuous monitoring or tamper-proof attestation. Changes restored between observations or made after a check can escape detection. Canonical path/stat checks do not eliminate all filesystem races, and same-user code can read/copy credentials. Neither hashes nor cleanup provide universal redaction or secure erasure. The six-minute reserve does not guarantee provider behavior under clock shifts or escaped execution.
