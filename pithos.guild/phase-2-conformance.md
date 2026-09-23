# Phase 2 conformance

## Selective commit checkpoint

This foundation/protocol checkpoint excludes the pending CQRS skill, evaluator infrastructure and runner instrumentation, and optional logging changes. The historical verification records below refer to the larger mixed working tree, not this selective snapshot. References to excluded evaluator work do not claim it is included in this commit.

The isolated selective snapshot passes **160 Guild tests (16 suites)**, Guild typecheck, package dry-run (**35 files**), and **2 root tests** using the existing installed dependencies. Compared with the mixed-tree 169 tests/42 files, this excludes six CQRS tests, three runner-observation tests, six CQRS skill resources and the optional logging module. The package still includes the child protocol, schemas and result collector. No live Pi/provider execution was performed.

The snapshot includes the existing Plan README correction pointing retired TDD users to Guild. Omitting it exposed a failing Guild migration assertion; including that documentation-only correction made the selective snapshot pass. No runtime Plan behavior is changed.

## Scope and frozen contract

Reduced Phase 2 only. E1 remains stopped. No evaluator/native-gate edits, Pi/SDK sessions, provider calls, Docker, spending, global runtime changes, staging, commits, version bumps or releases. Existing mixed work was retained. Independent review approved this bounded cooperative protocol with no findings.

`guild/2`, version 1: a pure builder preserves task text and binds host-assigned run/task identity and canonical role/profile. No inferred scope, acceptance criteria, practices or leases.

Result exact keys: `protocol`, `version`, `runId`, `taskId`, `role`, `profile`, `summary`, `blockers`, `limitations`, `payload`.

| Role | Exact payload |
| --- | --- |
| explorer | observations: [{reference, observation}], unknowns: string[] |
| architect | decisions: string[], contracts: string[], handoff: string[] |
| coder | changes: [{path, change}], verification: [{command, outcome}] |
| reviewer | scope: string[], findings: [{severity, reference, finding}], verdict |

Severity: Critical / High / Medium / Low. Verdict: Request changes / Comment / Approve. Empty lists and honestly unperformed checks are permitted; verdicts are not certified by the host.

Bounds: 48 KiB serialized UTF-8 result, 2048 UTF-8 bytes/string, 32 items/list, 128 bytes/identity. Transport: 1 MiB/JSON line, 16 MiB total stdout, 64 KiB total stderr. Overflow fails, rather than truncating a result into success. Display truncation is separate. Numeric compatibility usage placeholders are accompanied by `usageKnown` and `usageFields`; recorded totals may be partial.

## Connected implementation

- `runGuildRole` assigns identities, builds one envelope and writes private temporary task/prompt files. Both public handover routes use it through the existing shared admission/FIFO path.
- Explicit absolute local `src/child-protocol.ts` survives `--no-extensions`; no parent extension discovery, recursive tool, extra repository tool or ambient resource is enabled. Repository ceilings remain unchanged; `childTools` adds only `guild_submit_result`.
- Child checks effective tools, handles input without work on startup mismatch, emits an identity/tool handshake, validates raw arguments before Pi coercion and revalidates in execute. Submission must be the sole batch call.
- Invalid tool results (including pre-execute schema errors) and missing completion share one budget. Repair must be the next assistant response, with no reset at `agent_start`. Violations abort/block; `ctx.shutdown()` is not used.
- Parent accepts only correlated successful `tool_execution_end.details`, independently validates it and ignores the duplicate toolResult message representation. Duplicate submissions, mismatches, mixed/post-result work, errors and cancellation cannot yield completion.
- Final settlement is necessary but insufficient: process close and owned cleanup must also succeed. No prose fallback. Final outcomes and partial known usage reach both tool/direct details; the parent tool-result hook marks failed/cancelled outcomes as errors. Legacy UI rendering remains supported.

## Test list and coverage

