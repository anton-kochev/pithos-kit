---
name: go-engineering
description: >-
  Repository-aware, framework-neutral Go engineering guidance. Use for substantive
  Go code in the repository or an explicit repository-scoped request to create it:
  package and API design, domain rules, errors, testing, concurrency, services,
  CLIs, libraries, security, or performance. Discover module/workspace boundaries,
  supported Go versions, selected toolchains, build configuration, dependencies,
  and local conventions before proposing changes. Apply only the relevant depth;
  incidental snippets and unrelated non-Go tasks are not triggers.
---

# Go engineering

Start from the repository and the requested behavior, not an architecture template.
Use ordinary Go functions, types, packages, and explicit dependencies until a
concrete requirement justifies more structure. Preserve working conventions and
appropriate frameworks, assertion libraries, and tooling.
Standard-library-first is a starting point, not permission to remove dependencies.

## Scope, discovery, and authority

Confirm substantive repository-connected Go work before applying this guidance.
A stray snippet, generated example, or dependency name does not establish scope.
For a new Go component, establish its intended consumers and supported environment;
do not invent a minimum Go version or initialize a module without authorization.

This is a Pi-native parent-discoverable skill, loaded on demand when enabled.
A Guild Go profile supplies compact expertise, not automatic injection of this skill.
Guild children disable ambient skill discovery; parent discovery does not transfer
this body or its references to a child. Supply needed constraints and explicit
local reading paths in a self-contained handover instead of assuming inheritance.

Follow role permissions and repository instructions before any proposed action:
- Explorer gathers evidence and identifies unknowns; it does not edit or run tests.
- Architect defines options, contracts, risks, and a testable handoff; it stays read-only.
- Reviewer inspects evidence and reports findings, not unexecuted verification.
- Coder implements and verifies only the authorized scope with available tools.
- Writer remains `writer/general`; prose guidance grants no shell or web access.

Commands here are conditional examples, not automatic execution authorization.
Respect network policy, secrets, resource budgets, and deployment boundaries.
Do not install tools at `@latest`, upgrade Go or dependencies, change global Go
settings, or bypass policy just to follow a recommendation. Missing capabilities
are a reported limitation or an explicit decision for the parent, not a workaround.

## Establish the effective build

Read repository instructions, relevant manifests, CI, build scripts, source, and
nearby tests. Record the evidence supporting the intended execution scope:

- Locate each relevant `go.mod`: module path, `go` and optional `toolchain`
  directives, requirements, replacements, exclusions, and release boundaries.
- Inspect `go.work` when present or selected: workspace modules, replacements,
  and directives can change local resolution. Do not assume the repository root
  is a module or that a workspace build proves each module works independently.
- Treat `go.sum` as module-content checksums, not an exact dependency lockfile or
  a complete list of currently selected dependencies. Read requirements and the
  effective module graph; inspect vendoring and repository resolution policy.
- Distinguish the module's language/minimum-version requirements from the selected
  compiler/toolchain. Inspect CI images, development configuration, and effective
  `GOTOOLCHAIN`/workspace selection where available; an installed binary alone
  does not establish the compiler used for every command.
- Check `GOOS`, `GOARCH`, cgo, build tags, platform-suffixed files, generated code,
  and native dependencies. A package omitted by the current build may still be supported.
- Identify frameworks, drivers, assertions, analyzers, formatting, generators,
  module download policy, test services, and the actual CI verification matrix.
- Separate the consumer support floor from the developer's newer local environment.
  Validate relevant APIs against the former, including APIs used only in tests.

