# E1 runtime readiness — installed catalog inventory

## Follow-up: runtime switch explicitly approved

The user subsequently confirmed the proposed Node/Pi 0.85.1 switch. See [the approval and offline authentication check](e1-runtime-0851.md). The inventory and then-pending proposal below remain a historical record; the current campaign selection is in [the smoke configuration](e1-smoke-campaign.md).

## Inventory checkpoint: runtime decision was required

A static, offline inventory on 2026-09-07 found an already-installed candidate for the approved model. **The approved runtime has not changed, and live execution remains blocked.**

| Installation | Pi / pi-ai versions | Shipped Codex catalog contains `gpt-6-astra`? |
|---|---|---|
| Guild-local dependencies | 0.82.1 / 0.82.1 | No |
| Atlas-local approved runtime | 0.83.0 / 0.83.0 | No |
| Installed runtime under `/opt/pi-npm` | 0.85.1 / 0.85.1 | Yes |

The candidate's catalog entry identifies `openai-codex/gpt-6-astra`, API `openai-codex-responses`, and an explicit `high` thinking mapping. It includes cost metadata and a context-dependent pricing tier, which still need verification before use by the campaign's accounting policy. Catalog inclusion does **not** prove credential entitlement, successful provider service, immutable model identity, current billing rates, or extension compatibility.

## Evidence and bounds

Only explicit installed package manifests and `pi-ai/dist/providers/data/openai-codex.json` files were parsed, using Node.js 24.20.0 filesystem/crypto APIs. No Pi runtime or provider module was dynamically loaded. No credentials, user/global settings, custom models configuration, or authentication discovery were accessed. No network request, model trial, package install, runtime patch, or source-code change occurred in this inventory.

The private record `.pi/evaluation/e1-runtime-catalog-inventory.json` retains the observation time, installation paths, versions, catalog model sets, candidate entry, and raw-byte SHA-256 hashes of the Node executable, package manifests, and catalogs. These inventory hashes are not the completed campaign runtime fingerprint: they do not cover all executable dependencies or observed launch behavior.

Raw-byte catalog SHA-256:

- Guild/Atlas catalog: `c3313710bc6910e6bbcb06d5867247e97ec3fa6c2af9bc780f8a3eefb03e32e1`.
- Installed 0.85.1 catalog: `a10bfcfd34db6bcb98d8ee46175e154cab30530a137dbf31ac1434020ed3ffdd`.

This is environment fact-finding, not new runtime-observer implementation, TDD evidence, an independent review, or a model-quality result. After documenting the inventory, the unchanged suites were rerun: Guild **135/135**, evaluation **69/69**, both typechecks, repository root **2/2**, and `git diff --check` passed. These regressions do not test production integration with Pi 0.85.1. Nothing was staged or committed; prior [execution bridge verification](e1-execution-bridge.md) is not rewritten.

## Proposed decision — not yet approved

Use the **already-installed Pi 0.85.1 through Node**, retaining `openai-codex/gpt-6-astra`, `high`, the six development tasks, two natural arms, twelve maximum attempts with no retries, the $10 estimated-usage admission guard, and the approved time limits and first-pair inspection.

This would change the frozen runtime cohort. It is not an npm package version change or permission to install/patch anything. It requires explicit approval; do not silently select it because it appears in this inventory.

After approval, before permitting this runtime in the Codex driver:

1. Review 0.85.1's access-token/refresh policy and relevant SDK/CLI compatibility. The current access-only driver accepts exactly 0.83.0; do not just widen that pin.
2. Verify synthetic authentication without networking and production Guild registration/ordinary child startup under Node, including actual dependency resolution. Keep real credentials and provider requests out of these offline checks.
3. Implement actual native input/runtime/model/context/auth-policy/pricing observation and bind it to execution; injected matching digest strings remain insufficient.
4. Obtain independent review and resolve material findings before enabling live execution. Paid review/probe calls are not implicitly included in the smoke allowance.
5. Update the approved configuration and freeze verified implementation/runtime/policy evidence before the first pair. No extra trials, retries, judges, or replacement campaigns are authorized by a runtime decision.

Alternatively, retain Pi 0.83.0 and separately approve a model that it supports. No alternative model is selected here, and no custom model configuration is imported.

See [the existing approval](e1-smoke-campaign.md) and [authentication compatibility record](e1-authentication.md). Phase 2, held-out promotion, staging, commits, versioning, and publishing remain separately gated.
