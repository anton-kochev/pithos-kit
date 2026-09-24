# E1 isolated Guild-child checkpoint

**Status: isolated synthetic Guild checkpoint passed and retained evidence revalidated (`offline-docker.d2iWYHzd`). Campaign binding and independent review remain incomplete.** The preceding main-only run `offline-docker.7HBxaKLK` passed retained-evidence revalidation, including thirteen selected runtime fingerprints, fresh network checks, a completed synthetic CLI request and cleanup. That evidence is preserved and is not reused as permission to launch a new process outside isolation.

## Host command

From the host's `pithos-kit` checkout:

```bash
bash pithos.guild/evaluation/offline-docker.sh pithos-pithos-kit-16022 --synthetic-guild
```

Select the current project's running container name if it changed (`docker ps --format '{{.Names}}'`). Run once, then share the printed artifact directory and outcome. Retain failures; no automatic retries, connected probes, fallback installations, or replacement trials.

The default command remains readiness-only. `--synthetic-pi` remains the [main-only checkpoint](./e1-offline-synthetic.md). Modes are mutually exclusive; no arbitrary command, provider, model, credential or network option is accepted.

## Retained failure and diagnostic revision

- `offline-docker.YuRkM8xA` stopped before container creation: the selected source container name no longer existed.
- `offline-docker.T4KvajQN` used the updated source name and passed fresh network/runtime readiness. All 42 copied input files matched their maintained sources at inspection. Both children emitted only native `process_start`, with no context, request, normal footer, stdout or stderr. Guild reported exit code 1, but its runner normalizes a signal termination's null code to 1, so those records did **not** identify the raw termination reason.
- The parent completed its first synthetic request. Its attempted continuation lacked the required successful child outputs and was rejected; the synthetic HTTP fallback also threw. Parent CLI exit was 0 but the enclosing harness correctly failed with exit 1, no success summary, and successful cleanup. Neither failed directory was rewritten or replaced.

The diagnostic revision added the following observations without changing limits:

- `resources-before.json` and `resources-after.json` bracket parent capture, including failed capture, while the supervisor survives.
- `diagnostics/<pid>.jsonl` records early bootstrap milestones and selected resource snapshots. The parent separately observes ordinary child spawn/exit events, retaining raw `code` and `signal` without modifying the production runner or weakening acceptance checks.
- Snapshots select process RSS/heap-used/external byte counts and thread count; cgroup-v2 root memory/PID current, peak, limit and event counters. PID accounting includes threads. Only a `0::/` membership is supported; other layouts are not guessed. Missing, inaccessible, malformed or unsupported readings are null/unavailable, never invented zeros. No environment, argv, heap contents, arbitrary cgroup paths or proc contents are recorded.
- Each diagnostic log is capped at 64 KiB with an explicit limit marker. Diagnostic write failure/truncation is incomplete evidence, not proof of a cause. A killed observer may leave no footer or after-snapshot.
- Before deleting an owned container, the host retains `docker-final-state.json`: selected status, exit code, Docker OOM flag and configured memory/swap/PID/CPU limits. Failure to obtain it is reported and fails the host command, but cleanup is still attempted. No full Docker inspect/environment dump is retained.

**Interpretation:** SIGKILL alone does not prove OOM. Memory `max` events can reflect reclaim, not kills; `oom_kill` counter increases establish cgroup OOM kills during an interval, not by themselves a particular victim. PID `max` event increases indicate limit hits. Docker's OOM flag is supplementary and cannot explain every child termination. Compare before/after counters, child exit signals, capture timeout flags and milestones. These observations do not retroactively explain or replace T4KvajQN.

The subsequent retained diagnostic run `offline-docker.b18X49av` passed isolation/runtime checks but failed Guild startup again. Both children exited with raw `SIGABRT`; the cgroup PID/thread peak reached 32 and its limit-hit counter increased from 0 to 1 at the first child's exit, then to 2 at the second. Memory peaked at approximately 351 MiB of 512 MiB, with zero recorded OOM/kill events. Docker final-state capture and cleanup succeeded; all 43 copied inputs matched their maintained sources at inspection. This identifies PID/thread-limit exhaustion in that run, without identifying the exact failing thread-creation call or rewriting either earlier failure.

The operator explicitly approved raising **only the disposable harness PID/thread limit to 64**. Memory, CPU, tmpfs, network denial, permissions, mounts, timeouts and acceptance checks remain unchanged. No Node/V8/thread-pool tuning, runtime substitution or installation was made. The revised limit was subsequently exercised by `offline-docker.d2iWYHzd`: all 43 copied inputs and thirteen selected runtime fingerprints matched at inspection, fresh isolation checks passed, and three Pi producers completed four synthetic requests. Both children exited 0 without a signal; the parent received both results and synthesized its final response. PID/thread usage peaked at 34 of 64 with no limit-hit events; memory peaked at approximately 356 MiB of 512 MiB with no recorded OOM/kill events. The host exited 0, final Docker state was retained, and cleanup succeeded. The maintained synthetic validator and later [general native audit](./e1-native-evidence.md) both revalidated its original raw evidence without launching Pi. Earlier failed runs remain preserved. This is a successful synthetic checkpoint, not live-run authorization.

