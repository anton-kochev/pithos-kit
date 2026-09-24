# E1 scoped Codex authentication — offline implementation record

## Status

**Scoped-identity follow-up:** [same-descriptor auth observations](e1-scoped-auth-identity.md) now bind the transient lease to exact bytes/device/inode/account digest and recheck it before launch. New invocation records retain private identity metadata; actual native producer/request/receipt binding remains unfinished. The original verification history below is preserved.

**Later runtime revision:** the user approved Node-launched Pi 0.85.1. Its [separate compatibility record](e1-runtime-0851.md) documents policy inspection, synthetic SDK evidence, and exact driver support. The original 0.83.0 design/verification history below is preserved; production integration and independent review remain pending.

**Access-only borrowing implemented and offline-tested; live readiness is still incomplete.** This increment used synthetic credentials only. It did not discover, read, refresh, or modify real credentials, contact a provider, launch a benchmark, stage or commit changes, update dependencies, or implement Phase 2.

**Follow-up:** the [persistent campaign ledger](e1-campaign-ledger.md) has since been implemented and offline-tested. The later [execution bridge](e1-execution-bridge.md) adds offline deadline/receipt integration, while actual native observation remains a gate. The authentication verification history below is unchanged.

The approved [smoke campaign](e1-smoke-campaign.md) remains blocked on campaign controls, independent review, production Guild runtime verification, and a runtime/model decision: **Pi 0.83.0's shipped Codex catalog does not contain `gpt-6-astra`.** No model, runtime, or custom model configuration was substituted.

## Design and ownership

`createPiDriver()` now optionally accepts an explicit `codexAuth: { sourceFile, temporaryRoot }` alongside an empty `credentials` map. There is no default auth-file discovery and no live CLI command. Mixing Codex borrowing with API-key environment credentials is rejected, as is using the borrowed credential for another provider.

`src/codex-auth.ts` creates a per-trial private credential lease:

- Both paths must be absolute and explicitly supplied. The source must be an owned, private, single-link regular file, not a final-component symlink, and at most 1 MiB. Reads are bounded even if the source grows. The temporary root must already exist.
- Canonical path checks keep the source and temporary root outside the evaluated fixture, retained trial-storage root, and Guild implementation root. Symlink aliases cannot bypass those overlap checks.
- The helper parses only the supplied JSON file; it does not invoke Pi's global configuration/key resolver, execute shell-valued keys, or copy unrelated providers, environment values, or settings.
- The selected entry must be `openai-codex` OAuth with structurally consistent access-token/account/expiry fields. JWT parsing checks structure and consistency, **not signature authenticity**; actual provider authentication remains untested.
- Only the access token, account ID, and conservative expiry are copied into a mode-0600 `auth.json` inside a mode-0700 temporary directory. The refresh field is empty. No usable refresh token is handed to the evaluator's Pi processes, and the source file is never written.
- Effective expiry is the earlier of the source metadata expiry and JWT expiry. At acquisition and again immediately before spawn, the access token must outlive the entire trial timeout plus six minutes: Pi 0.83.0's five-minute refresh window and a one-minute setup/clock reserve.
- Near-expiry tokens are rejected. The operator owns refresh/login outside evaluation, then explicitly supplies a sufficiently fresh credential. There is no automatic refresh, login, or fallback in this helper.

Codex borrowing is currently restricted to **Pi 0.83.0**, whose refresh policy was inspected and auth resolution was probed. The general API-key adapter's existing minimum-version rule is unchanged. A different Codex runtime needs a reviewed refresh-policy/compatibility check before this narrow restriction changes.

## Driver lifecycle and evidence

The borrowed directory becomes the clean `HOME`, `PI_CODING_AGENT_DIR`, and `TMPDIR` for the parent and ordinary Guild children. Generated settings still disable ambient resources, compaction, and retries. With Codex borrowing, the entire agent directory is transient rather than retained beneath trial artifacts.

The driver cleans up the whole private directory after process settlement, including normal completion, child/process errors, timeout/cancellation, and pre-spawn setup failures. This also removes incidental private debug/cache files. Cleanup errors are surfaced rather than silently treated as success. Source-read/validation errors are sanitized so parser diagnostics cannot echo credential contents or the source path.

Invocation metadata records only the authentication policy (`codex-access-only; transient storage; no refresh`) and existing credential key names. The source path and credential values are not placed in argv or provenance. Synthetic integration tests scan retained artifacts to ensure those values were not copied during the tested workflows.

