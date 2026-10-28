/**
 * Exploratory production-runner probe, not TDD business-logic evidence.
 * npm run test:background-runtime -- /explicit/pi/dist/cli.js (or PI_BACKGROUND_PROBE_CLI).
 * Only Pi 1.4.0 is admitted. This does not certify minimum 1.0 or Plan integration.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runBackgroundGuildRoleForTest } from "../src/background-runner.ts";
import { ASK_TOOL, SUBMIT_TOOL, validateTask, type GuildTask } from "../src/protocol.ts";
import type { GuildRoleRunResult } from "../src/runner.ts";

const argument = process.argv[2] ?? process.env.PI_BACKGROUND_PROBE_CLI;
assert.ok(argument, "Supply installed CLI path or PI_BACKGROUND_PROBE_CLI; no fallback runtime");
assert.ok(process.argv.length <= 3, "Expected one CLI path");
const cli = await realpath(resolve(argument));
const manifest = JSON.parse(await readFile(join(dirname(cli), "..", "package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
assert.equal(manifest.version, "1.4.0", "Exploratory probe requires exactly Pi 1.4.0");
assert.equal(cli, await realpath(join(dirname(cli), "cli.js")));
const fixture = fileURLToPath(new URL("../test/fixtures/background-runner-probe-extension.ts", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "guild-background-probe-"));
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error("Total probe deadline: 30s")), 30_000);
const interrupt = () => controller.abort(new Error("Probe interrupted"));
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
type State = { key: string; home: string; child?: ChildProcess; task?: GuildTask; promptDir?: string;
  closed: boolean; question?: string; reply?: (answer: string | undefined) => void;
  result?: GuildRoleRunResult; job?: Promise<GuildRoleRunResult>; events: Record<string, any>[];
  wire: string; stderr: string };
const states: State[] = [];
const wait = async (predicate: () => boolean) => {
  while (!predicate()) {
    const failed = states.find(s => s.result && s.result.status !== "completed");
    assert.ok(!failed, `${failed?.key}: ${failed?.result?.errorMessage}`);
    await delay(10, undefined, { signal: controller.signal });
  }
  controller.signal.throwIfAborted();
};
try {
  for (const [index, role] of (["coder", "reviewer", "coder"] as const).entries()) {
    const key = `task-${index}`;
    const home = join(root, key), config = join(home, "config"), cwd = join(home, "cwd");
    await mkdir(config, { recursive: true, mode: 0o700 });
    await mkdir(cwd, { mode: 0o700 });
    await writeFile(join(config, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }), { mode: 0o600 });
    const state: State = { key, home, closed: false, events: [], wire: "", stderr: "" };
    states.push(state);
    // The runner owns transport and shutdown. This seam only selects the runtime,
    // removes inherited credentials/configuration, and observes the actual child.
    const spawnProbe = ((command: string, args: string[], options: any) => {
      assert.ok(!state.child, "Unexpected replacement process");
      const taskFile = options.env.GUILD_TASK_FILE;
      state.task = validateTask(JSON.parse(readFileSync(taskFile, "utf8")));
      state.promptDir = dirname(taskFile);
      const child = spawn(command, args, { ...options, env: {
        HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, PI_CODING_AGENT_DIR: config,
        PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
        GUILD_TASK_FILE: taskFile, BACKGROUND_PROBE_TASK: key,
      } });
      state.child = child;
      child.on("close", () => { state.closed = true; });
      // Bounded raw tail remains available even if production rejects an event before onEvent.
      child.stdout?.on("data", (chunk: Buffer) => { state.wire = (state.wire + chunk.toString()).slice(-16384); });
      child.stderr?.on("data", (chunk: Buffer) => { state.stderr = (state.stderr + chunk.toString()).slice(-4096); });
      return child;
    }) as typeof spawn;
    state.job = runBackgroundGuildRoleForTest({ role, profile: "typescript", task: key,
      practices: [], cwd, projectTrusted: false, model: "background-runtime-probe/scripted", thinkingLevel: "off",
      signal: controller.signal,
      onQuestion: question => {
        assert.equal(state.question, undefined, "Duplicate question");
        state.question = question;
        return new Promise(resolve => { state.reply = resolve; });
      },
      onEvent: event => { if (state.events.length < 256) state.events.push(event); },
    }, { spawn: spawnProbe, invocation: args => ({ command: process.execPath,
      args: [cli, ...args, "--offline", "--no-themes", "--no-mcp", "--extension", fixture] })
    }).then(result => { state.result = result; return result; });
  }
  await wait(() => states.every(s => s.reply));
  assert.equal(new Set(states.map(s => s.child?.pid)).size, 3);
  for (const s of states) {
    assert.ok(s.child?.pid);
    assert.equal(s.closed, false);
    process.kill(s.child.pid, 0);
    assert.deepEqual(JSON.parse(s.question!), { key: s.key, pid: s.child.pid, runId: s.task!.runId, taskId: s.task!.taskId });
    assert.ok(!s.result);
  }
  console.log(JSON.stringify({ phase: "three-alive-waiting", version: manifest.version,
    children: states.map(s => ({ key: s.key, pid: s.child!.pid, taskId: s.task!.taskId })) }));
  for (const index of [2, 0, 1]) {
    const s = states[index];
    s.reply!(`answer-for-${s.key}`);
    await wait(() => !!s.result);
    const result = s.result!;
    assert.equal(result.status, "completed", result.errorMessage);
    assert.equal(result.exitCode, 0);
    assert.equal(s.closed, true);
    assert.equal(s.child!.exitCode, 0);
    assert.equal(s.child!.signalCode, null);
    assert.equal(result.runId, s.task!.runId);
    assert.equal(result.taskId, s.task!.taskId);
    assert.equal(result.report?.taskOutcome, "succeeded");
    assert.deepEqual(JSON.parse(result.report!.summary), { key: s.key, pid: s.child!.pid,
      runId: s.task!.runId, taskId: s.task!.taskId, requests: 2, answer: `answer-for-${s.key}` });
    assert.deepEqual(s.events.filter(e => e.type === "tool_execution_start").map(e => e.toolName), [ASK_TOOL, SUBMIT_TOOL]);
    assert.equal(result.usage.turns, 2);
    console.log(JSON.stringify({ phase: "original-child-completed", key: s.key, pid: s.child!.pid, taskId: result.taskId, exitCode: result.exitCode }));
  }
} catch (error) {
  console.error(String(controller.signal.reason ?? error));
  process.exitCode = 1;
} finally {
  controller.abort();
  for (const s of states) s.reply?.(undefined);
  // Never manufacture exit evidence or release directories while a runner owns a child.
  await Promise.allSettled(states.flatMap(s => s.job ? [s.job] : []));
  clearTimeout(deadline);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  try {
    for (const s of states) {
      if (s.child) assert.equal(s.closed, true, "Runner returned before child close");
      if (s.promptDir) await assert.rejects(stat(s.promptDir), { code: "ENOENT" });
      assert.ok(!(await readdir(s.home, { recursive: true })).some(f => f.endsWith(".jsonl")), "Persisted child session");
      if (process.exitCode) console.error(JSON.stringify({ key: s.key, pid: s.child?.pid,
        status: s.result?.status, diagnostic: s.result?.errorMessage, stderr: s.stderr, wireTail: s.wire }));
    }
    console.log(JSON.stringify({ phase: "joined-and-cleaned", promptDirectoriesRemoved: true, persistedSessions: false }));
  } catch (error) { console.error(error); process.exitCode = 1; }
  await rm(root, { recursive: true, force: true });
}
