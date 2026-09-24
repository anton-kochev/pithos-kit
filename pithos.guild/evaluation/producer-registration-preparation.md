# Registered producer → private finalization — inert preparation only

This follow-up connects test-issued original deployment, attempt and storage
handles to the existing concrete Docker composition, owner, finalization and
retained audit. Latest supplied independent review: **Approve, no findings** for
this bounded inert preparation only. **All operational gates stay CLOSED.**
This is not operational deployment, selected-byte provenance, native ancestry,
auth compatibility or kernel isolation proof. Earlier approvals remain historical
for their original inputs. No C1–C8 promotion.

## Connected evidence

`installInertProducerDeployment` → `prepareInertProducerAttempt` → exclusive
`reserveFinalizationStorage` → `submitInertProducerCreate` →
`issueRegisteredFinalizationOrigin` → `inertDockerGradingOwner` → `gradingOwner`
→ `finalizeOwnedTrial` → `auditRetainedFinalization`.

The new positive and rejected-comparator tests traverse this entire chain using
fake Docker child-process edges and authored files. Exporter responses contain
original modes; the exporter is removed before grader creation; producer,
exporter and grader removal use full IDs and successful empty enumeration.
The retained audit rederives the same positive or negative grade without Git or
candidate execution. No DriverResult field or caller-returned grade/receipt is
used as authority. The existing runner/origin and native receipt tests still
pass unchanged; this new fixture does not traverse native admission or a real
producer invocation.

The producer has its own code root and exact selected file roster. Registered
owner checks use the original attempt's fixed producer mounts, not the grader's
`s.code`. Full ID, immutable image, generated owner token, fixed policy and
command are inspected at registration and again by the owner; policy is
rechecked immediately before destruction. An unrelated mount override cannot be
supplied to this path. Original inert fixtures keep their historical same-code
convention. The existing concrete Docker adapter permits only the original
attempt's exact create argv and selected executable/endpoint/config; composition
also rejects rebinding to another daemon selection.

Connection exposed a raw-JSON ordering defect: finalization reconstructed
`snapshot.files` in-place before retaining the record, invalidating the original
owner hash for protocol-decoded snapshots. It now derives the grade with a
separate normalized file map and preserves the owner's original serialized
Snapshot. Existing raw-versus-canonical digest semantics remain unchanged.

## Contracts and limits

- `producer-deployment.ts` validates an exact-key **version 1 data contract**:
  immutable image, explicit non-root producer UID/GID, Node v24.20.0 / Pi and
  pi-ai 0.87.0 / Linux arm64, executable and inventory hashes, Docker executable,
  Unix endpoint, config ownership/mode/exact inventory identity, declared daemon
  and namespace identities, fixed Git executable plus explicit version/hash,
  three separate source roots/rosters, exchange, retention ownership/topology
  and declared mount aliases. No hash is filled in; no defaults or dependency
  crawler are added. Grader/exporter rosters retain their exact two/three names.
  Producer roster is an exact explicit selection, not a verified dependency
  closure or an approved public native deployment. `validateProducerDeployment`
  returns detached data, never a handle. Caller approval fields reject.
- Only the test installer populates the private deployment WeakMap. Original
  handles are required; cloning/serialization transfers no authority. A selected
  inventory identity or supplied image reference does **not** verify any bytes,
  daemon, namespace, SDK, image closure, configuration or operator approval.
  Production `acquireProducerDeployment` unconditionally throws before input use.
- Attempt WeakMap binds the original deployment and all six trial/request/
  baseline/campaign/admission/launch fields, generated owner token, fixed plan,
  returned full ID, daemon/namespace declarations and fixed producer mounts.
  States are prepared, create-submitted, identified, handed, consumed. A private
  preflight latch prevents concurrent submission; preflight failure consumes the
  reservation. Ambiguous submitted create stays non-authoritative; an identified
  but wrong-policy resource is not handed off. No retry, replacement reservation,
  lookup/removal by name or interpretation of client death as destruction.
- The maintained new plan is **create-registration preparation only**: it
  selects the still-blocked native preload as its fixed entry, never starts it,
  and is not the native driver's prepared Pi invocation. Only the test issuer
  can submit this plan. Operational `launchProducer` throws unconditionally.
  Wiring an admitted invocation, auth and namespace-aware launch is still work,
  not silently approximated by this plan or a generic `registerProducer(obs)`.
- Storage exclusively reserves `<trial-parent>/.finalization/<trial-id>`; an
  existing trial reservation is never adopted, erased or repaired. It binds
  original deployment/attempt, trial location and directory UID/GID/mode and
  device/inode ancestry. All ancestors and declared mount aliases reject
  symlinks; mounted roots/ancestors cannot overlap private retention, including
  declared aliases. Storage is consumed once and bound to the origin, then
  rechecked before finalization and during fresh/retained record validation.
  Original ancestry is included in the result-hashed retained record.
  Filesystem checks assume cooperative/quiescent ownership: lexical paths,
  permissions and device/inode checks **are not isolation proof**, cannot discover
  undeclared aliases or prevent a hostile concurrent mount/rename owner.
- Original deployment/attempt/storage are consumed internally to construct the
  concrete owner; no arbitrary owner, grade callback or observed producer object
  is registered. `NODE_TEST_CONTEXT` checks identify fixture seams, not hostile
  code authority. Declared daemon/namespace identities are bound in the original
  handle and retained commitment; **actual namespace observation schema and
  authentication transport remain separately blocked**. No Docker-client PID is
  reinterpreted as a native producer PID; historical direct ancestry is unchanged.

