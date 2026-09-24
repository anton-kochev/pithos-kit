import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digest } from "../src/manifest.ts";
import { observeNativeFiles, assertNativeFiles } from "../src/native-file-observation.ts";

const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
async function fixture(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "guild-file-observation-test-"));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("rejects actual byte drift rather than recording an unchecked expected hash", async () => {
  await fixture(async root => {
    const path = join(root, "input"), expected = [{ id: "implementation/runner", path, sha256: sha("before") }];
    await writeFile(path, "after", { mode: 0o600 });
    assert.throws(() => observeNativeFiles(expected), /^Error: Native file observation mismatch$/);
  });
});

test("rejects malformed, duplicate and unbounded inventories before opening any input", async t => {
  await fixture(async root => {
    const good = { id: "runtime/node", path: join(root, "input"), sha256: sha("") };
    await writeFile(good.path, "", { mode: 0o600 });
    let opens = 0;
    const open = fs.openSync;
    const mock = t.mock.method(fs, "openSync", (...args: any[]) => { opens++; return (open as any)(...args); });
    try {
      for (const bad of [
        [], null, {}, new Array(1), Array.from({ length: 257 }, () => good),
        [good, good], [good, { ...good, id: "other" }], [good, { ...good, path: good.path + "2" }],
        [good, { ...good, id: "x", path: good.path + "2", extra: true }], [null],
        [{ ...good, id: "" }], [{ ...good, id: "x".repeat(257) }], [{ ...good, id: "bad\nlabel" }],
        [{ ...good, path: "relative" }], [{ ...good, path: root + "/./input" }], [{ ...good, path: root + "/" + "é".repeat(2048) }],
        [{ ...good, sha256: "a".repeat(63) }], [{ ...good, sha256: good.sha256.toUpperCase() }],
        Object.assign([good], { extra: true }), [{ ...good, [Symbol("extra")]: true }],
      ]) {
        assert.throws(() => observeNativeFiles(bad as any), /^Error: Native file observation mismatch$/);
        assert.equal(opens, 0);
      }
    } finally { mock.mock.restore(); }
  });
});

test("rejects writable shared files, hardlinks, symlink aliases, directories and missing files", async () => {
  await fixture(async root => {
    const path = join(root, "input"), reject = (file: string) => assert.throws(() => observeNativeFiles([{ id: "input", path: file, sha256: sha("") }]), /^Error: Native file observation mismatch$/);
    await writeFile(path, "", { mode: 0o600 });
    fs.chmodSync(path, 0o666); reject(path); fs.chmodSync(path, 0o600);
    fs.linkSync(path, path + ".hardlink"); reject(path); fs.unlinkSync(path + ".hardlink");
    fs.symlinkSync(path, path + ".alias"); reject(path + ".alias");
    fs.mkdirSync(join(root, "dir")); fs.symlinkSync(root, join(root, "dir", "alias"));
    reject(join(root, "dir", "alias", "input")); reject(root); reject(path + ".missing");
  });
});

test("rejects oversized aggregate metadata before reading any bytes", async t => {
  await fixture(async root => {
    const expected = [268435456, 268435456, 1].map((size, i) => {
      const path = join(root, String(i)); fs.writeFileSync(path, "", { mode: 0o600 }); fs.truncateSync(path, size);
      return { id: `file${i}`, path, sha256: sha("") };
    });
    let reads = 0;
    const mock = t.mock.method(fs, "readSync", () => { reads++; throw Error("No large-file read permitted by this fixture"); });
    try {
      assert.throws(() => observeNativeFiles(expected), /^Error: Native file observation mismatch$/);
      assert.equal(reads, 0);
    } finally { mock.mock.restore(); }
  });
});

test("rejects equal-byte replacement or rewriting during the descriptor read", async t => {
  await fixture(async root => {
    for (const mode of ["replace", "rewrite"]) {
      const path = join(root, mode), text = "same bytes";
      await writeFile(path, text, { mode: 0o600 });
      const read = fs.readSync;
      let changed = false;
      const mock = t.mock.method(fs, "readSync", (...args: any[]) => {
        if (!changed) {
          changed = true;
          if (mode === "replace") fs.renameSync(path, path + ".old");
          fs.writeFileSync(path, text, { mode: 0o600 });
        }
        return (read as any)(...args);
      });
      try { assert.throws(() => observeNativeFiles([{ id: mode, path, sha256: sha(text) }]), /^Error: Native file observation mismatch$/, mode); }
      finally { mock.mock.restore(); }
    }
  });
});

test("rechecks earlier files after later files have been consumed", async t => {
  await fixture(async root => {
    const first = join(root, "first"), second = join(root, "second");
    await writeFile(first, "first", { mode: 0o600 }); await writeFile(second, "second", { mode: 0o600 });
    const expected = [{ id: "first", path: first, sha256: sha("first") }, { id: "second", path: second, sha256: sha("second") }];
    const read = fs.readSync, secondInode = fs.statSync(second).ino;
    let changed = false;
    const mock = t.mock.method(fs, "readSync", (...args: any[]) => {
      if (!changed && fs.fstatSync(args[0]).ino === secondInode) { changed = true; fs.writeFileSync(first, "after"); }
      return (read as any)(...args);
    });
    try {
      assert.throws(() => observeNativeFiles(expected), /^Error: Native file observation mismatch$/);
      assert.equal(changed, true);
    } finally { mock.mock.restore(); }
  });
});

