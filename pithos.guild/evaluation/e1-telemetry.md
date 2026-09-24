# E1 child telemetry — offline implementation record

## Status and scope

**Telemetry implemented and offline-tested; independent review and live readiness are pending.** No benchmark provider calls, authentication access, live campaign, staging, commits, version changes, or Phase 2 implementation were performed in this increment.

**Follow-up:** [scoped Codex authentication](e1-authentication.md) has since been implemented and offline-tested. That record updates the readiness state, including the newly confirmed runtime/model mismatch. The verification results and remaining-work list below describe the telemetry checkpoint.

This is the first implementation slice of the approved [smoke readiness work](e1-smoke-campaign.md). The [methodology](methodology.md) remains the evaluation contract. The original [foundation record](e1-foundation.md) preserves its initial verification results rather than rewriting them as current evidence.

## Delivered

- A small opt-in `node:diagnostics_channel` publisher in `src/runner.ts`, inactive without a subscriber. `src/guild.ts` passes the existing tool-call/direct-command run ID into the runner.
- Each observed invocation has a child UUID, parent run ID, canonical role/profile, and contiguous event sequence. Start, raw stdout/stderr, and terminal observations stay outside model context. Raw bytes are base64-framed before the production parser can ignore malformed lines or lose chunk boundaries.
- Setup failure emits a terminal observation with an unknown process exit; cancellation retains preceding finalized usage and records an aborted terminal when the runner settles. Abrupt parent termination can leave partial records with no terminal event.
- An evaluation-only Node preload subscribes in both arms and writes synchronously through a private regular-file descriptor, not parent stdout. The native adapter exclusively creates `children.jsonl` with mode 0600, closes its descriptor on settlement, and fingerprints the preload with the rest of the evaluator. The child process does not inherit the preload or recording descriptor.
- Child recording is capped at 16 MiB, including base64/framing overhead. A limit marker or recording failure prevents certification. The cap stops recording, not the workflow; a campaign controller is still needed. The post-run reader rejects oversized/non-regular artifacts without deleting them.
- `runTrial` retains and reads the child artifact even after a thrown driver, adds `childTraceDigest` when read successfully, and includes observed child model identities in cohort checks. Child provider failures are classified as provider errors rather than generic incomplete traces.
- Raw child finalized messages feed `childObserved`, `childRuns`, and `totalObserved`; aggregate `childReported`/`totalReported` remain diagnostic. Duplicate final messages, missing usage, unfinished attempts, malformed bytes/events, missing observer lifecycle, gaps/duplicates, missing/unmatched/multiple child runs, wrong targets, and failed/aborted processes prevent a complete total.
- Observed finalized-turn subtotals survive failures. Missing numeric evidence is unknown, not zero; incomplete traces have unknown `totalObserved`. Raw tool events remain available for later human verification review, not automatic acceptance of reported test claims.

No tools, roles, prompts, free-form task/result contracts, queue rules, or ambient configuration policy changed. This channel is internal instrumentation, not a user/global configuration layer. Subscribers are trusted local code and must not throw; the evaluation subscriber catches recording errors and omits a successful terminal marker. This is not hostile-code containment.

## Test-first and sensitivity evidence

Commands were run from `pithos.guild/`.

| Behavior | Observed RED | Same command returned GREEN after the change |
|---|---|---|
| Opt-in raw runner observation | `undefined` instead of `start` | `npm test` |
| Tool/direct-command correlation | Missing parent tool-call and command IDs | `npm test` |
| Private native recording | Expected `children.jsonl` did not exist | `npm run eval:test` |
| Raw finalized child accounting | Valid raw child trace remained incomplete | `npm run eval:test` |
| Lifecycle/correlation rejection | Missing child run falsely accepted | `npm run eval:test` |
| Failed/corrupt child rejection | Failed child falsely accepted | `npm run eval:test` |
| Trial integration | Captured child absent from parsed trial | `npm run eval:test` |
| Capture cap | Child artifact exceeded 16 MiB | `npm run eval:test` |
| Bounded post-run reader | Oversized artifact treated as ordinary incomplete trace instead of observation error | `npm run eval:test` |
| Child provider classification | `incomplete_trace` instead of `provider_error` | `npm run eval:test` |
| Unfinished assistant attempt | Earlier final turn incorrectly certified a later partial attempt | `npm run eval:test` |
| Missing child numeric evidence | `0` instead of `null` | `npm run eval:test` |

Some error-path tests intentionally pin behavior introduced by the earlier slices. Controlled offline mutations demonstrated sensitivity, then were restored:

| Controlled mutation | Test/check that went RED | Diagnostic |
|---|---|---|
| Omit runner terminal observation | Production raw/setup-failure tests; real-runner evaluation integration | `stdout` instead of `end`; missing `end`; `unfinished_child_run` |
| Discard child evidence after driver throw | Evaluation thrown-driver retention test | Observed child input `0` instead of `1` |

Only this increment's uncommitted observational code was temporarily changed. No active safety boundary was disabled, no live run occurred, and both mutations were restored before final verification.

## Verification

The scripted integration launches the actual production `runGuildRole()` and its ordinary child-spawn path under Node, with an inert CLI producing synthetic events. It covers successful completion, simulated provider error, and cancellation, including raw tool outcomes and stderr. It does **not** load the real Pi production extension or contact a provider; its fake Pi manifest is not evidence of actual Pi 0.83.0 integration.

Observed on Node.js 24.20.0:

| Command/check | Result |
|---|---|
| Guild `npm test` | 135/135 passed |
| Guild `npm run typecheck` | Passed |
| `npm run eval:test` | 29/29 passed |
| `npm run eval:typecheck` | Passed |
| `npm run eval -- validate` | Six tasks valid; approved bank digest unchanged |
| `npm run eval -- schedule e1-development-1 1` | Offline schedule generated; no execution |
| Repository root `npm test` | 2/2 passed |
| Guild `npm pack --dry-run --json` | 39 files; evaluation/private artifacts excluded |
| `git diff --check` | Passed |

Independent review remains separate from these tests and local inspection.

## Remaining readiness work

1. Independently review the observation mechanism and evaluator, including failure handling and recording overhead.
2. Implement scoped Codex authentication without importing global resources or retaining credentials.
3. Implement approved campaign admission/budget/resume controls. A saved trace or operator acknowledgement is not a spending controller. Unknown or late provider usage still prevents a certified total, and in-flight overshoot remains possible.
4. Verify the selected real Node/Pi 0.83.0 runtime, production Guild registration/child launching, and approved model/auth combination before campaign calls.
5. Only after readiness passes, run and inspect the first approved paired smoke task before continuing. Held-out promotion and Phase 2 remain separately gated.
