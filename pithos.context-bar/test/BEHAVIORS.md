# Context bar behavior list

## Context model
- [x] Classify system prompt, project context, skill catalogue, tool metadata, and ordinary conversation without overlap.
- [x] Split explicit skill expansions from trailing user arguments.
- [x] Count assistant tool calls, tool results, and context-visible bash as tools; exclude `!!` bash.
- [x] Attribute recognized skill-file read results to skills.
- [x] Use provider-backed aggregate usage only when it belongs to the active model.
- [x] Reconcile positive provider residual into other and proportionally scale local overestimates.
- [x] Fall back to complete local estimation at startup, after model changes, and after compaction.

## UI
- [x] Allocate segment cells proportionally and deterministically in fixed order.
- [x] Render used context as upper-half-cell `▀` blocks and free capacity as a thin `─` line matching the editor border, with a normal-size integer percentage.
- [x] Preserve the violet → blue → teal → green → amber → gray category sequence with contrast-adapted light and dark variants instead of theme-dependent semantic hues.
- [x] Separate every adjacent visible section with one terminal-background cell whenever wider sections can contribute the space, without erasing one-cell sections.
- [x] Keep section interiors uninterrupted and show only the total-used percentage at the right edge.
- [x] Remove the editor's separate top-border row while enabled, leaving matching half-row padding above and below the input cursor, and restore it when disabled.
- [x] Fill exactly the terminal width, keeping percentage text at the right edge.
- [x] Handle zero/narrow widths, zero/full/overflow usage, and tiny segments safely.
- [x] Format a status legend with counts, model/window, and estimation basis.

## Codex usage
- [x] Parse defensively bounded ChatGPT usage responses into five-hour and weekly used percentages and reset metadata, including weekly-only defaults and model-specific additional limits.
- [x] Show used percentages and available reset countdowns per window, omit windows the plan does not expose, and add a stale suffix only after a failed refresh with retained data.
- [x] Allow OpenAI subscription sessions to opt in to the separate Codex account meter without changing the active model or using its credential.
- [x] Resolve only `openai-codex` OAuth auth, extract the account id from its JWT, and query the fixed HTTPS usage endpoint without redirects, secret logging, or live-network tests.
- [x] Deduplicate and throttle automatic refreshes for one minute while allowing an explicit forced refresh.
- [x] Bound OAuth resolution and requests with cancellation, scope cached values to the authenticated account, poll for otherwise-unobservable logout/login changes, and discard obsolete results after account changes.

## Extension
- [x] Register the above-editor widget only in TUI mode and start enabled.
- [x] Toggle with `/context-bar`, and support `on`, `off`, `status`, and `refresh`.
- [x] Suggest every canonical `/context-bar` argument with descriptions and prefix filtering.
- [x] Persist and restore enabled state from the active session branch.
- [x] Refresh context and Codex usage at their relevant session/model/settled lifecycle boundaries and clean up both on disable, provider switch, offline mode, and shutdown.

## Package
- [x] Publish with the expected npm identity, manifest, files, documentation, local settings entry, and release workflow.
