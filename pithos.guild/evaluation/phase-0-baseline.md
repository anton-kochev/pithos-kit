# Guild Phase 0 baseline

## Scope and measurement policy

This artifact records the current implementation before the approved role/profile clean break. Phase 0 changes no Guild runtime code. Evidence comes from the checked-in source, deterministic temporary-directory fixtures, and local test/type-check commands run on Node.js 24.19.0, npm 11.17.0, and TypeScript 5.9.3.

The initial Phase 0 implementation intentionally did not invoke a real model. Review identified that omission as a Phase 0 exit-gate gap, so a minimal controlled subset was subsequently run in disposable `/tmp` fixtures. The fixtures contained no repository credentials or user work. Both arms used `openai-codex/gpt-5.6-sol`, `medium` thinking, identical role-appropriate tool lists, `--no-session`, `--no-extensions`, and `--no-prompt-templates`. The current-member arm used the existing Guild runner and bundled prompt; the main-only arm used Pi's default prompt without a Guild member prompt. Ambient skills/context remained at current legacy defaults because Phase 0 must characterize rather than change them.

The raw JSONL files were kept outside the repository during measurement and are not published. The exact task texts, fixture purpose, measured aggregates, and rubric outcomes are recorded below. Parent-context growth is represented by final report bytes because provider tokenization of a report after reinjection was not separately observable; no token estimate is fabricated. Unimplemented future role/profile arms remain unavailable rather than being assigned zero values.

## Deterministic current-state baseline

| Area | Observed current behavior | Evidence |
|---|---|---|
| Public identity | Nine member names and a `guild_handover({ member, task })` input. The task is a non-empty free-form string. | `src/agents.ts`, `src/guild.ts`, `test/extension.test.ts` |
| Discovery order | Built-in definitions load first, then user definitions, then trusted project definitions; later accepted layers win. An untrusted project cannot displace a user definition. Returned members follow the package roster order. | `test/agents.test.ts` |
| Invalid discovery input | Malformed files, empty known definitions, duplicate known definitions, and tool-changing known definitions produce deterministic warnings. Invalid overrides leave the prior accepted definition in place; within one directory, the alphabetically first valid duplicate wins. Reordered exact tool sets are accepted and normalized to package order. | `test/agents.test.ts` |
| Unknown discovery name | An unknown definition is silently ignored and cannot enter the roster. This lack of a warning is a **legacy gap**, not target behavior. Unknown direct command input does produce a visible unavailable-member error. | `test/agents.test.ts`, `test/extension.test.ts` |
| Project prompt trust | Project definitions are considered only for trusted projects. A selected project override requires interactive confirmation and is rejected before launch when UI is absent or approval is declined. | `test/agents.test.ts`, `test/extension.test.ts` |
| Architect ceiling | `dotnet-architect`, `frontend-architect`, `typescript-architect`, and `rust-architect`: exactly `read,grep,find,ls`. | `src/agents.ts`, `test/agents.test.ts`, `test/runner.test.ts` |
| Coder ceiling | `csharp-coder`, `angular-coder`, `typescript-coder`, and `rust-coder`: exactly `read,grep,find,ls,edit,write,bash`. | `src/agents.ts`, `test/agents.test.ts`, `test/runner.test.ts` |
| Reviewer ceiling | `code-reviewer`: exactly `read,grep,find,ls,bash`. Reviewer `bash` is a known temporary legacy limitation; read-only use is prompt policy rather than a mechanical shell ceiling. | `src/agents.ts`, `test/agents.test.ts`, `test/runner.test.ts` |
| Tool forwarding | `buildChildArguments` forwards each selected member's exact comma-separated tool list. | `test/runner.test.ts` |
| Child invocation | Current fixed flags include `--mode json`, `-p`, `--no-session`, `--no-extensions`, and `--no-prompt-templates`, plus trust, tools, optional model/thinking, and an appended system prompt. | `src/runner.ts`, `test/runner.test.ts` |
| Ambient resources | `--no-skills` and `--no-context-files` are currently absent. Exact skill loading and explicit context loading are not implemented. | `test/runner.test.ts` |
| Process boundary | The child is ephemeral, inherits cwd, trust, model, and thinking level, and receives a generated prompt file. JSON mode is JSONL event transport only; accepted output remains free-form assistant text. | `src/runner.ts`, `test/runner.test.ts`, `test/extension.test.ts` |
| Output bound | Truncation retains up to 50 KiB (51,200 bytes) of original model-visible text without splitting UTF-8 characters, then appends a truncation notice, so the returned value can exceed 50 KiB by the notice length. Full result data remains in details. | `src/guild.ts`, `src/runner.ts`, `test/runner.test.ts` |
| Usage telemetry | Per run, current aggregation can record input, output, cache-read, cache-write, cost, context tokens, turns, model, and stop reason. Guild has no persistent aggregate evaluator; the controlled A01/R01 sample below was aggregated manually from raw run events. | `src/runner.ts`, controlled baseline below |
| Lifecycle | Pre-launch picker/editor cancellation creates no run or lifecycle event. A launched direct handover records `started` and one correlated terminal event. Agent-invoked dashboard state clears after success, failure, or abort. | `test/extension.test.ts` |
| Plan state parser | No matching entry is inactive; explicit booleans select active/inactive; the latest matching entry wins; malformed latest matching data is indeterminate. | `src/safety.ts`, `test/safety.test.ts` |
| Plan handover gap | Direct `/guild-handover` currently still launches while Plan state is active or indeterminate. This is explicitly pinned as temporary legacy behavior to invert in Phase 1. | `test/extension.test.ts` |
| Concurrency and mutation | Current Guild has no repository-level writer serialization, canonical routing, scoped lease, or final change audit. Shell mutation remains possible for coders and the reviewer has legacy shell access. | `src/guild.ts`, approved plan |

