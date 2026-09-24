# E1 candidate runtime contract migration to 0.87.0

## Independent review finalization

The supplied independent reviewer verdict is **Approve, no findings**, scoped to the candidate runtime contract migration described here. This is a **reviewed candidate contract**, not policy admission, actual SDK/runtime compatibility certification or operational acceptance. `CANDIDATE_NATIVE_POLICY_V3` remains unadmitted; its policy bytes and all execution gates are unchanged. Broader policy/receipt acceptance and separately authorized source/integration evidence remain outstanding. No C1–C8 advancement.

## Authority and evidence

The owner explicitly authorized changing the **candidate evaluation runtime requirement**, not installing or upgrading Pi, Node, dependencies or any runtime. Current selection: Node `v24.20.0`, Linux arm64, Pi/pi-ai `0.87.0`. Model `openai-codex/gpt-6-astra`, high thinking, base pricing, auto transport, authentication contract, bank, schedule/arms, all time/spend/attempt and restricted-environment limits are unchanged.

Owner-supplied Mac Docker verification reports image `sha256:edcbed99a004b66c67c0dd1d3ea794d6c0a2e83da18be770aeddedeff534dbff`, Node `v24.20.0`, Linux arm64, uid 501, and package metadata `pi-coding-agent 0.87.0` / `pi-ai 0.87.0`. This is **supplied metadata**, not independently verified image provenance, selected-file hashes, executable/loaded-module evidence, source inventory, auth behavior or provider proof. No image digest or UID is silently made an attestation or hard-coded into cooperative file ownership checks.

No installed bundle, SDK/provider code, procfs, host or Docker probe/import was performed. Repository source inspection and synthetic fixtures only. Actual SDK 0.87.0 compatibility remains **unverified** without a reviewed source inventory and separately authorized integration.

## Explicit identity separation

The frozen `CANDIDATE_NATIVE_POLICY_V2` already identifies Pi/pi-ai 0.85.1. It stays **unreviewed/unadmitted and unchanged**, as does immutable `NATIVE_POLICY_V1`. Silently editing either would reinterpret old campaign and receipt identities.

| Policy | Runtime requirement version | Pi / pi-ai | Evidence schema |
| --- | --- | --- | --- |
| immutable native V1 | 1 | 0.85.1 | native-v1 |
| historical candidate V2 | 1 | 0.85.1 | candidate-native-v2 |
| current candidate V3 (contract reviewed; unadmitted) | 2 | 0.87.0 | candidate-native-v2 |

`CANDIDATE_NATIVE_POLICY_V3` changes only policy revision and both package versions. Evidence envelope/audit version 2 is retained: its shape has not changed, and its policy digest identifies the exact runtime contract. Campaign spec stays version 2. Requirement version 2 has the same closed fields as version 1 but a distinct runtime tuple; the ordered 13-file selected roster is retained as an **unverified candidate expectation**, not claimed to exist or provide adequate coverage in 0.87.0. Unknown versions and mixed tuples fail closed.

The one assembly freezes runtime against the campaign's explicit policy. The parent binder derives requirement revision from that policy; the fixed-sibling loader validates its declared revision. Runtime observation compares package bytes with that frozen tuple. Bound producer and composed runtime/meter auditing use the validated requirement, while the public historical native auditor remains fixed to 0.85.1. The existing receipt route requires the exact policy/requirement pairing. Both historical V2 and current V3 synthetic receipts can be derived diagnostically, but neither is admitted or accepted by settlement/history. Cross-policy reinterpretation fails, including passing an old requirement under V3. No new runner or fallback route was added.

`snapshotRuntime(input, policy)` supports an explicit candidate selection; omitted policy and the historical `--fingerprint` path still mean V1. No historical harness is automatically migrated. Driver comparison and prepared preload comparison follow selected runtime inputs, but all existing execution stops remain. In particular the **ordinary scoped-auth allowlist remains exactly 0.83.0 / 0.85.1**, not extended on the strength of supplied metadata; 0.87.0 still fails before credential acquisition. The candidate preload still stops after requirement reading and before runtime observation/import. Invocation/configuration field layouts and raw/canonical binding rules are unchanged.

New policy/runtime/requirement bytes imply new digests, as do changed implementation bytes. A future authorized campaign must explicitly freeze new selected bytes, policy, implementation and specification. Do not rewrite old specs, requirements, launches, receipts, digests, grades or archives, resume them with current bytes, or pool old and migrated outcomes as equivalent. Historical 0.85.1 evidence proves nothing about the new runtime.

## Static compatibility inventory and gaps

