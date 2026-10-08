# Clio

Automatic, evidence-backed documentation capture for Pi. Requires **Pi 1.0.3 or later** and Node.js **22.19.0 or later**. Package version: **0.0.3**.

Clio turns useful code and investigation evidence into ordinary, unstaged documentation diffs. Installation **and loading** activate it: there is no enable flag or manual capture command.

## Install and remove

Project-local installation is recommended:

```bash
pi install -l npm:@pithos-kit/clio
```

Global installation (`pi install npm:@pithos-kit/clio`) applies in other projects too. From a checkout, use `pi install -l ./pithos.clio`, or try `pi -e ./pithos.clio` for one invocation. Project resources remain subject to Pi project trust; Clio also skips untrusted contexts.

Use `pi config --local` (or `pi config` globally) to disable the extension. Pi-native package filters work normally:

```json
{"packages":[{"source":"npm:@pithos-kit/clio","extensions":[]}]}
```

Remove with `pi remove -l npm:@pithos-kit/clio` or `pi remove npm:@pithos-kit/clio` for the global installation. Reload/restart to replace the active extension runtime. Removing an installation does not undo existing diffs or unload code already running.

Pithos configuration, if used:

```yaml
pi:
  extensions:
    "@pithos-kit/clio": "npm:0.0.3"
```

## Automatic scheduling, not forced execution

Clio offers one capture opportunity at **whole-run `agent_before_settle`**, after existing queued work drains. A successful edit/write, or at least two successful reads since the latest user message, qualifies as coding or investigation activity. Recorded nested read/edit/write calls (such as codemode calls) count too. It does not infer arbitrary shell, delegation, external-process or hidden tool effects; those runs can be missed without qualifying file observations.

The boundary preserves other extensions' entries, records a branch-local attempt, and supplies a nonce-bearing message requesting the model-only `clio_capture` tool. **The model can decline or omit this call.** Pi exposes no public queue reservation or forced invocation API. Omitted attempts are reported as skipped, not successful captures.

Once invoked, the entire worker and guarded application run inside one awaited **sequential** parent tool. Mixed tool batches, unsolicited/repeated/stale nonces, newer input, queued messages, session changes and lost permissions reject or cancel capture. Existing queued work can therefore take priority before invocation; capture is not guaranteed before every next user task. Reload uses the current branch's attempt marker and never revives its nonce. Navigation to an alternative branch uses that branch's history, not abandoned siblings.

Clio skips aborted/error runs, child sessions identified by Pi's `parentSession` metadata, active or malformed/indeterminate Plan state, untrusted projects, unavailable built-in edit tools, and recognized explicit read-only requests. It never reactivates tools removed by Plan. Permission hooks remain authoritative during application.

Read-only intent recognition is deliberately conservative text matching, **not a universal permission flag**. Common `read-only`, `do not edit/change/write`, `never edit`, `ask before modifying`, `no edits/changes/writes`, and `only inspect/review/explain` forms are recognized across **all user messages on the current branch**, including prior persistent instructions. Clio does not infer revocation from a later task; this can over-refuse previously restricted branches. It can miss paraphrases or decline a task that merely discusses read-only behavior. Use Plan or remove mutation tools for mechanical restrictions. Clio is not an OS sandbox.

## Configuration

Optional project-local `.pi/clio.json` (read on each capture; no global Clio-specific file):

```json
{
  "model": "anthropic/claude-sonnet-4-6",
  "thinking": "high",
  "docsDirs": ["handbook"],
  "timeoutMs": 180000,
  "maxTurns": 20,
  "maxContextBytes": 120000,
  "maxResultBytes": 32000,
  "maxFiles": 24,
  "maxEdits": 8
}
```

Omit `model` and `thinking` to inherit the parent's current selections independently. An override uses `provider/model-id` (model IDs may contain slashes). Thinking values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and must be supported by the selected model. Unavailable models and unsupported thinking produce a problem, **never a silent fallback**. Registry streaming uses the parent's configured provider/auth interface; no private runtime access or separate credentials are used. Virtual-model routing has not been verified.