## Test baseline and pre-existing failure

The first package-suite run before Phase 0 test additions observed:

- 108 tests in 15 suites;
- 107 passed and 1 failed;
- reported wall duration: 2,939.609335 ms (environment-sensitive, not a product threshold);
- `npm run typecheck` passed.

After the Phase 0 characterization tests were added, the package suite observed:

- 125 tests in 16 suites;
- 124 passed and the same 1 test failed;
- reported wall duration: 2,533.683292 ms on the first post-change run and 3,079.579668 ms on the final rerun (environment-sensitive, not a before/after performance comparison);
- the focused Phase 0 set passed 60/60;
- `npm run typecheck` passed.

The remaining failure is pre-existing and unrelated to Phase 0: `test/tdd-skill.test.ts`, case `points active migration guidance at Guild without creating duplicate owners`, expects `pithos.plan/README.md` to state that Guild 0.3.0 owns the relocated TDD skill and Atlas 0.6.0 no longer bundles it. The current Plan README no longer contains that migration text. Phase 0 did not modify either file, as required. This is Plan README drift in unrelated user work, not a Guild Phase 0 regression.

The repository-root metadata suite separately passed 2/2 before and after the scoped Phase 0 changes.

## Real-model metric baseline

### Controlled tasks

**A01 — TypeScript architecture.** A strict ESM TypeScript fixture contained a `JobRunner` with a FIFO queue, concurrency limit, discarded `AbortController`s, polling shutdown, and one concurrency test. Both arms received this exact task:

```text
Read-only architecture task. Inspect this fixture and design the smallest repository-compatible change to JobRunner so that enqueue rejects after shutdown begins, queued jobs are cancelled, active jobs receive cancellation after a 100 ms drain deadline, and concurrent shutdown callers share one terminal outcome. Define ownership, ordering, cancellation and cleanup invariants, concrete contract changes, a test-first plan, affected paths, trade-offs, and an implementation handoff. Do not edit files or run shell commands.
```

**R01 — Authorization review.** A minimal TypeScript fixture stated that users may update their own profile and administrators any profile. `updateUser` checked only that the actor had a non-empty ID before saving any caller-selected target ID. Both arms received this exact task:

```text
Review the current staged and unstaged change in this repository against README.md. Find concrete correctness or security defects introduced by the change. Return findings first with severity, exact path and line, evidence, impact, focused remediation, review scope, verification limits, and a Request changes, Comment, or Approve verdict. Do not edit files.
```