[Go Toolchains](https://go.dev/doc/toolchain) explains selection and version
requirements. Selection can download a toolchain; module-management commands can
change version requirements. Inspect policy before executing even discovery
commands that invoke Go. Do not use `go mod tidy` as a harmless inspection step.
When permitted, scoped `go version` and selected `go env` fields can confirm local
facts; avoid dumping credentials or claiming those facts describe every CI job.

## Choose the reference that answers the current risk

Load only the references needed for this task:

- Read [testing](references/testing.md) when changing behavior, selecting Go test
  idioms, reproducing a defect, or planning capability-aware verification.
- Read [design and domain](references/design-and-domain.md) when changing package
  boundaries, public APIs, domain invariants, persistence, or error contracts.
- Read [concurrency](references/concurrency.md) when goroutines, cancellation,
  channels, locks, bounded work, shutdown, or timing defects affect correctness.
- Read [workloads](references/workloads.md) for service, CLI/tooling, or library
  boundaries, including their security, deployment, and compatibility risks.

## Work from behavior to a small design

Trace the affected input through validation, state changes, I/O, and output.
Name the observable contract, failure behavior, resource ownership, and callers.
Resolve missing product decisions before encoding them as implementation defaults.
Select the narrowest cohesive change; do not reorganize unrelated packages.

Prefer packages named for a responsibility and consumer need rather than generic
`helpers`, `common`, or mechanically translated architecture layers.
Keep dependencies acyclic and make visibility intentional. A single root package
or command can be sufficient; `cmd/` is a convention, not a required skeleton.
The [module layout guide](https://go.dev/doc/modules/layout) shows several scales;
`internal` constrains imports by Go's visibility rules, not a security sandbox.

Prefer small consumer-owned interfaces when substitution is actually useful.
Do not create an interface for every concrete type, entity, or dependency.
Use explicit construction and ownership; no DI container or framework is required.
Follow local formatting and naming; distinguish style preferences from correctness.
[Go Code Review Comments](https://go.dev/wiki/CodeReviewComments) provides useful
conventions, not authority to rewrite healthy code or override versioned APIs.

DDD can help a complex business domain; it is not a prerequisite for Go work.
Use domain language, explicit invariants, and consistency boundaries when they
reduce real ambiguity. Simple transformations and CRUD may need plain functions.
Do not equate bounded contexts with microservices, packages, or separate modules.
Constructors do not prevent every zero-value instance; unexported state does not
make aliased slices or maps immutable. Define zero-value and ownership behavior.
Do not mandate repository interfaces, CQRS, event sourcing, or a folder template.

## Errors and compatibility are contracts

Handle errors deliberately; do not discard failures merely to simplify control flow.
Return actionable context without leaking credentials, internals, or private data.
Translate errors at boundaries where callers should not depend on implementation.
Use `%w` and `errors.Is`/`errors.As` on supported versions when an inspectable chain
is intended; do not ban `fmt.Errorf` or wrap every infrastructure error by habit.
Wrapping can expose an underlying error as an API commitment, as explained in
[Working with Errors in Go](https://go.dev/blog/go1.13-errors).

Specify which outcomes callers can inspect and which text is only diagnostic.
Reserve panic for a justified contract, not ordinary invalid input or I/O failures.
Review exported types, method sets, interface changes, serialized shapes, nil/empty
behavior, ordering, and cancellation semantics for compatibility, not just compilation.
Keep dependencies and Go-version changes out of an unrelated behavioral fix.

## Concurrency and resource ownership

Prefer synchronous APIs unless concurrency serves a demonstrated requirement.
For each goroutine, identify its owner, stop condition, and completion observation.
Propagate context deadlines and cancellation across supported I/O boundaries;
cancellation is a signal, not proof that work stopped or a side effect rolled back.
Bound concurrency, queues, input size, retries, and total work, not just request time.
Define channel close/send ownership and protect compound shared-state invariants.
Close resources on every path; avoid retaining deferred cleanup across unbounded loops.
Test cancellation, failure, blocked consumers, and shutdown as well as success.
A clean race-detector run cannot prove freedom from deadlock or logical races.

## Test-first behavior and bounded verification

Reuse the language-neutral `tdd` skill for test-first methodology; this skill adds
Go-specific design and tooling guidance, not a second red-green-refactor procedure.
Use it proactively for non-trivial logic and honor any explicit required-TDD contract.
Do not label tests written afterward or unexecuted red/green intentions as TDD.
Keep existing assertion and fixture conventions unless a change is justified.

Choose a focused package/test command first, then relevant broader checks from CI.
Set explicit scope and time limits. For example, where the named package and test
exist and execution is authorized:
`go test ./path/to/package -run '^TestBehavior$' -count=1 -timeout=60s`
describes a bounded focused run, not a universal command.
Adapt the path, timeout, tags, and environment; tests can still contact external services.
Use repository wrappers when they supply necessary isolation or configuration.
Do not assume `go test ./...` at a workspace root covers all modules.

Select race detection, vet, fuzzing, integration tests, vulnerability scanning, and
benchmarks by risk and capability. Confirm version/platform support and costs first.
Optional `testing/synctest` requires a compatible toolchain and API; it is not a
reason to raise the supported version. Prefer explicit synchronization to sleeps.
Report commands, working directory, configuration, observed diagnostics, and omissions.
Never claim a check passed unless it ran and its result was observed.

## Security, performance, and completion

Validate untrusted input at boundaries and enforce authorization at the operation
that owns the protected resource. Bound parsing, decompression, allocation, and I/O.
Preserve safe database parameterization, path handling, subprocess arguments,
transport security, and secret-redaction conventions; flag concrete gaps, not fashions.
Treat vulnerability scans as bounded evidence, not a security certificate.

Profile or measure representative workloads before optimizing. Establish latency,
throughput, allocation, or contention goals; keep benchmark setup and environment
comparable. Do not introduce pooling, unsafe code, or concurrency from intuition alone.
Preserve correctness and ownership while measuring any proposed improvement.

Finish with the changed contract, supporting repository evidence, actual checks,
remaining risks, and any authorization or environment gaps. Distinguish inspection,
supplied research, and observed execution. Keep unrelated edits and dependencies intact.
