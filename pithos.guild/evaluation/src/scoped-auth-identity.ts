// Provider-free observation of an explicitly supplied transient auth file.
// Identity hashes are private provenance metadata, not provider authentication.
import fs from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { digest } from "./manifest.ts";

function check(value: unknown): asserts value { if (!value) throw Error(); }
function exact(value: any, keys: string[]) {
  check(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)));
}
const stamp = (s: fs.BigIntStats) => [s.dev, s.ino, s.mode, s.nlink, s.uid, s.gid, s.size, s.mtimeNs, s.ctimeNs];
function readScopedAuth(file: string, remainingMs: number) {
  try {
    check(Number.isSafeInteger(remainingMs) && remainingMs >= 0 && remainingMs <= 3600000);
    check(typeof file === "string" && Buffer.byteLength(file) <= 4096 && !file.includes("\u0000") && isAbsolute(file) && resolve(file) === file && fs.realpathSync(file) === file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const info = fs.fstatSync(fd, { bigint: true });
      check(info.isFile() && info.nlink === 1n && info.uid === BigInt(process.getuid!()) && (info.mode & 0o077n) === 0n && info.size <= 1048576n);
      const bytes = Buffer.alloc(Number(info.size) + 1);
      let count = 0;
      while (count < bytes.length) { const n = fs.readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
      check(count === Number(info.size));
      check(same(stamp(info), stamp(fs.fstatSync(fd, { bigint: true })))
        && same(stamp(info), stamp(fs.lstatSync(file, { bigint: true }))) && fs.realpathSync(file) === file);
      const raw = bytes.subarray(0, count), store = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      exact(store, ["openai-codex"]);
      const data = store["openai-codex"];
      exact(data, ["type", "access", "refresh", "expires", "accountId"]);
      check(data.type === "oauth" && data.refresh === "" && typeof data.access === "string" && data.access.length <= 65536
        && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data.access)
        && Number.isSafeInteger(data.expires) && data.expires > 0 && typeof data.accountId === "string" && data.accountId.trim() && data.accountId.length <= 256);
      const payload = data.access.split(".")[1], decoded = Buffer.from(payload, "base64url");
      check(decoded.toString("base64url") === payload);
      const claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
      check(Number.isSafeInteger(claims?.exp) && claims.exp > 0 && Number.isSafeInteger(claims.exp * 1000) && data.expires <= claims.exp * 1000
        && claims["https://api.openai.com/auth"]?.chatgpt_account_id === data.accountId);
      const now = Date.now(), threshold = now + remainingMs + 360000;
      check(Number.isSafeInteger(now) && now >= 0 && Number.isSafeInteger(threshold) && data.expires > threshold);
      return { identity: Object.freeze({ version: 1 as const, kind: "scoped-codex-auth-file-observation" as const,
        dev: info.dev.toString(), ino: info.ino.toString(), uid: Number(info.uid), fileDigest: digest(raw.toString("base64")),
        accountDigest: digest(data.accountId), expires: data.expires as number }), access: data.access as string };
    } finally { fs.closeSync(fd); }
  } catch { throw new Error("Scoped Codex authentication mismatch"); }
}
export function captureScopedAuth(file: string, remainingMs: number) { return readScopedAuth(file, remainingMs).identity; }
export type ScopedAuthIdentity = ReturnType<typeof captureScopedAuth>;
export function assertScopedAuth(file: string, expected: ScopedAuthIdentity, remainingMs: number) {
  try {
    const identity = captureScopedAuth(file, remainingMs);
    check(same(identity, expected));
    return identity;
  } catch { throw new Error("Scoped Codex authentication mismatch"); }
}
export function assertScopedAuthAccess(file: string, expected: ScopedAuthIdentity, access: string) {
  try {
    const observed = readScopedAuth(file, 0);
    check(same(observed.identity, expected) && observed.access === access);
    return observed.identity;
  } catch { throw new Error("Scoped Codex authentication mismatch"); }
}
