# Owned snapshot export — reviewed inert candidate preparation only

Current follow-up: [connected finalization-to-receipt inert preparation](trial-finalization-preparation.md)
now consumes this evidence through the maintained runner and V3 receipt auditor.
The text below preserves the independently reviewed snapshot-only checkpoint;
its missing receipt-connection statements are historical. Operational issuance,
isolated export for real candidates and all execution gates remain closed.

Independent reviewer verdict: **Approve, no findings**; the Medium caller-owned
snapshot TOCTOU finding is resolved. Approval covers bounded inert preparation
only, not operational confinement or host Git execution against real candidates.

Operational entry `confinedSnapshotExport()` rejects unconditionally, as does
`confinedGradingOwner()`. No candidate path is wired to host Git. The runnable
adapter requires Node's test context and is solely for locally authored inert
fixtures; this check is not a security/isolation boundary. An approved isolated
exporter, image/Git inventory and transport are still missing. Existing ordinary
`snapshot()`, grading semantics, receipts and all operational Gates are unchanged.

## Supported contract

The supervisor independently approves `snapshotGitDigest` over the exact HEAD,
index and loose-object materialization. It must not accept a producer's claimed
approval. Only the fixture's unborn `eval` branch with ordinary SHA-1 loose-object
metadata is supported. Linked worktrees, alternate object stores, packs, refs,
replacement refs, shallow metadata, hooks, nested repositories and `.gitmodules`
are denied. Split/sparse index or other extension-dependent configurations are
not supported; only independently approved ordinary fixture indexes qualify.
No Git parser is introduced. Future support for other baselines needs a reviewed
contract, not synthesized status/index/diff fields.

Repository config and description are never copied into reconstructed Git
metadata. No host Git invocation occurs against the source/retained/exchange
repository. A disposable reconstruction restores original working-file modes,
uses fixed `/usr/bin/git` commands, clears inherited environment, disables
system/global configuration, fsmonitor, hooks, pager, autocrlf, external diff and
textconv. Git emits the existing Snapshot index/status/diff format. Collection,
Git output/time, total JSON emission and cancellation are bounded. Temporary
reconstruction is removed on success/failure. Actual untrusted index/object
processing must occur **inside future confinement**, not in the supervisor.

## Ownership connection

`inertGradingOwner` optionally prepares the snapshot from its bounded original
read after producer removal and before grader attach. Its `snapshotEvidence()`
returns a detached versioned record only after confirmed cleanup, rechecking
both retained and exchange normalized materializations. Evidence binds the same
attempt/grading/artifact/observer identities used by observations, the approved
Git digest, the normalized materialization digest, original directory/file
modes/content manifest (including empty directories), snapshot and snapshot
digest. Copies remain 0600/0700; those normalized modes never replace original
Snapshot modes. Altered retained or exchange content/modes cannot yield evidence.
The method does not claim a grade passed: a future receipt must consume this
record **and** the comparator result under the identical binding. No receipt
integration or operational ownership claim is made in this slice.

## Verification

RED: missing `grading-snapshot.ts` for the new exporter test; subsequently
`owner.snapshotEvidence is not a function` for the connected owner test.
GREEN: 24 focused tests, including safe self-authored fsmonitor sentinel positive
control, hostile-config nonexecution in export, benign Snapshot equality,
original executable modes despite normalized retention, empty directories,
retained alteration rejection, unsupported layouts, bounds and cancellation.

Commands (from `pithos.guild`):

- `node --import tsx --test evaluation/test/grading-snapshot.test.ts`
- `node --import tsx --test --test-name-pattern='owned snapshot evidence' evaluation/test/grading-owner.test.ts`
- `node --import tsx --test evaluation/test/grading-snapshot.test.ts evaluation/test/grading-owner.test.ts evaluation/test/grading-owner-cancellation.test.ts`
- `npm run eval:typecheck`
- `npm run eval:test` (417 passed; `/tmp/grading-snapshot-eval.log`)
- `npm test` (136 passed; `/tmp/grading-snapshot-guild.log`)
- `npm run typecheck`

Root: `npm test` (2 passed), `git diff --check`.
No Docker/provider/SDK/procfs/installed-runtime probes, dependencies, runtime
changes, spending, staging or commits. This is self-verification, not independent
acceptance or operational promotion.

