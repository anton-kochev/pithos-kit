# echo

A read-only side-channel question asker for pi sessions and project code.

Echo adds a `/ask` command that spawns an isolated pi side-process with only read-only tools enabled. Answers are shown to you and stored in extension history, but they are not injected into the main agent context — so you can probe the session and project without polluting the conversation that's doing real work.

## Install

Requires Pi **1.0.0 or later**.

```bash
pi install npm:@pithos-kit/echo
```

Pin to a version:

```bash
pi install npm:@pithos-kit/echo@<version>
```

For local development from a checkout of [`pithos-kit`](https://github.com/anton-kochev/pithos-kit):

```bash
pi install ./pithos.echo
```

Project-local install:

```bash
pi install ./pithos.echo -l
```

Temporary test run:

```bash
pi -e ./pithos.echo
```

## Pithos `.pithos` config

```yaml
pi:
  extensions:
    "@pithos-kit/echo": "npm:0.5.0"
```

## Commands

Inside pi:

```text
/ask [--model <provider/model>] [--] <question>
/ask --help
/asked [--help]
/ask-clear [--help]
```

`-h` is also accepted by every Echo command.

- `/ask` — ask Echo a question.
- `/asked` — browse previous Echo answers interactively with ↑/↓ and open one with Enter.
- `/ask-clear` — clears any stale Echo widget left by older versions.

## What Echo can access

Echo launches an isolated Pi side process with only read-only tools enabled:

- `read`
- `grep`
- `find`
- `ls`

It does **not** receive `bash`, `edit`, or `write`. Echo runs from the current project directory, so it can inspect source code and project files read-only.

## Session context strategy

Echo uses progressive disclosure to keep token usage low:

1. A small recent-session excerpt is included in the side-agent prompt.
2. The full current-session transcript is written to a temporary markdown file.
3. The side agent is instructed to inspect that transcript only when needed, preferably with targeted `grep`/`read` calls.
4. The temporary transcript is deleted after the side process exits.

## Examples

```text
/ask what is this session about?
/ask what files define the extension loading behavior?
/ask --model anthropic/claude-haiku-4-5 summarize the recent decisions
/asked
```

## Notes

This package imports pi runtime packages as peer dependencies:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

Do not bundle those dependencies; pi provides them at runtime.

`extensions/index.ts` is a thin jiti trampoline that disables jiti's module cache for `src/echo.ts`, so editing the implementation and running `/reload` always evaluates the newest code.
