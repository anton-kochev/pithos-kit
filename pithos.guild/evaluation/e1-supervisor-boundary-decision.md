# E1 supervisor/producer boundary — proposed decision

Status: **contract-revision direction approved for grading/auth feasibility and inert tests only; operational preparation remains no-go**.

This records static architecture exploration authorized after the restricted supervisor lifecycle review. It authorizes no host/provider execution, native gate opening, runtime/dependency change, spending or commit. The lifecycle delta was independently approved; the owner approved starting the grading/auth feasibility slice, not transport integration. This proposed topology has not been independently approved or demonstrated on a host.

## Decision proposed to the owner

Keep the bank-owning supervisor outside a disposable producer container. Keep `assembleNativeCampaign()` → `runCampaignNext()` as the sole campaign route, placing the fixed container launch transport beneath the maintained driver. Use one fresh container per attempt and a narrowly defined owned channel carrying only public producer inputs.

Do not implement this as a transparent Docker substitution. It changes native process identity, storage/path mapping, selection provenance and scoped-auth provisioning. If the original direct-supervisor ancestry requirement must remain unchanged, this topology is incompatible and E1 must remain blocked.

## Static findings requiring a boundary, not another helper

- `src/restricted-integration.ts` releases detached in-memory references but cannot isolate a same-UID producer or erase heap bytes.
- `src/pi-driver.ts` directly spawns the producer. The committed supervisor PID, actual child PID and parent PPID currently describe one namespace and direct ancestry.
- `src/runner.ts` retains a full task manifest. Sharing a campaign evidence tree with later producers risks revealing prior private task data.
- The driver fingerprint includes `evaluation/src`; `bank.ts` and `grading.ts` contain reference/hidden evaluation material. Excluding the task bank JSON alone is insufficient.
- `src/grading.ts` executes candidate-written JavaScript. Moving the supervisor outside must not move that untrusted execution into the supervisor's protection domain.
- Private evidence/configuration ownership checks assume the current UID. Different host/container ownership cannot be accepted by silently weakening those checks.

These are source-level concerns, not confirmed host exploits. The code mount and pre-provisioned image both need reviewed producer-readable inventories.

## Proposed ownership

### Outside supervisor

Own private bank/rubric/grader/delegation inputs, admission/origin, lease ownership, authoritative journal/results, receipt derivation and resumed audit. Keep those inputs and retained authoritative evidence outside both producer mounts.

Do not import candidate modules, run candidate tests on the supervisor host, honor candidate-selected executable paths or interpret producer output as commands. Static grading may remain here; dynamic grading requires the separate unresolved boundary below.

### Producer container

Preserve network-none, non-root, read-only root, zero capabilities, no-new-privileges, 512 MiB, 64 tasks, existing CPU/tmpfs/timeouts and exactly two mounts:

- RO `/harness/guild`: explicitly reviewed producer-only code roster.
- RW `/evidence`: an attempt-specific exchange/work tree, **not** the authoritative campaign store.

This changes the previously proposed layout; it needs explicit approval. Do not mount prior attempts, journals, private task manifests, reference answers or grading output. The producer runtime remains Node 24.20.0/Linux arm64/Pi and pi-ai 0.85.1. The reviewer's Bun upgrade does not revise it.

### Public launch channel

Construct a closed runtime-validated projection: public prompt/workspace input, necessary approved launch options, opaque trial/runtime/configuration commitments and producer-visible paths. Never serialize `NativeTrialInput`, the full trial task/request/context, bank, callback, origin or lease object. Decide whether small-private-input digest disclosure is acceptable; hashes are not a confidentiality mechanism.

Use fixed bounded framing and one owned endpoint per admission/container. Reject unknown fields, replay/duplicate frames, oversized input, malformed encoding and unexpected EOF. No general RPC, host file access or producer-selected resource operations. Do not inherit private provisioning descriptors into launch clients/containers. Attachment supplies transport, not identity attestation.

## Required contract revisions and unresolved items

| Contract | Required explicit decision |
| --- | --- |
| Process identity | Distinguish outside supervisor, owned container, local launcher and container-local parent/child PIDs. Docker-client PID is not Pi PID; container-local PPID is not host supervisor PID. State provenance and cooperative-attestation limits. |
| Runtime selection | Outside filesystem inspection cannot establish selected container bytes. Define approved immutable-image/input provenance and observation reconciliation while preserving the 13-file producer inventory. |
| Storage | Separate host-private retained paths from producer paths; commit launch before releasing executable input. Import bounded untrusted artifacts only after confirmed termination. Reject path escapes, links/special files and mutation; use supervisor-owned retained copies for fresh/resumed audit. |
| Scoped auth | Define diagnostic-only transient provisioning with genuine lease lifetime/cleanup. A host lease path is not container-reachable. No reconstructed lease object, real credentials or third mount. |
| Dynamic grading | Keep candidate execution outside supervisor protection. Existing same-process module/checker arrangement is insufficient for strict hidden-grader privacy. Define observable public inputs/results with private judgments outside, or stop if the grader cannot be separated without changing the evaluation contract. |
| Cleanup | Killing a Docker client does not prove container death. Define container ownership, bounded abort, descendants, uncertain outcomes and retained pending admissions. |

None of these decisions may be hidden behind a generic launcher callback or a caller-provided “approved” boolean.

## Rejected shortcuts

Same-UID chmod/hidden directories, deletion after reading, producer-reported PIDs treated as host captures, source-rewritten stops, fabricated origins, third mounts, host PID sharing and the historical synthetic runner do not meet this contract.

An in-container UID split is not a transparent alternative: a non-root zero-capability process cannot normally switch to an arbitrary UID. Root, setuid helpers or added capabilities conflict with the envelope; host-mediated launch/user-namespace alternatives change ancestry and require separate review. File ownership, groups, readable sources and inherited handles still need analysis.

## Bounded next work, if contract revision is approved

1. Resolve grading and diagnostic lease feasibility first; do not build the container transport while either makes the design impossible.
2. Amend the process/storage/provenance contract and freeze a producer-readable roster without reference/grading material.
3. Drive public projection, channel framing and authoritative import contracts using inert fixtures. Test private sentinels in keys/values/files, cross-attempt exposure, replay/overflow, launch-before-commit, forged evidence, PID namespace confusion, termination uncertainty and same-contract resume.
4. Connect only beneath the maintained driver; no second campaign runner. Keep operational stops until independent review and separate gate-change authorization.
5. Present a concrete host command sheet and isolation negative cases for separate owner execution approval. Unit tests cannot certify kernel isolation.

Retain failures and original evidence. Do not change native-v1 or declare the unreviewed candidate policy operational. Do not create a general sandbox/RPC framework or expand to Phase 2.

## Owner decision requested

The owner approved this **contract-revision direction**, initially limited to resolving grading/auth feasibility and specifying revised contracts with inert tests. The unresolved decisions below require further owner direction. This is materially broader than the completed lifecycle wrapper. It is not authorization to implement all transport machinery, open gates, run Docker/providers, alter resource limits, spend, stage or commit.

If the fixed constraints cannot support these boundaries, report E1 as blocked/inconclusive rather than weaken privacy or claim native acceptance.

## Grading/auth feasibility checkpoint (static source plus inert files)

**Recommendation: stop before transport integration.** No production extraction is justified yet: a public projection cannot preserve the current hidden dynamic checker contract, and copying diagnostic auth cannot transfer the existing lease. This is a no-go for the unchanged contracts, not proof that every separately approved isolation architecture is impossible.

### Actual grading exposures

