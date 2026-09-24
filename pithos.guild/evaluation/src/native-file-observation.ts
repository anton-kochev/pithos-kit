// Selected filesystem bytes only. Expectations are inputs, not approval or
// evidence that a process loaded these files. Never discovers or launches Pi.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { digest } from "./manifest.ts";

export interface NativeFileExpectation { readonly id: string; readonly path: string; readonly sha256: string }
const check = (value: unknown) => { if (!value) throw Error(); };
function inventory(expected: readonly NativeFileExpectation[]) {
  check(Array.isArray(expected) && expected.length > 0 && expected.length <= 256 && Reflect.ownKeys(expected).length === expected.length + 1);
  const ids = new Set<string>(), paths = new Set<string>();
  return Array.from(expected, entry => {
    check(entry && typeof entry === "object" && !Array.isArray(entry) && Reflect.ownKeys(entry).length === 3
      && ["id", "path", "sha256"].every(key => Object.hasOwn(entry, key)));
    const { id, path, sha256 } = entry;
    check(typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(id));
    check(typeof path === "string" && Buffer.byteLength(path) <= 4096 && !path.includes("\u0000") && path !== "/" && isAbsolute(path) && resolve(path) === path);
    check(typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256) && !ids.has(id) && !paths.has(path));
    ids.add(id); paths.add(path);
    return { id, path, sha256 };
  });
}
const stamp = (s: fs.BigIntStats) => [s.dev, s.ino, s.mode, s.nlink, s.uid, s.gid, s.size, s.mtimeNs, s.ctimeNs];
export function observeNativeFiles(expected: readonly NativeFileExpectation[]) {
  try {
    expected = inventory(expected);
    const plan = expected.map(entry => {
      check(fs.realpathSync(entry.path) === entry.path);
      const info = fs.lstatSync(entry.path, { bigint: true });
      check(info.isFile() && info.size >= 0n && info.size <= 268435456n && info.nlink === 1n
        && (info.uid === 0n || info.uid === BigInt(process.getuid!())) && (info.mode & 0o022n) === 0n);
      return { entry, info };
    });
    check(plan.reduce((total, item) => total + item.info.size, 0n) <= 536870912n);
    const files = plan.map(({ entry, info: initial }) => {
      const fd = fs.openSync(entry.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const info = fs.fstatSync(fd, { bigint: true });
        check(same(stamp(initial), stamp(info)));
        const buffer = Buffer.alloc(65536), hash = createHash("sha256");
        let bytes = 0;
        while (bytes <= Number(info.size)) {
          const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, Number(info.size) + 1 - bytes), null);
          if (!n) break;
          bytes += n; hash.update(buffer.subarray(0, n));
        }
        check(bytes === Number(info.size));
        check(same(stamp(info), stamp(fs.fstatSync(fd, { bigint: true })))
          && same(stamp(info), stamp(fs.lstatSync(entry.path, { bigint: true }))) && fs.realpathSync(entry.path) === entry.path);
        const sha256 = hash.digest("hex");
        check(sha256 === entry.sha256);
        return Object.freeze({ id: entry.id, sha256, bytes, dev: String(info.dev), ino: String(info.ino), uid: Number(info.uid), mode: Number(info.mode & 0o7777n) });
      } finally { fs.closeSync(fd); }
    });
    for (const { entry, info } of plan) {
      check(same(stamp(info), stamp(fs.lstatSync(entry.path, { bigint: true }))) && fs.realpathSync(entry.path) === entry.path);
    }
    return Object.freeze({ version: 1 as const, kind: "native-selected-file-observation" as const, inventoryDigest: digest(expected), files: Object.freeze(files) });
  } catch { throw new Error("Native file observation mismatch"); }
}
export type NativeFileObservation = ReturnType<typeof observeNativeFiles>;
export function assertNativeFiles(expected: readonly NativeFileExpectation[], prior: NativeFileObservation) {
  try {
    const actual = observeNativeFiles(expected);
    check(same(actual, prior));
    return actual;
  } catch { throw new Error("Native file observation mismatch"); }
}
