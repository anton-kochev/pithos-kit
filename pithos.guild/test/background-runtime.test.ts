import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createGuildBackgroundRuntime } from "../src/background-runtime.ts";
import { runBackgroundGuildRoleForTest } from "../src/background-runner.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { createPlanCoordinator } from "../../pithos.plan/extensions/plan-coordination.ts";
import type { RunBackgroundGuildRoleOptions } from "../src/background-runner.ts";
import { readFileSync } from "node:fs";
import { BackgroundRunRegistry } from "../src/background-runs.ts";
import { GuildExecutionAuthority } from "../src/execution-authority.ts";
import { createGuildBackgroundAdmission } from "../src/background-admission.ts";
import { dirname } from "node:path";

const fixture = fileURLToPath(new URL("./fixtures/background-child.mjs", import.meta.url));
const seam = { invocation: (args: string[]) => ({ command: process.execPath, args: [fixture, ...args] }), limits: { command: 2000, handshake: 3000, run: 8000, question: 4000, eof: 1000, term: 500, kill: 1000 } };
const input = { role: "coder", profile: "typescript", task: "Work", practices: [{ id: "tdd", policy: "required" }] };
const context = () => ({ cwd: process.cwd(), projectTrusted: false, getBranch: () => [] });
const standalone = { PITHOS_GUILD_PLAN_MODE: "standalone" };
const silent = { emit() {} };

test("internal facade runs a real child and retains a host-bound blocked report after cleanup", { timeout: 12000 }, async () => {
 let taskFile = "";
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: options => runBackgroundGuildRoleForTest(options, seam) });
 const owner = runtime.activate();
 try {
  const run = runtime.start(owner, input, { ...context(), onEvent(event) { if (event.type === "fixture") taskFile = event.taskFile as string; } });
  assert.equal((await runtime.wait(owner, run.id, 10000)).reason, "terminal");
  const done = runtime.collect(owner, run.id).snapshot;
  assert.equal(done.status, "completed", done.error);
  const dto = done.result as any;
  assert.equal(dto.runId, run.id);
  assert.equal(dto.report.taskId, dto.taskId);
  assert.equal(dto.report.taskOutcome, "blocked");
  assert.equal(dto.report.compliance[0].status, "blocked");
  for (const key of ["task", "output", "events", "stderr"]) assert.equal(key in dto, false);
  assert.ok(taskFile);
  assert.equal(existsSync(taskFile), false);
  assert.equal(existsSync(dirname(taskFile)), false);
  runtime.release(owner, run.id);
 } finally { await runtime.shutdown(); }
});

for (const activatePlan of [false, true]) test(`receiver-dependent branch reader ${activatePlan ? "vetoes changed persistence" : "admits inactive work"}`, async () => {
 let reads = 0, launches = 0;
 const ctx = {
  ...context(),
  branch: [] as unknown[],
  getBranch() { reads++; return this.branch; },
 };
 const runtime = createGuildBackgroundRuntime({
  bus: { emit() {
   if (activatePlan) ctx.branch = [{ type: "custom", customType: "plan-theme-state", data: { active: true } }];
   ctx.getBranch = () => assert.fail("must use the captured reader for both checks");
  } },
  parentEnvironment: standalone,
  runner: options => { launches++; return runBackgroundGuildRoleForTest(options, seam); },
 });
 const owner = runtime.activate();
 try {
  if (activatePlan) {
   assert.throws(() => runtime.start(owner, input, ctx), /Persisted Plan state is not inactive/);
   assert.equal(launches, 0);
   assert.deepEqual(runtime.list(owner), []);
  } else {
   const run = runtime.start(owner, input, ctx);
   assert.equal((await runtime.wait(owner, run.id, 5000)).reason, "terminal");
   assert.equal(runtime.status(owner, run.id).status, "completed");
   assert.equal(launches, 1);
  }
  assert.equal(reads, activatePlan ? 2 : 6, "admission and launch use the captured reader and live branch");
 } finally { await runtime.shutdown(); }
});

test("context getters cannot reenter admission and malformed captures never reserve", async () => {
 let launches = 0, discoveries = 0;
 const runtime = createGuildBackgroundRuntime({ bus: { emit() { discoveries++; } }, parentEnvironment: standalone, runner: options => { launches++; return runBackgroundGuildRoleForTest(options, seam); } });
 const owner = runtime.activate();
 try {
  assert.throws(() => runtime.start(owner, input, { ...context(), get cwd() {
   assert.throws(() => runtime.start(owner, input, context()), /reentrant/i);
   return process.cwd();
  } }), /reentrant/i);
  for (const patch of [{ cwd: undefined }, { cwd: "" }, { model: {} }, { thinkingLevel: 1 }, { projectTrusted: "yes" }, { onEvent: true }, { onUpdate: {} }, { getBranch: undefined }]) {
   assert.throws(() => runtime.start(owner, input, { ...context(), ...patch } as any));
  }
  assert.equal(launches, 0);
  assert.equal(discoveries, 0);
  assert.deepEqual(runtime.list(owner), []);
 } finally { await runtime.shutdown(); }
});

function deferred<T = void>() {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>(yes => { resolve = yes; });
 return { promise, resolve };
}

