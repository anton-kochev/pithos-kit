# Clio

Clio keeps your docs in step with your commits. Requires **Pi 1.0.3 or later** and Node.js **22.19.0 or later**. Package version: **0.0.6**.

After the agent finishes a run and the branch has new commits, Clio works in the background:

1. **Collects** what was learned. A classifier reads the session turn by turn and keeps only decisions, reasons, gotchas, constraints and dead ends. Progress reports and chatter are skipped. If nothing qualifies, Clio stops here.
2. **Drafts** doc updates. A worker model reads the commits, the diff, the kept session excerpts and the nearby docs, and proposes small edits to `README.md` files or Markdown under `docs/`.
3. **Grades** each proposed change with the classifier. Useful, durable changes are committed. Weak ones go to the inbox. Test narration, code restatement, status reports, bug reports and speculation are dropped.
4. **Commits** the good changes as their own `docs(clio): …` commit, once the agent is idle. That commit holds only Clio's files, carries a `Clio-Capture:` trailer, and is easy to read in `git log` and to revert.

Clio never pushes, amends, or commits anything but its own doc files. Your staged work stays staged.

## Install

```bash
pi install -l npm:@pithos-kit/clio
```

From a checkout: `pi install -l ./pithos.clio`, or `pi -e ./pithos.clio` for one run. With Pithos, add it to `.pithos`:

```yaml
pi:
  extensions:
    "@pithos-kit/clio": "npm:0.0.6"
```

## Commands

Run `/clio --help` for the same list.

| Command | What it does |
|---|---|
| `/clio` | Capture new commits now instead of waiting for the next settle. |
| `/clio --since <rev>` | Capture `<rev>..HEAD`, for example to retry a failed run or to cover commits from before Clio was installed. |
| `/clio review` | Go through the inbox: commit, drop or skip each waiting change. |
| `/clio undo [--yes]` | Revert Clio's most recent docs commit. |
| `/clio status` | Show the branch cursor, classifier health, inbox and last run. |
| `/clio status --probe` | Also make one tiny classifier call (about $0.0001) to test the model and its credentials right now. |

## How it keeps track

- **Cursor.** Each branch has a local ref, `refs/clio/cursor/<branch>`: the last commit Clio processed. It is shared by every Pi session and worktree of the repo and is never pushed unless you push it on purpose.
- **First run.** On a branch it hasn't seen, Clio only places the cursor at HEAD. It never backfills old history; use `/clio --since <rev>` for that.
- **Rebases.** If the cursor is no longer an ancestor of HEAD (rebase, reset), Clio moves it to HEAD without capturing.
- **Its own commits.** Clio commits and reverts of them are never documented again.
- **Session scope.** Only the current session's branch is read, from the time of the cursor commit. Commits made in other sessions are documented from the diff alone.
- **Inbox.** Changes waiting for review live in `.git/clio/inbox/`. They wait there when no classifier is configured, when the classifier is unsure, when the file has uncommitted changes, or when the branch moved under Clio.
- **No automatic runs** in untrusted projects, child sessions, or while Plan is active. `/clio` works there when you run it yourself.

## Configuration

Optional project-local `.pi/clio.json`. Every field is optional; unknown or malformed fields stop Clio with a clear error.

```json
{
  "model": "anthropic/claude-sonnet-4-6",
  "thinking": "medium",
  "docsDirs": ["handbook"],
  "autoCommit": true,
  "classifier": {
    "model": "openai/gpt-6-luna",
    "collectThreshold": 1.0,
    "gateThreshold": 1.0,
    "maxWindows": 8,
    "timeoutMs": 30000
  },
  "timeoutMs": 300000,
  "maxTurns": 16,
  "maxContextTokens": 64000,
  "maxEdits": 6,
  "maxCommits": 20
}
```

- `model` / `thinking`: the worker. They default to the session's model and thinking level.
- `docsDirs`: extra directories, besides any `docs/`, where Markdown counts as docs.
- `autoCommit`: set to `false` to send every change to the inbox.
- `classifier`: a registered classifier model, used through Pi's classification API.
  - Without one, nothing is committed automatically: every change goes to the inbox.
  - Scores run from 0 to 3.
  - `collectThreshold` is the minimum for a session excerpt to reach the worker.
  - `gateThreshold` is the minimum for an edit to be committed without review.
  - For `openai/...` classifiers, Pi needs API-key authentication, not a ChatGPT login. See Translate's README, section "OpenAI Decisions setup".
- `maxContextTokens`: the worker's context budget. It defaults to the smaller of 64k and half the model's context window. Reasoning is not counted.
- `maxCommits`: the most commits one run covers; larger ranges keep the newest.

## When the classifier is not working

Clio never treats a broken classifier as "nothing worth documenting".

- **Not usable at all.** No `classifier` in the config, no classification API in this Pi, or the model isn't registered. Every run report and `/clio status` say so: `unjudged (<reason>)`.
- **Calls failing.** A bad credential, a timeout, a rate limit or a provider error. Each run report gets a line like `Classifier openai/gpt-6-luna: 23 of 23 classifier calls failed (last: error: 401 no_matching_rule)`.
- **Most calls failing in one run.** The classifier counts as down for that run. Clio uses the recent session excerpts unjudged, the worker still runs, nothing is auto-committed, and every change goes to the inbox.
- **Checking it.** `/clio status` shows how the classifier did in the last run of this session. `/clio status --probe` tests it right away.

For `openai/...` classifiers, a `401` usually means Pi is using a ChatGPT login instead of an API key. See Translate's README, section "OpenAI Decisions setup".

## What gets sent where

- **The classifier provider** receives the session's user and assistant text, turn by turn. Credential-looking lines are redacted, and tool output stays out except a short excerpt of failed calls. It also receives each proposed doc change.
- **The worker model** receives the commits, the diff (lockfiles, build output and binaries excluded), the kept excerpts, and any project files it chooses to read.
- **Never read:** hidden paths, dependencies, build output, `AGENTS.md`/`CLAUDE.md`-style instruction files, and secret-looking files.

Redaction is a heuristic, not a guarantee.

## Development

```bash
npm ci
npm test
npm run typecheck
npm pack --dry-run
```

Tests use Pi's faux provider and real temporary git repositories; no paid model calls. They cover:
- the cursor and range rules;
- session windows and the classifier filter;
- proposal validation;
- commit, inbox and rollback behavior;
- the worker loop, including regressions for the old reasoning-size abort and cost tracking;
- the full pipeline;
- a connected Pi session.

The classifier thresholds were tuned on two real sessions only. Expect to adjust them.
