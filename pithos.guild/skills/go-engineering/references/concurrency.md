# Go concurrency and lifecycle

Read this reference when work crosses goroutines, cancellation boundaries, queues,
channels, locks, or shutdown paths. Start with ownership and completion, not primitives.
Use synchronous execution unless concurrency serves a concrete latency, throughput,
or independent-lifecycle requirement. More goroutines are not automatically faster.

## Give every goroutine an owner

Before starting work, answer:
- Who creates it, and what limits the number of active instances?
- Which data and resources does it own or borrow?
- What stops it on success, error, cancellation, and parent shutdown?
- What unblocks every possible wait when a peer exits early?
- Who observes its outcome and waits for completion?
- Can it outlive a request, and if so, what explicit longer-lived owner accepts it?

Write these answers into the API or local lifecycle, not just a comment promising
cleanup. Avoid fire-and-forget work whose errors and resources have no owner.
[Go Code Review Comments](https://go.dev/wiki/CodeReviewComments) emphasizes clear
goroutine lifetimes, context propagation, and synchronous defaults.

## Context and cancellation

Propagate the caller's context through operations that support it. Follow Go and
repository conventions for explicit context parameters; do not use context values
as an untyped bag of optional business parameters or hide required dependencies there.
Do not replace a request context with a background context to suppress cancellation
unless an explicit ownership transfer and durable/longer-lived contract justify it.

Release resources associated with derived contexts as their documented APIs require.
A deadline expresses a bound on cooperative work; it does not forcibly terminate
arbitrary computation or an API that ignores cancellation. Check expensive loops
at useful points and use supported I/O cancellation/deadline mechanisms.
Cancellation does not roll back a committed side effect or prove a worker has stopped.
Define how callers discover an uncertain external result before retrying it.

Treat cancellation signals and completion observations separately. Signal stop,
unblock pending work, then join owned workers within a bounded shutdown policy.
Do not introduce a circular wait in which a worker needs a resource held by its owner
while the owner waits for the worker. Escalate unresolved external blocking explicitly.

## Shared state, channels, and locks

Choose primitives around the invariant and ownership model. Channels can transfer
ownership or coordinate stages; mutexes can protect shared state. Neither is a universal
replacement for the other. Use established repository primitives when suitable.

- Specify who sends, receives, and closes each channel; prevent send-after-close.
- Close to express a meaningful end of production, not as a universal cleanup ritual.
- Make blocking sends/receives interruptible when lifecycle cancellation requires it.
- Document whether buffered work drains, is discarded, or is persisted at shutdown.
- Protect related fields together when the invariant spans them. Atomic access to
  individual fields does not by itself make a compound operation consistent.
- Keep lock scope understandable; avoid holding locks across unknown callbacks or
  slow I/O unless a documented invariant requires it and deadlock risk is addressed.
- Set a lock-order policy when multiple locks are necessary; avoid copying live locks.
- Do not assume that choosing a `select` cancellation case guarantees cancellation
  wins when other cases are ready. Design acceptable completion semantics explicitly.

Avoid shared mutable aliases across workers unless synchronization is explicit.
Copying a slice header, map-containing struct, or pointer does not isolate its data.
Document the synchronization edge that makes a value safe to observe, not an assumed
scheduler order or a sleep that happened to work locally.

## Bound work and define failure policy

Bound active workers, queue length, input size, retained results, and retry attempts.
Choose backpressure, rejection, or durable queuing intentionally; unbounded buffering
only moves overload into memory. Include total request budgets and downstream limits.
A worker limit alone does not bound queued inputs or already allocated payloads.

Define whether one failure cancels siblings, whether partial results are useful, and
which error is returned. Preserve important diagnostics without logging each failure
at every layer. Retry only eligible operations with bounded delay and cancellation;
consider duplicate effects and retry amplification across service layers.
Do not add a concurrency helper dependency merely to avoid designing this policy.

On shutdown, stop admission, signal owned work, apply the drain/abort policy, observe
completion, and close resources in dependency order. Specify the deadline and what
happens to incomplete work. Test startup failure and partial initialization too.

## Verify the claim actually at risk

Use explicit coordination to reach states such as “consumer blocked” or “worker
started.” A sleep does not establish that state; a timeout is a watchdog, not proof.
Test early peer exit, cancellation, saturated queues, repeated shutdown where
supported, and error paths that otherwise strand workers or resources.
Race tests must execute the relevant interleavings; repeat runs can increase evidence
but cannot exhaust possible schedules or prove fairness.

The [race detector](https://go.dev/doc/articles/race_detector) finds data races on
executed paths. It does not prove freedom from deadlocks, leaks, starvation, or
logical races. Verify target/cgo/compiler support and budget its runtime overhead.
Use observations and profiling when investigating contention; do not optimize by guesswork.

Optional `testing/synctest` can help supported tests, not every concurrent system.
[Testing Time](https://go.dev/blog/testing-time) distinguishes Go 1.25's generally
available package from Go 1.24's experimental API. Gate usage on the repository's
supported versions and consult matching API documentation before writing calls.
Fake time is not synchronization; real I/O, syscalls, cgo, and mutex blocking have
important limits. Retain explicit coordination and existing clock seams where needed.
Report tested paths, configuration, and untested lifecycle assumptions honestly.