The fixture had no Git metadata during these two runs; both arms correctly reported that staged/unstaged provenance could not be established.

### Measured aggregates

| Task / arm | Outcome | Elapsed | Input | Output | Cache read | Final context | Report bytes | Report quality | Reported cost |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|
| A01 main-only | Completed | 129,081 ms | 6,271 | 4,970 | 0 | 6,839 | 7,793 | 6/6 predeclared architecture criteria | $0.180455 |
| A01 `typescript-architect` | Completed | 132,005 ms | 8,708 | 5,669 | 16,896 | 12,385 | 9,713 | 6/6 predeclared architecture criteria | $0.222058 |
| R01 main-only | Request changes | 32,447 ms | 6,675 | 755 | 4,608 | 2,443 | 1,069 | Found 1/1 seeded High defect; 0 unsupported findings | $0.058329 |
| R01 `code-reviewer` | Request changes | 37,391 ms | 16,971 | 987 | 13,824 | 6,214 | 1,301 | Found 1/1 seeded High defect; 0 unsupported findings | $0.121377 |

Input, output, cache-read, and cost columns aggregate every assistant turn exactly once for both arms. The final-context column is separate: main-only values are the terminal provider call's `totalTokens`, while Guild values are the current runner's terminal `contextTokens`. Those final-context fields have provider/runner-specific semantics and must not be treated as cumulative usage. Report bytes are directly comparable and represent the payload that would normally be returned to parent context.

Architecture rubric (one point each): detected the current queue/shutdown defects; preserved synchronous `enqueue` compatibility; defined one state owner and one cached shutdown outcome; made admission/order/cancellation/cleanup invariants explicit; addressed cooperative cancellation and ignored-signal behavior; supplied affected paths plus behavior-first tests and handoff. Both arms satisfied all six. Review rubric: seeded authorization defect found with correct High severity, exact path/evidence, persistence impact, focused authorization check/tests, and Request changes verdict; unsupported findings counted separately. Both arms found the one seeded defect and added no unsupported finding.

An exploratory A01 main-only run at `xhigh` was terminated after the 300,000 ms harness limit without a final assistant result. Its partial JSONL was 250,310 bytes; final usage/cost was unavailable and is not inferred. No matching current-member `xhigh` arm was run, so this is an operational observation rather than a comparative quality result.

### Interpretation limits

- Two read-only tasks are a minimal exit-gate baseline, not evidence that delegation is generally worse or better.
- No implementation task was run, so changed-file discipline, test execution, and write-scope metrics remain uncollected.
- No future role/profile implementation exists yet.
- The current specialist prompts increased input/context and report size in both sampled tasks without improving this small rubric score; later phases must test whether compact roles/profiles preserve quality at lower cost.
- Stochastic claims require repeated fixture runs in later phases; these single runs are retained in the denominator and must not be presented as statistical results.

| Metric not covered by A01/R01 | Current state |
|---|---|
| Implementation correctness and verification | Not yet collected; requires disposable writable fixtures. |
| Unnecessary or out-of-scope files changed | Not yet collected; both tasks were read-only. |
| Human corrections beyond the fixed rubric | Not yet collected. |
| Routing mistakes/corrections | Zero in these manually selected arms; automatic routing is not implemented. |
| Protocol repair/failure rate | Not applicable to the current free-form boundary. |
| Future role/profile comparison | Not available until implemented. |

## Representative future real-model task matrix

Use immutable fixture commits or disposable clones. Each task needs explicit acceptance criteria and an oracle based on tests, compilation, diff inspection, or a fixed review rubric. Do not run these tasks against the user's working tree.

