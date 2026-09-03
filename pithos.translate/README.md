# translate

Faithful manual translation and display-only automatic assistant translation for [Pi](https://github.com/earendil-works/pi-mono).

Translate requires Pi **0.84.0 or later** because it relies on synchronous display-only Markdown transformers.

Translate does not enforce English and does not modify Pi prompts or model context. Any English-default policy belongs in your user or project instructions; this extension only translates eligible assistant output for display or a context-free card.

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
    "@pithos-kit/translate": "npm:1.0.0"
```

## Commands

| Command | Action |
|---|---|
| `/translate` | Translate the latest completed assistant prose into a context-free card |
| `/translate on` | Enable automatic terminal translation |
| `/translate off` | Return to manual mode for future responses |
| `/translate status` | Show the active scope, language, exact model, mode, and effective timeout |
| `/translate config` | Choose the target language and authenticated translation model again |
| `/translate --help` | Show package-local help (`-h` also works) |

The first command that needs configuration opens a required language and model wizard, then continues the requested operation. Its target-language step is a compact labeled single-line field with an example placeholder; reconfiguration prefills the current language. Cancelling the wizard makes no partial change. `/translate off` never needs configuration: when no valid configuration exists, it simply reports that automatic translation is already off and writes nothing.

## Scoped configuration

Translate uses only the scope from which Pi loaded this extension. Scopes are isolated: they do not inherit from or overwrite one another. Temporary state is additionally isolated by canonical extension source and working directory.

| Loading scope | Storage |
|---|---|
| **user** | `~/.pi/agent/translate.json` (or the configured Pi agent directory) |
| **project** | `<cwd>/.pi/translate.json` (using Pi's configured project directory name) |
| **temporary** (`pi -e ...`) | Process memory only (retained across extension/session recreation in that process) |

User and project files are replaced atomically and use this strict shape:

```json
{
  "language": "French",
  "model": "anthropic/claude-haiku-4-5",
  "mode": "manual",
  "timeoutMs": 60000
}
```

`language` is free-form non-empty single-line text. `model` is one exact `provider/model-id` selected from authenticated available Pi models. The first slash separates the provider, so model IDs may contain further slashes (for example, `openrouter/anthropic/claude-sonnet-4`). `mode` is `manual` or `automatic`. Optional `timeoutMs` is an integer from `1000` through `300000`; when omitted, Translate uses `60000` (60 seconds). Existing three-field files remain valid, and the default field is not written merely by loading them. Unknown or incomplete fields make the scoped file invalid and cause setup to run again. `/translate config` retains an existing explicit timeout; set or change it directly in the scoped JSON file and use `/translate status` to verify the effective value.

There is **no fallback model**. If that exact model disappears or loses authentication, Translate reports the provider and suggests `/login <provider>` or `/translate config`; it never uses the active coding model instead. Provider names are literal authentication boundaries: `openai/...` requires OpenAI API-key authentication (for example `OPENAI_API_KEY` or `/login openai`), while `openai-codex/...` uses ChatGPT/Codex subscription authentication. Working `openai-codex` credentials do not authenticate `openai` requests.

## Manual mode

The original assistant response remains visible and remains the only response in model context. `/translate` appends a themed Markdown card below it:

```text
Translation · French · anthropic/claude-haiku-4-5

Voici la réponse traduite…
```

The card is a durable Pi custom entry. It is saved in the session but is context-free: Pi does not send it to the main model. While the manual request runs, `/translate` retains its cancellable bordered loader. Errors, cancellation, and timeout append no card, even when a provider ignores cancellation.

## Automatic mode

Automatic mode prioritizes complete visual replacement over token streaming:

1. Streaming assistant prose is hidden without inserting an assistant placeholder. Main-model generation uses only Pi's own working indicator; Translate does not start a footer status during generation.
2. Only a successful terminal assistant message containing non-empty text and **no tool calls** is considered.
3. Assistant text blocks containing a Mermaid fence are intentionally left original and incur no translation model call. Pi's built-in Mermaid transformer runs before extension transformers, so its rendered output cannot exact-match the source cache.
4. Translation finishes in `message_end`, before final rendering. Immediately before the first non-Mermaid block's model request, an animated footer status begins and names the target language and exact model, for example `⠋ Translating into French with anthropic/claude-haiku-4-5...`. It remains active through every translation request for that message. The original message object is never replaced.
5. Pi's Markdown transformer substitutes translated blocks only in terminal display. Every successful automatic block is shown with an italic marker built from the persisted target language:

   ```markdown
   *Translated · French*

   Voici la réponse traduite…
   ```

6. A context-free outcome record is appended on that message's corresponding `turn_end`, after the source message. It stores translations, aggregate translation-model usage, and suppression tombstones for failed, cancelled, or deliberately skipped blocks, so queued turns, resumed sessions, and active branch changes restore translated blocks without resurrecting stale translations for original blocks. The display cache safely collapses and Markdown-escapes the saved target language when constructing the marker; the marker is not stored in translation bodies or original messages and never enters model context. Usage from a model-returned failure is retained; failures before any response do not invent usage.

The animated status uses Pi's keyed `setStatus` API under Translate's own key, so clearing it does not overwrite statuses owned by other extensions. It starts only after terminal-message eligibility is confirmed and only when Translate reaches the first block that will make a translation-model request. Translate clears an active status on completion, failure, cancellation, mode changes, branch/session changes, reload, and shutdown. Tool-calling, errored, length-stopped, empty, non-TUI, and all-Mermaid-skipped messages make no translation request and never show Translate's footer.

Thinking, user messages, tool calls, tool results, extension UI, logs, errors, images, and aborted responses are not translated. Tool-calling turns are not delayed by a translation request. If automatic translation fails, is cancelled, or reaches its configured timeout, the keyed status is cleared and the final renderer shows the original response instead of leaving the prose hidden. A failed or skipped repeated source also invalidates any older cached translation for that exact source immediately and after resume, because Pi does not provide message IDs to Markdown transformers.

## Troubleshooting

Run `/translate status` first and verify the exact provider/model and timeout. If authentication is missing, run `/login <provider>` or choose an authenticated model with `/translate config`. In particular, choose `openai-codex/...` when you intend to use Codex subscription authentication; choosing `openai/...` requires a separately valid OpenAI API key, model access, billing, and quota. Escape cancels the manual loader. Automatic failures and timeouts retain the original prose and clear `Translating...`; Translate never silently switches to the coding model.

Turning automatic mode off affects future responses. Historical automatic translations on the active branch continue to render as their saved translations unless a newer identical source must be forced original after failure.

## Transformer ordering

Translate should precede other display-transforming extensions in Pi's extension loading order. Later transformers receive Translate's output and remain compatible. Arbitrary output from an earlier extension transformer cannot be reverse-correlated to the assistant source because the transformer API supplies no message ID. The built-in Mermaid transformer is the unavoidable earlier case, which is why automatic translation skips Mermaid-containing assistant blocks.

## Faithful Markdown protection

Before every model call, Translate replaces protected Markdown with deterministic immutable placeholders and validates that each placeholder returns exactly once. It then restores:

- fenced code blocks, including their fence and info string;
- inline code spans;
- inline and reference-link destinations, reference identifiers, and shortcut references that have matching definitions;
- URL autolinks and bare HTTP(S)/`mailto:` URLs.

Those protected regions round-trip byte-for-byte. The translation prompt also requires preservation of Markdown structure, terminology, identifiers, commands, paths, filenames, API names, versions, numbers, and formatting. A missing, duplicated, malformed, or invented placeholder rejects the translation.

## Limitations

- Translation is aimed at Pi's interactive terminal renderer. Print, JSON, and RPC presentation do not receive a replacement card or translated transcript.
- There is no selected-text translation, history browser, language detection, side-by-side view, or per-message original viewer.
- Pi's Markdown transformer receives Markdown and render state, not a session-entry ID. Restored substitutions are therefore keyed by a collision-checked SHA-256 source fingerprint plus exact source text; repeated identical source blocks deterministically use the latest active-branch record.
- The extension calls the configured Pi model directly. Provider pricing and limits apply.

## Development

Requires Node.js 22.19 or later.

```bash
npm ci
npm test
npm run typecheck
npm pack --dry-run
```
