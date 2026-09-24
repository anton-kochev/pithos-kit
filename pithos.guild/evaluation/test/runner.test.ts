import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile, truncate, stat, chmod } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadDevelopmentBank, referenceFixes } from "../src/bank.ts";
import { digest } from "../src/manifest.ts";
import { deriveTrialReceipt } from "../src/trial-receipt.ts";
import { createSchedule, runTrial, type Driver } from "../src/runner.ts";

const message = JSON.stringify({ type: "message_end", message: { role: "assistant", model: "fake", provider: "test", stopReason: "stop", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, content: [{ type: "text", text: "Node.js 24; npm test (README.md)." }] } }) + '\n{"type":"agent_end"}\n';
const request = { task: loadDevelopmentBank().tasks[0], arm: "main-only" as const, repetition: 1, cohort: { model: "test/fake", thinking: "off" }, timeoutMs: 1000 };

test("schedules both arms adjacently per task/repetition with reproducible randomized order", () => {
  const bank = loadDevelopmentBank();
  const schedule = createSchedule(bank, 3, "seed");
  assert.deepEqual(schedule, createSchedule(bank, 3, "seed"));
  assert.notDeepEqual(schedule, createSchedule(bank, 3, "other"));
  assert.equal(schedule.length, bank.tasks.length * 3 * 2);
  for (let i = 0; i < schedule.length; i += 2) {
    assert.equal(schedule[i].taskId, schedule[i + 1].taskId);
    assert.equal(schedule[i].repetition, schedule[i + 1].repetition);
    assert.deepEqual(new Set([schedule[i].arm, schedule[i + 1].arm]), new Set(["main-only", "guild-available"]));
  }
  assert.throws(() => createSchedule(bank, 0, "seed"));
});

test("retains the driver's supervisor observation in the result for receipt binding", async () => {
  const storage = await mkdtemp(join(tmpdir(), "guild-runner-supervisor-test-"));
  try {
    let trusted: any;
    const result = await runTrial(storage, request, async context => {
      context.emit(message);
      trusted = { version: 1, kind: "guild-eval-supervisor-spawn", trialIdentity: context.trialIdentity,
        invocationDigest: digest("invocation"), configurationSha256: null, supervisorPid: 6, parentPid: 24 };
      return { exitCode: 0, supervisor: trusted };
    });
    assert.deepEqual(result.supervisor, trusted);
    assert.deepEqual(JSON.parse(await readFile(join(storage, result.id, "result.json"), "utf8")).supervisor, trusted);
  } finally { await rm(storage, { recursive: true, force: true }); }
});

for (const change of [
  (value: any) => value.trialIdentity.id = "00000000-0000-4000-8000-000000000001",
  (value: any) => value.parentPid = value.supervisorPid,
  (value: any) => value.invocationDigest = "invalid",
  (value: any) => value.extra = "private-unbound-field",
]) test("rejects malformed driver supervisor observations instead of retaining them", async () => {
  const storage = await mkdtemp(join(tmpdir(), "guild-runner-supervisor-rejection-"));
  try {
    const result = await runTrial(storage, request, async context => {
      context.emit(message);
      const supervisor: any = { version: 1, kind: "guild-eval-supervisor-spawn", trialIdentity: structuredClone(context.trialIdentity),
        invocationDigest: digest("invocation"), configurationSha256: null, supervisorPid: 6, parentPid: 24 };
      change(supervisor); return { exitCode: 0, supervisor };
    });
    assert.equal(result.status, "driver_error"); assert.equal(result.supervisor, null);
    assert.doesNotMatch(JSON.stringify(result), /private-unbound-field/);
  } finally { await rm(storage, { recursive: true, force: true }); }
});

