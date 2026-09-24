# E1 isolated synthetic CLI checkpoint

**Status: actual main-only Docker/CLI checkpoint passed.** Operator run `offline-docker.7HBxaKLK` passed retained-evidence revalidation: copied source equality at that checkpoint, thirteen runtime fingerprints, fresh parent/child network checks, one completed native request with matching synthetic usage, zero fallback counters, successful host exit and cleanup. The result is scoped to that run; later launches require fresh checks.

The first separate [Guild-child checkpoint](./e1-offline-guild.md) failed during child startup; diagnostics subsequently identified PID/thread-limit exhaustion in a new run. After the operator approved raising only that limit from 32 to 64, `offline-docker.d2iWYHzd` passed the fixed Guild checkpoint and retained-evidence revalidation. Campaign binding remains incomplete. This main-only increment is one main-only CLI turn. It is not Guild child execution, campaign/receipt binding, independent review, model-quality evidence, or approval for paid requests.

## Host command

From the host's `pithos-kit` checkout, select the container running this project:

```bash
bash pithos.guild/evaluation/offline-docker.sh pithos-pithos-kit-24535 --synthetic-pi
```

Use `docker ps --format '{{.Names}}'` if that container name has changed. Without `--synthetic-pi`, the command remains readiness-only. No arbitrary command, model, credentials, image-pull, or network override is accepted.

This creates a **fresh** disposable container using the selected source container's existing immutable image. It reruns the [network/readiness checks](./e1-offline-docker.md), then runs the fixed synthetic CLI probe in **that same container**. The normal Pithos container stays connected and unchanged apart from static inventory reads. The old private probe and unfinished native campaign driver remain disabled.

## What runs

- Static runtime comparison now includes thirteen selected files: the previous eleven plus `dist/cli/setup.js` and `dist/core/http-dispatcher.js`. No SDK import occurs during inventory.
- Parent and ordinary Node-child network checks must pass before Pi launch. The Pi preload also checks its own OS isolation and correlates the namespace/parent PID with the fresh readiness report before importing SDK modules.
- One Node-launched Pi 0.85.1 CLI, `openai-codex/gpt-6-astra`, high thinking, native `auto` transport, main-only seven-tool allowlist. The synthetic response invokes no tools. No extensions beyond Pi's observed built-in extension, ambient context files, skills, prompt templates, or saved sessions are requested.
- A new private temporary home/repository and generated, nonfunctional OAuth-shaped access token, empty refresh token, and synthetic account. No real credential source or persistent Pi home is mounted/read. The token and temporary home are not copied into retained harness inputs.
- A finite synthetic WebSocket supplies one fixed text response and explicitly present usage categories/default tier. HTTP fallback throws rather than substituting a response; a second request or malformed/model/thinking/tier-drifted serialized payload is rejected.
- The existing native request/context helpers observe actual SDK preparation and raw transport metadata. The probe requires one correlated, complete logical request, the matching normally finalized assistant response and base arithmetic, expected context snapshots, one process lifecycle, and the synthetic transport counters. Tool execution, missing usage, failed capture, timeout, or disagreement fails the checkpoint.

The source-inspected cause of the earlier override loss was ordering: `http-dispatcher.js` captured the synthetic fetch as its initial global, so `configureHttpDispatcher()` regarded it as replaceable and installed Undici globals. The new preload imports the dispatcher **before** installing the synthetic globals, then installs the native observer. This relies on the inspected 0.85.1 override-preservation behavior; the retained main-only CLI run subsequently confirmed that behavior for its single turn. OS network denial remains the independent barrier if that assumption fails again.

## Bounds and evidence

Pi has a twenty-second process-group timeout; each stdout/stderr capture retains at most 1 MiB and kills the process group on overflow. The enclosing synthetic mode has a forty-five-second watchdog. The same non-root/read-only/capability/mount restrictions and Docker cleanup apply. The copied asset set contains only named evaluation files—not the checkout, package dependencies, user config, home, or credential stores.

The fresh output directory retains:

- `evidence/verification.json`: isolation readiness, **not** Pi success;
- `evidence/synthetic/invocation.json`: fixed args, pricing and environment key names, not credential values;
- stdout/stderr and `process-outcome.json`, including partial failures;
- `native-config.json`, per-process native records, and synthetic transport counters;
- `evidence/synthetic/summary.json`: created only after successful reconciliation, unchanged temporary auth/fixture checks and temporary cleanup.

Successful container stdout must contain **both** `OFFLINE_VERIFIED` and `SYNTHETIC_PI_VERIFIED`, and the host/cleanup outcomes must succeed. The summary does not claim observed OS packet counts or provider billing provenance. Toy synthetic token counts/cost arithmetic are not real usage or evidence of authenticated provider access.

**Stop after the command and share its printed artifact directory and outcome.** If it fails, preserve the directory; do not rerun the disabled probe in the connected container, loosen isolation, install packages, or automatically retry. The next increment is the separately selected Guild-child mode linked above, inside the same restrictions. Complete execution/receipt/resume binding and independent review still block live E1 entry.

## Local evidence and limits

Tests cover host mode selection and missing-success evidence using an inert Docker fixture; synthetic request policy and finite responses; invalid preload entry rejection; bounded process capture with an actual inert Node process; and rejection of incomplete/corrupted synthetic CLI evidence. No actual Pi process or SDK provider invocation was launched in this environment during implementation. The earlier operator readiness reports `offline-docker.WQrHbeI8` (this project) and `offline-docker.ABnMPci5` passed their then-current readiness checks, but do not attest to this new mode.
