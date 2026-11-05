import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundLedger } from "../src/background-ledger.ts";
import { createBackgroundJournal } from "../src/background-journal.ts";
import { createBackgroundObservationSession } from "../src/background-observation-session.ts";
import { createGuildBackgroundRuntime, type GuildBackgroundContext } from "../src/background-runtime.ts";

// Test list: retirement/collection; navigation fences; identity/reentry; initialization; restore.
const input = {role: "coder", profile: "typescript", task: "Work"};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(history: any[] = []) {
 let calls = 0;
 const runtime = createGuildBackgroundRuntime({bus: {emit() {}}, parentEnvironment: {PITHOS_GUILD_PLAN_MODE: "standalone"},
  runner: async options => {
   calls++;
   await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), {once: true}));
   return {status: "failed", runId: options.runId, taskId: options.taskId, role: options.role, profile: options.profile,
    exitCode: 1, task: options.task, activity: "done", output: "private", stderr: "",
    usage: {input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 1, contextTokens: 3, turns: 1},
    providerUsage: {input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
     cost: {input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1}}};
  }});
 const manager = {id: "s", getSessionId() { assert.equal(this, manager); return this.id; },
  getBranch() { return history.map(e => ({id: e.id})); }, getEntries() { return history; }};
 const context = {sessionManager: manager, cwd: process.cwd()};
 const pi = {appendEntry(customType: string, data?: unknown) {
  assert.equal(this, pi);
  history.push({type: "custom", id: `e${history.length}`, parentId: history.at(-1)?.id ?? null,
   customType, data: structuredClone(data)});
 }};
 const execution: GuildBackgroundContext = {cwd: context.cwd, projectTrusted: false, getBranch: () => [],
  validateCurrent: () => true, isContextCurrent: () => true};
 return {runtime, manager, context, pi, execution, history, calls: () => calls,
  create: () => createBackgroundObservationSession({pi, context, runtime})};
}

test("one service journals through owner retirement and fresh owners collect native usage once", async () => {
 const f = fixture();
 try {
  const observation = f.create(), service = observation.service, epoch = observation.getEpoch();
  const owner = f.runtime.activate();
  const run = service.bind(owner).start(input, f.execution);
  assert.equal(observation.getEpoch(), epoch);
  await tick(); await f.runtime.retire(owner);
  assert.deepEqual(f.history.map(e => e.data.kind), ["admitted", "terminal"]);
  assert.equal(observation.isWritable(), true);
  const next = observation.service.bind(f.runtime.activate());
  const first = await next.wait(f.execution, run.runId, 0, {collectionId: "a", toolCallId: "a"});
  const repeat = await next.wait(f.execution, run.runId, 0, {collectionId: "b", toolCallId: "b"});
  assert.equal(first.collection?.kind, "first");
  assert.ok(first.collection && "nativeUsage" in first.collection);
  assert.equal(repeat.collection?.kind, "informational");
  assert.ok(repeat.collection && !("nativeUsage" in repeat.collection));
  assert.equal(observation.service, service); assert.equal(observation.getEpoch(), epoch);
 } finally { await f.runtime.shutdown(); }
});

test("pause after drain fences old scope and resume admits on the same service without respawn", async () => {
 const f = fixture();
 try {
  const observation = f.create(), service = observation.service, epoch = observation.getEpoch();
  const owner = f.runtime.activate(), bound = service.bind(owner);
  const run = bound.start(input, f.execution);
  await tick(); await f.runtime.retire(owner);
  const ledger = new BackgroundLedger(createBackgroundJournal(f.pi, f.context, {
   getEpoch: observation.getEpoch, isWritable: observation.isWritable,
   isCurrentSession: () => observation.isCurrent(f.context),
  }));
  const token = ledger.reserve({sessionId: "s", runId: "stale", taskId: run.taskId, role: "coder", profile: "typescript"});
  observation.pause();
  assert.equal(observation.isWritable(), false); assert.notEqual(observation.getEpoch(), epoch);
  const pausedEpoch = observation.getEpoch(), writes = f.history.length;
  const next = service.bind(f.runtime.activate());
  assert.equal((await next.wait(f.execution, run.runId, 0, {collectionId: "paused", toolCallId: "paused"})).collection?.kind, "rejected");
  assert.equal(f.history.length, writes);
  assert.equal(observation.resume({...f.context}), true);
  assert.equal(observation.getEpoch(), pausedEpoch); assert.equal(observation.service, service);
  assert.throws(() => ledger.observeTerminal(token, {...service.inspect(run.runId)!.report!, runId: "stale"}), /Stale terminal scope/);
  assert.equal(f.history.length, writes);
  assert.equal(f.calls(), 1);
  next.start(input, f.execution); await tick(); assert.equal(f.calls(), 2);
  assert.equal(observation.resume(f.context), true); assert.equal(observation.getEpoch(), pausedEpoch);
 } finally { await f.runtime.shutdown(); }
});

