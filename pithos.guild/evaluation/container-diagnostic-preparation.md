# Container namespace + diagnostic authentication — inert preparation

Current increment: supplied independent review **Approve, no findings**, after
both lifecycle Medium fixes; **bounded inert preparation only**. All operational factories, native admission,
preload, driver, settlement/history and restricted integration remain CLOSED.
No policy, Node v24.20.0 / Pi 0.87.0 / pi-ai 0.87.0 selection, image or dependency
was changed. No Docker/host/provider/SDK/procfs/installed-runtime probes, spend,
staging or commits were performed.

## Connected consumer

`prepareInertContainerAttempt` selects an explicit `container-diagnostic-launch-v1`
mode on the original producer registry handle. The original deployment, full
container ID, immutable image, endpoint, declared daemon/namespace, six-field
trial identity and prelaunch intent stay bound to that handle. Historical
create-registration attempts cannot silently acquire diagnostic evidence.

The existing authored Docker fixture performs create registration, not actual
container provisioning. The separate test-only diagnostic orchestrator binds a
private expectation to that same original attempt, commits it, privately generates
synthetic credentials, calls the **original** `createCodexAuthLease` and
`readCodexAuthLease`, sends bytes through an owned inert `PassThrough`, writes an
owned receiver fixture, observes host and receiver identities, authors cooperative
spawn envelopes, revokes the original lease and cleans up. No credential-source,
lease, arbitrary callback, observation or successful receipt input is accepted.

The proposed container destination is fixed to
`/tmp/guild-auth/<trial-uuid>/auth.json` on the proposed tmpfs. Development maps it
to a private temporary receiver fixture: it is **not** a mount, environment/argv
credential, running container, native origin or real native Pi invocation.

Host supervisor and Docker-client identities have a separate namespace from
local creator, Pi parent and Guild child identities. The fixture deliberately
uses the same numeric PID for the Docker client and local creator; namespace
identity prevents equivalence. The new `container-native-diagnostic-envelope`
has exact registry-bound parent/child links, bounded process/event records and
the frozen runtime tuple. It is cooperative diagnostic evidence, not kernel,
ancestry, executable-byte, SDK, provider or image attestation. Historical native-v1
and candidate-v2/v3 direct-PID checks are untouched; no broad campaign
`PreparedLaunch` contract was expanded.

## Lifecycle and retention

States: prepared → bound → committed → provisioned → observed → running →
revoking → cleanup-pending → closed. Here **provisioned means owned inert
channel/file fixtures only**. No credential source/lease/channel bytes are made
before commitment. Exact ordered exclusions and a 300000 ms scope are checked
with the original lease issuer before release and again before running. Clone,
disposed-original and reordered/missing-scope cases reject. Distinct host/local
file identities bind separately to the intent, namespace and receiver, avoiding
an intent/observed-auth digest cycle. Same-byte local replacement rejects.

Revocation of the original lease precedes source/receiver/channel cleanup.
Account/source/lease/transit/local-file/endpoint materializations are accounted
for; source and receiver deletion are checked by disappearance of their owned
fixture root, and channel closure is acknowledged. Missing acknowledgement,
cancellation or any uncertainty blocks finalization. Buffer clearing and dropped
references **do not claim JavaScript heap erasure**. These are cooperative
quiescent filesystem checks, not hostile-owner isolation.

`issueRegisteredFinalizationOrigin` consumes private diagnostic state internally,
not caller-claimed success. Even clean diagnostic files remain cleanup-pending
until the existing concrete owner confirms full-ID producer destruction (policy
reinspection, removal and empty enumeration) before comparator completion.
Uncertain destruction cannot close the lifecycle or complete a grade.

Container finalization records use **record version 2**, with independently
bound expected process/launch identities and observed auth identities in the
version-2 finalization marker. Historical version-1 records remain unchanged.
Both fresh finalization and retained audit call the same bounded namespace,
spawn, auth-identity, freshness-at-observation, lifecycle-order and cleanup audit;
they do not trust a success boolean. Token/account/source bytes are not retained.
Changing a record hash cannot bypass missing/reordered evidence, Docker-PID
substitution, receiver replacement, wrong full-ID cleanup or namespace/endpoint
rebinding. Negative cleanup cannot complete even with a passed comparator.