All fields are optional; unknown fields, null values, malformed JSON, symlinked configuration, and invalid limits fail closed. Defaults are shown above except model/thinking inherit and `docsDirs` defaults to `[]` (additional directories).

| Limit | Permitted range |
|---|---:|
| timeoutMs | 1,000–600,000 |
| maxTurns | 1–40 |
| maxContextBytes | 1,000–500,000 |
| maxResultBytes | 1,000–100,000 |
| maxFiles | 1–64 |
| maxEdits | 1–20 |

Limits are integers. Configuration itself is limited to 16 KiB. At most 16 additional relative directory names are accepted; path components use letters, numbers, underscores or hyphens. Safety exclusions cannot be configured away.

The worker can perform **bounded read-only investigation rounds** before its final proposal. `maxTurns` caps total provider requests, including the final response, not just the initial analysis. At most eight tool calls are accepted per response. Unknown tools, mutations, malformed batches, safety refusals and stale evidence terminate capture without retries. Ordinary file-count, evidence-byte or evidence-response-byte exhaustion instead returns structured `status: "capacity"` feedback with a `refusal` containing `limit`, `current`, `requested` and `max`. Refused content is never registered or returned; the worker may finalize using previously verified snapshots (including a valid empty proposal). It must never cite refused/unread content. An authorized directory listing whose directory or parent is absent returns only `{status: "not-found", action: "list", path}` feedback. It contains no evidence, registers no snapshot and creates nothing; the worker should finalize without retries using existing snapshots/session excerpts, or return a valid empty proposal. Missing paths cannot be cited. Missing file reads, permission errors, non-directory components, scope violations and unsafe paths (including dangling symlinks) still terminate capture. This does not relax request context/turn caps or guarantee another request fits. Context is checked before every provider request and includes policy, schema, task prose and cumulative tool results; small limits or repeated reads can exhaust it. Discovery examines bounded relevant docs trees (three nested levels, at most 100 entries per directory and approximately 100 directories). Initial and newly read snapshots share `maxFiles` and evidence-byte limits. Oversized or excluded files are skipped/refused rather than truncated into misleading repository evidence.

## Evidence and destinations

Clio snapshots observed source files, relevant ancestor `README.md` files, and Markdown under relevant `docs` directories or configured `docsDirs`. Existing **`README.md`** or **`.md` under `docs`/designated directories** may be changed. New Markdown pages may be proposed in bounded, independently discovered documentation directories. No bulk wiki scaffolding.

**New pages use exclusive publication, never ordinary `write`.** Discovery includes empty existing root/ancestor `docs` and configured `docsDirs`, including safe subdirectories (three nested levels, at most 100 directories and 100 inspected entries per directory). It is independent of the file-snapshot budget and performs no writes. If root `docs` is absent, the parent may authorize that one nonrecursive directory creation. Missing ancestor/configured trees, root `README.md` creation, and arbitrary scaffolding are refused. A new basename has 1–80 ASCII letters/digits/underscores/hyphens (first character alphanumeric) followed by `.md`, and all existing exclusions still apply. The combined edit/create count is bounded by `maxEdits`.

The worker receives only bounded `{path,missing}` destination metadata, not capabilities or filesystem identities. Its optional `creates:[{path,content,findings}]` shares the proposal’s evidence/reference validation, safe-content policy and duplicate-path rejection. Existing files, directories and dangling symlinks are collisions, never replacement candidates. An empty proposal stays quiet, including when `docs` is missing.

Fixed exclusions cover hidden paths (including `.pi`, `.git`, `.pithos.d`), dependencies/vendor/build/dist/coverage/assets/generated/skills/prompts/instructions paths, AGENTS/CLAUDE/SKILL/SYSTEM/APPEND_SYSTEM documents, secret-like filenames, binary/NUL content, known generated markers and common credential patterns. Source extensions are a conservative set of programming languages plus Markdown; configuration, logs and raw session transcripts are not evidence inputs. Symlinks, hard links, escapes and files outside the canonical project root are refused.

