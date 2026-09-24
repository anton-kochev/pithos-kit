# Reviewed concrete Docker backend + exporter — bounded software preparation

Subsequent [registered producer/storage preparation](producer-registration-preparation.md)
connects test-issued original handles to this composition and retained finalization.
That delta has supplied independent review **Approve, no findings**, bounded
inert create-registration preparation only, not operational issuance or a native
launch. Its linked record states the current blockers; no deployment/provenance,
ancestry/auth or kernel-isolation proof is claimed. The approval and missing-selection statements below describe this
preceding backend checkpoint; every operational factory remains CLOSED.

This slice connects the concrete Docker adapter, separate snapshot exporter and
existing private grading lifecycle. Latest supplied independent review: **Approve, no findings** for the full
concrete backend/exporter composition. This is **bounded software preparation,
not operational authorization**; it does not attest real daemon or host execution. No issuance, spending, execution campaign
or C1–C8 promotion is authorized. Original 13 inventory entries, V1/V2 and
historical Node 24.20.0 / Pi 0.87.0 V3 policy identities remain unchanged.

## Connected candidate

- `grading-docker.ts` accepts create only when argv exactly equals a detached,
  selected grader/exporter plan. It accepts attach/inspect/removal/enumeration
  only by full ID. Absolute executable, Unix endpoint and private config are
  explicit selections; argv includes `--host`/`--config`, `shell:false`, `env:{}`.
  There is no PATH discovery, ambient Docker context or credential inheritance.
- Control output is jointly limited to 64 KiB, validated as UTF8, with a 400 ms
  client deadline and at most 100 ms failed-client reap waiting. Cancellation
  immediately fails and disposes pipes; killing a client never attests resource
  destruction. Late errors are absorbed without converting failure to success.
- Attach supplies backpressured, bounded streams (16 MiB stdin, jointly 8 MiB
  stdout/stderr) and a client-completion promise. Stream/process errors, timeout,
  cancellation and overflow kill/dispose the client. Grading transport retains
  its tighter 64 KiB total / 4096-byte observation bounds. An unreaped client
  remains a failed client, never a successful container cleanup.
- `grading-composition.ts` is the concrete consumer, not a campaign callback
  framework. It uses the same `gradingOwner` lifecycle and shared full-ID
  inspect/destroy/policy helpers. Its work controller shares 4.5 seconds across
  preparation/export/grading. Cleanup uses a separate 500 ms signal; the existing
  supervisor still bounds the entire close wait to 500 ms. No command gets a new
  candidate work allowance. The two operational factories unconditionally throw;
  their prepared real-spawn path remains unreachable.
- Exporter code has exactly three public sources: bootstrap, protocol, core.
  Grader's existing two-source roster is unchanged. Both container plans have
  exactly two bind mounts: public code read-only and exchange (read-only for the
  exporter). Producer and retained private roots are never mounted into either.
  Source rosters/hashes, separate nonoverlapping roots and observed container
  policy/mounts are checked. Cleanup rechecks full ID, image, owner token and
  mounts; it does not remove a wrong-policy object just because create returned
  an ID. Producer mapping is now exact and rechecked before destruction too.
- Exporter bootstrap bounds stdin to 16 MiB, response to 8 MiB, and uses the
  existing approved-Git reconstruction core only inside its proposed container.
  Canonical single-LF frames bind the original tree digest and approved Git
  digest. Duplicate/unsafe paths, invalid modes, noncanonical base64/UTF8,
  metadata mismatch and overflow reject. The request owns its original bytes
  before any await, rather than using the reduced-mode retained/exchange copy.
- A snapshot response is consumed only after successful exporter full-ID
  destruction and independent empty full-ID enumeration. Its file roster, hashes
  and original modes must equal the detached request. Existing owned snapshot
  evidence remains unavailable until grader destruction and retained/exchange
  verification. No comparator, bank, receipts or supervisor helpers enter the
  exporter roster. No host candidate runtime or candidate Git execution occurred.
- A submitted create without a confirmed full reply ID remains an unresolved
  obligation, including timeout, collision, malformed reply and late ID. There is
  no lookup/removal by generated name and no inference of absence from client
  death. A failed exporter cannot release evidence or advance to grader create.

## Mandatory remaining work / hard stops

1. **Independent software-slice review is complete: Approve, no findings.**
   Operational independent review and separately authorized restricted-host
   integration evidence remain required; this verdict opens no gate.
2. **No operational registry or trusted maintained producer launcher is
   installed.** Do not create launcher authority from SupervisorSpawnObservation
   or a test callback. Existing origin registry and no-subprocess retained audit
   policies are unchanged. The operational factory cannot be opened by a flag.