**Limits:** a supervisor hard kill, host crash, or filesystem failure can prevent cleanup. These directories are transient private storage, not secure erasure; the operator must handle abandoned directories under the explicitly owned temporary root. Processes still have ordinary same-user filesystem access. This does not prevent a hostile shell/tool from reading or copying a credential, and it does not provide universal secret redaction. Raw artifacts remain private and require inspection before any publication. Use a disposable environment without unrelated credentials or user work for eventual trials.

The lifetime reserve prevents expected automatic refresh during bounded trials; it is not a guarantee about provider behavior under extreme clock shifts or escaped processes. No reusable refresh credential is present in the borrowed store if those assumptions fail.

## Verification evidence

Test-first slices used `npm run eval:test` from `pithos.guild/`:

| Behavior | Observed RED before implementation |
|---|---|
| Private access-only lease | Missing `codex-auth.ts` module |
| Private/absolute/bounded/non-overlapping paths | Missing expected rejection |
| Credential type, identity, expiry validation | Missing expected rejection |
| Native parent/child borrowing | Missing synthetic auth check; process error |
| Ambiguous/provider-mismatched authentication | Missing expected exception |
| Unverified runtime admission | Reached credential handling instead of rejecting the unverified runtime policy |

Each slice returned GREEN with the same command. An initial runtime-admission test omitted necessary driver context; that unrelated setup error was corrected and is not counted as behavioral RED evidence.

Additional lifecycle tests pin cleanup and the pre-spawn lifetime recheck. Sensitivity was demonstrated in **disposable copies** of the driver and tests, never by disabling the actual credential controls:

| Mutation in isolated copy | Observed RED |
|---|---|
| Omit the pre-spawn freshness recheck | Fake CLI launched; `incomplete_trace` instead of expected `driver_error` |
| Omit private-directory cleanup | Temporary credential directory remained after setup failure/completion |

The copies were removed and the original controls remained intact.

### Real SDK auth probe, not a model trial

The local ignored probe `.pi/evaluation/e1-auth-runtime-probe.mjs` ran via:

```bash
env -i PATH="$PATH" PI_OFFLINE=1 node .pi/evaluation/e1-auth-runtime-probe.mjs
```

It created a synthetic JWT/source file and lease, then imported the installed Atlas-local Pi 0.83.0 `ModelRuntime`. It used `ModelRuntime.create({ authPath: borrowedPath, modelsPath: null, allowModelNetwork: false })`, replaced `fetch` with a rejecting counter, and called `getAuth("openai-codex")` without creating an agent or sending a prompt.

Observed on Node.js 24.20.0:

- Auth source was `OAuth`, and resolved access matched the synthetic token.
- No usable refresh token was copied; source bytes stayed unchanged.
- Network-attempt counter was zero; private-directory cleanup succeeded.
- `getModel("openai-codex", "gpt-6-astra")` returned no model.

The shipped catalog in `pi-ai/dist/providers/data/openai-codex.json` independently confirms that absence. This proves compatibility of fresh borrowed credentials with that SDK auth path, not actual account/model availability, real provider authentication, complete production-extension startup, or independent approval.

Final checks observed on Node.js 24.20.0:

| Command/check | Result |
|---|---|
| Guild `npm test` | 135/135 passed |
| Guild `npm run typecheck` | Passed |
| `npm run eval:test` | 36/36 passed |
| `npm run eval:typecheck` | Passed |
| `npm run eval -- validate` | Six tasks valid; approved bank digest unchanged |
| `npm run eval -- schedule e1-development-1 1` | Offline schedule generated; no execution |
| Repository root `npm test` | 2/2 passed |
| Guild `npm pack --dry-run --json` | 39 files; evaluation/private artifacts excluded |
| `git diff --check` | Passed |
| Real Pi 0.83.0 synthetic SDK auth probe | Passed; zero network attempts; approved model absent |

Changed runtime logic is confined to `evaluation/src/{codex-auth,pi-driver}.ts`, with new `evaluation/test/{codex-auth,pi-driver-auth}.test.ts` and documentation updates. No production Guild source, prompts, tools, dependency versions, lockfiles, or publish metadata changed in this increment. Independent review remains pending.

## Next decisions and work

1. Resolve the runtime/model mismatch explicitly. A newer compatible Node/Pi runtime could preserve the selected model; alternatively select a supported model or approve an exact custom model configuration. Each changes the frozen campaign inputs and needs renewed approval. Do not invent pricing metadata or import global model configuration to bypass the blocker.
2. Implement approved campaign budget/admission/resume controls and finish independent review.
3. Verify production Guild registration/child launching and the approved model/auth combination under the selected runtime. Only then begin the first paired smoke task.

The held-out campaign, Phase 2, commits, versions, and publishing remain separately gated.
