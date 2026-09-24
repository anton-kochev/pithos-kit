# E1 restricted integration procedure and authorization checklist

Status: **draft; not executable and not execution authorization**.


## Current connected V3 preparation handoff

`runTrial -> finalizeOwnedTrial -> superviseAuthorization -> inertGradingOwner ->
snapshotEvidence` now retains original-mode evidence after confirmed inert owner
cleanup. The unchanged shared `receiptFor -> deriveCampaignTrialReceipt ->
deriveNativeTrialReceipt` selects `auditRetainedFinalization` after the native
audits, producing repeatable inert receipts without Git/candidate execution.
The test-only issuer is unavailable outside Node test context and cannot register
caller-authored owners or receipts. It is not hostile-code authority. Operational
issuance remains unavailable; missing/invalid origins cannot use legacy grading.
All native campaign/admission/driver/preload/settlement/history, confined factories
and restricted preparation gates remain CLOSED. No runnable Mac command exists.

[The preparation record](trial-finalization-preparation.md) gives the exact
private retention contract, 57 focused / 446 evaluator / 136 Guild / 2 root tests,
both typechecks, unchanged bank and remaining owner/namespace, image/Git/runtime/
producer-roster, private-storage, isolated-exporter, host-adapter, diagnostic-auth,
SDK-fidelity and independent-review blockers. No C1–C8 promotion or operational
approval. V3 still selects Node 24.20.0/Linux arm64/Pi and pi-ai 0.87.0; V1/V2
remain historical and unchanged. No Docker/host/provider/SDK/procfs/installed-runtime
probes, dependencies, spending, staging or commits.

## Prior V3 finalization handoff (historical; superseded for inert connection only)

Runtime migration is independently approved **as a candidate contract only**: Node 24.20.0/Linux arm64/Pi and pi-ai 0.87.0, unadmitted V3. Supplied Mac image `sha256:edcbed99a004b66c67c0dd1d3ea794d6c0a2e83da18be770aeddedeff534dbff` and uid 501 are metadata, not selected-byte/source/runtime verification. Historical 0.85.1 roster/layout discussion below is not permission to select it for V3.

The current call path is `runCampaignNext -> runTrial(confined-required)` for V3, behind unchanged gates. Without an operational owner/exporter, finalization records pending and never invokes local grading or host Git on the candidate. It withholds the private task manifest. Shared `receiptFor -> deriveCampaignTrialReceipt -> deriveNativeTrialReceipt` audits retained V3 inputs and then refuses final snapshot derivation before host Git, for fresh and retained-result calls alike. No new campaign runner, operational override or Mac flag exists.

Before this can become the requested code-complete integration candidate, the maintained producer owner must issue an attempt-bound registration (producer identity, image, exchange, daemon/namespace provenance), retain ownership through confirmed destruction, and supply authoritative imported artifact evidence. An arbitrary PID/label/JSON registration cannot authorize import. The existing inert owner is not that issuer. A confined exporter must bind the original file kinds/content/modes and exact index/status/diff to that import and the trusted baseline; normalized copy permissions must not replace original modes, and raw index bytes must not be compared as though they were `ls-files --stage` output. No exporter or approved parsing contract is currently available. Missing evidence stays pending; no fabricated empty snapshot or copied pass field can close it.

**Mac script plan remains blocked; no commands supplied.** Do not reuse a historical synthetic mode or invent a finalization flag. The actual public producer roster, full image inventory, diagnostic auth provisioning, namespace binding, bounded host adapter, exporter and independent review must precede a real command sheet and separate execution authorization. This increment's tests exercise inert local runner/receipt rejection only, not owner termination, kernel isolation or admitted campaign traversal.

Current owned-preparation increment: `grading-owner.ts` constructs the fixed Docker command plan and owns a one-shot test lifecycle through the existing sequential comparator/transport. `grading-bootstrap.ts` is the public fixed process entry. No Docker subprocess adapter is installed: `confinedGradingOwner()` unconditionally stops, and no operational entry accepts callbacks or alternate commands. The historical local checker is not a fallback. The command objects were inspected only by authored inert fixtures.

**Host command sheet — NOT RUNNABLE.** The command template fixes network-none, UID/GID > 0, read-only root, cap-drop ALL, no-new-privileges, private IPC, init, 64 PIDs, 512 MiB, one CPU, restricted 64 MiB tmpfs, pull-never, RO `/harness/guild` and RW `/evidence`, and a fixed `/usr/bin/env -i … /usr/bin/node /harness/guild/grading-bootstrap.ts` entry. No real image, host UID/GID, mount roots, producer owner or approved source/runtime hashes have been selected. Test SHA-256 strings are explicitly synthetic and cannot be used as an image selection.

