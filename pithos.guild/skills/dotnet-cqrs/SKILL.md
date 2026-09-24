---
name: dotnet-cqrs
description: >-
  Repository-aware CQRS guidance for C# and .NET systems. Use when deciding
  whether command/query separation is justified, designing commands, queries,
  read models or projections, choosing dispatch and messaging mechanisms,
  defining outbox/inbox and idempotency behavior, handling eventual consistency,
  or evaluating event sourcing and Marten. Inspect the repository first, select
  the smallest CQRS shape that solves demonstrated needs, and apply only APIs and
  packages supported by its target frameworks, language settings, providers,
  deployment model, operational capabilities, and conventions.
---

# CQRS for .NET

CQRS separates responsibilities where changing state and reading state have
meaningfully different models, risks, or scaling needs. It is not a mandate for
handlers, mediators, two databases, messaging, or event sourcing. Most systems
should use no CQRS or a small in-process split; every additional consistency and
operational boundary must earn its cost.

This skill complements `dotnet-clean-architecture`. Use that skill for general
solution boundaries, domain ownership, ports, adapters, and architecture choices.
Use this skill for the repository-connected CQRS decision and the consequences of
read/write separation. Neither skill authorizes broad restructuring, dependency
changes, public-contract breaks, data migrations, or deployment changes.

## Eligibility and repository discovery

Apply this skill only to substantive, relevant .NET or C# code connected to the
repository, or to an explicit repository-scoped request to create such a system.
Inspect `.sln`, `.slnx`, `.csproj`, `Directory.Build.props`,
`Directory.Build.targets`, `Directory.Packages.props`, `global.json`, project
references, lock configuration, production source, and tests. An incidental
snippet, generated sample, package name, or generic architecture question is not
enough; if no connected .NET work exists, stop and refuse generic CQRS
consulting.

Detect rather than assume:

- `TargetFramework`/`TargetFrameworks`, SDK selection, `LangVersion`, `Nullable`,
  analyzers, warnings, formatting, and generated-code policy;
- package versions and restore conventions, persistence/database providers,
  schemas and migrations, messaging or broker infrastructure, deployment/hosting
  topology, test projects, test commands, and CI expectations;
- current command, query, endpoint, consumer, background-worker, and scheduler
  conventions, including any mediator, bus, outbox, inbox, change-data-capture,
  event-store, cache, or search infrastructure;
- transaction boundaries, concurrency tokens, tenant and ownership filters,
  retry policies, serialization contracts, observability, health checks, and
  recovery procedures;
- ownership and operational maturity: who deploys, monitors, repairs, rebuilds,
  and rolls back each store, projection, queue, and contract.

Trace each relevant command or query from its endpoint or consumer through the
handler and transaction to the authoritative store, then through any publication,
projection, and read path. Do not infer CQRS from class suffixes or folders alone.
Classify existing patterns as healthy, harmless convention, accidental complexity,
or a concrete risk. Preserve healthy working behavior unless the user asks for a
change and authorizes its compatibility, migration, and operational costs.

## Role-aware use

A read-only architect stays at architecture altitude: report repository facts,
options, boundaries, consistency guarantees, contracts, risks, observable tests,
and an implementation handoff. Do not provide production function bodies or
claim implementation.

A coder may implement the approved scope, but must use supported repository APIs,
drive changed behavior test-first where useful, preserve unrelated work, and run
relevant verification. Adding or changing packages, stores, durable messaging,
schemas, public contracts, deployment topology, or migration strategy requires
explicit authorization. The skill never weakens either role's tool boundary.

If correctness depends on an unresolved product decision—such as acceptable
staleness, duplicate effects, conflict behavior, audit obligations, or migration
downtime—return `Blocked` with the specific decision required.

## Choose the smallest CQRS shape that earns its cost

Decide per bounded context or use case, not once for an entire solution. The
following shapes are adoption options, not a maturity ranking; moving right is
not inherently better and event sourcing is not the goal.

| Shape | Runtime and storage | Use when | Added obligations |
| --- | --- | --- | --- |
| Direct CRUD or cohesive endpoint | no required command/query abstraction | read and write shapes match and policy is simple | ordinary authorization, validation, concurrency, and tests |
| Command/query split | same process and usually one database; commands and queries have distinct contracts/handlers | write invariants and read projections benefit from separate paths | contract ownership and useful handler boundaries |
| Separate read model or shape | one database, with direct projections, views, or derived tables; updates may share the same transaction | measured query complexity or performance fights the write schema | derivation, migration, and rebuild strategy |
| Separate read store | independent read technology synchronized asynchronously | demonstrated scale asymmetry or a required query capability cannot be served proportionally by the authoritative store | durable change capture, idempotency, lag UX, observability, backfill, and recovery |
| Event-sourced context | events are authoritative and state/read models are projections | event history or temporal behavior is a business requirement and the team accepts event evolution and rebuild operations | immutable contract discipline, concurrency, projection lifecycle, and long-term recovery |