- `manifest.ts` closes task fields and distinguishes `unchanged` from `authorization`. `runner.ts::runTrial` omits rubric/grader/delegation from `request.json` but passes the full detached request to its trusted in-process driver and writes `task-manifest.json` after grading. These are not producer-channel contracts. The private task manifest and `result.json` (including grading diagnostics) must never inhabit a later attempt's readable exchange. Hashing the full request does not conceal small guessable private inputs.
- `bank.ts::referenceFixes` contains two reference implementations; `grading.ts::authorizationChecks` contains exact cases and assertions. Both are in the current `evaluation/src` fingerprint/layout. Excluding only `tasks/development.json` leaves these disclosures. A reviewed producer-only roster remains missing.
- `gradeOutcome` performs static snapshot/scope/index checks; `unchanged` executes no candidate module and leaves prose review pending. The authorization branch invokes `runNodeCheck`, which spawns Node with the checker on stdin, imports candidate `src/users.mjs` **in that same checker process**, and appends a completion marker. A subprocess is not an isolation boundary from the host supervisor's protection domain. The maintained `runTrial -> gradeOutcome` route must not run this branch on the outside host.
- This checker does not receive the whole rubric/delegation object. It does receive hidden case data and judgments in executable source. Candidate code receives actor/target/name and a `store.save` callback whose source includes private assertions; it can observe those arguments/callbacks and shares process globals with the checker. The persistence-error identity check also relies on same-process object identity. Bounded stdout, timeouts, pre/post snapshots and an unpredictable completion marker do not make the checker secret or its process trustworthy.
- Moving this exact checker into a producer container only moves the disclosure. Sending a closed list of calls and returning outcomes could keep expected judgments outside, but the case inputs then become public to candidate execution; local callback behavior, error identity, exception outcomes and side effects need an explicit observation contract. It cannot claim strict hidden-case/grader privacy or unchanged evaluation semantics merely by splitting JSON. No such public invocation API was added unused.

**Required owner choice:** either accept an explicitly revised grading contract with public stimuli and private external judgments (including changed error/side-effect observation semantics), authorize a separately reviewed grading protection boundary, or retain strict current hidden-grader privacy and mark dynamic E1 grading blocked/inconclusive. Static grading alone cannot silently replace the authorization tasks or certify task success.

### Genuine diagnostic auth: locally feasible, transfer blocked

`codex-auth.ts::createCodexAuthLease` already accepts structurally valid synthetic OAuth-shaped bytes without verifying provider signatures. Inert diagnostic source files can therefore exercise the genuine issuer with no new factory, fake lease or SDK. The original frozen object is registered in a process-local WeakMap. Lookup checks the exact original timeout and ordered forbidden-root list, rechecks freshness, and disposal revokes before filesystem removal (including cleanup failure). This is genuine local lease lifecycle, **not genuine provider authentication**.

The issuer requires private, bounded, single-link, current-UID files, absolute paths and realpath-based retention exclusions. Effective expiry is the lesser of source/JWT expiry and must exceed the full trial window plus six minutes; refresh material is discarded. `admitted-native-launch.ts` requires the original lease with exclusions for trial parent, retention root, workspace and Guild root. `scoped-auth-identity.ts` binds device/inode/UID, bytes, account and expiry; `native-launch.ts` rechecks that file. The driver owns disposal in `finally`. Existing tests cover scope/lifetime changes and cleanup failure.

The new inert test demonstrates that copying identical synthetic auth bytes produces a different file identity, a reconstructed object is not issued, and disposal of the original does **not** delete the copy. A host lease directory is not container-reachable with the proposed mounts. Putting it under code/evidence/workspace violates exclusions; a third mount is forbidden. Streaming bytes into container tmpfs creates another file and cleanup owner, not the existing observed lease. Reissuing inside the container changes issuer scope/trust and still leaves the host admission expecting its own original object. No rehydration, equality relaxation or new diagnostic bypass was implemented.

**Required owner choice:** retain existing local-file/issuer semantics and remain blocked, or explicitly authorize a diagnostic provisioning contract that binds host issuance to container-local file observation, bounded lifetime and verified termination/cleanup of all copies. It must not treat synthetic credentials as provider authentication or a Docker-client PID as the producer. Current direct supervisor-parent ancestry (`native-evidence.ts`) remains unchanged and incompatible with transparent container substitution.

### Inert verification and limits

Only `test/supervisor-auth-feasibility.test.ts` was added; production sources, gates, native-v1 and runtime/dependencies are unchanged. Test-first work here is an intentional existing-contract pin, not new production behavior:

| Controlled fixture mutation | Focused test | RED diagnostic |
| --- | --- | --- |
| Observe the original auth file instead of the independently copied file | `diagnostic auth copying cannot transfer a genuine lease or its cleanup ownership` | `identical bytes must not transfer leased file identity` (`notDeepStrictEqual`) |

The mutation was confined to the new test, then restored to observe `copied`; the identical command passed. No source-rewritten gate or candidate module was used in this fixture. It proves local file/issuer behavior only, not namespace isolation, container cleanup or admission feasibility.

Commands from `pithos.guild`: `node --import tsx --test evaluation/test/supervisor-auth-feasibility.test.ts` (RED, then GREEN: 1); `npm run eval:typecheck`; `npm run eval:test` (346 passed); `npm test` (136 passed); `npm run typecheck`. From root: `npm test` (2 passed), `git diff --check` (passed). Full suite logs: `/tmp/e1-feasibility-eval.log`, `/tmp/e1-feasibility-guild.log`. Existing suites include inert subprocess fixtures, not an authorized host/SDK/provider/procfs/installed-runtime probe. No Docker, spending, staging, commits or gate edits. No C1–C8 acceptance promotion. Subsequent independent read-only review approved this bounded feasibility work, not operational readiness; supplied tests were not independently rerun.

## Specified next contract: public grading and diagnostic auth transport

Status: **proposed specification, not implemented**. The owner authorized specification of these boundaries. No transport integration, operational gate change or execution follows. Native-v1, the existing lease issuer and current direct-ancestry audits remain unchanged.

### Public grading: visibility, timing and records

Lifecycle: `producing → termination-confirmed → artifacts-retained → grading → private-result`.

Confirm the producing container and descendants have terminated before importing bounded stable artifacts into supervisor-owned retention. Reject links, special files, escapes and mutations. Candidate code runs only in a separately owned disposable grading environment, never in the private supervisor's protection domain. Its provisioning remains unresolved under the existing resource/two-mount envelope.

Stimuli are public to grading-time candidate execution, not hidden cases. Private expected outcomes, bank/reference fixes, rubric and delegation judgments stay outside. No grading feedback or artifacts return to the producing agent or later attempts. Producer-readable inventories must exclude private evaluation source and prior results, not merely bank JSON.

Closed proposed stimulus fields:

`version: 1, kind: "e1-public-authorization-diagnostic", attemptId, gradingRunId, artifactDigest, cases`

Each case: `caseId, actor, targetId, name, saveBehavior`. Preserve the existing six ordered actor/target cases followed by the persistence-error case, including absent versus typed `admin` values. `saveBehavior` is `{kind: "return", value: "saved"}` or `{kind: "throw", errorLabel: "persistence"}`. No allowed flag, expected count/result, rubric or private-input digest. Only public-record commitments cross the boundary.

Closed observation fields:

`version, kind, attemptId, gradingRunId, artifactDigest, observerDigest, cases, completion`

Each observed case: `caseId, saveCalls, settlement, sameThrownObject`. Save calls record the first two arguments as tagged strings or `other`, without serializing arbitrary objects or invoking getters/stringifiers. Settlement distinguishes fulfilled string (with value), fulfilled other, rejection, synchronous throw and unsettled. `sameThrownObject` is a local comparison boolean only for the persistence case and null otherwise. Completion distinguishes complete, cancelled, timeout, overflow and observer error. There is no producer-supplied pass field.

Proposed diagnostic bounds: seven cases, at most 64 save observations per case, one request/terminal observation per grading run, 64 KiB per record and combined stdout/stderr, five seconds total matching the current dynamic checker window. Unknown fields, malformed encoding, replay, missing/duplicate cases, wrong commitments or overflow yield inconclusive—not success. These are specification bounds, not implemented protocol guarantees.

### Grading equivalence and trust: explicit acceptance blocker

Private comparison must preserve successful return `saved`, required save counts/arguments, denied-call rejection with zero saves, and persistence rejection with the same callback-thrown error object. Preserve scope/index/pre-post snapshot checks separately; unchanged tasks remain static checks with prose review pending and `taskSuccess: null`.

Do not add a persistence save-count requirement absent from the original checker, or require exact argument-list length when the callback checks only its first two arguments. Preserve differing synchronous-throw behavior in the existing `assert.rejects` invocation forms.

The existing callback asserts arguments and throws **during** save. Recording a wrong call and returning normally changes candidate-observable behavior; candidate code can catch that assertion. JSON labels/messages cannot establish error-object identity. A same-process observer can compare references and record callback behavior, but candidate code shares that observer's protection domain: these remain cooperative diagnostics, not hostile correctness attestation. Endpoint ownership or a completion marker does not change that.