The isolated plain Agent has one package-owned **`clio_evidence` list/read tool**, no mutation tools, repository resource loader, extensions, skills, shell, delegation, downloads or recursive Clio. Reads are scoped to initial source directories, existing snapshot paths, eligible ancestor `README.md` paths and eligible documentation directories. Ancestor READMEs remain eligible even when omitted from initial snapshots, but their surrounding directories are not opened as evidence scopes; reads still pass all exclusions and shared budgets. The tool declares explicit scopes and exact readable paths; an exact path never grants permission to list its parent or siblings. A root-only README observation does not authorize package subtree listing, and the worker is instructed to return a valid empty proposal when relevant evidence is inaccessible. Out-of-scope requests still terminate capture. A root-level source observation permits root-level files, not arbitrary unrelated subtrees. Lists are immediate (at most 100 inspected entries), reuse canonical/symlink/content exclusions, and disclose only eligible names plus `fileSizes` (whole-file UTF-8 bytes). Listing eligibility checks read files on the host but do not register them or expose content to the worker. The initial prompt and listings supply `budget`: current/max file count and serialized snapshot bytes, plus remaining file/byte allowance. Raw sizes exclude JSON escaping and snapshot overhead and are planning hints, not reservations; listings remain response-bounded. Workers should prioritize small relevant files and reserve room/turns for finalization as budgets run low. Read content is registered in host-owned snapshots only after evidence and response budget checks, before use; no partial evidence reads are introduced. Under shared budgets, references and source baselines include these newly explored files.

Clio also supplies bounded **recent user text and assistant prose**, explicitly labeled untrusted prior-task observations/instructions, never worker control. It prioritizes the latest user task and up to two prior user messages, then recent assistant prose after the latest user. At most 12 excerpts, 2,000 characters each, fit within the smaller of 16,000 serialized bytes or one quarter of `maxContextBytes`. Each has its host entry ID, role and truncation marker. Thinking, raw tool calls/results, custom/system entries, environment blocks and the full transcript are not forwarded. Common credential assignments/phrases (including unquoted passwords/tokens), bearer tokens and private keys are redacted from prose; matching repository files are refused entirely.

Generated-warning detection treats line-leading `DO NOT EDIT` warnings (including common comment/Markdown prefixes and `WARNING:`) as markers, not incidental in-sentence mentions of read-only instructions. Other generated-marker checks remain conservative, including mentions in prose. Lower-case plural bearer tokens are recognized as noun prose only before `are` or `and private keys`, unless introduced by an authentication header, assignment delimiter or quote. Other candidates still redact the entire line, and any real credential match still refuses the entire repository file; benign prose does not override other matches. This is a narrow grammatical heuristic, not a semantic guarantee: an actual value spelled `tokens` embedded in the same noun-like prose is indistinguishable, while differently phrased benign documentation can still be refused. There are no filename exemptions.

Secret/generated/instruction detection is heuristic, not complete redaction. Excerpts omit older decisions and may truncate relevant qualifications; Clio cannot reconstruct an entire discussion or prove approval. Do not expose sensitive repositories to a provider on the assumption that every secret or injected directive will be recognized.

The worker returns exact bounded JSON: findings (`observed` or `unknown`), host-snapshot path/line or session-entry references, unique exact replacements, finding indexes, and unresolved questions. Session references require a host entry ID, excerpt line range and an exact quote; forged IDs/quotes are rejected. Assistant citations must be marked `unknown`, not observed user intent. Referenced session excerpts and roles are retained in the tool result for review. There is deliberately **no automatically approved decision status**: neither code, assistant assertions nor even a user quotation becomes an approval certificate. User text establishes what was said; interpreting its significance still requires review.

The host validates shape, bounds, references and destinations against **its own snapshots and hashes**, not child-selected authorization hashes. Unknown rationale stays unknown; decisions are not invented from code snapshots alone. This validates grounding locations and exact quotations, **not semantic truth or entailment of arbitrary claim prose**. Review the diff normally before accepting model-generated claims.