test("identity is captured, both contexts stay valid, and close permanently prevents writes", async () => {
 const f = fixture();
 try {
  const o = f.create(), bound = o.service.bind(f.runtime.activate());
  for (const wrong of [{...f.context, sessionManager: {...f.manager}}, {...f.context, cwd: "/other"},
   {...f.context, sessionManager: {...f.manager, getSessionId: () => "other"}}]) {
   o.pause(); assert.equal(o.resume(wrong), false); assert.equal(o.isCurrent(wrong), false);
   assert.throws(() => bound.start(input, f.execution));
   assert.equal(f.history.length, 0);
  }
  f.manager.id = "other";
  assert.equal(o.resume(f.context), false); assert.throws(() => bound.start(input, f.execution));
  f.manager.id = "s";
  const branch = {...f.context}; f.context.cwd = "/changed";
  assert.equal(o.resume(branch), false); assert.equal(o.isCurrent(branch), false);
  f.context.cwd = branch.cwd;
  assert.equal(o.resume(branch), true); assert.equal(o.isCurrent(branch), true);
  const epoch = o.getEpoch(); o.close();
  assert.notEqual(o.getEpoch(), epoch); assert.equal(o.resume(branch), false);
  assert.equal(o.isWritable(), false); assert.equal(o.isCurrent(branch), false);
  assert.throws(() => bound.start(input, f.execution)); assert.equal(f.history.length, 0);
 } finally { await f.runtime.shutdown(); }
});

test("identity getter reentry cannot reopen a paused or closed session or invalidate the original unnoticed", async () => {
 for (const action of ["pause", "close"] as const) {
  const f = fixture();
  try {
   const o = f.create(), branch = {...f.context}; o.pause();
   let reads = 0;
   Object.defineProperty(f.context, "sessionManager", {get() {
    if (++reads === 2) o[action](); // Final original-context identity read.
    return f.manager;
   }});
   assert.equal(o.resume(branch), false); assert.equal(o.isWritable(), false);
   assert.equal(reads, 2);
  } finally { await f.runtime.shutdown(); }
 }
 for (const action of ["pause", "close", "invalidate", "throw"] as const) {
  const f = fixture();
  try {
   const o = f.create(); o.pause();
   const branch = {...f.context, get cwd() {
    if (action === "invalidate") f.context.sessionManager = {...f.manager};
    else if (action === "throw") throw Error("host getter");
    else o[action]();
    return f.context.cwd;
   }};
   assert.equal(o.resume(branch), false, action);
   assert.equal(o.isWritable(), false, action);
   assert.equal(f.history.length, 0);
  } finally { await f.runtime.shutdown(); }
 }
});

test("initialization rejects identity drift in captured SDK getters without publishing a service", async () => {
 for (const field of ["id", "cwd"] as const) {
  const f = fixture();
  try {
   let first = true;
   const drift = () => { if (first) { first = false; f.context.sessionManager = {...f.manager, getSessionId: () => "s"}; } };
   if (field === "id") f.manager.getSessionId = () => { drift(); return "s"; };
   else Object.defineProperty(f.context, "cwd", {get() { drift(); return process.cwd(); }});
   assert.throws(() => f.create(), /unavailable/i);
   assert.equal(f.calls(), 0); assert.equal(f.history.length, 0);
  } finally { await f.runtime.shutdown(); }
 }
});

test("restore reads history without children or writes and unknown admission collects explicitly", async () => {
 const f = fixture([{type: "custom", id: "e0", parentId: null, customType: "pithos.guild.background.v1",
  data: {version: 1, kind: "admitted", sessionId: "s", runId: "lost", taskId: "task", role: "coder", profile: "typescript"}}]);
 try {
  const o = f.create();
  assert.equal(o.service.inspect("lost")?.interrupted, true);
  assert.equal(f.calls(), 0); assert.equal(f.history.length, 1);
  const result = await o.service.bind(f.runtime.activate()).wait(f.execution, "lost", 0, {collectionId: "restore", toolCallId: "restore"});
  assert.equal(result.collection?.kind, "first");
  assert.ok(result.collection && !("nativeUsage" in result.collection));
  assert.equal(result.runs[0].status, "cancelled"); assert.equal(f.calls(), 0);
 } finally { await f.runtime.shutdown(); }
});
