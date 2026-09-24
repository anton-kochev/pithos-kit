# E1 pre-spend foundation — implementation record

## Status

**Foundation implemented; E1 evaluation is not complete.** The user authorized E1 implementation after publishing the full Phase 0–9 roadmap. No paid benchmark trials, live provider calls, held-out promotion run, or Phase 2 implementation occurred in this increment. Nothing was staged, committed, versioned, or published.

**Subsequent decision:** the user approved the [E1 smoke campaign configuration and readiness work](e1-smoke-campaign.md), including scoped Codex authentication support and the 12-trial/$10 estimated-usage/60-minute limits. Readiness is still pending; approval is not evidence of execution or implementation.

**Subsequent implementation:** [child telemetry](e1-telemetry.md) is now implemented and offline-tested. That follow-up adds an opt-in production observer and evaluator integration; the delivered scope and test counts below describe the initial foundation increment only. Independent review and other live-readiness controls remain pending.

**Subsequent authentication work:** [access-only Codex borrowing](e1-authentication.md) is implemented and offline-tested. A synthetic real-SDK probe confirmed fresh-token resolution without network access and exposed a blocker: the selected Pi 0.83.0 catalog lacks the approved `gpt-6-astra` model. The runtime/model decision has not been changed.

**Subsequent campaign-control work:** the [persistent ledger foundation](e1-campaign-ledger.md) is offline-tested. The later [execution bridge](e1-execution-bridge.md) adds offline deadline/settlement integration. Verified native input/model/pricing observation and independent review remain required; no live execution was enabled.

The completed portion is a small, offline-tested evaluation foundation. [methodology.md](methodology.md) is the current evaluation contract; the complete original product phase sequence and mandatory stop gates remain unchanged.

## Delivered scope

- Strict versioned, content-addressed task/fixture validation, safe relative paths, bounds, and collision checks.
- Six explicitly **development-only** tasks: factual lookup, authorization fix, dirty-tree authorization fix, defective review, clean review, and missing-source blocker.
- Reproducible adjacent paired schedules for main-only versus natural Guild-available arms.
- Fresh Git index/worktree/untracked fixtures without creating commits or copying grader scripts into the worktree.
- File/mode/symlink-target snapshots, independent index preservation, binary diff, and final worktree retention.
- Hidden behavioral authorization checks calibrated against two valid implementations, original/near-miss defects and premature exit; qualitative review remains pending rather than inferred from automatic checks.
- Explicit-driver trial recorder with unique IDs, bounded partial stdout/stderr, failure/cancellation/timeout classifications, final-state capture on driver failure, and no automatic retry/reuse/rollback.
- Native POSIX Pi adapter using the real Guild entrypoint and natural main-agent routing. It is **tested with an inert fake CLI**, not a paid model. Offline help inspection confirms relevant flags in the local Atlas Pi 0.83.0 installation.
- Parent/child-reported usage separation, duplicate detection, missing-usage/null handling, and explicit incomplete-child-evidence flags.
- Offline CLI validation/scheduling; live execution is intentionally not exposed through the CLI.
- Historical Phase 0/1 report classification notes without changing recorded measurements.

## Changed files

New:

- `evaluation/src/{manifest,fixture,bank,grading,trace,runner,pi-driver,cli}.ts`
- `evaluation/test/{manifest,fixture,grading,trace,runner,pi-driver,cli}.test.ts`
- `evaluation/tasks/development.json`
- `evaluation/tsconfig.json`
- `evaluation/methodology.md`
- `evaluation/e1-foundation.md`

Targeted existing-file edits:

- `pithos.guild/package.json`: only three evaluation scripts added by E1.
- `evaluation/phase-0-baseline.md` and `phase-1-foundation.md`: classification notes only.

No production `pithos.guild/src/**`, role/profile prompt, skill, Atlas catalog, root README, release workflow, dependency version, or lockfile was changed by E1. Prior Phase 1, logging, CQRS, TDD/Plan and local work remain separate. A starting-tree digest comparison found no other source changes; an ephemeral `.pithos.d` clipboard artifact changed/disappeared during the session and was not restored.

## Verification

Observed on Node.js 24.20.0:

| Command/check | Result |
|---|---|
| Guild `npm ci` | Passed before implementation |
| `npm run eval:test` | 19/19 passed |
| `npm run eval:typecheck` | Passed |
| `npm run eval -- validate` | Six development manifests/digests valid |
| `npm run eval -- schedule e1-development-1 1` | 12 paired development slots; no execution |
| Guild `npm test` | 132/132 passed |
| Guild `npm run typecheck` | Passed |
| Guild `npm pack --dry-run --json` | Passed; 39 published files, no evaluation/private artifacts |
| Repository root `npm test` | 2/2 passed |
| `git diff --check` | Passed |
| Pi 0.83.0 offline `--help` | Confirmed CLI flags without loading a model |