test("retirement joins a gated real child close and adapter cleanup before replacement", { timeout: 12000 }, async () => {
 const stopped = deferred<string>(), closed = deferred<string>(), cleanup = deferred(), release = deferred();
 let child: ChildProcess | undefined, taskFile = "", retained: RunBackgroundGuildRoleOptions | undefined;
 let events = 0, updates = 0, launches = 0;
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async options => {
  launches++;
  retained = options;
  const result = await runBackgroundGuildRoleForTest(options, { ...seam, limits: { ...seam.limits, term: 5000 }, spawn: ((...args: Parameters<typeof spawn>) => {
   child = spawn(...args);
   child.stdout!.on("data", chunk => { if (String(chunk).includes('fixture-stopping')) stopped.resolve("stopping"); });
   child.once("close", () => closed.resolve("closed"));
   return child;
  }) as typeof spawn });
  cleanup.resolve();
  await release.promise;
  return result;
 } });
 const owner = runtime.activate();
 let retirement: Promise<void> | undefined;
 try {
  const run = runtime.start(owner, { ...input, task: "question-gated" }, { ...context(), onEvent(event) { events++; if (event.type === "fixture") taskFile = event.taskFile as string; }, onUpdate() { updates++; } });
  assert.equal((await runtime.wait(owner, run.id, 5000)).reason, "question");
  const cancel = runtime.cancel(owner, run.id);
  assert.equal(runtime.planParticipant.tryAcquire({}).kind, "busy");
  assert.equal(runtime.status(owner, run.id).question, undefined);
  assert.throws(() => runtime.collect(owner, run.id), /not terminal/);
  assert.equal(await Promise.race([stopped.promise, closed.promise]), "stopping", "child must acknowledge SIGTERM without closing");
  assert.ok(existsSync(taskFile));
  let joined = false;
  void cancel.then(() => { joined = true; });
  retirement = runtime.retire(owner);
  assert.equal(runtime.isCurrent(owner), false);
  assert.throws(() => runtime.activate(), /retiring/);
  assert.equal(runtime.planParticipant.tryAcquire({}).kind, "unavailable");
  const before = [events, updates];
  retained!.onEvent!({ type: "late" });
  retained!.onUpdate!({} as any);
  await assert.rejects(retained!.onQuestion("late", new AbortController().signal), /Stale/);
  assert.deepEqual([events, updates], before);
  assert.equal(joined, false);
  child!.kill("SIGUSR2");
  await closed.promise;
  await cleanup.promise;
  assert.equal(existsSync(taskFile), false);
  assert.equal(existsSync(dirname(taskFile)), false);
  assert.equal(joined, false, "actual close does not replace adapter cleanup join");
  assert.throws(() => runtime.activate(), /retiring/);
  release.resolve();
  await cancel;
  await retirement;
  assert.equal(joined, true);
  const next = runtime.activate();
  retained!.onEvent!({ type: "late" });
  retained!.onUpdate!({} as any);
  await assert.rejects(retained!.onQuestion("late", new AbortController().signal), /Stale/);
  assert.deepEqual([events, updates], before);
  assert.ok(runtime.isCurrent(next));
  assert.equal(launches, 1);
 } finally {
  child?.kill("SIGUSR2"); release.resolve(); await retirement; await runtime.shutdown();
 }
});

test("three asking children retain their PIDs and a queued fourth keeps its admitted envelope and context", { timeout: 12000 }, async () => {
 const captures: any[] = [], optionsSeen: RunBackgroundGuildRoleOptions[] = [];
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: options => {
  optionsSeen.push(options);
  return runBackgroundGuildRoleForTest(options, seam);
 } });
 const owner = runtime.activate();
 const observe = (event: any) => { if (event.type === "fixture") captures.push({ ...event, envelope: JSON.parse(readFileSync(event.taskFile, "utf8")) }); };
 try {
  const runs = Array.from({ length: 3 }, () => runtime.start(owner, { ...input, task: "question" }, { ...context(), onEvent: observe }));
  // wait wakes on any question, so use event-loop turns rather than blocking its other children.
  const deadline = Date.now() + 5000;
  while (!runs.every(run => runtime.status(owner, run.id).question)) {
   assert.ok(Date.now() < deadline, "all three children must ask");
   await new Promise(resolve => setImmediate(resolve));
  }
  const raw = { ...input, task: "Work", practices: [{ id: "tdd", policy: "required" }] };
  const ctx = { ...context(), model: "original/model", thinkingLevel: "high", onEvent: observe };
  const fourth = runtime.start(owner, raw, ctx);
  assert.equal(fourth.status, "queued");
  raw.task = "mutated"; raw.practices.length = 0;
  ctx.cwd = "/nonexistent"; ctx.model = "mutated/model"; ctx.thinkingLevel = "low"; ctx.projectTrusted = true;
  ctx.onEvent = () => assert.fail("mutated observer");
  assert.equal(optionsSeen.length, 3);
  const pending = runs.map(run => runtime.status(owner, run.id).question!);
  assert.equal(new Set(pending.map(q => q.text)).size, 3);
  assert.throws(() => runtime.reply(owner, runs[0].id, pending[1].id, "wrong"), /Unknown/);
  for (const i of [2, 0, 1]) {
   runtime.reply(owner, runs[i].id, pending[i].id, `Answer for ${pending[i].text.split(" ").at(-1)}`);
   assert.throws(() => runtime.reply(owner, runs[i].id, pending[i].id, "duplicate"), /Unknown/);
  }
  for (const run of [...runs, fourth]) {
   assert.equal((await runtime.wait(owner, run.id, 5000)).reason, "terminal");
   assert.equal(runtime.status(owner, run.id).status, "completed", runtime.status(owner, run.id).error);
  }
  const results = runs.map(run => runtime.status(owner, run.id).result as any);
  results.forEach((result, i) => assert.equal(result.report.summary, `Replied in ${pending[i].text.split(" ").at(-1)}`));
  assert.equal(new Set([...results.map(result => result.taskId), (runtime.status(owner, fourth.id).result as any).taskId]).size, 4);
  const queued = captures.find(c => c.envelope.runId === fourth.id);
  assert.equal(queued.envelope.task, "Work");
  assert.deepEqual(queued.envelope.practices, [{ id: "tdd", policy: "required" }]);
  assert.equal(optionsSeen[3].cwd, process.cwd());
  assert.equal(queued.args[queued.args.indexOf("--model") + 1], "original/model");
  assert.equal(queued.args[queued.args.indexOf("--thinking") + 1], "high");
  assert.ok(queued.args.includes("--no-approve"));
  for (const capture of captures) assert.equal(existsSync(dirname(capture.taskFile)), false);
  // Terminal callbacks are fenced even before generation invalidation.
  for (const options of optionsSeen) {
   options.onEvent!({ type: "fixture", taskFile: "/should-not-read" });
   await assert.rejects(options.onQuestion("late", new AbortController().signal), /Stale/);
  }
  await runtime.retire(owner);
  const next = runtime.activate();
  assert.throws(() => runtime.reply(owner, runs[0].id, pending[0].id, "old"), /stale/);
  assert.throws(() => runtime.reply(next, runs[0].id, pending[0].id, "old"), /Unknown/);
 } finally { await runtime.shutdown(); }
});

