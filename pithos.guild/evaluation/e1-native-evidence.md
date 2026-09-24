# E1 general native-evidence reconciliation

**Status: provider-free audit implemented and tested; campaign binding remains unfinished.** This is a prerequisite for receipts, not a new execution mode or permission to spend. The native driver and old connected probe remain disabled.

## Why a separate audit

The [isolated Guild checkpoint](./e1-offline-guild.md) verifies a deliberately fixed synthetic workflow. Its two children, four requests, exact response text, transport counters and no-child-tool rules cannot grade natural workflows. `src/native-evidence.ts` instead reconciles variable numbers of requests and canonical handovers, including abstention and ordinary allowed tool use. The fixed synthetic checker remains unchanged.

`auditNativeEvidence()` takes an explicit arm, frozen-by-the-caller base pricing, supervisor/parent PIDs, raw parent/child-observer JSONL and a filename-to-raw-native-JSONL map. It has no filesystem, SDK, provider, authentication or process-launch dependency. It returns producer/request counts, ordered child targets, reconciled usage and a digest of the complete supplied input, including its exact raw strings. Missing observations are rejected, not replaced with empty/zero-usage evidence.

## Checks

- Exactly one parent and one matching producer per observed child: canonical filename/PID, direct ancestry, actor, contiguous sequence, reviewed Node/Pi version declarations, complete normal process footer, no extra producer files.
- Initial and per-request context records: expected model/high thinking, canonical role/profile, hard tool ceiling and stable system-prompt digest within each producer. All four roles and six profiles are supported; the Guild arm may abstain.
- One native request per finalized assistant turn: complete request lifecycle, outgoing exact model/high/omitted-or-default tier, raw SSE/WebSocket meter reconciliation and base-price arithmetic. Request, attempt and response identities cannot be reused across producers. Missing/incomplete/orphaned observations fail rather than becoming zero usage.
- Declared tool calls must match allowed, actually recorded starts/ends and arguments, with completion before the next assistant attempt; duplicate, late or unexecuted calls fail. Child recursion and tools outside the role ceiling fail. Ordinary tool errors may be recovered by later turns (important for failing tests during TDD); failed Guild handovers or incomplete provider requests do not certify usage.
- Each handover must match its declaration, raw child UUID/target, native spawn PID and the parent request that declared it. Child lifetimes and spawn order must agree with serialized observation. Each result's reported usage must equal its own child's raw usage; agreement only on the grand total is insufficient.
- Bounds before trace reconciliation: 16 MiB each for parent and child-observer strings, 16 MiB for all native strings together, at most 64 producer files, and at most 65,536 newline-separated segments per raw/decoded stream. Decoded child streams are bounded before the trace analyzer consumes them. These are audit bounds, not execution/spend limits or hostile-code containment.

## Retained-evidence replay

Provider-free replay of `offline-docker.d2iWYHzd` passed using the original retained inputs: three producers, four requests, explorer/typescript and coder/typescript, with usage agreeing with its original summary. No Pi or SDK/provider invocation was performed.

The older main-only checkpoint `offline-docker.7HBxaKLK` has no retained child-observer stream. It therefore **does not pass this complete general-audit input contract**. A separately labelled in-memory replay with an explicit empty observer fixture exercised its request records, but is only a hybrid control, not retained campaign evidence. The original main-only checkpoint remains valid within its original narrower scope. No file was backfilled, no missing stream was certified, and no replacement run was made.

Local fixtures exercise all 24 role/profile combinations, multi-turn children, non-fixed text, ordinary tools and recovery, abstention, identity reuse, cost redistribution, early/reordered/overlapping spawns, context/runtime/payload/meter drift, missing producers/footers, bounds and closed inputs. These are fixture tests, not actual model reasoning or child file-editing demonstrations.

A sensitivity check copied the auditor and tests into temporary evaluation-only files, removed one version check in the copy, ran the package test script, and removed both copies with an exit trap. The maintained auditor and active execution guards were never weakened.

| Controlled mutation | Test that went red | Diagnostic |
| --- | --- | --- |
| Omit the copied auditor's Node-version check | `npm run eval:test`: producer/lifecycle/context/payload/meter drift case | `Missing expected exception: node` |

The maintained suite then passed after copy cleanup.

## Still required before native campaign receipts

1. The [frozen native-policy contract](./e1-native-policy.md) is now implemented: campaign spec v2 requires policy/pricing, prevents omission/removal downgrade, and blocks native admission. Actual observed provenance and native receipt integration are still required; the contract alone is not readiness.
2. [Trial and parent-invocation input checks](./e1-native-trial-binding.md) now correlate the supplied specification/admission/request and exact parent argv. Bind actual launch metadata and every producer to those expectations, reviewed runtime/implementation and scoped authentication identity. Validate actual launch context, not merely supplied PID/version declarations; bind the serialized parent continuation/tool results rather than inferring forwarding from event order.
3. Read retained native files through the secure bounded evidence boundary, retain their digest in settlement, and apply the same audit during fresh receipt derivation and historical resume before another admission.
4. Complete the disabled driver integration and negative tests, then obtain approved independent review before the original live first-pair gate.

A caller-supplied pricing policy and cooperative process records are not independently verified runtime, auth, transport provenance or billing. A stable prompt digest alone does not prove the prompt's approved bytes or equality with the final serialized request instructions. The current request records select model/thinking/tier, not the entire outgoing prompt or tool-result payload. The existing in-process session/request guards inspect those policies, but their provenance and launch binding are not yet mandatory in campaign receipts. Checksums are not tamper-proof attestation or universal redaction. This increment neither changes the production Guild protocol nor authorizes Phase 2, live execution, spending or commits.
