# E1 Pi 0.85.1 — approved runtime and offline authentication check

## Status and authority

**Follow-up:** the [real CLI/Guild startup checkpoint](e1-native-startup.md) now covers production registration, selected dependency resolution, and ordinary child startup through missing-auth preflight. It also records two native resource-discovery details. Complete native execution binding and independent review still block live entry; the earlier verification history below is preserved.

The user explicitly confirmed switching the evaluation runtime to the **already-installed Pi 0.85.1 launched through Node**, retaining `openai-codex/gpt-6-astra`, `high`, the task bank, arms, attempt/spend/time limits, and first-pair checkpoint. This supersedes the earlier Pi 0.83.0 campaign selection; it does not rewrite earlier measurements or authorize installs, patches, extra probes with provider calls, or immediate live execution.

**Offline authentication compatibility checked; complete live readiness still blocked.** Production Guild registration/ordinary child startup, verified native input/pricing observation, and independent review remain unfinished. The CLI still has no `run` command. No real credentials were accessed and no provider HTTP requests or agent prompts were sent in this increment.

## Inspected runtime policy

Inspected the installed Pi 0.85.1 SDK documentation, provider/model/environment guidance and auth example, plus its actual unbundled SDK/auth implementation. The selected `dist/cli.js` imports `main.js`; this is the explicit Node entry, not the previously failing Bun bundle route.

Relevant implementation paths beneath the installed packages:

- `pi-ai/dist/auth/resolve.js`: default minimum validity remains **five minutes**, with refresh at `Date.now() + 300000 >= expires`; double-checked credential locking remains. Version 0.85.1 adds cancellation propagation and a **15-second refresh timeout**. Failed refresh does not silently fall back to environment auth.
- `pi-ai/dist/auth/oauth/openai-codex.js`: `toAuth()` returns the access token; `refresh()` uses the supplied refresh field. Browser/device login remains explicit and is not used by this check.
- `pi-ai/dist/providers/openai-codex.js`: the built-in provider uses OAuth, not an API-key fallback.
- `pi-ai/dist/models.js` and `pi-coding-agent/dist/core/model-runtime.js`: normal auth/request preparation passes API key/env/signal overrides, not a larger minimum validity window. `modelsPath: null` selects no custom model file and an in-memory model store in the inspected SDK path.

The lease's existing trial-timeout-plus-six-minute reserve is therefore retained unchanged. It still copies no usable refresh credential, rejects near-expiry access at acquisition and immediately before spawn, and requires source/transient storage outside the entire retained campaign, fixture, and Guild trees. This is an inspected cooperative runtime policy, not a signature check, hard real-time guarantee, or independent security approval.

## Real SDK probe — synthetic data only

The ignored manual compatibility probe `.pi/evaluation/e1-auth-runtime-0851-probe.mjs` was run with:

```bash
env -i PATH="$PATH" PI_OFFLINE=1 node .pi/evaluation/e1-auth-runtime-0851-probe.mjs
```

The probe used a new private temporary home/configuration, explicit synthetic source and borrowed auth paths, `modelsPath: null`, `allowModelNetwork: false`, an abort deadline, and a rejecting/counting `fetch` replacement installed before importing the SDK. It never created an agent session or sent a prompt.

Observed on Node.js 24.20.0:

- Both installed Pi and its nested pi-ai identify as **0.85.1**.
- `getModel("openai-codex", "gpt-6-astra")` resolves the exact approved ID; `high` maps to `high`.
- The resolved cost metadata equals the installed catalog entry, including its tier. This verifies metadata resolution, **not external rate accuracy or billing**; native accounting binding is still required.
- `getAuth(model)` returns OAuth and the matching synthetic access token; fresh resolution makes **zero fetch attempts**.
- With the probe's clock set to 300001 ms before expiry, auth still resolves without fetching. At exactly 300000 ms, one refresh attempt is intercepted locally and rejected; its refresh value is empty. **No HTTP is sent**, and there is no fallback success.
- Original source bytes and the borrowed store remain unchanged after the blocked refresh. The lease and temporary home are removed.

