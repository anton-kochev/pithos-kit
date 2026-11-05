# Pi semantic interrupt, atomic owned tools and parent continuation — uninstalled proposal

This proposal is **uninstalled and unpublished—bounded connected continuation qualification, not general runtime certification**. Stock Pi 1.4.0 remains unchanged and does not expose this capability; background operation requiring it remains unavailable there. No installed runtime patch, upstream submission, release, dependency installation, or live-provider call is part of this revision.

## Origin and artifacts

The base is public `earendil-works/pi`, tag `v1.4.0`, exact commit [`4a080252f06caf63a525d7873c5d94d3c23887e0`](https://github.com/earendil-works/pi/tree/4a080252f06caf63a525d7873c5d94d3c23887e0).

- [`pi-v1.4.0.patch`](pi-v1.4.0.patch): **16 source files (13 tracked + 3 new), 3,272 insertions, 1,269 deletions; 225,574 bytes**. SHA-256 `018c10ff06b72b020634692e1d209ce70acbb4ffc82ee6959d4252162ccaca59`. The exact module inventory lives in [`overlay.mjs`](overlay.mjs); no provider tests are exported.
- [`overlay.mjs`](overlay.mjs) and [`overlay.d.mts`](overlay.d.mts): shared manifest, exact production provenance, protected hashes/absences, and all-module transpilation used by all three launchers (portable, legacy semantic, and continuation).
- [`interrupt.test.mjs`](interrupt.test.mjs): provider-free regression harness using the real interactive renderer and extension runner, **42 tests including subtests**.
- [`verify.mjs`](verify.mjs): exact-source-gated explicit-input verifier; creates and removes a temporary runtime copy, never applies the patch.
- [`LICENSE.upstream`](LICENSE.upstream): unchanged upstream MIT license, copyright © 2025 Mario Zechner.

## Proposed contract

```ts
export type InterruptRetirementReason =
  | 'ui-reset' | 'ui-stop' | 'runner-rebind' | 'runner-invalidate';

export interface SemanticInterruptV1 {
  readonly protocol: 'pi-semantic-interrupt-v1';
  subscribe(
    onInterrupt: () => void | Promise<void>,
    onRetire: (reason: InterruptRetirementReason) => void,
  ): () => void;
}

// In ExtensionUIContext:
readonly semanticInterrupt?: SemanticInterruptV1;
```

This intentionally replaces the **unpublished** bare `onInterrupt` prototype. There is no old alias or environment flag. Check the exact protocol and callable method, then establish a live subscription: presence alone is insufficient. Registration throws during reset, after stop, on stale runner bindings, or if retirement happens before registration returns. A successful subscription returns a function disposer. This is a **trusted host assertion, not a security attestation**; it cannot make an untrusted in-process extension safe. False-capability prequalification belongs to the consuming adapter, not this harness.

The named types are declared in `core/extensions/types.ts`; the atomic contract adds public type exports in both package barrels. Consumers can derive the semantic capability type from `ExtensionUIContext['semanticInterrupt']`.

### Dispatch and lifetime

Notification occurs at the four existing native default, retry, compaction, and branch-summary interrupt callback sites, including default dispatch while idle. Synchronous listener prefixes run before the built-in action. Promises are observed but **not awaited**. Listeners cannot consume or replace the action. Dispatch snapshots independent registration records: removal skips a later entry, and additions wait until the next dispatch. Registering the same function twice creates two lifetimes.

Semantic-interrupt notification is not a raw-key listener or shortcut takeover. Escape consumed by a dialog, autocomplete, or panel does not notify. Notification preserves remapped/disabled bindings, double-Escape actions and the existing native abort action. Custom editors delegating to the native callback are supported; nondelegating custom editors are not covered. `CustomEditor` and raw-key routing are not patched. Separately, the current 16-module continuation proposal changes `AgentSession.abort` to invalidate continuation authority and adds RPC lifecycle/shutdown fences. The SDK fallback tests below do not qualify RPC process behavior.

Manual unsubscribe is idempotent and **silent**. Host retirement delivers its first reason synchronously, once, after fencing and detaching records. It does not await callbacks, and callback throws or accidentally returned rejected promises cannot stop cleanup. Old disposers cannot remove new registrations. Reset raises a depth fence before retirement and lowers it in `finally`, even on nested reset or throwing widget disposal. Registrations during reset or after stop throw; fresh registrations after reset are allowed. Stop fences before retirement callbacks and native teardown.

The runner wraps—not forwards—the capability. Pending records exist before calling raw `subscribe`, with the original method receiver. It validates the returned disposer and rechecks liveness after that call. Synchronous host retirement or reentrant invalidation/rebind during registration rejects the subscription and releases a returned resource once. Raw callbacks retained after removal are inert. If a raw host throws without returning a disposer, the runner can fence its local record but cannot release an opaque resource the host never exposed; that host owns failed-registration cleanup. Rebind/invalidate fence all records before notifications, then dispose resources even when notification fails. Host retirement followed by runner invalidation does not notify twice. Reentrant `setUIContext` during transition throws; invalidation from a retirement callback prevents publishing the replacement binding.

### Error isolation

Live interrupt handler failures use the native host's existing `showError` isolation. Error conversion/reporting failures cannot block abort. Late asynchronous failures after removal are suppressed. Retirement notifications and raw disposer failures are caught independently, including accidental promise rejection; **the fallback is suppression, not painting a potentially stale UI**. There is no new logging/provider channel. Native action and widget-disposal errors retain their original behavior and can still throw.

## Reproduce in isolation

Requirements: POSIX, Node **>=22.19**, an already patched source checkout, an existing `@earendil-works/pi-coding-agent` **1.4.0** package with its unbundled SDK/dependencies, and an existing TypeScript module supporting `rewriteRelativeImportExtensions` (5.7+). The portable runs used Node **24.20.0** and TypeScript **5.9.3**.

Use an existing exact-pinned source checkout with the selected proposal changes. No install or clone is needed. For a separate applicability check, archive its pinned HEAD to a **fresh** disposable directory; never apply to the preserved base or installed package:

```sh
source=/path/to/patched-source-checkout
base=$(mktemp -d "${TMPDIR:-/tmp}/pi-atomic-apply-XXXXXX")
git -C "$source" archive 4a080252f06caf63a525d7873c5d94d3c23887e0 | tar -x -C "$base"
git -C "$base" apply --check "$PWD/proposals/pi-interrupt-hook/pi-v1.4.0.patch"
```

The archive is an applicability fixture, not the verifier input (which needs Git metadata).

Then run, quoting paths:

```text
node proposals/pi-interrupt-hook/verify.mjs <patched-source-checkout> <installed-coding-agent-package> <typescript-module-file>
```

There are **no defaults and no automatic patch application**. Existing local inputs are `/opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent` and `./pithos.guild/node_modules/typescript/lib/typescript.js`, not installation targets.

All three launchers pin HEAD and enumerate **all** changed tracked and nonignored untracked production paths using `:(glob)packages/*/src/**`. Each inventory must equal the shared manifest before exact patch comparison. Tracked diffs and sorted new-file `--no-index /dev/null` additions (expected exit 1) use explicit `a/` and `b/` prefixes. Source contents are not normalized. Unexpected production paths fail even if selected modules match. Internal symlinks/aliases are rejected; input ancestor aliases are canonicalized once.

All **16** modules, including SDK/runtime/services, main, print/RPC and the three new helpers, are transpiled into a complete disposable unbundled SDK copy. This is `transpileModule` with TypeScript **5.9.3** and relative-import rewriting, **not a typecheck or declaration build**. Copied declarations/maps are not rebuilt. Existing output overwrite targets must be canonical non-symlink single-link files; new output paths must not exist, even as dangling links.

Dependencies are linked read-only **by convention**, not an OS-enforced sandbox. All three children retain allowlisted environments, isolated storage and process-group cleanup. Portable and legacy semantic deadlines are 30 seconds; continuation is 90 seconds. Portable stdout/stderr caps are **1,048,576/65,536 bytes**; legacy semantic and continuation caps are **131,072/8,192 bytes**. Before/after protection covers **54 existing installed files** (package metadata, bundled CLI and 13 four-artifact module sets), plus **12 absence assertions** for the three new module sets. Checks run in `finally`, including after child errors; this is not a digest of all dependencies. Runtime JS SHA-256 values for all 16 outputs are printed separately.
The bundled CLI is not copied or rebuilt. The native worker receives the disposable unbundled `dist/cli.js` path to locate the package, then imports its SDK and runs the existing public session/runtime pipeline; this does **not** qualify a newly compiled CLI binary. Installed 1.4.0 has an `agent-session` `displayText` delta absent at pinned HEAD despite equal versions. This is an **exact pinned-source overlay**, not a claim of identical installed behavior.

### Atomic owned-tools contract and scope

Optional `ExtensionAPI.atomicOwnedTools`, protocol `pi-atomic-owned-tools-v1`, binds a fixed name group to the loader's factory identity and session/core generation. `bind(names, onRetire)` returns a live handle with `isActive`, `update`, and `dispose`. Updates supply the complete group with per-name `preserve | activate | deactivate | default` policies; they preserve foreign selection/order. Results are `committed` or `aborted` with `conflict | stale | ownership | invalid | prepare-failed`. Failed withdrawal retains ownership for retry. Supersession/core rebind/runtime invalidation fence handles before contained retirement callbacks. Manual successful disposal is silent/idempotent.

The registry-write coordinator stages publication and fences stale outer writes after reentrant hooks; it does not restore snapshots or loop legacy registration. Definitions/schemas are copied without freezing callers; other nested metadata remains shared. This is a trusted in-process contract, not a hostile-proxy security boundary or exhaustive schema validator.

`core/parent-continuation.ts` is included. Portable and legacy suites alone do **not** qualify automatic continuation; the separate unmasked 16-case suite below does so within its stated boundaries. The legacy fixture masks **only** `ctx.parentContinuation` in every event (including input), tool and command callback delivered to Guild through forwarding facades. SDK contexts are not mutated, and semantic/atomic capabilities remain exposed. The worker logs `legacyAtomicCapabilityMask: true`. Its factory forwards `continuationRuntimeGate` into services/SDK **at construction**, before runtime binding. The portable fake runtime adds no-op input/transition/shutdown interface scaffolding only. Neither change weakens assertions or adds wake proof.

### Owned cleanup and foreign input

Continuation receipts and lease closure join the owned preparation, run, publication and settlement callbacks—not separately submitted native actions. After that cleanup, the host explicitly starts its independently tracked native FIFO. External idle joins still await the FIFO; an active, same-session drain descendant cannot join its own pump. Expired or cross-session descendants retain external join semantics. Foreign action errors keep their native result/reporting channels and do not change the owned receipt outcome. This unpublished clarification fixes a reload/closure cycle without weakening Guild's cleanup joins. Known commands are controls, not runnable model input; `/plan` refusal does not cancel a pending receipt. Plan idle entry closes delivery before activation; exit does not reopen it.

## Current command overlay: portable and legacy qualification

The current 225,574-byte artifact exports the frozen command/core-guard/native-queue/mode changes from `/tmp/guild-continuation-source-prRCx3`. All production paths were enumerated again: **13 tracked + 3 new**, unchanged manifest. Exact canonical source comparison and all 16 transpiles passed before worker admission; a fresh local pinned archive passed `git apply --check`.

- Portable **42/42** and legacy semantic **8/8** passed with fixtures, assertions and counts unchanged; no additional fake API scaffolding was needed. Both native Plan orders and native branch passed. The legacy worker logged `legacyAtomicCapabilityMask: true`, preserving the `ctx.parentContinuation` mask rather than asserting continuation behavior.
- Both runs retained **54 installed hashes + 12 absence checks**, SDK/AI identity checks (native), storage guards (native), and sandbox cleanup. No installed files, provider source, dependencies or package metadata were changed.
- Isolated source-copy mutations to `parent-continuation`, `agent-session`, and an unexpected production file each rejected before child/sandbox admission; each restoration passed **42/42**. No live source mutation was used.
- Evidence: `/tmp/guild-continuation-command-overlay-evidence.md`; incremental delta: `/tmp/guild-continuation-command-overlay-incremental.delta`; runtime hashes: `/tmp/guild-command-export-runtime-hashes.json`.
- Before export, the historical **209,923-byte** owned-drain artifact (SHA-256 `93db52093fbee8c44d24b6134ab5838689cd10e7a9cf13d87f2a24b2ab11a7a5`), README and portable fixture were preserved in `/tmp/guild-command-export-checkpoint-h8oskC`. Its exact source gate rejected current source before worker/sandbox admission as expected.

This export is portable/legacy fallback evidence only. Separate parent verification of the same artifact passed the strict **16/16 unmasked connected continuation** matrix, Guild **919** tests/typecheck/70-file package dry-run, and selected provider-source **543** tests with **36 configured skips**, plus root TypeScript checking. See [Guild reproduction commands and evidence boundaries](../../pithos.guild/README.md#background-qualification-and-shared-scheduling). The actual three-child shared-cwd RPC run is separate stock-CLI transport evidence, not proposal CLI qualification. No compiled proposal CLI, physical TTY, live-provider, broad-version or full upstream-suite/build certification is claimed.

### Conditional parent continuation

Optional context `parentContinuation`, protocol `pi-parent-continuation-v1`, permits automatic delivery to a healthy eligible parent only after live qualification. Without it, qualified semantic/atomic background tools retain UI/status-only delivery. Before commit, revocation leaves no owned notice or turn; after commit but before start, the notice remains without a turn; after start, only the matching owned run is aborted. Unknown persistence suppresses duplicate retries and signals recovery—not crash-atomic exactly-once delivery.

Native input may revoke one pending request while preserving its lease; genuine fresh idle can retry a definitely uncommitted batch under the same owner. This is not rearm after semantic interrupt: interrupted/retired parents never restart automatically. Native busy tree/reload guards remain intact. A rejected attempt may conservatively retire continuation authority without cancelling children or completing a transition; accepted pre-dispatch transitions drain and publish. Old facades never revive. Explicit queued native user intent can follow Runtime replacement through its shared input ticket; automatic continuations and captured commands remain epoch-bound.

## Full-overlay atomic-fallback verification (pre-drain-fix checkpoint)

The following evidence covers the preceding 205,833-byte artifact, not the current command/core-guard/native-queue revision.

Source: `/tmp/guild-continuation-source-prRCx3`; evidence: `/tmp/guild-continuation-overlay-evidence.md`; owned delta: `/tmp/guild-continuation-overlay-owned.delta`. Old atomic source `/tmp/guild-host-contracts-source-8MTn43` was not modified; prior patch/verifier/tests/README and evidence were saved in `/tmp/guild-continuation-old9-snapshot` before export.

- Old nine-module gate rejected the frozen source before child/sandbox admission (`guild-continuation-red.log`).
- Fresh local pinned archive passed `git apply --check` (`guild-continuation-apply.log`), without fetch/install.
- Portable **42/42** and legacy native **8/8**, unchanged names/counts/assertions (`guild-continuation-portable.log`, `guild-continuation-native.log`). All installed protections unchanged; native storage guards passed and sandboxes removed.
- Isolated source copies: new `parent-continuation`, tracked `agent-session`, and unexpected production file each rejected before sandbox/child; each restoration passed 42/42 (`guild-continuation-{newfile,tracked,unexpected}-{red,green}.log`). Live source/installed files were never mutated.
- Dangling-link absence control: `guild-continuation-absence-{red,green}.log`.
- Guild typecheck and root 3-test suite passed (`guild-continuation-{typecheck,root}.log`). Full Guild/provider suites, build, RPC process continuity and compiled CLI/TTY/live-provider behavior were not run or certified here. Main/RPC/print modules are included, not process-tested by the SDK probe. The separate connected 16-case suite was outside that checkpoint's scope.

### Shared launcher API

`files`, `trackedFiles`, `newFiles`, `protectedFiles` are the single module inventory. Call `qualifySource(source, proposal)` before creating a runtime sandbox; `digests(installed)` before copying and again in `finally`; `transpileOverlay(source, runtime, sandbox, compiler)` after a safe complete unbundled SDK copy. It returns and logs the 16 JS hashes. Inputs must be canonical validated local paths; the caller owns package/SDK/compiler identity checks, safe copy, environment, child process lifecycle, storage checks, output validation, and cleanup. `overlay.d.mts` exposes a typed compiler API without runtime dependencies. New continuation fixtures must not use the legacy capability mask.

## Nine-module atomic overlay verification (historical)

Evidence: `/tmp/guild-atomic-native-overlay-evidence.md`; owned delta: `/tmp/guild-atomic-overlay-owned.delta`. Source: `/tmp/guild-host-contracts-source-8MTn43`, exact HEAD above.

- Pre-export unchanged native command rejected the old three-file artifact against new source **before child admission**, not by timeout: `/tmp/guild-atomic-overlay-red.log`.
- Expanded artifact passed fresh archive `git apply --check`: `/tmp/guild-atomic-overlay-apply.log`.
- Portable **42/42**, unchanged test file: `/tmp/guild-atomic-overlay-portable.log`.
- Unchanged native **8/8**, including both required Plan orders and native branch: `/tmp/guild-atomic-overlay-green.log`. The Plan cases retain foreign selection and do not resurrect Plan after exit.
- Separate isolated mutations to new `atomic-owned-tools.ts` and tracked `agent-session.ts` each failed exact provenance before admission; restoring each returned **8/8**: `/tmp/guild-atomic-overlay-{newfile,tracked}-{red,green}.log`.
- All successful runs verified **30 hashes + 8 absences** unchanged and removed their runtime sandboxes; native storage guards passed.
- Root `npm test`: **3 passed**; Guild `npm run typecheck`: passed (`/tmp/guild-atomic-overlay-{root,typecheck}.log`). Full Guild/provider suites and build were not rerun in this overlay task; earlier provider 124 and Guild 852 results are separate evidence, not new runs here.

## Earlier semantic-only evidence (historical)

The following describes the previous three-file revision, not the current artifact size or overlay coverage.

For upstream checks, reuse already available matching lockfile dependencies and release model data in the disposable checkout. This revision copied the prepared dependency trees and ignored model data without installing anything or refreshing catalogs. Run `npm run check:model-data`, `npm run check`, and the five focused suites below. Do not install dependencies or regenerate providers merely to reproduce this revision without separate authorization.

### Historical evidence and limits

New owned source for parent native-integration work: `/tmp/guild-semantic-v1-source-eELJcw`. Clean exact-base archive for patch applicability: `/tmp/guild-semantic-v1-base-eELJcw`. The earlier `/tmp/pi-interrupt-source-M5tSHF` and `/tmp/pi-interrupt-original-71AUGS` were not edited.

Evidence index: `/tmp/guild-semantic-v1-proposal-evidence.md`; reviewable proposal delta: `/tmp/guild-semantic-v1-owned.delta`.

- Five observed red/green cycles migrate the original 26 tests, add native and runner retirement cases, drive pending registration failures, and mutation-check manual unsubscribe. Logs: `/tmp/guild-semantic-v1-{red,green}{1,2,3,4,5}.log`.
- Final portable verifier: **42/42 passed**, child exit 0, 11 protected installed hashes unchanged, sandbox removed (`/tmp/guild-semantic-v1-final.log`). The final suite against the preserved old prototype fails **42/42**, as expected for the incompatible contract (`/tmp/guild-semantic-v1-old-prototype.log`).
- Exact-base `git apply --check` passed (`/tmp/guild-semantic-v1-apply.log`). Exported patch equals the new checkout's three-file diff.
- Release model-data validation and full **`npm run check` passed**; final Biome pass checked 1,535 files with no fixes, followed by dependency/import/entry-graph/install-lock checks, TypeScript **7.0.2**, and browser checks (`/tmp/guild-semantic-v1-model-data.log`, `/tmp/guild-semantic-v1-check-final.log`).
- Five existing upstream suites passed **72/72** with Vitest **4.1.11**: `custom-editor-history-keybindings`, `extensions-runner`, `interactive-mode-compaction`, `interactive-mode-extension-dialogs`, and `interactive-mode-tree-navigation` (`/tmp/guild-semantic-v1-upstream-tests.log`).
- The pre-existing five tracked dirty files remain byte-identical at the Git-diff level (`before.diff` versus `preserved.diff` under `/tmp/guild-semantic-v1-`). Verifier and license remain unchanged.

Historical **26/26** evidence and earlier independent approval in `/tmp/pi-interrupt-parent-final.log`, `/tmp/pi-interrupt-portable-verify.tap`, and `/tmp/pi-interrupt-deps-*` describe the superseded bare-hook prototype, **not approval of this revised contract**. The original cases are migrated here, not discarded. No previous approval is carried forward.

These tests exercise real renderer/editor/selector/runner behavior with fake terminal and session-operation boundaries. They are **not** full upstream-suite/build, live-provider, end-to-end TUI/Guild certification, or proof of any minimum supported Pi version below this pinned base. These historical results do not substitute for the current bounded 16-case connected qualification above. Installed Pi remains untouched; applying a runtime patch requires separate permission.
