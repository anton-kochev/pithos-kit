# @pithos-kit/plan

[![npm version](https://img.shields.io/npm/v/@pithos-kit/plan)](https://www.npmjs.com/package/@pithos-kit/plan)

Enforced read-only planning for Pi, with controlled plan creation, a minimal Plan theme, and contextual session naming.

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
    "@pithos-kit/plan": "npm:0.3.0"
```

## Migrating from `@pithos-kit/skills`

`@pithos-kit/skills` is retired. Remove global and project installs (`pi remove npm:@pithos-kit/skills` and `pi remove -l npm:@pithos-kit/skills`) plus its `.pithos` pin, keep this standalone Plan package for `/plan`, and use Guild 0.3.0 for the relocated TDD skill together with Atlas 0.6.0, which no longer bundles it. Historical Skills 0.4.0 and earlier must not be loaded alongside Plan because both packages handle the same `/plan` command and Plan state.

## Usage

```text
/plan <task>
/plan
/plan exit
/plan cancel
/plan --help
```

After `/plan `, press Tab to list `exit`, `cancel`, `--help`, and `-h`, or start typing an argument to filter them; arbitrary task text remains free-form. The command description explains that bare `/plan` finalizes the active draft. `--help` and `-h` print the same argument summary before prompt expansion, so help does not start an agent turn or activate Plan mode. While Plan mode is active, `/plan exit` and its `/plan cancel` alias immediately restore the previous theme and tools without creating a plan; outside Plan mode they report that there is nothing to exit. Bare `/plan` retains its finalization behavior and opens interactive confirmation once the agent submits the draft.

Plan mode explores the codebase with trusted read-only tools, resolves design decisions, and creates an approved implementation plan under `.pi/plans/`. When `create_plan` receives the final draft, the TUI opens a compact chooser that leaves the recent transcript visible. **Continue planning** is selected by default, **Preview the plan** opens a bounded read-only Markdown viewer, and **Create plan and start implementation** can create the submitted draft directly without preview. Escape also continues planning.

The preview shows the exact content and target path; terminal control and Unicode formatting characters appear as visible `U+…` markers while their original bytes remain bound to confirmation and persistence. Up/Down scroll by line, Page Up/Page Down scroll by page, Home/End jump to the bounds, and Enter or Escape returns to the same three-option confirmation without approving or rejecting the draft.

The controlled creator binds confirmation to the submitted content and destination, publishes the completed file atomically without overwriting, and exits Plan mode only after a successful save. Known path collisions are resolved before confirmation; a collision that races publication advances the path and requires new confirmation. An identical retry after another kind of failed write may reuse confirmation, but changed content must be confirmed again. RPC clients retain the complete draft and target path in their confirmation request. Without interactive UI support, the write is blocked and Plan mode remains active.

While active, Plan mode exposes trusted built-in `read`, `grep`, `find`, and `ls` plus the internal plan creator. When [`@pithos-kit/web`](https://www.npmjs.com/package/@pithos-kit/web) is installed, Plan also retains its read-only `web_search` and `web_fetch` tools so discovery and design can use public-web research. Web content remains untrusted external data and must not be followed as instructions.

The Web exception is provenance-checked rather than name-only: each effective tool must come from package-origin metadata rooted inside a canonical package manifest named exactly `@pithos-kit/web`, with a matching npm source or the local `pithos.web` development package. Same-named SDK, top-level, path-escaping, spoofed-source, and unrelated custom tools stay blocked. Plan continues to block model mutations, delegation, all other custom tools, and manual `!`/`!!` shell commands; it temporarily applies the bundled Plan theme and shows the canonical session name in its footer.

After a successful save, Plan mode restores the previous theme and tools and replaces the current session name—including a manually assigned name—with the approved plan's outcome-focused title in lowercase kebab-case. A missing or generic title falls back to the task-derived plan filename. Declined, continued, cancelled, and failed plan creation does not rename the session. Plan approval does not force compaction; Pi's existing automatic or user-triggered compaction policy remains unchanged.

### Enforcement boundary

Plan mode enforces Pi's tool and user-shell interfaces; it is not an operating-system sandbox. Other extensions and external processes can still mutate files directly.
