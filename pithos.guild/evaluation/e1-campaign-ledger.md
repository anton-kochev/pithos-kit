# E1 campaign ledger — offline admission foundation

## Status and scope

**Admission-origin follow-up:** [scoped ledger origins](e1-admission-origin.md) now derive frozen parent inputs from the actual admitting handle and pending journal record. Copyable caller admission objects are not issuance authority. Native origin issuance remains disabled; launch/configuration integration is still pending.

**Native-policy follow-up:** [campaign spec v2](e1-native-policy.md) now requires an explicit closed native policy and matching pricing. It remains non-executable until launch/receipt binding is complete; the reviewed native cohort cannot enter through v1. Historical v1 native records remain inspectable without promotion or new writes. The v1 ledger history below is preserved.

**Follow-up:** the [execution bridge](e1-execution-bridge.md) now has offline tests for trial/artifact binding, deadline cancellation, evidence-derived settlement, and history re-audit. The later [base-pricing slice](e1-pricing-audit.md) freezes an optional pricing policy with the specification and audits it during settlement/resume without altering old unpriced evidence. Actual native observation and independent review remain required. The ledger-only verification and next-slice list below describe this earlier checkpoint.

**Implemented and offline-tested, not connected to live execution.** The ledger is the first campaign-control slice. `runTrial()`, `createPiDriver()`, grading, and the CLI were not changed by this increment. There is still no live-run command, and no campaign trials or provider calls were made.

This is not a complete budget controller or authorization to spend. The [approved smoke decisions](e1-smoke-campaign.md) remain unchanged, including the unresolved Pi 0.83.0 / `gpt-6-astra` catalog mismatch. Native deadline enforcement, verified runtime/input binding, evidence-derived settlements, and independent review remain pre-spend gates.

## Contracts

Repository-only modules:

- `src/campaign.ts`: specification validation, admission/settlement/checkpoint rules, monotonic active-time meter, replay validation.
- `src/campaign-store.ts`: private exclusive creation, transaction lock, bounded JSON records, checksummed journal and durable head.
- `test/campaign.test.ts`: synthetic filesystem/clock tests and a fresh Node-process resume probe. No Pi agent or model is launched.

`createCampaign(directory, spec)` creates a new private campaign, never reusing an existing directory. `openCampaign(directory, expectedSpec)` requires the same caller-supplied frozen specification. Every transaction checks it again against retained metadata. Allowances belong to this one retained campaign directory: the ledger does not police other directories or direct driver calls. The native entrypoint must bind the approved directory and never create a replacement campaign to reset limits on restart.

The versioned specification binds:

- bank, schedule, implementation, runtime, and environment/auth/pricing policy digests;
- explicit provider/model and thinking level;
- the exact ordered schedule, with unique adjacent main-only/Guild-available pairs and one repetition;
- workflow-count, estimated-usage, active-time, and per-workflow limits.

Validation rejects unknown fields, invalid digests/cohorts/schedules, and limits exceeding the approved smoke envelope: 12 workflows, $10 estimated usage, 60 minutes active time, five minutes per workflow. Tests use smaller synthetic limits and a fake cohort. These are evaluation-only bounds, not Guild defaults or an approval registry. Digests must ultimately be computed and checked against actual reviewed inputs by the native controller; supplying matching strings does not prove that has happened.

### Admission and accounting

`admit(observedBindings)` consumes only the next scheduled slot and durably records its UUID before returning permission. It rejects drift, an unfinished attempt, unknown spend/time, exhausted limits, integrity failure, or a pending first-pair inspection. Concurrent handles cannot both admit work.

`finish(id, receipt)` settles an attempt once, only through its admitting handle. A receipt contains a result digest, recorded/failed outcome, finite nonnegative estimated USD or `null`, and an integrity classification. These fields are validated, but their truth is not inferred by the ledger. **The next integration must derive them from retained parent-plus-child traces and preservation/grader evidence**, not caller claims or zero-filled tool aggregates.

Failures consume slots; unknown spend stays unknown and prevents further admission. Children contribute to the parent workflow's total estimate rather than consuming extra scheduled parent-workflow slots. The ledger itself does not yet count raw child attempts. The spend comparison stops up to one nanodollar early to avoid floating-point sums just below the threshold; recorded subtotals are not silently rounded or rewritten.

The monetary guard is an **estimated-usage admission limit**, never a guaranteed billing cap. An in-flight request may overshoot, late/missing usage cannot be recovered by a ledger, and subscription charges need not match catalog-priced usage.

### First-pair checkpoint

After the first two attempts settle with known accounting and intact evaluator/user-work boundaries, `inspectFirstPair(receiptDigest)` records an explicit inspection acknowledgement. It cannot run early, run twice, or clear an integrity failure or exhausted allowance. A digest is an audit reference to the operator's inspection, not automated proof that the inspection occurred or independent approval.

### Active time and interrupted attempts

Time is measured using the admitting handle's monotonic clock, from admission invocation through the settlement measurement. The caller must settle only after workflow and trusted grading have ended. Inactive gaps between attempts, including an operator pause, are not charged; final journal-flush overhead after the measurement is not included. Durably settled active time carries across reopen.

Admissions expose separate decreasing allowances:

