# context-bar

A thin, stacked context-window composition bar for [pi](https://github.com/earendil-works/pi-mono), rendered directly above the editor, with live ChatGPT Codex subscription usage in Pi's footer.

```text
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀────────────────────────42%
```

The real bar uses a harmonious theme-aware color progression and spans the terminal width. Used context renders as upper-half `▀` blocks, while free capacity renders as a thin `─` line matching the editor's current border color. Whenever width permits, every visible section is separated by a one-cell terminal-background delimiter; wider sections contribute the space so one-cell sections remain intact. This leaves balanced spacing around the input cursor. While enabled, context-bar removes Pi's separate top-border row; disabling the bar restores it. Its only inline text is the integer percentage at the far right showing total context used.

## Install

Context Bar requires Pi `1.0.0` or later. Atlas reports environments pinned to older Pi versions as incompatible.

```bash
pi install npm:@pithos-kit/context-bar
```

For local development:

```bash
pi install -l ./pithos.context-bar
```

## Pithos `.pithos` config

```yaml
pi:
  extensions:
    "@pithos-kit/context-bar": "npm:0.2.0"
```

## Commands

| Command | Action |
|---|---|
| `/context-bar` | Toggle the bar and Codex usage status |
| `/context-bar on` | Enable it |
| `/context-bar off` | Disable it |
| `/context-bar status` | Show the legend, estimated counts, model/window, estimation basis, and latest Codex usage details |
| `/context-bar refresh` | Bypass the one-minute cache and refresh Codex usage immediately |
| `/context-bar --help` | Show command usage without changing state |

`-h` is also accepted. Typing `/context-bar ` shows the canonical arguments with descriptions; suggestions filter as you continue typing.

New sessions start enabled. Explicit changes are stored as non-context entries on the active session branch, so they survive reload, resume, and fork without creating project or global configuration.

## Codex usage

When the active model uses the OAuth-authenticated `openai-codex` provider, Context Bar adds a native Pi footer status line:

```text
Codex · 5h 68% · week 74%
```

Both percentages are the **used** amount, not the remaining amount. The primary and secondary ChatGPT rolling windows are labeled `5h` and `week`. If the active plan exposes only a weekly window, Context Bar omits `5h` and converts the reported weekly value to used percentage without substituting an unrelated model-specific limit. Context Bar refreshes usage when an enabled TUI session starts on Codex, when the model changes to Codex, and after a Codex agent run settles. A lightweight 15-second in-memory auth check also detects logout and account changes that Pi does not expose as lifecycle events. Usage-endpoint attempts remain limited to once per minute; `/context-bar refresh` forces an immediate attempt without sending a model request.

`/context-bar status` includes the plan, relative reset times, data age, and any sanitized refresh error. If a refresh fails after a successful result for the same OAuth account, the footer keeps the prior percentages with `· stale`; a timeout clears percentages because account identity cannot be revalidated within the deadline. Cached usage is scoped to the current ChatGPT account and cleared when authentication disappears or the account identity cannot be revalidated; an account change discards obsolete in-flight results. Switching away from Codex, turning Context Bar off, entering offline mode, or shutting down also clears the footer status and cancels or ignores obsolete work.

Usage lookup requires ChatGPT Plus/Pro OAuth login through Pi. API-key OpenAI models and other providers are not queried.

## Segments

Segments always appear in this order:

| Segment | Includes | Color identity |
|---|---|---|
| **Prompt** | Pi's base prompt, custom/append prompts, working directory, and extension prompt changes | Violet |
| **Project context** | Loaded `AGENTS.md`, `CLAUDE.md`, and related project instruction context | Blue |
| **Skills** | Skill catalogue metadata, explicit `/skill:*` expansions, and recognized skill-file read results | Teal |
| **Tools** | Active definitions/schemas, prompt guidance, calls, arguments, results, and context-visible shell output | Green |
| **Conversation** | User content, prompt templates, images, assistant text/thinking, summaries, and custom context messages | Amber |
| **Other** | Provider framing, serialization differences, extension rewrites, and estimation residual | Gray |
| **Free** | Remaining context capacity | Thin line matching the current editor border (`borderMuted` fallback) |

The original violet → blue → teal → green → amber progression remains stable across themes. Context Bar selects darker or brighter variants from the active theme's foreground contrast instead of relying on semantic theme tokens whose hues may vary. Free capacity still follows the editor border as its mode/thinking color changes. The percentage uses the same `dim` theme color as Pi's footer path; it does not change color at thresholds.

## Accuracy

Pi exposes aggregate context usage, but not exact additive token counts by source. The colored composition is therefore an estimate:

- Text uses Pi-compatible conservative character-based token estimation.
- Images use Pi's fixed image estimate.
- A current provider aggregate is preferred only when it belongs to the selected model and matches the effective prompt/tool fingerprint; changed requests fall back to the safer local estimate.
- Positive unexplained residual is assigned to **Other**; overestimates are proportionally reconciled.
- Startup, model-switch, and post-compaction states use a complete local estimate until correlated provider usage is available.

`/context-bar status` identifies the current basis as `provider-backed total` or `local estimate`. The extension persists only the enabled/disabled boolean. While enabled, it reads Pi's in-memory prompt, context, and schema objects to recompute the bar; it clears its references when disabled or shut down and never writes or logs those inputs or provider payloads.

For Codex usage, the extension resolves Pi's current OAuth credential in memory and sends it only to the fixed HTTPS ChatGPT endpoint `https://chatgpt.com/backend-api/wham/usage`, with redirects disabled, a five-second end-to-end timeout covering authentication and the request, and a bounded response. Tokens and usage responses are never logged or persisted. `PI_OFFLINE=1` (also `true` or `yes`) disables these requests. The endpoint and response schema are provider-specific; if OpenAI changes them, Context Bar reports unavailable or stale data rather than guessing.

Tiny categories may occupy less than one terminal cell and disappear from the passive bar rather than being visually exaggerated. They remain visible in `/context-bar status`.

## Development

Requires Node.js 22.19 or later and Pi 1.0.0 or later.

```bash
npm install
npm test
npm run audit
npm run typecheck
npm pack --dry-run
```