- [x] All 24 role/profile pairs; original text and deterministic identities; exact headers/nested keys; UTF-8/list/result byte bounds (`protocol.test.ts`).
- [x] Strict raw schema before Pi coercion; valid result; duplicate/post-result work; schema-error/missing shared repair; continued `agent_start`; mixed batch; next-response repair bound; wrong startup tools (`child-protocol.test.ts`).
- [x] Connected child hooks -> Pi's actual pure `validateToolArguments` helper -> parent collector: valid, invalid-repair, missing-repair, exhaustion, mismatch, mixed batch and cancellation (`connected-protocol.test.ts`). Hook scheduling is authored from inspected source, not a live Pi session.
- [x] Finalized result versus arguments; handshake/settlement requirements; representation deduplication; reused call ID; errors/nonzero/cancel/late events; fragmented UTF-8 and malformed/oversized JSON (`result-stream.test.ts`).
- [x] Actual inert Node child invocation for all 24 prompt/tool/resource combinations, temporary permissions/cleanup, prose-only rejection, bounded stderr/stdout, extension/provider/process failure after submission, callback exceptions, reentrant cancellation and cleanup failure (`runner.test.ts`). No Pi executable is invoked by these fixtures.
- [x] Tool/direct/editor/alias compatibility, shared Plan/trust gate, FIFO, queued/active cancellation/shutdown, reentrant shutdown, correlated direct lifecycle, partial usage and no new legacy-prose success (`extension.test.ts`, existing `run-queue.test.ts`).
- [x] Completed/failed/cancelled and legacy persisted rendering; unknown/partial usage label (`ui.test.ts`).
- [x] Pi 0.87.0 dev resolution, peer packaging, publication of child source without auto-discovery, generated catalog/root metadata (package checks and pack listing).

## Observed RED/GREEN

Commands below were run from `pithos.guild` using `node --import tsx --test`. New modules first failed with the deliberately absent production import, not a fixture/setup failure. Each listed cycle was rerun GREEN after implementation.

| Focused test file / name filter | Observed RED |
| --- | --- |
| `test/protocol.test.ts` | missing `src/protocol.ts` |
| `test/child-protocol.test.ts` | missing `src/child-protocol.ts` |
| `test/result-stream.test.ts` | missing `src/result-stream.ts` |
| runner: `fails closed on prose-only` | `getRunFailure` returned null |
| extension: `same failed terminal\|legacy prose as a new` | failure threw/lost details; prose completed |
| result-stream: `reusing a failed` | completed instead of failed |
| runner: `only finite reported` | observed usage fields absent |
| extension: `preserves original tool task` | text trimmed to `Work` |
| UI: `cancelled tool results distinctly` | displayed Failed instead of Cancelled |
| protocol: `builder deterministic` | task UUID regenerated |
| child: `next assistant response` | intervening work was not aborted |
| child: `startup effective tools` | no handled input result |
| child: `before Pi can coerce` | no strict raw argument preparation |
| result-stream: `late finalized sibling` | completed instead of failed |
| runner: `host run/task identity` | failed terminal run identity absent |

Additional fixture/contract pins were checked with controlled mutations of only this implementation's own uncommitted lines, restored in `finally`, then rerun GREEN:

| Controlled mutation | Focused command suffix | Observed failure |
| --- | --- | --- |
| Return empty submission details | `--test-name-pattern='validation: valid' test/connected-protocol.test.ts` | Invalid Guild result schema or identity; failed vs completed |
| Permit extra schema keys | `--test-name-pattern='unknown nested record' test/protocol.test.ts` | Missing expected exception: explorer |
| Omit shutdown classification | `--test-name-pattern='reentrantly shuts down' test/extension.test.ts` | failed vs cancelled |
| Swallow owned cleanup failure | `--test-name-pattern='owned cleanup fails' test/runner.test.ts` | completed vs failed |

A broad intermediate run exposed old prose/throw-based fixtures; those were updated to the new structured-terminal contract, preserving admission and FIFO assertions. One typecheck caught a widened fixture `toolCall` literal after using Pi's validation helper; adding `as const` fixed it. Root checks initially rejected the authorized minimum change against the old 0.83 expectation; only Guild's expected minimum was updated.

## Verification commands

Dependency alignment (package-local only):

```text
npm install --save-dev --save-exact --ignore-scripts @earendil-works/pi-coding-agent@0.87.0 @earendil-works/pi-ai@0.87.0 @earendil-works/pi-tui@0.87.0
npm ci --ignore-scripts
npm ls --depth=0
```

All three direct Pi development resolutions are 0.87.0. Existing wildcard Pi peer conventions remain; no runtime dependency was bundled by Guild. Lock churn is the selected Pi packages and their dependency/bundled trees, not a general dependency upgrade. `npm ci` succeeded; npm reported zero vulnerabilities and a transitive `node-domexception` deprecation warning.

