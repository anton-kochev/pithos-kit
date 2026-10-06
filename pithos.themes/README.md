# @pithos-kit/themes

[![npm version](https://img.shields.io/npm/v/@pithos-kit/themes)](https://www.npmjs.com/package/@pithos-kit/themes)

Accessible light and dark themes for [Pi](https://github.com/earendil-works/pi-mono), designed for comfortable coding sessions with restrained semantic surfaces and a warm gold identity.

## Themes

- **`auric-dark`** — near-black surfaces, warm neutral text, antique-gold accents, muted forest success, navy pending, and burgundy error states.
- **`auric-light`** — a Solarized-inspired ivory theme with slate text, sand user messages, stronger gold success panels, pale blue pending, and rose error states.

Both themes use explicit RGB colors, include coordinated HTML export colors, and retain usable 256-color fallbacks. Informative text on message and tool surfaces meets WCAG AA contrast targets.

## Install

Requires Pi `1.0.0` or later.

```bash
pi install npm:@pithos-kit/themes
```

For local development from this repository:

```bash
pi install -l ./pithos.themes
```

If global files named `auric-dark.json` or `auric-light.json` already exist under `~/.pi/agent/themes/`, remove or disable those duplicate resources before evaluating the packaged copies.

## Pithos `.pithos` config

```yaml
pi:
  extensions:
    "@pithos-kit/themes": "npm:0.1.0"
```

## Usage

Choose a fixed theme through `/settings`, or configure the pair to follow the terminal appearance:

```json
{
  "theme": "auric-light/auric-dark"
}
```

Pi selects `auric-light` for a light terminal and `auric-dark` for a dark terminal. Live switching depends on terminal color-scheme notification support.

For accurate RGB rendering, ensure Pi receives `COLORTERM=truecolor` or `COLORTERM=24bit`. Pi otherwise approximates colors with the terminal's 256-color palette.

## Development

```bash
npm test
npm pack --dry-run
```