Therefore this proposal does **not** replace the authorization grader. Equivalent semantics without disclosing private judgments remain unproven. Before implementation, either demonstrate that equivalence in the reviewed grading boundary, or obtain an explicit evaluation-contract amendment defining the changed semantics and consequences for comparison. Until then dynamic grading remains blocked/inconclusive; no automatic grade promotion.

### Diagnostic auth: separate transport authorization, not lease transfer

Keep the original live `CodexAuthLease` in the host issuer's process-local registry. Neither identical bytes nor serialized lease fields transfer its identity or authority. Proposed separate discriminator: `version: 1, kind: "e1-diagnostic-auth-transport"`.

Host-private binding fields:

`version, kind, authorizationId, attemptId, admissionDigest, launchCommitment, ownerId, containerId, imageDigest, endpointId, timeoutMs, deadlineMs, hostIdentity, expectedContainerPath`

Owner-created UUIDs identify authorizations/endpoints; container identity follows the reviewed runtime's native identifier, never an invented PID alias. Digests use existing validation. `hostIdentity` is the original scoped identity; the live lease reference and exact ordered forbidden roots remain host-only. A serialized binding is correlation metadata, not authority. Require the original live registry entry, matching admission/container/endpoint and unchanged lease scope/freshness before releasing bytes. Inert tests cannot fabricate an admission to bypass closed issuance.

Only fixture-generated synthetic OAuth-shaped data is permitted here: no real source credentials, refresh material, provider validation or SDK access. It is not provider authentication.

Receiver provisioning must create one private auth file in a fixed reviewed container tmpfs location, outside both mounts. The exact location and owned provisioning mechanism remain unresolved. No auth bytes in argv, environment, code/evidence mounts, retained logs or a third mount.

Container observation fields:

`version, kind, authorizationId, containerId, endpointId, namespaceId, path, identity, source`

Source is explicitly cooperative container observation unless stronger independently supported provenance is approved. Require equal file/account digests and expiry to host-issued bytes, but not equal device/inode/UID across namespaces. Pin the independently captured container-local identity thereafter; equal-byte replacement still fails. This is a new binding, not relaxation of either existing identity checker.

Preserve existing auth bounds: file 1 MiB, access string 64 KiB, account ID 256 characters, normalized absolute path 4096 bytes, lease timeout 1–3,600,000 ms and effective expiry beyond the required window plus six minutes. E1's narrower five-minute workflow ceiling still applies. Provisioning cannot extend the admission deadline; recheck freshness before release and launch.

### Auth state, cleanup and process identity

Proposed states:

`prepared → bound → committed → provisioned → observed → running → revoking → cleanup-pending → closed`

Durable launch commitment precedes executable input/auth release. Failure after preparation enters revocation/cleanup; do not reuse an authorization/container for retry. Host ownership outlives launchers, producers, descendants and provisioning buffers.

Inventory all authorized materializations: synthetic source, host lease file, transit buffers and container file. Cleanup acknowledgment fields:

`version, kind, authorizationId, containerId, materializationId, location, action, outcome, evidenceSource`

Actions: deleted, released, container-destroyed. Outcomes: confirmed or uncertain. Closing requires inventory reconciliation, closed endpoints, host disposal and independently owned container termination/destruction evidence. Container self-reported deletion alone is insufficient. Host deletion failure still revokes the original lease as today. Buffer release does not prove heap erasure; destruction is not proof that arbitrary undiscovered copies never existed.

Missing acknowledgments, unknown copies, owner loss, timeout or uncertain destruction leave cleanup pending, block acceptance/further dispatch and retain non-secret failure evidence. No automatic successful resume. Cleanup must fit a reviewed existing watchdog mapping; no new timeout is authorized by this specification.

Distinguish host supervisor/launcher PIDs, owner-bound container/image identity and container-local parent/child PIDs/PPIDs tagged with namespace and observation source. Cross-namespace PID equality has no meaning; launcher PID is not Pi PID. Existing direct-ancestry audits remain unchanged and cannot accept this as a transparent substitution.

### Inert acceptance-test handoff and remaining no-go

Before any production transport work, drive:

1. Closed projection rejecting private sentinels in keys/values/paths and producer-readable inventories; no prior-attempt access.
2. Grading ordering, no-feedback and immutable-import requirements.
3. All original case semantics, especially callback exception timing, synchronous throws and same-error identity; do not call non-equivalent observations grades.
4. Rejection of forged pass fields, replay, malformed/oversized records and incomplete runs.
5. Original lease scope/freshness/revocation, reconstruction rejection, equal-byte replacement and bound authorization lifetime.
6. Host/container identity separation and PID-substitution rejection.
7. Failure at every provisioning/cleanup transition; owner loss and uncertain cleanup never become success.
8. Unchanged native-v1/current lease/gate behavior and one fresh/resume receipt route.

These are future tests, not executed checks. No schema/state-machine implementation was added for this documentation increment. Isolation, equivalent grading, container/runtime provenance, private image/code roster, tmpfs provisioning, owned termination and all-copy accounting remain prerequisites. Inert tests cannot certify kernel isolation or hostile-code correctness. Resolve grading equivalence first rather than build an unused transport framework.

## Historical pre-amendment inert grading-equivalence experiment — delayed comparison counterexample

**Historical verdict (old grader, before the authorized amendment below): the specified non-asserting public callbacks plus delayed private comparison are not equivalent to that grader. Stop before transport.** Owner authorization for this slice covered locally authored inert tests only. No production grader, auth, gate, runtime, dependency or transport change was made.

`test/supervisor-grading-equivalence.test.ts` runs the actual `gradeOutcome` against eight locally authored inert module variants and a test-only delayed-comparison model using `runNodeCheck`. The model collects all seven invocations before comparing; it preserves the two rejection invocation shapes and compares persistence identity locally. It is not a schema, transport, isolated observer or hostile-code attestation. It contains expected judgments in the test process and makes no privacy claim.

### Explicit recoverable counterexample

The module uses the correct authorization guard, then:

```js
try { return store.save(target, 'Wrong'); }
catch (error) {
  if (error.code === 'ERR_ASSERTION') return 'saved';
  throw error;
}
```

The exported function is async. On each allowed ordinary case, the existing callback increments `saves` to one, then throws on the wrong name. The module catches that assertion and returns `saved`. The outer checker sees the required return and one save, so it passes. Denials reject without saving. The persistence callback has no argument assertions: it throws its own error, which the module rethrows unchanged, satisfying identity. **Actual current behavior: true; delayed comparison: false.** The delayed callback returns `saved` without throwing, and private comparison later rejects the recorded wrong name.

An uncaught `return store.save(target, 'Wrong')` variant has the same calls, settlements and same-error identity under these non-asserting callbacks, but fails the existing checker. These records alone therefore do not distinguish this pair's original grades. This is a bounded counterexample to the proposed delayed observation contract, not a mathematical impossibility claim for all designs or a proof against a separately reviewed interactive boundary.

The initially suggested catch-and-correct-call variant is a **negative control**, not the counterexample: retrying with `store.save(target, name)` after the assertion produces two counted saves and fails the current checker. It also fails delayed comparison (the initial wrong call returns normally, so no retry occurs). Counter increments precede argument assertions; ignoring that order would manufacture a false equivalence claim. Catch-and-return is the recoverable scenario, not catch-and-retry.

### Other exact semantics observed

| Inert behavior | Current | Delayed model |
| --- | --- | --- |
| Catch assertion, return `saved`, rethrow persistence error | pass | fail |
| Wrong call without catch | fail | fail |
| Catch assertion then correct/retry call | fail | fail |
| Synchronous denial; authorized save inside promise continuation | pass | pass |
| Synchronous denial; authorized save evaluated before `Promise.resolve` | fail | fail |
| Async save, rethrow same error object | pass | pass |
| Async save, throw distinct `new Error(error.message)` | fail | fail |
| Extra save argument; retry persistence save after catching first error | pass | pass |

Denials use `assert.rejects(async () => updateUser(...))`: synchronous throws become rejections. Persistence uses `assert.rejects(() => updateUser(...), e => e === error)`: a synchronous throw does not satisfy that assertion, even for the identical error. Async promise rejection with the identical object passes; same-message distinct objects fail. The persistence callback does not check arguments or save counts. Ordinary callbacks inspect only the first two arguments. The model intentionally adds neither argument-arity nor persistence-count requirements. A serialized error label/message cannot substitute for reference identity; the local boolean remains only cooperative observation, not trustworthy hostile attestation.

