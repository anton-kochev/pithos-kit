import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, writeFile, readFile, rm, stat, realpath, chmod, symlink, link, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { test } from "node:test";
import { digest } from "../src/manifest.ts";
import { verifyNativePreparedAuth } from "../src/native-request.ts";
import { captureScopedAuth, assertScopedAuth, assertScopedAuthAccess } from "../src/scoped-auth-identity.ts";

test("native prepared access must match the freshly observed scoped identity", async () => {
  await temporary(async file => {
    const data = credential(), raw = JSON.stringify({ "openai-codex": data });
    await writeFile(file, raw, { mode: 0o600 });
    const identity = captureScopedAuth(file, 0), prepared = { model: {}, options: { apiKey: data.access } };
    assert.deepEqual(verifyNativePreparedAuth(prepared, file, identity), identity);
    assert.throws(() => verifyNativePreparedAuth({ ...prepared, options: { apiKey: "WRONG_ACCESS" } }, file, identity), /^Error: Native authentication policy mismatch$/);
    await writeFile(file, raw + " ");
    assert.throws(() => verifyNativePreparedAuth(prepared, file, identity), /^Error: Native authentication policy mismatch$/);
  });
});

test("native prepared auth rejects alternative headers, environment and malformed inputs", async () => {
  await temporary(async file => {
    const data = credential(); await writeFile(file, JSON.stringify({ "openai-codex": data }), { mode: 0o600 });
    const identity = captureScopedAuth(file, 0);
    for (const change of [
      (p: any) => p.options.headers = { Authorization: "OTHER_ACCESS" },
      (p: any) => p.model.headers = { "X-Account": "OTHER_ACCOUNT" },
      (p: any) => p.options.env = { API_KEY: "OTHER_ACCESS" },
      (p: any) => p.options.headers = [["bad header", "PRIVATE_ERROR"]],
      (p: any) => Object.defineProperty(p.options, "apiKey", { get() { throw Error("PRIVATE_ERROR"); } }),
    ]) {
      const prepared = { model: {}, options: { apiKey: data.access } }; change(prepared);
      assert.throws(() => verifyNativePreparedAuth(prepared, file, identity), /^Error: Native authentication policy mismatch$/);
    }
    assert.throws(() => verifyNativePreparedAuth(null, file, identity), /^Error: Native authentication policy mismatch$/);
    assert.deepEqual(verifyNativePreparedAuth({ model: { headers: {} }, options: { apiKey: data.access, headers: [], env: {} } }, file, identity), identity);
  });
});

