import { constants } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { mkdtemp, open, realpath, writeFile, rm } from "node:fs/promises";
import { join, isAbsolute, relative, sep } from "node:path";
import { captureScopedAuth, assertScopedAuth, type ScopedAuthIdentity } from "./scoped-auth-identity.ts";

type LeaseObservation = Readonly<{ directory: string; identity: ScopedAuthIdentity }>;
type LeaseScope = Readonly<{ timeoutMs: number; forbiddenRoots: readonly string[] }>;
const issuedLeases = new WeakMap<object, { observation: LeaseObservation; scope: LeaseScope; assertFresh: () => void }>();
// Process-local issuer/liveness check, not provider or operator authentication.
export function readCodexAuthLease(lease: unknown, expectedScope?: LeaseScope): LeaseObservation {
  try {
    const record = issuedLeases.get(lease as object);
    if (!record || (expectedScope !== undefined && !isDeepStrictEqual(record.scope, expectedScope))) throw Error();
    record.assertFresh();
    return record.observation;
  } catch { throw new Error("Codex authentication lease mismatch"); }
}

export interface CodexAuthSource {
  sourceFile: string;
  temporaryRoot: string;
}
interface Options extends CodexAuthSource {
  forbiddenRoots: string[];
  timeoutMs: number;
}

// Reviewed Pi 0.83.0 and 0.85.1 refresh within five minutes of expiry. Borrow
// access only, with a full trial window plus another minute for setup/clock skew.
const REFRESH_RESERVE_MS = 6 * 60 * 1000;
const MAX_AUTH_BYTES = 1024 * 1024;
const within = (file: string, root: string) => {
  const rel = relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

async function readPrivateSource(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.size > MAX_AUTH_BYTES) {
      throw new Error("Not a private bounded credential file");
    }
    const bytes = Buffer.alloc(MAX_AUTH_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MAX_AUTH_BYTES) throw new Error("Credential file too large");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
  } finally { await handle.close(); }
}

export async function createCodexAuthLease(options: Options) {
  if (process.platform === "win32" || !Array.isArray(options.forbiddenRoots) || !options.forbiddenRoots.length
    || ![options.sourceFile, options.temporaryRoot, ...options.forbiddenRoots].every(value => typeof value === "string" && isAbsolute(value))
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 3600000) {
    throw new Error("Invalid scoped Codex authentication options");
  }
  options = { ...options, forbiddenRoots: [...options.forbiddenRoots] };
  let temporaryRoot: string;
  let credential: { type: string; access: string; expires: number; accountId: string; refresh: string };
  try {
    temporaryRoot = await realpath(options.temporaryRoot);
    const sourcePath = await realpath(options.sourceFile);
    for (const root of await Promise.all(options.forbiddenRoots.map(root => realpath(root)))) {
      if (within(sourcePath, root) || within(temporaryRoot, root)) throw new Error("Credential storage overlaps retained inputs/artifacts");
    }
    const data = JSON.parse(await readPrivateSource(options.sourceFile))["openai-codex"];
    if (data?.type !== "oauth" || typeof data.access !== "string" || data.access.length > 64 * 1024
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data.access)
      || !Number.isSafeInteger(data.expires) || data.expires <= 0) throw new Error("Invalid OAuth credential");
    // Structural consistency only; the provider, not this parser, verifies JWT signatures.
    const claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(data.access.split(".")[1], "base64url")));
    const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (!Number.isSafeInteger(claims?.exp) || claims.exp <= 0 || !Number.isSafeInteger(claims.exp * 1000)
      || typeof accountId !== "string" || !accountId.trim() || accountId.length > 256
      || data.accountId !== accountId) throw new Error("Invalid OAuth identity or expiry");
    credential = {
      type: "oauth", access: data.access, refresh: "",
      expires: Math.min(data.expires, claims.exp * 1000), accountId,
    };
  } catch { throw new Error("Unable to read a scoped Codex access credential"); }
  const assertLifetime = () => {
    if (credential.expires <= Date.now() + options.timeoutMs + REFRESH_RESERVE_MS) {
      throw new Error("Codex access token must outlive the trial and refresh reserve; refresh it outside evaluation");
    }
  };
  assertLifetime();
  let directory: string;
  try { directory = await mkdtemp(join(temporaryRoot, "guild-codex-")); }
  catch { throw new Error("Unable to create private Codex authentication"); }
  let issued: object | undefined, disposed = false;
  const dispose = async () => {
    disposed = true;
    if (issued) issuedLeases.delete(issued);
    try { await rm(directory, { recursive: true, force: true }); }
    catch { throw new Error("Private Codex credential cleanup failed"); }
  };
  try {
    const file = join(directory, "auth.json");
    await writeFile(file, JSON.stringify({ "openai-codex": credential }), { flag: "wx", mode: 0o600 });
    const identity = captureScopedAuth(file, options.timeoutMs);
    const lease = Object.freeze({ directory, identity, assertFresh: () => {
      if (disposed) throw new Error("Codex authentication lease mismatch");
      assertLifetime(); assertScopedAuth(file, identity, options.timeoutMs);
    }, dispose });
    issued = lease;
    issuedLeases.set(lease, { observation: Object.freeze({ directory, identity }),
      scope: Object.freeze({ timeoutMs: options.timeoutMs, forbiddenRoots: Object.freeze([...options.forbiddenRoots]) }), assertFresh: lease.assertFresh });
    return lease;
  } catch {
    await dispose();
    throw new Error("Unable to create private Codex authentication");
  }
}
