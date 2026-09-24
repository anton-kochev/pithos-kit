# Authorized Mac image inspection — prepared, not executed

Status: supplemental static roster revision prepared and inertly tested only; independent review of this revision is pending. Independent review and supplemental metadata review approved the tooling with no findings; neither constitutes runtime or operational acceptance. No Docker operation has been performed for this change. This does not approve C1–C8, runtime selection, campaign execution or any admission/preload/driver/history/settlement gate. No frozen input, manifest or archive is replaced.

From the repository root on the authorized Mac, with Docker already available and the pinned image already local:

```sh
bash pithos.guild/evaluation/inspect-runtime-image.sh
```

No arguments, downloads, login, providers or credentials are required. Do not install anything or pull an image to make this work. Requires macOS Bash 3.2, Perl, `shasum` and standard system utilities; it does not require Node/Python or execute any extracted bytes. `DOCKER` defaults to `docker`; tests set it to an absolute inert fake executable. Use only a trusted local Docker client/daemon/context. Do not use a remote context.

## Scope and output

The script pins image `sha256:edcbed99a004b66c67c0dd1d3ea794d6c0a2e83da18be770aeddedeff534dbff`, verifies ID/Linux/arm64 and permits only the explicitly reviewed `Config.User` metadata spellings `pi` or `501`, rejecting declared volumes **before create**. The supplied runtime UID 501 observation under `--user pi` does not establish image `Config.User="501"`; prior image configuration was `pi`. Neither an accepted name nor numeric metadata independently proves an actual runtime UID, and GID is not attested. The Go template uses `index .Config "User"` and `index .Config "Volumes"` for missing-safe map lookup; a missing/unexpected user still fails the allowlist. Image metadata retained is only ID, OS, architecture, user and volume-presence, not environment or labels. Supplied Node 24.20.0 and Pi/pi-ai 0.87.0 are owner metadata, **not verified version claims**. No binary, SDK, installed runtime or procfs probe is used.

One randomly named container is created with pull disabled, a nonexecuting entrypoint placeholder, network disabled, read-only filesystem, dropped capabilities, no-new-privileges, explicit `--user=501:501` and resource limits (512 MiB memory, one CPU, approved PID limit 64). These are create options, not observed runtime identity. It is **never started**; there are no mounts. Exactly 15 static leaf paths are copied individually: the unchanged 13 paths in `src/native-input-contracts.ts`, in their original order, then the two explicitly reviewed supplemental paths below. No export, directory/root/home/config copy, start/run/exec/build/pull occurs.

`Output:` names a private mode-0700 temporary directory; it is intentionally retained on success and failure. It contains:

- `image.tsv`: the five selected metadata values above.
- `inventory.tsv`: three tab-separated columns: source path, SHA-256 (Mac `shasum -a 256`), classification (`native-runtime13` or `supplemental-static`). This is an inspection summary, not a native runtime input artifact.
- `observations.tsv`: accepted regular-file type, actual byte size and local numbered file mapping, or failure category.
- `files/1` through `files/13`: the original native runtime13 roster, with unchanged local numbering; `files/14` and `files/15`: supplemental static bytes. All are 0600, never executable.
- Small operation diagnostics; on failure an untrusted partial tar/file may remain. Do not open it with an automatic archive extractor.

### Supplemental STATIC observations — not native requirements

The supplied extracted `dist/cli.js` imports `./cli/setup.js` and `./main.js`;
`dist/cli/setup.js` imports `../config.js` and `../core/http-dispatcher.js`.
Setup and the dispatcher were already selected. Only these two observed gaps
are appended, under `/opt/pi-npm/lib/node_modules/@earendil-works/pi-coding-agent/`:

| Local file | Supplemental source suffix | Inventory classification |
| --- | --- | --- |
| `files/14` | `dist/main.js` | `supplemental-static` |
| `files/15` | `dist/config.js` | `supplemental-static` |

Both must copy and pass the same strict extraction and aggregate bounds; a
missing/inaccessible or unsafe supplemental leaf makes inspection fail closed
and still attempts owned-container cleanup. Partial output is not completion.
The immutable/versioned native runtime13 requirement, policy, input contracts
and admitted digests are unchanged. The classification is not an admission or
trust claim for either group. This is not a recursive scanner, full dependency
closure, or proof that launch dependencies are closed. Further static imports
may be followed only in a later explicitly reviewed inspection revision.

Inspect-only bounds are 128 MiB per regular leaf, 256 MiB aggregate selected bytes, and 128 MiB + 64 KiB per temporary tar (Bash file-size limit). A strict tar reader accepts exactly one correctly checksummed, basename-only regular ustar entry plus zero terminators/padding. Symlinks, hardlinks, directories, extra entries, prefixes, traversal, sparse/PAX/GNU extensions and oversized leaves are rejected, not followed or expanded. Unsupported tar encoding is a safe stop, not permission to relax the reader. A failed Docker copy reports missing **or inaccessible**, without inventing an absent-file stat; consult the private copy diagnostic to distinguish these. A returned tar type is an observation, not a runtime stat probe.

Docker may resolve **parent source symlinks inside the container filesystem**. This procedure cannot attest to parent components, pristine image runtime behavior, a dependency closure, or selected-byte trust. It is only a bounded observation of selected bytes exposed by the trusted daemon. Do not treat matching digests as an execution approval.

