# guild

A standalone bounded Guild with stable exploration, architecture, implementation, and review roles; reusable general, front-end, Angular, TypeScript, .NET, and Rust profiles; and repository-aware Clean Architecture, code-review, Conventional Commit, and test-driven development guidance for [pi](https://github.com/earendil-works/pi-mono).

The extension adds agent-callable `guild_handover` and controlled `create_commit` tools, plus interactive `/guild-handover` and `/commit` commands. Every handover names a canonical `role/profile`, starts an isolated ephemeral pi process with package-controlled prompts and a role-owned hard tool allowlist, and inherits the parent session's active provider, model, thinking level, working directory, and project-trust decision.

## Install

Requires Pi **0.87.0 or newer**. The initial provider-free compatibility target is exactly 0.87.0; future releases are not automatically certified.

```bash
pi install npm:@pithos-kit/guild
```

For local development from this repository:

```bash
pi install ./pithos.guild
pi install ./pithos.guild -l   # project-local
```

Temporary test run:

```bash
pi -e ./pithos.guild
```

## Pithos `.pithos` config

```yaml
pi:
  extensions:
    "@pithos-kit/guild": "npm:0.3.0"
```

## Roles and profiles

Roles own responsibility and the repository tool ceiling. Every child additionally receives only `guild_submit_result`, a child-only reporting tool with no repository or delegation capability:

| Role | Responsibility | Tools |
|---|---|---|
| `explorer` | Inspect repository structure, behavior, versions, conventions, dependencies, and relevant paths | `read`, `grep`, `find`, `ls` |
| `architect` | Compare designs and define contracts, invariants, test strategy, and an implementation handoff | `read`, `grep`, `find`, `ls` |
| `coder` | Implement one coherent scope, own relevant tests, and verify it | `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash` |
| `reviewer` | Independently inspect a focused change and return severity-ranked evidence and a verdict | `read`, `grep`, `find`, `ls` |

Profiles select package-owned technical guidance and never add tools:

| Profile | Focus |
|---|---|
| `general` | Technology-neutral software engineering |
| `frontend` | Browser UI, components, state, rendering, accessibility, and performance |
| `angular` | Angular applications, templates, reactivity, forms, and tests |
| `typescript` | TypeScript, JavaScript, Node.js, modules, runtime boundaries, and async behavior |
| `dotnet` | .NET, C#, projects, persistence, dependency injection, async behavior, and tests |
| `rust` | Rust, Cargo, ownership, errors, concurrency, unsafe boundaries, and tests |

All 24 role/profile pairs are valid. Only `coder` can edit, write, or invoke shell commands; explorer, architect, and reviewer are mechanically read-only. `researcher` is intentionally unavailable until Guild has controlled read-only web tools.

## Code-review standards skill

Guild owns the language-neutral `code-review-standards` skill for focused, evidence-based reviews with impact-calibrated severity and deterministic Request changes, Comment, or Approve decisions. When Guild is installed and this resource is enabled, Pi-native discovery lets the main agent load it proactively without requiring explicit invocation. Guild children deliberately start with general skill discovery disabled; exact child skill selection arrives in a later phase. The skill can also be loaded directly in the parent session when desired:

```text
/skill:code-review-standards [review scope]
```

The methodology honors explicit commits and ranges or inspects staged, unstaged, and relevant untracked changes; detects supported languages, frameworks, and runtimes from repository evidence; and complements the canonical `reviewer` role's findings-first report. It never treats an inspected scope as proof of perfect code or claims verification that was not run.

Use `pi config` or `pi config -l` to disable this resource, then run `/reload`. The canonical `reviewer` role remains self-contained without the skill: its package role prompt retains a hard read-only boundary, findings-first evidence, and a deterministic verdict.

## Test-driven development skill

Guild owns the language-agnostic `tdd` skill used for explicit or proactive test-driven development. Load it directly with optional task context:

```text
/skill:tdd [task context]
```

The skill drives behavioral changes through a test list and small red-green-refactor cycles while allowing pragmatic exceptions for spikes, trivial declarations, generated output, and other work that does not benefit from test-first ceremony. Pi exposes the skill to the main agent through native discovery; Guild children do not receive ambient skills in Phase 2.

Use `pi config` for global settings or `pi config -l` for a project override to toggle Guild's `tdd` resource, then run `/reload` in an active session. The `enableSkillCommands` setting controls native `/skill:tdd` registration and autocomplete; disabling the resource also removes its model-visible description after reload.

TDD previously shipped with the retired `@pithos-kit/skills` package and then Atlas. Remove the retired package at every scope.

## .NET Clean Architecture skill

Guild's `dotnet-clean-architecture` skill helps inspect and evolve repository-connected .NET boundaries without assuming a target framework, language version, package, mediator, ORM, or four-project template. Load it directly with optional task context:

```text
/skill:dotnet-clean-architecture [task context]
```

The skill first verifies substantive .NET relevance and detects solution, project, framework, language, package, persistence, hosting, test, and deployment capabilities. It then selects the smallest justified clean, layered, vertical-slice, or hybrid structure; preserves healthy existing boundaries; and makes dependency direction, domain invariants, consistency, security, migration, and verification explicit. Its examples are conditional guidance rather than migration authority, and architect and coder tool boundaries continue to apply.

Conventional Commit support also moved from Atlas to Guild. Guild 0.3.0 must be paired with Atlas 0.6.0 so exactly one active package owns `/commit`, `create_commit`, and the `conventional-commit` skill. Do not load Guild 0.3.0 beside an older Atlas release that still registers them.

## Confirmed commits

```text
/commit [instructions]
/commit --help
/skill:conventional-commit [instructions]
/skill:conventional-commit --help
```

`/commit` uses existing staged changes when present. Otherwise it narrows the staging set from explicit instructions, named paths or packages, and the active task context. Ambiguous scopes require confirmation before staging, and unrelated untracked, generated, editor, session, and local-configuration files are excluded unless explicitly requested.

The controlled `create_commit` tool shows the final message and staged file set for mandatory interactive confirmation. Declining leaves the index intact, missing UI fails closed, and a changed staged snapshot invalidates approval. Guild blocks direct model-issued `git commit` shell commands so the workflow cannot bypass the dialog; normal Git hooks still run. `/commit` is unavailable while `@pithos-kit/plan` Plan mode is active or indeterminate.

## Usage

Ask the main agent to choose a role and profile for one self-contained task:

```text
Use explorer/typescript to locate the package and runtime contracts involved.
Use architect/dotnet to design the order cancellation workflow.
Use architect/frontend to define state ownership for checkout.
Use coder/angular to add checkout loading and error states.
Use coder/rust to resolve the parser ownership defect.
Use reviewer/general to review the focused change for merge-blocking defects.
```

The main agent invokes the canonical API:

```text
guild_handover({ role: "coder", profile: "typescript", task: "...scope and acceptance criteria..." })
```

Delegate directly from the interactive TUI:

```text
/guild-handover
/guild-handover architect/typescript
/guild-handover coder/typescript Implement validation and run the tests
/guild-handover typescript-coder Implement validation and run the tests
/guild-handover --help
```

With no target, the command opens a role picker followed by a profile picker. With no task, it opens a multiline task editor. The command waits for the main agent to become idle and applies the same Plan-mode gate, inherited trust decision, queue, tools, and child runner as the agent tool. Direct execution is intentionally TUI-only.

List the fixed package roles, profiles, permissions, and aliases without launching a child:

```text
/guild
/guild --help
```

Both commands also accept `-h`; help returns before idle waits, UI prompts, admission checks, or child execution. Task input remains free-form. New child completions must use the exact result protocol below; prose alone is never a successful completion.

## Live transparency

Accepted handovers are serialized through one process-local FIFO queue. The compact dashboard distinguishes queued and running work without exposing task text, model settings, or tools:

```text
Guild · 2 active
 ○ reviewer/general · queued · 0s
 ● coder/typescript · running · 5s · 2 turns
```

Agent-invoked handovers use that aggregate dashboard. A direct `/guild-handover` uses a width-capped cancellable card with canonical identity, package source, permission level, queue state, elapsed time, turns, and real child-tool activity. Completed reports render as Markdown; failures receive diagnostics; cancellations use a compact terminal treatment.

Each direct handover records one hidden user-initiated `started` event and exactly one correlated `completed`, `failed`, or `cancelled` event with `triggerTurn: false`. Reports and diagnostics are delimited as task data rather than instructions. Picker/editor cancellation creates no lifecycle event. When the final run stops, the dashboard widget, footer status, timers, and tracked state clear.

Serialization covers all Guild handovers within one extension runtime. Cancellation of queued work never launches a child; cancellation of active work holds the queue until the child process terminates and cleanup finishes. Separate Pi processes and external tools remain outside this guarantee. Guild remains independent of Pi's native specialist facility and does not observe its lifecycle or messages.

## Package aliases and configuration migration

Canonical calls use `role/profile`. The old names remain package-owned compatibility aliases:

```text
dotnet-architect → architect/dotnet
frontend-architect → architect/frontend
typescript-architect → architect/typescript
rust-architect → architect/rust
csharp-coder → coder/dotnet
angular-coder → coder/angular
typescript-coder → coder/typescript
rust-coder → coder/rust
code-reviewer → reviewer/general
```

Aliases cannot change prompts, profiles, or role tool ceilings, and no sunset is promised. Direct commands accept aliases visibly; resumed old `{ member, task }` tool calls are normalized before the strict canonical schema is validated.

Guild no longer reads `~/.pi/agent/agents` or `.pi/agents` and has no user/global configuration layer. The migration does not delete those directories or their files, and arbitrary prompt overrides are not converted. Repository guidance may remain in `AGENTS.md`, but Guild children do not inherit ambient context files; delegated tasks must be self-contained or explicitly ask the child to inspect relevant repository guidance. Trusted constrained repository profiles and skills arrive only in later phases.

## Isolation and resources

Each Guild target runs with:

- an isolated context window and no saved child session;
- the parent's current provider/model, thinking level, working directory, and trust decision;
- an explicit package-controlled base system prompt plus exactly one role prompt and one profile prompt;
- the exact role-owned repository tool allowlist plus `guild_submit_result`;
- `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--no-context-files`, with one explicit absolute local `--extension` pointing to package-owned `src/child-protocol.ts`;
- no recursive Guild delegation and no user/project member, system-prompt, append-prompt, skill, extension, template, or context-file discovery.

The tool and direct command both fail closed while Plan mode is active or indeterminate. The inherited trust decision controls `--approve` versus `--no-approve`; it does not expand role tools. Only coder has shell access, so this remains guardrail-oriented delegation rather than a filesystem sandbox. Task input stays free-form; completion is structured.

Cancellation terminates the child process and waits for shutdown and owned cleanup before releasing the serialized queue. Rendering retains up to 50 KiB of UTF-8 report text plus a truncation notice; accepted structured reports remain in tool-result or lifecycle-message details. Transport and diagnostics are separately bounded, not retained without limit.

## Exact completion protocol

One host builder binds `guild/2` version 1 to a run ID, unique task ID, canonical role/profile, and original task text. It does not infer scope, acceptance criteria, or write leases from prose. The same runner and host-owned `completed`, `failed`, or `cancelled` outcome serve agent tools, direct commands, and editor input. Legacy persisted prose reports remain displayable, but cannot complete a new handover.

Children must submit `guild_submit_result` **alone in its tool batch**, once. Common exact fields are `protocol`, `version`, `runId`, `taskId`, `role`, `profile`, `summary`, `blockers`, `limitations`, and `payload`. Role payloads are:

- explorer: referenced `observations` and `unknowns`;
- architect: `decisions`, `contracts`, and `handoff`;
- coder: reported `changes` and `verification` commands/outcomes;
- reviewer: `scope`, severity-ranked `findings`, and `verdict`.

Empty findings and unperformed checks are legitimate when reported honestly. Each string is at most 2048 UTF-8 bytes, each list at most 32 items, and the serialized result at most 48 KiB. Oversized or extra-key results are rejected, never truncated into apparent completion. Parent ingestion permits at most 1 MiB per JSON line, 16 MiB total stdout, and 64 KiB stderr. Exceeding transport bounds fails the run, including unusually large ordinary tool events.

A malformed submission or prose-only completion gets **one shared corrective opportunity in the same child**. The next assistant response must submit the result alone; there is no respawn, queue re-entry, or reset on continued agent runs. Identity mismatch, mixed batches, duplicates, post-submission work, exhausted repair, missing handshake/settlement, process/provider errors, and cleanup failures fail closed. Cancellation and failure override a previously valid submission. Mixed-batch rejection is not a claim that sibling work never happened or was rolled back.

Reports, commands, changes, references, and judgments are **child-reported claims**, not authenticated or host-certified truth. These guardrails are not a filesystem sandbox. Tool failures carry structured terminal details and are marked as errors through Pi's `tool_result` hook. Known usage is retained on failures/cancellation: `usageFields` identifies fields actually observed, totals may be partial, and `usageKnown: false` means the numeric compatibility placeholders must not be read as measured zero usage.


## Development

```bash
cd pithos.guild
npm install
npm test
npm run typecheck
npm pack --dry-run
```

## Provenance

The concise role/profile resources retain adapted guidance from the MIT-licensed [Grimoire](https://github.com/anton-kochev/grimoire) project and repository-native TypeScript/Pi guidance. See [`NOTICE.md`](./NOTICE.md).