Before escalating, require measured or demonstrated pain, need, or requirement:
query plans and latency, contention evidence, throughput and availability targets,
a capability gap, temporal/audit obligations, or ownership boundaries. Exhaust
simpler options such as indexes, bounded projections, provider-supported views,
query tuning, caching with explicit invalidation, or a replica before introducing
a second source of operational failure.

Event sourcing is a separate, orthogonal decision—not simply the next CQRS level.
CQRS does not require it, and event-driven integration does not imply it. Prefer a
simple state-stored design for CRUD and domains whose history carries no product
meaning.

See [maturity and decision guidance](reference/maturity-and-decision.md).

## Commands and queries

Commands express intent to change state. Name the business operation rather than
a storage mutation, establish authenticated identity and authorization, validate
boundary shape, load the required state, invoke the invariant owner, define the
transaction and optimistic-concurrency behavior, persist once, and return a
stable outcome. Handlers orchestrate; they must not become duplicate domain
models.

A command may return information produced or decided by its own transaction, such
as an identifier, result/error contract, accepted state, or concurrency version.
Avoid returning a display-oriented query payload or joined DTO that requires a
second read and gives the command two reasons to change.

Queries are read-only from the caller's perspective and project the shortest safe
path to an explicit result. Direct provider-aware projection is valid inside the
layer that owns provider semantics and lifetime. Every query must retain tenant,
ownership, and authorization filters, bounded paging or another result limit,
stable ordering, cancellation, and deliberate tracking/caching behavior. A
query-side shortcut must never become a security shortcut.

Command/query separation does not mean one file or interface per operation.
Preserve cohesive endpoints, functions, vertical slices, or existing handlers
when they already expose the right behavior. Do not route known local calls
through a mediator or bus merely to satisfy naming symmetry.

## Read models and projections

A read model is a consumer-owned contract that answers a particular question; it
is not the aggregate or write model serialized for convenience. Shape it around
consumer needs, keep public API contracts separate from disposable storage
schemas, avoid leaking provider entities or lazy-loading behavior, and denormalize
only with a known refresh source.

Every derived read model must be rebuildable from an authoritative source of
truth on a defined timescale. Trace every field to write-side state, durable
change records, or events plus deterministic computation. Define initialization,
backfill, schema migration, dual-read/write or cutover rollout, validation, swap,
rollback/roll-forward, and cleanup. A rebuild path that has never been exercised
is an assumption, not recovery evidence.

Classify each query contract as **must-be-current** or **may-be-stale**, with an
acceptable lag bound. For read-your-own-writes, consider a current detail query
against the authoritative store, optimistic client state, version-aware waiting,
or an explicit processing state. Do not silently route correctness-sensitive
authorization, inventory, balance, or workflow decisions through a stale read
model.

Projection consumers must define source position, partition/stream ordering,
out-of-order behavior, idempotent updates, duplicate handling, concurrency,
checkpoint ownership, poison behavior, and replay semantics. Keep security and
tenant partitioning valid during ordinary reads, rebuilds, support operations,
and cross-store replication.

See [read models and projections](reference/read-models-and-projections.md).

## Consistency and reliable delivery

State the consistency boundary for every command and projection. A local database
transaction cannot atomically include an unrelated broker or store merely because
one handler calls both. Compare synchronous same-transaction updates,
commit-then-act with repair, compensating workflows, transactional outbox/change
capture, or a provider-supported distributed mechanism only when actually
available and justified.

An outbox records the state change and publication intent in the same local
transaction, then relays later. It narrows the lost/phantom-message gap; it does
not create exactly-once processing. Delivery is commonly at-least-once, so
duplicates, relay crashes, lock ownership, retries, ordering, retention, and
reconciliation remain. An inbox or processed-message key deduplicates local
side effects only when the key and those effects commit atomically. It cannot make
an external effect atomic: require downstream idempotency, a persisted intent with
reconciliation, or another explicit recovery contract. Naturally idempotent,
versioned upserts are preferable when the contract permits them.

Define ordering scope—aggregate, stream, tenant, partition, or none—and behavior
for gaps and older versions. Bound retries with backoff and cancellation. Route
poison messages to a dead-letter or failed-work state with an owner, diagnostic
context, replay rules, and a runbook; never loop forever or silently discard.

Version each durable message or event as a compatibility contract. Prefer
additive evolution and tolerant readers; for semantic breaks, define a new
contract or supported transformation. Plan mixed-version rollout, producer and
consumer ordering, historical fixtures, replay/backfill compatibility, and the
point at which old shapes can safely retire.

For async paths, propagate correlation/trace context and monitor projection lag,
outbox depth and age, consumer failures, retries, dead letters, rebuild progress,
and stale-read rates. Give each alert, dashboard, repair operation, and recovery
objective an owner. Keep secrets, credentials, personal data, and sensitive
business payloads out of logs, message metadata, events, and telemetry unless an
explicit protected contract requires them.

