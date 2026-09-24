# E1 raw response observation — transport checkpoint

## Scope and status

`src/response-observer.ts` adds evaluation-only Codex response adapters and a response-level reconciliation check. They are **not installed in the Pi driver, ordinary Guild children, campaign receipts, or resume audit yet**. No live entrypoint was enabled. Native execution binding and independent review remain mandatory gates.

The adapters observe raw terminal usage and service-tier fields before Pi's normalizer drops metadata or substitutes zeros. They do not select a transport, load credentials, change models, register a provider, or patch installed SDK files. Constructor/send/fetch arguments and response bytes pass through; unsupported observation cannot be certified. These are cooperative observation controls, not a network sandbox, billing authority, or general-purpose Fetch/WebSocket implementation.

## Implemented boundary

- `responseMeter()` selects a bounded response ID, enumerated status/tier, and five raw token counts. Missing, invalid, or unsupported values remain `null`. Explicit valid zeros remain zeros. Headers, request bodies, arbitrary errors, response text and unrelated response properties do not enter meter records. This is field selection, not universal secret redaction.
- `observeFetch()` assigns an attempt UUID before each delegated fetch, observes consumed SSE bytes, and records response/end/error metadata. Fetch failures, source-read errors, empty bodies, consumer cancellation and incomplete streams remain distinguishable. Status, headers, URL, redirect/type metadata and consumed bytes are preserved; response identity and arbitrary clone/subclass behavior are not promised.
- SSE framing follows the inspected Codex parser's LF-delimited frames, multiline `data:` joining and residual-frame-at-EOF behavior. Parsing is bounded to 1 MiB per frame and 16 MiB per attempt; invalid UTF-8, JSON or bounds produce an observation-error marker while consumption continues unchanged. Earlier extracted metadata survives a later malformed frame.
- `observeWebSocket()` observes sends and incoming terminal frames, including cached connection reuse. Strings, ArrayBuffers and views are supported. Blob frames, malformed/oversized input and overlapping sends cannot be certified. An overlapping send is rejected before forwarding it; the already-started attempt is retained as invalid. Connection setup before a send is not itself a recorded generation attempt.
- Callback failures use a fixed error rather than retaining arbitrary exception details. SSE consumption fails; WebSocket handling attempts a close and leaves incomplete evidence. This does not guarantee that every SDK consumer fails immediately after a socket callback failure.
- These adapters count calls at their fetch/send boundaries, not OS packets, redirect hops or hidden transport-library retries. Native logical-request observation is still needed to detect requests that never reach or bypass those boundaries.

`verifyResponseMeters()` requires exact record shapes/lifecycles and one distinct raw completed response for every supplied finalized assistant message. Every attempt must reconcile. It checks raw category presence, safe counts and totals, response IDs, normal assistant stop reasons, explicit response tier `default`, normalized category equality and the frozen base-price audit. Failed attempts cannot disappear behind a later successful retry/fallback. Duplicate, orphaned, missing, uncertain or mismatched evidence fails the check; it does not become zero spend.

**SSE cancellation is not necessarily a failed model request.** The actual Codex parser cancels its reader after consuming a terminal event. Reconciliation permits this only with matching complete raw metadata and a normally finalized assistant message. A cancelled/aborted workflow still needs the existing trial/receipt failure gates; this helper alone cannot establish workflow completion.

Response-level agreement is not request-policy attestation. The later native gate must observe the actual final request payload (including tier/reasoning/model), producer/runtime identity, auth policy, and parent/child context. Response tier and normalized cost alone cannot establish request intent, external rates, entitlement or billing.

## Test-first and sensitivity evidence

The evaluator progressed from 80 to 91 tests. Intentional REDs covered missing exports, missing failure lifecycle, loss of early metering, weak attempt-ID validation, lost response URL metadata, and acceptance of a non-assistant message. Callback sanitization was added alongside the early-metering fix and passed its new assertions; it was not a separately observed RED. Further regression checks cover invalid/omitted counts, explicit zero, full-stream limits, unsupported WebSocket frames, callback failure, and cancellation after a terminal event.