## Guarded application and cancellation

The parent executes built-in `edit`, using `{path, edits:[{oldText,newText}]}`, or the package-owned deferred, sequential **`clio_create_document`** through Pi’s `ctx.executeTool`. Neither built-ins nor Plan controls are replaced. The create tool is not a general write API: a single-use host capability binds exact canonical absolute path, full content, optional root `docs` mkdir, parent capture ID, runtime nested-call ID, session/run/generation and cancellation. It is consumed synchronously before waits and revoked after dispatch or invalidation. Unsolicited, mutated and replayed calls are refused even if the tool is discovered or activated. Own-tool provenance and callability are checked. Both paths traverse normal validation and `tool_call`/`tool_result` permission hooks.

Clio is **standalone**: no Aegis dependency, compatibility handshake, shared path-rule configuration, or built-in per-page confirmation. Eligible pages in the allowed documentation directories are created automatically; ordinary diff review remains acceptance. Permission extensions can block or confirm `clio_create_document` through Pi’s normal tool hooks. **Guards that cover only built-in `edit`/`write`, including Aegis in this repository, do not automatically cover this custom creation tool.** Clio does not read or enforce their private rules. To guard new pages, the permission extension must recognize `clio_create_document` and its absolute `path` and optional `createDirectory` arguments. Plan remains deny-default and is never given a Clio mutation exception. SDK hosts must make the deferred create tool callable; restrictive tool allowlists that omit it cause a useful refusal, not a fallback.

Before each edit, Clio rechecks permissions, owner session, input generation, cancellation, canonical paths, source/destination hashes and file identities. Paths interpreted differently by Pi (`@` prefixes, home expansion, file URLs and normalized Unicode spaces, including in the canonical root) are refused; dispatch uses the canonical absolute target. Clio predicts literal replacements with Pi-compatible BOM and line-ending restoration, refusing patches without a unique exact normalized match rather than using fuzzy fallback. The entire resulting file must pass the same NUL/credential/generated-content policy and `maxContextBytes` byte bound as read evidence **before dispatch**.

Clio observes resulting file contents and identity instead of trusting a success message, and honors `isError`. On conflict/denial/failure it stops remaining edits. If dispatch throws or the postwrite safety/read check fails, the attempted path remains **possibly modified (unverified)** in the outcome (`uncertain`) and completion, not a known zero changes or successful capture. Verified changes remain in `changed`, including unexpected contents, with a problem rather than capture credit. Already-applied changes remain unstaged; there is no automatic rollback that could destroy subsequent edits.

For a new page, the complete operation uses Pi’s `withFileMutationQueue(target)`. After permission/queue waits and immediately before publication it rechecks capture guards, referenced source hashes/dev/inodes, canonical root and parent identities, and destination absence. It writes and syncs a private same-directory exclusive temporary file, verifies its type, link count, identity and exact bytes through the retained descriptor, then publishes with a hard link that cannot replace an existing entry. The descriptor remains open through cleanup to prevent inode reuse. There is **no overwrite rename or ordinary-write fallback** if hard links are unavailable. Cleanup is awaited and removes only the owned temporary identity. Verified publication is checked against the intended content; the directory is synced.

A private host-owned ledger distinguishes not-published, published and uncertain outcomes; result hooks receive only a detached snapshot. Separate host completion and stored failure state prevent hooks from disguising incomplete publication as a successful capture. Created directories and unremoved temporary paths are reported. A permission/result failure after publication retains the actual diff but earns no capture credit for that operation. Empty directories can remain after cancellation; no rollback deletes published pages or directories. Unsupported filesystems, cleanup failures and ambiguous publication acknowledgements produce problems, never known-zero success.

**External writers are not locked.** There is an unavoidable interval between host validation and guarded tool execution, including time spent in permission hooks. External processes can race filesystem reads, symlink checks and edits; exclusive creation prevents destination replacement at the hard-link syscall, but surrounding path/identity/source checks are not atomic compare-and-swap or an OS security boundary. Hostile external processes can still swap path components or content between checks; Clio does not promise race isolation. Cooperating Pi tools are serialized by the runtime, but arbitrary other extensions have Pi's OS permissions too.