test("policy, persistence, holds, stale owners and discovery reentry veto before any child launch", async () => {
 for (const scenario of ["missing", "invalid", "persistence", "hold", "stale", "reentry", "final-reentry", "drift", "standalone-conflict", "required", "captured-standalone"]) {
  let launches = 0;
  const coordinator = createPlanCoordinator();
  coordinator.confirmInactive(coordinator.provider.inspect().generation);
  let runtime: ReturnType<typeof createGuildBackgroundRuntime>;
  let owner: ReturnType<typeof runtime.activate>;
  let inspections = 0;
  const nested = () => assert.throws(() => runtime.start(owner, input, context()), /Reentrant/);
  const provider = { ...coordinator.provider, inspect() { inspections++; if (scenario === "final-reentry" && inspections === 3) nested(); return coordinator.provider.inspect(); } };
  const env: { PITHOS_GUILD_PLAN_MODE?: string } = scenario === "invalid" ? { PITHOS_GUILD_PLAN_MODE: " Required" } : ["captured-standalone", "standalone-conflict", "reentry"].includes(scenario) ? { ...standalone } : {};
  runtime = createGuildBackgroundRuntime({ bus: { emit(_channel, request) {
   if (scenario === "reentry") nested();
   if (!["missing", "invalid", "captured-standalone", "reentry"].includes(scenario)) request.reply(provider);
  } }, parentEnvironment: env, runner: options => { launches++; return runBackgroundGuildRoleForTest(options, seam); } });
  owner = runtime.activate();
  env.PITHOS_GUILD_PLAN_MODE = "invalid-after-construction";
  try {
   if (scenario === "hold") runtime.planParticipant.tryAcquire({});
   if (scenario === "stale") await runtime.retire(owner);
   let reads = 0;
   const ctx = { ...context(), getBranch() {
    if (++reads === 2 && scenario === "drift") coordinator.confirmInactive(coordinator.provider.inspect().generation);
    return scenario === "persistence" ? [{ type: "custom", customType: "plan-theme-state", data: { active: true } }] : [];
   } };
   if (["required", "captured-standalone"].includes(scenario)) {
    const run = runtime.start(owner, input, ctx);
    assert.equal((await runtime.wait(owner, run.id, 5000)).reason, "terminal");
    assert.equal(runtime.status(owner, run.id).status, "completed");
    assert.equal(launches, 1);
   } else {
    assert.throws(() => runtime.start(owner, input, ctx), Error, scenario);
    assert.equal(launches, 0, scenario);
    if (runtime.isCurrent(owner)) assert.deepEqual(runtime.list(owner), []);
   }
  } finally { await runtime.shutdown(); }
 }
});

for (const corruption of ["identity", "missing", "compliance"] as const) test(`projection rejects ${corruption} after real runner cleanup`, async () => {
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async options => {
  const result = await runBackgroundGuildRoleForTest(options, seam);
  if (corruption === "identity") result.taskId = "forged";
  if (corruption === "missing") result.report = undefined;
  if (corruption === "compliance") result.report!.compliance = [];
  return result;
 } });
 const owner = runtime.activate();
 try {
  const run = runtime.start(owner, input, context());
  await runtime.wait(owner, run.id, 5000);
  assert.equal(runtime.status(owner, run.id).status, "failed");
  assert.equal(runtime.status(owner, run.id).result, undefined);
  assert.match(runtime.status(owner, run.id).error!, /identity|report|schema/);
 } finally { await runtime.shutdown(); }
});

for (const action of ["expiry", "cancel"] as const) test(`pending question ${action} retains failure/cancellation distinction`, async () => {
 const expired = deferred();
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: options => runBackgroundGuildRoleForTest({ ...options,
  onQuestion(text, signal) { signal.addEventListener("abort", () => expired.resolve(), { once: true }); return options.onQuestion(text, signal); },
 }, { ...seam, limits: { ...seam.limits, question: action === "expiry" ? 100 : 4000 } }) });
 const owner = runtime.activate();
 try {
  const run = runtime.start(owner, { ...input, task: "question" }, context());
  await runtime.wait(owner, run.id, 5000);
  if (action === "cancel") await runtime.cancel(owner, run.id);
  else { await expired.promise; await runtime.wait(owner, run.id, 5000); }
  assert.equal(runtime.status(owner, run.id).question, undefined);
  assert.equal(runtime.status(owner, run.id).status, action === "expiry" ? "failed" : "cancelled");
 } finally { await runtime.shutdown(); }
});

for (const action of ["retire", "shutdown"] as const) test(`${action} drains three gated children and never launches queued work`, { timeout: 12000 }, async () => {
 const children: ChildProcess[] = [], files: string[] = [], closed: Promise<void>[] = [], stopped: Promise<void>[] = [];
 const release = deferred(), cleanup = [deferred(), deferred(), deferred()];
 let launches = 0;
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async options => {
  const index = launches++;
  const result = await runBackgroundGuildRoleForTest(options, { ...seam, limits: { ...seam.limits, term: 5000 }, spawn: ((...args: Parameters<typeof spawn>) => {
   const child = spawn(...args); children.push(child);
   const stop = deferred(); stopped.push(stop.promise);
   child.stdout!.on("data", chunk => { if (String(chunk).includes("fixture-stopping")) stop.resolve(); });
   closed.push(new Promise(resolve => child.once("close", () => resolve())));
   return child;
  }) as typeof spawn });
  cleanup[index].resolve(); await release.promise; return result;
 } });
 const owner = runtime.activate();
 let join: Promise<void> | undefined;
 try {
  const runs = Array.from({ length: 4 }, () => runtime.start(owner, { ...input, task: "question-gated" }, { ...context(), onEvent(event) { if (event.type === "fixture") files.push(event.taskFile as string); } }));
  const deadline = Date.now() + 5000;
  while (!runs.slice(0, 3).every(run => runtime.status(owner, run.id).question)) {
   assert.ok(Date.now() < deadline); await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(runtime.status(owner, runs[3].id).status, "queued");
  const originalCancel = runtime.cancel(owner, runs[0].id);
  join = action === "retire" ? runtime.retire(owner) : runtime.shutdown();
  let settled = false; void join.then(() => { settled = true; });
  await Promise.all(stopped);
  assert.equal(launches, 3);
  assert.equal(settled, false);
  assert.throws(() => runtime.activate());
  assert.throws(() => runtime.collect(owner, runs[0].id));
  assert.equal(runtime.planParticipant.tryAcquire({}).kind, "unavailable");
  assert.equal(files.length, 3);
  files.forEach(file => assert.ok(existsSync(file)));
  children.forEach(child => child.kill("SIGUSR2"));
  await Promise.all(closed); await Promise.all(cleanup.map(gate => gate.promise));
  files.forEach(file => assert.equal(existsSync(dirname(file)), false));
  assert.equal(settled, false);
  assert.throws(() => runtime.activate());
  release.resolve(); await originalCancel; await join;
  assert.equal(launches, 3);
  assert.equal(settled, true);
  if (action === "retire") assert.ok(runtime.isCurrent(runtime.activate()));
  else assert.throws(() => runtime.activate(), /closed/);
 } finally { children.forEach(child => child.kill("SIGUSR2")); release.resolve(); await join; await runtime.shutdown(); }
});

