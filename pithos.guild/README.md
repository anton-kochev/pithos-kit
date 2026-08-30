# guild

A standalone Guild of .NET, Angular, TypeScript, Node.js, and Rust architecture and implementation members with repository-aware Clean Architecture, code-review, Conventional Commit, and test-driven development guidance for [pi](https://github.com/earendil-works/pi-mono).

The extension adds agent-callable `guild_handover` and controlled `create_commit` tools, plus interactive `/guild-handover` and `/commit` commands. Every handover starts an isolated, ephemeral pi process with a focused system prompt and a hard tool allowlist. The child inherits the parent session's active provider, model, thinking level, working directory, and project-trust decision.

## Install

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

## Guild members

| Member | Role | Tools |
|---|---|---|
| `dotnet-architect` | Read-only .NET architecture, reviews, contracts, test plans, and implementation handoffs | `read`, `grep`, `find`, `ls` |
| `frontend-architect` | Read-only front-end architecture, state ownership, boundaries, routing, rendering, and API contracts | `read`, `grep`, `find`, `ls` |
| `typescript-architect` | Read-only TypeScript/Node.js module, package, runtime, async lifecycle, state, compatibility, and Pi extension architecture | `read`, `grep`, `find`, `ls` |
| `csharp-coder` | Scoped C#/.NET implementation, related tests, builds, and verification | `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash` |
| `angular-coder` | Scoped Angular implementation, related tests, type-checking, linting, and builds | `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash` |
| `typescript-coder` | Scoped TypeScript/JavaScript implementation, migration, tests, type-checking, linting, and builds | `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash` |
| `rust-coder` | Scoped Rust implementation, compiler-error resolution, tests, linting, and builds | `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash` |
| `rust-architect` | Read-only Rust architecture, structural reviews, contracts, refactoring plans, and implementation handoffs | `read`, `grep`, `find`, `ls` |
| `code-reviewer` | Read-only, language-aware review of repository changes with severity-prioritized findings | `read`, `grep`, `find`, `ls`, `bash` |

Architect members cannot edit files or run shell commands. The reviewer cannot edit files and uses shell access only for non-mutating repository inspection. Coder members own related tests and verification and must not report success when relevant checks fail.

## Code-review standards skill

Guild owns the language-neutral `code-review-standards` skill for focused, evidence-based reviews with impact-calibrated severity and deterministic Request changes, Comment, or Approve decisions. When Guild is installed and this resource is enabled, Pi-native model-visible discovery lets the main agent and Guild child processes load it proactively without requiring explicit skill invocation. A temporary parent-only `pi -e` run does not guarantee child discovery unless Guild is also installed and enabled for the child. The skill can also be loaded directly when desired:

```text
/skill:code-review-standards [review scope]
```

The methodology honors explicit commits and ranges or inspects staged, unstaged, and relevant untracked changes; detects supported languages, frameworks, and runtimes from repository evidence; and produces the same findings-first report as `code-reviewer`. It never treats an inspected scope as proof of perfect code or claims verification that was not run.

Use `pi config` or `pi config -l` to disable this resource, then run `/reload`. The `code-reviewer` remains self-contained when the skill is disabled: its built-in prompt retains the hard read-only boundary, severity framework, scope discovery, and deterministic report contract.

## Test-driven development skill

Guild owns the language-agnostic `tdd` skill used for explicit or proactive test-driven development. Load it directly with optional task context:

```text
/skill:tdd [task context]
```

The skill drives behavioral changes through a test list and small red-green-refactor cycles while allowing pragmatic exceptions for spikes, trivial declarations, generated output, and other work that does not benefit from test-first ceremony. Pi exposes the skill to the main agent and to Guild child processes through native skill discovery.

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

Ask the main agent to hand a self-contained task over to a Guild member:

```text
Use dotnet-architect to design the order cancellation workflow.
Use frontend-architect to define state ownership for checkout.
Use typescript-architect to design package boundaries and async lifecycle contracts.
Use csharp-coder to implement the approved cancellation design.
Use angular-coder to add the checkout loading and error states.
Use typescript-coder to make the API client errors type-safe.
Use rust-coder to resolve the parser's ownership errors.
Use rust-architect to redesign the workspace crate boundaries.
Use code-reviewer to review the current change for merge-blocking defects.
```

The main agent invokes:

```text
guild_handover({ member: "csharp-coder", task: "...scope and acceptance criteria..." })
```

Delegate directly from the interactive TUI without asking the main agent to invoke the tool:

```text
/guild-handover
/guild-handover csharp-coder
/guild-handover csharp-coder Implement validation and run the tests
/guild-handover --help
```

With no member, the command opens a roster picker. With no task, it opens a multiline task editor. The command waits for the main agent to become idle, applies the same member discovery and project-override approval as the tool, and then runs synchronously in a cancellable live handover card. Direct command execution is intentionally TUI-only.

List the active roster and definition sources without executing a member:

```text
/guild
/guild --help
```

Both commands also accept `-h`; help returns before discovery, UI prompts, idle waits, or child execution.

## Live transparency

While Guild members are executing, the extension shows a compact active-run panel above the editor:

```text
Guild · 2 active
 ● dotnet-architect · 5s · 2 turns
 ● angular-coder · 49m 38s
```

The panel intentionally keeps only live identity and timing that are useful while a handover runs. Task and output stay in the chat, while static run configuration is omitted from the transient panel. Text colors follow the active Pi theme, while a dedicated light/dark violet background distinguishes the Guild panel from standard pending-tool cards. The summary and each active run have their own truncated line, framed by half-block edges that create balanced half-row padding and a half-row visual gap before the editor. `guild_handover` also has a custom tool-call card and a compact completion card whose full output is available through normal tool expansion.

Agent-invoked handovers use the aggregate dashboard shown above. A direct `/guild-handover` instead uses a compact, width-capped live card with a spinner, elapsed time, turns, current child-tool activity, and the configured cancellation hint:

```text
╭─ ✦ Guild Relay ───────────────────────────────────────────────────────── [● Running  00:12] ─╮
│  dotnet-architect · built-in · read-only                                                     │
│  Request  Explore the repository for .NET artifacts                                          │
│  ⠋  Scanning repository · find · 2 turns                               escape/ctrl+c cancel  │
╰──────────────────────────────────────────────────────────────────────────────────────────────╯
```

The activity label is derived from actual child tool events rather than an invented progress percentage. Completed reports render as Markdown in a neutral framed card; failed runs receive a diagnostics section, and cancellations use a compact terminal treatment.

While agent-invoked work is running, the footer reports the active count and the aggregate panel updates elapsed time and turns. Each stopped Guild member is removed from that live panel immediately. When the final active run stops, the `guild-dashboard` panel and footer status clear. Completed output and metadata remain on the corresponding tool result or direct-handover lifecycle message in the transcript.

A direct handover records a user-initiated `started` event and exactly one correlated terminal event. The started event is hidden visually because the live card already communicates progress, but both events remain available to the main agent on its next turn. They use `triggerTurn: false`, so completion never causes an automatic main-agent response. Member reports and failure diagnostics are explicitly delimited as task data rather than new instructions. Selection/editor cancellation creates no event; cancellation after execution starts records a terminal `cancelled` event.

Guild is independent of Pi's native specialist facility and does not observe its tool lifecycle or messages.

The first release intentionally supports one Guild member per invocation. Parallel tasks, chains, persistent member memory, and dedicated test-writer members are out of scope.

## Guild member overrides

The package always provides its nine built-in definitions. You can override a definition by creating a Markdown agent file in:

- User scope: `~/.pi/agent/agents/*.md`
- Project scope: `.pi/agents/*.md` in the current directory or an ancestor

Precedence is:

```text
project → user → built-in
```

Project definitions are considered only in trusted projects. Handing a task to a selected project override also requires explicit interactive confirmation; it is rejected when no UI is available.

An override uses this format:

```markdown
---
name: csharp-coder
description: Project-specific C# Guild member.
tools: read, grep, find, ls, edit, write, bash
---

Your project-specific Guild member instructions.
```

Names are limited to the bundled roster. Tool boundaries are hard policy: an override whose tools differ from the corresponding built-in role is ignored. This prevents read-only roles from gaining write access and architects from gaining shell access.

## Approved future Guild migration (not current behavior)

This Phase 0 section is documentation only: current Guild behavior and the `member` API remain unchanged until a later approved phase implements the cutover. The approved clean-break target uses stable role/profile identities, with these package-owned legacy mappings:

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

There is no user/global Guild layer in the target. The future cutover stops reading both `~/.pi/agent/agents` and `.pi/agents`; it does not delete either directory or its files. Arbitrary prompt overrides are not auto-converted. Repository facts move to `AGENTS.md`, while constrained repository profile and skill support arrives in later phases.

The aliases above are package-owned compatibility inputs. They do not change tools or authorization, and no alias sunset is promised.

## Isolation and resources

Each Guild member runs with:

- an isolated context window and no saved child session;
- the parent's current provider/model and thinking level;
- the Guild member's fixed tool allowlist;
- the parent's working directory and trust decision;
- normal trusted project context and skill discovery;
- extension discovery disabled in the child, preventing recursive delegation and unrelated extension behavior.

Cancellation terminates the child process and waits for it to stop before returning control. Model-visible output is capped at 50 KB; full output and run metadata remain in tool-result or lifecycle-message details.

## Development

```bash
cd pithos.guild
npm install
npm test
npm run typecheck
npm pack --dry-run
```

## Provenance

Most bundled Guild member prompts are adapted for pi from the MIT-licensed [Grimoire](https://github.com/anton-kochev/grimoire) project. The `typescript-architect` prompt is repository-native guidance informed by Pi's documented extension and runtime contracts. See [`NOTICE.md`](./NOTICE.md).