test("uses a reserved campaign UUID without reusing artifacts or accepting unsafe IDs", async () => {
  const storage = await mkdtemp(join(tmpdir(), "guild-reserved-trial-test-"));
  try {
    const id = "00000000-0000-4000-8000-000000000001";
    let calls = 0;
    const driver: Driver = async ({ emit }) => { calls++; emit(message); return { exitCode: 0 }; };
    const result = await runTrial(storage, request, driver, undefined, { id });
    assert.equal(result.id, id);
    await assert.rejects(runTrial(storage, request, driver, undefined, { id }), /exist/i);
    await assert.rejects(runTrial(storage, request, driver, undefined, { id: "../unsafe" }), /Invalid trial ID/);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(await readFile(join(storage, id, "result.json"), "utf8")).id, id);
  } finally { await rm(storage, { recursive: true, force: true }); }
});

test("delivers the reserved trial identity and original request digest to the driver", async () => {
  const storage = await mkdtemp(join(tmpdir(), "guild-driver-identity-test-"));
  try {
    const id = "00000000-0000-4000-8000-000000000002";
    let identity: unknown, frozen = false;
    const result = await runTrial(storage, request, async context => {
      identity = context.trialIdentity; frozen = Object.isFrozen(context.trialIdentity);
      context.emit(message); return { exitCode: 0 };
    }, undefined, { id });
    assert.deepEqual(identity, { version: 1, id, requestDigest: digest(request) });
    assert.equal(frozen, true);
    assert.equal(result.requestDigest, digest(request));
    assert.equal(result.status, "recorded");
  } finally { await rm(storage, { recursive: true, force: true }); }
});

test("driver request mutation cannot rewrite the retained request, grading task or result identity", async () => {
  const storage = await mkdtemp(join(tmpdir(), "guild-driver-mutation-test-"));
  try {
    const original = structuredClone(request);
    const result = await runTrial(storage, request, async context => {
      context.request.task.id = "changed-task";
      context.request.task.allowedChanges.push("unexpected.txt");
      context.request.cohort.model = "test/changed";
      context.request.timeoutMs++;
      context.emit(message); return { exitCode: 0 };
    });
    assert.equal(result.requestDigest, digest(original));
    assert.equal(result.taskId, original.task.id);
    assert.equal(result.status, "recorded");
    assert.equal(result.grade?.behavior, true);
    assert.deepEqual(JSON.parse(await readFile(join(storage, result.id, "task-manifest.json"), "utf8")), original.task);
    assert.deepEqual(request, original);
  } finally { await rm(storage, { recursive: true, force: true }); }
});

test("an external workflow deadline stops work but does not cancel separately bounded grading", async () => {
  const storage = await mkdtemp(join(tmpdir(), "guild-workflow-deadline-test-"));
  try {
    const deadline = new AbortController();
    const result = await runTrial(storage, request, async ({ emit, signal }) => {
      emit(message); deadline.abort(); assert.equal(signal.aborted, true); return { exitCode: 0 };
    }, undefined, { workflowSignal: deadline.signal });
    assert.equal(result.status, "timeout");
    assert.equal(result.grade?.behavior, true);
  } finally { await rm(storage, { recursive: true, force: true }); }
});

test("active-budget expiry remains visible when a workflow interruption happened first", async () => {
  const storage = await mkdtemp(join(tmpdir(), "guild-deadline-race-test-"));
  try {
    const workflow = new AbortController(), active = new AbortController();
    const result = await runTrial(storage, request, async ({ emit }) => {
      emit(message); workflow.abort(); active.abort(); return { exitCode: 0 };
    }, undefined, { workflowSignal: workflow.signal, activeSignal: active.signal });
    assert.equal(result.status, "campaign_timeout");
    assert.equal(result.interruption, "timeout");
    assert.equal(result.campaignDeadlineExceeded, true);
  } finally { await rm(storage, { recursive: true, force: true }); }
});

