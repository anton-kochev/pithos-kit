# E1 Pi 0.85.1 — real CLI/Guild startup checkpoint

## Status

**Follow-up:** the [frozen base-pricing audit](e1-pricing-audit.md) now connects per-turn arithmetic checks to settlement/resume and validates them against the installed SDK offline. It also records missing-usage defaults and lost service-tier metadata. Native execution/metering observation and independent review remain unfinished; the startup evidence below is preserved.

**Real Node/Pi CLI registration and ordinary Guild child startup checked through authentication preflight.** This advances the earlier [SDK/authentication checkpoint](e1-runtime-0851.md), but does not complete live readiness.

The probe loaded the production Guild extension through the selected Pi CLI's own loader, inspected its actual session/tool registry, and directly invoked its bound `guild_handover` tool. Explorer/typescript and coder/typescript children used the real CLI, not an inert executable or a replaced Guild runner. Both reached the expected missing-credential preflight error and returned that failure through Guild.

No parent model prompt was submitted. Child task submission stopped before the agent/provider loop because the fresh credential store was empty. No real credentials, provider HTTP requests, custom models/providers, installs, installed-file patches, campaign trials, staging, commits, or Phase 2 work were involved. This is compatibility exploration, not a quality/cost measurement or independent review.

## Probe boundaries

The manual probe and preload remain ignored local artifacts:

- `.pi/evaluation/e1-native-startup-probe.mjs`
- `.pi/evaluation/e1-native-startup-preload.mjs`
- `.pi/evaluation/native-startup/<UUID>/`

The launcher supplied an empty environment apart from PATH and explicit private HOME/TMPDIR/agent-directory/offline/probe settings. Each invocation had a fresh fixture and `{}` credential store. Native compaction/retry and ambient resources were disabled as in the driver; explicit model/thinking/tool/resource flags were passed. Parent stdout/stderr, production child diagnostics, startup observations, and launch information were retained privately. Temporary fixture/configuration directories were removed after each invocation.

Instrumentation was explicit and parent-only:

1. The existing evaluation child observer captured production diagnostics on fd3.
2. A disposable Node preload wrapped `AgentSession.bindExtensions()`, **calling the original implementation first**, then inspected the real bound session and invoked its tool. It did not replace ExtensionAPI, tool implementation, spawning, auth resolution, provider transport, or model selection.
3. Node synchronous module-resolution hooks and the native `child_process` diagnostics channel recorded actual resolution and spawn events. The latter publishes before spawn fields exist, so the probe waited for the process's `spawn` event.
4. Startup assertions wrote a separate fd4 record, not model context. The parent had no prompt, and a rejecting/counting parent `fetch` guard observed zero attempts.

The ordinary child inherited neither preload nor observation fd. Its own missing-auth preflight, empty inherited credential environment/store, offline startup policy, native session header and terminal error were checked. This is **not** an OS network sandbox or instrumentation of every possible child network API. The inspected Codex preflight rejects missing credentials before the agent loop; no successful/authenticated provider request was exercised.

## Observed registration and dependency resolution

Both arms selected `openai-codex/gpt-6-astra` and effective thinking `high`, temporary project trust, no saved session, and no loaded skills, prompt templates, or AGENTS context. The clean-directory runs used Pi's native parent prompt with no custom or appended system prompt.

| Arm | Actual active tools | Guild registration |
|---|---|---|
| Main-only | `read,write,edit,bash,grep,find,ls` | Absent |
| Guild-available | Same seven plus `guild_handover` | Production extension; canonical role/profile/task schema and source ownership verified |

The production extension registers `create_commit`, but the CLI `--tools` selection excludes it from the configured session tool registry as well as the active list. It is not merely an inactive tool that this session can enable by name. The Guild commands are registered; no command or commit workflow was invoked.

Actual Jiti import-resolution events selected these installed entries, rather than Guild's local Pi 0.82.1 development peers:

| Import | Resolved host entry | Installed package version |
|---|---|---|
| `@earendil-works/pi-ai` | Nested pi-ai `dist/compat.js` | 0.85.1 |
| `@earendil-works/pi-coding-agent` | Selected Pi `dist/index.js` | 0.85.1 |
| `@earendil-works/pi-tui` | Nested pi-tui `dist/index.js` | 0.85.1 |
| `typebox` | Nested typebox `build/index.mjs` | 1.3.7 |

This agrees with the inspected unbundled Node loader's explicit aliases. The probe retained the resolution events and entry-byte hashes; no observed module resolution selected Guild-local `node_modules`. These are **selected-entry observations, not a complete dependency-closure fingerprint**, and do not substitute for the still-required frozen runtime binding.

## Ordinary child observations

For both explorer/typescript and coder/typescript, the probe observed:

- The real Node executable launching the same installed `dist/cli.js`; no `pi`/Bun fallback and no inherited `--import` argument.
- The production role tool argument, exact approved model/high arguments, trust flag, resource-disabling flags, and generated package prompt files.
- Prompt bytes matching the package role/profile files and the standalone role/profile header, not an invented acknowledgement.
- Raw production diagnostics with correlated child IDs, contiguous sequence numbers, native JSON session header with the expected cwd, missing `openai-codex` credential error, exit code 1, and non-aborted terminal observation.
- The actual bound Guild tool rejecting with that error; generated prompt-directory cleanup after settlement.
- Unchanged fixture file tree/bytes and an unchanged empty credential store in the final runs.

