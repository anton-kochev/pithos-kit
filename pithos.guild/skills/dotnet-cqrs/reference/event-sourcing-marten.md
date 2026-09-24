# Event sourcing and conditional Marten guidance

Event sourcing persists facts that happened and derives current state through a
fold. It can support CQRS naturally, but it is an independent persistence choice
with long-lived compatibility and operational consequences.

## Eligibility for event sourcing

Require a repository-connected need such as:

- temporal reconstruction is part of the product or a regulatory contract;
- the sequence of decisions carries domain meaning;
- complete historical facts enable known retroactive projections; or
- an existing event-sourced context must be evolved or repaired.

Do not select event sourcing merely for an audit log, event-driven integration,
anticipated scale, or framework preference. Compare state storage with temporal
or history tables, append-only audit records, and an outbox. Apply event sourcing
per bounded context; catalog, preferences, and reference data can remain
state-stored beside a history-rich workflow.

Before implementation, confirm team ownership for event modeling, versioning,
projection operations, replay performance, backup/restore, incident repair, and
long-term retention/deletion policy.

## Event and stream contracts

An event is a past-tense domain fact with a stable semantic contract. Define:

- stream/aggregate identity, tenant boundary, and stream lifecycle;
- the command decision and invariant that produced it;
- event identifier, type, schema version, occurred/recorded time, correlation,
  causation, actor, and source metadata;
- optimistic-concurrency/expected-version behavior;
- serialization, unknown-field, and historical deserialization policy;
- sensitive-data minimization, encryption, access, retention, and deletion; and
- correction through compensating/corrective facts or another explicit repair
  mechanism.

An append-only store does not guarantee truthful history. Invalid commands,
incorrect clocks, compromised identities, or buggy decisions can record incorrect
facts permanently. Authorization, validation, review, and repair policy remain
load-bearing.

Avoid event types that mirror table updates (`StatusChanged` with arbitrary old
and new values) when a business fact (`OrderShipped`) carries the real intent.
Also avoid forcing every property edit into domain theater when history has no
meaningful consumer.

## Decision and fold

The write-side model is reconstructed by folding events. Keep the decision
separable from persistence where repository conventions permit:

```text
historical events → fold current decision state
current state + authorized command → expected outcome or new events
append new events with expected stream version
```

This shape supports fast domain tests with given history, a command, and expected
outcome/events. The handler still owns I/O orchestration, cancellation,
authorization context, stream loading, append, transaction, and result mapping.
Do not hide state-dependent authorization in a projection that may be stale.

Time, randomness, identifiers, exchange rates, and external decisions needed for
future replay should be supplied to the decision and captured in event data or a
stable reference. A projection that reads the current clock or calls a changing
external service is not deterministic.

## Concurrency and transactions

Expected-version checks prevent two writers from silently appending incompatible
facts to one stream. Define conflict behavior:

- surface a stable conflict and let the caller retry with current state;
- automatically retry only when the entire command decision and side effects are
  safe to repeat; or
- coordinate explicitly when the invariant spans streams or resources.

Keep aggregate/stream boundaries aligned to atomic invariants. Cross-stream
transactions can be supported by some stores, but they increase contention and
do not replace careful consistency design. External messages still need an
outbox/subscription mechanism whose atomicity with the append is verified.

## Projection lifecycles

Event-sourced read models are projections, but not every projection needs the same
consistency:

- **on-demand/live fold:** current but increasingly expensive with stream length;
- **same-transaction/inline projection:** current when the store truly includes it
  in the append transaction, with added write cost and failure coupling; or
- **asynchronous projection:** scalable and independently recoverable, with lag,
  duplicate, ordering, telemetry, and UX obligations.

Choose per query. A must-be-current decision should fold authoritative events or
use a verified current snapshot, not an async read model. Cross-stream reports and
search often tolerate async projection when the product contract says so.

