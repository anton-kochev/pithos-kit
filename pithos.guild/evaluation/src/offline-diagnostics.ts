// Evaluation-only selected resource counters; no SDK imports, env, argv or heap contents.
import { openSync, readSync, writeSync, writeFileSync, closeSync, constants } from "node:fs";
import { join } from "node:path";
import { channel } from "node:diagnostics_channel";
import type { ChildProcess } from "node:child_process";

export async function withResourceSnapshots<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const save = (phase: string) => writeFileSync(join(directory, `resources-${phase}.json`), JSON.stringify(resourceSnapshot()), { flag: "wx", mode: 0o600 });
  save("before");
  try { return await action(); } finally { save("after"); }
}

type ChildDiagnostic = { type: "child_spawn"; childPid: number | undefined } | { type: "child_exit"; childPid: number | undefined; code: number | null; signal: string | null };
export function observeChildExit(child: ChildProcess, report: (event: ChildDiagnostic) => void) {
  child.once("spawn", () => report({ type: "child_spawn", childPid: child.pid }));
  child.once("exit", (code, signal) => report({ type: "child_exit", childPid: child.pid, code, signal }));
}

export function installChildDiagnostics(entry: string, report: (event: ChildDiagnostic) => void) {
  const events = channel("child_process");
  // Node publishes the channel event before spawnargs is populated. Select only
  // when spawn/exit is emitted, not when the ChildProcess object is announced.
  const listener = (event: any) => observeChildExit(event.process, row => { if (event.process.spawnargs?.[1] === entry) report(row); });
  events.subscribe(listener);
  return () => events.unsubscribe(listener);
}

type Diagnostic = ChildDiagnostic | { type: "bootstrap_start" | "dispatcher_ready" | "native_preload_start" | "native_preload_ready" | "telemetry_ready" } | { type: "process_exit"; code: number };
export function openDiagnostics(file: string) {
  const fd = openSync(file, "wx", 0o600), marker = Buffer.from('{"version":1,"type":"diagnostic_output_limit"}\n');
  let bytes = 0, sequence = 0, failed = false, closed = false;
  return {
    emit(event: Diagnostic) {
      if (failed || closed) return false;
      try {
        let line = Buffer.from(JSON.stringify({ version: 1, sequence: sequence++, event, resources: resourceSnapshot() }) + "\n");
        if (bytes + line.length > 65536 - marker.length) { failed = true; line = marker; }
        for (let offset = 0; offset < line.length;) { const n = writeSync(fd, line, offset, line.length - offset); if (!n) throw Error(); offset += n; }
        bytes += line.length;
      } catch { failed = true; }
      return !failed;
    },
    close() { if (!closed) { closed = true; try { closeSync(fd); } catch { failed = true; } } return !failed; },
  };
}

function boundedText(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(16385); let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, null); if (!n) break; offset += n; }
    if (offset === bytes.length) throw Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } finally { closeSync(fd); }
}
export function resourceSnapshot(read: (path: string) => string = boundedText) {
  const text = (path: string) => { try { const value = read(path); return Buffer.byteLength(value) <= 16384 ? value : null; } catch { return null; } };
  const root = text("/proc/self/cgroup")?.trim() === "0::/";
  const number = (value: string | undefined | null): number | null => value !== undefined && value !== null && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const value = (file: string, limit = false) => { const raw = root ? text(`/sys/fs/cgroup/${file}`)?.trim() : null; return limit && raw === "max" ? "max" : number(raw); };
  const events = (file: string, keys: string[]) => {
    const raw = root ? text(`/sys/fs/cgroup/${file}`) : null;
    return Object.fromEntries(keys.map(key => {
      const matches = raw?.trim().split("\n").filter(line => line.split(/\s+/)[0] === key) ?? [];
      return [key, matches.length === 1 && matches[0].split(/\s+/).length === 2 ? number(matches[0].split(/\s+/)[1]) : null];
    }));
  };
  const memory = process.memoryUsage();
  return { version: 1, source: root ? "cgroup-v2-root" : "unavailable", at: Date.now(),
    process: { pid: process.pid, ppid: process.ppid, rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external,
      threads: number(/^Threads:\s+(\d+)$/m.exec(text("/proc/self/status") ?? "")?.[1]) },
    memory: { current: value("memory.current"), peak: value("memory.peak"), max: value("memory.max", true), events: events("memory.events", ["low", "high", "max", "oom", "oom_kill", "oom_group_kill"]) },
    pids: { current: value("pids.current"), peak: value("pids.peak"), max: value("pids.max", true), events: events("pids.events", ["max"]) } };
}
