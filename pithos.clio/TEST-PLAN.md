# Test plan (0.9.1)

Behaviors and where they are covered. Run with `npm test`. On a host without the container's `node_modules` you can also use `node --experimental-strip-types --test test/*.test.ts`.

| Behavior | Test file |
|---|---|
| Strict config with defaults (including `maxCostUsd` and `readOnlyDocs`); the classifier block; fail-closed on unknown fields | `config.test.ts` |
| Classifier: unavailable reasons; provider error, throw, malformed answer and hang each counted with a short redacted reason; probe ok/failed | `classify.test.ts` |
| First run only places the cursor; new commits form the range; Clio commits and reverts skipped; rewritten history resets; range cap; detached HEAD ignored | `cursor.test.ts` |
| One window per user turn (failure + proposal + reply); no thinking; Clio noise and harness blocks stripped; the since-filter; classifier keep/drop; failed calls drop; recent fallback | `collect.test.ts` |
| Edits only to docs read in full, exact unique `oldText`; citations must be from this run; junk kinds invalid; new-page rules; no credentials; schema kinds equal the useful gate kinds; read-only records (ADRs) never edited or added to | `proposal.test.ts` |
| Docs map: nearby READMEs, editable pages, read-only records listed as context, read-only directories never offered for new pages; glob rules | `digest.test.ts` |
| Commits only Clio's paths with the trailer and keeps the user's staging; dirty files deferred; HEAD moved means nothing is written; failed commit rolls back; gate commit / inbox / drop | `commit.test.ts` |
| Worker read-then-propose; a huge reasoning block does not abort (old bug); cost counted with extra keys (old bug); one repair turn with its reasons recorded; still-invalid reported with the final rejection; turn-limit refusal; deadline nudge at 70%; cost nudge, final answer kept past the hard line, a reader stopped at 1.5×; per-request log without contents; unsafe reads refused; cancellation | `worker.test.ts` |
| End to end: a broken classifier credential is reported loudly, the worker still runs and changes go to the inbox; a few failed calls turn a quiet "nothing" into a visible report; decision → `docs(clio)` commit and cursor past it; nothing kept means the worker never runs; no classifier means inbox; autoCommit off; narration dropped; a failed worker advances the cursor with a retry hint; progress steps in order; a run record without contents; a cost-limited run points at its record and a cheaper worker | `pipeline.test.ts` |
| Connected Pi: a settle with a new commit triggers a background run with no main-model scheduling turn; Plan and child sessions stay quiet; `/clio --help` and `/clio status` (limits, session-model warning); progress line format | `extension.test.ts` |

Not covered: real-provider proposal quality, classifier accuracy beyond the two-session spike, Windows, and git hooks other than a failing `pre-commit`.