## TDD and verification

Observed RED then GREEN:

| Behavior | RED |
| --- | --- |
| Versioned deployment data and original handles | Missing producer-deployment module |
| Exclusive identity-bound storage | Missing finalization-storage module |
| Registered composition through retained audit | Missing producer-launcher module; then retained snapshot hash mismatch |
| No second attempt reservation for the trial | Missing expected exception |
| Symlinked declared mount alias | Missing expected rejection |
| Preflight state distinct from submitted create | create-submitted instead of consumed |
| Original create plan cannot use another daemon endpoint | Missing expected exception |

Malformed/missing nested inputs, clone/replay/cross-attempt/storage/deployment
substitution, detached mutation, wrong image/token/mount, mount change at the
last producer inspect, uncertain create/removal, late ID, failed source preflight
and fresh/retained storage replacement have follow-up coverage. They are not all
claimed as separate RED cycles. During helper extraction, the original test's
binding constant was initially omitted and restored after typecheck. A subsequent
excess-property type error in a launch-identity negative fixture was corrected by
passing the named full identity. Neither compile error is reported as success.

Supplied implementation commands (not reviewer-executed or rerun for this
documentation-only finalization; Guild directory; focused RED runs used the corresponding
file or `--test-name-pattern`):

```text
node --import tsx --test evaluation/test/producer-deployment.test.ts
node --import tsx --test evaluation/test/finalization-storage.test.ts
node --import tsx --test evaluation/test/producer-launcher.test.ts
node --import tsx --test evaluation/test/producer-deployment.test.ts evaluation/test/finalization-storage.test.ts evaluation/test/producer-launcher.test.ts evaluation/test/grading-composition.test.ts evaluation/test/trial-finalization.test.ts
npm run eval:test
npm run eval:typecheck
npm test
npm run typecheck
npm run eval -- validate
```

Root: `npm test`, `git diff --check`, `git diff --cached --name-only`.
Supplied final results (not reviewer-executed): **70 focused / 520 evaluator / 136 Guild / 2 root tests passed**;
both typechecks passed, bank validation and whitespace checks passed, index empty.
Exact review inventory/archive are recorded in the current central manifest. All prior archives and the exact predecessor manifest are
preserved. Logs include the RED runs and resolved typecheck failure, not just
passing output. Bank digest remains
`9254fe78fdf7580faf991b4936beec533a1327e54b4efa7f6ed9cffd87820f85`.

Next blockers: namespace-aware native launch and diagnostic auth transport;
approved actual deployment values and provenance, public producer roster and
isolated storage/namespace provisioning; SDK/refresh/request/meter fidelity;
operational review and separately authorized host/provider integration with
independently confirmed real destruction. The bounded independent delta review
is complete; further user authorization for software preparation is not the blocker.
No gate, native policy/history/runtime selection or dependency changed. No
Docker/host/provider/SDK/procfs/installed-runtime probes, spending, staging or
commits. Existing mixed-tree work is preserved.

Historical implementation evidence snapshot: `.pi/evaluation/e1-producer-registration-preparation-9be0d413.tar.gz`.
Exact predecessor:
`.pi/evaluation/e1-candidate-v2-independent-review-inputs.pre-producer-registration-9be0d413.json`.
The archive is reproducible with sorted entries, fixed metadata and gzip mtime;
its SHA-256 sidecar records the generated bytes. Neither artifact replaces any
prior review archive or conveys independent approval.

## Documentation-only review finalization

Supplied verdict: **Approve, no findings**, bounded inert preparation only.
The refreshed central manifest and unique deterministic
`.pi/evaluation/e1-producer-registration-reviewed.tar.gz` retain current inputs
and supplied validation logs; the exact preceding manifest is preserved at
`.pi/evaluation/e1-candidate-v2-independent-review-inputs.pre-producer-registration-reviewed.json`.
All prior snapshots, archives and results remain unchanged. Finalization checks
are raw hashes, deterministic archive reproduction and diffs only. No tests,
typechecks, bank validation, gates, probes, runtime/dependencies, spending,
staging or commits were run or changed by this finalization.

## Subsequent inert container diagnostic increment

[Container diagnostic preparation](container-diagnostic-preparation.md) now
connects explicit namespace-qualified envelopes and original-lease synthetic
authentication cleanup to registered record-v2 finalization and retained audit.
Latest supplied independent review: **Approve, no findings**, after both lifecycle
Medium fixes; bounded inert diagnostic preparation only. This is a separate
approval, not an extension of the historical approval above. Supplied post-fix
542 evaluator / 136 Guild / 2 root tests and both typechecks passed; not independently
reproduced or rerun here. All operational gates remain CLOSED; no C1–C8 promotion.
Operational admitted native launch, real isolated authentication fixture/channel
transport and receiver provisioning, approved deployment provenance and actual-host/
provider evidence with independently confirmed destruction remain missing.
No actual container provisioning, native origin, runtime/SDK/provider attestation
or host integration is claimed. See the linked diagnostic finalization for the
unique reviewed archive and exact predecessor; verification is hashes/archive/diffs
only. No source/tests/gates, probes, dependencies, spending, staging or commits.
