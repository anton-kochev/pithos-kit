# Go design and domain boundaries

Read this reference when package responsibilities, public contracts, business
invariants, or persistence boundaries are part of the change. Start with actual
callers and constraints; do not translate a .NET or Java project hierarchy into Go.

## Packages and APIs

Choose cohesive packages with a clear responsibility and a small exported surface.
Prefer names that communicate the domain or capability over generic utility buckets.
Keep imports acyclic and dependencies explicit. Move code only when it improves a
real boundary; a folder move alone does not establish ownership or isolation.

A small program may need only a root package. Use multiple commands, supporting
packages, or modules when ownership and release needs justify them. The official
[module layout guide](https://go.dev/doc/modules/layout) presents options, not a
mandatory `cmd/`, `pkg/`, `internal/` template. `internal` enforces Go import
visibility rules; it is neither a security boundary nor a separate deployment unit.

Use concrete types and functions until a consumer benefits from abstraction.
Prefer small interfaces defined where they are consumed. Do not expose a large
provider interface merely to make mocking convenient. Accept an existing useful
interface or framework rather than adding an incompatible local imitation.
[Go Code Review Comments](https://go.dev/wiki/CodeReviewComments) supplies conventions
for interfaces and API design; apply them proportionally to the repository.

Document ownership of buffers, maps, slices, pointers, and returned resources.
Choose pointer/value receivers for semantics and consistency, not cosmetic uniformity.
Do not copy types containing synchronization state after use. Make concurrency
safety, mutation, and whether callers must close a result explicit in public contracts.
Use generics only when supported and when they clarify genuine reusable operations;
do not introduce them merely to avoid a small amount of clear code.

## Decide whether domain modeling earns its cost

DDD is useful when business language, competing interpretations, and complex rules
make correctness hard. [Fowler's DDD summary](https://martinfowler.com/bliki/DomainDrivenDesign.html)
frames it around complex domains; strategic modeling is not limited to OO languages.
For simple CRUD, adapters, or transformations, direct functions and structs may be
clearer than entities, repositories, factories, and application-service layers.

When complexity warrants modeling:
- Name packages, types, functions, and operations in the domain's language.
- Identify who owns each invariant and which transitions can change it.
- Distinguish identity from value equality. Specify identifiers, units, precision,
  rounding, time zones, and absence where these affect business decisions.
- Treat aggregates as consistency boundaries, not trees containing every related row.
- Define bounded contexts by meaning and responsibility. They need not correspond
  one-for-one to packages, modules, teams, microservices, or databases.
- Translate across genuinely different models instead of sharing a giant universal
  entity. Do not introduce translation layers where meanings already align.

## Invariants, zero values, and aliasing

Use unexported state and methods when they help concentrate invariant enforcement.
Constructors can validate normal creation but cannot prevent all zero-value instances
of exported concrete types. Decide whether the zero value is useful, inert, or invalid;
make methods behave safely and predictably for the chosen contract.
Check decoding, persistence reconstruction, copying, and update paths as well as creation.
Do not assume deserialization invokes a constructor or business validation.

Value copying is not deep copying. Slices can share backing arrays; maps and pointers
can retain shared mutable state. Decide whether inputs/results are borrowed, owned,
or copied. Defensive copies must account for nested mutable content when necessary.
Unexported fields alone do not make a type immutable if accessors leak mutable aliases.
An interface holding a typed nil pointer is not a nil interface. Return an explicit
nil error for success; test optional interface values and typed-nil outcomes when
those contracts are at risk. Preserve deliberate nil-versus-empty serialization.
Test attempted invalid transitions and mutation through aliases where relevant.

Prefer operations expressing intent over unrestricted setters that scatter checks.
Keep pure decisions independent of transport and storage when that improves clarity.
Do not require an interface or repository for every entity, a DI container, CQRS,
event sourcing, or a layered folder taxonomy to call the design domain-driven.

## Persistence and consistency

Place the transaction boundary around the invariant that must hold atomically.
Specify concurrency conflict behavior, retry eligibility, and idempotency requirements.
A process-local mutex cannot enforce a database invariant across multiple processes.
Use real constraints and provider semantics where required; verify them with suitable
integration tests rather than assuming an in-memory fake proves consistency.

Separate persistence records from public/domain types when their contracts differ;
do not duplicate every struct automatically. Keep provider details behind a boundary
only when it protects a meaningful dependency or policy, not to hide capabilities needed
for correct transactions. Define recovery for multi-step work and external side effects.
A local transaction does not make remote publication atomic. Add durable messaging
patterns only for an established requirement and an authorized operational cost.

## Errors and compatibility

Define errors callers can act on: invalid input, absence, conflict, cancellation,
transient failure, or another domain-specific outcome. Avoid inventing categories
that consumers do not need. Preserve useful diagnostic context without disclosing secrets.

On supported Go versions, `%w` preserves an inspectable error chain and `errors.Is`
and `errors.As` inspect it. [Working with Errors in Go](https://go.dev/blog/go1.13-errors)
explains why wrapping exposes implementation details as an API commitment.
Wrap when callers should depend on the underlying condition; translate when they
should depend on a stable boundary error. Neither always-wrap nor never-wrap is sound.
Keep error strings diagnostic unless deliberately part of a user or protocol contract.

Review changes from the consumer's perspective: exported fields and methods, interface
implementers, method sets, nil/empty distinctions, serialization, ordering, resource
ownership, and error inspection. An added interface method can break existing consumers.
Preserve compatibility or explicitly authorize and document the migration.
Test the behavior promised to callers, including old serialized inputs where supported,
rather than treating package compilation as sufficient evidence of compatibility.
