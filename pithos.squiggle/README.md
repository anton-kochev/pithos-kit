# squiggle

Quietly polish grammar and spelling in your pi prompts.

The extension intercepts user input, shows a `squiggling...` spinner while processing, corrects spelling and grammar using a configured model, shows a colored diff, and submits the corrected prompt automatically without confirmation. Named after the red squiggle from your favorite spell-checker.

## Install

```bash
pi install npm:@pithos-kit/squiggle
```

Pin to a version:

```bash
pi install npm:@pithos-kit/squiggle@<version>
```

For local development from a checkout of [`pithos-kit`](https://github.com/anton-kochev/pithos-kit):

```bash
pi install ./pithos.squiggle
```

Project-local install:

```bash
pi install ./pithos.squiggle -l
```

Temporary test run:

```bash
pi -e ./pithos.squiggle
```

## Pithos `.pithos` config

```yaml
pi:
  extensions:
    "@pithos-kit/squiggle": "npm:0.5.0"
```

## Configuration

Run `/squiggle config` to choose an exact correction model from providers with configured authentication, just like Translate's model picker. If none are available, run `/login` first. The picker opens directly and saves to `<cwd>/.pi/squiggle.json` (honors Pi's configured project directory name). There is no session or user-level model configuration.

Model precedence is **`SQUIGGLE_MODEL` > project > default**. An environment override may still take precedence after saving, which the completion message shows. Cancelling the picker changes nothing. Existing file fields are preserved, and malformed files are not overwritten.

You can still edit `.pi/squiggle.json` directly:

```json
{
  "mode": "on",
  "model": "openai-codex/gpt-5.4-mini",
  "maxInputChars": 500,
  "timeoutMs": 10000
}
```

Options:

- `mode`: `"on"` or `"off"`
- `model`: exact pi model spec in `provider/model` format (model IDs may contain additional slashes)
- `maxInputChars`: maximum input length to send to the correction model
- `timeoutMs`: correction deadline in milliseconds, from `1000` to `60000` (default: `10000`)

Environment variables override the project config (except the session on/off toggle):

```bash
SQUIGGLE_MODE=off pi
SQUIGGLE_MODEL=openai-codex/gpt-5.4-mini pi
SQUIGGLE_MAX_CHARS=1000 pi
SQUIGGLE_TIMEOUT_MS=15000 pi
```

## Commands

Inside pi:

```text
/squiggle toggle          # switch between on/off
/squiggle config          # choose and save the correction model
/squiggle --help          # show toggle/config usage
/squiggle-status          # show status
/squiggle-status --help   # show status-command usage
```

`-h` is accepted wherever `--help` is shown.

The toggle state is saved in the current pi session and overrides `.pi/squiggle.json` and environment configuration for that session.

The default correction model is `openai-codex/gpt-5.4-mini`. Squiggle uses only the exact configured model, never silently substituting the active coding model. `/squiggle-status` shows its exact ID, configuration source, and whether it is missing from the registry. Missing models or failed authentication leave the original prompt unchanged.

If authentication or correction exceeds the configured deadline, Squiggle cancels the request, clears the spinner, and submits the original prompt unchanged. Session shutdown, reload, and an active Pi cancellation signal also cancel in-flight correction.

## Notes

This package imports pi runtime packages as peer dependencies:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`

Do not bundle those dependencies; pi provides them at runtime.
