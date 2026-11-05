/**
 * Opt-in, provider-free Pi 1.4.0 shutdown probe with terminal-I/O UI smoke.
 * npm run test:shutdown-runtime -- /path/to/pi/dist/cli.js (or PI_SHUTDOWN_PROBE_CLI).
 * Four core pins and four actual InteractiveMode cases must pass.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const argument = process.argv[2] ?? process.env.PI_SHUTDOWN_PROBE_CLI;
  assert.ok(argument, "NOT CONFIGURED: supply installed Pi dist/cli.js or PI_SHUTDOWN_PROBE_CLI; no default runtime");
  assert.ok(process.argv.length <= 3, "Expected exactly one CLI path");
  const cli = await realpath(resolve(argument));
  const packageRoot = dirname(dirname(cli));
  assert.equal(cli, await realpath(join(packageRoot, "dist/cli.js")), "Expected installed dist/cli.js");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
  assert.equal(manifest.version, "1.4.0", "Probe admits only the explicitly selected Pi 1.4.0 runtime");
  assert.equal(manifest.exports?.["."]?.import, "./dist/index.js", "Expected public Pi SDK export");
  const worker = fileURLToPath(new URL("../test/fixtures/shutdown-runtime-probe-worker.mjs", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "guild-shutdown-probe-"));
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("Probe exceeded 30s deadline")), 30_000);
  const interrupt = () => controller.abort(new Error("Probe interrupted"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let child: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  let isClosed = false;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let printed = false;
  const printOutput = () => {
    if (printed) return;
    printed = true;
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  };
  try {
    const home = join(root, "home");
    const config = join(home, "config");
    const cwd = join(root, "cwd");
    const temp = join(root, "tmp");
    const cache = join(home, "cache");
    for (const path of [home, config, cwd, temp, cache]) await mkdir(path, { mode: 0o700 });
    controller.signal.throwIfAborted();
    child = spawn(process.execPath, [worker, cli], {
      cwd, stdio: ["ignore", "pipe", "pipe"],
      // No inherited credentials, proxies, PATH, NODE_OPTIONS, or user/project configuration.
      env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache,
        TMPDIR: temp, TMP: temp, TEMP: temp, PI_CODING_AGENT_DIR: config,
        PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    });
    closed = new Promise<void>(done => child!.once("close", (code, signal) => {
      isClosed = true;
      console.log(JSON.stringify({ phase: "process-close", pid: child!.pid, code, signal }));
      done();
    }));
    const fail = (error: unknown) => controller.abort(new Error(String(error).slice(0, 2048)));
    child.on("error", fail);
    child.stdout!.on("error", fail);
    child.stderr!.on("error", fail);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > 128 * 1024) fail("stdout exceeded 128KiB");
      else stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length > 8192) fail("stderr exceeded 8KiB");
      else stderr = Buffer.concat([stderr, chunk]);
    });
    let onAbort!: () => void;
    try {
      await Promise.race([closed, new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      })]);
    } finally { controller.signal.removeEventListener("abort", onAbort); }
    printOutput();
    controller.signal.throwIfAborted();
    assert.equal(stderr.toString("utf8"), "", "Unexpected worker stderr diagnostics");
    assert.equal(child.exitCode, 0, "Shutdown hypotheses failed: see worker case evidence");
    assert.equal(child.signalCode, null);
    const text = stdout.toString("utf8");
    assert.ok(text.endsWith("\n"), "Incomplete worker evidence");
    const records: Record<string, unknown>[] = text.trimEnd().split("\n").map(line => JSON.parse(line));
    assert.equal(records[0].phase, "runtime");
    assert.equal(records[0].version, "1.4.0");
    assert.equal(records[0].aiVersion, "1.4.0");
    const cases = records.filter(record => record.phase === "case");
    assert.deepEqual(cases.map(record => record.case), ["before-switch-veto", "replacement-drain",
      "cleanup-fault-continuation", "terminal-drain", "interactive-smoke", "reset-before-shutdown",
      "reset-before-shutdown-late-rejection", "reset-before-shutdown-cleanup-fault"]);
    for (const core of cases) assert.equal(core.status, "passed", JSON.stringify(core));
    assert.equal(records.at(-1)?.phase, "summary");
    assert.equal(records.at(-1)?.passed, 8);
    assert.equal(records.at(-1)?.coreComplete, true);
    assert.equal(records.at(-1)?.skipped, 0);
    assert.equal(records.at(-1)?.complete, true);

  } finally {
    clearTimeout(deadline);
    // The directory must outlive the process, including on timeout/interruption.
    // Sending SIGKILL is not evidence of close; await the actual close event.
    try {
      if (child && !isClosed) {
        child.kill("SIGTERM");
        const force = setTimeout(() => child!.kill("SIGKILL"), 1000);
        try { await closed; } finally { clearTimeout(force); }
      }
      printOutput();
      const files = await readdir(root, { recursive: true });
      assert.ok(!files.some(path => path.endsWith(".jsonl")), "Unexpected persisted session JSONL");
      assert.ok(!files.some(path => /(?:^|[/\\])(?:auth|settings|models|models-store)\.json$/.test(path)),
        "Settings, auth, and model storage must remain in memory");
      console.log(JSON.stringify({ phase: "storage-check", sessionJsonl: 0, persistentConfig: 0 }));
    } finally {
      await rm(root, { recursive: true, force: true });
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      console.log(JSON.stringify({ phase: "cleanup", closed: isClosed, removed: root }));
    }
  }
}

try { await main(); }
catch (error) {
  console.error(String(error).slice(0, 4096));
  process.exitCode = 1;
}
