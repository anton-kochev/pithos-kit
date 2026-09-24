import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { resourceSnapshot, observeChildExit, openDiagnostics, withResourceSnapshots, installChildDiagnostics } from "../src/offline-diagnostics.ts";

test("process-channel diagnostics observe only the selected CLI entry and can be removed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "guild-diagnostic-channel-")), entry = join(directory, "inert.mjs"), events: any[] = [];
  writeFileSync(entry, 'process.kill(process.pid, "SIGTERM");');
  const dispose = installChildDiagnostics(entry, event => events.push(event));
  try {
    const selected = spawn(process.execPath, [entry], { env: {}, stdio: "ignore", timeout: 3000 });
    await once(selected, "close");
    const other = spawn(process.execPath, ["-e", "process.exit(0)"], { env: {}, stdio: "ignore", timeout: 3000 });
    await once(other, "close");
    assert.deepEqual(events, [{ type: "child_spawn", childPid: selected.pid }, { type: "child_exit", childPid: selected.pid, code: null, signal: "SIGTERM" }]);
    dispose();
    const later = spawn(process.execPath, [entry], { env: {}, stdio: "ignore", timeout: 3000 });
    await once(later, "close"); assert.equal(events.length, 2);
  } finally { dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("supervisor retains before and after counters even when capture fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "guild-diagnostic-capture-"));
  try {
    await assert.rejects(withResourceSnapshots(directory, async () => {
      assert.equal(JSON.parse(readFileSync(join(directory, "resources-before.json"), "utf8")).version, 1);
      throw new Error("inert capture failed");
    }), /inert capture failed/);
    assert.equal(JSON.parse(readFileSync(join(directory, "resources-after.json"), "utf8")).version, 1);
    assert.equal(statSync(join(directory, "resources-after.json")).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("diagnostic sidecars are exclusive, private and bounded with an explicit truncation marker", () => {
  const directory = mkdtempSync(join(tmpdir(), "guild-diagnostic-log-")), file = join(directory, "diagnostics.jsonl");
  try {
    const log = openDiagnostics(file);
    assert.throws(() => openDiagnostics(file));
    assert.equal(log.emit({ type: "bootstrap_start" }), true);
    for (let i = 0; i < 1000; i++) log.emit({ type: "child_exit", childPid: 99, code: null, signal: "SIGKILL" });
    assert.equal(log.close(), false);
    assert.equal(statSync(file).mode & 0o777, 0o600); assert.ok(statSync(file).size <= 65536);
    const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows[0].event.type, "bootstrap_start"); assert.equal(rows[0].resources.version, 1);
    assert.equal(rows.at(-1).type, "diagnostic_output_limit");
    assert.equal(log.emit({ type: "bootstrap_start" }), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("raw child diagnostics distinguish an exit code from SIGKILL without normalizing either", async () => {
  for (const [script, code, signal] of [["process.exit(7)", 7, null], ['process.kill(process.pid, "SIGKILL")', null, "SIGKILL"]] as const) {
    const child = spawn(process.execPath, ["-e", script], { env: {}, stdio: "ignore", timeout: 3000 });
    const events: any[] = [];
    observeChildExit(child, event => events.push(event));
    await once(child, "close");
    assert.deepEqual(events, [{ type: "child_spawn", childPid: child.pid }, { type: "child_exit", childPid: child.pid, code, signal }]);
  }
});

test("malformed counters stay unknown and non-root cgroup layouts are not guessed", () => {
  for (const row of ["oom_kill 1 trailing", "oom_kill 1\noom_kill 2", "oom_kill -1", "oom_kill 9007199254740992"]) {
    const snapshot = resourceSnapshot(path => path === "/proc/self/cgroup" ? "0::/" : path.endsWith("memory.events") ? row : "max");
    assert.equal(snapshot.memory.events.oom_kill, null, row);
    assert.equal(snapshot.memory.current, null); assert.equal(snapshot.memory.max, "max");
  }
  const reads: string[] = [];
  const snapshot = resourceSnapshot(path => { reads.push(path); return "0::/private-container-path"; });
  assert.equal(snapshot.source, "unavailable"); assert.equal(snapshot.memory.events.oom_kill, null);
  assert.ok(reads.every(path => path.startsWith("/proc/self/"))); assert.doesNotMatch(JSON.stringify(snapshot), /private-container-path/);
});

test("resource snapshots keep selected cgroup values and distinguish unavailable readings from zero", () => {
  const files: Record<string, string> = {
    "/proc/self/cgroup": "0::/\n", "/proc/self/status": "Name:\tprivate-name\nThreads:\t11\n",
    "/sys/fs/cgroup/memory.current": "12345\n", "/sys/fs/cgroup/memory.peak": "54321\n", "/sys/fs/cgroup/memory.max": "536870912\n",
    "/sys/fs/cgroup/memory.events": "low 0\nhigh 0\nmax 4\noom 2\noom_kill 1\noom_group_kill 0\n",
    "/sys/fs/cgroup/pids.current": "29\n", "/sys/fs/cgroup/pids.max": "32\n", "/sys/fs/cgroup/pids.events": "max 0\n",
  };
  const snapshot = resourceSnapshot(path => { if (!(path in files)) throw new Error("private-path-and-error"); return files[path]; });
  assert.equal(snapshot.source, "cgroup-v2-root");
  assert.equal(snapshot.memory.current, 12345); assert.equal(snapshot.memory.max, 536870912);
  assert.equal(snapshot.memory.events.oom_kill, 1); assert.equal(snapshot.pids.events.max, 0);
  assert.equal(snapshot.pids.peak, null); assert.equal(snapshot.process.threads, 11);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-name|private-path/);
});