test("generic binding reaches synchronous execution separately from protocol and snapshot", async () => {
 const binding = Object.freeze({ value: "private" });
 let received: unknown;
 const authority = new GuildExecutionAuthority<typeof binding>(() => new BackgroundRunRegistry<typeof binding>(request => {
  received = request.context;
  assert.equal("context" in request.input, false);
 }));
 const owner = authority.activate();
 const admission = createGuildBackgroundAdmission({ authority, bus: silent, parentEnvironment: standalone });
 try {
  const run = admission.start(owner, input, context(), binding);
  assert.equal(received, binding);
  assert.equal("context" in run, false);
  await authority.wait(owner, run.id, 1000);
  if (false) {
   // @ts-expect-error Configured context is required at authority admission.
   authority.start(owner, input);
   // @ts-expect-error Configured context is required at policy admission.
   admission.start(owner, input, context());
   const registry = new BackgroundRunRegistry<typeof binding>(() => {});
   // @ts-expect-error Configured context is required at registry admission.
   registry.start(input);
  }
 } finally { await authority.shutdown(); }
});

test("synchronous observer errors and accidental promise rejection cannot fail transport; next owner gets only its own context", async () => {
 const retained: RunBackgroundGuildRoleOptions[] = [];
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: options => { retained.push(options); return runBackgroundGuildRoleForTest(options, seam); } });
 let owner = runtime.activate(), oldEvents = 0, newEvents = 0, updates = 0;
 try {
  assert.deepEqual(Object.keys(runtime).sort(), ["activate", "isCurrent", "start", "status", "list", "reply", "wait", "collect", "release", "cancel", "retire", "shutdown", "planParticipant", "runExclusive", "sendUpdate"].sort());
  assert.ok(Object.isFrozen(owner));
  const first = runtime.start(owner, input, { ...context(), onEvent() { oldEvents++; throw Error("observer"); }, onUpdate() { updates++; return Promise.reject(Error("accidental async observer")); } });
  await runtime.wait(owner, first.id, 5000);
  assert.equal(runtime.status(owner, first.id).status, "completed");
  assert.ok(oldEvents > 0);
  // Exercise update observer directly while live in a second run, independent of fixture usage updates.
  const asking = runtime.start(owner, { ...input, task: "question" }, { ...context(), onUpdate() { updates++; return Promise.reject(Error("accidental async observer")); } });
  await runtime.wait(owner, asking.id, 5000);
  retained[1].onUpdate!({} as any);
  await new Promise(resolve => setImmediate(resolve));
  await runtime.cancel(owner, asking.id);
  assert.ok(updates > 0);
  const oldCount = oldEvents, updateCount = updates;
  retained[0].onEvent!({ type: "late" }); retained[1].onUpdate!({} as any);
  assert.equal(oldEvents, oldCount); assert.equal(updates, updateCount);
  await runtime.retire(owner); owner = runtime.activate();
  const next = runtime.start(owner, input, { ...context(), onEvent() { newEvents++; } });
  retained[0].onEvent!({ type: "late" }); retained[1].onUpdate!({} as any);
  await runtime.wait(owner, next.id, 5000);
  assert.equal(runtime.status(owner, next.id).status, "completed");
  assert.ok(newEvents > 0); assert.equal(oldEvents, oldCount); assert.equal(updates, updateCount);
 } finally { await runtime.shutdown(); }
});

test("exclusive facade preserves typed results, phases, abort cleanup and stale rejection", async () => {
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone });
 const owner = runtime.activate();
 const phases: string[] = [];
 const value: { answer: number } = await runtime.runExclusive(owner, () => ({ answer: 42 }), undefined, phase => phases.push(phase));
 assert.deepEqual(value, { answer: 42 });
 assert.deepEqual(phases, ["queued", "running"]);
 const error = new Error("operation failed");
 await assert.rejects(runtime.runExclusive(owner, () => { throw error; }), failure => failure === error);
 const cleanup = deferred(); const controller = new AbortController();
 let operationSignal: AbortSignal | undefined;
 const active = runtime.runExclusive(owner, async signal => { operationSignal = signal; await cleanup.promise; return 7; }, controller.signal);
 controller.abort();
 assert.equal(operationSignal?.aborted, true);
 let joined = false;
 const shutdown = runtime.shutdown().then(() => { joined = true; });
 await Promise.resolve(); assert.equal(joined, false);
 cleanup.resolve(); await Promise.allSettled([active]); await shutdown;
 await assert.rejects(runtime.runExclusive(owner, () => 1), /stale|closed|owner/i);
});

test("reservation captures immutable identity/context before launch and observes bounded unknown usage on failure", async () => {
 const captured = { sessionId: "session", nested: { value: 1 } };
 const token = Object.freeze({ reservation: true });
 let reserved: any, terminal: any, launched = 0;
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async options => {
  launched++;
  assert.equal(options.runId, reserved.id);
  assert.equal(options.taskId, reserved.taskId);
  throw Error("spawn failed");
 } });
 const owner = runtime.activate();
 try {
  const run = runtime.start(owner, input, { ...context(), observation: {
   capturedContext: captured,
   reserve(value) {
    reserved = value;
    assert.equal(launched, 0);
    assert.ok(Object.isFrozen(value));
    assert.ok(Object.isFrozen(value.input));
    assert.ok(Object.isFrozen((value.capturedContext as any).nested));
    assert.deepEqual(runtime.planParticipant.tryAcquire({}), { kind: "busy", outstanding: 1 });
    return token;
   },
   onTerminal(value) { terminal = value; },
  } });
  captured.nested.value = 2;
  await runtime.wait(owner, run.id, 1000);
  assert.equal(launched, 1);
  assert.equal(terminal.token, token);
  assert.equal(terminal.admission, reserved);
  assert.equal(terminal.admission.capturedContext.nested.value, 1);
  assert.equal(terminal.result.status, "failed");
  assert.equal(terminal.result.runId, run.id);
  assert.equal(terminal.result.taskId, reserved.taskId);
  assert.equal(terminal.result.usageKnown, false);
  assert.deepEqual(terminal.result.usageFields, []);
  assert.ok(Object.isFrozen(terminal.result.usage));
  assert.ok(Buffer.byteLength(JSON.stringify(terminal.result)) <= 65536);
  assert.match(terminal.result.diagnostic, /spawn failed/);
 } finally { await runtime.shutdown(); }
});

