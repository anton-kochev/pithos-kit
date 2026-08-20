# Repository instructions

## Repository structure

- This is an npm monorepo of independently published `@pithos-kit/*` Pi packages.
- Each `pithos.*` directory is a standalone package with its own `package.json`, tests, dependencies, compatibility requirements, and release workflow.
- This is not an npm workspace. Run package commands from the affected package directory.
- The root package provides repository-wide metadata checks and Atlas catalog generation; root `npm test` does not run every package's tests.
- Consult the affected package's `package.json`, `README.md`, `tsconfig.json`, and release workflow before changing it.

## Development

- Use npm. Use `npm ci` when the affected package has a lockfile.
- Release workflows use Node.js 24, but package manifests remain authoritative for published compatibility.
- Packages use ESM. Preserve explicit `.ts` import extensions where already used.
- Follow the nearest `tsconfig.json`; there is no shared root TypeScript configuration.
- There is no repository-wide lint, formatter, build, or type-check command. Preserve local formatting and avoid broad style-only changes.
- Do not discard or overwrite unrelated working-tree changes.

## Validation

For each changed package:

```bash
cd pithos.<name>
npm test
npm run typecheck   # only when defined
npm pack --dry-run  # when package metadata or published contents change
```

From the repository root:

```bash
npm test
```

- Root tests validate package identities, metadata, release workflows, lockfile roots, READMEs, and the generated Atlas catalog.
- Use package scripts instead of reconstructing their underlying test commands manually.

## Metadata and generated files

- `pithos.atlas/src/generated/catalog.json` is generated from package manifests.
- After changing package identity, version, description, `pi`, or `pithosKit` metadata, run:

```bash
npm run catalog:generate
npm test
```

- Do not manually edit generated `.pithos.d/` contents.
- Treat `.pi/`, `node_modules/`, `dist/`, logs, and exported session files as local artifacts unless a task explicitly targets them.

## Releases and external changes

- Packages version and release independently through package-specific tags and GitHub workflows.
- Do not change versions, create tags, publish packages, or rewrite release history unless explicitly requested.
- Do not run scripts under `scripts/pi-patches/` unless explicitly requested; they modify the installed Pi runtime outside this repository.
- Treat historical sections of `CUTOVER.md` as records, not current release instructions.

## Package-specific instructions

- Add nested `AGENTS.md` files only for stable package-specific architecture, compatibility constraints, generated assets, or additional validation.
- Nested instructions should complement these repository-wide rules rather than duplicate them.