Before operational connection, review and implement:
- Complete immutable image configuration/runtime/loader/library roster. Current inert image-file validation permits only `/usr/bin/env` and `/usr/bin/node` executable commitments, **not a complete runnable image inventory**. It rejects arbitrary/private roster entries but cannot inspect image contents.
- Exact producer code roster and maintained attempt-to-owner registration; a Docker label is a correlation field, not self-authenticating authority. Only a trusted supervisor may select the producer ID, owner name, image and exchange mapping.
- A concrete trusted host command adapter with independent Docker daemon responses, bounded launch/cleanup and operator abort procedure. The test boundary cannot certify daemon provenance or descendant death. Existing five-second grading window includes preparation (4500 ms observation/preparation, 500 ms cleanup); no timeout extension is granted. The distinct synthetic/readiness/verifier contracts below are unchanged.
- Final snapshot/index/status/diff mapping for the existing grade/receipt path, without running host Git on candidate-controlled configuration. The new importer safely retains raw bytes after mock independent removal and checks grader-side mutation; it does not certify the pre/post baseline index or synthesize status/diff evidence.
- Separately specified diagnostic auth/tmpfs provisioning, followed by independent review and explicit restricted-host authorization. All native/operational gates remain closed.

The public source mount must contain **only** `grading-bootstrap.ts` and `grading-observer.ts`, with reviewed hashes; the entire evaluator tree, tests, bank, comparator, owner, private manifests and results are forbidden. A grader receives an independent copy, never the authoritative retained tree, producer exchange, or prior attempt. No grading output is returned to a producing agent. Filesystem safety assumes supervisor-owned parents and no concurrent hostile host/mount writer after owner destruction. Same-UID permissions and Node pathname checks are not kernel isolation.

The user subsequently authorized a minimal maintained entry and supervisor lifecycle implementation with inert fixtures, not gate changes, host runs, provider access, spending, staging or commits. The latest independent review approved the bounded confidentiality corrections only. Native acceptance remains outstanding. This procedure implements the next steps in `e1-completion-status.md`; it does not supersede its C1–C8 acceptance conditions.

## 1. Freeze and authorize preparation

Before requesting host approval, resolve and record:

- [ ] Exact working-tree source/test/config inventory and raw hashes, including the operator entry and all subsequent changes. HEAD alone is insufficient in this mixed tree.
- [ ] Immutable pre-provisioned image identity and selected runtime: Node 24.20.0, Linux arm64, Pi/pi-ai 0.85.1, closed 13-file runtime requirement and Guild fingerprint roster. The reviewer's Bun upgrade is unrelated to native runtime approval.
- [x] Supervisor module lifecycle in `src/restricted-integration.ts`: explicit `createCampaign()`, then `assembleNativeCampaign()`, `inspectSelection()` and `runNext()`/`runCampaignNext()`. Inert fixtures only; current CLI still validates/schedules only.
- [ ] Operational entry preparation: `prepareRestrictedIntegration()` unconditionally rejects before reading inputs or writing files. No caller flag bypasses the isolation stop.
- [ ] Exact copied-input roster preserving `/harness/guild/{package.json,package-lock.json,agents/,extensions/,src/,evaluation/src/}` and existing campaign/trial layout beneath `/evidence/<campaign>/`.
- [ ] Supervisor-only bank/rubric provisioning, provenance, lifetime and cleanup under the two-mount restriction. Do not mount the whole checkout or Pi home; do not serialize `NativeTrialInput` or pass rubric/grader/delegation inputs to producers. Same-UID permissions are not hostile-code isolation.
- [ ] Diagnostic auth/transport fixtures using the genuine scoped-lease lifecycle. No real credentials or external requests for restricted integration.
- [ ] Reviewed candidate policy/receipt contract and supported SDK request schema. The narrow schema's actual SDK compatibility is unverified; unknown fields must fail closed rather than be stripped.
- [ ] Independent review of the complete integration delta. Confidentiality approval is not approval of policy, gate replacements or operational acceptance.

### Supervisor input boundary: implemented versus blocked