test("reservation reentry cannot bypass owner, Plan persistence or caught nested-start vetoes", async () => {
 for (const action of ["nested", "retire", "shutdown", "persisted", "throw"] as const) {
  let launches = 0, drain: Promise<void> | undefined;
  const branch: unknown[] = [];
  const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async () => { launches++; throw Error("must not launch"); } });
  const owner = runtime.activate();
  try {
   assert.throws(() => runtime.start(owner, input, { ...context(), getBranch: () => branch, observation: {
    capturedContext: { sessionId: "captured" },
    reserve() {
     assert.deepEqual(runtime.planParticipant.tryAcquire({}), { kind: "busy", outstanding: 1 });
     if (action === "nested") { try { runtime.start(owner, input, context()); } catch {} }
     if (action === "retire") drain = runtime.retire(owner);
     if (action === "shutdown") drain = runtime.shutdown();
     if (action === "persisted") branch.push({ type: "custom", customType: "plan-theme-state", data: { active: true } });
     if (action === "throw") throw Error("reservation fault");
    },
    onTerminal() { assert.fail("unadmitted terminal"); },
   } }), /Reentrant|owner|shut down|Plan|reservation fault/);
   assert.equal(launches, 0, action);
   if (runtime.isCurrent(owner)) assert.deepEqual(runtime.list(owner), []);
   await drain;
  } finally { await runtime.shutdown(); }
 }
});

test("required Plan policy is preserved across reservation and provider generation drift vetoes launch", async () => {
 for (const drift of [false, true]) {
  const coordinator = createPlanCoordinator();
  coordinator.confirmInactive(coordinator.provider.inspect().generation);
  let launches = 0, observations = 0;
  const runtime = createGuildBackgroundRuntime({ bus: { emit(_channel, request) { request.reply(coordinator.provider); } },
   parentEnvironment: { PITHOS_GUILD_PLAN_MODE: "required" }, runner: async () => { launches++; throw Error("test failure"); } });
  const owner = runtime.activate();
  const start = () => runtime.start(owner, input, { ...context(), observation: {
   capturedContext: {},
   reserve() { if (drift) coordinator.confirmInactive(coordinator.provider.inspect().generation); },
   onTerminal() { observations++; },
  } });
  try {
   if (drift) assert.throws(start, /Plan changed/);
   else { const run = start(); await runtime.wait(owner, run.id, 1000); }
   assert.equal(launches, drift ? 0 : 1);
   assert.equal(observations, drift ? 0 : 1);
  } finally { await runtime.shutdown(); }
 }
});

test("retirement publishes active and queued cancellations once, joins all observers and owns delayed fault joins", async () => {
 for (const fault of [false, true]) {
  const cleanup = deferred(), publication = deferred();
  const observed: any[] = [], optionsSeen: RunBackgroundGuildRoleOptions[] = [];
  const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async options => {
   optionsSeen.push(options); await cleanup.promise;
   return { ...options, status: "failed", exitCode: 1, output: "", stderr: "", activity: "done",
    usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 1, turns: 1 } };
  } });
  const owner = runtime.activate();
  const runs = Array.from({ length: 4 }, () => runtime.start(owner, input, { ...context(), observation: {
   capturedContext: { sessionId: "original" }, reserve: value => value.id,
   async onTerminal(value) {
    observed.push(value);
    assert.equal(runtime.isCurrent(owner), false);
    assert.throws(() => runtime.start(owner, input, context()), /owner/);
    assert.throws(() => runtime.reply(owner, value.admission.id, "q", "late"), /owner/);
    await publication.promise;
    if (fault && value.admission.id === runs[3].id) throw Error("durability unavailable");
   },
  } }));
  const retiring = runtime.retire(owner);
  try {
   await new Promise(resolve => setImmediate(resolve));
   assert.equal(observed.length, 1);
   assert.equal(observed[0].result.usageKnown, false);
   assert.equal(observed[0].admission.id, runs[3].id);
   assert.equal(optionsSeen.length, 3);
   cleanup.resolve(); await new Promise(resolve => setImmediate(resolve));
   assert.equal(observed.length, 4);
   assert.equal(new Set(observed.map(value => value.admission.id)).size, 4);
   assert.ok(observed.every(value => value.result.status === "cancelled"));
   assert.equal(runtime.planParticipant.tryAcquire({}).kind, "unavailable");
   assert.equal(runtime.retire(owner), retiring);
   assert.throws(() => runtime.activate(), /retiring/);
   publication.resolve();
   // The authority owns the rejection even when its caller attaches a join later.
   await new Promise(resolve => setImmediate(resolve));
   if (fault) {
    await assert.rejects(retiring, AggregateError);
    await assert.rejects(runtime.shutdown(), AggregateError);
   } else {
    await retiring;
    assert.ok(runtime.isCurrent(runtime.activate()));
    await runtime.shutdown();
   }
  } finally { cleanup.resolve(); publication.resolve(); await retiring.catch(() => {}); await runtime.shutdown().catch(() => {}); }
 }
});

test("observation pin: persistence failure retains a successful child claim without offering collection", async () => {
 let terminal: any;
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async options => ({
  ...options, status: "completed", exitCode: 0, output: "", stderr: "", activity: "done",
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 1, turns: 1 },
  report: { protocol: "guild/2", version: 2, runId: options.runId!, taskId: options.taskId!, role: "coder", profile: "typescript",
   taskOutcome: "succeeded", compliance: [], summary: "Child claim", blockers: [], limitations: [], payload: { changes: [], verification: [] } },
 }) });
 const owner = runtime.activate();
 try {
  const run = runtime.start(owner, { ...input, practices: [] }, { ...context(), observation: {
   capturedContext: {}, reserve: () => ({}), onTerminal(value) { terminal = value; throw Error("journal fault"); },
  } });
  await runtime.wait(owner, run.id, 1000);
  assert.equal(terminal.result.report.taskOutcome, "succeeded");
  const snapshot = runtime.status(owner, run.id);
  assert.equal(snapshot.status, "failed");
  assert.equal((snapshot.result as any).report.taskOutcome, "succeeded");
  assert.match(snapshot.error!, /Terminal persistence fault/);
  assert.throws(() => runtime.collect(owner, run.id), /persistence/);
  await assert.rejects(runtime.cancel(owner, run.id), /persistence/);
 } finally { await assert.rejects(runtime.shutdown(), AggregateError); }
});