A disposable source/test copy removed only the response-tier condition. Reconciliation then incorrectly accepted unknown tier metadata, producing the expected `true !== false` failure. The maintained guard was never disabled; copies were removed in `finally`, and the maintained suite returned to 91/91.

## Actual installed SDK, synthetic transports

The private `.pi/evaluation/e1-response-sdk-probe.mjs` invokes the actual installed Pi/nested pi-ai **0.85.1** through Node 24.20.0. It resolves the approved catalog model with `ModelRuntime.create()`, fresh private HOME/TMPDIR/agent storage, empty auth, no custom model file, and model networking disabled. A synthetic access token is supplied directly to the SDK provider function; no real credential is accessed or resolved. A rejecting global fetch is installed before SDK import. All exercised HTTP/WebSocket boundaries use local synthetic delegates, not network connections.

The final completed probe contains **14 cases, 15 SDK provider-stream invocations and 17 captured transport attempts**:

| Case | Observed result |
|---|---|
| Default tier, SSE and auto-selected WebSocket | Raw counts reconcile with actual SDK normalization/base arithmetic |
| Two default auto turns in one session | One synthetic socket actually reused; distinct response/attempt IDs |
| Response priority tier | Actual Codex multiplier applied; raw priority retained; base reconciliation rejected |
| Missing whole usage | SDK zero-fills usage; raw unknown remains unknown; rejected |
| Missing cache-write category with otherwise populated usage | SDK substitutes zero and produces valid base arithmetic; raw missing category still rejects reconciliation |
| Missing response tier with populated usage | Base arithmetic agrees, but unknown raw tier rejects reconciliation |
| Explicit priority request, response `default` | Actual provider-specific `stream()` payload tier asserted; SDK applies priority multiplier; base reconciliation rejected |
| Dropped WebSocket send followed by SDK SSE fallback | Both attempts retained; later success cannot certify unknown earlier usage |
| Synthetic HTTP 429 followed by SDK retry | Both fetches retained; later success cannot erase the first attempt |

The retry fixture explicitly permits one **synthetic SDK retry**; campaign retries remain disabled. Final-payload assertions check model reasoning at the SDK hook; these assertions are not installed in campaign execution.

An expanded probe initially assumed that `streamSimple()` forwards a direct `serviceTier` option. Its assertion failed: the inspected `buildBaseOptions()` omits that provider-specific option. The corrected fixture uses `stream()` for that case and checks its outgoing payload tier. This was a probe assumption, not a production Guild defect. The empty partial output is retained without fabricated event backfill.

Three completed probe invocations and that failed expansion remain local: `e1-response-sdk-probe-result.json`, `-final.json`, `-checked.json` (empty partial), and `-verified.json`, plus the final stderr file. Earlier summary counters cover their primary cases; the last report labels those counters explicitly and separately totals every captured case. The final report records zero forbidden-fetch attempts, zero actual HTTP requests, unchanged empty auth and cleanup, plus selected Node/runtime/source hashes—not a complete dependency-closure or execution attestation. No agent session/prompt, successful authenticated delegation, campaign trial, model-quality result or independent review is represented by these fixtures.

## Validation and remaining gate

Validation at this checkpoint: Guild 135/135, evaluator 91/91, root 2/2; both typechecks; unchanged six-task bank and offline schedule; pack dry-run 39 files excluding evaluation/private assets; diff check. No staging, commits, dependency/version changes, production Guild source changes or Phase 2 work.

Next: bind these adapters and final request/context observations to actual parent and child execution, retain/correlate their evidence, require it in fresh receipts and historical re-audit, and obtain independent review. Only then consider the original first pair under the unchanged [smoke limits](e1-smoke-campaign.md). This checkpoint does not authorize an extra live probe or replacement trial.