| Repository contract inspected | Remaining 0.87.0 evidence gap |
| --- | --- |
| `native-input-contracts.ts`, `offline-runtime.ts`: exact entry, setup, dispatcher, model/session, resources, prompt, auth, nested pi-ai API/catalog paths | No selected 0.87.0 source bytes or hashes reviewed; no transitive runtime/loader/library/config closure established |
| `native-preload.ts`, `native-session.ts`: AgentSession/ModelRuntime/buildSystemPrompt imports and session resource observations | Exports, lifecycle, context and tool semantics unverified |
| `native-request.ts`, `native-evidence.ts`: strict candidate body vocabulary, callbacks, final HTTP/WebSocket representation and continuation | Actual SDK shape/normalization/callback/transport behavior unverified; unsupported fields still reject |
| `response-observer.ts`, pricing/meter reconciliation | Returned model, required tier/cache fields, retries and provider metering remain unverified; requested model is not returned-model proof |
| `codex-auth.ts`, `pi-driver.ts`, scoped identity and lease ownership | Historical five-minute refresh review is not 0.87.0 evidence; six-minute reserve unchanged but not newly certified; no credential/provider probe |
| parent invocation and native configuration/requirement bindings | CLI flags, resource discovery, child inheritance and admitted launch not demonstrated on 0.87.0 |

No compatibility range, transport relaxation, source import or widened auth permission was introduced to make tests pass. Scoped independent migration review is complete; broader policy acceptance and separately authorized source/integration evidence remain blockers. C1–C8 do not advance.

## Verification and exact delta

Supplied implementation RED/GREEN evidence (not independently rerun during this documentation-only finalization):

- Policy/input tests: missing V3 export (`undefined` versus required policy) and `Native runtime input mismatch` for requirement v2, then 17 passed.
- Route tests: V3 assembly/binder accepted old 0.85.1 (`Missing expected exception`); V3 receipt stopped at policy validation, then 38 passed.
- Explicit snapshot test: `Unreviewed offline runtime` for candidate 0.87.0, then included in 97 passing focused checks.

Observer package-byte mismatch, migrated preload tripwire, old-auth refusal and historical controls are follow-up coverage, not separately claimed RED cycles. No control was weakened to manufacture a failure. Existing suite-generated inert driver copies remain historical wiring tests, not native issuance.

Commands from `pithos.guild/`:

```text
node --import tsx --test evaluation/test/native-policy.test.ts evaluation/test/native-runtime-input.test.ts
node --import tsx --test evaluation/test/{campaign-assembly,native-runtime-observation,trial-receipt}.test.ts
node --import tsx --test evaluation/test/offline-runtime.test.ts
node --import tsx --test evaluation/test/{offline-runtime,native-policy,native-runtime-input,native-runtime-observation,native-launch,campaign-assembly,trial-receipt,pi-driver-auth,pi-driver-config}.test.ts
npm run eval:test
npm run eval:typecheck
npm test
npm run typecheck
npm run eval -- validate
```

Root: `npm test`, `git diff --check`. Supplied results (tests and both typechecks not independently rerun): **97 focused / 403 evaluator / 136 Guild / 2 root passed**, both typechecks passed. Initial evaluator typecheck failed because snapshot return inference narrowed `nodeVersion` to a literal; an explicit inventory return type restored the input contract, and the check was rerun successfully. That compile failure is not behavioral RED. Logs use `/tmp/e1-runtime-*.log`, retained in the migration review archive. Bank digest remains `9254fe78fdf7580faf991b4936beec533a1327e54b4efa7f6ed9cffd87820f85`.

Changed repository paths, all under `pithos.guild/evaluation/`:

- `src/{native-policy,native-input-contracts,native-runtime-observation,offline-runtime,campaign-execution,native-evidence,trial-receipt,native-preload,pi-driver}.ts`
- `test/{native-policy,native-runtime-input,native-runtime-observation,offline-runtime,campaign-assembly,trial-receipt,native-launch,pi-driver-auth}.test.ts`
- `e1-runtime-0870.md`, `e1-completion-status.md`, `e1-native-policy.md`, `e1-runtime-input-loading.md`, `e1-native-runtime-observation.md`, `e1-native-driver-configuration.md`

The current `.pi/evaluation/e1-candidate-v2-independent-review-inputs.json` filename is retained for continuity, with exact predecessor bytes preserved separately and a unique deterministic migration archive. Refresh and self-verification are **not independent acceptance**. No runtime/dependency/package upgrade, gate opening, spending, host execution, staging or commit; unrelated mixed-tree work is preserved.

Documentation-only review finalization changes only this document, the leading completion checkpoint and local review artifacts. The current manifest is refreshed; its exact pre-review bytes are preserved in `.pi/evaluation/e1-candidate-v2-independent-review-inputs.pre-runtime-0870-reviewed.json`. The unique deterministic `.pi/evaluation/e1-runtime-migration-0870-reviewed.tar.gz` retains the review inputs and supplied logs; prior snapshots and archives remain unchanged. Verification is limited to raw-file/inventory/archive hashes, deterministic archive reproduction and diffs. No tests, typechecks, runtime/probes, host execution, dependency changes, spending, staging or commit.