for (const change of ["trust", "active", "unsafe", "provider", "reentry"] as const) test(`queued safety gate rejects late ${change}`, async () => {
 const hold = deferred(); let launches = 0, changed = false;
 let runtime: ReturnType<typeof createGuildBackgroundRuntime>;
 let owner: ReturnType<typeof runtime.activate>;
 const coordinator = createPlanCoordinator(); coordinator.confirmInactive(coordinator.provider.inspect().generation);
 runtime = createGuildBackgroundRuntime({ bus: { emit(_channel, request) {
  if (changed && change === "provider") request.reply(coordinator.provider);
  if (changed && change === "reentry") { try { runtime.start(owner, input, context()); } catch {} }
 } }, parentEnvironment: standalone, runner: async () => { launches++; throw Error("launched"); } });
 owner = runtime.activate();
 const exclusive = runtime.runExclusive(owner, () => hold.promise);
 const ctx = { ...context(), validateCurrent() { return !(changed && change === "trust"); }, isContextCurrent: () => !(changed && change === "trust"), getBranch() {
  if (changed && change === "unsafe") return new Proxy([], {});
  return changed && change === "active" ? [{ type: "custom", customType: "plan-theme-state", data: { active: true } }] : [];
 } };
 try {
  const run = runtime.start(owner, input, ctx); changed = true; hold.resolve(); await exclusive;
  await runtime.wait(owner, run.id, 1000);
  assert.equal(launches, 0);
  assert.equal(runtime.status(owner, run.id).status, "failed");
 } finally { hold.resolve(); await runtime.shutdown(); }
});

test("reply safety refusal preserves the correlated question for a fresh valid reply", async () => {
 let safe = true;
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async options => {
  await options.onQuestion("Continue?", new AbortController().signal); throw Error("finished");
 } });
 const owner = runtime.activate();
 try {
  const run = runtime.start(owner, input, { ...context(), validateCurrent: () => safe, isContextCurrent: () => safe });
  const question = runtime.status(owner, run.id).question!;
  safe = false;
  assert.throws(() => runtime.reply(owner, run.id, question.id, "answer"), /context|current/i);
  assert.equal(runtime.status(owner, run.id).question?.id, question.id);
  safe = true; runtime.reply(owner, run.id, question.id, "answer");
  await runtime.wait(owner, run.id, 1000);
 } finally { await runtime.shutdown(); }
});

test("bounded updates queue promptly then route to the captured ready child with lifetime limits", async () => {
 const hold = deferred(), finish = deferred(); const seen: string[] = [];
 let options!: RunBackgroundGuildRoleOptions;
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async value => {
  options = value; await finish.promise; throw Error("done");
 } });
 const owner = runtime.activate(); const exclusive = runtime.runExclusive(owner, () => hold.promise);
 try {
  const run = runtime.start(owner, input, context());
  const first = await runtime.sendUpdate(owner, run.id, "first");
  const second = await runtime.sendUpdate(owner, run.id, "second");
  assert.equal(first.disposition, "queued-for-start"); assert.notEqual(first.updateId, second.updateId);
  await assert.rejects(runtime.sendUpdate(owner, run.id, "third"), /limit/);
  hold.resolve(); await exclusive;
  const control = { sendUpdate(text: string) { assert.equal(this, control); seen.push(text); return Promise.resolve("handled" as const); } };
  options.onReady!(control);
  options.onReady!({ sendUpdate() { return assert.fail("duplicate replaced control"); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ["first", "second"]);
  for (const text of ["", "\0", "é".repeat(4097)]) await assert.rejects(runtime.sendUpdate(owner, run.id, text));
  for (let i = 2; i < 32; i++) assert.equal((await runtime.sendUpdate(owner, run.id, `${i}`)).disposition, "handled");
  await assert.rejects(runtime.sendUpdate(owner, run.id, "33"), /limit/);
  finish.resolve(); await runtime.wait(owner, run.id, 1000);
  await assert.rejects(runtime.sendUpdate(owner, run.id, "terminal"), /unavailable/i);
 } finally { hold.resolve(); finish.resolve(); await runtime.shutdown(); }
});

test("required queued launch refuses a replacement inactive provider", async () => {
 const first = createPlanCoordinator(), second = createPlanCoordinator();
 for (const c of [first, second]) c.confirmInactive(c.provider.inspect().generation);
 let provider = first.provider, launches = 0; const hold = deferred();
 const runtime = createGuildBackgroundRuntime({ bus: { emit(_channel, request) { request.reply(provider); } }, runner: async () => { launches++; throw Error("launch"); } });
 const owner = runtime.activate(); const exclusive = runtime.runExclusive(owner, () => hold.promise);
 try {
  const run = runtime.start(owner, input, context()); provider = second.provider;
  hold.resolve(); await exclusive; await runtime.wait(owner, run.id, 1000);
  assert.equal(launches, 0);
 } finally { hold.resolve(); await runtime.shutdown(); }
});

test("final context guard cannot change persistence then dispatch an update", async () => {
 let discovered = false, armed = false, active = false, deliveries = 0; const done = deferred();
 const runtime = createGuildBackgroundRuntime({ bus: { emit() { if (armed) discovered = true; } }, parentEnvironment: standalone, runner: async options => {
  options.onReady!({ async sendUpdate() { deliveries++; return "handled"; } }); await done.promise; throw Error("done");
 } });
 const owner = runtime.activate();
 try {
  const run = runtime.start(owner, input, { ...context(), validateCurrent() { if (armed && discovered) active = true; return true; }, isContextCurrent: () => true,
   getBranch: () => active ? [{ type: "custom", customType: "plan-theme-state", data: { active: true } }] : [] });
  armed = true;
  await assert.rejects(runtime.sendUpdate(owner, run.id, "update"), /Plan/);
  assert.equal(deliveries, 0);
 } finally { done.resolve(); await runtime.shutdown(); }
});

test("update guard reentry cannot dispatch after a question appears", async () => {
 const finish = deferred(); let options!: RunBackgroundGuildRoleOptions, ask = false, deliveries = 0;
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async value => {
  options = value; options.onReady!({ async sendUpdate() { deliveries++; return "queued"; } });
  await finish.promise; throw Error("done");
 } });
 const owner = runtime.activate();
 try {
  const run = runtime.start(owner, input, { ...context(), validateCurrent() {
   if (ask) { ask = false; void options.onQuestion("question", new AbortController().signal).catch(() => {}); }
   return true;
  }, isContextCurrent: () => true });
  ask = true; await assert.rejects(runtime.sendUpdate(owner, run.id, "not an answer"), /question|unavailable/i);
  assert.equal(deliveries, 0);
 } finally { finish.resolve(); await runtime.shutdown(); }
});

