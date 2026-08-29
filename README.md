# pithos-kit

A monorepo of independently published Pi extensions, skills, prompts, themes, and package tooling for Pithos.

## Packages

- [`pithos.squiggle/`](./pithos.squiggle) — quietly polish grammar and spelling in user prompts. [![npm version](https://img.shields.io/npm/v/@pithos-kit/squiggle.svg)](https://www.npmjs.com/package/@pithos-kit/squiggle)
- [`pithos.echo/`](./pithos.echo) — read-only side-channel question asker for Pi sessions and project code. [![npm version](https://img.shields.io/npm/v/@pithos-kit/echo.svg)](https://www.npmjs.com/package/@pithos-kit/echo)
- [`pithos.answer/`](./pithos.answer) — extract questions from the last assistant response, answer them in an interactive TUI, and submit the answers. [![npm version](https://img.shields.io/npm/v/@pithos-kit/answer.svg)](https://www.npmjs.com/package/@pithos-kit/answer)
- [`pithos.telos/`](./pithos.telos) — repo-scoped structured task tracking through `/tasks`, an agent tool, and `.pi/telos-tasks.md`. [![npm version](https://img.shields.io/npm/v/@pithos-kit/telos.svg)](https://www.npmjs.com/package/@pithos-kit/telos)
- [`pithos.aegis/`](./pithos.aegis) — protect Pi agent shell commands and file mutations with configurable rules. [![npm version](https://img.shields.io/npm/v/@pithos-kit/aegis.svg)](https://www.npmjs.com/package/@pithos-kit/aegis)
- [`pithos.guild/`](./pithos.guild) — isolated .NET, Angular, TypeScript, and Rust architecture and implementation members, language-agnostic code review, confirmed Conventional Commits, and TDD guidance. [![npm version](https://img.shields.io/npm/v/@pithos-kit/guild.svg)](https://www.npmjs.com/package/@pithos-kit/guild)
- [`pithos.context-bar/`](./pithos.context-bar) — context-window composition above the editor and ChatGPT Codex subscription usage in the footer. [![npm version](https://img.shields.io/npm/v/@pithos-kit/context-bar.svg)](https://www.npmjs.com/package/@pithos-kit/context-bar)
- [`pithos.plan/`](./pithos.plan) — session-owned read-only planning with durable checkpoints, explicit lifecycle commands, and conflict-safe publication. [![npm version](https://img.shields.io/npm/v/@pithos-kit/plan.svg)](https://www.npmjs.com/package/@pithos-kit/plan)
- [`pithos.themes/`](./pithos.themes) — accessible Auric light and dark themes with automatic appearance switching. [![npm version](https://img.shields.io/npm/v/@pithos-kit/themes.svg)](https://www.npmjs.com/package/@pithos-kit/themes)
- [`pithos.translate/`](./pithos.translate) — faithful manual and display-only automatic assistant translation. [![npm version](https://img.shields.io/npm/v/@pithos-kit/translate.svg)](https://www.npmjs.com/package/@pithos-kit/translate)
- [`pithos.web/`](./pithos.web) — Brave-backed public-web search and bounded static HTML/text fetching, including trusted Plan-mode research. [![npm version](https://img.shields.io/npm/v/@pithos-kit/web.svg)](https://www.npmjs.com/package/@pithos-kit/web)
- [`pithos.atlas/`](./pithos.atlas) — name sessions, diagnose and configure Pithos, and manage guarded Pi runtime patches. [![npm version](https://img.shields.io/npm/v/@pithos-kit/atlas.svg)](https://www.npmjs.com/package/@pithos-kit/atlas)

## Install

Install one package:

```bash
pi install npm:@pithos-kit/atlas
pi install npm:@pithos-kit/squiggle
pi install npm:@pithos-kit/echo
pi install npm:@pithos-kit/answer
pi install npm:@pithos-kit/telos
pi install npm:@pithos-kit/aegis
pi install npm:@pithos-kit/guild
pi install npm:@pithos-kit/context-bar
pi install npm:@pithos-kit/plan
pi install npm:@pithos-kit/themes
pi install npm:@pithos-kit/translate
pi install npm:@pithos-kit/web
```

Pin an exact version when reproducibility matters:

```bash
pi install npm:@pithos-kit/squiggle@0.4.1
```

In `.pithos`, Pi packages live under `pi.extensions`:

```yaml
pi:
  version: "0.84.2"
  extensions:
    "@pithos-kit/atlas": "npm:0.7.0"
    "@pithos-kit/guild": "npm:0.3.0"
    "@pithos-kit/plan": "npm:0.4.0"
    "@pithos-kit/squiggle": "npm:0.4.1"
    "@pithos-kit/translate": "npm:1.0.0"
    "@pithos-kit/web": "npm:0.1.1"
```

Atlas can validate and interactively manage toolchain versions, `pi.version`, and `@pithos-kit/*` entries while preserving third-party configuration. Its changes describe a future rebuilt Pithos environment; they do not replace the active Pi process. Run `/pithos help` after installing it.

`@pithos-kit/skills` is retired. Its SRS prompt was removed and its TDD workflow now ships with Guild. Remove the retired package from global and project settings with `pi remove npm:@pithos-kit/skills` and `pi remove -l npm:@pithos-kit/skills`, use `/pithos config` to remove its `.pithos` pin, and check `pi list` for either that package or an earlier legacy Skills identity. Coordinate Guild and Atlas releases. Guild 0.3.0 owns TDD and Conventional Commit support and must be paired with Atlas 0.6.0 or later, which no longer registers those capabilities; otherwise `/commit`, `create_commit`, or the `conventional-commit`/`tdd` skills can have duplicate command, tool, or skill registration.

Pi can hide or expose the Guild TDD skill without another extension. Run `pi config` for global settings or `pi config -l` for a project override, toggle the `tdd` skill, then run `/reload` in an active Pi session. Disabling the resource removes its model-visible description and native command after reload. When TDD is enabled, `enableSkillCommands` controls command registration and autocomplete; only disabling the resource makes the skill invisible to the agent. Instructions already expanded into conversation history remain unless you start a new session or branch from before the invocation.

Current package metadata declares Pi `>=0.83.0` except Translate, which requires Pi `>=0.84.0`, and Context Bar and Themes, which require Pi `>=0.84.1`. Atlas reports incompatible combinations rather than silently accepting them.

## Package-local help

Atlas documents its own command with `/pithos help`. Every other public package command documents itself with `--help` or `-h`, for example:

```text
/ask --help
/tasks --help
/guild-handover --help
/plan --help
```

## Local development

From a checkout of this repository:

```bash
pi install -l ./pithos.squiggle
pi install -l ./pithos.echo
pi install -l ./pithos.answer
pi install -l ./pithos.telos
pi install -l ./pithos.aegis
pi install -l ./pithos.guild
pi install -l ./pithos.context-bar
pi install -l ./pithos.plan
pi install -l ./pithos.themes
pi install -l ./pithos.translate
pi install -l ./pithos.web
pi install -l ./pithos.atlas
```

Each dotted subdirectory has its own `package.json` and is published as a standalone npm package with a short name under `@pithos-kit`.

## Local Pi patches

Repo-local helper scripts for local Pi install patches live in [`scripts/pi-patches/`](./scripts/pi-patches). These changes survive restarts but may be overwritten by a Pi package update.

```bash
scripts/pi-patches/suppress-prompt-template-display.mjs
```

## Release

Packages release independently using the `pithos-kit.<name>-v` tag namespace:

```bash
cd pithos.squiggle
npm version patch --tag-version-prefix="pithos-kit.squiggle-v"
git push --follow-tags
```

| Package directory | npm package | Tag prefix | Workflow |
|---|---|---|---|
| `pithos.squiggle` | `@pithos-kit/squiggle` | `pithos-kit.squiggle-v` | `publish-pithos.squiggle.yml` |
| `pithos.echo` | `@pithos-kit/echo` | `pithos-kit.echo-v` | `publish-pithos.echo.yml` |
| `pithos.answer` | `@pithos-kit/answer` | `pithos-kit.answer-v` | `publish-pithos.answer.yml` |
| `pithos.telos` | `@pithos-kit/telos` | `pithos-kit.telos-v` | `publish-pithos.telos.yml` |
| `pithos.aegis` | `@pithos-kit/aegis` | `pithos-kit.aegis-v` | `publish-pithos.aegis.yml` |
| `pithos.guild` | `@pithos-kit/guild` | `pithos-kit.guild-v` | `publish-pithos.guild.yml` |
| `pithos.context-bar` | `@pithos-kit/context-bar` | `pithos-kit.context-bar-v` | `publish-pithos.context-bar.yml` |
| `pithos.plan` | `@pithos-kit/plan` | `pithos-kit.plan-v` | `publish-pithos.plan.yml` |
| `pithos.themes` | `@pithos-kit/themes` | `pithos-kit.themes-v` | `publish-pithos.themes.yml` |
| `pithos.translate` | `@pithos-kit/translate` | `pithos-kit.translate-v` | `publish-pithos.translate.yml` |
| `pithos.web` | `@pithos-kit/web` | `pithos-kit.web-v` | `publish-pithos.web.yml` |
| `pithos.atlas` | `@pithos-kit/atlas` | `pithos-kit.atlas-v` | `publish-pithos.atlas.yml` |

The workflows publish through npm trusted publishing and OIDC. The completed Skills retirement baseline is Guild 0.3.0 with Atlas 0.6.0 or later; see [`CUTOVER.md`](./CUTOVER.md) for the administrative history.
