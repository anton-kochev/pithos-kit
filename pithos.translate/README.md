# translate

Bidirectional translation for [Pi](https://github.com/earendil-works/pi-mono): translate ordinary interactive prompts into English before the main agent turn, and translate eligible assistant prose manually or through display-only automatic output translation.

Translate requires Pi **0.84.0 or later** because it uses the pre-expansion `input` event and synchronous display-only Markdown transformers.

## Install

```bash
pi install npm:@pithos-kit/translate
```

For local development:

```bash
pi install -l ./pithos.translate
```

## Pithos `.pithos` config

```yaml
pi:
  extensions:
    "@pithos-kit/translate": "npm:1.1.0"
```

## Commands

Translate registers exactly one command. Its management arguments are flat, single-token, and directional.

| Command | Action |
|---|---|
| `/translate` | Translate the latest completed assistant prose into a context-free card |
| `/translate input-on` | Configure input translation if needed, then enable it |
| `/translate input-off` | Disable input translation without requiring setup |
| `/translate input-status` | Show the input scope, fixed English target, exact model, mode, and timeout |
| `/translate input-config` | Choose the authenticated exact input-translation model |
| `/translate output-on` | Configure output translation if needed, then enable automatic display translation |
| `/translate output-off` | Disable automatic output translation; bare manual translation remains available |
| `/translate output-status` | Show the output scope, target language, exact model, mode, and timeout |
| `/translate output-config` | Choose the output target language and authenticated exact model |
| `/translate --help` | Show package-local help (`-h` also works) |

Unprefixed management arguments and nested two-token variants are not supported. Cancelling either configuration wizard makes no partial change. Turning an unconfigured direction off launches no setup and writes nothing.

## Scoped configuration

Translate uses only the scope from which Pi loaded the extension. User, project, and temporary scopes are isolated and do not inherit from or overwrite one another. Temporary state is additionally isolated by canonical extension source and working directory.

| Loading scope | Storage |
|---|---|
| **user** | `~/.pi/agent/translate.json` (or the configured Pi agent directory) |
| **project** | `<cwd>/.pi/translate.json` (using Pi's configured project directory name) |
| **temporary** (`pi -e ...`) | Process memory only, retained across extension/session recreation in that process |

User and project files are replaced atomically. The strict direction-oriented shape is:

```json
{
  "input": {
    "mode": "off",
    "model": "openai-codex/gpt-5.4-mini",
    "timeoutMs": 60000
  },
  "output": {
    "mode": "on",
    "language": "French",
    "model": "anthropic/claude-haiku-4-5",
    "timeoutMs": 60000
  }
}
```

Either `input` or `output` may be absent until configured; absence means off and unconfigured. Both directions use `"mode": "on"` or `"off"` and have independent exact models and optional timeouts. `output.language` is required, non-empty, and single-line. Input always targets English and therefore stores no language.

A model is one exact `provider/model-id`; model IDs may contain additional slashes, such as `openrouter/anthropic/claude-sonnet-4`. `timeoutMs` is an integer from `1000` through `300000`. Its default is `60000` (60 seconds) when omitted. Unknown fields, incomplete sections, and the earlier flat configuration shape are invalid; there is no migration layer.

There is **no fallback model**. Each request uses only that direction's configured and authenticated model, never the active coding model. Provider names are literal authentication boundaries: `openai/...` requires OpenAI API-key authentication (for example `OPENAI_API_KEY` or `/login openai`), while `openai-codex/...` uses ChatGPT/Codex subscription authentication. Working `openai-codex` credentials do not authenticate `openai` requests.

## Input translation

Input translation is opt-in and off by default. When enabled, Translate supports only an ordinary idle prompt submitted from the interactive TUI:

1. Pi dispatches extension commands first.
2. Translate receives raw prompt text through Pi's `input` event, before skill and prompt-template expansion.
3. Translate protects byte-sensitive Markdown regions and asks the configured exact model for a faithful English translation.
4. On success it returns Pi's `transform` result. Pi expands any preserved directive and creates one user message containing the translated text.

The original source is not persisted and does not enter the main model context. It necessarily exists transiently in the local Pi runtime and is sent to the configured translation provider because that provider must read it to translate it. Diagnostics record only source-free operational metadata such as character count, selected model, duration, outcome, and usage; they never record raw inbound text or provider error text.

Image attachments are preserved on the transformed prompt. English or language-neutral text still passes through the same guarded model boundary and may return unchanged.

### Skills and prompt templates

For a recognized leading skill or prompt-template invocation, Translate preserves the directive token and its following separator exactly and translates only the argument suffix. For example, `/review   Révise ce code` becomes `/review   Review this code` before Pi expands `/review`. A recognized directive token with no arguments continues unchanged.

Extension-originated input is explicitly bypassed to prevent loops and unintended rewriting.

### Unsupported paths and failures

While input translation is on, RPC, print, JSON, steering, follow-up, and otherwise non-idle user-input paths are blocked without a translation request. They are never passed untranslated to the main agent. Extension-originated messages remain the sole explicit bypass.

Inbound translation fails closed. Missing or unauthenticated models, unavailable exact models, timeout, cancellation, provider failure, truncated or empty output, altered Markdown placeholders, and unexpected translator errors all stop the prompt. In the interactive TUI, Translate restores the original draft to the editor and shows a source-free error so the user can retry without losing the text. A keyed footer status names English and the configured model while translation is active and is cleared on every outcome and session lifecycle change.

## Manual output translation

Bare `/translate` selects the latest successful completed assistant message containing non-empty prose and no tool calls. It appends a themed Markdown card:

```text
Translation · French · anthropic/claude-haiku-4-5

Voici la réponse traduite…
```

The original assistant response remains unchanged. The card is a durable Pi custom entry but is context-free, so Pi does not send it to the main model. The manual request uses a cancellable bordered loader. Failure, cancellation, and timeout append no card.

## Automatic output translation

Automatic output translation is display-only and prioritizes complete visual replacement over token streaming:

1. Streaming assistant prose is hidden while output mode is on; main-model generation uses Pi's own working indicator.
2. Only successful terminal assistant text with no tool calls is eligible.
3. Mermaid-containing text blocks remain original and incur no translation-model request because Pi's built-in Mermaid transformer runs first.
4. At the first eligible request, Translate starts a keyed footer status naming the target language and exact model.
5. Successful blocks render with a safe display-only marker:

   ```markdown
   *Translated · French*

   Voici la réponse traduite…
   ```

6. A context-free outcome record is appended on the corresponding `turn_end`. It stores translations, aggregate translation-model usage, and suppression tombstones so resumed branches reproduce display decisions without changing model context.

The original assistant message object is never replaced. Failure, cancellation, timeout, skipped blocks, mode changes, branch/session changes, reload, and shutdown clear the keyed footer. Failed or skipped repeated sources invalidate older cached translations for that exact source. Tool-calling, errored, truncated, empty, non-TUI, and all-Mermaid messages make no output translation request.

Historical successful output translations on the active branch continue rendering after output mode is turned off, unless a newer suppression record forces an identical source back to its original display.

## Faithful Markdown protection

Before every input or output model call, Translate replaces protected Markdown with deterministic immutable placeholders and validates that each placeholder returns exactly once. It restores these regions byte-for-byte:

- fenced code blocks, including fence and info string;
- inline code spans;
- inline and reference-link destinations, reference identifiers, and defined shortcut references;
- URL autolinks and bare HTTP(S)/`mailto:` URLs.

The translation-only system prompt treats source instructions as data and forbids answering or following them. It also requires faithful preservation of meaning, tone, Markdown structure, paragraph boundaries, lists, tables, headings, terminology, identifiers, commands, paths, filenames, API names, versions, numbers, and formatting. Missing, duplicated, malformed, or invented placeholders reject the translation.

## Transformer ordering

Translate should precede other display-transforming extensions in Pi's extension loading order. Later transformers receive Translate's output. Arbitrary output from an earlier transformer cannot be reverse-correlated because Pi's Markdown transformer API supplies no message ID; the built-in Mermaid transformer is the unavoidable earlier case handled above.

## Diagnostics

With Pithos Kit's opt-in JSONL diagnostics enabled, Translate records source-free lifecycle and translation events. It also records each completed main assistant-model response's provider, model, API, stop reason, and available token/spend usage so translation overhead can be distinguished from the coding turn. It never records assistant response text. Inbound completion, failure, exception, and unsupported-path records contain only operational dimensions; raw inbound text and inbound provider error text are excluded.

## Troubleshooting

Use `/translate input-status` or `/translate output-status` to verify the active scope, exact model, mode, and effective timeout. Reconfigure with the matching `input-config` or `output-config` argument. If authentication is missing, run `/login <provider>`. Input failures restore the draft; output failures retain the original assistant prose. Translate never silently switches to the active coding model.

## Limitations

- Inbound translation supports only ordinary idle interactive TUI prompts; unsupported user paths are deliberately blocked while enabled.
- A model-based translator cannot guarantee semantic correctness or language detection when the model returns an apparently valid but inaccurate result. Translate can guarantee fail-closed control flow only for detectable request and validation failures.
- There is no selected-text translation, history browser, side-by-side view, or independent source-language detector.
- Display substitutions use a collision-checked SHA-256 source fingerprint plus exact source text because Markdown transformers receive no session-entry ID.
- Translation-provider pricing, privacy terms, and limits apply.

## Development

Requires Node.js 22.19 or later.

```bash
npm ci
npm test
npm run typecheck
npm pack --dry-run
```
