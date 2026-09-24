# E1 frozen base-pricing audit checkpoint

## Status and scope

**Per-turn base-pricing audit implemented test-first and connected to new campaign specifications, settlement, and resume. Native execution observation is still unfinished; live entry remains disabled.**

This follows the [real CLI startup checkpoint](e1-native-startup.md). It is an evaluator-only arithmetic/integrity check, not a Guild feature, provider billing assertion, completed native observer, or independent review. No production Guild code, package versions/dependencies, task bank, campaign model/limits, or Phase 2 interfaces changed.

No real credentials, provider requests, agent prompts, live attempts, installs, installed-runtime patches, staging, or commits were involved. The manual SDK checks used empty private credential stores and synthetic numbers/events only.

## Why catalog hashes are insufficient

The selected Pi 0.85.1 SDK has three relevant behaviors:

1. `pi-ai/dist/models.js:calculateCost()` selects the highest **strictly exceeded** input-size threshold for each response. Input size includes uncached input, cache reads, and cache writes. Output tokens do not select the tier. Applying a tier to whole-workflow totals would be wrong.
2. `pi-ai/dist/api/openai-codex-responses.js` subsequently applies service-tier pricing: flex is 0.5×; priority is 2× for the approved model. The shared response processor does not retain that service-tier value in the normalized assistant message.
3. `pi-ai/dist/api/openai-responses-shared.js` normalizes missing usage/categories using zero defaults. A complete-looking serialized message with numeric cost fields is therefore not proof that every underlying provider usage field was present.

The first behavior is implemented and checked here. The latter two remain **native metering/provenance gates**, not facts that can be recovered by matching a catalog digest or guessing a multiplier from reported dollars. A non-base price is rejected by this audit; it is not silently repriced or treated as a known service tier.

## Frozen policy and arithmetic

`evaluation/src/pricing.ts` defines an exact `BasePricing` shape:

```text
version: 1
model: provider/model
api: exact API identity
serviceTier: base
cost: input, output, cacheRead, cacheWrite,
      optional tiers[{inputTokensAbove, input, output, cacheRead, cacheWrite}]
```

- `serviceTier: base` names this audit's unmultiplied arithmetic policy; it is **not** an OpenAI request parameter or an observed response tier.
- Rates are nonnegative finite USD-per-million values, bounded at 1,000,000. At most sixteen tiers are accepted, with unique nonnegative safe-integer thresholds; tier order is immaterial.
- Model/API identifiers and all policy/rate/tier fields are validated. Unsupported service policies, unknown fields, missing rates, non-finite numbers, and duplicate thresholds fail closed.
- Usage counts must be nonnegative safe integers. Their safe sum must equal `totalTokens`. A nonzero one-hour cache-write category is unsupported rather than silently priced under the wrong semantics.
- A finalized message must have positive output and positive total input including caches. These are conservative checks for the nonempty E1 workflows, not recovery of missing provider metering.
- Each of the four cost components and the total must **exactly** match the recomputed amount. The five-component cost shape is exact. No rounding allowance, aggregate balancing, or inferred service multiplier is used. This mirrors the reviewed SDK's arithmetic operation order; an unexplained representation change stops the campaign rather than being silently tolerated.
- Valid zero rates can still yield a known zero cost when nonzero usage and all other evidence are present. Missing/zero-filled usage is not substituted with such a result.

This is a deliberately limited base-pricing policy, not a general provider-pricing library. The actual campaign's policy must still be obtained from and checked against its observed, frozen native model/runtime; a caller-supplied policy alone is not that observation.

## Trace, receipt, and ledger connection

- `analyzeTrace(parent, children, pricing?)` checks every finalized parent assistant message and every correlated raw child assistant message under the same policy. Earlier tool-use turns are included. Streamed duplicates and handover aggregates do not become extra charges or replace raw evidence.
- Arithmetic/API/model/count discrepancies add `pricing_mismatch` (or `child_pricing_mismatch`) and make certified total usage unknown. Raw subtotals remain diagnostic evidence.
- `CampaignSpec.pricing` is optional only to preserve existing unpriced historical/inert specifications. When present it is validated against the bound model and frozen with the **entire persisted specification and journal chain**. It cannot be added, removed, or repriced on reopen. Caller mutation cannot change the retained policy.
- `deriveTrialReceipt()` first verifies the original result and raw-trace digests unchanged. It then applies the supplied frozen pricing as an additional audit. It does not rewrite earlier trace summaries or backfill fields.
- `runCampaignNext()` passes the frozen policy for both fresh settlement and historical evidence re-audit. A fresh mismatch settles one consumed attempt with failed integrity and unknown estimated spend, preventing another admission. A previously settled receipt that bypassed pricing is rejected before another driver call even if its raw evidence, result digests and journal checksums all agree.

A trial's raw-capture status can remain `recorded` while its stricter campaign receipt fails verification. Read the receipt, not just the capture status. Direct lower-level ledger calls remain cooperative APIs; the bridge is what derives evidence-backed settlements.

**Unpriced historical behavior is preserved, not promoted to live readiness.** No live factory/entrypoint was enabled, and absence of a pricing policy must not be accepted by the still-to-be-completed native campaign assembly.

