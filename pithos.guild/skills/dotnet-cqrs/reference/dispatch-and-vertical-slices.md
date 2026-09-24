# Dispatch choices and vertical slices

A command/query contract does not determine how it is invoked. Choose dispatch
from repository evidence and required runtime semantics; organize code around the
change seams that already work for the team.

## Map what exists

Inspect registrations, call sites, endpoint/consumer code, package versions,
pipeline behavior, source generation, reflection/trimming constraints, transport
configuration, and tests. Distinguish:

- a direct call or injected handler inside one process;
- dynamic in-process dispatch through a mediator;
- in-process notification fan-out;
- durable local work;
- brokered remote messaging; and
- scheduled, retried, or orchestrated workflows.

Similar `Send` or `Publish` method names do not imply the same guarantees. Trace
transactions, serialization, process boundaries, retry, ordering, cancellation,
and failure observation.

## Direct handlers are a complete option

Direct injection or a plain handler is often enough when the caller knows the use
case and execution is local. Benefits include compile-time navigation, explicit
lifetimes, fewer conventions, and no package dependency. Cross-cutting behavior
can use explicit calls, existing filters/middleware, or repository-supported
decorators when it genuinely repeats.

Do not manufacture an interface for every handler. A contract is useful when it
owns a boundary, supports multiple entry points, or creates a real substitution
or test seam. A concrete cohesive handler can remain concrete.

At asynchronous-store scale, direct handlers still work, but the team must own
change capture, relay, retry, deduplication, and consumer operations somewhere.
That operational need—not CQRS syntax—is the reason to consider messaging
infrastructure.

## Mediators

A mediator can provide dynamic dispatch, pipeline composition, and notification
fan-out. It is useful when the repository already invests in those capabilities
and registrations, behavior ordering, diagnostics, and testing are clear.

Before retaining or changing a mediator:

- inspect the exact installed version and API use;
- identify which pipeline behaviors affect correctness and their order;
- check registration, trimming/AOT, source-generation, and lifetime behavior;
- verify current license, support, and compatibility from authoritative sources;
- estimate source/binary compatibility and migration cost; and
- compare a direct call rather than assuming another mediator is required.

Do not migrate a healthy existing mediator because another package is fashionable.
Do not add one merely to call a known local class.

## Message buses and durable processing

A bus is not a mediator with a network. It introduces serialization contracts,
delivery and ordering semantics, queues or logs, retries, poison handling,
backpressure, deployment topology, security, telemetry, and operator ownership.
Use one when those capabilities solve a demonstrated process or durability need.

When Wolverine, Brighter, MassTransit, NServiceBus, a cloud SDK, or another
messaging mechanism is present or explicitly considered, inspect the repository's
actual package version, transport, persistence integration, outbox/inbox support,
consumer lifecycle, topology provisioning, health checks, and test harness.
Select APIs only from that evidence.

A package-provided outbox does not eliminate design work. Confirm which database
transaction it joins, when a message becomes visible, delivery guarantees,
deduplication responsibilities, lock/leadership behavior, retry policy, retention,
dead-letter flow, and recovery after partial failure.

## Dispatch decision table

| Need | Smallest likely option | Questions before escalating |
| --- | --- | --- |
| one known local use case | direct call or injected handler | Does an abstraction protect a real boundary? |
| repeated local cross-cutting behavior | existing middleware/filter/decorator or mediator pipeline | Is ordering observable and tested? |
| local dynamic dispatch | existing compatible mediator | Why is compile-time dispatch insufficient? |
| durable deferred work | repository-supported durable queue or worker | Where are intent, retries, dedup, and poison state stored? |
| remote integration | existing broker/transport and stable message contract | Who owns compatibility, topology, security, and operations? |
| long-running coordination | explicit state machine/saga only when required | How are timeouts, compensation, upgrades, and replay handled? |

A single repository can legitimately use direct handlers for simple HTTP paths,
a mediator for an established application pipeline, and a bus for durable
integration. Keep each mechanism at the boundary where its semantics matter.

## Vertical slices

CQRS pairs naturally with vertical slices because a command or query often forms
a cohesive feature seam. A repository might colocate an endpoint, input contract,
handler, validator, result, mapping, and focused tests. Follow existing file and
namespace conventions rather than imposing a sample tree.

Healthy slice rules:

- the slice owns one observable use case or query;
- transport details remain at the edge when the same use case has multiple entry
  points;
- business invariants remain with their domain/policy owner;
- provider-aware query composition remains with the owner of provider lifetime,
  authorization, and execution;
- slices do not call sibling handlers as an informal service locator;
- shared domain policy and real infrastructure boundaries move to intentional
  shared owners; and
- each slice may use the smallest CQRS shape its behavior needs.

A layered, modular, or hybrid repository can express the same responsibilities.
Feature folders are not evidence that CQRS is present, and four projects are not
evidence that boundaries are healthy.

## Command results

Method-level command-query separation is not a requirement that every use-case
command return `void`. A command can return facts produced by its transaction:

- the new or affected identifier;
- an expected success/error result;
- an accepted/processing state;
- a concurrency token or version; or
- a confirmation value computed while deciding the change.

Avoid returning a display DTO assembled through unrelated reads. The useful test
is whether the transaction produced or decided the value. If the handler must run
a new reporting query to fill the response, use a query contract instead.

For asynchronous commands, distinguish acceptance from completion. Returning an
identifier and `Accepted` state confirms that durable intent was recorded; it does
not claim the downstream work finished. Expose status and failure through an
explicit query, callback, event, or product workflow supported by the host.

## Pipeline concerns

Put each concern at a trustworthy boundary:

| Concern | Candidate owner |
| --- | --- |
| protocol/request shape | endpoint, consumer adapter, or host validation |
| application command shape | handler boundary or established pipeline |
| domain invariant | aggregate/entity/policy owner |
| authentication | host/transport |
| authorization and tenant ownership | endpoint and/or use case according to threat model |
| local transaction | use case or persistence/message integration |
| retry | adapter or durable infrastructure that understands idempotency |
| telemetry | boundary/pipeline with sensitive-data controls |
| caching | query owner with invalidation, tenant, and staleness semantics |

Pipeline convenience must not hide business rules, database calls disguised as
shape validation, unsafe retries, or exception translation that erases causality.
Test order when it changes authorization, transactions, idempotency, or telemetry.

## Conditional examples

Package-specific syntax belongs only in an implementation connected to a
repository that supports that package and version. Before translating a conceptual
example into code, read the installed package's APIs, authoritative documentation,
nearby registrations, and tests. If the package is merely an option, provide a
contract and decision rationale rather than speculative setup code.
