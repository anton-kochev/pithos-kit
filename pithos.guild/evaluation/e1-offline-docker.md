# E1 offline Docker readiness harness

**Status: initial host readiness verified.** Retained operator runs `offline-docker.WQrHbeI8` (this project) and `offline-docker.ABnMPci5` passed parent/child network checks, source-runtime comparison, host exit and cleanup checks. The copied verifiers matched the implementation reviewed at that checkpoint.

The default command remains verification-only. The explicit [synthetic main-only CLI mode](./e1-offline-synthetic.md) subsequently passed host run `offline-docker.7HBxaKLK`. The first separate [Guild-child mode](./e1-offline-guild.md) attempt failed during child startup; a diagnostic run subsequently hit the 32-task PID/thread limit. The operator approved 64 tasks; `offline-docker.d2iWYHzd` then passed the fixed synthetic Guild checkpoint and retained-evidence revalidation. Live campaign binding remains incomplete. Neither mode re-enables the old failed probe, creates a campaign, or authorizes model spending.

**Later source-only auth update:** the synthetic modes now copy `scoped-auth-identity.ts` and use synthetic JWTs with matching expiry claims for the [launch/prepared-request auth wiring](./e1-scoped-auth-identity.md). Only inert/local and mock-Docker checks have exercised this update. It requires separately authorized fresh restricted integration; none of the historical host checkpoints certify these changes. Container/network/resource limits are unchanged.

**Later source-only configuration update:** both synthetic bootstraps now consume the [bounded configuration reader](e1-native-config-reading.md) before dispatcher imports. Their copied roster adds `native-config.ts`, and the writer provides a mandatory raw-byte digest environment entry. Mock-Docker asset checks passed; no fresh host run has exercised this change. Historical checkpoints and container/network/resource limits remain unchanged.

**Later source-only runtime-input update:** the [runtime loader and shared contracts](e1-runtime-input-loading.md) add `native-runtime-input.ts`, `native-input-contracts.ts` and `native-policy.ts` to the synthetic roster. Bound configurations validate their retained sibling and still stop before runtime observation/SDK imports. No fresh restricted host validation has occurred.

## Why a separate container

A native CLI probe escaped its JavaScript synthetic-transport overrides: retained output showed native WebSocket failure/fallback and a real endpoint rejecting its synthetic token. No real credential was supplied, but the invocation must not be described as offline or as having zero actual HTTP requests. Its failed artifacts remain retained; its probe and the unfinished native driver mode remain disabled.

