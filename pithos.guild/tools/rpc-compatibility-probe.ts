/**
 * Exploratory real-runtime compatibility spike, NOT a production RPC transport.
 * Run via npm run test:rpc-compat -- /path/to/pi/dist/cli.js (or PI_RPC_PROBE_CLI).
 * Only the explicitly selected 1.4.0 runtime is admitted; local 0.99 doubles are not evidence.
 * This does not certify Pi >=1.0, live providers, Guild protocol, or Plan quiescence.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Pi 1.4's public RpcClient has no extension-UI reply method or byte-limit controls.
// Use documented JSONL here, not its private send/process fields.
// These records are inspected by assertions below, not trusted as a production protocol schema.
type Wire = Record<string, any>;
const cliArgument = process.argv[2] ?? process.env.PI_RPC_PROBE_CLI;
assert.ok(cliArgument, "NOT CONFIGURED: supply an installed Pi dist/cli.js path or PI_RPC_PROBE_CLI; no default runtime");
assert.ok(process.argv.length <= 3, "Expected exactly one CLI path");
const cli = await realpath(resolve(cliArgument));
const manifest = JSON.parse(await readFile(join(dirname(cli), "..", "package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
assert.equal(manifest.version, "1.4.0", "Exploratory probe only inspected Pi 1.4.0; refusing another runtime");
assert.equal(cli, await realpath(join(dirname(cli), "cli.js")));
const fixture = fileURLToPath(new URL("../test/fixtures/rpc-compatibility-probe-extension.ts", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "guild-rpc-compat-"));
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error("Probe exceeded 30s deadline")), 30_000);
const interrupt = () => controller.abort(new Error("Probe interrupted"));
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const children: {
  task: string; child: ChildProcessWithoutNullStreams; records: Wire[];
  closed: Promise<void>; isClosed: boolean; stderr: string; bytes: number;
  pending: Buffer; eofRequested: boolean; question?: Wire; sessionId?: string;
}[] = [];

try {
  for (let i = 0; i < 3; i++) {
    const task = `task-${i}`;
    const home = join(root, task);
    const config = join(home, "config");
    const cwd = join(home, "cwd");
    await mkdir(config, { recursive: true, mode: 0o700 });
    await mkdir(cwd, { mode: 0o700 });
    await writeFile(join(config, "settings.json"), JSON.stringify({
      compaction: { enabled: false }, retry: { enabled: false },
    }), { mode: 0o600 });
    controller.signal.throwIfAborted();
    const child = spawn(process.execPath, [cli,
      "--mode", "rpc", "--no-session", "--no-approve", "--offline",
      "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
      "--no-themes", "--no-mcp", "--extension", fixture,
      "--provider", "rpc-compat-probe", "--model", "scripted",
      "--tools", "probe_question", "--thinking", "off",
      "--system-prompt", "Repository-only deterministic RPC compatibility probe.",
    ], {
      cwd, stdio: ["pipe", "pipe", "pipe"],
      // Deliberately do not inherit PATH, NODE_OPTIONS, credentials, proxies, or Pi configuration.
      env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config,
        PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0", RPC_PROBE_TASK: task },
    });
    let close!: () => void;
    const state: typeof children[number] = {
      task, child, records: [], closed: new Promise<void>(r => { close = r; }),
      isClosed: false, stderr: "", bytes: 0, pending: Buffer.alloc(0), eofRequested: false,
    };
    children.push(state);
    const fail = (error: unknown) => controller.abort(new Error(`${task}: ${String(error).slice(0, 2048)}`));
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(state.stderr) + chunk.length > 8192) {
        fail("stderr exceeds 8KiB");
      } else state.stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (controller.signal.aborted) return;
      try {
        state.bytes += chunk.length;
        assert.ok(state.bytes <= 512 * 1024, "stdout exceeds 512KiB per child (1.5MiB aggregate)");
        state.pending = Buffer.concat([state.pending, chunk]);
        let lf: number;
        while ((lf = state.pending.indexOf(10)) >= 0) {
          assert.ok(lf <= 64 * 1024, "record exceeds 64KiB");
          const line = state.pending.subarray(0, lf).toString("utf8");
          state.pending = state.pending.subarray(lf + 1);
          const record: Wire = JSON.parse(line);
          assert.ok(record && typeof record === "object" && !Array.isArray(record));
          assert.equal(typeof record.type, "string");
          assert.notEqual(record.type, "extension_error", JSON.stringify(record));
          if (record.type === "response") assert.equal(record.success, true, JSON.stringify(record));
          if (record.type === "message_end" && record.message?.role === "assistant") {
            assert.ok(!["error", "aborted"].includes(record.message.stopReason), JSON.stringify(record));
          }
          state.records.push(record);
          assert.ok(state.records.length <= 256, "Too many records");
        }
        assert.ok(state.pending.length <= 64 * 1024, "Unterminated record exceeds 64KiB");
      } catch (error) { fail(error); }
    });
    child.on("close", (code, signal) => {
      state.isClosed = true;
      close();
      if (!state.eofRequested || code !== 0 || signal || state.pending.length) {
        fail(`Unexpected close: code=${code}, signal=${signal}, partial=${state.pending.length}, stderr=${state.stderr}`);
      }
    });
  }

  // Poll only this bounded experiment's captured records; every wait shares one deadline/abort.
  const wait = async (predicate: () => boolean) => {
    while (!predicate()) await delay(10, undefined, { signal: controller.signal });
    controller.signal.throwIfAborted();
  };
  const send = async (state: typeof children[number], record: Wire) => {
    controller.signal.throwIfAborted();
    await new Promise<void>((ok, reject) => {
      state.child.stdin.write(`${JSON.stringify(record)}\n`, error => error ? reject(error) : ok());
    });
  };
  const command = async (state: typeof children[number], id: string, type: string, extra: Wire = {}) => {
    await send(state, { id, type, ...extra });
    await wait(() => state.records.some(r => r.type === "response" && r.id === id));
    const responses = state.records.filter(r => r.type === "response" && r.id === id);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].command, type);
    return responses[0].data;
  };

  await Promise.all(children.map(async state => {
    const before = await command(state, "before", "get_state");
    assert.equal(before.model.provider, "rpc-compat-probe");
    assert.equal(before.model.id, "scripted");
    assert.ok(!before.sessionFile);
    assert.equal(typeof before.sessionId, "string");
    state.sessionId = before.sessionId;
    const accepted = await command(state, "prompt", "prompt", { message: state.task });
    assert.equal(accepted.disposition, "started");
    await wait(() => state.records.some(r => r.type === "extension_ui_request"));
    const questions = state.records.filter(r => r.type === "extension_ui_request");
    assert.equal(questions.length, 1);
    state.question = questions[0];
    assert.equal(state.question.method, "input");
    assert.equal(typeof state.question.id, "string");
    assert.deepEqual(JSON.parse(state.question.title), {
      task: state.task, pid: state.child.pid, callId: "original-question",
    });
  }));
  assert.equal(new Set(children.map(s => s.child.pid)).size, 3);
  assert.equal(new Set(children.map(s => s.sessionId)).size, 3);
  for (const state of children) {
    assert.equal(state.isClosed, false);
    process.kill(state.child.pid!, 0);
    assert.ok(!state.records.some(r => r.type === "tool_execution_end" || r.type === "agent_settled"));
    const waiting = await command(state, "waiting", "get_state");
    assert.equal(waiting.isStreaming, true);
    assert.equal(waiting.sessionId, state.sessionId);
  }
  console.log(JSON.stringify({ phase: "three-alive-waiting", version: manifest.version,
    children: children.map(s => ({ task: s.task, pid: s.child.pid, sessionId: s.sessionId, questionId: s.question!.id })) }));

  for (const index of [2, 0, 1]) {
    const state = children[index];
    await send(state, { type: "extension_ui_response", id: state.question!.id, value: `answer-for-${state.task}` });
    await wait(() => state.records.some(r => r.type === "agent_settled"));
    assert.equal(state.records.filter(r => r.type === "agent_settled").length, 1);
    assert.equal(state.records.find(r => r.type === "agent_settled")!.aborted, false);
    const starts = state.records.filter(r => r.type === "tool_execution_start");
    const ends = state.records.filter(r => r.type === "tool_execution_end");
    assert.equal(starts.length, 1);
    assert.equal(ends.length, 1);
    assert.equal(starts[0].toolName, "probe_question");
    assert.equal(starts[0].toolCallId, "original-question");
    assert.deepEqual(starts[0].args, { task: state.task });
    assert.equal(ends[0].toolCallId, starts[0].toolCallId);
    assert.equal(ends[0].isError, false);
    const expected = { task: state.task, pid: state.child.pid, callId: "original-question", answer: `answer-for-${state.task}` };
    assert.deepEqual(ends[0].result.details, expected);
    assert.deepEqual(ends[0].result.content, [{ type: "text", text: JSON.stringify(expected) }]);
    const text = await command(state, "text", "get_last_assistant_text");
    assert.deepEqual(JSON.parse(text.text), { observed: expected.answer, task: state.task, pid: state.child.pid, requests: 2 });
    const after = await command(state, "after", "get_state");
    assert.equal(after.sessionId, state.sessionId);
    assert.equal(after.isStreaming, false);
    assert.ok(!after.sessionFile);
    assert.equal(state.records.filter(r => r.type === "extension_ui_request").length, 1);
    assert.equal(state.isClosed, false);
    console.log(JSON.stringify({ phase: "original-tool-resumed-provider-observed", ...expected }));
  }
  for (const state of children) {
    state.eofRequested = true;
    state.child.stdin.end();
  }
  await wait(() => children.every(s => s.isClosed));
  for (const state of children) {
    const files = await readdir(join(root, state.task), { recursive: true });
    assert.ok(!files.some(f => f.endsWith(".jsonl")), "Unexpected persisted session");
  }
  console.log(JSON.stringify({ phase: "orderly-eof-exits", codes: children.map(s => s.child.exitCode) }));
} catch (error) {
  console.error(String(controller.signal.reason ?? error).slice(0, 4096));
  for (const state of children) if (state.stderr) console.error(`${state.task} stderr: ${state.stderr.slice(0, 2048)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  // Always reap before deleting owned resources; forced shutdown never counts as probe success.
  await Promise.all(children.map(async state => {
    if (state.isClosed) return;
    state.child.stdin.destroy();
    state.child.kill("SIGTERM");
    const force = setTimeout(() => state.child.kill("SIGKILL"), 1000);
    try { await state.closed; } finally { clearTimeout(force); }
  }));
  await rm(root, { recursive: true, force: true });
}