### RED/GREEN and verification

Intentional characterization/experiment, not production TDD. Focused command from `pithos.guild`: `node --import tsx --test evaluation/test/supervisor-grading-equivalence.test.ts`.

| Experiment / controlled fixture mutation | Observed RED |
| --- | --- |
| Initial equivalence hypothesis expected `{current:true, deferred:true}` for the catching module | actual `{current:true, deferred:false}` |
| After characterizing divergence, change only the new inert module's assertion catch from returning `saved` to rethrowing | actual `current:false`, expected `current:true`; deferred remained false |

Restoring the catch fixture yielded **4/4 GREEN** with the identical focused command. Other matrix entries are follow-up characterization coverage, not separately claimed RED cycles. Initial fixture setup incorrectly reused an existing mkdtemp directory (`EEXIST`); it was corrected to a child fixture directory before the behavioral RED and is not counted as evidence.

Final checks: `npm run eval:typecheck`; `npm run eval:test` (**350 passed**); `npm test` (**136 passed**); `npm run typecheck` in Guild. Root `npm test` (**2 passed**) and `git diff --check` passed. Logs: `/tmp/e1-grading-{setup-failure,red,controlled-red,green,eval,guild}.log`. Existing suites use inert Node subprocess fixtures; no user/untrusted candidate output, provider/SDK/installed-runtime/procfs/host/container probes, Docker, spending, staging or commits were run. The existing 35-file review inventory verified before refresh; prior manifests/archives are preserved. The new deterministic review archive is `.pi/evaluation/e1-grading-equivalence-review-followup.tar.gz`.

**Recommended owner choice:** explicitly amend the evaluation contract to public stimuli and delayed judgments if that changed grading behavior is acceptable, with versioned comparability consequences and separate review before implementation. Otherwise keep dynamic E1 blocked/inconclusive or authorize investigation of a different grading protection boundary that preserves callback timing without claiming secret judgments are absent. Do not silently fix the grader's catchable assertions, retry behavior, invocation shapes or identity rule in this slice. Diagnostic-auth provisioning, isolation, provenance, owned termination and independent review remain unresolved. All operational gates remain closed; no C1–C8 promotion.


## Authorized save-validation amendment — implementation, not transport approval

The owner explicitly authorized rejecting swallowed save-argument assertion failures. This supersedes only the old grader's recoverability above, not the historical observations or the blocked transport decision. The unchanged counterexample now yields **current false / delayed false**. The historical table and RED/GREEN logs above describe the old implementation, not current behavior.

For each ordinary authorization case, `saves` still increments before validating ID then name. Either validation failure latches `invalidSave` and immediately rethrows the original assertion object. After candidate settlement and the existing count check, the checker requires the latch to be false. Catching the assertion and returning `saved` cannot clear it; retrying cannot clear it or undo the count. No callback timing, extra-argument rule, denial invocation shape or persistence callback changed. Denial still wraps synchronous throws asynchronously; persistence still requires asynchronous rejection with the identical error object, with no new persistence count/argument requirement. Read-only grading is unchanged.

### Identity and comparability

Old `grading.ts` raw SHA-256: `d0413c2a03e774157d0f37f2abb40efe3cf2702d96200a489fc47489e844e4d0`.
Amended raw SHA-256: `8e7c3ead2eefbaf2237ade267c7098655619d3585fb5e4d9a0623a93d9cd75e3`.

No new package, bank, native policy or receipt schema version is needed for this bounded amendment: `pi-driver.ts:fingerprint()` already includes every `evaluation/src` file, including the grader. Its file identities are **canonical digest of the base64 string**, not the raw SHA-256 used by the review manifest. The canonical digest of that implementation map binds invocation and campaign `implementationDigest`; native launch/receipt also bind that identity. `campaign-execution.ts` checks the frozen observation before historical receipt interpretation and again before admission/settlement; the driver checks implementation drift after execution. These mechanisms detect changed selected bytes; they do not retroactively certify standalone artifacts lacking an authenticated/frozen implementation selection.

The receipt audit uses retained grade/results and their digests, not a rerun of dynamic grading. Therefore prior grades, receipts and aggregates must remain labeled with their original grader identity and cannot be silently regraded, rebased to the new implementation, or pooled as comparable amended outcomes. Invalidate their eligibility for amended-semantic comparison/resume under the changed selection; retain the original evidence, manifests, logs and archives. Any future re-evaluation requires explicit authorization, separately identified results and a newly frozen implementation/campaign, retaining links to original evidence and reporting the comparability break. No prior receipt/journal/bank is edited here. The frozen development bank digest, runtime selection and both native policies remain immutable; no release is made.

### Verification and limits

The exact existing catch-and-return candidate was retained. Changing only its expected current verdict to false gave behavioral RED: actual `{current:true,deferred:false}`. The latch then gave GREEN with the identical focused command. Follow-up coverage checks both bad ID and bad name, observing the immediate assertion in candidate catch output and a final failing verdict. Existing catch/retry, denial sync/async, same-object/distinct-object persistence, extra arguments and repeated persistence calls remain covered.

Commands from Guild: `node --import tsx --test evaluation/test/supervisor-grading-equivalence.test.ts` (RED, then 4 GREEN); `node --import tsx --test evaluation/test/grading.test.ts evaluation/test/supervisor-grading-equivalence.test.ts` (10 passed); `npm run eval:test` (351 passed); `npm run eval:typecheck`; `npm test` (136 passed); `npm run typecheck`; `npm run eval -- validate`. Root: `npm test` (2 passed), `git diff --check`. Both typechecks passed; bank digest remains `9254fe78fdf7580faf991b4936beec533a1327e54b4efa7f6ed9cffd87820f85`. Logs: `/tmp/e1-amend-*.log`, copied into the amendment archive.

This removes one demonstrated divergence; it proves neither global delayed-grader equivalence nor isolation. Immediate callback throws remain observable to arbitrary candidate JavaScript. Delayed observations, same-error identity across a boundary, private-input isolation/provenance, diagnostic-auth provisioning, owned termination and independent review remain unresolved. All native admission/preload/driver/history/settlement gates and operational preparation stay closed; no C1–C8 promotion. Only locally authored inert candidates were executed. No host/provider/SDK/procfs/installed-runtime probes, Docker, dependency/runtime changes, spending, staging or commits occurred.

## Bounded grading effort: continuation disclosure checkpoint

The approved plan `2026-09-20-153627-plan-8237153e-47d2-4c70-b3e0-07a270fd67c1.md` authorizes steps 1–4, not operational execution. **Public stimuli and immediate callback behavior are now explicitly approved.** The earlier strict callback-secrecy objection is resolved, not a reason to stop this effort. The public contract includes the six ordered actor/target/name inputs, return `saved`, immediate ID-then-name assertions with count-before-assert and permanent invalid-save latch, and the persistence error callback. It does not include bank/reference fixes, rubric, unrelated private inputs or final expected judgments. Same-error identity remains a cooperative local reference comparison, not serialized identity or hostile-code-proof evidence. Extra arguments remain permitted; persistence gains no argument/count rule.

**A further exact-semantic decision is needed before implementing the proposed collect-all observer.** Current `authorizationChecks` does not merely compare after each call: an unsuccessful private judgment terminates the checker before subsequent candidate invocations. Public callback behavior alone cannot reproduce that continuation decision. For example, a candidate can call `save(target, name)` exactly once and return `wrong-return` on the first invocation, then write a file on every subsequent invocation. The amended checker fails its private return assertion immediately; the later file is never written. A collect-all observer with the same immediate asserting callbacks and latch still invokes the later cases and writes the file before private comparison rejects. The measured result is:

| Route | Behavior passed | Changed checker paths |
| --- | --- | --- |
| Amended maintained grader | false | `[]` (`checkerMutated: false`) |
| Test-only asserting callback / deferred judgment model | false | `["later-case.txt"]` |

This is **not** a demonstrated verdict divergence, nor proof that every interactive architecture is impossible. It disproves full invocation/side-effect equivalence of the specified fixed seven-call, terminal-record-only model even after callback disclosure is approved. Keeping the final pre/post snapshot check does not make those executions equivalent. Arbitrary candidates can also observe invocation history. No claim of global delayed equivalence is warranted.