Pithos's normal [Docker launcher](https://github.com/anton-kochev/pithos/blob/main/src/docker/run.rs) does not request network denial and mounts persistent home state. Its [entrypoint](https://github.com/anton-kochev/pithos/blob/main/entrypoint.sh) also reconciles settings/packages. Neither is the desired bootstrap for an isolated test. Docker's [`none` network driver](https://docs.docker.com/engine/network/drivers/none/) supplies a separate, loopback-only network stack.

The new script leaves the interactive Pithos container connected and creates a separate disposable container from its **existing immutable image ID**. It overrides the entrypoint, clears the effective process environment, and mounts neither the checkout nor the source container's home, credentials, sessions, environment file, clipboard bridge, or Docker socket. Only copied readiness scripts/static inventory and a fresh output directory are mounted. No credentials—even synthetic ones—are needed for these checks.

## Run from your host terminal

Use the local Docker daemon/Docker Desktop that is running your current Pithos session. Do not run this inside Pi's container, pass Docker flags to `pithos`, disconnect the interactive container, or enable a privileged nested Docker daemon.

From the host's `pithos-kit` checkout:

```bash
# Identify the currently running Pithos container.
docker ps --format '{{.Names}}'

# Replace the example name with the container running this session.
bash pithos.guild/evaluation/offline-docker.sh pithos-pithos-kit-12345
```

Requirements: host Bash (the script avoids Bash-4-only features), standard POSIX utilities, an existing local Docker image, and a non-root host user able to use Docker. Checkout paths containing commas/newlines and images declaring automatic volumes are rejected. No host Node, jq, image pull/build, package installation, version change, or daemon configuration change is required.

The reviewed inventory uses `/usr/bin/node` **24.20.0**, Pi **0.85.1**, and its nested pi-ai **0.85.1**. The script performs static file reads in the selected source container via `docker exec` with an empty environment; it does not import the SDK or inspect credentials/settings. It compares the disposable container's selected file hashes against that inventory. If runtime changes exist only in the source container's writable layer, comparison with the original image will fail. Do not repair this automatically with an install, image commit, rebuild, or alternative runtime.

## What it verifies

Before starting the disposable container, the host checks its immutable image ID, `network=none`, non-root user, read-only root filesystem, dropped capabilities, no-new-privileges setting, private/default process/IPC/UTS settings, no added devices, and exact bind-mount destinations/access modes. The container has a writable temporary filesystem, a 512 MiB memory limit, an operator-approved 64-task PID/thread limit, and one CPU allowance.

The verifier then:

1. Checks the actual process's loopback-only interfaces/routes, zero capability sets, non-root UID, and no-new-privileges status **before any socket check**.
2. Compares static Node/Pi versions and thirteen selected file hashes with the source inventory. This is not a complete dependency-closure audit or native execution attestation.
3. Runs a working local TCP loopback control, followed by TCP and UDP checks to numeric IPv4/IPv6 documentation addresses (`192.0.2.1`, `2001:db8::1`, port 9). These are not provider endpoints; no DNS, HTTP, TLS, authentication, or model request is used. Only kernel `ENETUNREACH` counts as the expected rejection. A timeout, refused connection, other error, or successful send/connect fails verification.
4. Repeats the structural and socket checks in an ordinary Node child, checking its PID/parent PID, matching network namespace and UID, and all four denial results.
5. Writes a report only after successful checks. Socket checks have two-second bounds, the child a ten-second kill timeout, and the verifier a twenty-second watchdog. Docker-daemon operations themselves are not given a portable host-side timeout; interrupt the script if the daemon stalls.

This is an OS network restriction for this disposable process tree—not protection against a hostile Docker administrator, kernel exploits, or a coordinated rewrite of evidence. A successful report does not certify provider metering, request policy, billing, auth entitlement, or E1 readiness as a whole.

## Artifacts, cleanup, and the stop point

Every invocation prints a fresh `.pi/evaluation/offline-docker.XXXXXXXX/` directory. It retains copied scripts, `harness/expected-runtime.json`, validated Docker policy/mount summaries, container stdout/stderr, cleanup output, and the host exit code. A successful run also has `evidence/verification.json` and an `OFFLINE_VERIFIED` marker in container stdout. Treat a missing report/marker, nonzero exit, or cleanup error as an unsuccessful checkpoint; retain the directory rather than overwriting or replacing its results.

The script removes only its own container. Its name and ownership label support cleanup when `docker create` loses its response. Interrupted/failed creation with uninspectable ownership is reported as unknown, not silently considered clean. SIGKILL, host failure, or daemon unavailability can prevent cleanup; `container-name.txt` identifies the container to investigate. Do not indiscriminately remove other containers or volumes.

**Stop after this command and share the artifact directory and outcome.** It provides no arbitrary-command mode; only the explicitly selected, fixed synthetic mode linked above may proceed to a Pi probe. Do not remove the existing probe's disable guard or rerun it in the connected container. Verification belongs to the container just checked; after cleanup, its report is not a reusable permission slip for another process. A later synthetic Pi probe must be integrated behind the same checks in a fresh restricted container, reviewed, and retain its own evidence. The initial host readiness checkpoint has been verified; the new synthetic mode requires its own fresh host run.

## Local validation evidence

Maintained tests exercise the real Bash script against an **inert Docker CLI fixture**, not a daemon. They cover launch policy, pre-start drift rejection, failed/missing output, source/image constraints, interruption, lost creation responses, unknown ownership, and cleanup failure. Structural/socket/runtime tests use fixtures for external boundaries; the positive loopback control uses actual local TCP only.

RED/GREEN checkpoints covered missing files/exports, unimplemented socket/tree checks, accepted policy/runtime drift, missing cleanup/error reporting, and Docker template trailing-newline handling. A static inventory using the installed Node successfully read the selected installed files without importing Pi. This environment has no Docker CLI, so none of these results establish an actual Docker launch or observed network denial. The original host command has since been run successfully by the operator, as recorded above. The revised thirteen-file inventory and main-only synthetic mode subsequently passed the retained run noted above; no completed report authorizes a later process outside fresh isolation.
