# telos

Session-scoped task checklists for pi.

Telos adds a `/tasks` command and an agent-callable `telos_tasks` tool. Each saved Pi session owns an independent checklist in the current project's `.pi/telos/sessions/<session-key>.md`. Tasks survive quitting and resuming that session and remain inspectable outside pi. New sessions, forks, and clones start with an empty checklist; renaming a session or navigating its `/tree` keeps the same checklist.

With `--no-session`, tasks stay in memory only. They survive closing/reopening `/tasks` and extension reload, but are discarded when the session is replaced or Pi exits. Both the UI and command/tool output label this limitation. Opening the viewer never creates a task file.

**Existing installations:** the old shared `.pi/telos-tasks.md` is left untouched, but is no longer used. Telos does not automatically import it into any session or delete it.

## Install

Requires Pi **1.0.0 or later**.

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
/tasks cleanup          # preview orphan task files and confirm removal
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

`/tasks` opens a read-only interactive list with **at most 10 task rows by default** in TUI mode (configurable with `visibleTaskCount`). Use `↑`/`↓` to move the chevron; the window scrolls one row when you cross its edge. Press `Enter` or `Space` for details, and `Esc`, `Ctrl+C`, or `q` to close. Text/JSON/RPC modes receive the active list as text rather than a terminal component.

The header shows progress such as `7/12 done · 2 blocked`, counting all non-archived tasks. Lists longer than the configured visible count also show the visible range, such as `11–20 of 24` with the default of 10. Task details are not subject to this row cap.

The open view refreshes automatically, including details, counts, and externally edited task data. Selection follows the same task ID across sorting changes. If the selected task is archived or removed, the view returns to the list and selects the nearest remaining row. Opening and closing details preserves the scroll position. Failed or incomplete file reads keep the last valid view with an inline warning until recovery; a valid empty task list intentionally clears the display. Refresh work stops when the view closes or the session changes.

## View configuration

Optionally create `.pi/telos.json` in the project:

```json
{
  "refreshIntervalMs": 1000,
  "visibleTaskCount": 10
}
```

- `refreshIntervalMs` is an integer in milliseconds, from **250** to **2147483647**. The default is **1000**.
- `visibleTaskCount` is a positive safe integer (1–9007199254740991). The default is **10**. It caps visible task rows, not the total tasks stored. Increasing or decreasing it keeps the selected task visible and preserves open details.

Both settings are optional and default independently, so existing refresh-only config files still work. Configuration is strict JSON: unknown settings, fractional values, comments, and wrong types are rejected.

Config is rechecked about once per second, independently of the task refresh interval. Valid edits to either setting take effect while `/tasks` is open without reopening, reloading Pi, or redeploying. Missing/deleted config or `{}` restores both defaults. Invalid/unreadable config keeps the last valid settings (or the defaults initially) and displays a separate warning until recovery. Telos never creates or rewrites this config for you. Memory-only sessions use these settings too.

## Cleaning up deleted sessions

Pi currently has no public session-deletion event, so deleting a session cannot immediately remove its separate task file. Run `/tasks cleanup` to preview eligible orphaned files and explicitly confirm their removal. Without confirmation UI, no files are deleted; there is no force option or agent-tool cleanup action.

Cleanup only considers validated Telos artifacts whose session files were previously observed on disk and are now absent from the same accessible parent location. Active-session files, never-observed sessions, unknown/malformed ownership, unsafe paths, and symlinks are skipped. Candidates are checked again after confirmation; changed task files or reappeared sessions are skipped. The result reports deleted, skipped, and failed counts.

A missing session might have been moved: review the displayed paths before confirming. Restoring a trashed session does **not** restore a separately deleted task file. Cleanup never deletes session files, the legacy shared task file, or memory-only tasks, and never runs automatically on quit or viewing. Sessions moved to a new location with the same ID and project can read their checklist; a successful mutation updates the cleanup locator. Cleanup observation metadata is refreshed on task mutations, so uncertain/unobserved artifacts may remain ineligible.

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

The tool supports create, list, show, update, status, complete, reopen, block, archive, and delete rejection for the **current session**. It also accepts `dependencies: string[]` for create/update. Its `scope` parameter (`active`, `archived`, `all`) filters that session's tasks, not other sessions. Cleanup is command-only. Telos adds no automatic per-turn task creation or plan-to-task generation.

## Session task artifacts

Saved sessions use `.pi/telos/sessions/<session-key>.md`, where the key is a SHA-256 hash of the session ID. The project directory provides a separate namespace. YAML frontmatter contains canonical task data and a generated `telos_owner` section binding the artifact to its session and cleanup location. Leave ownership metadata intact when editing tasks. It includes local absolute project/session paths and, when available, observed session-header and filesystem identity information; consider this before sharing artifacts.

The task-data portion looks like this (ownership metadata omitted here):

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

Archive is the task soft-delete mechanism. Individual physical task deletion is rejected; `/tasks cleanup` removes only confirmed orphan artifacts, not individual task records.

Successful persisted mutations write a complete validated artifact to an exclusive temporary file in the same directory, then atomically replace the destination. Existing file permissions are preserved and temporary files are cleaned up on failure. This avoids exposing a partially written canonical file; it does not provide cross-process compare-and-swap or power-loss durability guarantees. Telos serializes cooperating in-process mutations, but arbitrary external writers can still race.

## Local development

```bash
cd pithos.telos
npm ci
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