## Fixed workflow

After fresh [same-container isolation/runtime checks](./e1-offline-docker.md):

1. One real Node/Pi 0.85.1 parent loads the copied production Guild extension with the seven built-ins plus `guild_handover`.
2. Its first synthetic response requests `explorer/typescript` and `coder/typescript`, through the real tool and ordinary serialized Guild runner—not direct harness child launches.
3. Each child checks its own OS isolation and direct parent ancestry before importing SDK code, then uses the maintained native observer to inspect actual role/profile prompts, hard tool ceilings, model/high thinking and resource/auth settings. Each receives one synthetic text response, with **no child tool execution or repository mutation**.
4. The parent's second serialized WebSocket payload must contain both matching `function_call_output` values before the synthetic transport supplies the final text response. No missing or invented child result is accepted.
5. Acceptance reconciles three native process lifecycles, two handovers, four logical requests, raw meters and finalized usage. Raw diagnostics bind tool-call IDs to child UUIDs, native spawn PIDs, internally resolved child contexts and each child's stdout. Parent and child transport counters must agree; response/request/attempt identities cannot be reused. Child-reported and raw-observed aggregate usage must match. Child lifetimes may not overlap.

The transport remains finite: two parent requests, one request per child, one synthetic WebSocket per process, no HTTP fallback. The dispatcher-before-globals startup order follows the successful main-only checkpoint. OS denial remains necessary even if JavaScript instrumentation fails.

This demonstrates neither coder file-editing behavior nor meaningful model reasoning, quality, provider entitlement, external billing, or complete campaign attestation. Synthetic token counts and arithmetic are fixture data, not spend. Complete receipt/resume binding, broader negative integration cases and independent review still block live E1 entry. The old private connected probe and unfinished native campaign-driver mode stay disabled.

## Inputs, bounds and retention

- Same existing immutable image, thirteen-file static runtime comparison, two mounts, network-none/read-only/non-root/zero-capability restrictions. No new mounts, dependencies, source home, source environment, credentials, Docker socket, pulls or installs.
- The read-only harness additionally contains a **closed copy** of Guild's package manifest, extension entry, nine production source files, four role prompts, six profile prompts and Conventional Commit skill resource. Files are copied unchanged; symlinked resource directories/files are rejected. No checkout-wide copy, `node_modules`, local settings, logs, sessions or private evaluation assets are included. Skill discovery and the commit tool remain outside the configured tool ceiling.
- A fresh generated nonfunctional, access-only OAuth-shaped credential is shared by the isolated process tree. No real credential source is borrowed. Private temporary HOME/TMPDIR and working directory are removed after success/failure where execution reaches cleanup.
- Thirty-second parent process-group timeout and sixty-second enclosing watchdog. The operator-approved PID/thread limit is now 64; the existing 512 MiB memory limit and CPU/tmpfs restrictions remain unchanged. Resource exhaustion fails this attempt; it is not permission to silently relax limits.
- Parent stdout/stderr retain at most 1 MiB each. The parent-only FD 3 observer retains bounded raw child stdout/stderr (16 MiB total, including lifecycle records); ordinary children do not inherit that descriptor. Truncated/incomplete observations cannot certify success. Native records retain their existing bounded output behavior.

New evidence under `evidence/synthetic-guild/` includes fixed invocation/pricing, process outcome, parent stdout/stderr, `children.jsonl`, native config/process records, parent ancestry descriptor, and per-process transport/isolation metadata in `transports/`. A success summary is written only after reconciliation, unchanged auth/empty repository/prompt cleanup checks, and temporary cleanup. Failed and partial outputs remain available without a success summary.

The host requires both `OFFLINE_VERIFIED` and `SYNTHETIC_GUILD_VERIFIED`, their reports, a successful container exit and successful cleanup. This is cooperative, source-inspectable evidence—not signed or tamper-proof OS/network attestation. It does not measure packets, hidden network attempts or provider billing.

## Local verification scope

Tests use inert Docker responses, actual inert Node descriptor/timeout checks, synthetic WebSocket events and provider-free trace fixtures. They exercise ancestry rejection, finite requests, return-payload requirements, missing/extra/wrong native producers, malformed usage, call/result mismatches, conflicting totals, forbidden child tool activity and overlapping child lifetimes. Diagnostic tests additionally exercise malformed/unavailable counter handling, private bounded logs, supervisor failure retention, actual inert Node signal exits, process-channel selection and Docker final-state capture before cleanup. An inert test caught that Node publishes the process channel before `spawnargs` is populated; selection now occurs at spawn/exit reporting. The fixed Guild runtime path and diagnostic wiring now have the retained isolated positive evidence above. No Pi or SDK provider was launched in the connected development container for these increments; fixture coverage beyond the fixed checkpoint is not additional actual runtime execution.
