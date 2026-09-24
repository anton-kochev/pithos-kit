# Read models and projections

The read side answers consumer questions without compromising authorization,
consistency, provider ownership, or recovery. A faster query is not useful if it
returns stale data where correctness requires current state or leaks another
tenant's records.

## Consumer-owned read contracts

Design a result from the consumer's behavior:

- one explicit contract per coherent question, not one universal entity DTO;
- only the fields the consumer needs, with stable serialization semantics;
- deterministic sorting and bounded paging, streaming, or aggregation;
- authorization, tenant, ownership, and information-disclosure rules;
- a declared freshness class and acceptable lag; and
- source/binary/wire compatibility when the contract is public.

A storage row, search document, or cache entry is an implementation detail unless
it is deliberately the public contract. Keep provider entities, lazy-loading
proxies, unconstrained query objects, and mutable domain objects behind the query
boundary.

Denormalization is valid when every copied value has an authoritative origin and
refresh path. Avoid preformatted display strings when localization or client
presentation owns formatting; “screen-shaped” means consumer-shaped, not that the
server must own every visual detail.

## Direct projections in the authoritative store

Start with the provider's smallest supported projection. With EF Core this may be
a bounded `Select` into a result type; with Dapper or another SQL mechanism it may
be an explicit parameterized query. Apply provider guidance only when that
provider and version are detected.

Review:

- generated SQL/query plan, indexes, scans, joins, N+1 behavior, and result size;
- tracking, context/session lifetime, cancellation, timeout, and connection use;
- parameterization and injection safety;
- authorization and tenant predicates in the executed query;
- stable ordering and paging correctness; and
- real-provider tests for semantics that an in-memory double cannot reproduce.

Raw SQL can be appropriate for reporting-shaped queries, but it does not remove
invariants around security, bounds, numerical correctness, time zones, or contract
compatibility.

## Separate read shapes in one database

Provider-supported views, materialized/indexed views, computed projections, or
derived tables can solve complex reads while retaining one operational database.
Determine whether the shape is computed at query time, maintained by the database,
or updated by application code in the same local transaction.

For an application-maintained shape:

1. identify every command and repair path that can affect it;
2. keep authoritative and derived writes in the intended transaction;
3. define optimistic concurrency and failure behavior;
4. provide an initial backfill and deterministic rebuild;
5. validate derived data against the authoritative source; and
6. plan schema deployment, mixed-version execution, rollback/roll-forward, and
   cleanup.

Avoid synchronous in-process event handlers whose ordering and transaction
participation are assumed rather than verified. If one is used, test the actual
dispatch and persistence boundary.

## Asynchronous projections across stores

An asynchronous projection consumes durable changes and writes a read store.
Specify the pipeline rather than naming it “eventual consistency”:

```text
authoritative transaction → durable change record → relay/log/broker
→ projection consumer → checkpoint + read-store update
```

For each arrow define ownership, delivery guarantee, timeout, retry, cancellation,
security, telemetry, and repair. For each projection define:

- source event/message/change contract and starting position;
- partition key and ordering scope;
- behavior for duplicate, missing, old, and out-of-order input;
- idempotent upsert or transactionally recorded checkpoint/inbox;
- read-store concurrency and partial-write behavior;
- checkpoint atomicity relative to the projection update;
- poison handling and replay after correction; and
- throughput, lag, and rebuild objectives.

One projector per independently deployable/rebuildable read model usually keeps
failure and migration ownership clear. Sharing a consumer is acceptable when the
repository deliberately shares their lifecycle; do not split mechanically.

## Rebuildability and source of truth

A derived read model must never be the only home of a fact. Every field should
trace to authoritative state or a durable event/change log, plus deterministic
computation where needed. Operator corrections belong at the source of truth and should flow
through the projection; direct read-store edits require an explicit temporary
repair procedure and reconciliation.

A rebuild design includes:

- a complete and retained replay/backfill source;
- deterministic transformation code with clocks/external values supplied by the
  source rather than fetched during replay;
- resumable checkpoints and bounded resource use;
- a fresh destination or safe truncate strategy;
- progress, failure, reconciliation, and completion telemetry;
- validation counts/hashes or domain-specific invariants;
- cutover through alias, routing, version, or atomic swap where supported;
- rollback/roll-forward and old-store retention; and
- measured recovery time against realistic data volume.

Reuse the same core projection logic for live consumption and rebuild where
practical, while allowing adapters to batch or checkpoint differently. Test that
both paths produce equivalent observable read results.

## Current and stale reads

Classify every query:

- **Must-be-current:** a stale answer can authorize the wrong action, violate a
  limit, misstate money/inventory, or send a workflow down an invalid path.
- **May-be-stale:** lag is acceptable within a documented bound, such as search,
  analytics, or a list whose detail page rechecks authoritative state.

Possible read-your-own-writes mechanisms include:

1. route detail-by-ID to the authoritative store;
2. return command-produced confirmation and let the client render optimistic
   state;
3. expose `Accepted`/`Processing` and poll or subscribe for completion;
4. return a source version and wait/fallback until the projection reaches it; or
5. temporarily pin relevant reads to a current source when infrastructure
   supports it.

Select from product behavior and repository capability. Do not claim that a
fixed delay, cache invalidation guess, or “usually fast” projector guarantees
freshness.

## Security and privacy

Read-side denormalization multiplies sensitive data locations. Apply least-data
principles, encryption and access policy, tenant partitioning, retention/deletion,
subject-access/export obligations, and audit controls to every store, backup,
index, cache, message, and rebuild artifact.

Projection and support identities should have only the required source and target
permissions. Rebuild tools must preserve tenant isolation and avoid dumping
sensitive payloads into logs or temporary files. Verify deletion propagation and
backup implications when legal or product contracts require it.

## Migration sequence

Prefer a reversible expansion-and-cutover:

1. pin current query behavior and service levels;
2. add the new schema/index/store without switching reads;
3. backfill through tested deterministic projection logic;
4. consume live changes while measuring lag;
5. reconcile authoritative and derived results;
6. shadow or selectively route reads;
7. cut over with a rollback path;
8. observe for the agreed window; and
9. retire the old path only after compatibility obligations expire.

A simple same-database projection may need only a migration and focused provider
test; do not impose distributed rollout ceremony where no distributed boundary
exists.

## Read-side anti-patterns

- **One DTO for every consumer:** unrelated fields and compatibility needs become
  coupled; define focused contracts.
- **Domain entities as responses:** persistence and policy internals become public;
  project explicitly.
- **Unbounded query or export:** one request can exhaust memory, database, or
  network; page, stream, aggregate, or govern it.
- **Security after materialization:** filtering in memory can fetch or expose data
  the caller must never access; enforce at a trustworthy query boundary.
- **Cache without projection discipline:** invalidation is an unnamed projector;
  define freshness, ownership, rebuild, and failure behavior.
- **Derived flags with no source:** rebuild cannot reproduce them; move the fact to
  the authoritative side.
- **Untested rebuild:** recovery exists only on paper; rehearse it against realistic
  volume and record evidence.