Smallest concrete choice (recommend the first if exact execution semantics are required):

1. Explicitly permit a supervisor-derived **continue/stop bit after each ordinary case** to the disposable grader, as an additional grading-time disclosure of judgment progress, never to the producing agent or later attempts. Keep expected values/rubric/reference inputs supervisor-only. This revises the one-request/one-terminal-record, all-seven-cases observation contract to bounded sequential observations. Owned terminal cleanup is still required; this is not permission for generic RPC or container execution.
2. Explicitly accept fixed seven-case invocation despite earlier failure, including changed invocation history and side-effect diagnostics, as another versioned semantic amendment. Preserve the existing snapshot checks but do not label the resulting execution globally equivalent.

Locally embedding the continuation predicates would place private expected judgments in candidate-readable code; that is not covered merely by permission to reveal callback behavior. Silently sending private case pass/fail decisions back would likewise be an unrecorded disclosure exception. This checkpoint therefore stops at plan step 1 rather than adding an unused adapter/framework or silently selecting either amendment. Steps 2–4's connected implementation, protocol/limit/cancellation tests and disposable-boundary preparation are **not delivered**. This is a narrow contract blocker for the terminal-only design, not a claim that host availability makes software preparation impossible.

### New evidence and validation

`test/supervisor-grading-equivalence.test.ts` adds one locally authored inert candidate and a test-only delayed model which preserves immediate assertions/latch. An equivalence-hypothesis RED expected identical changed paths and observed `['later-case.txt']` versus `[]`. The final characterization pins this difference; GREEN is not a production fix or a new behavioral TDD implementation. Existing amended callback/count/denial/identity/arity tests remain unchanged.

Commands actually run from Guild:
- `node --import tsx --test evaluation/test/supervisor-grading-equivalence.test.ts` — hypothesis RED, 4 pass / 1 fail.
- `node --import tsx --test evaluation/test/grading.test.ts evaluation/test/supervisor-grading-equivalence.test.ts` — 11 pass.
- `npm run eval:test` — 352 pass.
- `npm run eval:typecheck` — pass.
- `npm test` — 136 pass.
- `npm run typecheck` — pass.
- `npm run eval -- validate` — unchanged bank `9254fe78fdf7580faf991b4936beec533a1327e54b4efa7f6ed9cffd87820f85`.

Root `npm test` — 2 pass. Logs: `/tmp/e1-continuation-{red,green,eval,eval-typecheck,guild,typecheck,bank,root}.log`. Review inventory refreshed with a unique `e1-continuation-checkpoint-8237153e.tar.gz` deterministic archive and preserved preceding manifest. Independent review follows; this is not independent acceptance. No production grader bytes or historical grade identities changed; retain all earlier results/archives without regrading or pooling.

All native admission/driver/preload/settlement/history/operational preparation gates remain CLOSED. No C1–C8 promotion, host/provider/SDK/procfs/installed-runtime probes, Docker, dependency/runtime changes, spending, staging or commits. No arbitrary candidate output was executed: only locally authored inert fixtures under the existing test runner. No restricted-host command exists for this unfinished grading route. Private roster/artifact separation, owned immutable import and actual isolation/termination evidence remain host-boundary work requiring separate authorization, not claims supported by this experiment.

## Sequential grading slice — continuation clarification and inert implementation

The independent review and current direction resolve the preceding checkpoint: **next-case release/termination is permitted continuation observability under existing semantics**, not a new grading amendment or a request for further owner approval. No collect-all observer is used. The supplied review approved the experiment, not universal equivalence. The previous continuation-choice text records the superseded checkpoint.

### Implemented boundary

- `grading-observer.ts` is the only new public grading code. It receives a single public case and holds one supplied candidate instance across requests. Ordinary callbacks increment first, assert ID then name immediately, permanently latch caught assertion failures and ignore extra arguments. Persistence throws one locally allocated error, has no count/argument requirement, and compares references locally. Node `assert.rejects` retains its runtime promise-shape rule; unsupported then-only returns do not become valid persistence rejections.
- `grading-boundary.ts` stays supervisor-private. It owns the six ordered ordinary cases and final persistence case and their judgments. It releases the next invocation only after the previous observation passes. Neither detailed failure feedback nor predicates/final judgments are returned to the session. Early ordinary failure goes directly to cleanup. This is a grading-specific interface, not RPC, authentication or container transport.
- Request fields: `version`, `caseId` (0–6), `attemptId`, `gradingRunId`, public retained-artifact and observer digests, `actor`, `target`, `name`, `saveBehavior`. Only public-code/artifact commitments are included, never small-private-input hashes. The four binding fields are validated and detached before release. No bank, rubric, reference fix, private task, previous result or private diagnostic field is projected.
- Observation fields: the version/case/binding fields plus `saves`, `invalidSave`, `settlement` (`saved`, `other`, `rejected`, `synchronous-throw`), `sameThrownObject`, `overflow`. Candidate objects/errors are not serialized. Ordinary invalid arguments are represented by the permanent latch rather than collecting arbitrary values. Persistence save calls are deliberately uncounted. Unknown fields, duplicate JSON keys/noncanonical framing, incomplete/oversized records, wrong binding/order or overflow cannot pass.
- One canonical JSON record per exchange, at most seven exchanges, 4096 bytes per record, 64 KiB cumulative response ceiling, 64 ordinary counted saves. The session contract also requires combined raw stdout/stderr ≤64 KiB; **there is no transport yet to enforce raw stream limits/UTF-8 framing**. The supervisor reserves 500 ms of its five-second owner window for cleanup; observation deadline is 4500 ms. Timeout/abort stops release, aborts I/O and always requests close. Close throw, uncertainty or timeout yields `cleanup-pending`, never a grade. Successful close is a session contract, not independently demonstrated destruction.
- `gradeConnectedOutcome` in the existing grading module hard-stops authorization before artifact reads/imports. Static grading delegates to the existing snapshot/scope/index/pre/post checks. The maintained native campaign route additionally requires confined grading before invoking `runTrial` for authorization, including failed producers that would otherwise fall through to the legacy checker. No caller-supplied launcher, approval boolean or unsafe fallback exists on that entry. Native admission still stops earlier under its existing closed gate. Historical `gradeOutcome`/local checker remains available for existing offline/inert diagnostics, explicitly **not** an outside-supervisor execution entry; it must never receive real candidate artifacts in a private supervisor.

### Evidence and limitations

Only authored inert candidates ran. Focused command from Guild: `node --import tsx --test evaluation/test/grading.test.ts evaluation/test/sequential-grading.test.ts evaluation/test/supervisor-grading-equivalence.test.ts` — **23 passed**. Differential coverage compares the actual amended checker with sequential observations for caught assertions, retries, synchronous denial/persistence distinctions, error identity/copies, extra arguments, repeated persistence calls and unsupported then-only returns. The side-effect counterexample now observes current `[]`, collect-all `['later-case.txt']`, sequential `[]` with exactly one invocation. Original delayed experiments remain historical characterization, not new behavioral RED.

New RED evidence (logs `/tmp/e1-sequential-*.log`, retained in the new review archive): absent adapter/observer import; absent connected entry; duplicate-key frame accepted (`passed` versus `inconclusive`); cancellation during cleanup returned `passed`; unsupported then-only return passed sequential but failed amended checker; caller binding mutation substituted a later run ID. Each was repaired and rerun GREEN. Additional malformed/boundary/success coverage is characterization of the driven implementation, not separately claimed RED. Self-review found the promise-shape and binding-lifetime defects and fixed them test-first. The campaign preflight is defensive closed-gate wiring, not evidence of executing an admitted native branch.

Final commands from Guild: focused command above; `npm run eval:test` (**364 passed**); `npm run eval:typecheck`; `npm test` (**136 passed**); `npm run typecheck`; `npm run eval -- validate` (unchanged bank `9254fe78fdf7580faf991b4936beec533a1327e54b4efa7f6ed9cffd87820f85`). Root `npm test` (**2 passed**) and `git diff --check`; a separate whitespace scan includes the untracked changed evaluator files. No dependencies or runtime were changed. Package lock remains TS 5.9.3 / tsx 4.23.1 / Node types 24.13.3; producer selection remains Node 24.20.0/Linux arm64/Pi and pi-ai 0.85.1.