## RED/GREEN and sensitivity evidence

Each maintained behavior was driven with package-local `npm run eval:test`. The suite progressed from 71 to 80 passing tests.

| Behavior | Observed RED before implementation |
|---|---|
| Base arithmetic API | Deliberately missing `pricing.ts` import |
| Strict per-turn tier selection | `8 !== 16` |
| Exact policy validation | Deliberately missing `validateBasePricing` export |
| Invalid usage rejection | `Missing expected exception` |
| Parent cost/API/model/category audit | `true !== false` |
| Raw child pricing propagation | `true !== false` |
| Frozen specification field | `Invalid campaign: unknown or missing fields` |
| Fresh settlement pricing binding | `0.25 !== null` |
| Historical receipt pricing binding | `Missing expected rejection` for historical evidence mismatch |
| Unknown cost fields and zero-input/output reports | `true !== false`, then restored GREEN |

A separate sensitivity check copied only the pricing/trace modules and their trace tests to disposable locations. Omitting the cost comparison in that copy made both parent and child pricing assertions fail with `true !== false`. The maintained guard was never disabled. Copies were removed in `finally`; the normal 80-test suite was restored GREEN.

These tests use synthetic models/usages and injected offline drivers/observers. They prove the arithmetic and ledger/receipt wiring, **not native runtime observation or provider access**.

## Actual installed SDK checks — distinct evidence

The ignored `.pi/evaluation/e1-pricing-runtime-probe.mjs` ran through Node 24.20.0 against the already-approved installed Pi/nested pi-ai 0.85.1. It used a clean environment, fresh private HOME/TMPDIR/agent directory, `{}` auth, `modelsPath: null`, `allowModelNetwork: false`, and a rejecting/counting `fetch` guard installed before SDK import. No session, agent, provider stream, or authenticated request was created.

The probe:

- Resolved `openai-codex/gpt-6-astra`, its high mapping, and its catalog-matching cost through actual `ModelRuntime.create()`.
- Compared this evaluator's arithmetic with actual installed `calculateCost()` across eleven vectors: ordinary and mixed usage, plus below/at/above the input threshold driven separately by uncached input, cache reads, and cache writes. All matched, including floating-point results.
- Confirmed unexplained doubled costs fail the base-only audit. This is synthetic multiplier sensitivity, not invocation of Codex's private service-tier function.
- Invoked the installed shared response normalizer directly on synthetic completion events. It omitted service-tier identity from the assistant output and produced zero-filled usage for a missing-usage response. The evaluator rejected the zero-filled report.
- Retained selected installed source/catalog hashes as provenance, not a complete dependency-closure binding.

The shared-normalizer probe intentionally supplied no Codex service-tier callback: its populated-usage result demonstrates base arithmetic and field loss, **not complete Codex transport pricing**. The Codex multiplier was inspected in installed source separately.

Both SDK probe executions passed, each with eleven vectors, zero fetch attempts, zero provider requests, no prompts, unchanged empty auth, and temporary-directory cleanup. Initial and final sanitized results are retained separately at `.pi/evaluation/e1-pricing-runtime-probe-result.json` and `e1-pricing-runtime-probe-final.json` (private mode 0600). They are not campaign attempts or a pricing/billing authority. The fetch guard is not a hostile-code OS network sandbox.

## Verification and next gate

Final checks on Node.js 24.20.0:

| Check | Result |
|---|---|
| Guild `npm test` | 135/135 passed |
| Guild `npm run typecheck` | Passed |
| `npm run eval:test` | 80/80 passed |
| `npm run eval:typecheck` | Passed |
| Root `npm test` | 2/2 passed |
| Bank validation / offline schedule | Six tasks; approved digest unchanged; schedule generated without execution |
| `npm pack --dry-run --json` | 39 files; evaluation/private assets excluded |
| `git diff --check` | Passed |
| SDK/sensitivity temporary directories and copies | Removed |

No historical trial or campaign files were rewritten. All intentional REDs were restored; nothing was staged or committed.

Follow-up: the [raw response checkpoint](e1-response-observation.md) implements transport adapters and checks them against the actual SDK using synthetic responses. It demonstrates missing-category/tier rejection even when normalized base arithmetic agrees. The adapters are not yet bound to campaign execution or receipts, so the gates below remain.

Still required before live execution:

1. Actual native runtime/implementation/context/auth/model observation bound to execution, not the existing observer callback seam or this manual SDK snapshot. Account for the native built-in extension and system-prompt discovery findings from the previous checkpoint.
2. Response-level metering/service-tier observation and remaining child internal context/accounting verification. Arithmetic agreement cannot prove raw usage presence, external rates, entitlement, or billing. Missing information must remain unknown.
3. Fresh independent review outside the failed Bun route, with material findings resolved. No paid reviewer/judge call was added here.
4. Then—and only then—the original first pair within the unchanged [smoke allowance](e1-smoke-campaign.md), followed by inspection. No retry/replacement campaign, holdout promotion, or Phase 2 is authorized by this checkpoint.