test("a workflow deadline expiring during grading does not relabel already-completed work", async () => {
  const storage = await mkdtemp(join(tmpdir(), "guild-post-workflow-test-"));
  try {
    const workflow = new AbortController(), ready = join(storage, "ready");
    const task = loadDevelopmentBank().tasks.find(t => t.grader === "authorization")!;
    const pending = runTrial(storage, { ...request, task }, async ({ cwd, emit }) => {
      await writeFile(join(cwd, "src/users.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(ready)}, 'ready'); await new Promise(r => setTimeout(r, 200));\n${referenceFixes[0]}`);
      emit(message); return { exitCode: 0 };
    }, undefined, { workflowSignal: workflow.signal });
    for (let i = 0; i < 200; i++) {
      if (await access(ready).then(() => true, () => false)) break;
      await delay(10);
    }
    await access(ready); workflow.abort();
    const result = await pending;
    assert.equal(result.status, "recorded");
    assert.equal(result.grade?.behavior, true);
  } finally { await rm(storage, { recursive: true, force: true }); }
});

test("an active campaign deadline cancels grading and retains the interrupted result", async () => {
  const storage = await mkdtemp(join(tmpdir(), "guild-active-deadline-test-"));
  const deadline = new AbortController();
  try {
    const ready = join(storage, "checker-ready");
    const task = loadDevelopmentBank().tasks.find(t => t.grader === "authorization")!;
    const pending = runTrial(storage, { ...request, task, timeoutMs: 3000 }, async ({ cwd, emit }) => {
      await writeFile(join(cwd, "src/users.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(ready)}, 'ready'); await new Promise(() => {setInterval(() => {}, 1000)});`);
      emit(message); return { exitCode: 0 };
    }, undefined, { activeSignal: deadline.signal });
    try {
      for (let i = 0; i < 300; i++) {
        if (await access(ready).then(() => true, () => false)) break;
        await delay(10);
      }
      await access(ready);
    } finally { deadline.abort(); }
    const result = await pending;
    assert.equal(result.status, "campaign_timeout");
    assert.equal(result.grade?.behavior, false);
    assert.equal(result.grade?.checkCancelled, true);
    assert.equal(result.grade?.checkerMutated, null, "post-check preservation is not certified after cancellation");
    assert.equal(JSON.parse(await readFile(join(storage, result.id, "result.json"), "utf8")).status, "campaign_timeout");
  } finally { deadline.abort(); await rm(storage, { recursive: true, force: true }); }
});

test("defaults to no execution and retains unique raw evidence and final states for injected offline trials", async () => {
  const storage = await mkdtemp(join(tmpdir(), "guild-trial-test-"));
  try {
    await assert.rejects(runTrial(storage, request), /driver must be explicitly supplied/);
    assert.deepEqual(await readdir(storage), []);
    const fake: Driver = async ({ emit }) => { emit(message); return { exitCode: 0 }; };
    const one = await runTrial(storage, request, fake);
    const two = await runTrial(storage, request, fake);
    assert.notEqual(one.id, two.id);
    assert.equal(one.status, "recorded");
    assert.equal(one.grade?.taskSuccess, null);
    assert.equal(one.trace?.complete, true);
    assert.equal(await readFile(join(storage, one.id, "parent.jsonl"), "utf8"), message);
    assert.equal(JSON.parse(await readFile(join(storage, one.id, "result.json"), "utf8")).id, one.id);
    const publicRequest = JSON.parse(await readFile(join(storage, one.id, "request.json"), "utf8"));
    assert.equal(publicRequest.request.task.rubric, undefined, "do not expose grader answers during execution");
  } finally { await rm(storage, { recursive: true, force: true }); }
});

test("retains an oversized child artifact without reading or certifying it", async () => {
  const storage = await mkdtemp(join(tmpdir(), "guild-child-size-test-"));
  try {
    const result = await runTrial(storage, request, async ({ emit, artifactDirectory }) => {
      const file = join(artifactDirectory, "children.jsonl");
      await writeFile(file, ""); await truncate(file, 17 * 1024 * 1024);
      emit(message); return { exitCode: 0 };
    });
    assert.equal(result.status, "observation_error");
    assert.equal(result.childTraceDigest, null);
    assert.equal(result.trace.totalObserved.cost, null);
    assert.equal((await stat(join(storage, result.id, "children.jsonl"))).size, 17 * 1024 * 1024);
  } finally { await rm(storage, { recursive: true, force: true }); }
});

test("reads retained child evidence even when the driver throws after writing it", async () => {
  const storage = await mkdtemp(join(tmpdir(), "guild-child-throw-test-"));
  try {
    const records = [
      { version: 1, type: "observer_ready" },
      { version: 1, type: "start", childId: "child-1", runId: "call-1", role: "coder", profile: "general", sequence: 0 },
      { version: 1, type: "stdout", childId: "child-1", runId: "call-1", role: "coder", profile: "general", sequence: 1, base64: Buffer.from(message).toString("base64") },
    ].map(event => JSON.stringify(event)).join("\n") + "\n";
    const result = await runTrial(storage, request, async ({ artifactDirectory }) => {
      await writeFile(join(artifactDirectory, "children.jsonl"), records);
      throw new Error("Driver failed after partial capture");
    });
    assert.equal(result.status, "driver_error");
    assert.equal(result.trace.childObserved.input, 1);
    assert.equal(result.trace.totalObserved.cost, null);
    assert.match(result.childTraceDigest!, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(join(storage, result.id, "children.jsonl"), "utf8"), records);
    assert.equal(result.grade?.scope, true);
  } finally { await rm(storage, { recursive: true, force: true }); }
});

test("preserves partial trace on provider throw and distinguishes cancellation from completion", async () => {
  const storage = await mkdtemp(join(tmpdir(), "guild-failure-test-"));
  try {
    const result = await runTrial(storage, request, async ({ emit }) => { emit('{"type":"agent_start"}\n'); throw new Error("provider unavailable"); });
    assert.equal(result.status, "driver_error");
    assert.equal(result.trace?.complete, false);
    assert.match(result.error!, /provider unavailable/);
    assert.equal(result.grade?.scope, true, "capture final state even when the driver throws");
    assert.match(await readFile(join(storage, result.id, "parent.jsonl"), "utf8"), /agent_start/);
    const slow: Driver = async ({ signal }) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { exitCode: 0 };
    };
    const timeout = await runTrial(storage, { ...request, timeoutMs: 10 }, slow);
    assert.equal(timeout.status, "timeout");
    assert.ok(timeout.grade === undefined || timeout.grade.taskSuccess === null, "setup cancellation may leave grading unavailable; never invent a task score");
  } finally { await rm(storage, { recursive: true, force: true }); }
});

for (const failure of [false, true]) test(`confined finalization never uses local grading after producer ${failure ? 'failure' : 'completion'}`, async () => {
  const storage = await mkdtemp(join(tmpdir(), 'guild-confined-finalization-'));
  try {
    const result = await runTrial(storage, request, async ({ cwd, emit, artifactDirectory }) => {
      await writeFile(join(artifactDirectory, 'children.jsonl'), '{"version":1,"type":"observer_ready"}\n', { mode: 0o600 });
      // Invalid inert Git config is a tripwire: no command or candidate module.
      await writeFile(join(cwd, '.git/config'), 'invalid inert config [');
      await writeFile(join(cwd, '.git/index'), 'inert original retained index bytes');
      await chmod(join(cwd, '.git/index'), 0o640);
      emit(message);
      if (failure) throw new Error('inert producer failure');
      return { exitCode: 0 };
    }, undefined, { finalization: 'confined-required' });
    assert.equal(result.status, failure ? 'driver_error' : 'finalization_pending');
    assert.equal(result.grade, undefined);
    assert.equal(await readFile(join(storage, result.id, 'repo/.git/index'), 'utf8'), 'inert original retained index bytes');
    assert.equal((await stat(join(storage, result.id, 'repo/.git/index'))).mode & 0o777, 0o640);
    assert.deepEqual(result.finalization, { version: 1, state: 'pending', reason: 'confined-snapshot-evidence-required' });
    assert.equal(await access(join(storage, result.id, 'task-manifest.json')).then(() => true, () => false), false);
    const retained = JSON.parse(await readFile(join(storage, result.id, 'result.json'), 'utf8'));
    assert.deepEqual(retained.finalization, result.finalization);
    assert.doesNotMatch(result.error ?? '', /git|config/);
    await assert.rejects(deriveTrialReceipt(join(storage, result.id), request, result), /Confined final snapshot evidence is required/);
  } finally { await rm(storage, { recursive: true, force: true }); }
});