The blocked-refresh case intentionally probes behavior outside the lease's permitted live freshness envelope. It does not weaken the real lease control, refresh a real credential, or count as a campaign model attempt. A `fetch` replacement and this inspected call path are not an OS-level network sandbox against hostile code.

The prior Pi 0.83.0 probe remains unchanged. Its missing-model result is historical; the new 0.85.1 result resolves that catalog mismatch without a model substitution. Actual provider/account entitlement remains untested.

## Driver change and tests

`evaluation/src/pi-driver.ts` now permits **exactly 0.83.0 and 0.85.1** for scoped Codex borrowing. Retaining previously checked 0.83.0 preserves the old compatibility/test path; it is **not an approved campaign fallback**. The eventual native campaign observer must enforce the selected 0.85.1 runtime. Other releases require a new policy check rather than an automatic semver range.

The existing synthetic native-adapter test now exercises both reviewed versions for parent/ordinary-child access, private configuration, no usable refresh/unrelated credential copy, source preservation, and cleanup after completion, process failure, and timeout. Its CLI is inert: this checks adapter behavior, not production Pi/Guild integration.

Test-first command: `npm run eval:test` from `pithos.guild/`.

| Change/check | Observed evidence |
|---|---|
| Add exact 0.85.1 support | RED: `Missing synthetic auth check: driver_error`; GREEN after adding only the reviewed version |
| Pin rejection of unreviewed 0.85.2 alongside 0.84.0 | Initially GREEN; changing only the disposable test manifest version to allowed 0.85.1 made it RED: expected version rejection, got `Unable to read a scoped Codex access credential` |
| Restore that fixture | GREEN; no runtime/credential control was disabled |

The pre-credential rejection pin distinguishes runtime-policy failure from a later failure reading its deliberately nonexistent synthetic source. The controlled fixture mutation was restored.

## Node CLI smoke check, not production registration

Ran the installed `dist/cli.js --help` through Node in an empty private HOME/TMPDIR/agent directory, with a clean environment and startup networking disabled. It exited successfully and advertised all twelve parent-driver flags checked: mode, print, no-session, no-extensions, no-skills, no-prompt-templates, no-context-files, approve, extension, tools, model, and thinking.

Help exits before ordinary extension/agent startup. It does **not** certify Guild registration, child launching, dependency resolution, provider transport, or pricing/accounting. Those gates stay open.

## Verification

Final checks observed on Node.js 24.20.0:

| Check | Result |
|---|---|
| Guild `npm test` | 135/135 passed |
| Guild `npm run typecheck` | Passed |
| `npm run eval:test` | 71/71 passed |
| `npm run eval:typecheck` | Passed |
| `npm run eval -- validate` | Six valid tasks; approved bank digest unchanged |
| `npm run eval -- schedule e1-development-1 1` | Offline schedule generated; no execution |
| Repository root `npm test` | 2/2 passed |
| Guild `npm pack --dry-run --json` | 39 files; evaluation/private artifacts excluded |
| `git diff --check` | Passed |
| Actual 0.85.1 SDK synthetic auth/model probe | Passed; zero HTTP requests; blocked refresh boundary verified |
| Actual 0.85.1 Node CLI help | Passed; twelve parent flags present; registration not tested |

Runtime source changes in this increment are evaluation-only: the exact driver allowlist and an explanatory lease comment. No production Guild source/prompt/tool, dependency, lockfile, package version, or publish metadata changed. No files were staged or committed.

## Next checkpoint

1. Verify real production Guild registration and ordinary child launching through the selected Node/Pi runtime without provider HTTP. Keep this distinct from an inert CLI or mocked ExtensionAPI test.
2. Implement verified native runtime/implementation/context/auth-policy/model/pricing observation and bind it to execution and retained evidence.
3. Obtain fresh independent review outside the failed Bun route; paid review calls require separate authorization.
4. Freeze the approved inputs only after readiness passes, then follow the original first-pair/inspection gate. No extra trials or silent retries.

The [smoke configuration](e1-smoke-campaign.md) remains the authority for campaign scope and limits. Held-out promotion and Phase 2 remain unauthorized.
