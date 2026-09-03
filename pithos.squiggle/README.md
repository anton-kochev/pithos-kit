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

Create `.pi/squiggle.json` in your project:

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
- `model`: pi model spec in `provider/model` format
- `maxInputChars`: maximum input length to send to the correction model
- `timeoutMs`: correction deadline in milliseconds, from `1000` to `60000` (default: `10000`)

Environment variables override the config file:

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
/squiggle --help          # show toggle usage
/squiggle-status          # show status
/squiggle-status --help   # show status-command usage
```

`-h` is accepted wherever `--help` is shown.

The toggle state is saved in the current pi session and overrides `.pi/squiggle.json` and environment configuration for that session.

If authentication or correction exceeds the configured deadline, Squiggle cancels the request, clears the spinner, and submits the original prompt unchanged. Session shutdown, reload, and an active Pi cancellation signal also cancel in-flight correction.

## Notes

This package imports pi runtime packages as peer dependencies:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`

Do not bundle those dependencies; pi provides them at runtime.
