import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, writeFile, readFile, stat, access, rm, mkdir, chmod, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { createCodexAuthLease, readCodexAuthLease } from "../src/codex-auth.ts";
import { captureScopedAuth } from "../src/scoped-auth-identity.ts";

test("the issued lease cannot have its identity, directory or freshness check replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-codex-frozen-lease-test-"));
  try {
    const sourceFile = join(root, "source.json"), artifacts = join(root, "runs"); await mkdir(artifacts);
    await writeFile(sourceFile, JSON.stringify({ "openai-codex": credential() }), { mode: 0o600 });
    const lease = await createCodexAuthLease({ sourceFile, temporaryRoot: root, forbiddenRoots: [artifacts], timeoutMs: 300000 });
    const dispose = lease.dispose;
    try {
      assert.throws(() => Object.assign(lease, { directory: "/replacement", identity: {}, assertFresh: () => {} }), TypeError);
      assert.ok(Object.isFrozen(lease)); lease.assertFresh();
    } finally { await dispose(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("issuer lookup returns immutable observations only for the exact live lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-codex-origin-test-"));
  try {
    const sourceFile = join(root, "source.json"), artifacts = join(root, "runs"); await mkdir(artifacts);
    await writeFile(sourceFile, JSON.stringify({ "openai-codex": credential() }), { mode: 0o600 });
    const lease = await createCodexAuthLease({ sourceFile, temporaryRoot: root, forbiddenRoots: [artifacts], timeoutMs: 300000 });
    try {
      const observation = readCodexAuthLease(lease);
      assert.deepEqual(observation, { directory: lease.directory, identity: lease.identity });
      assert.ok(Object.isFrozen(observation)); assert.ok(Object.isFrozen(observation.identity));
      assert.doesNotMatch(JSON.stringify(observation), /source.json|synthetic-signature|DO_NOT_COPY_REFRESH|synthetic-account/);
      for (const other of [undefined, {}, { ...lease }, new Proxy(lease, {})]) {
        assert.throws(() => readCodexAuthLease(other), /^Error: Codex authentication lease mismatch$/);
      }
    } finally { await lease.dispose(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const failure of [false, true]) test(`revokes lease before filesystem cleanup starts, including failure=${failure}`, async t => {
  const root = await mkdtemp(join(tmpdir(), "guild-codex-revoke-test-"));
  try {
    const sourceFile = join(root, "source.json"), artifacts = join(root, "runs"); await mkdir(artifacts);
    await writeFile(sourceFile, JSON.stringify({ "openai-codex": credential() }), { mode: 0o600 });
    const lease = await createCodexAuthLease({ sourceFile, temporaryRoot: root, forbiddenRoots: [artifacts], timeoutMs: 300000 });
    const originalRm = fsPromises.rm; let inspected = false, issuerRejected = false, methodRejected = false;
    const mock = t.mock.method(fsPromises, "rm", async (path: any, options: any) => {
      if (path === lease.directory) {
        inspected = true;
        try { readCodexAuthLease(lease); } catch { issuerRejected = true; }
        try { lease.assertFresh(); } catch { methodRejected = true; }
        if (failure) throw Error("SYNTHETIC_CLEANUP_FAILURE");
      }
      return originalRm(path, options);
    });
    syncBuiltinESMExports();
    try {
      if (failure) await assert.rejects(lease.dispose(), /^Error: Private Codex credential cleanup failed$/);
      else await lease.dispose();
      assert.equal(inspected, true);
      assert.deepEqual([issuerRejected, methodRejected], [true, true]);
      assert.throws(() => readCodexAuthLease(lease), /^Error: Codex authentication lease mismatch$/);
      if (failure) await access(join(lease.directory, "auth.json")); // No automatic deletion/recovery claim.
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unissued lease lookup does not inspect attacker-controlled getters", () => {
  let reads = 0;
  const fake = new Proxy({}, { get() { reads++; throw Error("CALLER_SECRET_MUST_NOT_LEAK"); } });
  assert.throws(() => readCodexAuthLease(fake), /^Error: Codex authentication lease mismatch$/);
  assert.equal(reads, 0);
});

for (const drift of ["bytes", "original lifetime"]) test(`issuer lookup rechecks ${drift}`, async t => {
  const root = await mkdtemp(join(tmpdir(), "guild-codex-origin-fresh-test-"));
  try {
    const sourceFile = join(root, "source.json"), artifacts = join(root, "runs"); await mkdir(artifacts);
    const now = Date.now();
    await writeFile(sourceFile, JSON.stringify({ "openai-codex": credential(now + 3600000) }), { mode: 0o600 });
    const lease = await createCodexAuthLease({ sourceFile, temporaryRoot: root, forbiddenRoots: [artifacts], timeoutMs: 300000 });
    try {
      const file = join(lease.directory, "auth.json");
      readCodexAuthLease(lease);
      if (drift === "bytes") await writeFile(file, await readFile(file, "utf8") + " ");
      // Still more than six minutes remaining, but not the original trial + reserve.
      const clock = drift === "original lifetime" ? t.mock.method(Date, "now", () => now + 2941000) : undefined;
      try { assert.throws(() => readCodexAuthLease(lease), /^Error: Codex authentication lease mismatch$/); }
      finally { clock?.mock.restore(); }
    } finally { await lease.dispose(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an expected trial window and retention exclusions must match the original lease scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-codex-scope-test-"));
  try {
    const sourceFile = join(root, "source.json"), artifacts = join(root, "runs"); await mkdir(artifacts);
    await writeFile(sourceFile, JSON.stringify({ "openai-codex": credential() }), { mode: 0o600 });
    const scope = { timeoutMs: 300000, forbiddenRoots: [artifacts] };
    const lease = await createCodexAuthLease({ sourceFile, temporaryRoot: root, ...scope });
    try {
      assert.equal(readCodexAuthLease(lease, scope).directory, lease.directory);
      for (const different of [{ ...scope, timeoutMs: 1 }, { ...scope, forbiddenRoots: [root] }, { ...scope, forbiddenRoots: [] }]) {
        assert.throws(() => readCodexAuthLease(lease, different), /^Error: Codex authentication lease mismatch$/);
      }
      scope.timeoutMs = 1; scope.forbiddenRoots.length = 0;
      assert.equal(readCodexAuthLease(lease, { timeoutMs: 300000, forbiddenRoots: [artifacts] }).directory, lease.directory);
    } finally { await lease.dispose(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

function token(expires: number, accountId = "synthetic-account") {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "synthetic" })}.${encode({ exp: Math.floor(expires / 1000), "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.synthetic-signature`;
}
function credential(expires = Date.now() + 3600000) {
  return { type: "oauth", access: token(expires), expires, refresh: "DO_NOT_COPY_REFRESH", accountId: "synthetic-account" };
}

test("rejects non-private, aliased, oversized, or artifact-contained credential paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-codex-path-test-"));
  try {
    const artifacts = join(root, "runs"), sourceFile = join(root, "source.json");
    await mkdir(artifacts);
    const source = JSON.stringify({ "openai-codex": credential() });
    await writeFile(sourceFile, source, { mode: 0o600 });
    const options = { sourceFile, temporaryRoot: root, forbiddenRoots: [artifacts], timeoutMs: 300000 };
    const rejected = async (change: Partial<typeof options> = {}) => {
      await assert.rejects(async () => {
        const lease = await createCodexAuthLease({ ...options, ...change });
        await lease.dispose();
      }, /Codex|credential/);
    };
    await rejected({ sourceFile: relative(process.cwd(), sourceFile) });
    await rejected({ temporaryRoot: artifacts });
    const alias = join(root, "alias");
    await symlink(artifacts, alias);
    await rejected({ temporaryRoot: alias });
    const sourceAlias = join(root, "source-alias.json");
    await symlink(sourceFile, sourceAlias);
    await rejected({ sourceFile: sourceAlias });
    const retainedSource = join(artifacts, "source.json");
    await writeFile(retainedSource, source, { mode: 0o600 });
    await rejected({ sourceFile: retainedSource });
    await chmod(sourceFile, 0o644); await rejected(); await chmod(sourceFile, 0o600);
    await writeFile(sourceFile, source + " ".repeat(1024 * 1024)); await rejected();
    assert.deepEqual(await readdir(artifacts), ["source.json"]);
    assert.equal((await readdir(root)).some(name => name.startsWith("guild-codex-")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("validates OAuth identity and expiry without echoing credential contents in errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-codex-validation-test-"));
  try {
    const sourceFile = join(root, "SOURCE_PATH_MUST_NOT_LEAK"), artifacts = join(root, "runs");
    await mkdir(artifacts);
    const valid = credential();
    const bad = [
      { ...valid, type: "api_key" },
      { ...valid, accountId: "wrong-account" },
      { ...valid, expires: undefined },
      { ...valid, expires: String(valid.expires) },
      { ...valid, access: valid.access + ".extra" },
      { ...valid, access: token(Date.now() + 60000) },
      { ...valid, expires: Date.now() + 60000 },
      { ...valid, access: "header." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url") + ".signature" },
    ];
    for (const value of bad) {
      await writeFile(sourceFile, JSON.stringify({ "openai-codex": value }), { mode: 0o600 });
      await assert.rejects(async () => {
        const lease = await createCodexAuthLease({ sourceFile, temporaryRoot: root, forbiddenRoots: [artifacts], timeoutMs: 300000 });
        await lease.dispose();
      }, (error: Error) => {
        assert.doesNotMatch(error.message, /SOURCE_PATH_MUST_NOT_LEAK|DO_NOT_COPY_REFRESH|wrong-account|synthetic-signature/);
        return /Codex/.test(error.message);
      });
    }
    await writeFile(sourceFile, '{"openai-codex":"SECRET_IN_INVALID_JSON');
    await assert.rejects(createCodexAuthLease({ sourceFile, temporaryRoot: root, forbiddenRoots: [artifacts], timeoutMs: 300000 }), (error: Error) => {
      assert.doesNotMatch(error.message, /SECRET_IN_INVALID_JSON|SOURCE_PATH_MUST_NOT_LEAK/);
      return /Codex/.test(error.message);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a lease binds its private file identity and rejects later credential-byte changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-codex-lease-identity-test-"));
  try {
    const sourceFile = join(root, "source.json"), artifacts = join(root, "runs");
    await mkdir(artifacts);
    const source = JSON.stringify({ "openai-codex": credential() });
    await writeFile(sourceFile, source, { mode: 0o600 });
    const lease = await createCodexAuthLease({ sourceFile, temporaryRoot: root, forbiddenRoots: [artifacts], timeoutMs: 300000 });
    try {
      const file = join(lease.directory, "auth.json"), raw = await readFile(file, "utf8");
      assert.deepEqual(lease.identity, captureScopedAuth(file, 300000));
      assert.equal(Object.isFrozen(lease.identity), true);
      lease.assertFresh();
      await writeFile(file, raw + " ");
      assert.throws(() => lease.assertFresh(), /^Error: Scoped Codex authentication mismatch$/);
      assert.equal(await readFile(sourceFile, "utf8"), source);
    } finally { await lease.dispose(); }
    await assert.rejects(access(lease.directory));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("caller mutation cannot reduce a lease's original workflow lifetime requirement", async t => {
  let now = 1800000000000;
  t.mock.method(Date, "now", () => now);
  const root = await mkdtemp(join(tmpdir(), "guild-codex-lease-budget-test-"));
  try {
    const sourceFile = join(root, "source.json"), artifacts = join(root, "runs"); await mkdir(artifacts);
    await writeFile(sourceFile, JSON.stringify({ "openai-codex": credential(now + 3600000) }), { mode: 0o600 });
    const options = { sourceFile, temporaryRoot: root, forbiddenRoots: [artifacts], timeoutMs: 300000 };
    const lease = await createCodexAuthLease(options);
    try {
      options.timeoutMs = 0; now += 3600000 - 510000;
      assert.throws(() => lease.assertFresh(), /outlive the trial/);
    } finally { await lease.dispose(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("borrows only a fresh Codex access credential privately and leaves the source untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-codex-auth-test-"));
  try {
    const sourceFile = join(root, "source.json"), artifacts = join(root, "runs");
    await mkdir(artifacts);
    const auth = credential();
    const source = JSON.stringify({ "openai-codex": { ...auth, env: { SHOULD_NOT_COPY: "private" } }, other: { type: "api_key", key: "!do-not-execute" } });
    await writeFile(sourceFile, source, { mode: 0o600 });
    const lease = await createCodexAuthLease({ sourceFile, temporaryRoot: root, forbiddenRoots: [artifacts], timeoutMs: 300000 });
    try {
      assert.equal((await stat(lease.directory)).mode & 0o777, 0o700);
      assert.equal((await stat(join(lease.directory, "auth.json"))).mode & 0o777, 0o600);
      const copied = JSON.parse(await readFile(join(lease.directory, "auth.json"), "utf8"));
      assert.deepEqual(copied, { "openai-codex": { type: "oauth", access: auth.access, expires: Math.floor(auth.expires / 1000) * 1000, accountId: auth.accountId, refresh: "" } });
      assert.equal(await readFile(sourceFile, "utf8"), source);
      lease.assertFresh();
    } finally { await lease.dispose(); }
    await assert.rejects(access(lease.directory));
    assert.equal(await readFile(sourceFile, "utf8"), source);
  } finally { await rm(root, { recursive: true, force: true }); }
});
