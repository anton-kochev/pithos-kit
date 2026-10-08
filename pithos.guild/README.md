# guild

A standalone bounded Guild with stable exploration, architecture, implementation, and review roles; reusable general, front-end, Angular, TypeScript, .NET, and Rust profiles; and repository-aware Clean Architecture, CQRS, code-review, Conventional Commit, and test-driven development guidance for [pi](https://github.com/earendil-works/pi-mono).

The extension adds agent-callable `guild_handover` and controlled `create_commit` tools, plus interactive `/guild-handover` and `/commit` commands. Every handover names a canonical `role/profile`, starts an isolated ephemeral pi process with package-controlled prompts and a role-owned hard tool allowlist, and inherits the parent session's active provider, model, thinking level, working directory, and project-trust decision.

## At a glance

Guild hands **one focused task** to an isolated child: choose a role for its permissions and a profile for its technical guidance. Explorer and architect investigate or plan, coder can edit and run tests, and reviewer inspects changes without writing. Guild queues handovers, returns a bounded structured report, and leaves verification and final decisions to the main agent. It does not run an automatic multi-agent pipeline or prove a child's claims.

For example, in Pi's interactive TUI:

```text
/guild-handover explorer/typescript Find where user input is validated and cite relevant files.
```

Or ask the main agent, “Use explorer/typescript to find the validation path and report the evidence.” The child can inspect but not edit; for an implementation, delegate a separate coder task with scope and acceptance criteria. See [Usage](#usage) for coder, reviewer, and required-TDD examples.

## Install

Requires Pi **1.0.0 or newer**. The provider-free development test harness remains pinned to 0.99.0; passing that harness does not certify Pi 1.x or real-provider behavior.

Install the current release:

```bash
pi install npm:@pithos-kit/guild@0.6.0
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
    "@pithos-kit/guild": "npm:0.6.0"
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

Guild owns the language-neutral `code-review-standards` skill for focused, evidence-based reviews with impact-calibrated severity and deterministic Request changes, Comment, or Approve decisions. When Guild is installed and this resource is enabled, Pi-native discovery lets the main agent load it proactively without requiring explicit invocation. Guild children start with general skill discovery disabled. Every reviewer child receives the fixed package-owned review core in its prompt, independent of profile or parent discovery toggle; this does not add tools or grant shell access. The skill can also be loaded directly in the parent session when desired:

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

The skill drives behavioral changes through a test list and small red-green-refactor cycles while allowing pragmatic exceptions for spikes, trivial declarations, generated output, and other work that does not benefit from test-first ceremony. Pi exposes the skill to the main agent through native discovery; Guild children do not receive ambient skills. A coder child receives the fixed package-owned TDD core only when the caller explicitly requests required TDD, independent of parent discovery toggles.

Use `pi config` for global settings or `pi config -l` for a project override to toggle Guild's `tdd` resource, then run `/reload` in an active session. The `enableSkillCommands` setting controls native `/skill:tdd` registration and autocomplete; disabling the resource also removes its model-visible description after reload.

TDD previously shipped with the retired `@pithos-kit/skills` package and then Atlas. Remove the retired package at every scope.

## .NET Clean Architecture skill

Guild's `dotnet-clean-architecture` skill helps inspect and evolve repository-connected .NET boundaries without assuming a target framework, language version, package, mediator, ORM, or four-project template. Load it directly with optional task context:

```text
/skill:dotnet-clean-architecture [task context]
```

The skill first verifies substantive .NET relevance and detects solution, project, framework, language, package, persistence, hosting, test, and deployment capabilities. It then selects the smallest justified clean, layered, vertical-slice, or hybrid structure; preserves healthy existing boundaries; and makes dependency direction, domain invariants, consistency, security, migration, and verification explicit. Its examples are conditional guidance rather than migration authority, and architect and coder tool boundaries continue to apply.

## .NET CQRS skill

Guild's `dotnet-cqrs` skill complements the Clean Architecture baseline with focused guidance for deciding whether CQRS earns its cost and for designing command/query contracts, read models, projections, asynchronous consistency, and optional event sourcing. Load it directly with optional task context:

```text
/skill:dotnet-cqrs [task context]
```

The skill verifies substantive repository-connected .NET relevance and inspects the actual framework, language, provider, package, messaging, deployment, test, and operational capabilities before recommending a shape. It treats direct CRUD, in-process command/query paths, separate read shapes, asynchronous read stores, and event sourcing as bounded-context options rather than a maturity contest. Authorization and tenancy, transaction boundaries, outbox/inbox and idempotency behavior, ordering, compatibility, lag UX, observability, rebuilds, rollout, and recovery stay explicit.

EF Core, Dapper, mediators, brokers, Wolverine, Marten, and other package APIs are conditional examples only. Existing versions and repository usage must support them, time-sensitive license or support decisions require current authoritative verification, and adding or changing dependencies still requires authorization. Pi-native discovery exposes the skill to the main agent when the Guild resource is enabled; Guild children do not receive ambient skills. `dotnet-clean-architecture` remains the broader source for solution and domain boundaries.

Conventional Commit support also moved from Atlas to Guild. Guild 0.3.0 and later must be paired with Atlas 0.6.0 or later so exactly one active package owns `/commit`, `create_commit`, and the `conventional-commit` skill. Do not load them beside an older Atlas release that still registers these resources.

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

The main agent invokes the canonical API. Most tasks need no practice option; required TDD is an explicit coder-only choice:

```text
guild_handover({ role: "explorer", profile: "typescript", task: "Locate input validation and cite relevant files" })
guild_handover({ role: "coder", profile: "typescript", task: "...scope and acceptance criteria...", practices: [{ id: "tdd", policy: "required" }] })
```

Delegate directly from the interactive TUI:

```text
/guild-handover
/guild-handover architect/typescript
/guild-handover coder/typescript Implement validation and run the tests
/guild-handover typescript-coder Implement validation and run the tests
/guild-handover --json {"role":"coder","profile":"typescript","task":"Implement validation","practices":[{"id":"tdd","policy":"required"}]}
/guild-handover --help
```

With no target, the command opens a role picker followed by a profile picker. With no task for a coder, it asks **No requirement** or **TDD required** before opening the multiline editor; other roles open the editor directly. Selection/editor cancellation creates no handover. `--json` must be the leading standalone option followed by one complete canonical JSON object, with no trailing data. Other command tasks (including embedded `--json` or TDD text) remain literal and never select practices. Only coder can request required TDD; omission and `[]` mean no requirement. Tool arguments, direct JSON and editor input share strict validation: exact keys, nonblank/NUL-free task, task <=32 KiB UTF-8, canonical input <=40 KiB, host envelope <=48 KiB. Accepted practices are copied before queue admission. The command waits for the main agent to become idle and applies the same Plan-mode gate, inherited trust decision, queue, tools, and child runner as the agent tool. Direct execution is intentionally TUI-only.

List the fixed package roles, profiles, permissions, and aliases without launching a child:

```text
/guild
/guild --help
```

Both commands also accept `-h`; help returns before idle waits, UI prompts, admission checks, or child execution. Task input remains free-form. New child completions must use the exact result protocol below; prose alone is never a successful completion.

## Live transparency

Accepted handovers are serialized through one process-local FIFO queue. The compact dashboard distinguishes queued and running work with an automatic task preview after the existing metrics. Previews are sanitized single lines capped at 80 terminal columns (including the ellipsis), then clipped to available panel width. Model settings and tools remain hidden; the original delegated task is unchanged:

```text
Guild · 2 active · ↑ select · → expand
 ○ reviewer/general · queued · 0s · Review the validation changes
 ● coder/typescript · running · 5s · 2 turns · Implement input validation
```

Task previews may expose sensitive task content to anyone viewing the terminal. Only the bounded preview is retained by the active dashboard; it clears when the run finishes.

With the dashboard visible and the editor **exactly empty**, plain **↑** selects the last/nearest agent row above the editor, without waiting for the main agent to become idle or taking actual editor focus. **↑/↓** then select a handover by run ID; **→** (or **Enter**) expands its emitted assistant text, tool arguments, results, and status directly beneath that row. **↓** past the bottom compact row returns navigation to the editor and consumes that boundary key only; subsequent keys work normally. **←** collapses detail without releasing selection; in compact view Left is a no-op. **Esc** also collapses detail, then **Esc** returns to the editor. Right/Enter on an already expanded session preserves scrolling and its subscription. Only one session can be expanded; clicking another row disposes the previous detail before opening the new one. Other input (including printable typing) releases panel navigation and passes through unchanged; the draft and cursor are never replaced. Any nonempty draft, including whitespace or a newline, leaves Up/Down history and cursor handling untouched. Empty-editor Up takes precedence over previous-prompt history only while agent rows are visible; with no dashboard/agents, normal history remains available. There is no activation shortcut.

In expanded view, **↑/↓**, **Page Up/Page Down**, and **Home** scroll manually; **End** resumes live following. Paused scrolling stays anchored to content across updates and resizing; an evicted anchor is labelled explicitly. Fullscreen mode also supports clicking a dashboard row to select and expand that exact run inline. Regular terminal mode uses keyboard navigation, not mouse clicks.

The dashboard has no inspector modal or global F6 binding. Its component and selection survive ticker and queue updates. Expansion uses the same opaque, padded Guild detail styling across the full available terminal width; the entire panel is capped at half the terminal height (at most 24 rows), leaving space for the editor. Short screens show fewer roster rows around the selection. A blank opaque row separates the compact selected agent from a themed **✦ Session** delimiter, without repeating its role/status. Two-column detail padding, a muted bounded task preview, a **Transcript** divider and footer breathing room separate content and controls; these rows count against the height budget. Tiny screens prioritize the visible **← collapse** control over roster chrome. Assistant entries and ordinary tool input/output are labelled. Internal report submissions show only a bounded human summary and submission status, never their protocol envelope; submission is not host-validated completion. It does not send instructions to children or expose thinking/reasoning blocks, signatures, provider metadata, or binary images. Unsupported images and omitted content are labelled. Collapse/navigation never cancel a handover. Only queued/running agents appear in the roster. When a selected agent completes, fails, or is cancelled (including while queued), its detail subscription is immediately disposed and its row removed. Selection moves to the adjacent active row when available, but never automatically expands another agent. An omitted/evicted transcript for a still-active ID remains labelled unavailable.

Compatibility: inspected installed Pi 1.0.4's public `ctx.ui.setWidget` component factory, `ctx.ui.onTerminalInput` unsubscribe/`{consume: true}` contract, component-local mouse coordinates and `matchesKey`/keybindings APIs. One lightweight observer exists while the widget is mounted, including when panel navigation is inactive; activation/return and ticker updates do not re-register it. Rebuilds dispose the old observer; widget cleanup/shutdown dispose it and detail subscriptions. Stale listeners and cleared widget factories are inert.

Activation and continued capture are guarded by public `TUI.hasOverlay()`, Guild direct-progress ownership, and an isolated structural check of the runtime-public `getFocusedComponent()` capability (omitted from the declared TUI interface). Only focused editors exposing CustomEditor's public text/app-action/extension-shortcut hooks are eligible; dialog/progress owners release capture and receive input unchanged. Missing focus capability or unsupported replacement editors disable keyboard activation rather than risk intercepting dialogs. A foreign custom screen deliberately exposing the same editor hooks cannot be distinguished through these public capabilities. It does not call `setFocus`, replace the editor, or access private runtime fields. Check `/hotkeys` for user/extension conflicts.

The transcript store is memory-only and session-local, independent of `PITHOS_GUILD_TRACE`. It retains at most 256 KiB of strings and 500 entries per run, with individual strings capped at 16 KiB and displayed tasks at 4 KiB; up to 10 completed runs/2 MiB of completed content are retained, subject to a global 64-run/4 MiB string budget. Limits include stored identifiers and metadata strings, not the entire JavaScript heap. Evictions and truncation of active transcripts are visible; completed snapshots are retained privately for diagnostics, not as dashboard rows. All retained transcripts clear on shutdown, reload, or session replacement. Viewing does not add transcript history to parent model context or tool-result details, create session files, or make extra model requests. Repository/tool output may still contain secrets: anyone viewing the terminal can see that content, and the live view is a bounded excerpt, not a complete saved child session.

Agent-invoked handovers use that aggregate dashboard. A direct `/guild-handover` uses a width-capped cancellable card with canonical identity, package source, permission level, queue state, elapsed time, turns, and real child-tool activity. On that card, **F6** or **Enter** opens its own transcript; **Esc** or **F6** returns to progress without cancelling. Back on the progress card, **Esc/Ctrl+C** cancels as before. Completion, failure, or cancellation closes the direct live view and renders the terminal report. Completed reports render as Markdown; a valid blocked task is transport-completed with a warning **Blocked** treatment and retained report (not a tool error). Failures receive diagnostics; cancellations use a compact terminal treatment. Details include requested practices, task outcome and host-selected skill receipts; ordinary rendering shows only selected skill IDs.

Each direct handover records one hidden user-initiated `started` event and exactly one correlated `completed`, `failed`, or `cancelled` event with `triggerTurn: false`. A blocked task remains `completed` with explicit `taskOutcome: blocked`. Reports and diagnostics are delimited as task data rather than instructions. Picker/editor cancellation creates no lifecycle event. When the final run stops, the entire dashboard automatically disappears: widget, footer status, ticker, controller and input observer clear immediately, even with selected/expanded detail, a nonempty draft or changed focus ownership. No Esc is needed; stale callbacks cannot consume subsequent editor input. Shutdown disposes inline capture and detail subscriptions before the store and execution queue.

Serialization covers all Guild handovers within one extension runtime. Cancellation of queued work never launches a child; cancellation of active work holds the queue until the child process terminates and cleanup finishes. Separate Pi processes and external tools remain outside this guarantee. Guild remains independent of Pi's native specialist facility and does not observe its lifecycle or messages.

### Child usage and traces

Agent-invoked handovers return the child's token usage and cost to Pi, so they count in the footer, `/session`, and session totals. Usage is omitted when any child turn lacks a complete breakdown. Direct `/guild-handover` runs keep usage in their lifecycle details only, because Pi does not let extensions add usage to custom messages.

Children run without their own session files. Set `PITHOS_GUILD_TRACE=1` to record each child transcript locally as `<session dir>/guild/<session id>/<child id>.jsonl`: a header with run, role/profile and parent-session correlation, finalized child events (streaming `message_update` events are dropped), stderr, and an end record. Files are private (`0600`, directories `0700`) and capped at 16 MiB each; overflow writes a `truncated` marker and keeps the end record. Traces contain raw repository content and tool output. Recording failures are logged and never affect the handover.

Traced runs also snapshot the repository state they start from, after queueing, into `<run id>.state/` beside the trace: `state.json` (root, `HEAD`, branch, captured files, anything skipped), `tracked.patch` (`git diff --binary HEAD`, staged and unstaged), and copies of untracked, non-ignored files under `untracked/`. The trace header's `repoState` names the snapshot and whether it is complete. Capture is read-only for the repository: no index, ref, or stash changes. Ignored files are not captured, and each part is capped at 32 MiB. To restore: clone the repository, check out `head`, run `git apply --binary tracked.patch`, and copy `untracked/` over the checkout. Snapshots can contain uncommitted secrets that are not gitignored, so keep them private.

From a source checkout, `npm run report -- [session files or directories] [--since YYYY-MM-DD] [--json]` summarizes real sessions (default `~/.pi/agent/sessions`, or `$PI_CODING_AGENT_DIR/sessions`). It counts handovers by target, entry path, status, task outcome and child-reported TDD compliance; reports duration and the child share of cost over sessions whose costs are all known; flags possible rework when the parent edits a path a coder reported changing before the next user message; and joins traces for rejected result submissions. Older Guild session formats are read as well. The report is observational: it does not show whether main-only work would have done better. The tool is repository-only and not part of the published package.

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

Guild no longer reads `~/.pi/agent/agents` or `.pi/agents` and has no user/global configuration layer. The migration does not delete those directories or their files, and arbitrary prompt overrides are not converted. Repository guidance may remain in `AGENTS.md`, but Guild children do not inherit ambient context files; delegated tasks must be self-contained or explicitly ask the child to inspect relevant repository guidance. Only the fixed reviewer core and explicitly required coder TDD core are injected into child prompts; other ambient skills and profile-selected resources remain unavailable.

## Isolation and resources

Each Guild target runs with:

- an isolated context window and no saved child session;
- the parent's current provider/model, thinking level, working directory, and trust decision;
- an explicit package-controlled base system prompt plus exactly one role prompt and one profile prompt, with selected fixed package skill cores embedded after role/profile guidance;
- the exact role-owned repository tool allowlist plus `guild_submit_result`;
- `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--no-context-files`, with one explicit absolute local `--extension` pointing to package-owned `src/child-protocol.ts`;
- no recursive Guild delegation and no user/project member, system-prompt, append-prompt, skill, extension, template, or context-file discovery.

The tool and direct command both fail closed while Plan mode is active or indeterminate. The inherited trust decision controls `--approve` versus `--no-approve`; it does not expand role tools. Only coder has shell access, so this remains guardrail-oriented delegation rather than a filesystem sandbox. Task input stays free-form; completion is structured.

Cancellation terminates the child process and waits for shutdown and owned cleanup before releasing the serialized queue. Rendering retains up to 50 KiB of UTF-8 report text plus a truncation notice; accepted structured reports remain in tool-result or lifecycle-message details. Transport and diagnostics are separately bounded, not retained without limit.

## Exact completion protocol

One host builder binds `guild/2` version 2 to a run ID, unique task ID, canonical role/profile, and original task text. It does not infer scope, acceptance criteria, or write leases from prose. The same runner and host-owned `completed`, `failed`, or `cancelled` outcome serve agent tools, direct commands, and editor input. Legacy persisted prose reports remain displayable, but cannot complete a new handover.

Children must submit `guild_submit_result` **alone in its tool batch**, once. Common exact fields are `protocol`, `version`, `runId`, `taskId`, `role`, `profile`, `taskOutcome`, `compliance`, `summary`, `blockers`, `limitations`, and `payload`. `taskOutcome` is `succeeded` only with no blockers and all requested compliance satisfied; `blocked` requires a nonblank blocker. `compliance` is empty unless coder required TDD was selected. Required TDD needs one exact record with status `satisfied` (at least one same-command red nonzero/green zero claimed cycle) or `blocked` (nonblank reason, blocked task outcome). Missing execution or meaningful preimplementation red is blocked, not waived. Up to eight completed cycles are reportable; diagnostics and 1–4 evidence references per red/green observation remain child claims. Role payloads are:

- explorer: referenced `observations` and `unknowns`;
- architect: `decisions`, `contracts`, and `handoff`;
- coder: reported `changes` and `verification` commands/outcomes;
- reviewer: `scope`, severity-ranked `findings`, and `verdict`.

Empty findings and unperformed checks are legitimate when reported honestly. Each string is at most 2048 UTF-8 bytes, each list at most 32 items, and the serialized result at most 48 KiB. Oversized or extra-key results are rejected, never truncated into apparent completion. Parent ingestion permits at most 1 MiB per JSON line, 16 MiB total stdout, and 64 KiB stderr. Exceeding transport bounds fails the run, including unusually large ordinary tool events.

A malformed submission or prose-only completion gets **one shared corrective opportunity in the same child**. The next assistant response must submit the result alone; there is no respawn, queue re-entry, or reset on continued agent runs. Identity mismatch, mixed batches, duplicates, post-submission work, exhausted repair, missing handshake/settlement, process/provider errors, and cleanup failures fail closed. Cancellation and failure override a previously valid submission. Mixed-batch rejection is not a claim that sibling work never happened or was rolled back.

Reports, commands, changes, references, TDD cycles, and judgments are **child-reported claims**, not authenticated or host-certified truth. Fixed package core selection is host-owned: required-TDD coder selects `skills/tdd/SKILL.md`, reviewer always selects `skills/code-review-standards/SKILL.md`, all other cases select none. Each selected raw valid UTF-8 core must be a canonical regular package file <=32 KiB; missing, symlinked or oversized cores fail before child launch. Its complete content is embedded with absolute source and references-directory anchors, not loaded via ambient skills or references preloading. Details receipts record package-relative path, byte count and SHA-256 of injected raw bytes; they attest selection, not authenticity, child attention, or test execution. Host role/tools/protocol overrides required practice, which overrides general skill exceptions. For optional parent-selected reviewer work, the caller must include the original requirement, report, scope and evidence in the task (not coder practices); the reviewer classifies claims as corroborated/contradicted/unverified. No automatic reviewer pipeline is installed. These guardrails are not a filesystem sandbox. Tool failures carry structured terminal details and are marked as errors through Pi's `tool_result` hook. Known usage is retained on failures/cancellation: `usageFields` identifies fields actually observed, totals may be partial, and `usageKnown: false` means the numeric compatibility placeholders must not be read as measured zero usage.


## Development

```bash
cd pithos.guild
npm ci
npm test
npm run typecheck
npm pack --dry-run
```

## Evaluation and benchmarking

Guild's evaluation methodology compares the complete workflow: the same user request goes to either the main agent alone or the main agent with Guild available, through final verification and synthesis. Delegation is optional; choosing not to delegate can be the right outcome. Forced role/profile calls are useful diagnostic experiments, not a substitute for this end-to-end comparison.

The methodology separates deterministic boundary tests, known-task regressions, single-variable experiments, and repeated product comparisons. Correctness and preservation of user work come first. Any future report should show reliability, total parent-plus-child usage/cost, latency, and context burden separately rather than combining them into one score. Failed, cancelled, and timed-out attempts must remain visible; missing usage is unknown, not zero. Single-run pilot results do not establish superiority, and development fixtures are not held-out promotion evidence.

Evaluation tooling is **repository-only**, not part of the installed npm package or the normal handover workflow. From a source checkout:

```bash
cd pithos.guild
npm run eval -- validate
npm run eval -- schedule e1-development-1 1
npm run eval:test
npm run eval:typecheck
```

These commands are offline: validation and scheduling do not launch models. **E1 is closed with an inconclusive outcome**, not an accepted comparative benchmark. Native campaign admission, provider trials, and settlement/history gates remain closed. Provider-free and scripted Pi integration checks exercise specific runtime paths, not real-provider behavior, task quality, or genuine TDD adherence. Live campaigns require separate task-bank, model, budget, readiness, and operational approval; this README does not authorize them.

For methods, historical checkpoints, and the current gate status, see the repository's [evaluation methodology](https://github.com/anton-kochev/pithos-kit/blob/main/pithos.guild/evaluation/methodology.md), [Phase 2 assessment](https://github.com/anton-kochev/pithos-kit/blob/main/pithos.guild/evaluation/phase-2-assessment.md), and [E1 completion status](https://github.com/anton-kochev/pithos-kit/blob/main/pithos.guild/evaluation/e1-completion-status.md). Evaluation evidence and raw traces are repository-local, not bundled in the published package; credentials must not enter recorded artifacts.

## Provenance

The concise role/profile resources retain adapted guidance from the MIT-licensed [Grimoire](https://github.com/anton-kochev/grimoire) project and repository-native TypeScript/Pi guidance. See [`NOTICE.md`](./NOTICE.md).
