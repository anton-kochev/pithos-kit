# telos

Repo-scoped structured task tracking for pi.

Telos adds a `/tasks` command and an agent-callable `telos_tasks` tool. Tasks persist in the current repository's `.pi/telos-tasks.md`, so they survive pi sessions and remain inspectable outside pi.

## Install

```bash
pi install npm:@pithos-kit/telos
```

Pin to a version:

```bash
pi install npm:@pithos-kit/telos@<version>
```

For local development from a checkout of [`pithos-kit`](https://github.com/anton-kochev/pithos-kit):

```bash
pi install ./pithos.telos
pi install ./pithos.telos -l   # project-local
```

Temporary test run:

```bash
pi -e ./pithos.telos
```

## Pithos `.pithos` config

```yaml
pi:
  extensions:
    "@pithos-kit/telos": "npm:0.3.0"
```

## Usage

Inside pi:

```text
/tasks
/tasks list [--archived|--all]
/tasks create [--priority low|medium|high|urgent] [--status todo|in_progress|blocked|done|archived] [--notes <notes>] [--depends <id[,id...]>] <title>
/tasks show <id>
/tasks update <id> [--title <title>] [--priority low|medium|high|urgent] [--status todo|in_progress|blocked|done|archived] [--notes <notes>] [--depends <id[,id...]>]
/tasks status <id> <todo|in_progress|blocked|done|archived>
/tasks complete <id>
/tasks reopen <id>
/tasks block <id>
/tasks archive <id>
/tasks delete <id>       # rejected; use archive instead
/tasks --help
```

`-h` is also accepted, and help returns before reading or changing the task artifact.

Examples:

```text
/tasks create --priority high "Implement Telos MVP"
/tasks list --all
/tasks update TSK-abc123ef --notes "Waiting on review"
/tasks create --depends TSK-abc123ef "Build on existing task"
/tasks complete TSK-abc123ef
/tasks archive TSK-abc123ef
```

`/tasks` with no arguments opens a read-only interactive task list when pi has an interactive UI. Use `↑`/`↓` to move the chevron pointer between tasks, press `Enter` or `Space` to open/close details for the selected task, and press `Esc`, `Ctrl+C`, or `q` to exit without modifying tasks. In non-interactive modes it prints the active task list as text.

### Interactive list legend

The interactive list uses compact glyphs so task rows stay scannable:

Statuses:

```text
□ todo
▣ in_progress
▧ blocked
■ done
▫ archived
```

Priorities:

```text
●●● urgent
●●○ high
●○○ medium
○○○ low
```

Dependency indicator:

```text
◂1   depends on one task
◂2   depends on two tasks
```

Example row:

```text
› □ TSK-9d6a63e4  ●○○  Dependent test task  ◂1
```

The `›` chevron marks the selected task. Press `Enter` or `Space` to switch to a details view for that task:

```text
─── TSK-9d6a63e4 ─────────────────────────

  Dependent test task
  □ todo · ●○○ medium

  Dependencies
  □ TSK-e1fe6249  ●○○  Move Telos task artifact under .pi

  Created  2026-06-04 11:08 UTC
  Updated  2026-06-04 11:08 UTC
```

The details view shows the description and dependencies only when they are present. Long descriptions wrap instead of truncating.

Completed tasks are dimmed and sorted after incomplete active tasks. Dependency IDs are not expanded in the list; use the details view or `/tasks show <id>` for full details.

## Agent tool

Telos registers one LLM-callable tool: `telos_tasks`.

The tool supports the same task operations as `/tasks`: create, list, show, update, status, complete, reopen, block, archive, and delete rejection. It also accepts `dependencies: string[]` for create and update operations. It is described neutrally so the agent can use it when the user asks to manage or track tasks; Telos does not add any automatic per-turn task creation or tracking hook.

## `.pi/telos-tasks.md` artifact

Telos stores canonical task data in YAML frontmatter under the repository's `.pi` directory:

```md
---
telos_version: 1
tasks:
  - id: TSK-abc123ef
    title: Implement Telos MVP
    status: todo
    priority: high
    notes: ""
    dependencies: []
    created: "2026-06-02T12:00:00.000Z"
    updated: "2026-06-02T12:00:00.000Z"
---

# Tasks

Generated human-readable summary...
```

The YAML frontmatter is the source of truth. The Markdown body is regenerated after successful Telos mutations and should be treated as display output.

Task fields:

- `id` — stable task ID, generated as `TSK-{short_hash}`, for example `TSK-abc123ef`
- `title` — non-empty task title
- `status` — `todo`, `in_progress`, `blocked`, `done`, or `archived`
- `priority` — `low`, `medium`, `high`, or `urgent`
- `notes` — string, may be empty
- `dependencies` — task IDs this task depends on; use `[]` when there are none. Dependencies must reference existing tasks, cannot reference the task itself, and cannot contain duplicates.
- `created` — ISO 8601 timestamp
- `updated` — ISO 8601 timestamp

Archive is the MVP soft-delete mechanism. Physical deletion is rejected and leaves `.pi/telos-tasks.md` unchanged.

## Local development

```bash
cd pithos.telos
npm install
npm test
```

Telos uses Node's built-in `node:test` runner with `tsx` for TypeScript tests.

## Publish

This package is intended to publish through the repository's trusted publishing workflow. Release with a package-specific tag:

```bash
cd pithos.telos
npm version patch --tag-version-prefix="pithos-kit.telos-v"
git push --follow-tags
```

## Notes

This package imports pi runtime packages as peer dependencies:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

Do not bundle those dependencies; pi provides them at runtime.