## Independent Medium follow-up: caller-owned snapshot TOCTOU

`inertSnapshotExport` now synchronously copies every Map entry, entry mode and
file Buffer before validating the approved Git digest or reaching its first
await. Entry/aggregate-byte limits bound copying; validation, reconstruction and
hashing then exclusively use the detached tree. Later caller mutations cannot
change approved index bytes or produce mixed working-file/hash/status views.
This is cooperative caller ownership, not hostile shared-memory isolation.

TDD RED: immediate Map replacement/insertion, working Buffer mutation and entry
mode mutation produced snapshots differing from the original; immediate index
Buffer mutation reached Git with `fatal: index file corrupt`. The same tests now
all return the original approved snapshot. An initial fixture omitted required
`untracked: {}` and was corrected before behavioral RED; that setup error is not
counted as regression evidence. Existing approval mismatch rejection is retained.

Supplied implementation commands (not independently rerun for this
documentation-only finalization; Guild directory; logs `/tmp/snapshot-toctou-*.log`, also
retained under `validation/` in the review archive):

- `node --import tsx --test evaluation/test/grading-snapshot.test.ts` (RED: 4 failures; GREEN: 5 passed)
- `node --import tsx --test evaluation/test/grading-snapshot.test.ts evaluation/test/grading-owner.test.ts evaluation/test/grading-owner-cancellation.test.ts` (28 passed)
- `npm run eval:typecheck` (passed)
- `npm run eval:test` (421 passed)
- `npm test` (136 passed)
- `npm run typecheck` (passed)
- `npm run eval -- validate` (passed; unchanged bank digest `9254fe78fdf7580faf991b4936beec533a1327e54b4efa7f6ed9cffd87820f85`)

Root `npm test` (2 passed), `git diff --check` and scoped whitespace checks passed.
No real candidate/runtime/SDK/provider/procfs/Docker probes or execution-gate
changes. Confined export/owner and native admission/preload/driver/history/
settlement remain closed. No receipt integration or C1–C8 promotion. This fixes
the supplied independent finding; independent re-review returned **Approve,
no findings**. The Map, entries, modes and Buffer bytes are synchronously detached
before approval validation or any await; approval through reconstruction and
hashing uses only the clone. This is not hostile shared-memory isolation.

The prior manifest omitted this snapshot preparation slice and still hashed
pre-snapshot `grading-owner.ts`/`grading-owner.test.ts`. The refreshed inventory
includes those current connected inputs plus `grading-snapshot.ts`, its test and
this preparation record; this is bookkeeping, not a new owner implementation or
retroactive review approval. The exact predecessor manifest is preserved as
`.pi/evaluation/e1-candidate-v2-independent-review-inputs.pre-snapshot-toctou.json`;
new deterministic archive `.pi/evaluation/e1-grading-snapshot-toctou.tar.gz`
retains the refreshed manifest, inputs and validation logs. Older archives are
unchanged.

## Reviewed documentation finalization

The supplied 421 evaluator / 136 Guild / 2 root test results and both typechecks
were not independently rerun. This finalization verifies hashes and diffs only.
The refreshed manifest and unique deterministic
`.pi/evaluation/e1-grading-snapshot-toctou-reviewed.tar.gz` retain the reviewed
record; `.pi/evaluation/e1-candidate-v2-independent-review-inputs.pre-snapshot-toctou-reviewed.json`
preserves the exact preceding manifest. All previous snapshots/archives remain
unchanged.

The remaining connection is the maintained runner/receipt route:
`runCampaignNext -> runTrial` still records pending confined finalization, and
`receiptFor -> deriveCampaignTrialReceipt -> deriveNativeTrialReceipt` still
rejects V3 before host Git. A future receipt must consume owned snapshot evidence
and the comparator result under the identical binding. Trusted operational owner
registration, an approved isolated exporter/image/Git/runtime inventory and
transport, the host adapter/rosters and snapshot-to-receipt mapping remain missing.
`confinedSnapshotExport()` and `confinedGradingOwner()` still reject
unconditionally. No code, tests, probes, gates, dependencies, spending, staging
or commits changed; no C1–C8 promotion or operational approval.