3. Required reviewed selections are still absent: absolute Docker executable
   **and hash**, private config ownership/permissions/contents, daemon endpoint
   and trust/topology, producer/grader/exporter namespace/storage ownership and
   mount topology, GID, Git executable version/hash, and full image loader/library
   closure. `DockerGradingSelection` is a preparation schema, **not an approved
   operational schema**; these missing approvals must become mandatory registry
   validations before either CLOSED factory is changed.
4. Supplied future image selection remains
   `sha256:edcbed99a004b66c67c0dd1d3ea794d6c0a2e83da18be770aeddedeff534dbff`.
   It was not probed or independently attested. Supplemental main/config evidence
   is not full dependency closure. All test image/source identities are invented.
5. Bootstrap/image execution, real daemon behavior and independent OS resource
   destruction have not been exercised. Only inert emitters were used. Core Git
   tests continue to run solely on authored fixtures. No Docker, installed-runtime,
   provider, SDK or procfs probes, dependency changes, spending, staging or commits.

## Verification and evidence

Observed RED: attach rejected as unavailable; missing snapshot protocol module.
A later backpressure test initially assumed the first forwarded write must block;
corrected it to fill the downstream and then assert the next write blocks. The
first composition typecheck caught a possibly-undefined pipe type; corrected to
an explicit Readable type. Neither failing run is represented as success.
Composition/create/late-ID and additional malformed-response tests are focused
characterization/regression coverage, not additional claimed preimplementation RED.

Supplied implementation commands from Guild (not reviewer-run or rerun for this
documentation-only finalization; targeted tests were repeated during implementation):

```
node --import tsx --test evaluation/test/grading-docker.test.ts
node --import tsx --test evaluation/test/grading-snapshot-protocol.test.ts
node --import tsx --test evaluation/test/grading-composition.test.ts
node --import tsx --test evaluation/test/grading-snapshot-protocol.test.ts evaluation/test/grading-owner.test.ts
node --import tsx --test evaluation/test/grading-docker.test.ts evaluation/test/grading-composition.test.ts evaluation/test/grading-snapshot-protocol.test.ts
node --import tsx --test evaluation/test/grading-docker.test.ts evaluation/test/grading-snapshot-protocol.test.ts
node --import tsx --test evaluation/test/grading-docker.test.ts evaluation/test/grading-composition.test.ts
npm run eval:test
npm run eval:typecheck
npm test
npm run typecheck
npm run eval -- validate
```

Root: `npm test`, `git diff --check`. Final totals: **480 evaluator / 136 Guild /
2 root tests**, both TypeScript checks passed. Bank digest unchanged:
`9254fe78fdf7580faf991b4936beec533a1327e54b4efa7f6ed9cffd87820f85`.
A uniquely named `e1-docker-composition-candidate-*` inventory/archive under
`.pi/evaluation/` retains source hashes and validation logs; no historical
manifest/archive is overwritten. Mixed-tree unrelated work is preserved.

## Reviewed evidence finalization and required next inputs

The current central `.pi/evaluation/e1-candidate-v2-independent-review-inputs.json`
now inventories concrete control/create/attach, shared owner helpers, snapshot
bootstrap/protocol/core and composition sources and their affected tests. Its exact
predecessor is `e1-candidate-v2-independent-review-inputs.pre-real-backend-reviewed.json`.
The unique deterministic `.pi/evaluation/e1-real-backend-reviewed.tar.gz` includes
current inputs, predecessor inventories and supplied validation logs. Partial and
composition-candidate archives remain unchanged historical checkpoints. Only hashes,
archive reproduction and diffs were checked here; no code/tests/gates were changed
and no tests, typechecks, bank validation or operational probes were rerun.

**Required next software:** trusted maintained producer-launcher registration and
attempt/daemon/container/namespace issuance, with mandatory registry validation of
all approved selections listed above and real private-storage ownership; connect
that authority to the prepared composition only under separately reviewed gate
changes. Diagnostic auth provisioning and reviewed SDK/refresh/request/meter
compatibility remain separate integration obligations. Do not rebuild the already
completed adapter/exporter or treat a test callback/observation as authority.

**External data/approval:** the exact executable/config/daemon/storage/GID/Git/image
closure selections above, approved producer and public source rosters, provenance
and ownership evidence, and separately authorized operational review/integration.
Supplied image metadata alone satisfies none of these approvals. All factories and
operational gates remain closed; no C1–C8 acceptance or host execution is claimed.

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