`supervisorCampaign(selection)` is the maintained in-process lifecycle, not a host launcher or provisioning channel. A trusted supervisor supplies an already-materialized bank (including rubric/grader/delegation) directly in memory. It snapshots and validates those inputs, never loads a bank path or serializes `NativeTrialInput`, and exposes only explicit creation, selection inspection, one next-attempt call and disposal. Creation writes the existing public digest/spec journal only; assembly receives private supervisor inputs, not a producer configuration. No driver/observer/configuration callback override is introduced. Native admission rejects before credentials or producers. Inspection must precede `runNext()`; failure/cancellation during an operation revokes the lifecycle, and `runNext()` always releases its owned references. Dispose is idempotent. Retained campaign/partial evidence is not deleted. This is reference release, **not heap zeroization or erasure of caller copies**; active I/O unwinds normally. No credential lease is issued at this checkpoint.

The only permitted future mount layout remains RO `/harness/guild` (exact code roster, no task bank/private rubric) and RW `/evidence` (campaign artifacts). Neither mount provides supervisor-only storage from same-UID producers. Mode 0600/0700, hidden paths, deleting a file after loading, or a third mount are not an acceptable privacy solution. Do not provision bank/rubric or credentials into either shared tree or environment/argv to make this entry runnable. Actual private-input delivery, provenance, cross-process access isolation and credential fixture placement remain **unimplemented and blocked pending independent isolation review**. An in-memory snapshot alone cannot certify confidentiality against hostile same-UID code. `prepareRestrictedIntegration()` therefore rejects even a plausible selection, without inspecting it; the lifecycle API is fixture/component evidence, not operational permission.

### Gate-change implementation approval (separate from lifecycle implementation)

Request permission for a concrete, narrow implementation delta before modifying operational gates. Load-bearing locations, identified by symbol/behavior rather than mutable line numbers:

| File under `evaluation/src/` | Required review |
| --- | --- |
| `campaign.ts` | Native availability/admission stop; candidate receipt settlement rejection; nonempty v2 history rejection |
| `campaign-execution.ts` | Single assembly/runner and shared fresh/resume `receiptFor()` contract |
| `pi-driver.ts` | Early stop before credentials and admitted preparation |
| `native-preload.ts` | Bound candidate stop before runtime observation and SDK imports |
| `admitted-native-launch.ts` | Genuine admission/lease preparation and launch transaction |
| `trial-receipt.ts` | Mandatory native audit and trusted expectations for fresh and historical receipts |

Do not simply delete stops or add arbitrary model-controlled bypass options. Pending native journal traversal must be supported coherently before actual preparation; accepted settlements/history require the reviewed receipt contract. No copied source, fabricated origins, stubbed configuration callbacks or legacy probe route may certify integration.

## 2. Restricted host execution procedure

**No runnable command exists for this maintained-path checkpoint yet.** `offline-docker.sh` and its existing synthetic modes are historical diagnostics, not the required execution entry. A command using an invented new flag would be misleading.

The implementation handoff must supply a fully expanded, independently reviewed command sheet before host authorization. Until then:

```text
NOT EXECUTABLE — supervisor lifecycle exists; operational preparation blocked.
Reviewed private-input isolation/provenance, image identity, case roster,
artifact location and watchdog mapping remain pending.
```

Required host policy: network-none; non-root; read-only root; zero capabilities; no-new-privileges; exactly two bind mounts (read-only code, writable evidence); 512 MiB; 64-task PID limit; preserve existing one-CPU and restricted tmpfs settings. No pull, build, install, dependency upgrade or runtime substitution is implied.

Preserve existing fixed timeout contracts: 2-second socket checks, 10-second verifier child, 20-second readiness watchdog, existing 45/60-second synthetic watchdogs where applicable. Explicitly review the new maintained-mode watchdog mapping rather than silently reusing or extending it. Workflow ceiling remains five minutes. Document an operator abort procedure for Docker daemon operations; do not assume they have a portable bounded timeout.

### Host authorization checklist

- [ ] Owner approves exact inventory, image, command sheet, gate replacement scope and diagnostic cases.
- [ ] Operator identifies restricted host, artifact directory, time window and abort owner.
- [ ] No provider access, real credential placement or spending is authorized.
- [ ] Evidence access/retention and cleanup responsibilities are explicit.
- [ ] Every unresolved item above is resolved; otherwise no-go.

### Ordered execution and expected evidence

