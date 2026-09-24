import { constants } from "node:fs";
import { mkdir, open, lstat, readdir, rename, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "./manifest.ts";

const MAX_RECORD_BYTES = 65536;
// Twelve attempts are unchanged. Native adds one pre-spawn record per attempt.
const eventLimit = (spec: unknown) => (spec as { version?: unknown } | null)?.version === 2 ? 37 : 25;
function requireRecord(ok: unknown): asserts ok {
  if (!ok) throw new Error("Invalid campaign: damaged or unsafe journal");
}
function exact(value: any, keys: string[]) {
  requireRecord(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
async function privateDirectory(directory: string) {
  const info = await lstat(directory);
  requireRecord(info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0);
}
async function readJson(file: string) {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      requireRecord(info.isFile() && info.nlink === 1 && info.uid === process.getuid?.() && (info.mode & 0o077) === 0 && info.size <= MAX_RECORD_BYTES);
      const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
      let count = 0;
      while (count < bytes.length) {
        const { bytesRead } = await handle.read(bytes, count, bytes.length - count, null);
        if (!bytesRead) break;
        count += bytesRead;
      }
      requireRecord(count <= MAX_RECORD_BYTES);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
    } finally { await handle.close(); }
  } catch { throw new Error("Invalid campaign: unreadable, unsafe, or malformed journal record"); }
}
async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function save(file: string, value: unknown) {
  const text = JSON.stringify(value) + "\n";
  requireRecord(Buffer.byteLength(text) <= MAX_RECORD_BYTES);
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(text); await handle.sync(); }
  finally { await handle.close(); }
}
function supported(directory: string) {
  requireRecord(process.platform !== "win32" && isAbsolute(directory));
}
export async function createStore(directory: string, spec: unknown) {
  supported(directory);
  await mkdir(directory, { mode: 0o700 }); // Never reuse or overwrite an existing campaign.
  await save(join(directory, "spec.json"), spec);
  await mkdir(join(directory, "events"), { mode: 0o700 });
  await save(join(directory, "head.json"), { version: 1, count: 0, lastDigest: digest(spec) });
  await syncDirectory(directory);
  await syncDirectory(dirname(directory));
}

// One cooperative writer/read transaction. A stale lock is deliberately never stolen.
export async function transaction<T>(directory: string, spec: unknown, visit: (events: unknown[], append: (event: unknown) => Promise<void>) => Promise<T>): Promise<T> {
  supported(directory);
  const maxEvents = eventLimit(spec);
  await privateDirectory(directory);
  const lock = join(directory, ".lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Campaign locked; do not clear a stale lock without operator investigation");
    throw error;
  }
  try {
    if (digest(await readJson(join(directory, "spec.json"))) !== digest(spec)) throw new Error("Frozen campaign mismatch");
    const eventDirectory = join(directory, "events");
    await privateDirectory(eventDirectory);
    const head = await readJson(join(directory, "head.json"));
    exact(head, ["version", "count", "lastDigest"]);
    requireRecord(head.version === 1 && Number.isSafeInteger(head.count) && head.count >= 0 && head.count <= maxEvents);
    const files = (await readdir(eventDirectory)).sort();
    requireRecord(files.length === head.count);
    let previous = digest(spec);
    const events: unknown[] = [];
    for (let i = 0; i < files.length; i++) {
      requireRecord(files[i] === `${String(i).padStart(4, "0")}.json`);
      const envelope = await readJson(join(eventDirectory, files[i]));
      exact(envelope, ["version", "sequence", "previous", "event", "digest"]);
      const { digest: checksum, ...payload } = envelope;
      requireRecord(payload.version === 1 && payload.sequence === i && payload.previous === previous && checksum === digest(payload));
      previous = checksum;
      events.push(envelope.event);
    }
    requireRecord(previous === head.lastDigest);
    let appended = false;
    return await visit(events, async event => {
      requireRecord(!appended && files.length < maxEvents);
      appended = true;
      const payload = { version: 1, sequence: files.length, previous, event };
      const checksum = digest(payload);
      await save(join(eventDirectory, `${String(files.length).padStart(4, "0")}.json`), { ...payload, digest: checksum });
      await syncDirectory(eventDirectory);
      // The head detects a missing tail, including deletion of the only started record.
      const temporary = join(directory, `head-${randomUUID()}.tmp`);
      await save(temporary, { version: 1, count: files.length + 1, lastDigest: checksum });
      await rename(temporary, join(directory, "head.json"));
      await syncDirectory(directory);
    });
  } finally { await rmdir(lock); }
}