Every projection needs deterministic apply behavior, source position, idempotency,
ordering scope, checkpoint atomicity, schema migration, rebuild, validation,
cutover, and poison recovery.

## Snapshots

A snapshot is a performance optimization for reconstructing stream state, not a
source of truth and not a default requirement. Add one only after measured fold
cost justifies it.

Define snapshot schema/version, source stream position, invalidation, migration,
and behavior when missing or corrupt. It must be safe to discard and rebuild from
events. Test equivalence between a full fold and snapshot-plus-tail across
historical versions.

## Event evolution and historical compatibility

Past events may be replayed years after their original deployment. Prefer
additive evolution with tolerant readers. When semantics change, choose and test:

- upcasting/transformation from old persisted shape to a current semantic shape;
- multiple apply handlers for explicit historical versions; or
- a new event contract and migration period.

Keep representative persisted payload fixtures. Test deserialization, fold
results, projections, snapshots, and rebuilds against them. Include unknown event
types, deleted/renamed CLR types, time-zone/precision changes, numeric changes,
and mixed deployment versions where relevant.

Legal erasure and correction can conflict with immutable history. Resolve that in
product/security design through minimized payloads, external protected personal
data, redaction/tombstone policy, encryption key destruction, or another approved
mechanism compatible with the actual obligations. Do not invent a universal
answer.

## Rebuild and recovery

A projection rebuild should be an operated workflow:

1. select the exact event range, tenant/partition scope, code version, and target;
2. write into a fresh or safely isolated destination;
3. bound parallelism and pressure on the event store;
4. checkpoint resumably and expose progress/failures;
5. validate counts, positions, hashes, and domain-specific expectations;
6. catch up changes that arrived during the rebuild;
7. cut over atomically or through controlled routing;
8. retain rollback evidence for the agreed period; and
9. record duration against recovery objectives.

Rehearse with realistic history. Long rebuild time, unavailable old event types,
or projections that call external systems are design defects discovered by the
drill.

Event-store disaster recovery also requires tested backup/restore, point-in-time
objectives, append consistency, subscription checkpoint recovery, encryption-key
availability, and reconciliation of any externally published messages.

## Apply Marten only when supported

Use Marten guidance only when the repository already contains Marten or the user
has explicitly selected it. Inspect:

- exact Marten and related package versions, target frameworks, and language
  settings;
- PostgreSQL server/provider compatibility and deployment ownership;
- document-session lifetime, transaction and retry behavior;
- stream identity, tenancy, expected-version, event metadata, and serialization
  conventions;
- supported projection lifecycles, async daemon topology, leadership, health, and
  rebuild APIs;
- schema generation/migration policy and production permissions;
- Wolverine integration only if that package and compatible integration are
  present or separately authorized; and
- repository test fixtures using the real provider or supported containers.

Do not paste `StartStream`, `Append`, projection base classes, daemon registration,
attributes, CLI commands, or integration calls from an example until the detected
version's authoritative documentation and repository usage support them. APIs and
operational defaults can change independently.

Marten can coexist with state-stored documents and event-sourced streams, which
may support bounded-context adoption. That is an option, not a recommendation;
compare existing persistence, team familiarity, migration, lock-in, support,
license, hosting, observability, and recovery costs.

## Event-sourcing tests

A proportional suite can include:

- pure fold/decision tests for allowed and rejected transitions;
- expected-version concurrency and retry tests against the real event store;
- historical event fixture and upcasting compatibility tests;
- inline/current and async projection behavior, duplicate, ordering, checkpoint,
  and poison tests;
- snapshot/full-fold equivalence;
- complete rebuild, catch-up, validation, cutover, and rollback exercises;
- outbox/subscription atomicity and external consumer idempotency; and
- authorization, tenant isolation, sensitive-data, retention, and recovery tests.

Never claim audit completeness, deterministic replay, rebuildability, or durable
publication because the selected event-store package advertises those features.
Verify the configured repository behavior and report limitations truthfully.
