# Consistency and reliability

Asynchronous CQRS exchanges a single immediate transaction for explicit delivery,
duplicate, ordering, lag, repair, and operational contracts. Make those contracts
observable before introducing the boundary.

## Name the local transaction

For each command, state exactly what commits atomically. A relational transaction
can include authoritative state and an outbox row in the same database. It does
not automatically include a broker, search cluster, cache, remote API, or separate
database.

Common choices include:

- keep all required state changes in one local transaction;
- commit locally, then invoke a remote effect with persisted repair state;
- invoke first and accept compensation/idempotent retry obligations;
- persist publication intent through an outbox or supported change log; or
- use a provider-supported distributed transaction only when detected, justified,
  and operationally owned.

Do not stretch `TransactionScope` or a similarly named abstraction across
heterogeneous resources and assume atomicity. Inspect provider enlistment,
execution strategy, retry behavior, ambient transaction support, and deployment
configuration.

## Transactional outbox

An outbox writes a durable publication record with the authoritative state in the
same local transaction. A separate relay claims pending rows, publishes them, and
records progress. This closes the process-crash gap between commit and publication
intent, but it does not prove exactly-once delivery or eliminate every loss mode.

Define the outbox contract:

- stable message identifier, type/contract version, occurrence time, source
  position, tenant, and correlation/causation metadata;
- serialization and protection of sensitive fields;
- transaction participation and behavior under application/database retries;
- claim/lock semantics for multiple relay instances;
- batching, ordering, timeout, cancellation, retry, backoff, and rate limits;
- when a row counts as published and how uncertain publish outcomes reconcile;
- poison/dead-letter state, diagnostics, manual replay, and ownership;
- retention, cleanup, indexes, partitioning, and capacity alerts; and
- reconciliation between committed business state and publication records.

A hand-rolled EF Core interceptor/background worker is only an illustrative shape.
Use it only if EF Core and the relevant provider/version are present, scopes and
transactions are correct, multi-instance locking is supported, and the team owns
all missing operations. A package-provided outbox receives the same scrutiny.

## Inbox and idempotency

At-least-once delivery means consumers should expect duplicates. Choose the
smallest sound defense:

- naturally idempotent versioned upsert or absolute-state assignment;
- compare source/entity versions and ignore older input;
- checkpoint a monotonically ordered stream/partition atomically with the local
  projection update, or only after a naturally idempotent update;
- store processed message IDs in an inbox transactionally with local side effects;
  external effects still need downstream idempotency or persisted reconciliation;
  or
- use a provider/package mechanism whose atomicity is verified.

For client-facing commands, an idempotency key identifies one logical operation.
Define key scope (user, tenant, endpoint), payload mismatch behavior, retention,
concurrent duplicate behavior, replayed result, authorization, and transaction
participation. A cache-only dedup check can race with authoritative persistence.

Do not label an operation idempotent because it usually produces the same final
row. Email, payment, inventory, external calls, emitted messages, audit entries,
and counters may still duplicate. A crash after an external effect succeeds but
before the inbox record commits is an explicit failure window unless the downstream
operation deduplicates or the workflow can reconcile it.

## Ordering, concurrency, and gaps

State the ordering guarantee actually provided: aggregate/stream, broker
partition, tenant, global, or none. Keying by aggregate identity can preserve
per-entity order when the transport supports it; it does not create cross-entity
order.

Consumers should define:

- expected source version/position and optimistic-concurrency behavior;
- action for older, duplicate, future, or missing versions;
- bounded waiting or parking for gaps;
- repartitioning and parallel-consumer behavior;
- replay interaction with live traffic; and
- whether a conflict is retried, rejected, reconciled, or escalated.

Retries must be safe for the entire operation, not merely the database call. Avoid
automatic retry around unknown external side effects unless the downstream
contract has a reliable idempotency mechanism.

## Poison work and recovery

A poison message is input that repeatedly fails for a deterministic reason or has
exhausted bounded transient retries. Move it to a failed/dead-letter state with:

- original contract bytes or a protected durable reference;
- type/version, source position, tenant, correlation, attempt count, and failure
  diagnostics;
- access controls and retention matching the payload sensitivity;
- an alert and named owner;
- a runbook for classify, repair, replay, skip, or compensate; and
- projection reconciliation after resolution.

A dead-letter queue nobody watches is delayed data loss. A retry loop with no cap
is an availability incident. A manual skip without a business reconciliation is
silent inconsistency.

## Event and message evolution

Durable messages outlive deployments and often outlive code structures. Version
the contract, not the CLR filename. Prefer:

1. additive optional fields with meaningful defaults and tolerant readers;
2. a tested transformation/upcaster when old persisted shapes can map
   unambiguously to the current semantic contract; or
3. a new contract type for a breaking semantic change, with both versions handled
   through a defined migration window.

Plan producer-first or consumer-first deployment according to compatibility.
Include rolling and rollback versions, delayed messages, offline consumers,
replayed history, and rebuilt projections. Keep representative historical payload
fixtures and verify deserialization plus behavior in CI.

Never mutate persisted event history casually. When legal deletion, redaction, or
crypto-shredding is required, design that obligation explicitly rather than
promising absolute immutability that conflicts with policy.

## Eventual consistency as product behavior

For every asynchronous command and query, define:

- when intent is durably accepted;
- whether completion can fail later and how the user learns that;
- which result screens may lag and for how long;
- which operation rechecks current authoritative state;
- what `Pending`, `Failed`, retry, cancel, and support states mean; and
- how read-your-own-writes is achieved where required.

Possible experiences include optimistic state, current detail-by-ID reads,
explicit processing status, polling/subscription, version-aware waiting, or a
refresh affordance. Choose according to risk. Blocking until a projection catches
up can be valid for a narrow high-stakes workflow, but it couples availability and
latency to the projector and needs a timeout/failure contract.

## Observability and operations

Before asynchronous rollout, instrument and assign owners for:

- correlation/causation and distributed trace continuity;
- outbox pending count, oldest age, publish rate, failures, and uncertain outcomes;
- broker backlog, redelivery, consumer throughput, retry, and dead-letter count;
- per-projection source checkpoint, lag, apply failures, and stale-read rate;
- read/write reconciliation and invariant violations;
- rebuild/backfill progress, ETA, resource use, and validation;
- dependency readiness versus liveness; and
- service-level thresholds and recovery objectives.

Logs and traces must avoid credentials, tokens, personal data, secrets, and
sensitive event/message payloads. Prefer identifiers and protected diagnostic
references. Define cardinality limits for tenant, entity, message, and error tags.

A dashboard without alert ownership and a runbook is documentation, not an
operational control. Rehearse relay failover, poison repair, projection rebuild,
backup/restore, and rollback; record observed times and gaps.

## Verification matrix

| Risk | Useful evidence |
| --- | --- |
| atomic state + intent | real-provider test that commit/rollback includes both authoritative change and outbox record |
| duplicate delivery | apply the same message concurrently and sequentially; observe one logical effect |
| uncertain publish | simulate timeout after broker acceptance and prove retry/reconciliation is safe |
| ordering/gaps | feed old, duplicate, future, and missing positions through the real consumer logic |
| poison handling | exhaust bounded retries, observe failed state/alert, repair, and replay |
| compatibility | deserialize historical fixtures under mixed producer/consumer versions |
| lag UX | verify current and stale query routing plus pending/failure user contracts |
| recovery | rebuild from the durable source and reconcile against authoritative expectations |

Use repository-supported fault injection and isolated infrastructure. Never claim
exactly-once, no-loss, ordered, or recoverable behavior from an interface name or
configuration snippet alone.
