# guild

A standalone bounded Guild with stable exploration, architecture, implementation, review, and writing roles; reusable general, front-end, Angular, TypeScript, .NET, and Rust profiles; and content-craft, repository-aware Clean Architecture, CQRS, code-review, code-comments, Conventional Commit, and test-driven development guidance for [pi](https://github.com/earendil-works/pi-mono).

The extension adds agent-callable `guild_handover` and controlled `create_commit` tools, plus interactive `/guild-handover` and `/commit` commands. Every handover names a canonical `role/profile`, starts an isolated ephemeral pi process with package-controlled prompts and a role-owned hard tool allowlist, and inherits the parent session's active provider, model, thinking level, working directory, and project-trust decision.

## At a glance

Guild hands **one focused task** to an isolated child: choose a role for its permissions and a supported profile for its guidance. Explorer and architect investigate or plan, coder can edit and run tests, reviewer inspects changes without writing, and writer creates scoped prose artifacts without shell access. Guild queues handovers, returns a bounded structured report, and leaves verification and final decisions to the main agent. It does not run an automatic multi-agent pipeline or prove a child's claims.

On a qualified host, coder and reviewer tasks can also run in the background: **three occupied slots and eight pending starts**, in the parent's working directory. Children can ask the parent for clarification and continue in the same process after an answer. Background controls and automatic parent notices remain subject to runtime qualification, Plan protection, and explicit result collection.

For example, in Pi's interactive TUI:

```text
/guild-handover explorer/typescript Find where user input is validated and cite relevant files.
```

Or ask the main agent, “Use explorer/typescript to find the validation path and report the evidence.” The child can inspect but not edit; for an implementation, delegate a separate coder task with scope and acceptance criteria. See [Usage](#usage) for coder, reviewer, and required-TDD examples.

## Install

The blocking path requires Pi **1.0.0 or newer**, unchanged. Installing Guild alone does not add background support to stock Pi. Background tools are conditional on the host runtime. They require live-qualified `semanticInterrupt` (`pi-semantic-interrupt-v1`) and `atomicOwnedTools` (`pi-atomic-owned-tools-v1`), plus safe Plan policy and owner. Optional qualified `parentContinuation` (`pi-parent-continuation-v1`) additionally enables automatic idle-parent delivery. Package tool metadata describes conditional inventory, not availability on every supported version. Qualification requires the exact protocol, lifetime capability and successful live binding—not semver, function presence or an environment override. The provider-free development harness remains pinned to 0.99.0; it does not certify Pi 1.x or real-provider behavior.

### Background support in Pithos

Pithos builds that ship the Guild runtime overlay for **Pi 1.5.0** apply it during the container image build and select the patched Node runtime at startup. On that supported setup, no manual runtime activation or Guild enable flag is needed after a restart or container recreation. The build checks the exact installed files before applying its overlay; an unsupported version or mismatched installation stays on stock Pi. The launcher reports a refused patch. Do not assume that selecting a newer Pi version also supplies background support.

Guild still checks the live capabilities and Plan state. By default, background admission requires a compatible inactive Plan extension; an intentionally Plan-free setup must explicitly assert `PITHOS_GUILD_PLAN_MODE=standalone`. These checks are not bypassed by Pithos startup. Existing blocking handovers remain available without the background capabilities.

The supported Pithos launcher can select the stock runtime instead when `~/.pi/agent/pithos-stock-runtime` exists. Removing that marker restores the normal selection on the next process start. `/reload` does not replace the running Pi core. These are Pithos launcher behaviors, not changes made by the Guild npm package.

### Install Guild

Install the current release:

```bash
pi install npm:@pithos-kit/guild@0.11.0
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
    "@pithos-kit/guild": "npm:0.11.0"
```

## Roles and profiles

Roles own responsibility and the repository tool ceiling. Every child additionally receives `guild_submit_result`, a child-only reporting tool with no repository or delegation capability. Background coder/reviewer children also receive `guild_ask_parent` for correlated clarification; it does not expand repository permissions or enable delegation:

| Role | Responsibility | Tools |
|---|---|---|
| `explorer` | Inspect repository structure, behavior, versions, conventions, dependencies, and relevant paths | `read`, `grep`, `find`, `ls`, `git_read` |
| `architect` | Compare designs and define contracts, invariants, test strategy, and an implementation handoff | `read`, `grep`, `find`, `ls`, `git_read` |
| `coder` | Implement one coherent scope, own relevant tests, and verify it | `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash` |
| `reviewer` | Independently inspect a focused change and return severity-ranked evidence and a verdict | `read`, `grep`, `find`, `ls`, `git_read` |
| `writer` | Create or revise articles, tutorials, stories, and scripts from a supplied brief and evidence; `general` only | `read`, `grep`, `find`, `ls`, `git_read`, `edit`, `write` |

Profiles select package-owned guidance and never add tools:

| Profile | Focus |
|---|---|
| `general` | Task-grounded general guidance; software engineering only when relevant |
| `frontend` | Browser UI, components, state, rendering, accessibility, and performance |
| `angular` | Angular applications, templates, reactivity, forms, and tests |
| `typescript` | TypeScript, JavaScript, Node.js, modules, runtime boundaries, and async behavior |
| `dotnet` | .NET, C#, projects, persistence, dependency injection, async behavior, and tests |
| `rust` | Rust, Cargo, ownership, errors, concurrency, unsafe boundaries, and tests |

There are 25 supported role/profile pairs: all 24 existing engineering pairs plus `writer/general`. Unsupported writer pairs are rejected, not silently mapped to general. Writer can edit or write assigned artifacts; only `coder` can invoke shell commands. Explorer, architect, and reviewer remain mechanically read-only. Their `git_read` tool, also available to writer, runs only `status`, `diff`, `log`, `show`, `ls-files`, and `blame` without a shell, accepts an exact allowlist of read-only options (no `--output`, external diff, textconv, or signature checks), disables fsmonitor and optional index locks, and caps output at 50 KiB. It never changes staged content, refs, or the working tree; like any plain `git diff`, `diff` may refresh the index stat cache, and repository-configured clean filters still run. `researcher` is intentionally unavailable until Guild has controlled read-only web tools.

## Writer and content-craft skill

Use `writer/general` for technical or nontechnical writing. General does not mean nontechnical: put domain and topic requirements in the brief rather than selecting a technology profile. Supply the audience, purpose, format, voice/tone, length, source material, explicit output path, and acceptance criteria. For example:

```text
/guild-handover writer/general Write a 900-word article for junior developers about database indexes. Use docs/index-notes.md as the factual source. Save to docs/articles/indexes.md. Use an approachable tone, explain the limits of analogies, and flag gaps rather than inventing evidence.
```

Writer requires an explicit destination in the task. If it is absent, unsafe, outside scope, or would overwrite conflicting content without authorization, the child should report blocked instead of choosing a path. Existing assigned documents may be revised when authorized; preserve unrelated edits. This is prompt guidance, not host-enforced path confinement or a filesystem sandbox. The host validates the report, not the existence, accuracy, or ownership of reported artifacts.

Clarify requirements and research in the parent before handing over. Writer has no shell, web, user-question, publishing, or delegation tools. Supply local source paths or source contents; URLs alone are not read evidence. A writer should report missing essential information, unverified claims, and checks it could not perform honestly. Fiction may invent within its stated frame but must not fabricate factual sourcing or endorsements. Shell-based content builds and executable tutorial checks remain parent/coder responsibilities.

The package-owned `content-craft` skill covers audience-first writing, structure and voice, analogies and concrete examples, factual grounding, revision, and proportionate guidance for articles, tutorials, stories, podcasts, videos, screenplays, and documentary scripts. Load it in the parent with optional context:

```text
/skill:content-craft [writing brief]
```

Pi-native discovery exposes the skill to the parent when enabled. Every writer child receives the fixed content-craft core through both handover entry paths, independent of that toggle; no other role receives it automatically. Writer does not receive code-comments, review, or TDD cores, and required TDD remains coder-only. A missing or invalid craft core fails writer setup before launch. Receipts attest selected bytes, not editorial quality or factual verification. Use `pi config` or `pi config -l`, then `/reload`, to toggle parent discovery.

Long-form prose goes into the assigned files, not bounded report strings. The report contains `artifacts` (path/description), `sources` (reference/usage), and `checks` (check/outcome), with common blockers and limitations. A succeeded writer report requires at least one artifact; blocked work may have none. Both are child-reported claims. A parent can read the artifact to present or verify it. No automatic publication or reviewer pipeline is installed.

## Code-review standards skill

Guild owns the language-neutral `code-review-standards` skill for focused, evidence-based reviews with impact-calibrated severity and deterministic Request changes, Comment, or Approve decisions. When Guild is installed and this resource is enabled, Pi-native discovery lets the main agent load it proactively without requiring explicit invocation. Guild children start with general skill discovery disabled. Every reviewer child receives the fixed package-owned review core in its prompt, independent of profile or parent discovery toggle; this does not add tools or grant shell access. The skill can also be loaded directly in the parent session when desired:

```text
/skill:code-review-standards [review scope]
```

The methodology honors explicit commits and ranges or inspects staged, unstaged, and relevant untracked changes; detects supported languages, frameworks, and runtimes from repository evidence; and complements the canonical `reviewer` role's findings-first report. It never treats an inspected scope as proof of perfect code or claims verification that was not run.

Use `pi config` or `pi config -l` to disable this resource, then run `/reload`. The canonical `reviewer` role remains self-contained without the skill: its package role prompt retains a hard read-only boundary, findings-first evidence, and a deterministic verdict.

### Independent review workflow

Review is independent scrutiny of original needs, plan/design, and implementation, not a plan-conformance stamp. A plan is optional. Parent and direct-command callers supply a self-contained brief in the existing task field; children do not inherit the conversation or ambient context files. Preserve material requirements rather than substituting an author's checklist. Use explicit local file paths for longer context and instruct the child to read those files; disclose inaccessible references, omit unrelated context and secrets.

Reusable review brief:

```text
Original requirement (preferably verbatim): "..."
User constraints and decisions, with provenance: ...
Implementer assumptions (not user decisions): ...
Exact scope and comparison: paths, commit/range/base or staged/unstaged/untracked state; exclusions ...
Plan/rationale (optional): none, or explicit local paths; read those files.
Actual verification evidence and limitations: commands, observed outcomes, evidence paths;
not-run checks and inaccessible references ...
Independently challenge plan/design and implementation from the original needs.
Assess context sufficiency; retain supported findings and disclose unassessed dimensions.
```

No-plan existing-code example:

```text
/guild-handover reviewer/typescript Review src/cache.ts at HEAD for resource cleanup against its public contract; no feature request or written plan exists. Read src/cache.ts and test/cache.test.ts. Objective: identify leaks on cancellation. User decision: preserve the public API. Implementer assumption: cancellation always follows initialization. Scope is these paths at HEAD, not working-tree changes. Verification: no commands run; inspect tests, do not claim execution. Report missing essential context rather than inventing intent.
```

For a change review, replace the scope with the exact comparison and include the original request, for example: `Original requirement: "Cancellation must release the worker even before startup completes." Read docs/cancellation-contract.md and review src/worker.ts and test/worker.test.ts against HEAD, including staged and unstaged changes. Plan: none. User constraint: preserve the API. Author assumption: startup cannot fail. Verification: npm test passed per supplied author log docs/review/test-output.txt; read it, treat it as supplied evidence, not your own execution.` Use real scoped paths and evidence, not these illustrative names.

Reviewers distinguish planning/design gaps from implementation bugs and assess whether tests merely mirror implementation assumptions. They respect explicit decisions unless consequential evidence warrants challenge; independent review is not opposition for sport. Missing essentials preventing the assigned review produce `taskOutcome: blocked` with precise blockers, while independently supported findings remain. Partial context can support an explicitly limited review, never silent narrowing or approval of material unassessed scope. Missing context is not itself a severity finding.

Task outcome and verdict are separate: Request changes for unresolved Critical/High/Medium findings; Comment for Low findings or material unresolved limitations; Approve only with neither in the fully inspected assigned scope. A completed review requesting changes is not itself blocked. Isolated reviewers cannot ask questions or run shell/tests and must always submit the structured report, even when blocked. Parent skill use may ask focused questions. The parent closes gaps by supplying evidence and requesting another review, asking the user only if information is genuinely unavailable. Never present a limited review as complete. These are instruction contracts, not mechanical guarantees of independent reasoning; no automatic review pipeline or new schema is introduced.

## Code-comments skill

Guild's language-neutral `code-comments` skill guides accurate, concise comments that prevent misunderstandings and plausible wrong edits. It preserves intent, contracts, constraints, and non-obvious mechanisms rather than imposing comment-count targets or a why-only rule. Load it directly with optional task context:

```text
/skill:code-comments [task or scope]
```

Pi-native discovery exposes the skill to the main agent when enabled. Every **coder** child, across all profiles and both handover entry paths, automatically receives the same fixed package-owned core. Required-TDD coders receive TDD followed by code-comments; explorer, architect, reviewer, and writer children do not receive code-comments. Guidance stays within the assigned task and does not authorize unrelated cleanup or behavior changes.

Use `pi config` or `pi config -l`, then `/reload`, to toggle the parent-session resource. That toggle does not disable fixed coder injection. Children retain disabled ambient discovery and unchanged tool permissions. A missing or invalid code-comments core fails coder setup before launch; other roles do not load it. Core receipts record selection, not proof that a child followed the recommendations.

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
Use writer/general to draft an article from supplied notes at an explicit output path.
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

With no target, the command opens a role picker followed by a supported-profile picker; choosing writer automatically selects general without a redundant profile picker. With no task for a coder, it asks **No requirement** or **TDD required** before opening the multiline editor; other roles open the editor directly. Selection/editor cancellation creates no handover. `--json` must be the leading standalone option followed by one complete canonical JSON object, with no trailing data. Other command tasks (including embedded `--json` or TDD text) remain literal and never select practices. Only coder can request required TDD; omission and `[]` mean no requirement. Tool arguments, direct JSON and editor input share strict validation: exact keys, nonblank/NUL-free task, task <=32 KiB UTF-8, canonical input <=40 KiB, host envelope <=48 KiB. Accepted practices are copied before queue admission. The command waits for the main agent to become idle and applies the same Plan-mode gate, inherited trust decision, queue, tools, and child runner as the agent tool. Direct execution is intentionally TUI-only.

List the fixed package roles, profiles, permissions, and aliases without launching a child:

```text
/guild
/guild --help
```

Both commands also accept `-h`; help returns before idle waits, UI prompts, admission checks, or child execution. Task input remains free-form. New child completions must use the exact result protocol below; prose alone is never a successful completion.

### Background tools and manual controls

On a qualified interactive host, coder/reviewer tasks can run concurrently; other roles remain blocking-only.

| Tool | Purpose |
|---|---|
| `guild_start` | Admit a task with canonical role, profile, task and optional coder practices; returns IDs, not proof of launch |
| `guild_status` | Inspect runs and current untrusted questions without collecting usage |
| `guild_send` | Send an update, or reply with the exact pending `questionId`; acceptance is not delivery or scope acknowledgment |
| `guild_wait` | Observe a run and explicitly collect its terminal report; default 30 seconds, maximum 60 |
| `guild_cancel` | Cancel one run and join cleanup |

```text
guild_start({role: "coder", profile: "typescript", task: "...scope and acceptance criteria..."})
guild_status({runId: "<returned runId>"})
guild_send({runId: "<runId>", questionId: "<pending questionId>", message: "...answer..."})
guild_wait({runId: "<runId>", timeoutMs: 60000})
```

Limits are **3 occupied slots, 8 pending starts and 16 unconsumed records**. Queued admission is not child launch; waiting and stopping retain capacity through cleanup and terminal publication. Each run permits eight questions, 8 KiB question/message text, two pending/in-flight updates and 32 lifetime updates. There are at most 32 concurrent waiters. Terminal report DTOs and whole public tool results have 64 KiB budgets; oversized reports are rejected, not silently truncated into success. Wait timeout is observational, not cancellation. While a child is waiting for an answer, use `guild_send` with its exact pending `questionId`; an ordinary update without that ID is not accepted until the question is answered.

`PITHOS_GUILD_PLAN_MODE` is captured once: unset or exact `required` needs a compatible inactive Plan handshake. Exact `standalone` is a trusted parent assertion of absence and rejects any provider reply. Invalid values block background admission only. Safe persisted inactivity and strict Plan protection through cleanup remain required. Shared cwd and task scopes are **not file locks**: coordinate overlapping edits yourself. Guild does not roll back, stash, merge or delete child edits on cancellation.

```text
/guild status [runId]
/guild cancel <runId>
/guild cancel-all
```

These manual controls inspect or cancel without a model turn, usage claim or automatic rearm. No-argument `/guild` and help retain the roster/help behavior. Status shows question IDs and sanitized untrusted previews; qualified tool status/wait recover canonical questions and results.

A semantic application interrupt, including Escape dispatched to the native interrupt action, cancels **all active, waiting and queued work**. Escape consumed by a modal or panel is not a semantic interrupt. Completion never restarts an interrupted or retired parent; a healthy qualified parent may receive automatic notices. Only fresh eligible idle intent after drain and safe Plan checks can reactivate the owner. Navigation drains before epoch change; session replacement fences old callbacks. Persisted observations are visible according to their origin session/branch and restore observations, **never children**.

**Automatic idle-parent continuation is conditional on live-qualified `parentContinuation`.** Fair bounded batches coalesce canonical questions and terminal notices; terminal delivery follows publication and cleanup. Notices acknowledge historical commit, not model reading, and neither notices nor status collect child usage. Actual parent inference has its normal usage. Without this optional capability, otherwise qualified background tools and UI/status remain available, but notices add no context messages or model turns. There is no fallback `sendMessage` queue. The [original Pi 1.4.0 host proposal](../proposals/pi-interrupt-hook/README.md) records the development contract and its historical tests; current Pithos deployment support is described under [Background support in Pithos](#background-support-in-pithos).

## Live transparency

On the blocking path, accepted handovers are serialized, across all roles and both blocking entry paths, as exclusive operations through one shared process-local scheduler. Their FIFO waiting backlog remains unbounded, preserving existing blocking admission rather than imposing a new overflow limit. The compact dashboard distinguishes queued and running work with an automatic task preview after the existing metrics. Previews are sanitized single lines capped at 80 terminal columns (including the ellipsis), then clipped to available panel width. Model settings and tools remain hidden; the original delegated task is unchanged:

```text
Guild · 2 active · ↑ select · → expand
 ○ reviewer/general · queued · 0s · Review the validation changes
 ● coder/typescript · running · 5s · 2 turns · Implement input validation
```

Task previews may expose sensitive task content to anyone viewing the terminal. Only the bounded preview is retained by the active dashboard; it clears when the run finishes.

With the dashboard visible and the editor **exactly empty**, plain **↑** selects the last/nearest agent row above the editor, without waiting for the main agent to become idle or taking actual editor focus. **↑/↓** then select a handover by run ID; the selected status dot and role/profile label use an inverted background, while metrics and task preview stay unchanged. **→** (or **Enter**) expands its emitted assistant text, tool arguments, results, and status directly beneath that row. **↓** past the bottom compact row returns navigation to the editor and consumes that boundary key only; subsequent keys work normally. **←** collapses detail without releasing selection; in compact view Left is a no-op. **Esc** also collapses detail, then **Esc** returns to the editor. Right/Enter on an already expanded session preserves scrolling and its subscription. Only one session can be expanded; clicking another row disposes the previous detail before opening the new one. Other input (including printable typing) releases panel navigation and passes through unchanged; the draft and cursor are never replaced. Any nonempty draft, including whitespace or a newline, leaves Up/Down history and cursor handling untouched. Empty-editor Up takes precedence over previous-prompt history only while agent rows are visible; with no dashboard/agents, normal history remains available. There is no activation shortcut.

In expanded view, **↑/↓**, **Page Up/Page Down**, and **Home** scroll manually; **End** resumes live following. Paused scrolling stays anchored to content across updates and resizing; an evicted anchor is labelled explicitly. Fullscreen mode also supports clicking a dashboard row to select and expand that exact run inline. Regular terminal mode uses keyboard navigation, not mouse clicks.

The dashboard has no inspector modal or global F6 binding. Its component and selection survive ticker and queue updates. Expansion uses the same opaque, padded Guild detail styling across the full available terminal width; the entire panel is capped at half the terminal height (at most 24 rows), leaving space for the editor. Short screens show fewer roster rows around the selection. A blank opaque row separates the compact selected agent from a themed **✦ Session** delimiter, without repeating its role/status. Two-column detail padding, a muted bounded task preview, a **Transcript** divider and footer breathing room separate content and controls; these rows count against the height budget. Tiny screens prioritize the visible **← collapse** control over roster chrome. Assistant entries and ordinary tool input/output are labelled. Internal report submissions show only a bounded human summary and submission status, never their protocol envelope; submission is not host-validated completion. It does not send instructions to children or expose thinking/reasoning blocks, signatures, provider metadata, or binary images. Unsupported images and omitted content are labelled. Collapse/navigation never cancel a handover. Background rows also retain waiting/stopping states through cleanup; the dashboard shows up to three occupied and eight queued background slots. When a selected agent completes, fails, or is cancelled (including while queued), its detail subscription is immediately disposed and its row removed. Selection moves to the adjacent active row when available, but never automatically expands another agent. An omitted/evicted transcript for a still-active ID remains labelled unavailable.

Compatibility: inspected installed Pi 1.0.4's public `ctx.ui.setWidget` component factory, `ctx.ui.onTerminalInput` unsubscribe/`{consume: true}` contract, component-local mouse coordinates and `matchesKey`/keybindings APIs. One lightweight observer exists while the widget is mounted, including when panel navigation is inactive; activation/return and ticker updates do not re-register it. Rebuilds dispose the old observer; widget cleanup/shutdown dispose it and detail subscriptions. Stale listeners and cleared widget factories are inert.

Activation and continued capture are guarded by public `TUI.hasOverlay()`, Guild direct-progress ownership, and an isolated structural check of the runtime-public `getFocusedComponent()` capability (omitted from the declared TUI interface). Only focused editors exposing CustomEditor's public text/app-action/extension-shortcut hooks are eligible; dialog/progress owners release capture and receive input unchanged. Missing focus capability or unsupported replacement editors disable keyboard activation rather than risk intercepting dialogs. A foreign custom screen deliberately exposing the same editor hooks cannot be distinguished through these public capabilities. It does not call `setFocus`, replace the editor, or access private runtime fields. Check `/hotkeys` for user/extension conflicts.

The transcript store is memory-only and session-local, independent of `PITHOS_GUILD_TRACE`. It retains at most 256 KiB of strings and 500 entries per run, with individual strings capped at 16 KiB and displayed tasks at 4 KiB; up to 10 completed runs/2 MiB of completed content are retained, subject to a global 64-run/4 MiB string budget. Limits include stored identifiers and metadata strings, not the entire JavaScript heap. Evictions and truncation of active transcripts are visible; completed snapshots are retained privately for diagnostics, not as dashboard rows. All retained transcripts clear on shutdown, reload, or session replacement. Viewing does not add transcript history to parent model context or tool-result details, create session files, or make extra model requests. Repository/tool output may still contain secrets: anyone viewing the terminal can see that content, and the live view is a bounded excerpt, not a complete saved child session.

Agent-invoked handovers use that aggregate dashboard. A direct `/guild-handover` uses a width-capped cancellable card with canonical identity, package source, permission level, queue state, elapsed time, turns, and real child-tool activity. On that card, **F6** or **Enter** opens its own transcript; **Esc** or **F6** returns to progress without cancelling. Back on the progress card, **Esc/Ctrl+C** cancels as before. Completion, failure, or cancellation closes the direct live view and renders the terminal report. Completed reports render as Markdown; a valid blocked task is transport-completed with a warning **Blocked** treatment and retained report (not a tool error). Failures receive diagnostics; cancellations use a compact terminal treatment. Details include requested practices, task outcome and host-selected skill receipts; ordinary rendering shows only selected skill IDs.

While its registration and dialog remain current, each direct handover records one hidden user-initiated `started` event and exactly one correlated `completed`, `failed`, or `cancelled` event with `triggerTurn: false`. A blocked task remains `completed` with explicit `taskOutcome: blocked`. Reports and diagnostics are delimited as task data rather than instructions. Picker/editor cancellation creates no lifecycle event. When the final run stops, the entire dashboard automatically disappears: widget, footer status, ticker, controller and input observer clear immediately, even with selected/expanded detail, a nonempty draft or changed focus ownership. No Esc is needed; stale callbacks cannot consume subsequent editor input. Terminal shutdown fences handover callbacks and publication before aborting execution, then independently cleans up UI and joins owned execution cleanup.

For handovers, `session_shutdown` permanently closes that registration: saved entry points cannot restart work, and shutdown joins accepted execution tails, not arbitrary command promises. Native idle waits, pickers and editors are fenced on resumption, not cancelled or drained. A direct custom dialog closes once during owned shutdown cleanup only if it has not already been host-disposed; host disposal revokes its saved `done` callback and settles Guild’s local wait without waiting for the native custom promise. Late completion cannot use that callback to restore an old draft. A started command may therefore have no terminal lifecycle message after shutdown or host disposal. Native same-session tree retirement and fresh-intent rearm are connected as described below. These guarantees do not prevent the host itself from mounting an arbitrarily delayed custom factory or extend to `create_commit`; semantic interrupt support is conditional as described above, and deterministic doubles and Pi 1.4.0 source inspection are not full Pi-runtime certification.

Serialization covers all blocking Guild handovers within one extension runtime. Cancellation of queued work never launches a child; cancellation of active work holds the scheduler until the child process terminates and cleanup finishes. Children share the parent's working directory; Guild creates no worktrees. Separate Pi processes and external tools remain outside this guarantee. Guild remains independent of Pi's native specialist facility and does not observe its lifecycle or messages.

Background UI delivery uses fair batches of at most eight items/8 KiB, with overflow recovery via status/wait. Previews are untrusted data, not instructions. The same single-focused-transcript controls and private bounded store apply; viewing never collects usage.

### Child usage and traces

Only the first top-level `guild_wait` collection can return known native child usage, with a persisted correlated receipt. Repeats are informational without attribution; nested waits are blocked before claiming. Unknown usage is not measured zero. Durable claims are at-most-once, **not crash-atomic exactly-once credit**: a lost tool return may never be credited. An interrupted restored observation explicitly collected by wait is cancelled with unknown usage.

Agent-invoked blocking handovers return the child's token usage and cost to Pi, so they count in the footer, `/session`, and session totals. Usage is omitted when any child turn lacks a complete breakdown. Direct `/guild-handover` runs keep usage in their lifecycle details only, because Pi does not let extensions add usage to custom messages.

Children run without their own session files. Set `PITHOS_GUILD_TRACE=1` to record each child transcript locally as `<session dir>/guild/<session id>/<child id>.jsonl`: a header with run, role/profile and parent-session correlation, finalized child events (streaming `message_update` events are dropped), stderr, and an end record. Only the exact environment value `1` enables recording. Files are private (`0600`, directories `0700`), with a 16 MiB content budget plus truncation/end-record metadata overhead; overflow writes a `truncated` marker and keeps the end record. Traces contain raw repository content and tool output. Recording failures are logged and never affect the handover.

Traced blocking handovers also snapshot the repository state they start from, after queueing, into `<run id>.state/` beside the trace: `state.json` (root, `HEAD`, branch, captured files, anything skipped), `tracked.patch` (`git diff --binary HEAD`, staged and unstaged), and copies of untracked, non-ignored files under `untracked/`. The trace header's `repoState` names the snapshot and whether it is complete. Capture is read-only for the repository: no index, ref, or stash changes. Ignored files are not captured, and each part is capped at 32 MiB. To restore: clone the repository, check out `head`, run `git apply --binary tracked.patch`, and copy `untracked/` over the checkout. Snapshots can contain uncommitted secrets that are not gitignored, so keep them private.

From a source checkout, `npm run report -- [session files or directories] [--since YYYY-MM-DD] [--json]` summarizes real sessions (default `~/.pi/agent/sessions`, or `$PI_CODING_AGENT_DIR/sessions`). It counts handovers by target, entry path, status, task outcome and child-reported TDD compliance; reports duration and the child share of cost over sessions whose costs are all known; flags possible rework when the parent edits a path a coder reported changing before the next user message; and joins traces for rejected result submissions. Older Guild session formats are read as well. For background runs it separates admission-to-terminal latency from actual trace execution intervals: sum, union (any child executing), and overlap (at least two executing, not pairwise multiplicity), aggregated per session. Missing endpoints remain unknown. These are not workflow wall time or speedup. Known uncollected child cost is informational, not native totals; native credit requires a matching collection receipt/tool result. The report is observational: it does not show whether main-only work would have done better. The tool is repository-only and not part of the published package.

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

Guild no longer reads `~/.pi/agent/agents` or `.pi/agents` and has no user/global configuration layer. The migration does not delete those directories or their files, and arbitrary prompt overrides are not converted. Repository guidance may remain in `AGENTS.md`, but Guild children do not inherit ambient context files; delegated tasks must be self-contained or explicitly ask the child to inspect relevant repository guidance. The fixed reviewer core, coder code-comments core, writer content-craft core, and explicitly required coder TDD core are injected into their respective child prompts; other ambient skills and profile-selected resources remain unavailable.

## Isolation and resources

Each Guild target runs with:

- an isolated context window and no saved child session;
- the parent's current provider/model, thinking level, working directory, and trust decision;
- an explicit package-controlled base system prompt plus exactly one role prompt and one profile prompt, with selected fixed package skill cores embedded after role/profile guidance;
- the exact role-owned repository tool allowlist plus `guild_submit_result`, with `guild_ask_parent` additionally available to background coder/reviewer children;
- `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--no-context-files`, with one explicit absolute local `--extension`: package-owned `src/child-protocol.ts` for blocking print/JSON children, or `src/background-child-protocol.ts` for retained background RPC children;
- no recursive Guild delegation and no user/project member, system-prompt, append-prompt, skill, extension, template, or context-file discovery.

The tool and direct command both fail closed while Plan mode is active or indeterminate. The inherited trust decision controls `--approve` versus `--no-approve`; it does not expand role tools. Only coder has shell access, so this remains guardrail-oriented delegation rather than a filesystem sandbox. Task input stays free-form; completion is structured.

Blocking Guild handovers do not support parent–child clarification exchanges. Blocking children run in print/JSON mode with stdin ignored: the parent cannot send follow-up instructions to the running child, and the child has no ask-parent/reply operation. Live transcripts are observational, not a messaging channel. Supply essential context before delegation; if missing information blocks the task, the child reports blockers and the parent can supply that information in a new handover, not resume the same child. The same-child corrective opportunity described below repairs result submission only, not missing task context.

Cancellation terminates the child process and waits for shutdown and owned cleanup before releasing the serialized queue. Rendering retains up to 50 KiB of UTF-8 report text plus a truncation notice; accepted structured reports remain in tool-result or lifecycle-message details. Transport and diagnostics are separately bounded, not retained without limit.

## Exact completion protocol

One host builder binds `guild/2` version 2 to a run ID, unique task ID, canonical role/profile, and original task text. It does not infer scope, acceptance criteria, or write leases from prose. Blocking agent tools, direct commands, and editor input share the blocking runner; background tools use the retained RPC runner. Both paths use host-owned `completed`, `failed`, or `cancelled` outcomes. Legacy persisted prose reports remain displayable, but cannot complete a new handover.

Children must submit `guild_submit_result` **alone in its tool batch**, once. Common exact fields are `protocol`, `version`, `runId`, `taskId`, `role`, `profile`, `taskOutcome`, `compliance`, `summary`, `blockers`, `limitations`, and `payload`. `taskOutcome` is `succeeded` only with no blockers and all requested compliance satisfied; `blocked` requires a nonblank blocker. `compliance` is empty unless coder required TDD was selected. Required TDD needs one exact record with status `satisfied` (at least one same-command red nonzero/green zero claimed cycle) or `blocked` (nonblank reason, blocked task outcome). Missing execution or meaningful preimplementation red is blocked, not waived. Up to eight completed cycles are reportable; diagnostics and 1–4 evidence references per red/green observation remain child claims. Role payloads are:

- explorer: referenced `observations` and `unknowns`;
- architect: `decisions`, `contracts`, and `handoff`;
- coder: reported `changes` and `verification` commands/outcomes;
- reviewer: `scope`, severity-ranked `findings`, and `verdict`;
- writer: `artifacts` with `path`/`description`, `sources` with `reference`/`usage`, and `checks` with `check`/`outcome`. Succeeded requires at least one artifact; each supplied writer record field must be nonblank and NUL-free. No article body is carried in the report.

The new role retains `guild/2` version 2: reports are bound to one host-selected role and validated by the same-package parent/child schema, and existing role payloads are unchanged. Older packages do not understand the writer target.

Empty findings and unperformed checks are legitimate when reported honestly. Each string is at most 2048 UTF-8 bytes, each list at most 32 items, and the serialized result at most 48 KiB. Oversized or extra-key results are rejected, never truncated into apparent completion. Parent ingestion permits at most 1 MiB per JSON line, 16 MiB total stdout, and 64 KiB stderr. Pi's `agent_end` and `turn_end` events only repeat messages and tool results already streamed individually, so they are skipped unparsed and excluded from both limits. Exceeding transport bounds fails the run, including unusually large ordinary tool events. A child that stops on a provider error reports the provider's message in its failure diagnostic.

A malformed submission or prose-only completion gets **one shared corrective opportunity in the same child**. The next assistant response must submit the result alone; there is no respawn, queue re-entry, or reset on continued agent runs. Identity mismatch, mixed batches, duplicates, post-submission work, exhausted repair, missing handshake/settlement, process/provider errors, and cleanup failures fail closed. Cancellation and failure override a previously valid submission. Mixed-batch rejection is not a claim that sibling work never happened or was rolled back.

Reports, commands, changes, references, TDD cycles, and judgments are **child-reported claims**, not authenticated or host-certified truth. Fixed package core selection is host-owned: every coder selects `skills/code-comments/SKILL.md`, with `skills/tdd/SKILL.md` first when required TDD is requested; reviewer selects only `skills/code-review-standards/SKILL.md`; writer selects only `skills/content-craft/SKILL.md`; explorer and architect select none. Each selected raw valid UTF-8 core must be a canonical regular package file <=32 KiB; missing, symlinked or oversized cores fail before child launch. Its complete content is embedded with absolute source and references-directory anchors, not loaded via ambient skills or references preloading. Details receipts record package-relative path, byte count and SHA-256 of injected raw bytes; they attest selection, not authenticity, child attention, or test execution. Host role/tools/protocol overrides required practice, which overrides general skill exceptions. For optional parent-selected reviewer work, the caller supplies the self-contained review brief above in the task (not coder practices), with an author report if available; the reviewer classifies claims as corroborated/contradicted/unverified. No automatic reviewer pipeline is installed. These guardrails are not a filesystem sandbox. Tool failures carry structured terminal details and are marked as errors through Pi's `tool_result` hook. Known usage is retained on failures/cancellation: `usageFields` identifies fields actually observed, totals may be partial, and `usageKnown: false` means the numeric compatibility placeholders must not be read as measured zero usage.


## Development

```bash
cd pithos.guild
npm ci
npm test
npm run typecheck
npm pack --dry-run
```

The exploratory RPC compatibility probe requires an explicitly selected installed Pi **1.4.0** runtime:

```bash
npm run test:rpc-compat -- /path/to/pi/dist/cli.js
```

Alternatively, set `PI_RPC_PROBE_CLI` to that CLI path. There is no default runtime, and the probe rejects other versions. This is not a production RPC transport or certification of Pi >=1.0 compatibility, live-provider behavior, the Guild protocol, or Plan-mode quiescence; local 0.99 test doubles are not evidence for this probe.

### Background qualification and shared scheduling

#### Deployed Pi 1.5.0 release checks

`test:deployed-runtime` checks the exact Pithos-shipped Pi 1.5.0 deployment manifest and installed output hashes before copying the runtime into an isolated test directory. It runs the existing **16 connected cases** plus a separate idle-parent question test. The latter releases a child question only after the native parent turn has settled, then requires one automatic notice and response **without `guild_wait` or `guild_status` polling**, followed by an exact reply to the same child.

To check the actual npm package rather than checkout source, run from the repository's `pithos.guild` directory inside the Pithos container:

```bash
packdir=$(mktemp -d)
npm pack --pack-destination "$packdir"
tar -xzf "$packdir"/pithos-kit-guild-*.tgz -C "$packdir"
PATH=/usr/bin:/bin:"$PATH" npm run test:deployed-runtime -- \
  /opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent \
  /opt/pi-guild-runtime/versions/1.5.0/manifest.json \
  "$packdir/package"
```

The packed Guild version must match the checkout running the probe. The host manifest is separately pinned: arbitrary manifests and changed installed outputs are rejected, not accepted by version number alone. The runtime and Guild source/assets come from the selected inputs; Plan and test fixtures come from the checkout. These checks use the real SDK/InteractiveMode, terminal I/O doubles, local scripted responses, and in-process child runners. They do not replace actual-child transport checks or certify a physical terminal, every provider, or future Pi versions. The launcher checks its protected installed hashes again and removes its temporary runtime after the workers close. Dependencies are read-only by convention, not an OS sandbox.

Ordinary `npm test` runs the portable manifest and release-version checks. The installed-file mutation and packed-runtime integration tests are opt-in through `GUILD_DEPLOYED_TEST_ROOT` and `GUILD_DEPLOYED_TEST_PACKAGE`; their default skips are not evidence of deployment qualification. Require a successful exit from the explicit deployed command, including the separate idle test.

The current release check passed on the launcher's **Node 24.22.2**: all **16 connected cases**, the separate idle-question case, and all **4 validation tests with deployment checks enabled** against a real **70-file npm package**. The default Guild suite reported **921 passed and 2 opt-in skips**, with those deployment checks run separately; typecheck, Plan **391**, Atlas **127** plus typecheck, and root **3** also passed. Local evidence is in `/tmp/guild-release-15-parent-*.log`; temporary logs are not published attestations.

#### Original Pi 1.4.0 evidence

The original exact-source [Pi 1.4.0 proposal](../proposals/pi-interrupt-hook/README.md) has distinct historical proof sets: **8 masked legacy cases** qualify atomic fallback, **16 unmasked connected cases** qualify bounded automatic continuation, and **42 portable tests** cover host contracts. The connected run uses actual Pi 1.4.0 SDK/Runtime/InteractiveMode and packaged Plan, both registration orders and SDK/public-editor Enter routes, terminal I/O doubled, local zero-usage transport and in-process children. It checks held receipt phases, 3 occupied + 8 queued slots and twelfth refusal, coalescing, cleanup, commit boundaries, interrupt/fresh intent, native input priority, tree/reload vetoes and accepted transitions, shutdown and nonjoining closure. Known 80-token/$0.8 child usage is collected once; nested waits claim none. Fixture zero usage does not predict real-provider usage.

From `pithos.guild`, select explicit inputs (overlay launchers have no defaults):

```bash
npm run test:semantic-runtime -- /path/to/patched-source /path/to/installed-package "$PWD/node_modules/typescript/lib/typescript.js"
npm run test:continuation-runtime -- /path/to/patched-source /path/to/installed-package "$PWD/node_modules/typescript/lib/typescript.js"
npm run test:background-runtime -- /path/to/pi/dist/cli.js
```

The continuation default requires all 16 cases; focused `--case` runs remain `qualified: false`. Separately, the actual RPC probe used stock CLI 1.4.0 and a local scripted provider: three distinct PIDs alive together in one empty shared cwd with separate HOME/config, retaining PID/run/task/native ASK toolCallId through answer/report, two requests each, completion order 2,0,1, real close and temporary cleanup, no persisted child sessions. Native toolCallId is not the registry question token. This is transport evidence, not shared-writing collision safety or proposal CLI/background-host qualification.

Parent logs `/tmp/guild-completion-parent-{native16,shared-rpc,tests,typecheck,pack}.log` record 16/16, actual RPC, Guild **919**, typecheck and a **70-file** package dry-run. Selected provider-source checks record **543 passed/36 configured skips** (43 passed/4 skipped files), plus root TypeScript checking in `/tmp/guild-command-parent-provider543{,-tsc}.log`, not the full upstream suite/build. The final parent sweep also passed Plan **391**, Atlas **127** plus typecheck/23-file dry-run, root **3**, stock shutdown/navigation/Plan probes **8/9/10**, the three-worker accounting probe and RPC compatibility probe (`/tmp/guild-completion-parent-*.log`). These are local evidence, not published attestations; no physical TTY, live-provider or broad-version certification is claimed.

One factory-created `GuildExecutionRuntime` per `registerGuild` now owns blocking tool/direct scheduling and shutdown drain through the same private execution authority and registry. Its internal scheduler defaults to three active coder/reviewer background operations and eight pending background operations, independently of the unbounded blocking backlog. A single FIFO and exclusive barriers prevent background work from overtaking already admitted blocking work. Any nonterminal background record (queued, running, waiting, or stopping) refuses new blocking admission; retained terminal records alone do not.

The default runtime composes the real background runner lazily; qualified hosts expose the five background tools described above. Blocking reports still use their existing result path rather than background records. Blocking lifecycle and live Plan admission are connected as described below; semantic interrupt integration requires a qualified host. Ordinary Plan-free blocking remains available, without treating silence as proof of Plan absence. Tests using injected runners and stable participant leases verify these scheduling contracts, not actual-runtime, provider, or completed cross-package integration.

### Execution authority

`GuildExecutionAuthority` owns explicitly activated registry generations behind opaque, frozen, identity-only owner tokens. Retirement invalidates facade access synchronously, closes admission, and joins the old registry's actual cleanup before another activation is allowed; it never activates a replacement automatically. Shutdown is terminal and joins in-flight activation or retirement. Failed activation or unprovable cleanup fails closed. Factories transfer fresh, unused synchronous registries exclusively; already-claimed registries cannot be transferred to another authority. A factory remains responsible for resources it throws without returning. Operations must not await a retirement/shutdown join that owns their own cleanup.

The frozen Plan participant and its independent owner leases survive registry replacement, bridging held protection into each new registry before publication. Observational waits detach caller/scope abort listeners and reject stale delivery after invalidation; caller cancellation does not cancel the run. Previously accepted exclusive results and cancellation joins can settle after retirement, but remain bound to the old registry.

Live registration initially activates one owner for both existing blocking entry paths and joins terminal shutdown on `session_shutdown`. Its factory must transfer a fresh, inactive synchronous runtime; rejected reuse does not shut down the original owner. Native tree retirement now invalidates that scope and fences its UI, trace and result callbacks; only fresh eligible intent can activate a replacement scope on the same runtime. Background policy is enforced by the admission facade below. Stock Pi has no installed interrupt capability; conditional tool exposure neither infers Plan absence nor certifies Pi >=1.0 compatibility.

### Internal background admission policy

`createGuildBackgroundAdmission` in `src/background-admission.ts` is the synchronous admission facade over the execution authority and trusted coordination bus; public background tools use it through the runtime. It captures `PITHOS_GUILD_PLAN_MODE` from the parent process environment once at factory construction (tests may inject a parent environment). An unset value defaults to `required`; only exact `required` and `standalone` values are accepted. Empty, whitespace, case variants, nonstrings, and configuration read failures permanently block that facade's background admission without throwing during construction. Later environment changes do not change the captured policy. Mode is never a start/tool-input or child argument.

Required mode needs exactly one synchronous compatible inactive Plan provider. Missing, active, uncertain, incompatible, duplicate, or unstable providers block admission. Explicit parent `PITHOS_GUILD_PLAN_MODE=standalone` permits zero synchronous replies only; any on-stack reply conflicts with that assertion. Silence is never evidence of Plan absence. As with discovery, late replies are inert: a required handshake cannot be established by a late reply, and standalone relies on the parent's explicit assertion, not asynchronous inventory detection.

Both modes require safely captured inactive persisted branch state. The facade copies only scanner-relevant own data, rejects unsafe relevant persistence shapes, validates and privately copies canonical coder/reviewer input before discovery, attaches the authority's stable participant, then rechecks persistence, provider identity/generation/phase, reentry, and the exact current owner immediately before reservation. Nested admission attempts veto the outer attempt even if caught. Failed admission never detaches coordinator protection or releases independent holds. Existing blocking `guild_handover` and `/guild-handover` retain their ordinary Plan-free behavior under every background setting; their final admission uses the safe persistence reader and live Plan coordination on the shared exclusive scheduler.

Tests exercise this facade with real registries, authorities and Plan coordinators and injected operations. Registration supplies the bus and captured parent policy to the composed runtime, with conditional public adapters, notifications and explicit collection accounting. These tests are not runtime certification; the blocking Pi minimum remains >=1.0. This is trusted-extension cooperation, not a malicious-extension sandbox; a bus swallowing a handler throw after a valid reply remains undetectable.

### Background runtime composition

`createGuildBackgroundRuntime` in `src/background-runtime.ts` composes a private admission facade and execution authority with the real `runBackgroundGuildRole` executor. Explicit activation creates fresh registries; its frozen facade exposes only owner-scoped operations, retirement/shutdown joins, and the stable Plan participant. Host-allocated run/task identities bind independent host envelopes to validated terminal projections. No raw registry, runner control, or ungated start is exposed.

Each start captures primitive process settings and synchronous observer references before discovery and vetoes nested starts even when a context getter catches the nested error. The captured `getBranch` runs with its original context receiver for both synchronous admission checks, so receiver-dependent readers observe live branch state. Neither the reader nor its receiver enters the queued execution binding. Per-run bindings travel separately from protocol input and snapshots, including while queued. Questions forward their exact lifetime signal into the registry and replies remain owner/run/question-bound. Observer delivery is fenced by both owner identity and run liveness; thrown errors and accidental rejected promises are observed without owning transport. This is a **synchronous observer contract**, not cancellation of arbitrary asynchronous host side effects.

Offline vertical tests enter this facade and launch actual scripted subprocesses: three simultaneous asking children resume their original PIDs with out-of-order replies, queued work retains its admitted envelope/settings, and malformed reports fail projection. Explicit child signal gates and a runner-seam cleanup barrier verify cancellation, retirement, and shutdown retain ownership through real close and cleanup, without launching cancelled queued work. Tests also exercise required-mode admission with the real inactive Plan coordinator and explicit captured-parent standalone policy. Scripted blocked-TDD reports remain blocked reports within completed transport; these are fixture claims, not evidence of task-level TDD by a model.

Live registration now uses this composition under one authority: both blocking entry paths delegate through its generic exclusive facade without background projection. Registration captures the Pi events object and a frozen one-field parent `PITHOS_GUILD_PLAN_MODE` snapshot, not a session, branch, model, trust decision, UI, or working directory. The narrow synchronous emit adapter preserves the events receiver. Construction, activation, and shutdown do not discover Plan, attach participants, subscribe to the bus, or launch a background child. Blocking admission now performs Plan discovery with the stable runtime participant, rechecks inactive persisted state, provider readiness, reentry, and owner identity, then reserves synchronously. See the combined installed Guild–Plan probe below for the connected behavior and remaining limitations.

The current registration adds conditional background tools, manual controls, dashboard observation and collection accounting. Same-session native tree retirement/rearm is connected below. Background exposure requires the qualified host capabilities; the Pithos Pi 1.5.0 integration supplies them, while installing Guild alone does not. Source inspection of installed Pi 1.4.0's event bus supports synchronous on-stack delivery; its swallowed-handler-error limitation remains. The 0.99 development harness and these checks do not certify Pi >=1.0 compatibility. Qualification remains capability-specific; automatic continuation additionally requires the optional live-qualified context capability.

### Connected native tree retirement and fresh-intent rearm

The existing native navigator remains in use; no custom navigator or editor replacement is required. `session_before_tree` synchronously invalidates Guild's current generation and calls runtime retirement before awaiting the registry drain and Guild-owned execution/local-dialog cleanup tails. Queued work never launches. Owned custom dialogs close before panel/listener disposal; host-disposed dialogs have already revoked their native close callback. Widgets, status, progress and timers are cleared before the hook permits leaf mutation. Prompt-directory removal failures are host-only cleanup errors, not child task diagnostics; cancellation cannot erase them. Blocking execution rejects with a bounded cleanup error, and terminal shutdown retains that failure. A cleanup fault returns **`{cancel: true}`** and permanently fails this registration closed: throwing alone is insufficient because Pi reports and swallows hook errors. Repeated hooks share an in-flight join. A later navigation veto does not restart an old child or roll back retirement.

After successful drain, only fresh `interactive` or `rpc` input, or an explicit direct `/guild-handover` intent, may synchronously activate a new immutable scope on the **same runtime and Plan participant**. Activation requires a callable `ctx.isIdle()` returning true, safely read **current** inactive persisted branch state, an unchanged retired epoch, and no terminal shutdown. Reentrant context getters, navigation and activation callbacks cannot publish a replacement owner for the wrong epoch. Extension/unknown input, busy input, lifecycle events, timers and cleanup never bank intent or activate later. Help and roster do not activate. A retired direct command that is busy at entry returns unavailable rather than waiting to arm; an already-active command retains its original idle wait. Old idle waits, pickers, editors and callbacks retain their entry scope and cannot reacquire a newer one.

Rearm is **activation, not work admission**. An empty branch is persisted inactivity, not evidence that no Plan provider exists. Rearm reuses the background facade's policy-neutral safe persistence reader, without background discovery or configuration gating. Ordinary Plan-free blocking handovers therefore retain their existing behavior with unset, required, standalone or invalid background configuration. Background starts still use their originally captured strict policy and discovery. Independent Plan holds and attached coordinator protection, including disposal-held leases, survive activation; activation under a hold is allowed but execution is not. Rearm itself does not discover Plan; the subsequent blocking admission transaction performs that discovery before reserving work.

Transcript history remains session-owned and bounded across tree changes. Retired executions finish internally as cancelled without publishing old results onto the new branch, and old trace bindings unbind after execution cleanup. The recorder and whole transcript store are disposed only at terminal `session_shutdown`, which always shuts down the runtime even if no active scope remains. Unrelated native idle waits, pickers and editors are not joined; owned continuation preparation/run/publication/settlement callbacks are joined. Neither the before-tree hook nor input handler waits for host idle.

The installed Pi **1.4.0** source has been inspected: no-op navigation and earlier vetoes may skip Guild's hook; navigation is already busy when before-tree hooks run, and idle is restored in navigation's `finally`, not by `session_tree`. Unit tests invoke registered handlers with deterministic host doubles; they do **not** establish actual native event ordering. The opt-in installed-runtime probe now loads real `registerGuild` through Pi's public extension loader and exercises the connected paths described below, including the injected cleanup-failure veto. This historical stock-runtime probe did not install the semantic interrupt capability; it is separate from the current Pithos runtime integration. Background results now have session-owned observation and explicit collection; exposure remains conditional on host qualification.

### Installed native-navigation probe (Pi 1.4.0)

From `pithos.guild`, run:

```bash
npm run test:navigation-runtime -- /opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
```

The observed Pi **1.4.0** run reports **9 passed, 0 failed**, and exits zero. This completes the scoped navigation probe, not background host qualification. The worker uses the selected installation's public `discoverAndLoadExtensions` with exactly one explicit fixture and empty isolated cwd/agent directory. That fixture imports actual `src/guild.ts`; no Guild lifecycle handler or scheduler is copied. SDK and AI versions/paths are printed, and imported SDK/AI function identities verify the loader aliases to the selected installed graph rather than checkout 0.99 dependencies. On that stock host the registered tools remain exactly `create_commit` and `guild_handover`; no app-interrupt hook is installed.

Passing checks retain the original seven native `navigateTree` cases and add a swallowed foreign before-hook error: no-op and earlier veto do not retire Guild; held runner cleanup prevents target mutation and queued launch; success, later veto and genuine native summary rejection/abort leave Guild retired until fresh idle interactive/RPC input. Busy and extension input do not rearm, and a retired runner update cannot publish through the tool callback. Input goes through actual `session.prompt` with a later **handled-input sink** to prevent provider startup; this differs from normal continued prompting. Independent promise gates emulate runner cleanup, **not OS child processes**. Summary failures use only a local scripted transport.

The `cleanup-failure` case uses a disclosed **directory-metadata test seam**: Pi's public in-memory factory has no directory option, so only that isolated SessionManager instance's public `getSessionDir` is overridden to return the owned temporary directory for fake capture/trace observation. Directory metadata is therefore not unmodified. The actual SessionManager class, memory persistence, AgentSession, ExtensionRunner, navigation, lifecycle and idle methods remain real. The fake trace unbind is counted and throws once; native navigation returns cancellation with no extension error, no leaf mutation and no `session_tree`, and fresh user input cannot reactivate the failed Guild runtime. Because Pi swallows thrown hook errors, cancellation plus skipped later hooks and zero errors establishes an explicit hook veto rather than an exception mistaken for cancellation. An isolated temporary Guild source copy allowing extension input to rearm was rejected by the same probe; restoring the copy passed all nine cases. Production and installed-runtime safety controls were never mutated. Command picker/wait races, Plan holds, all background-policy variants, and full stale UI/message publication are not established by this probe. No Escape, full native TUI, live-provider, benchmark, or Pi >=1.0 certification is claimed.

The observed worker closes before temporary-directory removal and reports zero session JSONL and persistent auth/settings/model configuration files. Local execution evidence and diagnostics are recorded in `/tmp/native-guild-probe-finish-evidence.md` and `/tmp/native-guild-probe-finish-*.log`; these are local artifacts, not published evidence. The separate 575-test development suite, typecheck and package dry-run passed, but are separate from the installed-runtime evidence.

### Installed shutdown-runtime probe (Pi 1.4.0)

```bash
npm run test:shutdown-runtime -- /opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
```

The observed Pi **1.4.0** worker reports **four core cases passed**:
`before-switch-veto`, `replacement-drain`, `cleanup-fault-continuation`, and
`terminal-drain`, plus **four public `InteractiveMode` cases with terminal I/O doubled**:
`interactive-smoke`, `reset-before-shutdown`, `reset-before-shutdown-late-rejection`,
and `reset-before-shutdown-cleanup-fault`. The launcher reports **8 passed, 0 skipped**,
`complete: true`, and exits zero. Each UI case uses the selected installation's actual regular-mode TUI, not a physical terminal.

The public `AgentSessionRuntime` factory loads a fresh real Guild registration through
`discoverAndLoadExtensions` for every replacement, using the selected installed SDK/AI
graph and memory-only credentials, models, settings, resources and sessions. Actual
`newSession()`/`dispose()` dispatch shutdown; no lifecycle event or teardown is copied.
An earlier switch veto preserves the old session without shutdown or factory invocation.
Active and queued registered-tool calls exercise **in-process runner gates, not OS
children**. While cleanup is held, the running signal aborts, queued/new work cannot
launch, and host invalidation, replacement factory and rebind cannot proceed. On release,
trace unbind precedes host invalidation, old contexts become stale before the fresh
factory, and the freshly bound registered tool can execute. Saved old tool/update
callbacks remain inert. Terminal disposal drains without replacement; this Pi version
retains the disposed session reference, whose extension context is stale.

The draining cases and UI smoke use a disclosed **metadata-only `getSessionDir` override** on each
in-memory SessionManager for fake capture/trace observation. Memory persistence and
actual lifecycle methods remain unchanged. The cleanup-fault case throws synchronously
from fake trace unbind: the active execution rejects, Pi reports exactly one
`session_shutdown` error, and **replacement continues**. A thrown shutdown error is not
a switch veto. An isolated copied-Guild mutation omitting the returned shutdown join
fails the held-cleanup assertion; restoring the copy passes all four core cases.
These are integration pins of existing behavior, not newly implemented production logic.

The UI case calls public `InteractiveMode.init()` (not `run()`) with a bounded terminal
I/O double, preserving the mode's real invalidation/reset and session-rebind callbacks.
An observer captures each real `session_start` context. The old context sets a draft;
actual `session.prompt("/guild-handover coder/general ...")` renders Guild's native custom
progress card and records its started lifecycle message without a provider. A temporary
public widget factory observes the actual `TuiMainScreen` and its focused component;
it neither replaces the editor nor changes focus. The progress card takes focus, and
owned shutdown returns focus to the original editor before host reset. Replacement
aborts the held runner and closes Guild's owned dialog, restoring the old draft, but
cannot replace the session until runner cleanup and trace unbind finish. Real mode rebind
supplies a distinct fresh context; saved old update/event callbacks and command-tail
settlement cannot change its new draft or publish terminal lifecycle messages into either
session. The old context is stale. An isolated copied-source mutation omitting the shutdown
join also fails this UI case's held-replacement assertion; revoking without closing the
owned dialog fails its editor-focus assertion. Restoring each copy passes.

The terminal starts/stops once; cleanup calls `runtime.dispose()` then `mode.stop()` to
release the real UI's resources. The worker uses an isolated minimal environment, bounded
output and a deadline. The launcher observes actual process close before verifying zero
session JSONL and persistent auth/settings/model files and removing the directory. SDK,
AI and TUI identities resolve to the selected installed **1.4.0** graph. The four core
cases retain their observer seams; the UI case does not replace mode lifecycle callbacks.

The three reset-first cases invoke a registered public command's bound `ctx.reload()`
while native progress is focused and the host is neither streaming nor compacting.
A public widget disposal observer writes `reset-draft` after native dialog reset, before
`session_shutdown`; native custom/done and mode lifecycle methods are not replaced.
Guild's locally owned command settles while runner cleanup is still held, without
restoring the old draft or publishing a terminal lifecycle message. Reload waits for
release, retains the same AgentSession, and uses a mutable public ResourceLoader to
rediscover a fresh registration and ExtensionRunner. Saved stale callbacks remain inert.
The late runner rejection is sanitized under the retired scope with no public extension
error. The trace-unbind fault throws `scripted-trace-cleanup-failure` after release;
exactly one old-runner public `session_shutdown` error (`Guild shutdown cleanup failed`)
is observed, and reload still succeeds rather than treating the error as a veto.
Fresh registered-tool execution and final disposal succeed in all three cases; error
observers stay attached through final disposal and mode stop. Isolated-copy mutations
restoring stale dialog completion or disabling the trace fault are rejected by these
pins. These are integration pins, not new production behavior.

This covers shutdown-before-reset and these normal/failure reset-before-shutdown reload
paths, not all lifecycle races. No physical terminal, semantic Escape/raw-key behavior or hook,
provider request, Plan integration, OS-child cleanup, performance, or Pi >=1.0 certification
is established. Local evidence is in `/tmp/shutdown-core-evidence.md` and
`/tmp/shutdown-ui-evidence.md` and `/tmp/guild-reset-first-final-evidence.md`; temporary
artifacts are not published proof. These historical shutdown checks do not qualify
background exposure; that requires the capability gate described above.

### Combined installed Guild–Plan probe — admission, native tree and interactive exit

Run `npm run test:plan-runtime -- /opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`
from `pithos.guild`. The probe against the unchanged Pi **1.4.0** runtime exits **0**:
**10 passed, 0 failed**: five cases in each public-loader registration order. While registered
Guild work is held with the actual host context idle, real `session.prompt("/plan")`
refuses entry without changing persisted inactivity or the tool loadout. After drain,
Plan enters, active Plan rejects Guild before runner/capture/trace binding, and
`/plan exit` without a checkpoint publishes nothing and restores Guild admission.
The probe only inspects the real bus provider; it never preattaches a participant.

The two additional cases use fresh buses, registrations and memory-only runtimes:

- **`held-navigation-and-fresh-owner`** holds a registered Guild runner and queues
  another invocation. Actual `session.navigateTree(target, {summarize: false})`
  aborts the runner, but cannot mutate the old leaf or emit `session_tree` until
  cleanup and trace unbind finish. Queued work never launches. RPC input cannot
  rearm while busy; `/plan` receives the **generic host-busy warning**, not evidence
  of a coordinator lease. At true idle, `/plan` succeeds while Guild remains retired;
  active persisted Plan prevents fresh-input activation and the retired tool cancels
  without capture/bind/run. After no-checkpoint `/plan exit`, extension input does
  nothing and fresh interactive/RPC input activates exactly one owner. Holding a
  second Guild runner while the host is idle makes `/plan` receive the distinct
  **coordinator-busy warning**, without changing Plan entries/tools or aborting Guild.
- **`branch-roundtrip-reconciliation`** first runs Guild to attach its real stable
  participant, then creates genuine active state via `/plan`. An active-owner Guild
  attempt is rejected before capture/bind/run. Native navigation to the inactive
  assistant branch restores inactivity and the original tool loadout, preserving the
  same plan identity. Navigation back to a saved assistant marker restores genuine
  active Plan state and Plan tools without another `/plan`; fresh input cannot rearm.
  Returning inactive, awaiting idle, and sending fresh intent permits one new owner
  and actual registered Guild execution.

Neutral public observers bracket both real extensions. Plan has **no
`session_before_tree` handler**: Guild drains before leaf mutation in either order.
The first tree observer sees the selected branch; the last sees actual Plan
reconstruction. Provider instance identity remains stable and generation changes are
recorded observationally. Plan may append state after the event's `newLeafId` was
captured, so final selection is checked by target ancestry, not leaf equality. A
single final-observer gate demonstrates **post-reconciliation host busy** even with
an inactive provider; it does not claim to observe a naturally suspended `reconciling`
phase. All before/tree observers see nonidle, followed by true idle after navigation.
Only initial branch construction uses `SessionManager.branch`; after binding,
selection uses native navigation exclusively. The active marker is a zero-usage
assistant message, never invented Plan state.

Fresh-input tests use real `session.prompt` dispatch and a final neutral handled-input
sink to prevent model startup. A transparent execution-runtime wrapper counts
activation while delegating to the real implementation. No lifecycle/coordinator
handler is replaced. The launcher checks exactly sixteen normal JSON-mode notices
in order after actual process close; unexpected bus errors, chooser fallbacks and
teardown warnings remain failures. All fixture gates release in cleanup and actual
`runtime.dispose()` runs with zero extension errors and agent starts through disposal.

This supersedes the earlier milestones' pending live-blocking-discovery statements.
Blocking tool/direct admission now attaches the stable runtime participant to one
compatible inactive provider, rechecks safe persisted state and the original provider,
and reserves synchronously. Zero on-stack replies with safe persisted inactivity
preserve legacy blocking permission under every background setting; this is **not
proof of Plan absence**. Background required/standalone policy is unchanged. Queued
start, post-capture and post-bind checks prevent downstream launch on changed state;
a post-capture refusal does not undo the snapshot. Trace unbind remains inside exclusive
ownership. Construction, help, roster, activation and shutdown do not discover Plan.
The bus remains trusted cooperation: a swallowed handler throw after a valid final
on-stack reply is undetectable.

The original eight cases use JSON/non-UI execution of the registered tool definition
with real host context, not model-issued tool calls. The additional
**`interactive-plan-and-direct-guild`** case runs in both orders with fresh real
registrations and `InteractiveMode`, using a terminal-I/O double rather than a physical
TTY. The public resource loader parses the packaged absolute-path Plan theme, and mode
initialization registers it. The actual `session_start` context reports the initial
`system` theme; `/plan` changes it to `plan`, and native `/plan exit` restores exactly
the captured original name and tool loadout. The no-checkpoint selector is rendered
by Pi, and Enter through the terminal input callback chooses its first option,
**Exit without publishing**; no selector or completion callback is replaced.

Before entry, a held real `/guild-handover coder/general ...` command renders Guild's
native progress and takes editor focus. With the actual context idle, `/plan` refuses
coordinator-busy entry without changing entries, theme, tools or runner cancellation.
Releasing the runner returns focus. Active Plan vetoes another direct handover without
capture, bind, runner launch or lifecycle publication. After native exit a direct
handover runs again. The runner returns a cancelled transport result, not a successful
role report. A public additive error observer is installed before mode binding and
retained through final runtime disposal; terminal starts/stops are exactly one each.
The sixteen JSON stderr notices remain exact; interactive notifications stay in the
captured terminal stream.

An isolated-copy mutation replacing Plan's theme restoration with a no-op fails both
interactive cases (`plan` instead of `system`) while the original eight pass. Restoring
the copied source passes all ten. Local evidence is `/tmp/plan-tui-probe-evidence.md`;
these are integration pins, not production implemented test-first. Sessions,
credentials, models and settings are memory-only; a metadata-only `getSessionDir`
override supports fake capture/trace, and the runner is an in-process gate, not an OS
child. Actual runtime disposal, zero agent starts/extension errors, bounded isolation,
process-close-before-removal, and zero Plan Markdown, session JSONL and persistent
configuration files are checked. Earlier blocking evidence is
`/tmp/plan-blocking-evidence.md`; native-tree evidence and the owned delta are
`/tmp/plan-tree-probe-evidence.md` and `/tmp/plan-tree-probe-owned.delta`. These are
local artifacts, not published proof. A source-guard mutation in an isolated package
copy makes the new held-navigation case fail on extension-input activation (2 instead
of 1); restoring the copy passes all eight. Live production and installed controls
were never mutated. These are integration pins of existing behavior, not a claim
that production was implemented test-first. Guild **608**, Plan **391**, root **3**,
navigation **9**, shutdown **5**, Guild typecheck and package dry-run also passed.
Independent review findings were fixed and re-reviewed. The interactive pin now
checks exact operation-specific refusal messages, rejects enumerated rendered
failure/fallback notices, and verifies unchanged Plan identity and absent checkpoint
and publication metadata across native exit. Missing-notice polling terminates on
its own deadline rather than leaving timers for the outer watchdog to kill.
Parent verification confirmed all 582 recorded outside-scope files unchanged.
Final suite evidence is in `/tmp/plan-tui-verified-parent-{guild,plan,root}.log`;
follow-up polling evidence is in `/tmp/plan-tui-notice-deadline-{negative,green}.log`.
Preservation is recorded in `/tmp/plan-tui-verified-parent-preservation.json`.
That historical probe claims no full Plan publication or
restoration-failure coverage, native Escape behavior, provider,
physical-terminal or broader Pi compatibility certification; it introduced no runtime,
dependency, public background tool or Plan production change.

### Background registry adapter contract

`src/background-result.ts` provides the `projectBackgroundResult` adapter used by the background runtime. It checks runner identity against the host task and validates any report before returning an independent JSON copy. `completed` requires a report and zero exit code; it denotes transport completion, so a blocked report can still be completed. Failed or cancelled results retain their non-success status even when they contain a report. The projection omits task text and raw/rendered output, bounds diagnostics to 2048 UTF-8 bytes, and rejects a serialized DTO larger than 64 KiB rather than truncating its report. Projection errors must reject the operation, never become fulfilled success-shaped fallbacks; settlement must follow owned cleanup.

`src/background-runs.ts` defines a registry-level contract, not a guarantee of end-to-end Pi integration. An operation must settle only after its owned cleanup finishes. Fulfilled JSON means transport completion, not a validated Guild report; the adapter remains responsible for report validation and process-kill deadlines.

When composing `runBackgroundGuildRole` with the registry, forward the runner's `onQuestion(text, questionSignal)` lifetime signal to `ask(text, questionSignal)`. An unavailable answer or transport shutdown aborts that question lifetime. Independent cancellation while its matching ask is pending fails the run; an already-aborted run is not reclassified as failed by this signal, preserving manual/shutdown cancellation. Settlement removes the lifetime listener, and replies must match the current pending question ID, so stale signals or replies cannot affect a later question. The runner retains ownership until child close, even after its SIGKILL deadline; registry operation settlement must also await owned cleanup.

Registry Plan holds require idle admission: nonterminal background records (including waiting or stopping work) and outstanding exclusive operations make acquisition return `busy`. Retained terminal results do not prevent a hold. Repeated acquisition by the same owner returns the same lease; independent owners must each release their holds before admission can resume. Releasing a stale lease cannot remove a renewed hold or reopen a shut-down registry. These registry guarantees alone do not certify cross-package Plan-mode safety.

### Plan coordination helper contract

Guild's `src/plan-coordination.ts` and Plan's `extensions/plan-coordination.ts` share the internal v1 `pithos.plan.coordination` contract without a runtime package dependency. This is cooperation between trusted extensions, not a malicious-extension security boundary. Coordinator instance and generation objects are process-local identities, never persisted IDs.

`discoverPlan` returns a snapshot, **not an admission grant**: rediscover/revalidate immediately before admission. The trusted caller supplies presence and persisted-state evidence; discovery cannot establish either. Persisted state must be `inactive`. Zero replies permit readiness only with explicit `presence: "absent"`; silence with `present` or `unknown` does not imply absence. Otherwise discovery requires `present` and exactly one compatible, synchronous, inactive provider. Supplying a participant attaches it and rechecks instance, generation, and phase; omitting it is inspection only. Handlers must reply on-stack as their final synchronous operation. Late replies are inert, and a bus that swallows handler errors cannot expose a throw after a valid reply.

Coordinator attachments last for its lifetime. Transitions out of inactivity acquire participant holds; valid `busy`/`unavailable` refusals are retryable, while acquisition/release contract faults permanently poison that coordinator. The owner must finish tool/theme/state reconciliation and establish persisted inactivity before `confirmInactive` releases protection. Disposal deliberately retains holds rather than reopening admission. These are helper-level contracts, not certification of runtime wiring, Escape cancellation, or Pi branch-navigation behavior.

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
