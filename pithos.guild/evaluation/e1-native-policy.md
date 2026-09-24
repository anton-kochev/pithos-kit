# E1 frozen native campaign policy

**Current candidate update:** [owner-authorized 0.87.0 contract migration](e1-runtime-0870.md) adds unreviewed/unadmitted policy V3 and runtime requirement v2. Immutable V1, historical candidate V2, requirement v1 and the checkpoint evidence below retain their 0.85.1 meaning. All execution gates remain closed; selected bytes, SDK/auth/provider compatibility and independent acceptance are not established.

**Status: contract and fail-closed gates implemented; native admission remains disabled.** This is evaluation schema work, not a package release/version change, actual campaign creation, execution attestation or approval to spend.

## Two explicit specification formats

- **Campaign spec v1:** historical/non-native-evidence format, with its existing optional pricing field. Existing records are not rewritten or promoted. The existing inert test/driver workflows remain compatible.
- **Campaign spec v2:** requires both `nativePolicy` and explicit base `pricing`, in addition to the existing bindings, schedule and limits. Missing, null, undefined, unsupported or extra fields are rejected before creating the campaign directory. There is no default policy or automatic conversion from v1.

`src/native-policy.ts` defines the closed, immutable `NATIVE_POLICY_V1` requirement set:

| Field | Required value |
| --- | --- |
| `version` | `1` |
| `node` | `v24.20.0` |
| `pi`, `piAi` | `0.85.1` |
| `model` | `openai-codex/gpt-6-astra` |
| `api` | `openai-codex-responses` |
| `thinking` | `high` |
| `serviceTier` | `base` |
| `transport` | `auto` |
| `authentication` | `scoped-codex-access-only` |
| `evidence` | `native-v1` |

These values identify requirements, not observed facts or tunable user configuration. Future reviewed changes need a new policy revision, not silent edits to v1. Auto transport can produce observed SSE or WebSocket requests; it is not a networking guarantee. The evidence identifier does not certify that the current producer records supply every required launch/auth/continuation binding.

Campaign bindings must agree with the policy's model/thinking; pricing must agree with its model/API and pass the existing strict base-pricing validator. Actual reviewed rates are supplied and frozen separately, not inferred from the policy identifier. Existing runtime, implementation, bank, schedule and policy digests remain part of the frozen specification. The entire v2 specification—including policy and prices—is persisted and compared on reopen and every transaction. Changing bindings, prices or supported format cannot bypass that comparison; dropping required fields cannot downgrade it to v1. Caller mutation does not change an opened handle's cloned specification.

## Disabled until execution binding exists

A valid v2 specification may be created and reopened for inspection, but `admit()`, `finish()` and `inspectFirstPair()` reject it. Nonempty v2 execution history is unsupported and rejected even if its journal checksums are internally consistent. The existing receipt format is not treated as native evidence.

The reviewed native cohort cannot be newly created through v1. Historical v1 records for that cohort remain inspectable, but their admission, settlement and inspection writes are blocked. Changing an existing v2 specification to v1 also fails the frozen-spec comparison. Other v1 workflows are not thereby granted native attestation or authorization for a different cohort.

`runCampaignNext()` checks the same disabled gate before calling its observation or driver callbacks or consuming a slot. This closes a partial-integration hazard: recognizing `nativePolicy` must not let the old bridge ignore it and issue an ordinary non-native receipt. Tests exercise both v2 and legacy-native entry attempts and confirm zero callbacks and zero admissions. A fresh inert Node process can reopen the v2 specification but still cannot admit.

The separate native Pi-driver guard and old connected-probe guard remain intact. These library guards are cooperative controls, not a hostile-code or authorization boundary against callers invoking unrelated APIs, lower-level storage, direct provider calls or another campaign directory. No active/native campaign directory was created during this increment; all campaign creation in tests used disposable fixtures.

## Test-first verification

Package command: `npm run eval:test`.

- RED/GREEN: native specification creation, direct/bridge admission gates, legacy-cohort downgrade prevention and legacy-ledger write prevention.
- Rejection cases: missing/unknown policy fields, unsupported revisions/runtime/auth/transport/evidence, mismatched cohort/API/pricing, changed or removed frozen inputs; rejected creations leave no directory.
- Compatibility: existing v1 tests continue to pass; old native records remain unchanged and inspectable without being upgraded.
- An approval pin compares the policy against an explicit independently written requirement table. A temporary copied policy/test verified its sensitivity; the maintained policy and active guards were never changed.

| Controlled mutation | Test that went red | Diagnostic |
| --- | --- | --- |
| Copied policy changes Node to `v24.19.0` | `npm run eval:test`: reviewed-policy pin | Actual `v24.19.0`, expected `v24.20.0` |

The exit trap removed both sensitivity copies; the maintained suite is rerun after cleanup. No SDK/provider probes, runtime patches, dependency changes, paid review, staging or commits are part of this increment.

## Next boundary

[Trial identity and exact parent-invocation input binding](./e1-native-trial-binding.md) are now implemented and tested without enabling native admission. Actual launch/producer provenance binding remains required, including reviewed runtime/implementation, scoped auth identity, actual context and serialized parent continuation. Then securely load and digest native files and invoke the [general native audit](./e1-native-evidence.md) in both fresh receipts and historical resume. Those are not implemented by accepting this specification. Native admission/driver gates must remain closed until that integration, negative verification and approved independent review are complete; the original live first-pair gate still follows.