No universal equivalence: transport latency, microtask/thenable behavior, detached asynchronous callbacks and concurrent side effects can distinguish an interactive boundary. Limits deliberately fail closed rather than certify arbitrary programs. The observer shares candidate protection and can be subverted; same-object booleans are cooperative diagnostics. In-process fixture sessions are never production launchers and cannot preempt hostile synchronous JavaScript. Unit cleanup acknowledgments prove state handling, not kernel isolation, descendant death or secret erasure.

### Remaining work and identity

The bounded adapter/comparator and inert tests are implemented. Independent review returned **Approve, no findings** for `evaluation/src/grading-observer.ts`, `evaluation/src/grading-boundary.ts`, `evaluation/src/grading.ts`, `evaluation/src/campaign-execution.ts`, `evaluation/test/grading.test.ts`, `evaluation/test/sequential-grading.test.ts` and `evaluation/test/supervisor-grading-equivalence.test.ts`. Approval covers only the bounded inert implementation, not operational acceptance or universal equivalence. The 364 evaluator / 136 Guild / 2 root results and both typechecks above are supplied implementation evidence, not reviewer-executed checks; no tests or typechecks were rerun for this documentation-only finalization. The current review manifest is refreshed with a preserved pre-final-review snapshot and unique deterministic `.pi/evaluation/e1-sequential-grading-final-review-8237153e.tar.gz`; the earlier sequential archive and pre-sequential snapshot remain unchanged. Owned executable confinement, immutable bounded artifact import after producer termination, fixed image/roster provenance, stream framing/output enforcement, independent termination and cleanup evidence remain unimplemented. The connected entry therefore hard-stops; there is no honest executable host command sheet yet. No host execution or gate opening is authorized, and no C1–C8 condition is promoted. This is not another continuation-contract blocker.

The public roster must contain only reviewed observer/bootstrap/runtime inputs and retained candidate files; `grading-boundary.ts`, `grading.ts`, `bank.ts`, tests, reference material, private manifests and results remain outside both producer mounts. Do not copy the whole evaluator source tree. Producer and grading exchange paths must be separate from private authoritative artifacts and prior attempts; import must reject links/special files/escapes/mutation. Grading feedback/artifacts never return to producing agents or subsequent attempts. These are executable-transport prerequisites, not proven isolation.

New `grading.ts` raw SHA-256: `a938ad92188e3bcb9b6ee1033eab3e50514fb7d8387f87908c33ffd8a56b0753`. The existing implementation fingerprint also includes both new modules and campaign wiring. Preserve old results/implementation identities without regrading or pooling. Prior manifests/archives remain untouched; the pre-sequential manifest and distinct deterministic `e1-sequential-grading-8237153e.tar.gz` retain this checkpoint and validation logs. All native admission, driver, preload, settlement/history and operational preparation gates remain CLOSED. No host/provider/SDK/procfs/installed-runtime probes, Docker, spending, staging or commits occurred.


## Fixed byte-transport increment — prepared consumer, not confined launch

`superviseAuthorization` now accepts the fixed `GradingProcessTransport` through `grading-transport.ts`; it still uses the same sequential projection, private comparison, cancellation and five-second window (4500 ms exchange plus 500 ms cleanup). Existing in-memory sessions remain semantic test fixtures. The operational `gradeConnectedOutcome`/campaign preflight still reject before artifact reads or launch. No caller transport override was added to those operational entries and no local-checker fallback was enabled.

Transport is exactly supervisor stdin writes and stdout/stderr reads, not RPC. Requests and observations use one canonical JSON record plus LF, seven exchanges maximum, one pending request, 4096-byte record limit, and 65536 combined raw response bytes including discarded stderr. Fragmented bytes are assembled before strict UTF-8 round-trip validation; batches, unsolicited/replayed records, bad bindings, malformed JSON, EOF and overflow cannot pass. No raw candidate diagnostics are retained. Cancellation rejects pending I/O and terminal disposal destroys all three owned pipes. The existing comparator enforces binding, exact keys, order and observation semantics.

`terminate()` must belong to a trusted external resource owner; it is not derived from candidate output, completion markers or process-reported PIDs. The transport invokes it once and never returns success on uncertainty, throw or timeout. Byte-integrity failure is conservatively classified cleanup-pending even if the owner reports termination; it must not be resumed as success. Cancellation with otherwise confirmed cleanup remains cancelled. The inert child test confirms only that authored child's exit, not descendant or container destruction. This interface is **not** an authenticated owner registry or independently implemented container cleanup.

Prepared inventory constraint: only `grading-observer.ts` is public grading source. `grading-transport.ts`, `grading-boundary.ts`, `grading.ts`, `bank.ts`, tests, private manifests, reference material and prior results must remain supervisor-only. No whole `evaluation/src` copy is acceptable. Actual bootstrap/producer/runtime image inventory and immutable-image identity are still missing, so this is not an executable roster. There is no artifact importer yet: no artifacts may be read/imported on the operational route until independent producer termination, bounded link/escape/special-file/mutation rejection and supervisor-owned retention are implemented and reviewed. This increment supplies neither filesystem isolation nor hostile observer integrity.

### Executed evidence

From Guild:
- `node --import tsx --test evaluation/test/grading-transport.test.ts`: initial behavioral RED (`cleanup-pending` instead of expected `passed` because streams had no consumer), then GREEN. Cancellation regression RED (`cleanup-pending` instead of `cancelled`), then GREEN.
- `node --import tsx --test evaluation/test/grading.test.ts evaluation/test/sequential-grading.test.ts evaluation/test/supervisor-grading-equivalence.test.ts evaluation/test/grading-transport.test.ts`: **29 passed**.
- `npm run eval:test`: **370 passed**; `npm run eval:typecheck`: passed.
- `npm test`: **136 passed**; `npm run typecheck`: passed.
- `npm run eval -- validate`: unchanged bank `9254fe78fdf7580faf991b4936beec533a1327e54b4efa7f6ed9cffd87820f85`.

Root `npm test`: **2 passed**; `git diff --check` passed. Logs `/tmp/e1-transport-*.log` are retained in the distinct deterministic byte-transport archive. Additional malformed-frame, cumulative stderr, early EOF, binding/order, lost/uncertain owner and authored-child checks are follow-up coverage, not separately claimed RED cycles. Source review is self-review only; independent acceptance remains outstanding. No Docker, host/provider/SDK/procfs/installed-runtime probes, credentials, dependencies/runtime changes, spending, staging or commits occurred. Historical outcomes retain their original implementation identities; the implementation fingerprint changes with these new bytes and cannot silently rebind prior results. No C1–C8 promotion.

## Owned command/import preparation — inert connected slice, not operational completion

This increment continues plan 8237153e through the **same `superviseAuthorization` → `gradingTransportSession` path**, not another campaign runner. `OwnedGradingConnection.open()` is bounded by the existing observation/preparation deadline; the returned public binding is checked for unchanged attempt/run IDs before any case release. Artifact and observer commitments are derived from the imported bytes/public source roster. `close()` remains bounded by the existing supervisor cleanup window. The existing operational `requireConfinedGrading()` now reaches `confinedGradingOwner()`, which still throws unconditionally before filesystem access. `gradeConnectedOutcome`, campaign preflight, native admission/driver/preload/settlement/history and operational preparation therefore remain closed. There is no caller-supplied operational launcher or local-checker fallback.

### Implemented preparation