function credential(expires = Math.floor(Date.now() / 1000) * 1000 + 3600000) {
  const claims = { exp: expires / 1000, "https://api.openai.com/auth": { chatgpt_account_id: "ACCOUNT_MUST_NOT_LEAK" } };
  return { type: "oauth", access: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic-signature`,
    refresh: "", expires, accountId: "ACCOUNT_MUST_NOT_LEAK" };
}
async function temporary(action: (file: string) => Promise<void>) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "guild-auth-identity-test-"));
  try { await action(join(root, "AUTH_PATH_MUST_NOT_LEAK.json")); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("requires a closed access-only store with consistent JWT identity and expiry", async () => {
  await temporary(async file => {
    const good = credential();
    for (const change of [
      (a: any) => a["openai-codex"].type = "api_key",
      (a: any) => a["openai-codex"].refresh = "REFRESH_MUST_NOT_LEAK",
      (a: any) => a["openai-codex"].accountId = "WRONG_ACCOUNT_MUST_NOT_LEAK",
      (a: any) => a["openai-codex"].expires++,
      (a: any) => a["openai-codex"].expires = "3600000",
      (a: any) => delete a["openai-codex"].expires,
      (a: any) => a["openai-codex"].access += ".extra",
      (a: any) => a["openai-codex"].access = "header.e30.signature",
      (a: any) => a["openai-codex"].env = { SECRET: "MUST_NOT_LEAK" },
      (a: any) => a.other = { key: "MUST_NOT_LEAK" },
    ]) {
      const data = { "openai-codex": { ...good } }; change(data);
      await writeFile(file, JSON.stringify(data), { mode: 0o600 });
      assert.throws(() => captureScopedAuth(file, 300000), /^Error: Scoped Codex authentication mismatch$/);
    }
    for (const raw of ["{}", "[]", "null", '{"SECRET_MUST_NOT_LEAK', Buffer.from([0xff])]) {
      await writeFile(file, raw, { mode: 0o600 });
      assert.throws(() => captureScopedAuth(file, 300000), /^Error: Scoped Codex authentication mismatch$/);
    }
  });
});

test("enforces the remaining workflow plus six-minute reserve at the exact boundary", async t => {
  const now = 1800000000000;
  t.mock.method(Date, "now", () => now);
  await temporary(async file => {
    const auth = credential(now + 661000); auth.expires = now + 660001;
    await writeFile(file, JSON.stringify({ "openai-codex": auth }), { mode: 0o600 });
    assert.equal(captureScopedAuth(file, 300000).expires, auth.expires);
    auth.expires--;
    await writeFile(file, JSON.stringify({ "openai-codex": auth }));
    assert.throws(() => captureScopedAuth(file, 300000), /^Error: Scoped Codex authentication mismatch$/);
    for (const remaining of [-1, 0.5, NaN, Infinity, 3600001, undefined, "0"]) {
      assert.throws(() => captureScopedAuth(file, remaining as any), /^Error: Scoped Codex authentication mismatch$/);
    }
    auth.expires = now + 360001;
    await writeFile(file, JSON.stringify({ "openai-codex": auth }));
    assert.equal(captureScopedAuth(file, 0).expires, auth.expires);
    auth.expires--;
    await writeFile(file, JSON.stringify({ "openai-codex": auth }));
    assert.throws(() => captureScopedAuth(file, 0), /^Error: Scoped Codex authentication mismatch$/);
  });
});

test("rejects unsafe, aliased, relative, oversized or absent files without retaining their names", async () => {
  await temporary(async file => {
    const raw = JSON.stringify({ "openai-codex": credential() });
    await writeFile(file, raw, { mode: 0o600 });
    const reject = (path: string) => assert.throws(() => captureScopedAuth(path, 0), /^Error: Scoped Codex authentication mismatch$/);
    reject(relative(process.cwd(), file));
    reject(file + "/../" + file.split("/").at(-1));
    reject(file + ".missing"); reject(dirname(file));
    await chmod(file, 0o644); reject(file); await chmod(file, 0o600);
    await symlink(file, file + ".alias"); reject(file + ".alias");
    await mkdir(file + ".dir"); await symlink(dirname(file), file + ".dir/alias");
    reject(join(file + ".dir/alias", file.split("/").at(-1)!));
    await link(file, file + ".hardlink"); reject(file); reject(file + ".hardlink"); await rm(file + ".hardlink");
    await writeFile(file, raw + " ".repeat(1048576)); reject(file);
  });
});

test("rejects ordinary replacement, same-size rewrite, growth or permission changes during descriptor reads", async t => {
  await temporary(async file => {
    const raw = JSON.stringify({ "openai-codex": credential() }), read = fs.readSync;
    for (const mode of ["replacement", "rewrite", "growth", "permissions"]) {
      await writeFile(file, raw, { mode: 0o600 }); await chmod(file, 0o600);
      let changed = false;
      const mock = t.mock.method(fs, "readSync", (...args: any[]) => {
        if (!changed) {
          changed = true;
          if (mode === "replacement") { fs.renameSync(file, file + ".old"); fs.writeFileSync(file, raw, { mode: 0o600 }); }
          if (mode === "rewrite") fs.writeFileSync(file, raw.replace("synthetic-signature", "synthetic-signaturf"));
          if (mode === "growth") fs.appendFileSync(file, " ");
          if (mode === "permissions") fs.chmodSync(file, 0o644);
        }
        return (read as any)(...args);
      });
      try {
        assert.throws(() => captureScopedAuth(file, 0), /^Error: Scoped Codex authentication mismatch$/, mode);
        assert.equal(changed, true, mode);
      } finally { mock.mock.restore(); }
    }
  });
});

test("rechecks exact identity and prepared access without returning the secret", async () => {
  await temporary(async file => {
    const auth = credential(), raw = JSON.stringify({ "openai-codex": auth });
    await writeFile(file, raw, { mode: 0o600 });
    const expected = captureScopedAuth(file, 300000);
    assert.deepEqual(assertScopedAuth(file, expected, 300000), expected);
    assert.deepEqual(assertScopedAuthAccess(file, expected, auth.access), expected);
    assert.throws(() => assertScopedAuthAccess(file, expected, "WRONG_ACCESS_MUST_NOT_LEAK"), /^Error: Scoped Codex authentication mismatch$/);
    await writeFile(file, raw + " ");
    assert.throws(() => assertScopedAuth(file, expected, 0), /^Error: Scoped Codex authentication mismatch$/);
    assert.throws(() => assertScopedAuthAccess(file, expected, auth.access), /^Error: Scoped Codex authentication mismatch$/);
    await writeFile(file, raw);
    fs.renameSync(file, file + ".old"); await writeFile(file, raw, { mode: 0o600 });
    assert.throws(() => assertScopedAuth(file, expected, 0), /^Error: Scoped Codex authentication mismatch$/);
  });
});

test("recheck failures never expose caller-supplied identity diagnostics", async () => {
  await temporary(async file => {
    const auth = credential(); await writeFile(file, JSON.stringify({ "openai-codex": auth }), { mode: 0o600 });
    const bad = { ...captureScopedAuth(file, 0) };
    Object.defineProperty(bad, "fileDigest", { enumerable: true, get() { throw new Error("CALLER_SECRET_MUST_NOT_LEAK"); } });
    assert.throws(() => assertScopedAuth(file, bad, 0), /^Error: Scoped Codex authentication mismatch$/);
    assert.throws(() => assertScopedAuthAccess(file, bad, auth.access), /^Error: Scoped Codex authentication mismatch$/);
  });
});

test("captures a frozen scoped file identity without credential, account or path plaintext", async () => {
  await temporary(async file => {
    const auth = credential(), raw = JSON.stringify({ "openai-codex": auth });
    await writeFile(file, raw, { mode: 0o600 });
    const info = await stat(file, { bigint: true }), identity = captureScopedAuth(file, 300000);
    assert.deepEqual(identity, { version: 1, kind: "scoped-codex-auth-file-observation", dev: info.dev.toString(), ino: info.ino.toString(), uid: Number(info.uid),
      fileDigest: digest(Buffer.from(raw).toString("base64")), accountDigest: digest(auth.accountId), expires: auth.expires });
    assert.equal(Object.isFrozen(identity), true);
    assert.doesNotMatch(JSON.stringify(identity), /ACCOUNT_MUST_NOT_LEAK|AUTH_PATH_MUST_NOT_LEAK|synthetic-signature|refresh/);
    assert.equal(await readFile(file, "utf8"), raw);
  });
});