The old Phase 1 TDD/Plan assertion failure is no longer present in the current pre-existing tree. E1 did not modify that test or Plan README to make it pass. Historical reports retain the outcomes observed at their original dates.

### Test-first evidence

The same `npm run eval:test` command was observed RED then GREEN for missing manifest, fixture, trace, grader, trial-runner, native-driver and CLI modules. Subsequent focused behavioral REDs included:

| Missing behavior | Observed RED | Correction verified GREEN |
|---|---|---|
| Strict manifest/digest/path rejection | Missing expected exception | Validate fields, digests, bounds and collisions before launch |
| Final state after thrown driver | Expected scope `true`, got `undefined` | Grade/capture state after driver settlement, including failure |
| Duplicate parent terminal usage | Expected 10 input tokens, got 20 | Detect duplicate finalized message rather than double count |
| Terminal completion discrimination | Expected incomplete, got complete | Require terminal `stop` independently of `agent_end` |
| Grader answers hidden during execution | Rubric present in request record | Write full task manifest only after execution settles |
| Candidate early `process.exit(0)` | Candidate falsely passed | Require random terminal checker marker after assertions |
| Special-name file capture | `__proto__` missing from own file keys | Null-prototype snapshot map |

Controlled pin evidence: temporarily omitted terminal POSIX group cleanup in E1-owned code (no live run); the offline descendant-writer test went RED with `Missing expected rejection` because its delayed marker appeared. Restoring cleanup returned the full suite to GREEN. No production safety hook was disabled.

## Review and remaining limitations

Implementation delegation and independent reviewer attempts both failed at installed Pi/Bun startup (`_CacheStorage`/`undici`, Bun 1.3.14 Linux arm64). They produced no code or review findings. **No independent approval is claimed.** Local inspection and deterministic verification are the available evidence.

Material remaining work before completing E1:

1. **Review and verify child telemetry.** The [follow-up observation path](e1-telemetry.md) now retains raw child transport and finalized usage, including partial evidence across failures. Production aggregates remain diagnostic and traces without raw child evidence still cannot certify accounting. The observation path needs independent review and verification against the selected real runtime; it does not recover unreported usage or infer test-claim truth. No Phase 2 schema was introduced.
2. **Live campaign controls and runtime verification.** The library adapter has an explicit acknowledgement, not a budget enforcer. CLI live execution stays disabled. Bind an approved bank/cohort/runtime and define admission stopping on unknown cost plus an honest in-flight overshoot policy. Real production-extension startup and provider integration remain untested. Guild's local Pi dependency is 0.82.1; the available Atlas 0.83.0 runtime now also has a synthetic SDK auth-resolution probe, but its catalog lacks the approved model. Resolve that mismatch with renewed approval before live execution.
3. **Independent task bank.** The six small JS-dominant cases are development smoke fixtures. Obtain an independently selected held-out set (including architecture and relevant non-JS stacks) for promotion. Do not relabel these cases held-out.
4. **Qualitative grading and reports.** Automatic gates leave `review: pending`/`taskSuccess: null`. Blinded review, per-task paired outcome/uncertainty reporting, and any model-judge calibration remain to be performed on actual trials. There are no model benchmark results to summarize yet.
5. **Approved budget, pending admission controls.** The smoke model, task/arm count, runtime/context policy, estimated-usage/time limits, and raw-data policy are now recorded in [the campaign decision](e1-smoke-campaign.md). Implement and verify those controls before provider calls; changed inputs require renewed approval.

Copies/process groups are cooperative test isolation, not hostile-code containment. Fixtures have an unborn Git HEAD and cannot evaluate historical change provenance. The authorization checker resists ordinary early-exit mistakes but shares a JS runtime with imported candidate code; it is not a tamper-proof oracle. Subscription OAuth/custom-provider setup and Windows process cleanup were not supported by this initial adapter. The later [Codex borrowing increment](e1-authentication.md) adds scoped access-only support; broader provider setup and Windows cleanup remain unsupported.

## Next checkpoint

Continue within E1 on the pre-spend blockers, then verify the frozen inputs against the approved smoke configuration. The approved development shape is six tasks × two natural arms × one repetition (12 trials), with inspection of the first pair before continuing. It is a debugging exercise, not promotion evidence. A later held-out campaign requires separate approval; after that evaluation, stop again and decide whether Phase 2 should proceed, shrink, or wait.
