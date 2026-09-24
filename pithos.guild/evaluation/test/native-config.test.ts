import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { readNativeConfig } from "../src/native-config.ts";

const sha = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
const mismatch = /^Error: Native configuration observation mismatch$/;
function fixture(visit: (file: string) => void) {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "guild-config-read-test-"));
  try { visit(join(root, "config.json")); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test("reads exact bounded private config bytes into a frozen object", () => {
  fixture(file => {
    const raw = JSON.stringify({ version: 1, nested: { values: ["inert"] } }) + "\n";
    fs.writeFileSync(file, raw, { mode: 0o600 });
    const config = readNativeConfig(file, sha(raw));
    assert.deepEqual(config, JSON.parse(raw));
    assert.ok(Object.isFrozen(config)); assert.ok(Object.isFrozen(config.nested.values));
    assert.throws(() => config.nested.values.push("changed"), TypeError);
  });
});

// Existing reader invariants: intentional pins, with disposable-copy sensitivity.
test("rejects digest, encoding and root-type mismatches without exposing bytes", () => {
  fixture(file => {
    for (const raw of [Buffer.from([0xff]), Buffer.from('{"private":"DO_NOT_LEAK"'), Buffer.from("null"), Buffer.from("[]"), Buffer.from('"scalar"')]) {
      fs.writeFileSync(file, raw, { mode: 0o600 });
      assert.throws(() => readNativeConfig(file, sha(raw)), mismatch);
    }
    fs.writeFileSync(file, "{}", { mode: 0o600 });
    for (const hash of [undefined, "", "A".repeat(64), "0".repeat(64)]) assert.throws(() => readNativeConfig(file, hash as any), mismatch);
  });
});
test("accepts exactly 64KiB and rejects larger files before byte reads", t => {
  fixture(file => {
    const raw = "{}" + " ".repeat(65534); fs.writeFileSync(file, raw, { mode: 0o600 });
    assert.deepEqual(readNativeConfig(file, sha(raw)), {});
    fs.appendFileSync(file, " "); let reads = 0;
    const mock = t.mock.method(fs, "readSync", () => { reads++; throw Error(); });
    try { assert.throws(() => readNativeConfig(file, sha(raw + " ")), mismatch); assert.equal(reads, 0); }
    finally { mock.mock.restore(); }
  });
});
test("rejects path aliases, hardlinks, public modes, wrong owners and nonfiles", t => {
  fixture(file => {
    fs.writeFileSync(file, "{}", { mode: 0o600 });
    assert.throws(() => readNativeConfig(file + "/../config.json", sha("{}")), mismatch);
    assert.throws(() => readNativeConfig("relative.json", sha("{}")), mismatch);
    fs.symlinkSync(file, file + ".alias"); assert.throws(() => readNativeConfig(file + ".alias", sha("{}")), mismatch);
    fs.linkSync(file, file + ".link"); assert.throws(() => readNativeConfig(file, sha("{}")), mismatch); fs.unlinkSync(file + ".link");
    fs.chmodSync(file, 0o644); assert.throws(() => readNativeConfig(file, sha("{}")), mismatch); fs.chmodSync(file, 0o600);
    const uid = process.getuid!(); const owner = t.mock.method(process as NodeJS.Process & { getuid: () => number }, "getuid", () => uid + 1);
    try { assert.throws(() => readNativeConfig(file, sha("{}")), mismatch); } finally { owner.mock.restore(); }
    fs.mkdirSync(file + ".dir"); assert.throws(() => readNativeConfig(file + ".dir", sha("{}")), mismatch);
  });
});
test("handles short reads and closes the descriptor on success and JSON failure", t => {
  fixture(file => {
    for (const raw of ['{"x":"short reads"}', '{invalid']) {
      fs.writeFileSync(file, raw, { mode: 0o600 });
      const read = fs.readSync; let fd: number | undefined;
      const mock = t.mock.method(fs, "readSync", (f: number, b: Buffer, offset: number, length: number, position: any) => {
        fd = f; return read(f, b, offset, Math.min(3, length), position);
      });
      try {
        if (raw.includes("invalid")) assert.throws(() => readNativeConfig(file, sha(raw)), mismatch);
        else assert.deepEqual(readNativeConfig(file, sha(raw)), { x: "short reads" });
      } finally { mock.mock.restore(); }
      assert.notEqual(fd, undefined); assert.throws(() => fs.fstatSync(fd!), { code: "EBADF" });
    }
  });
});
test("rejects descriptor/path drift and retains changed files with descriptors closed", t => {
  fixture(file => {
    for (const mode of ["replacement", "rewrite", "growth", "permissions"]) {
      const raw = '{"x":"stable"}'; fs.writeFileSync(file, raw, { mode: 0o600 }); fs.chmodSync(file, 0o600);
      const read = fs.readSync; let fd: number | undefined, changed = false;
      const mock = t.mock.method(fs, "readSync", (...args: any[]) => {
        fd = args[0];
        if (!changed) {
          changed = true;
          if (mode === "replacement") { fs.renameSync(file, file + ".old"); fs.writeFileSync(file, raw, { mode: 0o600 }); }
          if (mode === "rewrite") { fs.writeFileSync(file, raw); fs.utimesSync(file, 1, 1); }
          if (mode === "growth") fs.appendFileSync(file, " ");
          if (mode === "permissions") fs.chmodSync(file, 0o644);
        }
        return (read as any)(...args);
      });
      try { assert.throws(() => readNativeConfig(file, sha(raw)), mismatch, mode); assert.equal(changed, true); }
      finally { mock.mock.restore(); }
      assert.throws(() => fs.fstatSync(fd!), { code: "EBADF" });
      if (mode === "growth") assert.equal(fs.readFileSync(file, "utf8"), raw + " ");
      if (mode === "permissions") assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    }
  });
});
