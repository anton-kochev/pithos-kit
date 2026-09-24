# E1 native driver configuration handoff

**Current candidate update:** [owner-authorized 0.87.0 contract migration](e1-runtime-0870.md) adds unreviewed/unadmitted policy V3 and runtime requirement v2. Immutable V1, historical candidate V2, requirement v1 and the checkpoint evidence below retain their 0.85.1 meaning. All execution gates remain closed; selected bytes, SDK/auth/provider compatibility and independent acceptance are not established.

**Milestone 1 remains incomplete.** `createPiDriver()` now contains the actual admitted-configuration callback hookup. Its maintained native stop remains before credential acquisition and callback entry, so this is not successful native admission or execution evidence.

## Driver path

The driver snapshots its options at construction, including nested runtime/auth options. `nativeRuntime` requires native observation mode; supplying it cannot silently select an unobserved workflow. After the existing stop, the native branch requires both that inventory and the bridge-supplied callback before fingerprinting or borrowing auth.

After building the real parent argv, it calls `prepareNativeLaunch` with:

- a runtime inventory copy and selected Guild root;
- the original issued auth lease, not a structural clone;
- a snapshot of the exact versioned parent invocation and trial identity.

The request bank/rubric is not passed to this callback. Callback mutation of its invocation copy cannot change the eventual argv. The admitted constructor remains responsible for journal-derived checks, original lease scope and runtime binding.

The returned environment is copied and must contain exactly four fields: the expected package preload import, the expected trial configuration path, a lowercase raw-byte configuration SHA256, and the original lease's auth-file digest. Missing responses, extra environment keys, altered preload/config paths or mismatched hashes fail before invocation recording or spawn. This is handoff validation, not independent certification of the configuration contents or issuer.

The same owned snapshot is retained as `invocation.json.nativeEnvironment` and forwarded to the child environment. Existing post-setup cancellation/freshness checks and `finally` disposal remain; preparation failure, disposed leases or cancellation cannot reach spawn. The ordinary legacy path does not acquire a native environment.

## What was actually tested

The maintained driver's reviewed-native stop was exercised against an inert package manifest: no callback, auth setup or spawn occurred. Its stop remains unchanged in source.

To test downstream wiring without opening that maintained gate, `pi-driver-config.test.ts` generates a temporary copy from the current driver source. It requires the exact stop to be present, replaces that stop **only in the generated copy** with a guard for the fixture's exact cwd/CLI/synthetic credential paths, and resolves relative imports back to the original local modules. Spawn is replaced at Node's process boundary with an emitter having no PID. Neither the CLI nor preload executes; both fixture entry files throw if accidentally executed. The copy and fixture files are removed in `finally`, and built-in exports are restored.

This is a wiring test double—not a campaign, issued native admission, actual native configuration, producer run, runtime observation or SDK/provider probe. Its callback is a double returning input-only environment metadata. It does exercise genuine synthetic lease acquisition and exact original scope lookup, argv/runtime copying, environment forwarding/retention, callback errors, lease disposal, cancellation and missing prerequisites. No native-origin capability is fabricated or substituted.

RED first showed zero callback calls. Additional REDs showed missing/extra/incorrect configuration responses reaching the mocked spawn and a runtime inventory silently selecting an unobserved mode. GREEN closes those cases. Existing cleanup/cancellation behaviors were then pinned through the same isolated wiring fixture; all retained evidence remains unit-test evidence, not live-readiness evidence. Self-inspection is not independent review.

Final local checkpoint: **279 evaluator / 135 Guild / 2 root tests passed**, both typechecks passed, Bash and tracked/untracked whitespace checks passed, bank digest unchanged, schedule generation only, dry-run package 39 files, index empty. No generated driver fixture directories remained after validation.

## Remaining work

The callback is now wired, but its successful use under an actual v2 origin remains blocked and unexecuted. Reviewed concrete runtime/Guild selection and producer observations, final serialized request/continuation binding, secure same-auditor native receipts/resume, approved independent review and separately authorized fresh restricted integration remain pending. The configuration preload still stops after input validation and before runtime/SDK execution.

No host/provider/installed-runtime/procfs probe, evaluation spending, dependency/runtime/resource-limit/version change, staging, commit or release occurred. Historical attempts and checkpoints were not rewritten or promoted.