## TDD and verification

Observed REDs:

- Connected diagnostic test: missing `diagnostic-auth-transport.ts` module.
- Self-consistent retained receiver replacement with recomputed auth digest:
  `Missing expected rejection: self-consistent replacement`. Fixed by binding
  independently captured host/local observations in the version-2 marker and
  comparing them again inside shared record validation.

Both are GREEN. A later owned-channel change exposed a close-event wait after
an already-closed stream; its test command timed out. Checking `closed` before
waiting fixed the race; subsequent focused and full suites pass. This timeout
is not counted as a successful run.

Executed from `pithos.guild`:

```text
node --import tsx --test evaluation/test/container-diagnostic.test.ts
node --import tsx --test --test-name-pattern='shared retained' evaluation/test/container-diagnostic.test.ts
node --import tsx --test evaluation/test/container-diagnostic.test.ts evaluation/test/producer-launcher.test.ts evaluation/test/trial-finalization.test.ts
npm run eval:test
npm run eval:typecheck
npm test
npm run typecheck
npm run eval -- validate
```

Results: **58 connected / 535 evaluator / 136 Guild / 2 root tests passed**;
both typechecks passed; bank digest unchanged:
`9254fe78fdf7580faf991b4936beec533a1327e54b4efa7f6ed9cffd87820f85`.
Root `npm test` and `git diff --check` also pass. Logs and exact inventory are in
the central review manifest and unique archive; prior manifests/archives and
mixed-tree work are preserved. These are implementation results, not independent
review approval or operational evidence.

Remaining operational work: approved real namespace/daemon/image
and roster provenance; real isolated receiver/channel provisioning; admitted
native invocation and full runtime/request/response/meter correlation; SDK and
refresh fidelity; operational review and separately authorized host/provider
integration with independently confirmed destruction. No C1–C8 promotion.

Review inventory: `.pi/evaluation/e1-candidate-v2-independent-review-inputs.json`.
Unique deterministic archive:
`.pi/evaluation/e1-container-diagnostic-preparation-35d8b422.tar.gz` (SHA-256
sidecar). Exact predecessor:
`.pi/evaluation/e1-candidate-v2-independent-review-inputs.pre-container-diagnostic-35d8b422.json`.
All previous review status fields and archives remain historical, not approval of
this increment.

The initial implementation archive `e1-container-diagnostic-preparation-35d8b421.tar.gz`
is preserved. Final channel ownership explicitly disables automatic stream
destruction so lease revocation precedes endpoint cleanup. All verification
commands were rerun successfully after that adjustment; final logs are under
`.pi/evaluation/validation/container-diagnostic-final-20260604/`.

## Diagnostic cleanup review corrections (2026-06-04)

Two Medium findings are addressed in the inert transport only. Abort is latched
through disposal and source/receiver cleanup, independent of the cleanup work's
signal. A monotonic execution deadline and timer now enforce the existing
`timeoutMs` run window, not merely credential freshness. A stopped run receives
at most the existing 500ms owned-cleanup grace, never another five-minute window.
The returned run is bounded even when an uncancellable filesystem await is
pending; that await remains owned, its late rejection is handled, and settlement
continues failed-state cleanup rather than releasing more auth or issuing
successful evidence. This is not a claim that JavaScript can interrupt kernel IO.
Run timers and the abort listener are removed on return. Cancellation or elapsed
time during cleanup permanently prevents later signal-free finalization.

Original lease disposal still revokes before attempting deletion. A rejection
now records sanitized aggregate uncertainty while independently attempting
revocation verification, endpoint destruction, transit zero-fill, source/receiver
removal and cleanup acknowledgements. Later successful root removal does not
turn failed lease deletion into a successful diagnostic. No arbitrary production
callbacks or new fault capabilities were introduced; tests mock the filesystem
boundary using the existing `syncBuiltinESMExports` convention, and use inert
clock/timer seams (no permissions assumption under root/current UID).

