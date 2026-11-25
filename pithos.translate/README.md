# translate

Bidirectional translation for [Pi](https://github.com/earendil-works/pi-mono): translate ordinary interactive prompts into English before the main agent turn, and translate eligible assistant prose manually or through display-only automatic output translation.

Translate requires Pi **1.0.0 or later**. It uses the pre-expansion `input` event and synchronous display-only Markdown transformers.

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
    "@pithos-kit/translate": "npm:3.1.1"
```

## Commands

Translate registers exactly one command. Its management arguments are flat, single-token, and directional.

| Command | Action |
|---|---|
| `/translate` | Translate the latest completed assistant prose into a context-free card |
| `/translate input-on` | Configure input translation if needed, then enable it |
| `/translate input-off` | Disable input translation without requiring setup |
| `/translate input-status` | Show the input scope, fixed English target, exact model, mode, timeout, and optional English check |
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

There is **no fallback model**. Each request uses only that direction's configured and authenticated model, never the active coding model. Provider credentials are separate. For `openai/...`, chat can work with a ChatGPT login, but the Decisions classifier requires API-key authentication. You can keep `openai-codex/...` on subscription authentication and use a Platform API key for `openai/...`.

## Input translation

Input translation is opt-in and off by default. When enabled, Translate supports ordinary idle prompts and busy steering/follow-up messages submitted from the interactive TUI:

1. Pi dispatches extension commands first.
2. Translate receives raw prompt text through Pi's `input` event, before skill and prompt-template expansion.
3. Translate protects byte-sensitive Markdown regions, optionally checks whether the input already needs no English translation, and otherwise asks the configured exact translator for a faithful English translation.
4. On success it returns Pi's `transform` result. Pi expands any preserved directive and delivers the translated text using the original submission’s native steering or follow-up behavior (or starts a normal turn when appropriate). Translate does not resubmit the message or wait for the main agent to become idle. Translation adds preprocessing latency before Pi can queue the message.

When translation is performed, the original source is not persisted and does not enter the main model context. Translate handles the original text transiently in Pi. Without an English check, it sends eligible text directly to the translation provider after Markdown protection. With the check enabled, the classifier receives the protected text first. If it approves, the original prompt continues unchanged to the main model without a translator call. On fallback, the translator also receives the protected text. Diagnostics record only source-free operational metadata such as character count, selected model, duration, outcome, and usage; they never record raw inbound text or provider error text.

Image attachments are preserved on the transformed prompt. Without an English check, English or language-neutral text still passes through the same guarded translator boundary and may return unchanged.

### Optional file-only English check

The decision model does not translate. It answers one question: can this prompt go to the main agent unchanged? For OpenAI, [set up the classifier credential](#openai-decisions-setup) even if chat translation already works. Then add `englishCheck` inside the existing `input` section of the active user or project `translate.json` file:

```json
{
  "input": {
    "mode": "on",
    "model": "openai-codex/gpt-5.4-mini",
    "timeoutMs": 60000,
    "englishCheck": {
      "model": "openai/gpt-6-luna",
      "threshold": 0.98,
      "timeoutMs": 10000
    }
  }
}
```

Keep any existing `output` section. Use `~/.pi/agent/translate.json` (or the configured agent directory) for a user installation, or `<cwd>/.pi/translate.json` for a project installation. Run `/reload` after editing; there is no file watcher. Temporary installations have no file-backed setup for this option. The input wizard does not prompt for the check and preserves it when reconfiguring; mode toggles also preserve it. `/translate input-status` reports the check's exact model, effective threshold, and timeout. Remove `englishCheck` to disable it.

- `model` is required and names an exact registered **classifier**, initially `openai/gpt-6-luna`, independently of the translation model. No codemode or MCP setup is needed.
- `threshold` defaults to `0.98`; it must be a finite number greater than zero and at most one.
- `timeoutMs` defaults to `10000`; it must be an integer from `1000` through `300000`. This budget is separate from the translator's timeout, so a fallback can take the sum of both budgets.
- The setting is input-only; `output.englishCheck` and unknown nested fields are rejected.

#### OpenAI Decisions setup

**Use a Platform API key, not a ChatGPT login.** `/login openai` can save a subscription token rather than a key. A `stored` indicator or working translation proves neither that Pi selected a Platform key nor that `/v1/decisions` accepts it.

1. On the [OpenAI API keys page](https://platform.openai.com/api-keys), choose your project and key. Under **Restricted → Model capabilities**, allow **Decisions → Write**. If the same key also runs your translator or chat model on `/v1/responses`, allow **Responses → Write** too. Keep other permissions your apps need; **All** is not required.
2. From the **host terminal** in your project directory, run `pithos run -- pi auth login openai --api-key`. For standalone Pi, run `pi auth login openai --api-key` instead. Enter the key at the secure prompt, never in chat, a command argument, or `translate.json`. Look for **Saved API key for OpenAI**, not **Logged in to OpenAI**. This replaces Pi's stored `openai` credential; requests using that key use API billing. It does not replace your `openai-codex` subscription credential.
3. Restart your usual session. For an end-to-end check with logs, start it with `pithos run -- env PITHOS_LOG_LEVEL=info PITHOS_LOG_DIR=.pi/logs pi`. Run `/translate input-status` to confirm the configuration, then send a normal English prompt. The status command itself does not call the classifier.
4. Check the latest `translation.input.english-check` event in `.pi/logs/pithos-translate.jsonl`. A fresh `skip` with `threshold-met` confirms the classifier answered and translation was skipped. A `below-threshold` fallback also confirms a valid answer; a `provider-error` does not. If a probe reports `401 no_matching_rule`, verify **which credential Pi is using** before changing key permissions. Editing a Platform key does nothing to a session using OAuth.

#### What the check sends and when it falls back

The classifier must be available in the installed Pi registry; older Pi versions without classifier APIs safely use the translator instead.

The check receives the **complete protected argument text**, without silent truncation. Code and URLs use the same Markdown placeholders as translation. For recognized directives only the argument suffix is classified; attachments are not sent to the classifier. Enabling the check sends this protected prose to the classifier provider even if no translation is ultimately needed; its privacy, pricing, and limits apply.

Only a successful, valid boolean answer with a finite probability at or above the threshold approves skipping. Approval returns Pi's original `continue` result, preserving text, directive spacing, and attachments exactly. Non-English, mixed-language, uncertain, invalid, missing-model, unauthenticated, errored, provider-aborted, and timed-out checks all fall back to the configured translator. Caller cancellation instead stops processing and restores the original draft. Translator failures still fail closed. Checking and translating have distinct footer messages, cleared on completion or cancellation.

The threshold is provisional, not a language-detection correctness guarantee. A model can confidently misclassify short, mixed-language, or adversarial text. No live accuracy evaluation is included in the automated tests.

### Skills and prompt templates

For a recognized leading skill or prompt-template invocation, Translate preserves the directive token and its following separator exactly and translates only the argument suffix. For example, `/review   Révise ce code` becomes `/review   Review this code` before Pi expands `/review`. A recognized directive token with no arguments continues unchanged.

Extension-originated input is explicitly bypassed to prevent loops and unintended rewriting.

### Unsupported paths and failures

While input translation is on, RPC, print, JSON, and non-idle user-input paths without a steering/follow-up delivery option are blocked without a translation request. They are never passed untranslated to the main agent. Extension-originated messages bypass this processing entirely. The optional English check runs only after these eligibility guards.

Inbound translation fails closed. Missing or unauthenticated models, unavailable exact models, timeout, cancellation, provider failure, truncated or empty output, altered Markdown placeholders, and unexpected translator errors all stop the prompt. In the interactive TUI, Translate restores the original draft to the editor and shows a source-free error so the user can retry without losing the text. Pending input work is cancelled and late results are discarded on session start/replacement, tree navigation, reload, and shutdown, without restoring an old draft into the new session. Main-run cancellation also stops pending busy-input translation. A keyed footer status names English and the configured model while translation is active and is cleared on every outcome and session lifecycle change.

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

With Pithos Kit's opt-in JSONL diagnostics enabled, Translate records source-free lifecycle and translation events. Each `translation.input.english-check` event records the model, source character count, duration, outcome, effective `threshold`, and a `reason`. `classifierCalled` tells you whether Translate invoked Pi's classification API, not whether a network request reached the provider. A valid boolean response includes its numeric `probability`: `threshold-met` skips translation; `below-threshold` falls back. Other reasons distinguish setup failures, exceptions, provider errors or aborts, invalid responses, timeouts, and cancellation without exposing raw errors. Events record available `classifierUsage` (input/output/total tokens and cost), separately from chat translation usage; they contain neither source text nor raw provider errors. It also records each completed main assistant-model response's provider, model, API, stop reason, and available token/spend usage so translation overhead can be distinguished from the coding turn. It never records assistant response text. Inbound completion, failure, exception, and unsupported-path records contain only operational dimensions; raw inbound text and inbound provider error text are excluded.

## Troubleshooting

Use `/translate input-status` or `/translate output-status` to verify the active scope, exact model, mode, and effective timeout. Reconfigure with the matching `input-config` or `output-config` argument. For OpenAI classifier authentication, follow [OpenAI Decisions setup](#openai-decisions-setup); for ordinary chat translation, use your provider’s normal login. Input failures restore the draft; output failures retain the original assistant prose. Translate never silently switches to the active coding model.

## Limitations

- Inbound translation supports idle interactive TUI prompts and busy steering/follow-up messages; unsupported user paths are deliberately blocked while enabled.
- A model-based translator cannot guarantee semantic correctness or language detection when the model returns an apparently valid but inaccurate result. Translate can guarantee fail-closed control flow only for detectable request and validation failures.
- There is no selected-text translation, history browser, side-by-side view, or general-purpose source-language detector beyond the optional English precheck.
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
