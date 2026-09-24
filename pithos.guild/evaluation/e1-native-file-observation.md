# E1 native selected-file observation

**Status: provider-free filesystem observation implemented, not integrated into native execution.** Tests use inert temporary files. No installed runtime inventory, Pi/SDK/provider probe, real credential, host run or model trial was used in this increment.

## Contract

`src/native-file-observation.ts` supplies two operations:

- `observeNativeFiles(expected)` compares actual filesystem bytes against an explicit ordered inventory of `{ id, path, sha256 }` entries.
- `assertNativeFiles(expected, prior)` repeats the observation and requires the complete result to match, including inventory digest and file identities. Equal-content inode replacement fails.

Expectations are **inputs, not approval**. No discovery, implicit baseline, fallback, self-updating hash or file execution occurs. The caller must eventually supply a separately reviewed, closed runtime/implementation selection and bind it to the frozen campaign. This helper does not establish that selection.

The inventory must contain 1–256 entries with unique labels and paths, exact keys and lowercase SHA-256 hashes. Labels are bounded ASCII identifiers, not filesystem destinations. Paths must be absolute, canonical and at most 4096 UTF-8 bytes, with no NUL or symlink aliases. Values are copied before filesystem reads.

Files must be regular, single-link, owned by root or the current UID, and not group/world writable. Before any byte read, metadata must fit **256 MiB per file / 512 MiB total**. These are selected-file observation bounds, not changes to container memory, PID/thread, CPU, timeout or spending limits.

Each file is opened with `O_NOFOLLOW | O_NONBLOCK`. Descriptor metadata must match the preflight metadata. Bytes are hashed through 64 KiB chunks, handling short reads and allowing at most one extra byte to detect growth. Successful observations match the exact initial size and expected SHA-256. Before/after descriptor and path stamps compare device, inode, mode, links, owner/group, size and nanosecond modification/change timestamps. A final path-stamp pass checks earlier files after later reads. Descriptors close on success and failure.

The frozen result contains:

```text
version: 1
kind: native-selected-file-observation
inventoryDigest: digest of the selected input values, including exact paths
files: [{ id, sha256, bytes, dev, ino, uid, mode }]
```

Device/inode values are lossless decimal strings. Literal paths and file contents are not returned. Labels, hashes and identity metadata remain private correlation data, not universal redaction. Errors are fixed: `Native file observation mismatch`.

**Digest conventions are explicit:** entry `sha256` hashes raw bytes. This is not interchangeable with the legacy implementation collector's `digest(base64(bytes))`. The inventory digest uses the evaluation canonical-object digest. No historical digest or artifact is converted or backfilled.

## Test-first evidence

`npm run eval:test` drove capture, byte-drift rejection, closed/bounded input validation, unsafe-file rejection, aggregate preflight, during-read replacement/rewrite detection, final inventory recheck and prior-observation comparison through observed RED/GREEN cycles.

Additional pins cover exact size admission, bounded streaming/short reads, descriptor cleanup and immutable expectation values. The large-size fixtures use sparse metadata and deliberately stop at the read boundary: **they do not read hundreds of MiB or claim successful maximum-size hashing**. Actual streaming is verified with a 200,000-byte inert file.

Controlled changes were made only in disposable copies:

| Copied mutation | Test that went RED | Diagnostic |
| --- | --- | --- |
| Reject the exact 256 MiB boundary | Size-admission pin | Zero read attempts instead of one |
| Increase the read buffer to 128 KiB | Bounded short-read stream | Fixed mismatch after the fixture's chunk-bound assertion |
| Omit descriptor close | Cleanup pin | Missing expected `EBADF` |
| Discard the input snapshot | Expectation-mutation pin | Fixed mismatch instead of successful original-input observation |

An exit trap removed both copies. Maintained controls, historical evidence and isolation settings were not changed. Self-inspection is not independent review.

Final local checkpoint: **192 evaluator / 135 Guild / 2 root tests passed**, both typechecks passed, Bash syntax and whitespace checks passed, development-bank digest unchanged, seeded schedule generated without execution, dry-run package 39 files, index empty.

## Remaining integration and limits

Follow-up: [runtime requirement and executable correlation](./e1-native-runtime-observation.md) now consumes this observer for the closed historical runtime selection and compares Node's selected file identity with a before/after procfs image observation. Verification uses synthetic filesystem fixtures; actual producer/configuration integration is still pending.

The existing `offline-runtime.ts` inventory, legacy `pi-driver.ts` implementation fingerprint, fixed synthetic launch/preload and Docker copied-file roster are deliberately unchanged. None imports this helper yet. Their historical checkpoints are not promoted by these tests.

Next work must establish the reviewed file selection, observe it from the actual launch/producer boundary, correlate it with trial/invocation/auth identity and retain/re-audit the resulting evidence. Runtime identity, loaded implementation/resources, serialized instructions/continuation, native receipts and historical resume remain incomplete. All native admission/driver/probe gates stay closed, with independent review still required before live readiness.

These are cooperative, non-atomic filesystem observations—not loaded-code proof, dependency closure, continuous monitoring or hostile-code containment. Repeated stat checks cannot eliminate every race or detect changes restored between observations. Synchronous filesystem calls can block; byte bounds are not wall-clock deadlines. A matching hash does not establish provenance, authorization, credential use, transport policy, billing or spending authority.