- `grading-owner.ts` constructs only fixed Docker command objects: create with a generated owned name/label; inspect by full selected ID (or owned creation name after incomplete create); force-remove only after owner-name/image/ID checks; successful full-ID container enumeration to confirm absence; and attach/start by the returned full ID. A failed inspect is never interpreted as destruction. Producer output/exit/acknowledgments do not authorize import. The **only** executable boundary here is `inertGradingOwner`, guarded as test-only and supplied entirely authored fake daemon responses/streams. The environment guard is not a security boundary; the unconditional operational factory stop is what prevents operational callback injection. No Docker command was executed and no general subprocess facility was added.
- Create fixes pull-never, network-none, nonzero UID/GID, read-only root, ALL capability drop, no-new-privileges, private IPC, init, 512 MiB, 64 PIDs, one CPU, and `/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777`. Exactly two binds: public code RO at `/harness/guild`, independent grading exchange RW at `/evidence`. Fixed clean-environment Node/bootstrap entry, no shell or arbitrary command field. Prepared inspect validation rejects identity, user, network, privilege, rootfs, caps, security options, memory/PID/CPU, IPC/PID/UTS/init/tmpfs, entrypoint/workdir, devices, declared image volumes and mount drift before attach. This is a prepared policy check, **not host-demonstrated confinement or a complete image configuration audit**.
- Producer mount mapping must identify the exact selected `/evidence` source before owner removal/import. Roots must be normalized absolute, nonoverlapping, and free of mount-option delimiters. Every existing ancestor must be a real directory. Import rejects symlinks, hardlinks (`nlink != 1`), special files, unsafe names/traversal, excessive depth/count/bytes, leaf replacement and observed mutation. Regular files are opened no-follow/nonblocking, read at most initial size plus one, and checked by descriptor and path identity before/after. Limits retain the existing 2000 entries/1000 files/32 levels/8 MiB ceiling (including retained Git metadata, conservatively tighter than the historical snapshot's content-only ceiling).
- Only after independently modeled producer destruction are bytes copied exclusively into a fresh supervisor-private retained directory and a separate empty grading exchange. Neither copy is a link to producer files or to the other copy. Existing destinations cannot be reused. Partial evidence is retained, not silently reset. The retained tree is never mounted. Grader removal precedes post-grading reads; content and normalized-copy mode changes, index-byte changes and unsafe files prevent success. Mutation/read failure is conservatively `cleanup-pending`, not a fabricated original `checkerMutated`/scope receipt. Original source modes are included in the artifact commitment, while copy permissions are normalized to private files.
- The fixed public roster is exactly `grading-bootstrap.ts` and `grading-observer.ts`; file hashes and absence of extras are checked before mount/attach. Whole evaluator copies, comparator/owner/bank/tests/private manifests/results are rejected. The public bootstrap imports one fixed `/evidence/src/users.mjs` instance, bounds and validates public requests, and emits only existing cooperative observations. It never imports private predicates or sends final judgments. Same-reference-error observations remain cooperative, not hostile-code attestation.
- One-shot ownership includes partially failed create/start and idempotent cleanup. Cleanup waits for in-flight preparation rather than declaring absence before a late create. Lost owner/timeout/uncertain daemon operations cannot promote a grade or permit reuse. The outer 4500+500 ms window is unchanged; a hung external operation leaves cleanup pending. No portable Docker abort mechanism is pretended to exist in this test adapter.

### Exact remaining choices and completeness boundary

**The software preparation is not code-complete for restricted operational integration.** This slice implements command planning, owner state handling, public bootstrap, bounded copy/import and the comparator connection, rather than another standalone transport unit. It intentionally does not invent:

1. A real immutable image digest, full image configuration and loader/library/runtime inventory, source hashes or producer inventory. Inert `imageFiles` admits only commitments to `/usr/bin/env` and `/usr/bin/node`; this is a closed executable template, **not a complete Linux runtime roster**. Selecting actual image contents or claiming their privacy from a digest would exceed evidence. Image environment/loader behavior and runtime provenance still need review.
2. A trusted maintained-attempt/daemon/container ownership registry or actual host spawn adapter. The operator must bind the daemon endpoint, full producer/container identity, label, image and exchange to supervisor authority; labels alone are not authority. The test adapter's independent-looking responses prove state handling only. Original producer and auth provisioning still need their exact closed rosters and watchdog mapping.
3. A safe final Git snapshot/receipt mapping. Retained `.git` bytes are never executed or read by host Git here: candidate-controlled config/includes/fsmonitor would be an unsafe fallback. Raw index-byte preservation across grading does not prove equality with the existing baseline `ls-files --stage` representation, status or diff. Choose and review either trusted pre/post snapshot production outside the private supervisor or a bounded canonical index/status mapping before connecting full scope/final receipt derivation. No replacement receipt fields, fake empty diffs or baseline preservation claims are emitted by this slice.

Those are concrete remaining integration decisions/implementations, not a request to revisit approved public callbacks or continuation observability. No missing host availability is used to claim software completion. Parent paths and mount ownership must be supervisor-trusted and all producer writers gone: Node path APIs cannot defend against an independently hostile host renaming parents or replacing mounts concurrently. Unix modes are not privacy isolation. No kernel/descendant death, all-copy erasure or arbitrary-candidate observation integrity claim follows from the inert tests.

### Executed verification and retained evidence

New test-first RED logs: missing owner API (`e1-owner-red.log`); switching from acknowledgement callbacks to fixed command controls (`e1-owner-control-red.log`, successful case was cleanup-pending and no removals occurred); missing bootstrap API (`e1-owner-bootstrap-red.log`); root-user policy drift and grader chmod accepted (`e1-owner-policy-red.log`); wrong producer exchange mapping still imported (`e1-owner-mapping-red.log`). Corresponding focused GREEN logs are retained. An initial test type annotation failed typecheck and was corrected; it is not behavioral RED evidence. Additional negative cases and cancellation/binding tests are follow-up coverage, not separately claimed RED cycles.

Commands actually run from Guild:
- `node --import tsx --test evaluation/test/grading-owner.test.ts` (RED/GREEN cycles).
- `node --import tsx --test evaluation/test/grading-bootstrap.test.ts` (missing-API RED).
- `node --import tsx --test evaluation/test/grading-owner.test.ts evaluation/test/grading-bootstrap.test.ts` — **14 passed**.
- `npm run eval:test` — **386 passed**, including two additional owned-session cancellation/binding tests.
- `npm run eval:typecheck`; `npm test` — **136 passed**; `npm run typecheck`.
- `npm run eval -- validate` — unchanged bank `9254fe78fdf7580faf991b4936beec533a1327e54b4efa7f6ed9cffd87820f85`.

Root `npm test` — **2 passed**. Both final typechecks passed. Logs `/tmp/e1-owner-*.log` are retained in the distinct deterministic `.pi/evaluation/e1-grading-owned-preparation-8237153e.tar.gz`; current review hashes are refreshed with a preserved pre-owned-preparation manifest. Earlier archives/manifests/results remain untouched. Current implementation identity changes; do not silently regrade or pool historical outcomes. Whitespace and archive/inventory checks are recorded in this increment's manifest.

At this preparation checkpoint, self-review only; subsequent independent review and final re-review are recorded below. No Docker, host/provider/SDK/procfs/installed-runtime probes, credentials, dependencies/runtime changes, spending, staging or commits. Existing test banks still run their authored inert Node fixtures. All operational gates remain CLOSED; no C1–C8 promotion or claim of Phase 1 completion. Separately authorized restricted-host evidence and later separately authorized provider work remain necessary.


## Owned import independent review fixes

Independent review reported two Medium findings in `grading-owner.ts`. Independent owner re-review returned **Approve, no findings; both prior Mediums resolved**. Acceptance is limited to bounded owner preparation, not operational readiness or Phase 1 completion. No architecture, operational entry, confinement policy or C1–C8 gate was expanded.

1. **Unbounded directory materialization:** replaced `readdir` with `opendir` (one-entry buffering), explicit reads and `finally` closure. Cancellation is checked before and after reads; the global 2000-entry/depth limit is enforced before collecting names for deterministic sorting. Oversized directories reject on the first over-limit entry. Destination emptiness reads at most one entry and closes on rejection. Copy loops also check cancellation. These are bounded filesystem operations, not a guarantee of preempting a stalled kernel call.
2. **Dropped empty directories:** the tree explicitly distinguishes directory and file entries. Directories, including nested empty directories, are retained in both independent copies, with normalized private directory permissions. Original type/path/mode enters artifact commitments, and normalized copy directory presence/modes enter post-grading comparison. Added/removed/chmod directories cannot pass. The 1000-file ceiling is counted separately from the unchanged 2000-entry/32-level/8 MiB bounds. Required candidate and public source entries must be regular files. Existing link/special-file/ancestor/mutation checks remain in place. Root directory metadata is still not an artifact entry; supervisor-owned quiescent parent/mount assumptions remain required.

### TDD and verification

Focused RED command from Guild: `node --import tsx --test evaluation/test/grading-owner.test.ts`.
- Bound regression: expected zero materializing `readdir` calls, observed 2002. The initial filesystem spy did not intercept ESM named imports and passed; syncing builtin ESM exports corrected the test instrumentation, then produced this behavioral RED. After the fix, the same command passed (13 tests).
- Empty-directory regression: the authored fixture required `scratch/nested` at attach in both retained and grading copies; missing directories caused `inconclusive` instead of `passed`. The same command passed after the fix (14 tests).
- Follow-up coverage (not separately claimed RED): read-count/handle closure at oversized rejection, single-read nonempty destination rejection, cancellation during enumeration, commitment differences for directory presence/mode, and add/remove/chmod mutation rejection.

Final commands actually run from Guild:
- `node --import tsx --test evaluation/test/grading-owner.test.ts evaluation/test/grading-owner-cancellation.test.ts evaluation/test/grading-bootstrap.test.ts` — **24 passed**.
- `npm run eval:test` — **394 passed**; `npm run eval:typecheck` — passed.
- `npm run test` — **136 passed**; `npm run typecheck` — passed.
- `npm run eval -- validate` — unchanged bank `9254fe78fdf7580faf991b4936beec533a1327e54b4efa7f6ed9cffd87820f85`.

Root `npm test` — **2 passed**; `git diff --check` passed, plus scoped untracked-file whitespace checks. Root defines no typecheck. Logs `/tmp/e1-owner-review-*.log` are retained in the unique deterministic `.pi/evaluation/e1-grading-owner-review-fixes-8237153e.tar.gz`. The current review manifest is refreshed; its exact preceding bytes are preserved as `.pi/evaluation/e1-candidate-v2-independent-review-inputs.pre-owner-review-fixes-8237153e.json`. Earlier archives/manifests/results remain untouched. Changed implementation/commitment bytes must not silently rebind, regrade or pool historical outcomes.

All operational/native admission/driver/preload/settlement/history/preparation gates remain CLOSED. No Docker, host/provider/SDK/procfs/installed-runtime probes, credentials, runtime/dependency changes, spending, staging or commits occurred. Only authored inert fixtures ran, including existing test-bank subprocesses. This resolution does not establish real confinement, inventory provenance, descendant destruction or Phase 1 completion; all previously listed operational blockers remain.


### Independent owner re-review finalization

**Approve, no findings.** Both prior Medium findings (unbounded directory materialization and lost empty directories) are resolved. This closes the bounded owner-preparation re-review only; it does not approve operational integration or complete Phase 1/C1–C8.

The real immutable image and complete runtime/loader/library/config inventory, producer roster and maintained-attempt owner registration, trusted host adapter with bounded daemon abort ownership, safe Git snapshot/index/status/diff-to-receipt mapping, and diagnostic auth/tmpfs provisioning remain blockers. Native-v2/SDK fidelity and separately authorized host end-to-end/negative evidence remain unresolved. All operational gates and the unconditional confined-owner factory stop remain CLOSED. No runnable host command is supplied or claimed.

This is documentation-only bookkeeping of the supplied independent verdict. The preceding test/typecheck counts are retained implementation evidence, not reviewer-executed or rerun here. Verification is limited to hashes and diffs. No source/tests/gates, probes/host execution, runtime/dependencies, spending, staging or commits changed or ran. The refreshed `.pi/evaluation/e1-candidate-v2-independent-review-inputs.json`, exact pre-finalization snapshot `.pi/evaluation/e1-candidate-v2-independent-review-inputs.pre-owner-final-review-8237153e.json`, and unique deterministic `.pi/evaluation/e1-grading-owner-final-review-8237153e.tar.gz` preserve this finalization without overwriting prior evidence or rebinding historical outcomes.

## V3 finalization safety checkpoint — bounded acceptance, full connection blocked

This increment does not deliver the requested code-complete owned finalization slice. The precise missing contracts are: `DriverResult` has no owner-issued attempt/producer/image/exchange registration; `OwnedGradingConnection` provides only open/close transport/binding; `superviseAuthorization` returns passed/state, not authoritative imported artifact evidence; no confined exporter supplies the existing `Snapshot.files/index/status/diff`. Returning those fields from an arbitrary caller would invent authority. The test owner normalizes copy permissions and commits original modes but cannot rederive baseline index equality from raw Git index bytes. None of those facts is established by supplied Mac image metadata or by a driver exit/PID. This is not a renewed callback-secrecy or continuation-approval objection.

The smallest safe bounded acceptance change is connected to the existing runner/receipt path:

- `src/runner.ts`: supervisor-selected `TrialControls.finalization = "confined-required"` is captured before execution. Both successful and failed producer paths bypass `gradeOutcome` and retain a pending marker without final snapshot/grade. Successful workflow status becomes `finalization_pending`; existing errors/interruption remain visible. No private task manifest is released in this mode. Pending does not imply termination, and no artifact import is performed. Existing local behavior is unchanged when the requirement is absent.
- `src/campaign-execution.ts`: trusted V3 spec selects that requirement on the sole `runTrial` call. Existing native availability/admission and authorization-grading preflight stops are untouched; this branch remains unexecuted behind those stops. No operational option accepts a finalizer, resource identity or caller PID.
- `src/trial-receipt.ts`: V3 still runs bound producer/runtime/content/input audits and rejects before candidate repository snapshot/Git. Fresh and retained-result calls share this rejection. Historical candidate V2 remains diagnostic-only with its original behavior. An explicitly pending confined result cannot use the ordinary receipt route either. No grading is rerun, receipt/zero cost invented, or settlement/history gate changed.
- `test/runner.test.ts`: success and thrown-driver inert fixtures use invalid non-executable Git config as a tripwire. Assert pending/no grade, preserved failure status, absence of private task manifest, retained original index bytes/mode, result serialization and ordinary receipt refusal. Retention of bytes/mode is not baseline preservation or an import commitment.
- `test/trial-receipt.test.ts`: V3's previously diagnostic success is now an explicit missing-confined-snapshot rejection, tested against both in-memory and retained results with invalid inert candidate config. Existing negative binding/content/runtime cases still run for both V2 and V3; V2 diagnostic receipt checks remain unchanged.

### Verification actually run

From `pithos.guild`:

```text
node --import tsx --test --test-name-pattern='confined finalization' evaluation/test/runner.test.ts
node --import tsx --test --test-name-pattern='candidate policy' evaluation/test/trial-receipt.test.ts
node --import tsx --test evaluation/test/runner.test.ts evaluation/test/trial-receipt.test.ts
npm run eval:typecheck
npm run eval:test
npm test
npm run typecheck
npm run eval -- validate
```

Root: `npm test`; `git diff --check`; `git diff --cached --stat` (empty); scoped whitespace scan includes these untracked evaluator files.

RED: runner returned `grader_error` rather than pending/preserved `driver_error`; V3 receipt invoked Git and reported invalid config rather than missing confined evidence; ordinary receipt on a pending result also reached Git. The ordinary rejection test first lacked a child artifact and stopped earlier; that fixture was completed before the Git-boundary RED and is not counted as behavioral evidence. Corresponding focused GREEN: **28 passed**. Full **405 evaluator / 136 Guild / 2 root passed**, both typechecks passed; bank digest unchanged at `9254fe78fdf7580faf991b4936beec533a1327e54b4efa7f6ed9cffd87820f85`. Logs `/tmp/e1-finalization-*.log` retained in a unique review archive; the previous manifest/archives are preserved. No independent review performed in this role.

Review questions: Does the pending requirement cover every V3 success/failure/interruption without changing ordinary behavior? Can either receipt route invoke host Git for pending/current V3 evidence? Are cached grades powerless to satisfy the missing exporter? Are original modes and raw index retention clearly distinguished from canonical baseline/index equality? What precise issuer/exporter contract is required to bind imported files to trial/producer/image/exchange without arbitrary caller authority? Are gate preservation, unexecuted campaign wiring and the absence of a runnable Mac entry reported accurately?

All C1–C8 remain blocked as mapped in the leading status. No native-v1/historical V2/V3 policy pins, dependencies, runtimes, packages or grader semantics changed. No Docker, host/provider/SDK/procfs/installed-runtime probes, spending, staging or commits. Only authored inert fixtures and repository-supported test banks ran. No full-owner integration, authoritative artifact bindings or isolation/termination proof is claimed. Retain previous grades/receipts with their original frozen implementation; new source bytes cannot silently rebind or regrade them.
