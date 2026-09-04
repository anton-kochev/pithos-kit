# Translate behavior list

## Commands and help
- [x] Keep bare `/translate` as one-shot manual translation of the latest eligible assistant response.
- [x] Recognize only the eight flat directional controls: `input-on`, `input-off`, `input-status`, `input-config`, `output-on`, `output-off`, `output-status`, and `output-config`.
- [x] Keep top-level `--help` and `-h`; reject unprefixed, nested, and unsupported arguments with package-local usage.
- [x] Suggest every supported single-token argument through Pi autocomplete and filter by prefix.

## Scoped configuration
- [x] Strictly validate independently optional `input` and `output` sections with `on`/`off` modes, independent exact models, bounded optional timeouts, and an output-only target language.
- [x] Reject unknown fields, malformed sections, and the former flat schema without migration.
- [x] Resolve the command's canonical user/project/temporary source scope and fail closed on ambiguous provenance.
- [x] Load and atomically persist only `~/.pi/agent/translate.json` or `<cwd>/.pi/translate.json` for the active scope; keep source/cwd-isolated temporary settings for the process lifetime.
- [x] Configure input with an authenticated exact model and output with a single-line language plus authenticated exact model, without partial writes.
- [x] Preserve the other direction whenever one direction is configured or toggled.
- [x] Treat either direction's `off` action without configuration as already off, without setup or writes.
- [x] Enable an unconfigured direction through one completed configuration write.

## Input interception
- [x] Keep input translation off by default and pass disabled input through unchanged.
- [x] Intercept only ordinary idle interactive TUI prompts before skill/template expansion.
- [x] Return the English text through Pi's `input` transform rather than resubmitting a user message.
- [x] Preserve attached images in the transform result.
- [x] Preserve recognized leading skill/template directive tokens and separators exactly, translating only their arguments; pass argument-free directives unchanged.
- [x] Bypass extension-originated input to prevent loops.
- [x] Block RPC, print, JSON, steering, follow-up, and non-idle user paths without a translation-model call while input mode is on.
- [x] Fail closed on every detectable translation failure, restore the original interactive TUI draft, clear keyed progress, and emit only source-free feedback.
- [x] Append no session entry and expose no original inbound text to the main-model conversation.

## Markdown safety and model boundary
- [x] Protect and byte-exactly restore backtick/tilde LF/CRLF fenced code, inline code, inline/reference/defined-shortcut links, autolinks, and bare URLs.
- [x] Reject missing, duplicated, malformed, or invented protection placeholders.
- [x] Resolve only the exact configured authenticated model for each direction; never fall back to the active coding model.
- [x] Fix inbound requests to English while allowing arbitrary or mixed source languages.
- [x] Build a faithful translation-only prompt that treats imperative source requests as data, forbids additions or omissions, safely quotes the target language, propagates cancellation, normalizes timeout/failure, and captures available usage.
- [x] Preserve usage from success and model-returned failures without inventing it for pre-response failures.

## Manual output behavior
- [x] Select only `stop`-completed assistant prose without tool calls and normalize each block with Pi's rendered `trim()`.
- [x] Find the latest eligible assistant response on the active branch.
- [x] Append a durable context-free themed Markdown card for successful bare-command translation.
- [x] Leave history unchanged and append nothing on cancellation or failure.
- [x] Make no manual output-translation model call outside interactive TUI mode.

## Automatic output behavior
- [x] Suppress only streaming assistant prose while automatic output mode is on, leaving main-model generation to Pi's working indicator.
- [x] Start a keyed animated footer naming target language and model only immediately before the first eligible non-skipped request.
- [x] Never show Translate's footer for tool-calling, errored, length-stopped, empty, non-TUI, or all-Mermaid messages; clear it on every outcome and lifecycle change.
- [x] Translate finalized eligible prose, cache display substitutions, and never replace the assistant message.
- [x] Reveal original prose on failure/cancellation and persist suppression tombstones that invalidate stale repeated-source translations.
- [x] Persist translated and deliberately skipped block outcomes on the corresponding `turn_end`, including queued-turn and branch handling.
- [x] Restore active-branch records and legacy translation records while keeping substitutions display-only.
- [x] Prefix successful blocks with a safely escaped `Translated · <target language>` display marker that never enters message context or stored translation bodies.
- [x] Handle multiple blocks and repeated source text deterministically.
- [x] Leave Mermaid-containing blocks original without a model call because Pi's built-in Mermaid transformer runs first.
- [x] Keep output available to later transformers and document that Translate must precede arbitrary display-transforming extensions.

## Privacy, diagnostics, and package contract
- [x] Never persist or log raw inbound source text or inbound provider errors; record only source-free dimensions, model, outcome, duration, and available usage.
- [x] Record source-free provider/model/stop metadata and available usage for each completed main assistant-model response, without recording response text.
- [x] Record unsupported inbound blocking and unexpected inbound exceptions with safe classifications and no source or provider-error content.
- [x] Document that the local runtime and configured translation provider necessarily receive inbound source transiently.
- [x] Publish `@pithos-kit/translate` v1.1.0 for Pi >=0.84.0 with one extension entry, one `translate` command, directional metadata, scripts, and packed files.
- [x] Document the intentionally breaking command grammar and strict unified configuration schema.
