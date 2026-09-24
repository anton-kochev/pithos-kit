# E1 native trial and parent invocation input binding

**Status: provider-free input checks implemented. Native admission remains disabled.** These checks correlate supplied inputs; they do not prove an admitted or executed process, observed runtime/auth identity, serialized provider instructions, or a native campaign receipt.

## Runner identity and immutable handoff

`DriverContext` now requires `trialIdentity: { version: 1, id, requestDigest }`. `runTrial()` supplies a frozen identity containing its reserved/generated UUID and original full-request digest. The driver receives a separate request copy, so driver mutation cannot rewrite the runner's retained task manifest, grading inputs or result identity.

`createPiDriver()` snapshots request/identity before asynchronous preflight. After existing runtime/native-mode guards and before implementation capture or credential acquisition, it rejects missing, extra, array-shaped, changed or wrong-directory identity. Newly recorded `invocation.json` includes that identity. The generic directory check matches the artifact directory's basename to the UUID; it is not a complete campaign-location or filesystem-provenance check.

An inert executable test verifies identity retention and unchanged launch arguments during caller mutation. Other inert tests verify rejection before CLI entry, invocation recording or transient agent creation. These executables import no Pi/provider; they are not new model trials. Historical invocation files are not changed or backfilled, and the current ordinary receipt checker does not certify these new fields as native evidence.

## Native campaign input checks

`src/native-trial-binding.ts` provides:

- `bindNativeTrial(input)`: requires a valid [v2 native specification](./e1-native-policy.md), the exact frozen development bank, a structurally valid admission snapshot, runner identity, the exact scheduled request, and canonical bounded retention paths. It compares the entire request—including task, arm, repetition, cohort and workflow timeout—against the bank/schedule; recalculating a digest for a changed prompt cannot bypass that comparison.
- `bindNativeParentInvocation(input, guildRoot, actual)`: additionally compares the supplied parent command/argv/cwd/identity against the fixed reviewed Node/Pi entry paths, observer import, resource/trust flags, arm-specific Guild extension/tools, model/thinking, separator and exact task bytes. Extra fields, extra flags, removed resource guards and changed instructions are rejected, not normalized away.

Admission snapshots contain only the durable fields (`id`, `slot`, `scheduled`, `allowanceMs`, `activeAllowanceMs`), not a handle's remaining-time callbacks. The checker validates their structure and consistency with the supplied specification, **not that the ledger actually issued them**. The future bridge must obtain that snapshot from its admitted ledger state, bind the approved campaign directory, and enforce live remaining-time signals. The request retains the frozen workflow timeout; a shorter active allowance is enforced separately by the existing deadline controller, not by these pure functions.

Results are frozen, explicitly labelled **input bindings**, containing the trial UUID and digests of the complete specification/admission/request/location or invocation. They contain no task text or literal retention paths. The specification digest transitively covers policy, prices, and declared runtime/implementation digests; it does not independently observe or authenticate them. Error messages are fixed and do not echo supplied input.

Paths are lexically canonical and bounded to 4096 UTF-8 bytes. This performs no filesystem reads, symlink resolution, source fingerprinting, auth inspection or process launch. The invocation comparison covers selected launch inputs, not the environment, actual process argv, `NODE_OPTIONS`, native preload configuration or SDK/provider payload. Stable path strings and matching hashes are not tamper-proof provenance, universal redaction or authorization.

## Test-first evidence

`npm run eval:test` drove missing runner identity, driver request mutation, missing binding API, changed requests with recomputed hashes, native-policy/bank mismatch, cross-trial identity/path rejection, exact invocation matching, invocation identity retention, malformed driver identity and asynchronous request snapshots through observed RED/GREEN cycles. The UTF-8 path-bound test went RED because an oversized otherwise-consistent location was accepted, then GREEN after byte-based validation.

Both natural arms use inert in-memory admission fixtures: **the tests do not enable v2 admission to manufacture evidence**. Fixed synthetic CLI acceptance and all native campaign/connected-probe guards remain unchanged. No host run, SDK/provider probe, real credential read, paid review, staging or commit occurred in this increment.

Final local checkpoint: **171 evaluator / 135 Guild / 2 root tests passed**, both typechecks passed, Bash syntax/diff checks passed, the development-bank digest was unchanged, the seeded schedule generated without execution, and the dry-run package retained 39 files. The index remained empty; self-inspection is not independent review.

## Remaining boundary

The new pure binding checks are not yet invoked by the disabled native driver/receipt path. A later [ledger-backed origin builder](./e1-admission-origin.md) can now derive parent inputs from a live admitting handle rather than supplied admission/specification objects; native origin issuance and actual launch integration remain disabled/pending. [Scoped-auth file identity](./e1-scoped-auth-identity.md) is now observed and rechecked by the lease/driver, but is not yet bound to native producers or receipts. Next: bind these expectations to actual launch/producer observations, reviewed runtime and implementation bytes, and that scoped authentication identity; then bind serialized request instructions and parent continuation/tool-result forwarding. Secure retained native reads, fresh receipt derivation and historical resume re-audit remain required, followed by approved independent review and the original live first-pair gate. No historical record is promoted by having matching input digests.
