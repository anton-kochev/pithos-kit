# Behavioral test list

Existing driven behavior: strict config; branch leases; safe snapshots/proposals; isolated Agent; guarded apply; actual Pi lifecycle; compact UI. See TDD.md for prior evidence.

## Bounded worker continuation (test-first)

1. [x] Permitted scoped list/read rounds register new evidence, validate references and recheck baselines at guarded apply.
2. [x] Unknown/mutation/malformed/out-of-scope tool attempts terminate; finite turn/file/context limits.
3. [x] Sum per-turn usage; missing/partial accounting is never represented as complete zero.
4. [x] Bounded host-ID user and assistant prose context, no thinking/tool results/environment or obvious secrets.
5. [x] Prior persistent and latest read-only requests prevent capture.
6. [x] Session source references support observations, never auto-approve decisions from code or assistant assertions.
7. [x] Original edits-only behavior reported a missing destination; superseded by exclusive new-page creation below.

8. [x] Sensitive unquoted credentials/secret phrases and unsafe tool paths are refused.
9. [x] Latest user task remains present after long assistant/tool traffic.

Driving cycles and supplemental regression coverage are distinguished in TDD.md. No paid providers. Ordinary write has no exclusive-create contract; new pages now use the dedicated guarded operation below. Semantic model quality, comprehensive secret detection and filesystem race freedom are not certified by deterministic tests.

## Automatic exclusive new pages (supersedes the historical refusal above)

Test list recorded before implementation: discovery independent of snapshots;
exact grounded creates and combined bounds; exclusive publication; single-use
parent authorization; normal permission hooks; actual Pi creation/Plan; partial cleanup honesty. The earlier Aegis compatibility design is superseded by the user's standalone-Clio decision (see TDD.md).

- [x] Existing, empty and missing root docs; existing configured/ancestor docs and subdirectories; no discovery writes.
- [x] Safe basenames/content, source references, duplicate paths and combined proposal bounds.
- [x] Two-page parent execution, deferred tool provenance/callability, unchanged edit behavior.
- [x] Exact parent/runtime capability binding, mutation/replay/unsolicited rejection and invalidation.
- [x] No-replace hard-link publication; file/directory/dangling-symlink collisions, race after precheck, changed root/parent identities, queued cancellation.
- [x] Permission-delay source/directory/target/Plan/input changes; lost built-in edit and unavailable create tool; denial and post-result failure honesty.
- [x] Actual Plan extension file on Pi 1.0.3, not only synthetic Plan entries.
- [x] Standalone creation with an independent built-in-only guard exposing `/aegis`, without a compatibility responder, in both load orders. No production Aegis imports, command discovery or event-bus protocol.
- [x] Independent custom-tool-aware permission hooks allow/block new pages in both load orders and deny confirmation without UI. Built-in-only guards do not automatically cover creation; documentation states that boundary explicitly.
- [x] Published/uncertain/not-published ledger, awaited cleanup failure, leftover temp and created directory reporting, quiet empty proposal.
- [x] Prepared-temp identity/type/link-count/byte checks before publication; replacement preservation, bounded reads, combined cleanup errors and removed-temp accounting.
- [x] Private ledger survives actual Pi result-details mutations; host completion/failure prevents false capture credit when dispatch clears or replaces a publisher error.

Supplemental tests are distinguished from the eight driving cycles in TDD.md.
External hostile OS races, crash/power-loss durability, Windows, real-provider
quality/cancellation, arbitrary extension code and installed CLI/UI matrices are
not certified. No OS sandbox or overwrite fallback is provided.

## Lean capture and observable outcomes

- [x] Default limits: two observed test sources, 35 unrelated doc bodies, scoped listing/target read, exact assertion-only correction through real Pi edit.
- [x] Optional bounded qualifications survive proposal/result/completion without unresolved inflation; actual unresolved strings are never reclassified.
- [x] Policy distinguishes observed assertions from verified test execution or production behavior.
- [x] Actual initial provider-context bytes vs hard-guard bytes; zero-call initial refusal; actual invocation count including synchronous provider failure.
- [x] Initial checked candidates/admitted/pool omissions vs unread documentation; bounded discovered-directory counts, not invented discovered-file totals.
- [x] Structured capacity counts, directory absence not capacity, no refused snapshots; parent details and concise completion retain diagnostics.
- [x] Existing whole-file limits, stale baselines, exclusions, scopes, cancellation, no-retry and permission failures remain covered.

See the resumed-implementation section of TDD.md for observed cycles and safe
pin mutations, distinguished from inherited handover logs.