test("three live controls route independently, bound in-flight payloads and fence retirement settlement", async () => {
 const finish = deferred(), response = deferred<"queued">();
 const retained: RunBackgroundGuildRoleOptions[] = [], delivered: string[][] = [[], [], []];
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async options => {
  const index = retained.push(options) - 1;
  options.onReady!({ sendUpdate(text) { delivered[index].push(text); return response.promise; } });
  await finish.promise; throw Error("done");
 } });
 let owner = runtime.activate();
 try {
  const runs = Array.from({ length: 3 }, () => runtime.start(owner, input, context()));
  const promises = runs.map((run, i) => runtime.sendUpdate(owner, run.id, `run-${i}`));
  const extra = runtime.sendUpdate(owner, runs[0].id, "é".repeat(4096));
  await assert.rejects(runtime.sendUpdate(owner, runs[0].id, "third"), /limit/);
  assert.deepEqual(delivered.map(texts => texts[0]), ["run-0", "run-1", "run-2"]);
  const retiring = runtime.retire(owner);
  for (const options of retained) options.onReady!({ sendUpdate() { return assert.fail("stale control"); } });
  response.resolve("queued");
  for (const promise of [...promises, extra]) await assert.rejects(promise, /Stale|unavailable/);
  finish.resolve(); await retiring;
  owner = runtime.activate();
  await assert.rejects(runtime.sendUpdate(owner, runs[0].id, "old"), /Unknown/);
 } finally { response.resolve("queued"); finish.resolve(); await runtime.shutdown(); }
});

for (const action of ["cancel", "retire", "unsafe", "trust"] as const) test(`queued updates drop on ${action} before readiness`, async () => {
 const finish = deferred(); let retained!: RunBackgroundGuildRoleOptions, safe = true, branch: unknown[] = [], deliveries = 0;
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async options => {
  retained = options; await finish.promise; throw Error("done");
 } });
 const owner = runtime.activate(); let join: Promise<void> | undefined;
 try {
  const run = runtime.start(owner, input, { ...context(), validateCurrent: () => safe, isContextCurrent: () => safe, getBranch: () => branch });
  await runtime.sendUpdate(owner, run.id, "pending");
  if (action === "cancel") join = runtime.cancel(owner, run.id);
  if (action === "retire") join = runtime.retire(owner);
  if (action === "unsafe") branch = new Proxy([], {});
  if (action === "trust") safe = false;
  retained.onReady!({ async sendUpdate() { deliveries++; return "handled"; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deliveries, 0);
  finish.resolve(); await join;
 } finally { finish.resolve(); await runtime.shutdown(); }
});

test("reply rejects stale IDs, owners, oversized text and unsafe persistence without consuming a question", async () => {
 let branch: unknown[] = [];
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async options => {
  await options.onQuestion("question", new AbortController().signal); throw Error("done");
 } });
 const owner = runtime.activate();
 try {
  const run = runtime.start(owner, input, { ...context(), getBranch: () => branch });
  const question = runtime.status(owner, run.id).question!;
  assert.throws(() => runtime.reply({} as typeof owner, run.id, question.id, "answer"), /owner/);
  assert.throws(() => runtime.reply(owner, run.id, "other", "answer"), /Unknown/);
  assert.throws(() => runtime.reply(owner, run.id, question.id, "é".repeat(4097)), /text/);
  branch = new Proxy([], {});
  assert.throws(() => runtime.reply(owner, run.id, question.id, "answer"), /Unsafe/);
  assert.equal(runtime.status(owner, run.id).question?.id, question.id);
  await assert.rejects(runtime.sendUpdate(owner, run.id, "not an answer"), /question/);
  branch = []; runtime.reply(owner, run.id, question.id, "answer");
  await runtime.wait(owner, run.id, 1000);
 } finally { await runtime.shutdown(); }
});

test("queued launch guard cancellation cannot be swallowed into a child launch", async () => {
 const hold = deferred(); let armed = false, id = "", launches = 0;
 const runtime = createGuildBackgroundRuntime({ bus: { emit() { if (armed) { armed = false; void runtime.cancel(owner, id); } } }, parentEnvironment: standalone,
  runner: async () => { launches++; throw Error("launched"); } });
 const owner = runtime.activate(); const exclusive = runtime.runExclusive(owner, () => hold.promise);
 try {
  id = runtime.start(owner, input, context()).id; armed = true;
  hold.resolve(); await exclusive; await runtime.wait(owner, id, 1000);
  assert.equal(launches, 0);
 } finally { hold.resolve(); await runtime.shutdown(); }
});

test("queued update acceptance is fenced if ownership retires before async delivery", async () => {
 const finish = deferred();
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async () => { await finish.promise; throw Error("done"); } });
 const owner = runtime.activate();
 try {
  const run = runtime.start(owner, input, context());
  const pending = runtime.sendUpdate(owner, run.id, "pending");
  const retired = runtime.retire(owner);
  await assert.rejects(pending, /Stale|unavailable/);
  finish.resolve(); await retired;
 } finally { finish.resolve(); await runtime.shutdown(); }
});

for (const source of ["branch", "provider"] as const) for (const action of ["launch", "reply", "update"] as const) test(`pure final guard rejects ${source} drift before ${action}`, async () => {
 const hold = deferred(), done = deferred();
 let armed = false, discovered = false, finalRead = false, safe = true, launches = 0, deliveries = 0;
 const coordinator = createPlanCoordinator(); coordinator.confirmInactive(coordinator.provider.inspect().generation);
 const provider = { ...coordinator.provider, inspect() {
  if (source === "provider" && finalRead) safe = false;
  return coordinator.provider.inspect();
 } };
 const runtime = createGuildBackgroundRuntime({ parentEnvironment: source === "branch" ? standalone : undefined,
  bus: { emit(_channel, request) { if (armed) discovered = true; if (source === "provider") request.reply(provider); } },
  runner: async options => {
   launches++;
   options.onReady!({ async sendUpdate() { deliveries++; return "handled"; } });
   if (action === "reply") await options.onQuestion("Continue?", new AbortController().signal);
   await done.promise; throw Error("done");
  } });
 const owner = runtime.activate();
 const exclusive = action === "launch" ? runtime.runExclusive(owner, () => hold.promise) : undefined;
 const ctx = { ...context(), validateCurrent() { if (armed && discovered) finalRead = true; return safe; },
  isContextCurrent: () => safe,
  getBranch() { if (source === "branch" && finalRead) safe = false; return []; } };
 try {
  const run = runtime.start(owner, input, ctx); armed = true;
  if (action === "launch") {
   hold.resolve(); await exclusive; await runtime.wait(owner, run.id, 1000);
   assert.equal(launches, 0);
  } else if (action === "reply") {
   const question = runtime.status(owner, run.id).question!;
   assert.throws(() => runtime.reply(owner, run.id, question.id, "answer"), /context|current/i);
   assert.equal(runtime.status(owner, run.id).question?.id, question.id);
  } else {
   await assert.rejects(runtime.sendUpdate(owner, run.id, "update"), /context|current/i);
   assert.equal(deliveries, 0);
  }
 } finally { hold.resolve(); done.resolve(); await runtime.shutdown(); }
});

