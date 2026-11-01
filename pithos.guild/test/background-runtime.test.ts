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
  assert.equal(reads, 2, "both synchronous checks use the original receiver and live branch");
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
  assert.deepEqual(Object.keys(runtime).sort(), ["activate", "isCurrent", "start", "status", "list", "reply", "wait", "collect", "release", "cancel", "retire", "shutdown", "planParticipant", "runExclusive"].sort());
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