1. Verify supplied hashes and host/image policy without invoking a producer; mismatch means no startup.
2. Explicitly create the diagnostic campaign and inspect selection through the maintained assembly.
3. Exercise real admission, durable launch preparation, config/lease, supervisor and parent/child observations.
4. Derive the mandatory receipt from retained evidence. If settlement remains gated at this stage, record a blocked checkpoint—not successful settlement.
5. Only after separately reviewed and authorized settlement/history support, settle, close/reopen and re-audit through the same receipt route.
6. Run negative cases on separately identified diagnostic evidence/campaign copies; preserve original successes and failures. Never mutate historical evidence in place or call corrupted copies original observations.
7. Verify owned process/container termination and lease cleanup; retain final state and sanitized operator outcome.

| Positive case | Required rejection case |
| --- | --- |
| Main-only admission | Changed config, invocation or committed launch prefix |
| Guild available, abstaining | Unexpected child or wrong tool ceiling |
| Labeled diagnostic serialized read-only/writer children | Overlap, recursion, UUID/PID/role/task mismatch, incorrect forwarded result |
| Launch commitment before spawn | Failed append, cancellation, duplicate preparation, supervisor-file collision |
| Supported request/response flow | Unknown schema fields, credential disclosure, changed continuation, unsupported framing, missing model/tier/cache/usage |
| Fresh receipt and resumed re-audit | Missing, altered, extra, unsafe, duplicated or reordered evidence; auditor/implementation drift |
| Durable first-pair pause and limits | Next admission without inspection; exhausted limits; unknown spend/time |
| Owned cleanup | Timeout, interruption or uncertain cleanup never yields fabricated success |

Forced delegation is diagnostic only, never imposed on comparison trials. Offline fixtures establish maintained-path behavior, not real provider metadata or billing.

### Stop, rollback and evidence

Stop on policy/runtime/layout drift, unsupported SDK shape, missing meters, privacy failure, unknown cost/time, integrity failure, timeout or uncertain cleanup. Kill only owned resources through the reviewed cleanup path and dispose the lease. Retain partial files, interrupted admissions and failed artifacts. No orphan repair, replacement attempt, fake zero cost or synthetic settlement.

Withdrawal means disabling the newly authorized operational entry/gates through the reviewed rollback patch, not resetting the mixed tree. Preserve unrelated edits and historical evidence.

Retain input hashes, image/runtime selection, host policy checks, journal/admission/preparation, supervisor/producer evidence, request/response meters, raw-byte receipt inventory, fresh/resume results, each negative-case outcome and cleanup state. Raw content remains private; publish sanitized summaries only. Cooperative hashes/PIDs are correlation, not loaded-code attestation or operator authority.

**Exit for C1–C6 consideration:** independent review of changes and restricted evidence, operator outcome signoff, and explicit acceptance mapping. Passing unit tests alone is insufficient. Reassess feasibility at the first integrated checkpoint; stop rather than expand the framework if private provisioning or SDK fidelity cannot meet the contract.

## 3. Separately authorize first provider pair

After technical readiness acceptance, request a separate provider-connected disposable environment and scoped credential authorization. Never turn the network-none harness into a connected run implicitly.

Freeze the original schedule, Node/Pi runtime, `openai-codex/gpt-6-astra`, high reasoning, base tier, auto transport and pricing contract. Run only the original first scheduled baseline/Guild pair. Missing entitlement, returned model, tier or usage stops the attempt with retained evidence; do not substitute models or invent costs. Paid readiness probes require separate approval.

Ceiling: **12 total attempts, $10 provider-priced estimated usage, 60 active minutes, five-minute workflows**. This is not a guaranteed billing cap or authorization for development/review spending. Count all attempts according to the frozen ledger contract.

Inspect first-pair correctness/preservation, privacy, reliability, latency and parent-plus-child usage/cost. Document owner inspection and explicit continuation authorization before any remaining admission; do not restart the campaign to bypass failures or budgets.

## 4. Remaining trials and provisional decision

Continue only remaining permitted trials while limits and inspection gates allow. Complete arm-blinded human judgments separately from technical receipt acceptance. Report all attempts and exclusions, correctness/preservation, failures, reliability, latency and estimated parent-plus-child costs. Keep unknown context effects unknown and distinguish estimated cost from actual billing.

Map each result to C1–C8 and issue provisional adoption, further bounded work, rejection or an inconclusive decision. Six development tasks do not establish general statistical superiority. No holdouts, new arms, Phase 2, release or commit authority follows from this procedure.
