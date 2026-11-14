# Go testing and verification

Read this reference when changing behavior or choosing evidence for a Go change.
Reuse `tdd` for methodology and required-practice reporting; do not substitute a
Go-specific ritual. Discover local commands, versions, fixtures, and CI first.

## Select observable tests

- Exercise real internal logic; fake external boundaries only where useful.
- Choose table-driven tests when cases share setup and assertions. Give cases
  descriptive names and use subtests where they improve isolation or diagnostics.
- Keep distinct workflows as distinct tests instead of forcing a giant case table.
- Assert semantic results and side effects, not incidental call sequences.
- Check error identity/type through the supported public contract, using
  `errors.Is` or `errors.As` when appropriate; match text only when text is a contract.
- Include invalid input, empty/nil data, boundaries, partial failure, cancellation,
  and cleanup cases that carry actual risk. Check both result and forbidden effects.
- Use external-package tests where public-consumer behavior matters; retain
  same-package tests when justified by the repository and implementation risk.
- Preserve existing assertion libraries. Standard-library tests need no new dependency.

[Go Test Comments](https://go.dev/wiki/TestComments) supports readable test cases
and diagnostics. Treat historical API advice cautiously: `%w` preserves error
information on supported versions. Assertion-library preferences are not mandates.

## Fixtures and boundaries

Give each test ownership of temporary files, listeners, processes, and cleanup.
Use supported test helpers and repository conventions; verify newer helper APIs
against the oldest test toolchain rather than assuming current documentation applies.
Avoid mutable global fixtures, real credentials, fixed ports, and shared directories.
Enable parallel tests only when their dependencies and state are isolated.
Check loop-variable semantics against the module's language version before relying
on modern capture behavior; do not mechanically rewrite established safe patterns.

Use small fakes to control network failures, time, and external outcomes.
A fake database cannot prove transaction isolation, SQL, constraints, or migrations.
Use repository-supported real-provider integration tests for those semantics.
Record the provider/version and configuration tested, and keep destructive tests
inside disposable authorized environments. Never infer production readiness from a mock.

## Timing and concurrency

Coordinate with explicit events or synchronization rather than arbitrary sleeps.
A timeout bounds a hung test; it does not establish that workers reached a state.
Assert worker completion, cancellation response, and cleanup after failure.
Test blocked sends/receives and shutdown races where the affected lifecycle permits them.
Keep failure diagnostics in the test's control flow; workers should communicate
results back rather than relying on test termination to clean up their work.

Use `testing/synctest` only if the repository supports its API and execution model.
[Testing Time](https://go.dev/blog/testing-time) describes general availability in
Go 1.25 after a different experimental API in Go 1.24. Do not copy the experimental
API into stable-version guidance or upgrade a repository just to use this package.
Consult the target-version documentation before choosing a specific API call.
Fake time alone is not synchronization. Real I/O, syscalls, cgo, and mutex blocking
have important limits; do not assume a test bubble controls external work.
Where unavailable, retain suitable clock seams and explicit coordination.

## Select bounded commands

These examples require an execution-capable role and authorization. Replace the
illustrative package/test names, use the correct module directory, and preserve
CI flags, tags, environment, and wrapper scripts. Set an outer execution budget
for compilation, downloads, benchmark/fuzz workers, and subprocesses as well as tests;
a test binary's timeout is not a budget for the entire command. Do not run these as
an automatic checklist.

| Risk | Conditional example | Interpretation |
| --- | --- | --- |
| Focused regression | `go test ./path/to/package -run '^TestBehavior$' -count=1 -timeout=60s` | Executes the selected test scope without cached success; confirm it selected a test. |
| Affected package suite | `go test ./path/to/package -timeout=2m` | May use cached results; note cache status when reporting. |
| Shared-memory changes | `go test -race ./path/to/package -timeout=3m` | Requires a supported target/toolchain and cgo/compiler setup. |
| Static diagnostics | `go vet ./path/to/package` | Bound execution externally; findings and silence both need interpretation. |
| Parser/property exploration | `go test ./path/to/package -run '^$' -fuzz '^FuzzDecode$' -fuzztime=20s -timeout=60s` | Requires supported native fuzzing and a real target; cap workers/resources as needed. |
| Measured hot path | `go test ./path/to/package -run '^$' -bench '^BenchmarkOperation$' -benchmem -benchtime=1s -count=3 -timeout=60s` | Compare representative inputs and equivalent environments, not a single favorable sample. |

These commands may compile, download dependencies/toolchains, write caches, and
execute arbitrary repository tests. Inspect policy and fixtures before running.
Expand coverage to other affected packages/modules and supported build variants
according to risk. Cross-compilation does not prove runtime behavior on that target.

The [race detector](https://go.dev/doc/articles/race_detector) detects races on
executed paths, not all races, deadlocks, leaks, or business-level concurrency defects.
Its target support and overhead vary; inspect current target-specific support.
Fuzzing explores a bounded input sample, not every input. Keep useful regression
seeds under repository policy and make properties stronger than merely “no panic.”

## Optional vulnerability checks and reporting

Use an approved installed `govulncheck` only when relevant and permitted; scope it
to selected packages, build configuration, network access, and a finite run budget.
Do not install or upgrade it at `@latest` by default. Its documentation explains
[known-vulnerability checking](https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck):
default operation contacts a vulnerability database and results can have false
positives or negatives. Machine-readable modes may return success despite findings;
interpret the chosen format/tool version rather than treating exit zero as clean.

Report exact commands, module/workspace context, toolchain, tags/platform, observed
outcomes, and scope omitted. Distinguish cached results, inspected tests, supplied
logs, and tests actually executed. Report infrastructure failures separately from
behavioral failures when evidence supports that distinction. No analyzer or passing
suite establishes universal correctness, concurrency safety, or security.