for (const kind of ["effectful-only", "pure-only", "noncallable", "getter-throw", "getter-reentry", "false", "throw", "reentry"] as const) test(`paired context guards reject ${kind} before launch`, async () => {
 let launches = 0;
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async () => { launches++; throw Error("launch"); } });
 const owner = runtime.activate();
 const nested = () => { try { runtime.start(owner, input, context()); } catch {} };
 const ctx = { ...context(), validateCurrent: kind === "pure-only" ? undefined : () => true,
  get isContextCurrent(): any {
   if (kind === "getter-throw") throw Error("capture failed");
   if (kind === "getter-reentry") nested();
   if (kind === "effectful-only") return undefined;
   if (kind === "noncallable") return true;
   return () => { if (kind === "throw") throw Error("predicate failed"); if (kind === "reentry") nested(); return kind !== "false"; };
  } };
 try {
  assert.throws(() => runtime.start(owner, input, ctx), error => error instanceof Error && error.message.length < 256);
  assert.equal(launches, 0);
 } finally { await runtime.shutdown(); }
});

for (const phase of ["reservation", "queued-acceptance", "sent-acceptance"] as const) test(`pure context predicate fences ${phase}`, async () => {
 let safe = true, launches = 0; const done = deferred(), response = deferred<"handled">();
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async options => {
  launches++;
  if (phase === "sent-acceptance") options.onReady!({ sendUpdate: () => response.promise });
  await done.promise; throw Error("done");
 } });
 const owner = runtime.activate();
 const ctx = { ...context(), validateCurrent: () => true, isContextCurrent: () => safe,
  observation: { capturedContext: {}, reserve() { if (phase === "reservation") safe = false; }, onTerminal() {} } };
 try {
  if (phase === "reservation") {
   assert.throws(() => runtime.start(owner, input, ctx), /context|current/i);
   assert.equal(launches, 0);
  } else {
   const run = runtime.start(owner, input, ctx);
   const pending = runtime.sendUpdate(owner, run.id, "update"); safe = false; response.resolve("handled");
   await assert.rejects(pending, /context|current/i);
  }
 } finally { response.resolve("handled"); done.resolve(); await runtime.shutdown(); }
});

test("paired guard functions capture once and preserve a frozen host receiver", async () => {
 const done = deferred(); let effectfulReads = 0, pureReads = 0, deliveries = 0;
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async options => {
  options.onReady!({ async sendUpdate() { deliveries++; return "handled"; } }); await done.promise; throw Error("done");
 } });
 const owner = runtime.activate();
 const ctx = Object.freeze({ ...context(),
  get validateCurrent() { effectfulReads++; return function(this: unknown) { assert.equal(this, ctx); return true; }; },
  get isContextCurrent() { pureReads++; return function(this: unknown) { assert.equal(this, ctx); return true; }; },
 });
 try {
  const run = runtime.start(owner, input, ctx);
  assert.equal((await runtime.sendUpdate(owner, run.id, "update")).disposition, "handled");
  assert.equal(deliveries, 1); assert.equal(effectfulReads, 1); assert.equal(pureReads, 1);
 } finally { done.resolve(); await runtime.shutdown(); }
});

test("rejected queued acceptance frees capacity without delivering text or resetting lifetime limits", async () => {
 let safe = true; const done = deferred(), seen: string[] = [];
 let options!: RunBackgroundGuildRoleOptions;
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async value => {
  options = value; await done.promise; throw Error("done");
 } });
 const owner = runtime.activate();
 try {
  const run = runtime.start(owner, input, { ...context(), validateCurrent: () => true, isContextCurrent: () => safe });
  await new Promise(resolve => setImmediate(resolve));
  const rejected = runtime.sendUpdate(owner, run.id, "rejected"); safe = false;
  await assert.rejects(rejected, /context|current/i);
  safe = true;
  const first = await runtime.sendUpdate(owner, run.id, "replacement-1");
  const second = await runtime.sendUpdate(owner, run.id, "replacement-2");
  assert.equal(first.updateId, `${run.id}:update:2`);
  assert.equal(second.updateId, `${run.id}:update:3`);
  await assert.rejects(runtime.sendUpdate(owner, run.id, "overflow"), /limit/);
  options.onReady!({ async sendUpdate(text) { seen.push(text); return "handled"; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ["replacement-1", "replacement-2"]);
  for (let i = 3; i < 32; i++) await runtime.sendUpdate(owner, run.id, `remaining-${i}`);
  await assert.rejects(runtime.sendUpdate(owner, run.id, "lifetime overflow"), /limit/);
 } finally { done.resolve(); await runtime.shutdown(); }
});

for (const accept of [false, true]) test(`readiness waits for queued acceptance commit (${accept})`, async () => {
 let safe = true; const done = deferred(), response = deferred<"handled">(), seen: string[] = [];
 let options!: RunBackgroundGuildRoleOptions;
 const runtime = createGuildBackgroundRuntime({ bus: silent, parentEnvironment: standalone, runner: async value => {
  options = value; await done.promise; throw Error("done");
 } });
 const owner = runtime.activate();
 try {
  const run = runtime.start(owner, input, { ...context(), validateCurrent: () => true, isContextCurrent: () => safe });
  await new Promise(resolve => setImmediate(resolve));
  const pending = runtime.sendUpdate(owner, run.id, "candidate");
  options.onReady!({ sendUpdate(text) { seen.push(text); return response.promise; } });
  assert.deepEqual(seen, [], "readiness must not dispatch before acceptance's final guard");
  safe = accept;
  if (accept) {
   assert.equal((await pending).disposition, "queued-for-start");
   assert.deepEqual(seen, ["candidate"], "commit must flush an already-ready queue");
   const second = runtime.sendUpdate(owner, run.id, "second");
   await assert.rejects(runtime.sendUpdate(owner, run.id, "third"), /limit/);
   response.resolve("handled"); await second;
  } else {
   await assert.rejects(pending, /context|current/i);
   safe = true;
   await new Promise(resolve => setImmediate(resolve));
   assert.deepEqual(seen, []);
   response.resolve("handled");
   assert.equal((await runtime.sendUpdate(owner, run.id, "replacement")).disposition, "handled");
   assert.deepEqual(seen, ["replacement"]);
  }
 } finally { response.resolve("handled"); done.resolve(); await runtime.shutdown(); }
});