Behavioral RED evidence:

| Regression | Expected observed failure before fix |
| --- | --- |
| Abort during lease/source cleanup | Missing expected rejection (2 cases) |
| Elapsed deadline during provisioning/lease/source cleanup | Missing expected rejection (3 cases) |
| Lease removal rejects | Source/receiver cleanup not attempted |
| Pending filesystem await | Returned run did not settle at deadline + 500ms |

Commands run from `pithos.guild` (each name-pattern command first RED, then the
same cases GREEN in the focused suite):

```text
node --import tsx --test --test-name-pattern='abort during' evaluation/test/container-diagnostic.test.ts
node --import tsx --test --test-name-pattern='elapsed execution' evaluation/test/container-diagnostic.test.ts
node --import tsx --test --test-name-pattern='lease deletion failure' evaluation/test/container-diagnostic.test.ts
node --import tsx --test --test-name-pattern='run deadline bounds' evaluation/test/container-diagnostic.test.ts
node --import tsx --test evaluation/test/container-diagnostic.test.ts
npm run eval:test
npm run eval:typecheck
npm test
npm run typecheck
npm run eval -- validate
```

Results: **22 focused / 542 evaluator / 136 Guild / 2 root tests passed**;
both typechecks passed. Initial test-only type errors (untyped fs mock arguments
and dynamic Node events namespace typing) were corrected before the final rerun;
they are not behavioral RED evidence. Root `npm test` and `git diff --check`
passed. Bank digest remains
`9254fe78fdf7580faf991b4936beec533a1327e54b4efa7f6ed9cffd87820f85`.
Logs: `.pi/evaluation/validation/diagnostic-auth-cleanup-20260604/`.

Review manifest: `.pi/evaluation/e1-candidate-v2-independent-review-inputs.json`.
Exact predecessor preserved at
`.pi/evaluation/e1-candidate-v2-independent-review-inputs.pre-diagnostic-auth-cleanup-20260604.json`.
Unique deterministic archive:
`.pi/evaluation/e1-diagnostic-auth-cleanup-20260604.tar.gz` (SHA-256 sidecar).
All prior review statuses, manifests, archives, policies and mixed-tree work are
preserved. Independent acceptance was outstanding at this correction checkpoint;
the supplied final verdict below supersedes that marker for this slice only. All
operational gates remain CLOSED; no C1–C8 promotion, actual Docker/host/procfs/
SDK/provider probes, dependency changes, spend, staging or commit.

## Documentation-only independent review finalization (2026-06-04)

Supplied independent verdict: **Approve, no findings**, after both lifecycle
Medium fixes above. Approval covers the connected container diagnostic slice
and corrected cancellation/deadline and failure-independent cleanup lifecycle,
**bounded inert preparation only**, not operational acceptance. Historical
checkpoints, counts and approvals above retain their original scope.

Supplied post-fix **22 focused / 542 evaluator / 136 Guild / 2 root**, both
typechecks and unchanged bank validation passed. These results were not
independently reproduced or rerun here. Finalization verifies raw file/inventory
hashes, deterministic archive reproduction and diffs only.

Operational namespace-aware admitted native launch, real isolated authentication
fixture/channel transport and receiver provisioning, approved actual daemon/image/
roster/storage provenance, SDK/refresh/request/meter fidelity, operational review
and separately authorized actual-host/provider evidence with independently
confirmed destruction remain missing. Authored synthetic files and owned inert
streams are not those operational fixtures or evidence. All operational gates
remain CLOSED; no C1–C8 promotion. No source/tests/gates, policy/runtime/dependencies,
probes, spending, staging or commits changed or ran in this finalization.

The refreshed central manifest retains supplied logs and raw-byte inventories.
Unique reviewed archive:
`.pi/evaluation/e1-container-diagnostic-reviewed-20260604.tar.gz` (SHA-256 sidecar).
Exact predecessor:
`.pi/evaluation/e1-candidate-v2-independent-review-inputs.pre-container-diagnostic-reviewed-20260604.json`.
All previous manifests, archives and mixed-tree work are preserved.
