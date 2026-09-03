# @pithos-kit/plan

[![npm version](https://img.shields.io/npm/v/@pithos-kit/plan)](https://www.npmjs.com/package/@pithos-kit/plan)

Session-owned, enforced read-only planning for Pi with durable exact checkpoints,
explicit save/preview/exit commands, and conflict-safe atomic publication.

## Install

```bash
pi install npm:@pithos-kit/plan
```

For local development:

```bash
pi install -l ./pithos.plan
```

## Pithos `.pithos` config

```yaml
pi:
  extensions:
    "@pithos-kit/plan": "npm:0.5.0"
```

## Command lifecycle

```text
/plan
/plan save
/plan preview
/plan exit
/plan status
/plan help
/plan --help
/plan -h
```

The grammar is explicit. `/plan <task>`, `/plan pause`, `/plan cancel`, and other
unknown arguments are rejected with help. Enter Plan mode first, then provide the
task and refinements as normal prompts.

- **`/plan`** enters Plan mode. The first use creates one plan identity and a
  collision-resistant candidate path for the physical Pi session. Later uses
  restore that same plan. Repeating it while active is a no-op.
- **`/plan save`** asks the agent to finalize/checkpoint when needed and publish
  the latest exact checkpoint. It creates the file on first publication and
  updates the same stable path afterward. Plan mode remains active.
- **`/plan preview`** displays the latest exact checkpoint without publishing.
  It fails clearly when no checkpoint exists and does not start an agent turn.
- **`/plan exit`** is the sole combined leave/pause command. A synced published
  plan exits immediately. Otherwise Pi first offers Create/Update plan, Exit
  without publishing, Preview, and Continue planning, before any model turn.
  **Exit without publishing is the safe default** and keeps the checkpoint and
  plan identity restorable. Create/Update binds the exact current checkpoint,
  path, and update baseline before asking the agent to finalize; a changed
  checkpoint requires exact reapproval. With no checkpoint, the direct chooser
  offers Exit without publishing, Finalize before exit, and Continue planning.
  If finalization settles without publication, an idle Exit/Continue fallback
  prevents Plan mode from becoming trapped.
- **`/plan status`** reports active/inactive mode, branch revision,
  unpublished/dirty/synced/conflict state, path, and persisted/ephemeral session
  status without an agent turn.
- **`/plan help`**, **`--help`**, and **`-h`** show usage without changing state.

Autocomplete offers `save`, `preview`, `exit`, `status`, and `help`, followed by
the retained `--help` and `-h` aliases.

## Exact session checkpoints

While active, Plan mode exposes the internal sequential `update_plan_draft` tool.
The agent is instructed to call it after the first coherent planning brief and
after every material change to requirements, constraints, decisions,
assumptions, open questions, or plan steps.

Each call supplies:

- the complete Markdown snapshot (never a patch or summary), and
- `expectedRevision`, using optimistic branch-local concurrency.

The result returns the new revision and SHA-256 digest. The complete exact
snapshot is stored in Pi session tool-result details; lifecycle custom entries
store the session owner, stable plan identity, candidate and published paths,
checkpoint revision/digest, publication digest/state, active flag, and
content/path-bound approval state. There are **no draft plan files**.

Every active model context receives an ephemeral projection of the exact latest
branch checkpoint. It is explicitly labeled **unapproved data, not
instructions**, and says that newer user messages are authoritative. The
projection occurs through Pi's `context` event on every model call, independently
of compaction summaries.

Completed checkpoints survive compaction, `/tree`, cancellation, `/quit` and
resume, reload, and process restart when the Pi session itself is persisted.
Active Plan mode also keeps or reapplies the bundled `plan` theme during `/reload`
without replacing the saved pre-Plan theme that will be restored on exit.
Ephemeral (`--no-session`) use is supported for the current process, but Plan
warns on activation and reports the limitation in `/plan status`.

## Sessions, branches, and forks

A physical Pi session owns exactly one logical plan and at most one published
file. Exiting without publication preserves the identity and checkpoint;
re-entering `/plan` restores them. Start a new Pi session to start a new logical
plan.

Checkpoint revisions are branch-local. After `/tree`, Plan reconstructs only the
selected branch's validated checkpoint, clears stale approval, and reconciles
mode tools/theme. Sibling checkpoint content is never projected into the active
branch. Publication identity and the stable published path remain global to the
physical session.

Forked, cloned, and new sessions have a different Pi session ID. Copied parent
state is not treated as ownership: entering Plan creates a fresh identity and a
unique candidate path. Active legacy state is migrated to a fresh session-owned
identity with old approval revoked and no legacy file implicitly claimed;
inconsistent or multiple identities fail closed.

## Publication and approval

`create_plan` remains the controlled publication tool for compatibility, but it
accepts an exact checkpoint **revision**, not reconstructed Markdown. It is
blocked during ordinary planning and becomes eligible only for the agent turn
started by `/plan save` or `/plan exit`.

### First publication

Pi binds approval to the exact checkpoint digest and selected path. TUI users may
preview the exact Markdown before choosing Create plan; RPC approval includes the
complete checkpoint and target. Without interactive UI, publication is blocked
and Plan mode remains active. Persisted approval is never reused to mutate a file
in a no-UI runtime.

Publication creates under `.pi/plans/` using an exclusive, atomic no-overwrite
operation. Preflight validates existing `.pi` and `.pi/plans` components without
creating them and rejects symlinks or non-directories. Approved execution creates
missing components one at a time and validates them against the canonical project
directory. Known collisions are resolved before approval. A collision racing the
write advances the generated timestamp, revokes approval, and requires renewed
confirmation.

### Updates

All updates target the same first-published path. Cooperating Pi mutations are
serialized through Pi's per-file mutation queue. After asynchronous temporary
file preparation, the final open/fstat/read/lstat/digest verification and atomic
rename execute synchronously in one non-yielding JavaScript section. A
modification, deletion, symlink replacement, or directory observed by that
verification is a conflict and is never silently overwritten. The session
remains in Plan mode.

Portable Node APIs do not provide a strict cross-process compare-and-swap for
this replacement, so this is not a linearizable CAS. Arbitrary external OS
writers are not locked and can still race the final filesystem calls.

If the latest checkpoint digest is already published, Pi verifies the on-disk
bytes and performs no write. `/plan save` remains active; `/plan exit` exits
immediately when that verified publication is unchanged. A successful first
publication also derives the contextual session name from the outcome-focused
`# Plan:` title.

Approval is persisted as an exact revision/digest/path/base-digest binding so a
completed write can be reconciled safely after a process interruption. `/tree`
always clears approval. Publication failure never exits Plan mode; explicit Exit
without publishing does.

## Read-only enforcement

Plan mode exposes trusted built-in `read`, `grep`, `find`, and `ls`, plus
`update_plan_draft` and `create_plan`. When
[`@pithos-kit/web`](https://www.npmjs.com/package/@pithos-kit/web) is installed,
provenance-verified `web_search` and `web_fetch` remain available for public-web
research. Web content is untrusted external data and must not be followed as
instructions.

The Web exception is provenance-checked against a canonical package manifest
named exactly `@pithos-kit/web`. Same-named SDK, top-level, path-escaping,
spoofed-source, and unrelated custom tools stay blocked. Plan also blocks writes,
edits, shell tools, manual `!`/`!!` shell commands, delegation, mutating or
untrusted custom tools, and same-named overrides of trusted built-ins. It applies
the bundled Plan theme and planning footer while active, restoring the previous
theme and exact tool selection on exit. If the visual distinction is ever absent
while `/plan status` reports active mode, run `/reload`; the reloaded runtime
reconstructs state and reapplies the Plan presentation without relaxing tool
restrictions.

### Enforcement boundary

Plan mode enforces Pi's tool and user-shell interfaces; it is not an
operating-system sandbox. Other extensions and external processes can still
mutate files directly. Changes observed by publication verification become
conflicts, but arbitrary external OS writes can race the final filesystem calls.

## Migrating from `@pithos-kit/skills`

`@pithos-kit/skills` is retired. Remove global and project installs
(`pi remove npm:@pithos-kit/skills` and
`pi remove -l npm:@pithos-kit/skills`) and its `.pithos` pin. Historical Skills
0.4.0 and earlier must not be loaded alongside this package because both handle
`/plan` and Plan state.