Cancel using Pi's ordinary abort control. New input also invalidates capture and bridges cancellation into the worker. Timeout requests abort; cleanup is awaited before the parent tool settles. A provider that ignores cancellation can delay that cleanup—this is not a hard-kill subprocess deadline. Cancellation during application can leave an accurately reported partial diff.

## Progress and results

TUI mode uses one compact width-aware widget with phase, elapsed time, model and thinking. It is cleared on completion/cancellation. JSON/print/RPC operation does not depend on a terminal widget.

Only changes or problems produce a normal completion message, with elapsed time, worker cost estimate (or unknown/partial), findings captured, observed and changed files, and unresolved items. Successful no-op completion is quiet (the tool transcript still exists). Measured worker usage is summed across provider turns, including supported optional token breakdowns when available for every turn, and returned on the parent tool result so Pi totals include it. Missing/malformed per-turn usage is not synthesized as zero: available totals are labeled partial, or accounting is unknown when nothing measurable was supplied. The tool details include `usageStatus`; optional breakdowns are omitted when incomplete. Completion cost is **worker-only**; the parent's scheduling/continuation model calls are accounted separately by Pi. Zero/missing prices are reported as unknown, not measured free usage.

Worker failures keep their category and include the selected `provider/model` and request turn. Provider errors include a sanitized explanation when available. Evidence failures include the failed `read`/`list` action, a safe relative path (otherwise `[OMITTED PATH]`), and an allowlisted host reason or filesystem error code; raw tool results, file bodies and absolute filesystem error paths are not copied into diagnostics. Missing/unrecognized reasons are explicit, not guessed. Each diagnostic is at most 900 UTF-8 bytes, with at most 500 bytes of explanation. Terminal controls, common credentials/auth headers, URLs and common structured/request-payload dumps are omitted before truncation. Provider error redaction remains heuristic, not a guarantee that arbitrary sensitive prose is recognized; conservative omission can also hide useful details. Hard request failures distinguish `request-context-bytes` from `request-turns` with host-owned current/requested/max numbers. Evidence capacity feedback distinguishes `file-count`, `evidence-bytes` and `response-bytes`; bytes count serialized snapshots or tool responses, not tokens. For a complete request/response, current is zero and requested is its total size; for an added snapshot, requested is its incremental serialized size. `maxContextBytes` still independently bounds whole files, snapshots, tool responses and each cumulative request; these are not separate configurable limits. Safety failures still stop capture without retries, fallback or relaxed checks; only ordinary evidence capacity refusals and authorized directory absence feedback allow continued finalization.

Clio never stages, commits, amends or publishes. If the code was committed earlier in the run, the later documentation changes remain unstaged for a separate human-reviewed commit.

## Development and verification

```bash
npm ci
npm test
npm run typecheck
npm pack --dry-run
```

Tests use pinned actual Pi **1.0.3** APIs and a provider-free faux provider: settlement → nonce → isolated Agent → real built-in edit, real permission hooks, queued input, mixed batches, cancellation, newly explored source conflicts, exclusive new-page publication, missing/empty docs, actual Plan, and reload. Independent permission-hook fixtures verify custom-tool allow/deny behavior and noninteractive confirmation refusal in both load orders. A built-in-only guard fixture verifies that Clio neither requires a compatibility responder nor treats an unrelated command name as a dependency. No paid model calls are part of the suite. Unit tests cover limits, proposals, scope, leases, capability attacks, target races, queue cancellation, partial publication/cleanup ledgers and compact output. See `TEST-PLAN.md` and `TDD.md` in the source checkout for observed red/green evidence.

Provider-free tests do not certify real-provider extraction quality, all natural-language read-only requests, all filesystem races, every terminal/theme, Windows behavior, or every third-party extension. End-to-end installed CLI interaction and live provider evaluation were not performed.
