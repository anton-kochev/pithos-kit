# Pi semantic interrupt hook — uninstalled proposal

This tested proposal is **uninstalled and unpublished—not full Guild integration**. The patch has not been applied to installed Pi; source changes and runtime verification were confined to isolated copies. Installed upstream Pi 1.4.0 lacks this capability. No upstream submission, merge, or release is claimed.

## Origin and artifacts

The base is public `earendil-works/pi`, tag `v1.4.0`, exact commit [`4a080252f06caf63a525d7873c5d94d3c23887e0`](https://github.com/earendil-works/pi/tree/4a080252f06caf63a525d7873c5d94d3c23887e0), cloned in isolation.

- [`pi-v1.4.0.patch`](pi-v1.4.0.patch): **3 source files, 126 insertions, 28 deletions**. It changes `core/extensions/types.ts`, `core/extensions/runner.ts`, and `modes/interactive/interactive-mode.ts` under `packages/coding-agent/src/`.
- [`interrupt.test.mjs`](interrupt.test.mjs): provider-free regression harness using the real interactive renderer and extension runner.
- [`verify.mjs`](verify.mjs): explicit-input verifier that creates and removes a temporary runtime copy; it does not apply the patch.
- [`LICENSE.upstream`](LICENSE.upstream): upstream MIT license, copyright © 2025 Mario Zechner.

## Proposed contract

The optional, TUI-only API is:

```ts
onInterrupt?(handler: () => void | Promise<void>): () => void;
```

Feature-detect `typeof ctx.ui.onInterrupt === "function"` before registering; do not infer availability from a version. Each registration returns an independent disposer, including repeated registration of the same handler.

Notification occurs at the native default, retry, compaction, and branch-summary interrupt callbacks, including default dispatch while idle. Listener synchronous prefixes run before the built-in action. Promises are observed but **not awaited**; listener throws, rejections, and diagnostic failures are isolated. Listeners cannot consume or replace the native action.

This is not a raw-key listener or shortcut takeover. Escape consumed by a dialog, autocomplete, or panel does not notify. Remapped/disabled interrupt bindings and normal double-Escape behavior remain native. Custom editors delegating directly to the native callback are supported; nondelegating custom editors are not covered by that claim.

Subscriptions retire on UI reset, runner rebind/invalidation, or stop; stale bindings reject registration. The reentrant-reset regression is fixed with a depth fence: disposal cannot register new listeners while an outer reset remains active, even after nested reset or disposal failure. Retired asynchronous failures do not repaint.

There is no `Session.abort` or RPC semantic change. Active programmatic cancellation remains a separate signal channel; this proposal does not choose Guild cancellation policy or defaults.

## Reproduce in isolation

Run from the pithos-kit root. Requirements: POSIX, Node **>=22.19**, an already patched source checkout, an existing `@earendil-works/pi-coding-agent` **1.4.0** package with its unbundled SDK and dependencies, and an existing TypeScript compiler module supporting `rewriteRelativeImportExtensions` (5.7+). The focused verifier used **Node 24.20.0 on Linux and TypeScript 5.9.3**. A subsequent, user-authorized upstream validation installed pinned development dependencies **only in the disposable source checkout**, with lifecycle scripts disabled; see below.

Optional preparation creates a fresh temporary clone, verifies its exact base, and applies the patch **only there**:

```sh
(
  set -eu
  repo=$(pwd -P)
  source=$(mktemp -d "${TMPDIR:-/tmp}/pi-interrupt-source-XXXXXX")
  git clone --depth 1 --branch v1.4.0 https://github.com/earendil-works/pi.git "$source"
  test "$(git -C "$source" rev-parse HEAD)" = \
    4a080252f06caf63a525d7873c5d94d3c23887e0
  git -C "$source" apply --check "$repo/proposals/pi-interrupt-hook/pi-v1.4.0.patch"
  git -C "$source" apply "$repo/proposals/pi-interrupt-hook/pi-v1.4.0.patch"
  printf 'Patched source: %s\n' "$source"
)
```

Then invoke the verifier with all three paths, replacing the placeholders:

```text
node proposals/pi-interrupt-hook/verify.mjs <patched-source-checkout> <installed-coding-agent-package> <typescript-module-file>
```

There are **no defaults and no automatic patch application**. Quote paths containing spaces. Local existing examples are `/opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent` and `./pithos.guild/node_modules/typescript/lib/typescript.js`; they are inputs, not installation targets. No historical scratch path is required. The preparation clone remains for inspection; the verifier removes its own runtime sandbox.

The verifier validates package identities/versions, copies unbundled `dist` without the CLI bundle, and transpiles only the three source files into that copy. This is `transpileModule` verification, **not typechecking or a declaration/full build**. Runtime dependencies are symlinked and read-only **by convention**, not by an OS sandbox or read-only mount. Only temporary copies are intentionally changed.

The test child receives a sanitized allowlisted environment and temporary HOME/config/agent/cwd/tmp directories. It has a 30-second deadline and bounded output (1 MiB stdout, 64 KiB stderr). SHA-256 checks compare **11 selected installed files** before/after: package metadata, bundled CLI, and the three affected JS/declaration/map sets—not every dependency.

## Recorded evidence and remaining gates

Both `/tmp/pi-interrupt-parent-final.log` and `/tmp/pi-interrupt-portable-verify.tap` record **26/26 passing tests**, including subtests. The portable run records child exit 0, unchanged protected-file hashes, and sandbox removal. `/tmp/pi-interrupt-harness/README.md` retains historical scratch commands and regression evidence.

Tests exercise real renderer input routing, editors, selectors, and `ExtensionRunner`, with fake terminal/session-operation boundaries. They are **not end-to-end TUI/Guild certification**, live-provider coverage, or proof of a minimum supported Pi version `>=1.0`.

The initial independent reviews reported no code issues, but their verdict was **Comment** because upstream checks were missing. That validation gap has since been closed without changing the patch:

- User-authorized `npm ci --ignore-scripts` installed the lockfile-pinned dependencies in the disposable checkout, using a separate temporary npm cache. Package manifests and the lockfile remained byte-identical. The install reported engine/deprecation warnings; no dependency upgrades or lifecycle scripts were used to address them.
- The first dependency-backed check exposed missing ignored model-catalog JSON. The matching installed Pi AI 1.4.0 `dist/providers/data` directory was copied **read-only from the installation into the disposable checkout's** `packages/ai/src/providers/data`. This includes its manifest; no live catalog regeneration occurred. `npm run check:model-data` validated the copied data.
- Full **`npm run check` passed**: Biome checked 1,535 files with no fixes, followed by dependency/import/entry-graph/install-lock checks, **TypeScript 7.0.2**, and browser checks.
- Five existing upstream editor, runner, compaction, dialog, and tree-navigation test files passed **72/72 tests**, using Vitest 4.1.11 with an isolated offline environment.
- The parent reran the portable interrupt verifier: **26/26 passed**, child exit 0, all 11 protected installed-file hashes unchanged, and temporary runtime removed. The exported patch still matches the disposable source diff byte-for-byte.

Follow-up logs: `/tmp/pi-interrupt-deps-install.log`, `/tmp/pi-interrupt-model-data-check.log`, `/tmp/pi-interrupt-upstream-check-hydrated.log`, `/tmp/pi-interrupt-deps-parent-upstream-tests.log`, and `/tmp/pi-interrupt-deps-parent-portable.log`. Earlier failed-check logs remain historical evidence, not the current status.

To repeat the full upstream check in a disposable checkout, install its pinned dependencies with `npm ci --ignore-scripts`, supply the matching release's ignored model data, then run `npm run check:model-data` and `npm run check`. Do not regenerate current provider catalogs merely to make an old release typecheck. The portable verifier itself still performs no installation or source-data hydration.

The follow-up independent review found no issues and **approved the scoped, uninstalled proposal**, confirming that the earlier upstream-check concern is resolved.

Source validation is complete for this proposal on the recorded environment, **not** a full upstream test-suite/build or end-to-end Guild certification. Full Guild wiring/native integration verification remains before exposure. Applying any change to installed Pi still requires separate permission.
