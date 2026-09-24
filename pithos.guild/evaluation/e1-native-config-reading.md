# E1 native configuration byte correlation

Milestone 1 remains incomplete. This increment connects a bounded, provider-free reader to the existing producer preload and both fixed synthetic bootstraps. It does not enable native admission, configuration issuance, SDK/provider execution, or receipt acceptance.

## Writer and reader contract

`prepareNativeLaunch()` serializes configuration once, rejects UTF-8 output above 65536 bytes before creating artifacts, writes the exclusive private file, and returns `GUILD_EVAL_NATIVE_CONFIG_SHA256` for those exact bytes. This is **raw-byte SHA256**, not the auth file's existing `digest(base64(bytes))` or canonical-object runtime-requirement digest. Existing digest conventions are unchanged.

`readNativeConfig(file, sha256)` requires:

- an explicit lowercase 64-hex expectation and canonical absolute path, at most 4096 UTF-8 bytes, without aliases or NUL;
- `O_NOFOLLOW | O_NONBLOCK`, regular single-link file owned by the current UID, no group/other permissions;
- size at most 65536 bytes before reading, with one additional growth-detection byte and short-read handling;
- stable descriptor/path device, inode, mode, link count, owner/group, size and nanosecond modification/change stamps, plus final canonical-path agreement;
- matching raw-byte digest, strict UTF-8 and object-root JSON;
- recursively frozen returned data and descriptor closure on success/failure.

Failures have the fixed message `Native configuration observation mismatch`, without path/content diagnostics. This reader validates bytes and filesystem observations, **not the complete native configuration schema or its issuer**. An equal-content replacement completed before the read is not rejected merely for having another inode: there is no previously supplied configuration inode expectation. During-read replacement is rejected. There is no continuous monitoring, hostile-code containment, or authority in a caller-supplied path/hash pair.

## Actual consumption

The native preload checks the file/digest pair before using even `piEntry` to decide whether the process is a Pi producer. Either variable being present activates validation; half-configured environments fail closed. This prevents changed configuration bytes from changing the CLI selector and silently skipping instrumentation. With valid unchanged configuration, ordinary non-Pi tools still pass through.

The existing `admissionBinding` stop remains after loading and before SDK imports. Matching bytes cannot enable a currently unsupported bound configuration. The independent auth-identity and unsupported-binding tests recompute their **synthetic fixture** digests deliberately so they still exercise their own checks rather than only a hash mismatch.

Both fixed synthetic bootstraps now use the same reader before their dispatcher import. The copied asset roster adds `native-config.ts`. This is source integration plus mocked-Docker asset verification, **not a fresh restricted-host result**. Old configurations without the digest environment entry are not given a compatibility bypass, and old retained runs are not rewritten or reclassified.

## Local evidence

RED/GREEN demonstrated a missing reader API, missing writer digest, oversized writer acceptance, missing copied asset, and preload bypasses. The changed CLI selector and missing path REDs executed only the inert test CLI and exited zero; missing digest reached only the one-line local print-and-throw import tripwire. No installed SDK/provider or real credential was loaded.

Reader invariants were then pinned with synthetic files and mocked filesystem/UID boundaries. These pins passed initially; disposable-copy sensitivity made five tests fail:

| Copied mutation | Diagnostic |
| --- | --- |
| Freeze root only | Nested array was not frozen |
| Omit SHA comparison | Missing expected digest rejection |
| Permit 65537-byte preflight | One byte-read call instead of zero |
| Omit descriptor close | Missing `EBADF` |
| Omit descriptor/path stability | Missing replacement rejection |

That copied run had 250 tests, five expected failures; both copies were removed by an exit trap. Maintained controls were never weakened. Two local typecheck failures were corrected: optional POSIX `getuid` typing in a mock, and an explicit session-policy projection replacing an overly broad object spread. Neither was counted as behavioral RED. Self-inspection is not independent review.

Final local checkpoint: **245 evaluator / 135 Guild / 2 root tests passed**, both typechecks passed, Bash and tracked/untracked whitespace checks passed, development-bank digest unchanged, schedule generation only, dry-run package 39 files, index empty. Admission, driver, old-probe and bound-config stops remain in place.

## Remaining boundary

The later [driver hookup](e1-native-driver-configuration.md) now calls its admitted configuration callback behind the existing stop. Actual native issuance/execution remains blocked and untested. The later [runtime-requirement loader](e1-runtime-input-loading.md) now reads and correlates the fixed sibling before the unchanged bound-config stop. Complete configuration/schema/issuer expectations, concrete reviewed Guild/runtime observations, producer event binding, final transport/request/continuation correlation, and secure native receipts/resume remain unfinished. Approved independent review and separately authorized fresh restricted integration still precede live comparisons. No model spending, host run, dependency/runtime/resource-limit change, commit or release occurred.