Final checks (observed):

| Directory | Command | Result |
| --- | --- | --- |
| `pithos.guild` | `npm test` | 169/169 pass, 17 suites |
| `pithos.guild` | `npm run typecheck` | pass |
| `pithos.guild` | `npm pack --dry-run` | pass, 42 files; child/protocol/collector source included; no evaluation or test resources |
| root | `npm run catalog:generate` | regenerated from 12 manifests |
| root | `npm test` | 2/2 pass |
| root | `git diff --check` | pass |

No package-wide lint/build script exists. Focused files were also run separately with `node --import tsx --test test/<name>.test.ts` (protocol, child-protocol, result-stream, connected-protocol, runner, extension, UI), and the name-filtered commands above were rerun to GREEN.

## Limitations

No live Pi startup/resource-loader/provider propagation was executed. Installed Pi 0.87.0 README/extensions/json/session-format/packages docs, structured-output example and relevant loader/session/agent-loop/print-mode/validation source informed the authored seams. Tests exercise the actual pure Pi argument validator, not a provider. The initial compatibility target is 0.87.0; neither 0.83 fallback nor all future versions are certified.

Reports are cooperative child claims, not authenticated evidence, host-certified truth, write leases, rollback or hostile-code containment. Existing opt-in Node diagnostics-channel subscribers retain Node's subscriber contract (must not throw); runner update callbacks are isolated. No quality/cost/latency benefit was measured.

## Independent review and main-session verification

A read-only Guild reviewer (TypeScript profile) inspected the connected implementation, tests, package compatibility and installed/local Pi source: **Approve; no findings**, scoped to this cooperative protocol. The reviewer did not run tests or execute Pi/providers; supplied test results were not represented as independently reproduced.

The main session subsequently reran `npm test`, `npm run typecheck` and `npm pack --dry-run` from `pithos.guild`: **169 tests passed**, typecheck passed, and the dry-run listed 42 published files. Root `npm test` passed **2 tests**, and `git diff --check` passed. No live Pi/provider/Docker execution, evaluator expansion, staging, commits or releases occurred.

## Roadmap reconciliation and fresh verification — 2026-09-23

The local roadmap `.pi/plans/2026-08-21-164459-guild-bounded-delegation-roadmap.md` now distinguishes the historical baseline, implemented Phase 1 foundation, reduced Phase 2 contract, and deferred target architecture. This reconciliation changes documentation only; substantial pre-existing working-tree changes were preserved. It does not assert that the implementation is committed or released.

The richer task schema is explicitly deferred, not silently satisfied by prose: structured objective, scope, acceptance criteria, constraints, artifacts and practices, full-envelope unknown-field rejection, and task field/total size bounds remain outstanding. Current result bounds do not bound task text. Required practices or routing must first obtain an explicitly designed and approved task-contract extension for the fields they require. Process-local FIFO is not a cross-process repository writer lock; coder path scope remains instructional.

Fresh checks executed against the current working tree using existing installed dependencies:

| Directory | Command | Observed result |
| --- | --- | --- |
| `pithos.guild` | `npm test` | 169/169 pass, 17 suites; no failures, skips or cancellations |
| `pithos.guild` | `npm run typecheck` | pass |
| `pithos.guild` | `npm pack --dry-run` | pass, 42 files; `src/child-protocol.ts`, `src/protocol.ts`, `src/result-stream.ts` included; no evaluation or test resources |
| root | `npm test` | 2/2 pass |
| root | `git diff --check` | pass |

No dependency installation, metadata change, catalog regeneration, production edit, evaluator test/activation, live Pi/provider/Docker execution, staging, commit or release was performed in this reconciliation. These results freshly reproduce the offline checks, not the earlier independent review or live runtime behavior. The local roadmap is an ignored planning artifact and is not included by ordinary Git diff checks; its text and whitespace were checked separately.

Live Pi 0.87.0 startup/resource-loader/event-order/provider integration and representative real-task quality/cost/latency evidence remain unverified here. The separate E1 operational gates remain closed. Reduced Phase 2 conformance is not full original Phase 2 completion or promotion readiness. Stop for user review; Phase 3, including exact-skill/practice preparation, remains unauthorized.