test("rechecks the full observation and rejects equal-content replacement or inventory drift", async () => {
  await fixture(async root => {
    const path = join(root, "input"); await writeFile(path, "", { mode: 0o600 });
    const expected = [{ id: "node", path, sha256: sha("") }], prior = observeNativeFiles(expected);
    assert.deepEqual(assertNativeFiles(expected, structuredClone(prior)), prior);
    for (const bad of [null, { ...prior, version: 2 }, { ...prior, extra: true }, { ...prior, inventoryDigest: "0".repeat(64) }, { ...prior, files: [] }]) {
      assert.throws(() => assertNativeFiles(expected, bad as any), /^Error: Native file observation mismatch$/);
    }
    assert.throws(() => assertNativeFiles([{ ...expected[0], id: "other" }], prior), /^Error: Native file observation mismatch$/);
    fs.renameSync(path, path + ".old"); await writeFile(path, "", { mode: 0o600 });
    assert.throws(() => assertNativeFiles(expected, prior), /^Error: Native file observation mismatch$/);
  });
});

test("admits exact size boundaries but rejects larger metadata before reads (no large data read)", async t => {
  await fixture(async root => {
    for (const [sizes, allowed] of [[[268435456], true], [[268435457], false], [[268435456, 268435456], true]] as const) {
      const expected = sizes.map((size, i) => {
        const path = join(root, String(i)); fs.writeFileSync(path, "", { mode: 0o600 }); fs.truncateSync(path, size);
        return { id: `file${i}`, path, sha256: sha("") };
      });
      let reads = 0;
      const mock = t.mock.method(fs, "readSync", () => { reads++; throw Error("Intentional read stop: metadata boundary only"); });
      try {
        assert.throws(() => observeNativeFiles(expected), /^Error: Native file observation mismatch$/);
        assert.equal(reads, allowed ? 1 : 0);
      } finally { mock.mock.restore(); }
    }
  });
});

test("streams bounded chunks and handles short reads", async t => {
  await fixture(async root => {
    const path = join(root, "input"), text = "x".repeat(200000); await writeFile(path, text, { mode: 0o600 });
    const read = fs.readSync;
    let calls = 0;
    const mock = t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, length: number, position: any) => {
      assert.ok(length > 0 && length <= 65536, "read chunk bound"); calls++;
      return read(fd, buffer, offset, Math.min(length, 5000), position);
    });
    try {
      assert.equal(observeNativeFiles([{ id: "input", path, sha256: sha(text) }]).files[0].bytes, 200000);
      assert.ok(calls > 40);
    } finally { mock.mock.restore(); }
  });
});

test("closes the one descriptor on success and read failure, sanitizing diagnostics", async t => {
  await fixture(async root => {
    const path = join(root, "input"); await writeFile(path, "", { mode: 0o600 });
    const expected = [{ id: "input", path, sha256: sha("") }], open = fs.openSync;
    for (const fail of [false, true]) {
      const fds: number[] = [];
      const opening = t.mock.method(fs, "openSync", (...args: any[]) => { const fd = (open as any)(...args); fds.push(fd); return fd; });
      const reading = fail ? t.mock.method(fs, "readSync", () => { throw Error("SOURCE_PATH_MUST_NOT_LEAK"); }) : undefined;
      try {
        if (fail) assert.throws(() => observeNativeFiles(expected), /^Error: Native file observation mismatch$/);
        else observeNativeFiles(expected);
        assert.equal(fds.length, 1);
        assert.throws(() => fs.fstatSync(fds[0]), { code: "EBADF" });
      } finally {
        opening.mock.restore(); reading?.mock.restore();
        for (const fd of fds) { try { fs.closeSync(fd); } catch {} }
      }
    }
  });
});

test("snapshots expectation values before filesystem reads", async t => {
  await fixture(async root => {
    const path = join(root, "input"); await writeFile(path, "", { mode: 0o600 });
    const expected = [{ id: "input", path, sha256: sha("") }], expectedDigest = digest(expected), read = fs.readSync;
    const mock = t.mock.method(fs, "readSync", (...args: any[]) => {
      expected[0].sha256 = sha("changed"); return (read as any)(...args);
    });
    try { assert.equal(observeNativeFiles(expected).inventoryDigest, expectedDigest); }
    finally { mock.mock.restore(); }
  });
});

test("observes explicit expected bytes and descriptor identities without returning literal paths", async () => {
  await fixture(async root => {
    const path = join(root, "PATH_MUST_NOT_APPEAR"), text = "inert runtime bytes\n";
    await writeFile(path, text, { mode: 0o600 });
    const expected = [{ id: "runtime/node", path, sha256: sha(text) }], info = await stat(path, { bigint: true });
    const result = observeNativeFiles(expected);
    assert.deepEqual(result, { version: 1, kind: "native-selected-file-observation", inventoryDigest: digest(expected), files: [
      { id: "runtime/node", sha256: sha(text), bytes: Buffer.byteLength(text), dev: String(info.dev), ino: String(info.ino), uid: Number(info.uid), mode: Number(info.mode & 0o7777n) },
    ] });
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.files) && Object.isFrozen(result.files[0]));
    assert.doesNotMatch(JSON.stringify(result), /PATH_MUST_NOT_APPEAR|inert runtime bytes/);
  });
});
