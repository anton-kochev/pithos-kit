/** Opt-in Pi 1.4 accounting qualification; no public background tools or child execution. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const argument = process.argv[2] ?? process.env.PI_ACCOUNTING_PROBE_CLI;
  assert.ok(argument, "NOT CONFIGURED: supply installed Pi dist/cli.js or PI_ACCOUNTING_PROBE_CLI; no default runtime");
  assert.ok(process.argv.length <= 3, "Expected exactly one CLI path");
  const cli = await realpath(resolve(argument));
  const packageRoot = dirname(dirname(cli));
  assert.equal(cli, await realpath(join(packageRoot, "dist/cli.js")), "Expected installed dist/cli.js");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
  assert.equal(manifest.version, "1.4.0", "Probe admits only the explicitly selected Pi 1.4.0 runtime");
  assert.equal(manifest.exports?.["."]?.import, "./dist/index.js", "Expected public Pi SDK export");
  const worker = fileURLToPath(new URL("../test/fixtures/accounting-runtime-probe-worker.mjs", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "guild-accounting-probe-"));
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("Probe exceeded 60s deadline")), 60_000);
  const interrupt = () => controller.abort(new Error("Probe interrupted"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let child: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  let isClosed = false;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let printed = false;
  let completed = 0;
  let checkpoint: Record<string, unknown> | undefined;
  const sessionFiles = new Set<string>();
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
    for (const phase of ["full", "claim-exit", "recover"]) {
      stdout = Buffer.alloc(0); stderr = Buffer.alloc(0); printed = false; isClosed = false;
      controller.signal.throwIfAborted();
      child = spawn(process.execPath, [worker, cli, "", phase, ...(checkpoint ? [String(checkpoint.file)] : [])], {
        cwd, stdio: ["ignore", "pipe", "pipe"],
        // No inherited credentials, proxies, PATH, NODE_OPTIONS, or user/project configuration.
        env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache,
          TMPDIR: temp, TMP: temp, TEMP: temp, PI_CODING_AGENT_DIR: config,
          PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
      });
      closed = new Promise<void>(done => child!.once("close", (code, signal) => {
        isClosed = true;
        console.log(JSON.stringify({ phase: "process-close", workerPhase: phase, pid: child!.pid, code, signal }));
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
      assert.equal(child.exitCode, phase === "claim-exit" ? 23 : 0, "Accounting hypotheses failed: see worker case evidence");
      assert.equal(child.signalCode, null);
      const text = stdout.toString("utf8");
      assert.ok(text.endsWith("\n"), "Incomplete worker evidence");
      const records: Record<string, unknown>[] = text.trimEnd().split("\n").map(line => JSON.parse(line));
      assert.equal(records[0].phase, "runtime");
      assert.equal(records[0].version, "1.4.0");
      assert.equal(records[0].aiVersion, "1.4.0");
      if (phase === "claim-exit") {
        checkpoint = records.at(-1);
        assert.equal(checkpoint?.phase, "claim-checkpoint");
        assert.ok(checkpoint && typeof checkpoint.file === "string");
        assert.equal(checkpoint.runId, "exit");
        assert.equal(checkpoint.taskId, "t-exit");
        assert.equal(checkpoint.collectionId, "collection-call-exit");
        assert.equal(checkpoint.toolCallId, "call-exit");
        const claim = checkpoint;
        const file = await realpath(checkpoint.file);
        assert.equal(file, checkpoint.file);
        sessionFiles.add(file);
        assert.equal(dirname(file), await realpath(join(cwd, "loss-sessions")), "Checkpoint must name owned session");
        assert.ok((await stat(file)).size < 128 * 1024);
        const entries = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        assert.equal(entries[0].id, checkpoint.sessionId);
        const events = entries.filter(e => e.type === "custom" && e.data?.runId === claim.runId).map(e => e.data);
        assert.deepEqual(events.map(e => e.kind), ["admitted", "terminal", "collected"], "Exit must persist exactly one claim");
        assert.equal(events[2].native, "claimed");
        assert.equal(events[2].toolCallId, checkpoint.toolCallId);
        assert.equal(events[2].collectionId, checkpoint.collectionId);
        assert.equal(events[2].taskId, checkpoint.taskId);
        assert.equal(entries.filter(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === claim.toolCallId).length, 0, "Exit must precede native tool result");
        console.log(JSON.stringify({phase: "loss-disk", receipts: 1, matchingToolResults: 0}));
      } else {
        if (phase === "full") assert.equal(records.find(record => record.phase === "accounting")?.tokens, 160);
        else assert.equal(records.find(record => record.phase === "recovery")?.receipts, 1);
        assert.equal(records.at(-1)?.phase, "summary");
        assert.equal(records.at(-1)?.passed, true);
        const file = records.at(-1)?.file;
        assert.ok(typeof file === "string");
        assert.equal(file, await realpath(file));
        assert.equal(dirname(file), await realpath(join(cwd, phase === "full" ? "sessions" : "loss-sessions")));
        sessionFiles.add(file);
      }
      completed++;
    }
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
      assert.ok(files.length <= 64, "Bounded SDK session and loader-cache resources");
      const jsonl = files.filter(path => path.endsWith(".jsonl"));
      assert.ok(jsonl.length <= 2, "At most two owned sessions");
      if (completed === 3) {
        assert.equal(jsonl.length, 2, "Exactly two seeded persisted sessions are expected");
        assert.deepEqual(new Set(jsonl.map(path => join(root, path))), sessionFiles, "Only known session files");
      }
      assert.ok(jsonl.every(path => /^(cwd\/(sessions|loss-sessions)\/)/.test(path)));
      for (const path of files) {
        const info = await stat(join(root, path));
        if (info.isFile()) {
          assert.ok(jsonl.includes(path) || /^tmp\/jiti\/[\w.-]+\.mjs$/.test(path), `Unplanned file: ${path}`);
          assert.ok(info.size < 128 * 1024, "Session file bound");
        }
      }
      assert.ok(!files.some(path => /(?:^|[/\\])(?:auth|settings|models|models-store)\.json$/.test(path)),
        "Settings, auth, and model storage must remain in memory");
      console.log(JSON.stringify({ phase: "storage-check", sessionJsonl: jsonl.length, workersCompleted: completed, persistentConfig: 0,
        loaderCaches: files.filter(path => path.startsWith("tmp/jiti/") && path.endsWith(".mjs")).length }));
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