- `remainingMs()`: the smaller of the workflow timeout and remaining active campaign time, less time already consumed;
- `remainingActiveMs()`: campaign time remaining, including time available for separately bounded grading after a workflow timeout.

Neither function installs a timer or kills a process. The native controller must enforce both deadlines, including the active-time boundary through grading. Late settlements retain overshoot rather than clamping it away and block future work when the allowance is exhausted.

A reopened handle cannot certify the duration or spend of an unfinished attempt. That attempt stays counted, its current total spend/time are unknown, and admission is blocked. There is no automatic retry, abandonment reset, crash reconciliation, or settlement through a replacement handle. Recovery requires operator investigation and separately designed/reviewed evidence reconciliation, not invented zero usage.

## Persistence and limits

The store requires an absolute path on a POSIX filesystem with private, owned directories/files and directory-sync support. Creation uses mode 0700 directories and exclusively created mode 0600 records. Reads reject nonregular, linked, shared-permission, malformed, or oversized record files; JSON reads are capped at 64 KiB. Parser errors do not echo record contents.

An exclusive `.lock` directory serializes each read/modify/write transaction. A stale lock is never stolen or automatically removed. A process crash may therefore stop the campaign even before an attempt starts; this is intentionally fail-closed. Investigate liveness, retained evidence, and any credential remnants before considering recovery. Do not blindly delete locks.

Each immutable event envelope contains its sequence, previous digest, event, and checksum. There can be at most 25 events: twelve starts, twelve finishes, and one inspection. Events are exclusively written and synced. A separately synced head is atomically replaced and its directory synced after each append. It anchors the count and final digest, detecting missing tails, including deletion of the only started record. Replay also validates event meaning, legal transitions, schedule identity, allowances, settlements, and checkpoint placement.

An incomplete write, head/event disagreement, invalid history, or unexpected journal entry blocks use; nothing is repaired, truncated, overwritten, or removed automatically. Private metadata and failed writes remain available for investigation.

These are cooperative local-filesystem controls, not hostile-code containment or tamper-proof accounting. Checksums cannot detect coordinated rewriting of the whole journal/head/spec or restoration of a consistent old snapshot. Same-user shell access, filesystem failures, and hard kills remain outside stronger guarantees. The store is not validated for Windows or network filesystems.

## Test-first evidence

The focused command for every cycle was `npm run eval:test` from `pithos.guild/`.

| Slice | Observed RED |
|---|---|
| New private campaign API | Missing `campaign.ts` module |
| Strict specification and frozen-input validation | Missing expected rejection |
| Durable admission and settlement | Missing `admit` method |
| Spend/trial limits and settlement validation | Missing expected rejection |
| First-pair inspection | Missing `inspectFirstPair` method |
| Monotonic active time and interrupted-handle protection | Missing `remainingMs` method |
| Separate campaign/grading allowance | Missing `remainingActiveMs` method |
| Exclusive lock and damaged journal rejection | Missing expected rejection |
| Semantic replay despite valid checksums | Missing expected rejection for an invalid slot |
| Decimal spend threshold | Expected `spend_limit` was absent for 0.3 + 0.6 at a 0.9 limit |
| Returned admission isolation | Caller mutation caused a frozen-spec mismatch |

Each returned GREEN with the same command after implementation.

The complete twelve-slot/fresh-process test is an intentional integration pin. Its sensitivity was verified without disabling real controls:

| Controlled mutation | Observed RED |
|---|---|
| Remove only the disposable test fixture's `head.json` before fresh-process reopen | Resume process failed with `Invalid campaign: unreadable, unsafe, or malformed journal record`, rather than returning twelve retained starts/finishes |

The mutation was removed, the test returned GREEN, and no real campaign or user data was altered.

Final verification observed on Node.js 24.20.0:

| Command/check | Result |
|---|---|
| Guild `npm test` | 135/135 passed |
| Guild `npm run typecheck` | Passed |
| `npm run eval:test` | 49/49 passed |
| `npm run eval:typecheck` | Passed |
| `npm run eval -- validate` | Six tasks valid; approved bank digest unchanged |
| `npm run eval -- schedule e1-development-1 1` | Offline schedule generated; no execution |
| Repository root `npm test` | 2/2 passed |
| Guild `npm pack --dry-run --json` | 39 files; evaluation/private artifacts excluded |
| `git diff --check` | Passed |

No dependency, version, lockfile, prompt, production Guild source, or publish-metadata changes were made in this increment. Nothing was staged or committed. Independent review remains pending.

## Next slice — still required

1. Compute/freeze actual bank/schedule/implementation/runtime/cohort/policy observations, resolve the approved model's absence, and check them immediately before native launch.
2. Bind each durable admission UUID to retained trial artifacts before setup; preserve failures before `runTrial()` can write a result.
3. Enforce workflow and active-campaign deadlines against process groups and separately bounded grading. A remaining-time accessor is not enforcement.
4. Derive settlement cost/completeness/integrity from retained raw evidence and validated final state. Pause on uncertainty; do not trust summary fields alone.
5. Obtain fresh independent review outside the failed Bun launch path and resolve material findings before enabling live execution.

No held-out promotion, Phase 2, staging, commits, versions, or publishing is authorized by this increment.
