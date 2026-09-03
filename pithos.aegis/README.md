# Aegis

Protect Pi agent shell commands and file mutations with configurable block and confirmation rules.

Aegis intercepts agent `bash`, `write`, and `edit` tool calls before they run. It has no command blacklist by default and one built-in protected path: editing `.pi/aegis.json` requires confirmation. Add project rules in `.pi/aegis.json`. For confirmation rules, **No** is the first/default option; any result other than selecting `Yes` blocks the operation.

User-entered `!` and `!!` shell commands are not protected because they already represent explicit user intent.

## Install

```bash
pi install npm:@pithos-kit/aegis
```

Pin to a version:

```bash
pi install npm:@pithos-kit/aegis@<version>
```

For local development from a checkout of [`pithos-kit`](https://github.com/anton-kochev/pithos-kit):

```bash
pi install ./pithos.aegis
```

Project-local install:

```bash
pi install ./pithos.aegis -l
```

Temporary test run:

```bash
pi -e ./pithos.aegis
```

## Pithos `.pithos` config

```yaml
pi:
  extensions:
    "@pithos-kit/aegis": "npm:0.2.0"
```

## Default behavior

There are no built-in command blacklist rules. The only built-in protection rule requires confirmation before an agent `write` or `edit` operation changes `.pi/aegis.json`.

When an agent operation matches a configured `confirm` rule, Aegis shows an interactive prompt with these options:

```text
No
Yes
```

The operation is allowed only when `Yes` is selected. `No`, Escape/cancel, or non-interactive modes block the operation.

## Configuration

Create `.pi/aegis.json` in your project to add rules:

```json
{
  "commands": [
    {
      "name": "git push",
      "pattern": "\\bgit\\s+push\\b",
      "action": "confirm"
    },
    {
      "name": "recursive remove",
      "pattern": "\\brm\\s+(-rf|-fr|--recursive)\\b",
      "action": "block"
    }
  ],
  "paths": [
    {
      "name": "protect .pi",
      "pattern": "(^|/)\\.pi(/|$)",
      "action": "confirm"
    }
  ]
}
```

Top-level fields:

- `commands`: rules matched against the full agent-run shell command for `bash` tool calls.
- `paths`: rules matched against normalized project-relative paths for `write` and `edit` tool calls.
- `rules`: an alternate field for command rules; entries are combined with `commands`.

Rule fields:

- `name`: human-readable rule name shown in prompts and status output.
- `pattern`: JavaScript regular expression string matched case-insensitively.
  - Command patterns match the full shell command.
  - Path patterns match normalized project-relative paths such as `.pi/settings.json`.
- `action`: either:
  - `confirm` — ask the user before allowing the operation; block when no UI is available.
  - `block` — always block the operation.

If multiple rules match, `block` takes precedence over `confirm`. Invalid project configuration does not break the extension; Aegis reports warnings and continues with valid rules.

## Commands

Inside Pi:

```text
/aegis status
/aegis list
/aegis reload
/aegis toggle
/aegis --help
```

`-h` and the existing `help` subcommand also show usage.

- `status` — show the config path, whether it was found, and the rule count.
- `list` — show effective rules.
- `reload` — reload `.pi/aegis.json` from disk.
- `toggle` — enable or disable Aegis for the current Pi session; the state survives `/reload`.
- `help` — show usage and a copy-paste example configuration.

`/aegis` with no argument is the same as `/aegis status`.

Aegis is a clean-break identity: it does not register prior commands, read prior configuration paths, or restore prior session-state entries.

## Development

```bash
cd pithos.aegis
npm test
npm pack --dry-run
```

## Notes

This package imports `@earendil-works/pi-coding-agent` as a peer dependency. Pi provides it at runtime; do not bundle it.