## Abort and cleanup

No macOS `timeout` utility is assumed. Docker operations (including cleanup) are foreground and have **no automatic wall-clock deadline**. If an operation stalls, press Ctrl-C. If the daemon/client does not return, stop this inspection and recover Docker locally; do not repeatedly launch copies of the script. Shell traps cannot guarantee cleanup after SIGKILL, terminal loss or daemon failure.

Cleanup removes only the full 64-hex ID actually returned by this invocation's create, including a returned ID recovered after failure/cancellation. It never removes a resource by name, so a name collision cannot delete a preexisting container. Removal uses `rm -v`, without force; the container should never have run. Cleanup failure returns nonzero and prints the owned ID and retained output, never a success claim.

If create was cancelled before returning a full ID, its random name is printed as a **manual reconciliation hint only**. The operation may have reached the daemon. Do not automatically delete that name or an ID guessed from it. Once Docker responds, reconcile the creation with the local daemon and returned-ID evidence; if ownership cannot be established, retain/report the unresolved resource rather than deleting somebody else's container. Never start it. If cleanup stalls, Ctrl-C/daemon recovery and the same ownership rule apply. Keep this inspection marked incomplete until owned cleanup is confirmed.

## What to paste back

Paste only: script exit status; whether owned cleanup completed; `image.tsv`; `inventory.tsv`; and `observations.tsv` (or the first failed selected path and its failure category). Include supplied versions explicitly as **owner-supplied/unverified**. Do not paste full raw selected files, tar archives, Docker inspect output, environment, labels, credentials or raw diagnostic files publicly. Review any diagnostic locally and share only a sanitized short error category. Delete the retained private directory manually when no longer needed.

## Development verification

Tests inject an absolute inert fake Docker binary; they do not invoke real Docker. The focused runner is:

```sh
cd pithos.guild
node --import tsx --test evaluation/test/inspect-runtime-image.test.ts
```

Observed test-first RED: missing script (exit 127); GREEN after implementation. A second RED showed a full returned create ID was not cleaned when create exited nonzero; GREEN after trap recovery. Follow-up coverage checks exact roster, hardening flags, volumes/architecture rejection before create, collision ownership, missing/symlink/directory/malformed/oversized archives, cleanup failure, and cancellation with/without a returned ID. The cancellation test initially over-specified exit 143; unresolved ownership intentionally overrides it to exit 1, so the assertion now requires nonzero (no production change or behavioral RED claim). Independent review approved that prior script. Supplemental review approved the metadata correction; actual authorized Mac inspection remains outstanding.

Historical verification for the prior script: focused tests **7 passed**; `npm run eval:test` (**412 passed**) and `npm test` (**136 passed**) passed (logs `/tmp/inspect-image-eval.log`, `/tmp/inspect-image-guild.log`); `npm run eval:typecheck`, `npm run typecheck`, `npm run eval -- validate`, root `npm test` (**2 passed**), `bash -n evaluation/inspect-runtime-image.sh`, `perl -c evaluation/inspect-runtime-leaf.pl`, and `git diff --check` passed. Bash/Perl syntax checks were invoked from the repository root with the `pithos.guild/` prefix. Host here was not macOS; native Mac execution remains unverified. No dependencies, gates, policy, runtime, spending, staging or commits changed.

Metadata correction verification: test-first RED had three failures (PID limit 64, accepted `pi`, and missing-safe template source); GREEN has **9 focused tests passed**. Tests accept `pi` and `501`, reject unexpected/empty users, wrong ID/OS/architecture and declared volumes before create, and retain cleanup/never-start coverage. Missing-safe template coverage is a source contract only: the inert fake returns metadata and does not evaluate Go templates or prove real Docker behavior. `npm run eval:typecheck`, `npm run typecheck`, `bash -n pithos.guild/evaluation/inspect-runtime-image.sh` and `git diff --check` passed. No real Docker, runtime probes, gates or dependency operations were run for this correction; no actual UID/GID was independently proven. Supplemental read-only review approved the correction with no findings; the reviewer did not independently execute these tests or Docker.

Supplemental static roster revision: test-first RED observed omitted `main.js` /
`config.js` in the exact roster and erroneous success for `main-missing` (8 passed,
2 failed). GREEN: 10 focused tests passed, including each supplemental position
under missing, symlink, directory, oversized, traversal, extra-entry and checksum
failures. Exact bytes, numbering, classifications and owned cleanup are checked.
The strict Perl reader is unchanged. No real Docker or extracted runtime was
executed; native Mac behavior and independent review of this revision remain
outstanding.

Revision verification (repository Linux host, inert fixtures): from
`pithos.guild`, `node --import tsx --test evaluation/test/inspect-runtime-image.test.ts`
(**10 passed**), `npm run eval:test` (**415 passed**), `npm test` (**136 passed**),
`npm run eval:typecheck` and `npm run typecheck` passed. From the repository root,
`npm test` (**2 passed**), `bash -n pithos.guild/evaluation/inspect-runtime-image.sh`,
`perl -c pithos.guild/evaluation/inspect-runtime-leaf.pl` and `git diff --check`
passed. RED/GREEN logs: `/tmp/inspect-supplemental-red.log` and
`/tmp/inspect-supplemental-green.log`; broader test logs:
`/tmp/inspect-supplemental-eval.log` and `/tmp/inspect-supplemental-guild.log`.
