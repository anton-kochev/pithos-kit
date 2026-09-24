// Provider-free point-in-time configuration observation, not launch authority.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual as same } from "node:util";

const stamp = (s: fs.BigIntStats) => [s.dev, s.ino, s.mode, s.nlink, s.uid, s.gid, s.size, s.mtimeNs, s.ctimeNs];
function freeze(value: any): any {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export function readNativeConfig(file: string, sha256: string): Record<string, any> {
  try {
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
      || typeof file !== "string" || Buffer.byteLength(file) > 4096 || file.includes("\0")
      || !isAbsolute(file) || resolve(file) !== file || fs.realpathSync(file) !== file) throw Error();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const info = fs.fstatSync(fd, { bigint: true });
      if (!info.isFile() || info.nlink !== 1n || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o077n) !== 0n || info.size < 0n || info.size > 65536n) throw Error();
      const bytes = Buffer.alloc(Number(info.size) + 1); let count = 0;
      while (count < bytes.length) { const n = fs.readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
      if (count !== Number(info.size) || !same(stamp(info), stamp(fs.fstatSync(fd, { bigint: true })))
        || !same(stamp(info), stamp(fs.lstatSync(file, { bigint: true }))) || fs.realpathSync(file) !== file) throw Error();
      const raw = bytes.subarray(0, count);
      if (createHash("sha256").update(raw).digest("hex") !== sha256) throw Error();
      const config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      if (!config || typeof config !== "object" || Array.isArray(config)) throw Error();
      return freeze(config);
    } finally { fs.closeSync(fd); }
  } catch { throw new Error("Native configuration observation mismatch"); }
}