This proves startup and failure propagation for the tested paths, **not successful delegation**. Child active tool/context objects were not inspected internally: command arguments and matching prompt bytes alone do not prove those resolved runtime objects. That distinction remains part of the native observer work.

## Two runtime details the initial probe exposed

### Built-in extension despite `--no-extensions`

Pi 0.85.1's `main.js` always supplies its hidden `<inline:llama.cpp>` factory, including these invocations with `--no-extensions`. It appeared in both arms; the Guild arm additionally loaded the explicit production extension.

Inspected `dist/extensions/index.js`, `llama/index.js`, and `llama/provider.js`: the factory registers a provider and `/llama` command, not an extra model tool. Its startup refresh checks network permission and configured credentials. This probe configured neither llama credentials nor `LLAMA_BASE_URL`, invoked no llama command, and observed no parent fetch.

The corrected probe explicitly expects this built-in resource; it does not hide/remove it or treat the selected runtime as extension-free. The frozen observer must account for native built-ins separately from ambient/user extensions.

### `--no-context-files` does not suppress system-prompt files

An intentionally planted `SYSTEM.md`/`APPEND_SYSTEM.md` pair appeared in the actual parent `getSystemPromptOptions()` and prompt, while `contextFiles` and `skills` remained empty. The inspected resource loader treats these files separately from AGENTS context.

Normal startup probes therefore use clean system-prompt locations and retain AGENTS/ambient-extension canaries. A separate contaminated-directory control must fail the native-prompt assertion. This preserves the evidence rather than weakening the assertion or replacing Pi's native prompt.

For the actual campaign, `createPiDriver()` creates a fresh private agent directory, and the task manifest rejects `.pi` path segments, preventing these fixture-supplied project files at initial startup. **The fresh input layout is part of the policy; the flags alone are insufficient.** A native observer must reject unexpected custom/appended parent prompts before admission/execution. Cooperative task processes and same-user filesystem changes are not hostile-code containment.

## Exploration and negative controls

All exploratory output remains retained; no prior observation was overwritten or reclassified as a model success. Four early launcher failures exposed an incorrect expectation of no built-in extension, the system-prompt contamination (including a diagnostic rerun), and an incorrect expectation that `create_commit` remained in the configured registry. These were probe-assumption corrections, **not production RED/GREEN bug fixes**.

Final native controls and restored runs used:

```bash
env -i PATH="$PATH" PI_OFFLINE=1 node .pi/evaluation/e1-native-startup-probe.mjs missing-extension-control
env -i PATH="$PATH" PI_OFFLINE=1 node .pi/evaluation/e1-native-startup-probe.mjs system-prompt-control
env -i PATH="$PATH" PI_OFFLINE=1 node .pi/evaluation/e1-native-startup-probe.mjs main-only
env -i PATH="$PATH" PI_OFFLINE=1 node .pi/evaluation/e1-native-startup-probe.mjs guild-available
```

| Safe control | Native result |
|---|---|
| Omit the explicit Guild extension while expecting the Guild arm | Exit 1; registered-extension set assertion rejected; no child |
| Add system-prompt canaries to the isolated input directories | Exit 1; native-prompt assertion rejected; no child |
| Restore normal main-only launch | Exit 0; verified startup; no child |
| Restore normal Guild launch | Exit 0; verified startup; two expected child authentication-preflight failures |

These are disposable compatibility/sensitivity probes, not maintained unit tests or paid campaign attempts. No production guard was weakened. There were fourteen startup-probe invocations in this increment: four exploratory failures, four expected negative-control failures, and six successful normal startup checks. Each of the three normal Guild checks launched two pre-authentication children; all evidence stays separate from the campaign's twelve-attempt allowance. No empirical evaluation result is inferred from those counts.

## Verification and remaining gate

No production or evaluation runtime source was changed in this increment; only local probe artifacts and readiness documentation were added/updated. Final checks on Node.js 24.20.0:

| Check | Result |
|---|---|
| Guild `npm test` | 135/135 passed |
| Guild `npm run typecheck` | Passed |
| `npm run eval:test` | 71/71 passed |
| `npm run eval:typecheck` | Passed |
| Repository root `npm test` | 2/2 passed |
| Bank validation / offline schedule | Six tasks; approved digest unchanged; schedule generated without execution |
| `npm pack --dry-run --json` | 39 files; evaluation/private assets excluded |
| `git diff --check` | Passed |
| Startup temporary directories | None remained |

These suites are unchanged regression checks, not automated coverage of the disposable native probe. Native positive/negative evidence is recorded separately above. Nothing was staged or committed.

Before live entry:

1. Implement and test **actual native observation bound to the campaign**, including implementation/runtime identity, both arms' resolved resources/tools/prompts, auth policy, model, and pricing calculation. Incorporate the built-in-extension and system-prompt findings above. A manual snapshot, matching hashes, or an injected observer callback is not this binding.
2. Verify the remaining child runtime context/accounting path; the present child check stops at missing-auth preflight. Prior synthetic SDK token resolution is separate evidence, not a successful production child request.
3. Obtain fresh independent review outside the failed Bun route and resolve material findings. No paid review call was added under smoke approval.
4. Only after readiness passes, freeze inputs and run the original first pair, inspect it, and honor the existing attempt/spend/time/unknown-usage stops. The offline CLI still rejects `run`; no live entrypoint was enabled here.

The [smoke configuration](e1-smoke-campaign.md) remains unchanged: approved runtime/model, development tasks, arms, limits and checkpoint. Held-out promotion and Phase 2 are still separate decisions.