| ID | Representative task | Current arm | Approved future arm | Primary comparison signals |
|---|---|---|---|---|
| M01 | Design cancellation and transaction boundaries for a .NET order API with an existing solution and tests. | `dotnet-architect` | `architect/dotnet` | Repository-version use, invariant coverage, implementable handoff, invented dependencies |
| M02 | Implement order validation in that API and add the smallest regression test. | `csharp-coder` | `coder/dotnet`, then later required TDD | Test red/green evidence, correctness, files changed, verification |
| M03 | Decide whether a CRUD-heavy .NET workflow justifies CQRS without adding packages. | `dotnet-architect` plus optional skill discovery | `architect/dotnet` with selected CQRS practice/skill in a later phase | Proportional decision, consistency model, unsupported API claims |
| M04 | Define state ownership and loading/error behavior for an existing Angular checkout feature. | `frontend-architect` | `architect/frontend` or `architect/angular` only if later supported | Installed-version awareness, state boundaries, accessibility, handoff quality |
| M05 | Implement an Angular checkout error state under the repository's existing component style. | `angular-coder` | `coder/angular` | Rendered behavior, accessibility, focused tests, unrelated migration |
| M06 | Design ESM exports and async shutdown contracts in a TypeScript package. | `typescript-architect` | `architect/typescript` | Runtime/module correctness, compatibility, lifecycle coverage |
| M07 | Fix a TypeScript parser regression involving malformed external input. | `typescript-coder` | `coder/typescript`, then later required TDD | Runtime validation, strict types, regression test, emitted behavior |
| M08 | Convert one coherent JavaScript dependency slice to TypeScript without changing package exports. | `typescript-coder` | `coder/typescript` | Consumer compatibility, assertions introduced, build/test success |
| M09 | Redesign crate boundaries for a Rust workspace with feature-gated adapters. | `rust-architect` | `architect/rust` | Dependency direction, feature coherence, staged migration, compile checkpoints |
| M10 | Fix a Rust ownership bug in a parser while preserving the public error contract. | `rust-coder` | `coder/rust` | Compiler-driven fix, clone/unsafe use, tests, public compatibility |
| M11 | Review an authorization-sensitive TypeScript diff with one seeded high-severity defect and benign noise. | `code-reviewer` | `reviewer/general` | Seeded-defect recall, false positives, severity, evidence, deterministic verdict |
| M12 | Review an async resource-cleanup diff with a seeded listener leak and an unrelated pre-existing issue. | `code-reviewer` | `reviewer/general` | Changed-scope reasoning, leak detection, unrelated-change handling |
| M13 | Change a shared API contract consumed by .NET and Angular packages. | Main agent coordinating current bounded members | Main agent coordinating `architect/dotnet`, `architect/frontend`, then one serialized coder at a time | Cross-boundary completeness, synthesis burden, duplicate work, compatibility |
| M14 | Implement a focused fix in a repository that starts with unrelated staged, unstaged, and untracked changes. | Matching current coder | Matching future coder; later lease/audit arm | Preservation of baseline changes, attribution, unnecessary files, completion honesty |
| M15 | Present an ineligible repository/task to each stack-specific implementation path. | Current coder refusal behavior | Canonical coder/profile eligibility | Correct refusal, evidence cited, no speculative scaffolding or mutation |

## Comparison procedure for later phases

1. Freeze the fixture commit, task text, acceptance criteria, model/provider version, thinking level, and tool environment.
2. Run main-agent-only and current-member arms before replacing the current implementation; retain raw JSONL usage and final diffs outside normal parent context.
3. Run a minimum justified number of repetitions for stochastic tasks; report every result and the aggregation method rather than selecting the best run.
4. For later arms, change only the capability under evaluation: canonical role/profile, structured protocol, exact skills, routing, guardrail, or reviewer. Do not bundle phases into one comparison.
5. Record input/output/cache tokens, reported cost, elapsed time, parent-context bytes/tokens before and after synthesis, routing correction count, lifecycle outcome, and all changed paths.
6. Score output against the predeclared oracle. Keep model self-assessment separate from test/compiler results and human review.
7. Preserve failed, blocked, cancelled, and protocol-error runs in the denominator.

## Phase 0 interpretation

The deterministic baseline now protects the current boundary while the README documents the approved clean break. The minimal A01/R01 model subset closes the Phase 0 measurement gap while remaining explicitly too small for broad conclusions. Phase 0 does not implement role/profile dispatch, aliases, schemas, exact skills, repository routing, guardrails, or any other Phase 1+ behavior. Later phases must extend the controlled matrix one capability at a time and retain failed, timed-out, blocked, and cancelled runs in the denominator.
