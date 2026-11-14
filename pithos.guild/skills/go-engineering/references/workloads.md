# Go workload boundaries

Read only the sections relevant to the repository's workload. A service, CLI, and
library can share core logic without sharing lifecycle or compatibility contracts.
Preserve appropriate existing frameworks and dependencies. These are risk checklists,
not a requirement to add a router, command framework, database, or deployment layer.

## Services and workers

Trace ingress through authentication, authorization, validation, execution, persistence,
and response/publication. Apply tenant and object ownership checks where the protected
operation happens, including background consumers and direct data-access paths.

- Bound request bodies, decompression, parsing, pagination, response size, and fan-out.
- Configure timeouts and connection/resource limits for the actual server and clients;
  inspect version-specific framework defaults rather than assuming safe defaults.
- Propagate request context and deadlines to supported downstream operations.
- Close response bodies and other owned resources on all paths according to their APIs.
- Define transaction boundaries, conflict responses, and idempotency for retried writes.
- Do not expose internal error chains, stack traces, credentials, or sensitive records
  in public responses. Keep useful correlation without logging entire payloads.
- Distinguish process liveness from readiness to accept work. Avoid health checks that
  amplify outages through expensive dependencies or unnecessary cascading failures.
- Stop admission and define bounded drain/cancellation behavior before closing shared
  resources. Give background work explicit ownership beyond request lifetimes.

For consumers and scheduled jobs, define delivery/retry assumptions, duplicate effects,
ordering, poison-input handling, checkpoints, and recovery ownership. Acknowledgment
and local state updates may not be atomic; document the failure window instead of
claiming exactly-once effects. Do not add a broker or outbox without a concrete need.

Verify handler logic with focused tests and actual transport/provider behavior with
appropriate integration tests. Mocks cannot prove database isolation, TLS, reverse-proxy
configuration, deployment signals, or broker redelivery behavior. Record missing evidence.

## CLIs and repository tools

Keep command parsing and process lifecycle separate from reusable operation logic
where that enables direct testing. A small command need not have a `cmd/` hierarchy
or a third-party command framework. The [module layout guide](https://go.dev/doc/modules/layout)
shows proportional options rather than a mandatory folder structure.

- Define arguments, flags, configuration precedence, environment inputs, and defaults.
- Keep machine-readable output on its documented stream and diagnostics separate;
  preserve exit status, output schema, ordering, and quoting contracts used by scripts.
- Distinguish usage errors, operation failures, and cancellation where the contract needs it.
- Avoid mandatory interactive prompts in automation. Gate destructive actions with the
  repository's confirmation/dry-run policy; never silently broaden the target set.
- Handle signals and cancel owned subprocesses/work. Ensure cleanup happens before a
  top-level process exit; do not scatter abrupt exits through reusable logic.
- Validate path traversal, symlinks, permissions, overwrite policy, and partial-write
  recovery according to the actual filesystem threat model.
- Pass subprocess arguments explicitly; do not concatenate untrusted input into shell code.
- Keep credentials out of arguments, diagnostics, generated output, and default logs.

Test command behavior through injected streams or the existing harness where useful;
add process-level checks for exit status, signals, and OS behavior when those are at risk.
Use isolated temporary directories and bounded subprocess execution. Cross-platform
support requires evidence for the platforms promised, not only local compilation.

## Reusable libraries

Start with consumers: supported Go versions/platforms, public API, compatibility
expectations, and whether the module is published independently. Keep library users
in control of lifecycle, logging policy, retries, and process termination.
Avoid surprise global state, background goroutines, network calls, or environment
mutation during initialization. Make resource acquisition and cleanup explicit.

Document ownership, concurrency safety, zero-value behavior, nil/empty distinctions,
and whether cancellation can leave effects committed. Keep exported interfaces small;
adding a method can break external implementers. Avoid exporting dependencies' types
unless that coupling is part of the intended contract.

Treat errors callers inspect as public surface. As [Working with Errors in Go](https://go.dev/blog/go1.13-errors)
explains, wrapping underlying errors can commit the API to them. Translate at a stable
boundary when appropriate, while preserving usable diagnostics. Do not promise stable
error text accidentally. Test behavior from the consumer side, not only private helpers.

Check module paths, version policy, examples, and dependency requirements against the
repository's release conventions. A workspace replacement can hide a missing published
dependency or incompatible module; verify independent consumer resolution where needed.
Do not upgrade the supported Go floor merely to use a convenient helper in tests.

## Security and performance across workloads

Use parameterized database operations and context-appropriate escaping; validate data
before costly allocation or interpretation. Bound archive expansion, regular-expression
input, fan-out, and external requests according to risk. Treat URL destinations and file
paths as security boundaries when callers can choose them. Retain TLS verification and
approved cryptographic APIs; do not invent security mechanisms or suppress checks to pass tests.

Use optional approved vulnerability tooling as evidence for the selected build only.
[govulncheck documentation](https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck) describes
known-vulnerability analysis and output modes; neither absence of findings nor success
exit status in every mode is a security certificate. Respect database/network policy.

Define a performance objective before tuning. Profile representative workloads to locate
allocation, I/O, CPU, or contention costs. Compare stable benchmark inputs and environments;
include tail latency or overload behavior when averages would hide the risk. Avoid pooling,
unsafe code, caching, or parallelism without measured benefit and explicit ownership rules.

Record effective `GOOS`, `GOARCH`, cgo/native libraries, tags, generated assets, container
or deployment settings, and relevant CI coverage. Build success is not execution evidence
on another platform. Report tested configurations and operational assumptions separately;
do not claim deployment, load, security, or recovery verification that was not performed.
