# @pithos-kit/atlas

[![npm version](https://img.shields.io/npm/v/@pithos-kit/atlas)](https://www.npmjs.com/package/@pithos-kit/atlas)

Atlas gives eligible new sessions readable synthetic names and includes a default runtime footer, interactive catalog, version checker, compatibility doctor, `.pithos` configuration manager, and optional guarded Pi fallback patches for pithos-kit. It combines bounded model-assisted session naming and a bundled offline catalog with explicit public npm registry checks, Pi runtime provenance, and reversible environment customization.

## Install

```bash
pi install npm:@pithos-kit/atlas
```

Pin an exact version:

```bash
pi install npm:@pithos-kit/atlas@0.8.0
```

For local development:

```bash
pi install -l ./pithos.atlas
```

## Pithos `.pithos` config

```yaml
pi:
  extensions:
    "@pithos-kit/atlas": "npm:0.8.0"
```

The separate Pithos base image can preinstall Atlas so it remains available to diagnose a project configuration that would otherwise prevent project packages from loading.

## Automatic session names

After the first user message in an eligible new session, Atlas asks the cheapest authenticated, session-scoped, non-reasoning text model for one synthetic name containing 3–5 lowercase ASCII words in kebab-case, inspired by 1980s, 1990s, and 2000s pop culture. For example: `neon-pager-ringtone-reboot`. The static request includes no conversation, prompt, cwd, tools, session identifier, or other session-derived content.

The request runs in the background with thinking disabled by model selection, no prompt caching, no retries, and a ten-second timeout. It may incur a small provider charge; Pi 0.83 does not include this background completion in session usage totals. Invalid output, missing credentials or a suitable model, provider failure, timeout, `PI_OFFLINE`, or session shutdown produces a local three-word kebab-case fallback. A manual or extension-provided rename while generation is pending cancels the attempt and remains authoritative.

Automatic naming eligibility applies to a fresh startup whose allocated session file does not exist yet, `/new`, and unnamed in-process forks. Session startup alone never generates or assigns a name; Atlas waits for the session's first user message. Atlas preserves the intent of names supplied through `--name`, `/name`, inherited by a fork, or set by another extension, while canonicalizing any nonconforming value to lowercase kebab-case. It leaves persisted legacy unnamed sessions and reloads untouched. Because Pi 0.83 does not expose initial CLI-fork provenance, `--fork` from an old unnamed session may remain unnamed.

Pi persists the name as canonical session metadata and displays it in Atlas's runtime footer, the terminal title, and the session selector. The name remains until changed manually with `/name` or replaced after a successful approved save by [`@pithos-kit/plan`](https://www.npmjs.com/package/@pithos-kit/plan); while Plan mode is active, its minimal temporary footer retains the current name. Ephemeral `--no-session` runs receive a runtime name but cannot persist beyond the process.

Atlas also provides the model-facing `rename_session` tool. Its tool guidance limits use to explicit user requests to name or rename the current session. Lowercase kebab-case is mandatory for every session name: Atlas validates tool input and canonicalizes names set through `/name`, `--name`, inheritance, or other extensions. Values with no ASCII letters or digits become `unnamed-session`.

## Commands

```text
/pithos
/pithos help
/pithos packages
/pithos versions [--refresh]
/pithos doctor [--refresh]
/pithos config
/pithos config validate
/pithos patch footer status
/pithos patch footer apply
/pithos patch footer remove
```

- `/pithos` opens a focused About, Doctor, Configure, and Fallback Patches menu in TUI mode and prints help in non-interactive modes.
- `/pithos help` is the single Atlas help page.
- `packages` lists package-owned commands, tools, prompts, skills, themes, agents, and configuration from the bundled catalog, then adds runtime command/tool provenance without contacting npm.
- `versions` explicitly queries public npm registry endpoints, distinguishing bundled and latest versions.
- `doctor` shows cancellable progress while it distinguishes the active Pi process, the Pi version configured for a future Pithos rebuild, configured package pins, runtime-detected packages, bundled versions, latest versions, and versions compatible with the configured Pi. Its status and bounded final diagnostic identify the `config`, `registry`, and `runtime` phases with elapsed timings; failures omit configuration contents. Press Escape to cancel the registry-backed diagnostic and print the phases that were still pending.
- `config validate` reads and validates `.pithos` without changing it.
- `config` opens the interactive manager described below.
- `patch footer status` inspects the optional built-in-file fallback without changing it.
- `patch footer apply` explicitly confirms and installs that fallback; `remove` reverses it. Both require a Pi restart. Normal Atlas TUI sessions do not need the patch.

## Runtime footer (default)

On every TUI `session_start`, Atlas installs a custom fallback footer at runtime. It renders the current cwd, Git branch, session name, provider, model, reasoning level, and every extension status on bounded lines. It reads session and footer data during each render and subscribes to Git branch changes, so branch, name, model, reasoning, and status changes are reflected without restarting Pi.

```text
/workspace/project (main) • session-name                 (openai-codex) gpt-5.6-sol • high
Codex · 5h 68% · week 74%
```

The runtime footer omits cumulative input/output/cache counts, cache-hit rate, estimated cost or subscription marker, context-window percentage, and the auto-compaction marker. The underlying accounting remains available through Pi's `/session`, RPC, and session data.

Atlas wraps the shared `ctx.ui.setFooter` method with lifecycle ownership metadata and restores the prior setter when its session runtime shuts down. A defined custom footer temporarily overrides Atlas, and clearing it with `setFooter(undefined)` restores Atlas. Normal fallback installation is deferred through the `session_start` microtask, so a custom footer installed after Atlas during that same startup is observed by the wrapper and preserved. Persisted active or indeterminate Plan state remains the ordering-independent guard: Atlas does not replace Plan when Plan installed its footer first, and Plan exit still restores the Atlas fallback.

Pi exposes no public getter for the currently installed footer. Consequently, when Plan state is inactive, Atlas cannot detect a non-Plan custom footer that was installed before Atlas's `session_start` handler; the deferred Atlas fallback replaces that pre-Atlas footer. Load that footer after Atlas if it should take precedence.

Because this footer is installed after Pi starts, it needs no source-file mutation, restart, or launcher. It remains the default even when container recreation resets Pi's built-in footer file or the container invokes Pi without Atlas's optional launcher.

## Optional built-in footer file patch and launcher fallback

Atlas also retains the guarded, reversible patch engine for Pi's built-in footer. This is an optional fallback for launch environments that deliberately need the compact footer before Atlas can install its runtime custom footer; it is not the normal Atlas path.

The patched built-in footer uses the same compact presentation:

```text
/workspace/project (main) • session-name                 (openai-codex) gpt-5.6-sol • high
Codex · 5h 68% · week 74%
```

It retains the current directory, Git branch, session name, provider, model, reasoning level, and extension status lines. It hides cumulative input/output/cache counts, cache-hit rate, estimated cost, context-window percentage, and the auto-compaction marker. The underlying accounting remains available through Pi's `/session`, RPC, and session data.

Atlas 0.8.0 recognizes only complete reviewed stock or Atlas-patched footer digests for Pi 0.83.0, 0.84.1, and 0.84.2. Unknown versions plus locally or partially modified Pi sources are reported as unsupported and are never changed. Apply/remove preserve file permissions, bind mutation to the reviewed version and source digest, recheck source before an atomic same-directory replacement, and require an explicit confirmation naming the Pi version and target file. Atlas refuses mutation while Plan mode is active or indeterminate. Restart Pi after either operation.

For Pithos image builds and other explicit non-interactive automation, the published package exposes the same engine as a CLI:

```bash
pithos-atlas-patch footer status --pi-dir /path/to/@earendil-works/pi-coding-agent
pithos-atlas-patch footer apply  --pi-dir /path/to/@earendil-works/pi-coding-agent
pithos-atlas-patch footer remove --pi-dir /path/to/@earendil-works/pi-coding-agent
```

The standalone CLI requires an explicit target so build automation cannot accidentally patch a nested development dependency. Set the Atlas-specific `PITHOS_ATLAS_PI_PACKAGE_DIR` instead of `--pi-dir` when an environment override is more convenient. Add `--json` for machine-readable output. The CLI performs the explicit operation requested and does not prompt, making the invocation itself the automation approval boundary.

### Optional launcher fallback in ephemeral environments

The default runtime footer above requires no launcher. If an environment explicitly chooses the built-in-file fallback, a patch applied directly under an ephemeral prefix such as `/opt/pi-npm` disappears when that prefix is recreated. Such an environment can install Atlas in persistent storage and start Pi through its packaged `pithos-atlas-pi` launcher instead. On every startup the launcher finds the next `pi` executable on `PATH`, skips symlinks that resolve back to itself, validates the owning `@earendil-works/pi-coding-agent` manifest and `bin.pi` entrypoint, and runs the guarded footer apply CLI before Pi can import its core modules. An already-patched footer is a no-op. An unsupported package, version, or source causes a safe refusal and Pi is not launched.

On Windows, the launcher recognizes npm's global-prefix `node_modules` and project-local `node_modules/.bin` layouts. It uses the presence of `pi.cmd` only to locate the package: it does not read or execute shim contents, and instead launches the validated package-contained JavaScript entrypoint with the current Node executable.

For example, an image or container entrypoint can expose the persistent launcher transparently as `pi` while leaving the recreated Pi installation later on `PATH`:

```bash
npm install --global --prefix /persistent/atlas --legacy-peer-deps @pithos-kit/atlas@0.8.0
mkdir -p /persistent/pi-wrapper
ln -sfn /persistent/atlas/bin/pithos-atlas-pi /persistent/pi-wrapper/pi
export PATH="/persistent/pi-wrapper:/opt/pi-npm/bin:$PATH"
exec pi "$@"
```

The isolated launcher installation uses `--legacy-peer-deps` so npm does not auto-install Atlas's Pi peer under the persistent prefix. Keep the Atlas bin directory itself out of the launcher's search `PATH`; the wrapper symlink already resolves the launcher. The wrapper path must precede the intended real Pi bin directory. The launcher forwards Pi's arguments and standard streams unchanged and propagates its exit code or terminating signal. It produces no patch status output during successful startup; patch diagnostics go to standard error on refusal. `pithos-atlas-pi` may also be invoked directly when replacing the command name is unnecessary.

## Software-development workflow migration to Guild

Software-development skills and commit workflows now belong to [`@pithos-kit/guild`](https://www.npmjs.com/package/@pithos-kit/guild), so Atlas no longer bundles or advertises TDD or Conventional Commit capabilities. Pair Atlas 0.6.0 or later with Guild 0.3.0 so exactly one active package owns `/commit`, `create_commit`, `conventional-commit`, and TDD. Loading Guild 0.3.0 beside an older Atlas release causes duplicate command, tool, and skill ownership.

The earlier `@pithos-kit/skills` package remains retired. Remove it at every scope where it was installed, then remove its future-build pin through `/pithos config`:

```bash
pi remove npm:@pithos-kit/skills       # global settings
pi remove -l npm:@pithos-kit/skills    # current project's settings
```

Opening `/pithos config` with a retired Skills pin stages its removal for review; Atlas will not preserve or re-offer that package. Use `pi list` to check both effective package scopes and remove any earlier legacy Skills identity too.

## Interactive configuration

`/pithos config` manages:

```yaml
toolchains:
  dotnet: "<exact-version>"
  go: "<exact-version>"
  rust: "<exact-version>"
pi:
  version: "..."
  extensions:
    "@pithos-kit/...": "npm:<exact-version>"
```

Configure has three steps: select the Pi version, select Pithos toolchains and their exact numeric versions, then select pithos-kit packages. Atlas preserves unknown keys, comments and ordering where YAML document editing permits, and third-party `pi.extensions` entries. It never edits `.pithos.d/`, installs packages, changes the active Pi process, or rebuilds Pithos.

The toolchain and package selectors use `◆` for selected entries, `◇` for available entries, and `◈` for changes staged in the wizard but not yet submitted. The package step presents one alphabetized list using compact version labels; an `↑` between versions means an update is available. Selected-Pi requirements are called out inline. When registry metadata is unavailable, Atlas labels bundled fallback versions explicitly instead of presenting them as latest. Press Escape to cancel any selector.

A configuration transaction:

1. requires a trusted TUI project and waits up to ten seconds for the agent to become idle;
2. refuses to run while `@pithos-kit/plan` Plan mode is active or indeterminate;
3. reads only `<cwd>/.pithos` and rejects links, special files, aliases, duplicate keys, malformed managed nodes, and oversized input;
4. stages exact Pi and npm versions in memory;
5. shows a contextual diff;
6. asks with `No` before `Yes`;
7. rechecks trust, idle/Plan state, file type, and original bytes inside Pi's per-file mutation queue;
8. writes and synchronizes a same-directory temporary file before atomically replacing the target.

Cancellation, an idle-wait timeout, and pre-commit errors leave `.pithos` unchanged. Footer patch apply/remove uses the same bounded idle wait and does not start its child process if Pi remains busy. After a successful write, rebuild/restart Pithos before expecting the selected Pi or package versions to be active.

## Agent tools

Atlas registers the validated `rename_session` tool and the read-only `pithos_info` tool. Footer patch application is deliberately not model-callable. `pithos_info` supports these actions:

- `catalog`
- `versions`
- `runtime`
- `config`
- `doctor`

The `catalog`, `versions`, and `runtime` actions accept an optional `package` filter. Registry-backed `versions` and `doctor` calls also accept `refresh: true` to bypass successful session caches.

The tool has no write, apply, update, install, or rebuild action. Only a user-confirmed `/pithos config` TUI transaction can modify `.pithos`.

## Registry and offline behavior

Atlas performs no network request during extension registration, session startup, command completion, `/pithos help`, or `/pithos packages`. Only the first user message in an eligible new unnamed session may start the bounded synthetic-name model request described above. Version, doctor, and configuration actions may query `https://registry.npmjs.org` with fixed-origin requests, short timeouts, cancellation, bounded responses, validated metadata, and successful-result session caching.

Set any of the following to disable registry requests:

```bash
PI_OFFLINE=1 pi
PI_OFFLINE=true pi
PI_OFFLINE=yes pi
```

When offline, session naming uses its local fallback. Registry operations—including response-body streaming—are bounded by the same request timeout. Operations that are timed out, unpublished, or otherwise unavailable use the generated bundled catalog and clearly report that latest registry data is unavailable. The interactive manager can still select bundled exact versions; registry-only versions are unavailable until a successful explicit check.

## Troubleshooting stuck operations

Start with `/pithos packages`: it is local and does not contact npm. Run `/pithos doctor` to see bounded phase timings and press Escape to cancel its registry-backed work. To isolate registry access entirely, restart as `PI_OFFLINE=1 pi`; Atlas then uses bundled metadata. If `/pithos config` or a footer apply/remove action reports that Pi did not become idle, abort or let the current model run finish and retry. Atlas refuses after ten seconds and guarantees that no configuration or runtime-file change was started.

## Development

Atlas targets Pi `0.83.0` APIs for compatibility while this repository currently pins Pi `0.84.2` in `.pithos`. Context Bar still honestly reports its separate Pi `>=0.84.1` requirement.

```bash
cd pithos.atlas
npm install
npm run catalog:generate
npm test
npm run typecheck
npm pack --dry-run
```

The generated snapshot at `src/generated/catalog.json` is derived from every package's `pithosKit` manifest metadata. Tests fail if it is stale.

Atlas's shipped runtime dependencies pass `npm audit --omit=dev`. The development tree intentionally pins Pi `0.83.0` for compatibility testing, so a full development audit may also report advisories inherited from that older Pi toolchain.
