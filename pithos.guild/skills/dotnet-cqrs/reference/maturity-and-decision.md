# CQRS adoption and decision framework

CQRS is a set of separations with different costs, not a maturity badge. Choose a
shape per bounded context or use case, preserve healthy existing behavior, and
move only when repository evidence shows that the next commitment solves a real
problem.

## Start with the problem, not the pattern

Before proposing CQRS, write down:

- the command-side invariants, contention, authorization, and transaction needs;
- the query shapes, latency and throughput targets, result sizes, and staleness
  tolerance;
- measured query plans, incidents, scaling limits, or missing provider
  capabilities;
- compatibility obligations for APIs, messages, schemas, and stored data;
- who owns deployment, monitoring, backfill, repair, rebuild, and rollback; and
- the simplest non-CQRS change that might solve the same problem.

Adjectives such as “scalable,” “clean,” or “future-proof” are not evidence. A
latency target, contention trace, product consistency rule, temporal requirement,
or ownership boundary can be.

## Shape 0 — direct CRUD or cohesive endpoints

A direct endpoint or application service can be the correct design when the read
and write shapes match, policy is modest, and one provider serves the load. Keep
authorization, input validation, concurrency, transactions, bounded reads, and
tests explicit; avoiding CQRS does not mean avoiding design.

Stay here when commands and queries would be wrappers around the same operations.
Adding command/query marker interfaces, a mediator, or folders without changing
responsibility is ceremony, not CQRS value.

## Shape 1 — command and query paths

Commands and queries have distinct contracts and implementation paths but can
remain in one process against one database. Commands protect state changes and
invariants; queries project directly to bounded response contracts. They may use
existing endpoints, functions, or handler classes—no dispatcher is required.

This split can earn its cost when:

- write behavior is domain-rich while reads are projection-heavy;
- authorization, concurrency, or transaction behavior differs by operation;
- feature-local tests and ownership improve with cohesive use-case contracts; or
- current handlers mix change decisions with reporting concerns.

It does not itself require separate persistent models. Keep one source of truth
and one deployment while that remains sufficient.

## Shape 2 — separate read shapes in one database

Use direct provider projections, views, materialized/indexed views where
supported, or derived read tables when measured queries fight the normalized
write schema. A separate shape can retain strong consistency when it is computed
at query time or maintained in the same local transaction.

Before adding a derived table, define:

- which authoritative fields derive every column;
- how all command paths keep it correct;
- whether maintenance is synchronous, database-owned, or event-driven inside the
  transaction;
- how it is initialized, migrated, validated, rebuilt, and repaired; and
- the added write amplification, locking, and deployment ordering.

Try indexes, query-plan fixes, bounded projections, and provider-supported views
first. A derived table is justified when those options cannot satisfy the known
shape or service level—not because denormalization looks simpler in a diagram.

## Shape 3 — asynchronous read stores

A separate read store earns its operational cost when a required query technology
or demonstrated scale/availability boundary cannot be served proportionally by
the authoritative store. Examples can include search, geo, graph, analytical, or
cache-like key access, but the repository's actual providers decide what is
available.

This shape requires, before launch:

- durable, replayable change capture such as an outbox, log, or supported CDC
  mechanism;
- at-least-once duplicate handling and an explicit ordering scope;
- a deterministic backfill/rebuild and schema-cutover procedure;
- classification of must-be-current and may-be-stale queries;
- user behavior for pending, failed, and stale results;
- correlation, lag, queue/outbox, failure, and dead-letter telemetry; and
- named ownership for alerts, repair, reconciliation, capacity, backup, restore,
  deployment, and rollback.

A read replica is not automatically a different read model; it may simply be the
same schema with replication lag. Treat it according to its real consistency,
routing, and failover behavior rather than its label.

## Event sourcing — an independent persistence choice

Event sourcing changes the source of truth from current state to an event
history. It often produces command-side decisions and read-side projections, but
it is not the “highest” form of CQRS. Evaluate it independently.

Credible signals include:

- temporal reconstruction is a product or regulatory requirement;
- the sequence of decisions is itself business data;
- retroactive projections over complete history create known value; or
- current bespoke history/synchronization mechanisms already approximate an
  event log and their cost is understood.

Weak signals include wanting an audit log, publishing integration events, a
preference for immutable data, or anticipated future reporting. State storage
plus temporal/history tables and an outbox can satisfy those needs with less
contract and operational burden.

Event sourcing also requires long-lived event compatibility, expected-version
concurrency, deterministic projections, correction/repair policy, deletion and
retention decisions, replay performance, backup/restore, and a team that can
operate those mechanisms.

## Graduation and rollback evidence

For any move, record both a trigger and a reversal plan:

| Change | Evidence that can justify it | Evidence to stay or move back |
| --- | --- | --- |
| direct path → command/query split | responsibilities and tests are tangled; write policy and read projection genuinely diverge | handlers only forward; files multiply without independent behavior |
| one shape → derived read shape | repeated measured query complexity or latency cannot be solved proportionally | an index/projection/view meets the target; write amplification dominates |
| one store → async read store | proven capability, scale, ownership, or availability boundary | lag/repair cost exceeds value; one provider can now meet the target |
| state storage → event sourcing | history/temporal behavior is a requirement with funded operations | events carry no useful history; projections recreate the CRUD table everyone needs |

Prefer an incremental slice: one bounded query, one derived model, one projection,
or one event-sourced aggregate. Preserve compatibility and run both paths long
enough to compare correctness and service levels before cutover. Do not perform a
system-wide flag-day migration.

## Decision record

A useful decision or handoff states:

1. repository facts and the exact bounded context;
2. current behavior and measured problem;
3. selected shape and why the simpler option is insufficient;
4. consistency and staleness contracts per operation;
5. source of truth and transaction boundaries;
6. authorization, tenancy, compatibility, and data-migration effects;
7. observability, recovery, rebuild, ownership, and service objectives;
8. incremental tests, rollout, rollback/roll-forward, and decommissioning; and
9. conditions that would justify future escalation or simplification.

Do not score a project into an architecture mechanically. The table structures
evidence; product and operational constraints decide.