Treat eventual consistency as product behavior. Specify what the user sees while
work is pending, how failures surface, which reads may lag, and how support can
reconcile state. Never promise immediate consistency from an asynchronous path.

See [consistency and reliability](reference/consistency-and-reliability.md).

## Event sourcing is a separate decision

Event sourcing makes an event history authoritative and derives current state and
read models from it. Select it only when history, temporal reconstruction,
traceable decisions, or retroactive projections are business, product, or
regulatory requirements that justify immutable contract evolution and operational
replay. An audit log, integration events, or a desire for fashionable architecture
can usually be served more simply by state storage, history or temporal tables,
and an outbox.

Define stream identity and boundaries, expected-version or optimistic-concurrency
behavior, event naming and payload ownership, metadata/security, deletion and
retention obligations, snapshots, projection lifecycle, rebuild time, upcasting
or other historical-version handling, and disaster recovery. Events can preserve
incorrect facts forever; validation, authorization, testing, and repair events
still matter.

Apply Marten-specific guidance only when Marten is detected, present, or explicitly
selected. Inspect its installed version, target-framework compatibility,
PostgreSQL provider/server requirements, projection APIs, daemon topology,
transaction integration, schema/migration conventions, and test support before
using an example. The same evidence rule applies to any other event store.

See [event sourcing and conditional Marten guidance](reference/event-sourcing-marten.md).

## Package and dispatch choices

Dispatch and durability solve different problems. Direct injection/calls or plain
handlers provide explicit local execution. A mediator can provide dynamic
in-process dispatch and pipeline composition. A message bus or broker introduces
durable or remote delivery semantics, retries, ordering constraints, scheduling,
and operational ownership. Do not substitute one label for another.

Before retaining, adding, replacing, pinning, or upgrading MediatR, Wolverine,
Marten, Dapper, EF Core, Cortex.Mediator, Brighter, FastEndpoints, a broker client,
or another package:

1. inspect the existing package or dependency, exact version, target compatibility,
   actual features in use, transitive effects, and migration surface;
2. verify current license and support terms from authoritative sources when they
   affect the decision—do not preserve time-sensitive claims in code guidance;
3. compare repository-native direct handlers and existing infrastructure with the
   concrete capability being purchased;
4. account for deployment, configuration, security, telemetry, testing, data
   migration, rollback, team familiarity, and long-term maintenance; and
5. obtain explicit approval or authorization before any add, replace, upgrade, or
   pin operation.

Preserve a compatible existing investment unless an authorized change has a
measurable benefit. A package example is not migration authority.

See [dispatch options and vertical slices](reference/dispatch-and-vertical-slices.md).

## Test-first implementation and verification

Inspect the repository's test framework, test runner, test commands, fixtures,
containers, assertion style, CI, and nearby conventions before prescribing or
writing tests. For changed behavior, use the smallest useful
red-green-refactor cycle: one observable failing behavior, minimal implementation,
then cleanup while green. Architecture-only work specifies tests in implementation
order but stays read-only.

A proportional CQRS strategy may include:

- domain tests for invariants and command decisions without infrastructure mocks;
- handler/application tests for authorization, orchestration, outcomes,
  concurrency, cancellation, and transaction intent;
- real-provider persistence tests for projections, constraints, query shape,
  migrations, outbox capture, locking, and checkpoints;
- contract/message tests for serialization, historical payloads, compatibility,
  duplicate delivery, ordering, retry, poison, and mixed-version rollout;
- projection and rebuild tests for deterministic replay, idempotency, backfill,
  cutover, lag classification, and recovery; and
- host or end-to-end tests only for risks that cross the real transport, broker,
  store, and deployment boundaries.

Use repository-supported providers and test infrastructure. Mocks of query
providers, transactions, brokers, or event stores rarely prove their semantics.
Do not add a testing package without authorization. Never claim a test, build,
restore, migration, replay, rebuild, or verification step passed unless it was
actually run and observed; report unavailable or failing checks truthfully.

## Working sequence

1. Establish repository eligibility and detected capabilities.
2. Map existing command, query, transaction, store, message, and ownership paths.
3. Define observable behavior, invariants, authorization, consistency,
   compatibility, recovery, and operational service levels.
4. Compare direct CRUD and the smallest credible CQRS shapes per bounded context.
5. Choose contracts and boundaries with evidence; state rejected escalation
   options and rollback conditions.
6. List tests and migration slices in dependency order, including failure and
   recovery behavior.
7. Implement only the authorized slice, using supported APIs and packages.
8. Verify with commands actually run and review for ceremony, stale-read security
   risks, hidden distributed transactions, unrebuildable state, and unowned
   operations.

Examples in the reference files are illustrative shapes. Adapt every example to
the repository's supported language, framework, package, provider, hosting, and
nullable capabilities; do not paste syntax or APIs merely because they appear in
this skill.
