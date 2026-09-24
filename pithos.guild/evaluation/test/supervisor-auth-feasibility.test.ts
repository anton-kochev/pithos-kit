import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, copyFile, chmod, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCodexAuthLease, readCodexAuthLease } from "../src/codex-auth.ts";
import { captureScopedAuth, assertScopedAuth } from "../src/scoped-auth-identity.ts";

// Feasibility pin, not a container transport or provider-authentication test.
// Test list: identical bytes != leased file; reconstructed object != issuer;
// disposal revokes the original but cannot clean up a separately copied file.
test("diagnostic auth copying cannot transfer a genuine lease or its cleanup ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-auth-feasibility-"));
  try {
    const retained = join(root, "retained"), transient = join(root, "transient");
    await mkdir(retained); await mkdir(transient);
    const sourceFile = join(root, "diagnostic-source.json");
    const expires = Math.floor(Date.now() / 1000) * 1000 + 3600000;
    const accountId = "inert-diagnostic-account";
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "synthetic" })}.${encode({ exp: expires / 1000,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.synthetic-signature`;
    await writeFile(sourceFile, JSON.stringify({ "openai-codex": {
      type: "oauth", access: token, refresh: "", expires, accountId,
    } }), { mode: 0o600 });
    const scope = { timeoutMs: 300000, forbiddenRoots: [retained] };
    const lease = await createCodexAuthLease({ sourceFile, temporaryRoot: transient, ...scope });
    try {
      const original = join(lease.directory, "auth.json"), copied = join(transient, "copy.json");
      await copyFile(original, copied); await chmod(copied, 0o600);
      const observed = captureScopedAuth(copied, scope.timeoutMs);
      assert.equal(observed.fileDigest, lease.identity.fileDigest);
      assert.notDeepEqual(observed, lease.identity, "identical bytes must not transfer leased file identity");
      assert.throws(() => assertScopedAuth(copied, lease.identity, scope.timeoutMs), /Scoped Codex authentication mismatch/);
      assert.throws(() => readCodexAuthLease({ ...lease, identity: observed }, scope), /Codex authentication lease mismatch/);
      assert.equal(readCodexAuthLease(lease, scope).directory, lease.directory);
      await lease.dispose();
      assert.throws(() => readCodexAuthLease(lease, scope), /Codex authentication lease mismatch/);
      await assert.rejects(access(original), { code: "ENOENT" });
      assert.ok((await readFile(copied, "utf8")).includes("synthetic-signature"));
      // The test owns this copy. Existing lease disposal does not revoke its bytes.
    } finally { await lease.dispose(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
