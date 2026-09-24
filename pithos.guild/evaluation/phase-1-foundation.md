# Guild Phase 1 role/profile foundation evaluation

> E1 classification: historical conformance and pilot evidence. A01/R01 are regression cases; E01/C01 are acceptance cases without comparator arms; Q01 is dogfooding. None measures natural parent delegation through final synthesis or establishes statistical superiority. Historical results remain unchanged. See [evaluation methodology](methodology.md).

## Scope

Phase 1 replaces language-specific member identities with a fixed package-owned role/profile registry while intentionally retaining free-form task and result text. It adds four roles (`explorer`, `architect`, `coder`, `reviewer`), six profiles (`general`, `frontend`, `angular`, `typescript`, `dotnet`, `rust`), package-owned migration aliases, mechanical role tool ceilings, explicit child resource controls, equivalent Plan/trust admission, and one process-local FIFO run queue.

Phase 1 does **not** add researcher/web access, task or result protocols, exact selected skills, practices, repository routing, mutation guards, leases, audits, or parallel read-only execution.

## Deterministic evidence

- The public tool schema contains only strict `role`, `profile`, and `task` fields.
- `prepareArguments` maps exactly the nine old `{ member, task }` identities and leaves mixed, unknown, or extended legacy shapes invalid.
- All 24 role/profile pairs resolve from fixed package resources; `researcher` does not.
- Explorer, architect, and reviewer receive exactly `read,grep,find,ls`; only coder also receives `edit,write,bash`.
- No user or project member discovery remains, and the obsolete top-level combined prompts are absent.
- Child arguments include `--no-session`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--no-context-files`, plus explicit package-controlled system and role/profile prompt files.
- Tool and direct command share fail-closed Plan admission and immutable trust capture.
- Queue fixtures cover FIFO ordering, one active operation, queued and active cancellation, failure release, idempotent shutdown, active cleanup waiting, and listener cleanup.
- Direct command fixtures cover canonical and alias grammar, two-stage selection, editor cancellation, correlated lifecycle events, queue phases, and terminal cleanup.
- UI fixtures preserve old persisted member rendering while all new result details use canonical identity.

Compatibility was checked in a disposable copy against `@earendil-works/pi-coding-agent` **0.83.0** from Atlas's exact development dependency: TypeScript compilation and the 76 focused core tests passed. Pi 0.83.0 help also exposes every child-resource and system-prompt flag used by the runner. This is stronger evidence than inferring compatibility from Guild's older 0.82.1 lockfile.

## Controlled model tasks

All Phase 1 runs used `openai-codex/gpt-5.6-sol`, `medium` thinking, inherited trusted-project state, no session, no extensions, no skills, no prompt templates, no context files, fixed package prompts, and exact role tools. Raw aggregate records remain in disposable `/tmp` evaluation storage and are not published. Report quality was scored against fixed observable rubrics, not model self-assessment.

### A01 — architecture comparison

The exact frozen Phase 0 task and fixture were reused. The six criteria were: identify current shutdown defects; preserve synchronous `enqueue` compatibility; define one state owner and cached shutdown outcome; make admission/order/cancellation/cleanup invariants explicit; address cooperative cancellation and ignored signals; provide affected paths, behavior-first tests, and an implementation handoff.

| Arm | Elapsed | Input | Output | Cache read | Final context | Report bytes | Cost | Quality |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Phase 0 main-only | 129,081 ms | 6,271 | 4,970 | 0 | 6,839 | 7,793 | $0.180455 | 6/6 |
| Phase 0 `typescript-architect` | 132,005 ms | 8,708 | 5,669 | 16,896 | 12,385 | 9,713 | $0.222058 | 6/6 |
| Phase 1 `architect/typescript` | 102,886 ms | 5,500 | 4,455 | 0 | 6,130 | 8,170 | $0.161150 | 6/6 |

The Phase 1 report preserved the full design rubric with a smaller prompt/context footprint and lower elapsed time/cost than the sampled legacy specialist. This is one stochastic run, not a general performance claim.

### R01 — review comparison

The exact frozen Phase 0 authorization fixture and task were reused. Success required finding the one seeded High object-level authorization defect with exact evidence, persistence impact, focused remediation/tests, a Request changes verdict, and no unsupported finding.

| Arm | Elapsed | Input | Output | Cache read | Final context | Report bytes | Cost | Quality |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Phase 0 main-only | 32,447 ms | 6,675 | 755 | 4,608 | 2,443 | 1,069 | $0.058329 | 1/1 defect; 0 unsupported |
| Phase 0 `code-reviewer` | 37,391 ms | 16,971 | 987 | 13,824 | 6,214 | 1,301 | $0.121377 | 1/1 defect; 0 unsupported |
| Phase 1 `reviewer/general` | 41,385 ms | 6,810 | 1,365 | 0 | 3,506 | 1,452 | $0.075000 | 1/1 defect; 0 unsupported |

The mechanically read-only Phase 1 reviewer found the defect and explicitly disclosed that it could not run Git or verification commands. It was cheaper than the sampled legacy reviewer but slower and more expensive than main-only. Later reviewer hardening must solve constrained diff/verification access without restoring unrestricted shell.

### E01 — explorer usefulness

Exact task:

```text
Inspect this fixture read-only. Report the exact relevant files and manifests, the current JobRunner queue and shutdown behavior, existing test coverage, module/runtime/compiler settings, repository conventions that constrain a change, and any material unknowns. Cite paths and line ranges. Separate observed facts from assumptions. Do not design a replacement, edit files, or run shell commands.
```

| Arm | Elapsed | Input | Output | Cache read | Final context | Report bytes | Cost | Quality |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Phase 1 `explorer/typescript` | 70,760 ms | 6,698 | 2,991 | 0 | 4,685 | 6,323 | $0.123220 | 6/6 |

The report covered all six predeclared areas: files/manifests, current behavior, existing tests, compiler/runtime settings, constraining conventions, and material unknowns separated from observed facts. It made no changes and did not drift into a replacement design.

### C01 — coder usefulness

A disposable TypeScript authorization fixture started with one passing self-update test and a missing cross-user authorization check. Exact task:

```text
Implement the smallest fix required by README.md in this disposable TypeScript fixture. Preserve the public updateUser signature and add no dependencies. Add focused tests proving an ordinary user cannot update another user's profile and an administrator can update another profile; unauthorized attempts must fail before store.save. Run the existing test command and report changed files, behavior, exact verification, and residual risks. Do not commit.
```

| Arm | Elapsed | Input | Output | Cache read | Final context | Report bytes | Cost | Outcome |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Phase 1 `coder/typescript` | 49,501 ms | 14,963 | 1,596 | 11,264 | 5,327 | 685 | $0.128327 | Correct; 3/3 tests passed |

The coder changed only `src/users.ts` and `test/users.test.ts`, preserved the public signature, added no dependency or artifact, rejected unauthorized access before persistence, and covered ordinary-user denial plus administrator success. Independent final verification passed 3/3. The report stated that it observed a red test, but Phase 1's free-form runner does not retain structured red/green evidence; only the final state and command were independently corroborated.

### Q01 — real repository-connected review

After the implementation and controlled fixtures, `reviewer/typescript` reviewed the actual `pithos.guild` Phase 1 source, tests, resources, docs, metadata, catalog entry, evaluation, and plan. It was mechanically read-only and received explicit scope because it could not use Git shell inspection.

| Arm | Elapsed | Input | Output | Cache read | Final context | Report bytes | Cost | Outcome |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Phase 1 `reviewer/typescript` | 141,381 ms | 112,978 | 6,294 | 599,552 | 108,262 | 3,680 | $1.053486 | No code defect; 2 Medium process/evidence findings and 1 Low root-doc finding |

The review found that the durable completion record lacked the mandatory changed-file/verification/deviation/next-phase sections, that promotion evidence needed a real repository-connected task, and that the root README still described the legacy member model. The root description and this completion record were corrected. Q01 itself supplies a real repository-connected role/profile task, while the controlled A01/R01/E01/C01 runs retain deterministic oracles. This combination validates basic real use without claiming broad cross-stack coverage. The run also demonstrates that a fresh review can be useful but expensive even when its parent-facing report is only 3,680 bytes.

## Completion record

### Changed files and resources

- Repository catalog/docs: root `README.md`; `pithos.atlas/src/generated/catalog.json`; `pithos.atlas/test/extension.test.ts`.
- Guild package/docs: `pithos.guild/package.json`, `README.md`, and `NOTICE.md`.
- Canonical resources: new `pithos.guild/agents/roles/*.md` and `agents/profiles/*.md`; nine obsolete top-level combined member prompts removed.
- Runtime: `src/agents.ts`, `guild.ts`, `runner.ts`, `safety.ts`, `ui.ts`, `visibility.ts`, and new `run-queue.ts`.
- Tests: `test/agents.test.ts`, `code-review-standards-skill.test.ts`, `extension.test.ts`, `package.test.ts`, `runner.test.ts`, `safety.test.ts`, `ui.test.ts`, `visibility.test.ts`, and new `run-queue.test.ts`.
- Evaluation: this `evaluation/phase-1-foundation.md` artifact.

Unrelated pre-existing CQRS changes in shared Guild metadata/docs/catalog, the separate TDD test edit, and local/session artifacts were preserved and are not Phase 1 work.

### Verification matrix

| Check | Result |
|---|---|
| Guild clean install | `npm ci` passed; npm reported 3 existing audit findings (1 moderate, 2 high) in the locked dependency tree |
| Focused Guild core tests | 76/76 passed |
| Guild package suite | 131/132 passed; sole failure is unrelated pre-existing `pithos.plan/README.md` migration-text drift exercised by `test/tdd-skill.test.ts` |
| Guild TypeScript type-check | Passed |
| Guild package dry-run | Passed; only the ten nested role/profile resources replace the nine old combined prompts |
| Atlas package suite | 118/118 passed |
| Atlas TypeScript type-check | Passed |
| Atlas package dry-run | Passed |
| Root metadata suite | 2/2 passed |
| Pi 0.83.0 disposable Guild type-check/core tests | Passed; 76/76 |
| Pi 0.83.0 required CLI flags | Present |
| Final whitespace/error-marker check | Passed |
| Final narrow documentary re-review | Approve; no actionable findings |

### Deviations, blockers, and plan updates

- No Phase 1 runtime blocker remains. The package-wide red test is explicitly unrelated user work and was not altered.
- `npm ci` reported three dependency audit findings from the existing lockfile. Phase 1 changes no dependency versions, and no unaudited automatic `npm audit fix` was applied.
- A broad delegated implementation handoff initially failed at its provider endpoint before making changes; work continued in smaller independently verified slices.
- Package profiles intentionally accept all 24 role/profile pairs; no eligibility matrix was added without demonstrated need.
- To prevent a user/global layer leak, Phase 1 chooses explicit package prompts and disables ambient context. Automatic repository `AGENTS.md` injection is therefore absent and documented rather than reimplemented ad hoc.
- Reviewer shell removal is a deliberate mechanical boundary. Q01 and R01 confirm usefulness with supplied scope, while constrained Git/verification access remains a later hardening problem.
- No roadmap phase was added or reordered. Its lifecycle status now records Phase 1 completion and the mandatory stop before Phase 2. The observed free-form evidence limitation still supports evaluating Phase 2 next, subject to user approval.

### Phase 2 preview — not authorized by this record

Phase 2 would replace free-form process boundaries with small versioned TypeBox task/result envelopes and a trusted child `guild_submit_result` tool. It would reject missing, malformed, duplicate, mismatched, oversized, or prose-only completions while keeping truth/correctness claims dependent on tests and inspection. No Phase 2 schema, child extension, result tool, or preparatory test is included in Phase 1.

## Interpretation and residual risks

- These four single runs establish basic usefulness, not statistical superiority.
- Prompt decomposition preserved the sampled architecture/review rubrics and produced useful explorer/coder outcomes, but broader stack fixtures and repetitions remain necessary.
- Disabling ambient context means children do not automatically receive repository `AGENTS.md`; tasks must be self-contained or direct them to inspect relevant guidance.
- Reviewer is mechanically read-only and therefore cannot discover Git diffs or run checks without supplied scope. Constrained review verification remains deferred.
- Serialization is per Guild extension runtime, not cross-process locking or containment.
- Coder retains unrestricted shell and Phase 1 has no write scope, guard, lease, or audit.
- Task and result boundaries remain free-form, so schema, repair, bounded role payloads, and trustworthy evidence are deliberately unresolved until Phase 2.
- Raw model event records are not checked in; exact tasks, aggregates, rubrics, and final observable fixture outcomes are recorded here.

## Phase decision

The role/profile foundation satisfies the Phase 1 purpose independently: canonical identity is public and deterministic, old names migrate as package aliases, read-only roles are mechanical, child resources are explicit, admission is equivalent, and runs are serialized. Advancement to Phase 2 still requires user review and explicit confirmation; this document does not authorize protocol work.
