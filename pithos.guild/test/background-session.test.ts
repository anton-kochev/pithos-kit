import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundSession } from "../src/background-session.ts";
import { createGuildBackgroundRuntime, type GuildBackgroundContext } from "../src/background-runtime.ts";
import type { BackgroundJournal, LedgerScope } from "../src/background-ledger.ts";
import type { RunBackgroundGuildRoleOptions } from "../src/background-runner.ts";

// Test list: guarded prompt admission; signals; controls/waits; durable claims;
// retirement/recovery; scope fences; publication faults; bounded capacity.
const input = {role: "coder", profile: "typescript", task: "Work"};
const usage = {input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10,
 cost: {input: .1, output: .2, cacheRead: .3, cacheWrite: .4, total: 1}};
class Journal implements BackgroundJournal {
 history: any[] = [];
 current: LedgerScope = {sessionId: "s", branchEntryIds: [], writable: true, epoch: {}};
 hook?: (event: string, data?: any) => void;
 scope() { this.hook?.("scope"); return this.current; }
 entries() { this.hook?.("entries"); return this.history; }
 append(data: unknown) {
  this.hook?.("before", data);
  const id = `e${this.history.length}`;
  this.history.push({type: "custom", id, parentId: this.current.branchEntryIds.at(-1) ?? null,
   customType: "pithos.guild.background.v1", data: structuredClone(data)});
  this.current = {...this.current, branchEntryIds: [...this.current.branchEntryIds, id]};
  this.hook?.("after", data);
 }
}
function setup(journal = new Journal(), onFault?: (reason: string) => unknown) {
 const calls: RunBackgroundGuildRoleOptions[] = [];
 const finish = new Map<string, () => void>();
 const runtime = createGuildBackgroundRuntime({bus: {emit() {}}, parentEnvironment: {PITHOS_GUILD_PLAN_MODE: "standalone"},
  runner: async options => {
   calls.push(options);
   await new Promise<void>(resolve => {
    finish.set(options.runId!, resolve);
    options.signal!.addEventListener("abort", () => resolve(), {once: true});
   });
   return {status: "failed", runId: options.runId, taskId: options.taskId, role: options.role, profile: options.profile,
    exitCode: 1, task: options.task, activity: "done", output: "private", stderr: "", usage: {input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 1, contextTokens: 10, turns: 1}, providerUsage: usage};
  }});
 const session = createBackgroundSession({runtime, journal, onFault});
 const owner = runtime.activate();
 const bound = session.bind(owner);
 const context: GuildBackgroundContext = {cwd: process.cwd(), projectTrusted: false, getBranch: () => [],
  validateCurrent() { return true; }, isContextCurrent() { return true; }};
 return {runtime, journal, session, owner, bound, context, calls, finish};
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("prompt admission captures each start, requires guard pair, and bounds visible summaries", async () => {
 const f = setup();
 try {
  assert.throws(() => f.bound.start(input, {...f.context, isContextCurrent: undefined}), /guard/i);
  const runs = Array.from({length: 7}, (_, i) => f.bound.start(input, {...f.context, model: `model-${i}`}));
  assert.equal(new Set(runs.map(r => r.runId)).size, 7);
  await tick();
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.map(c => c.model), ["model-0", "model-1", "model-2"]);
  const summaries = f.bound.status(f.context);
  assert.equal(summaries.filter(s => s.status === "queued").length, 4);
  assert.equal(summaries.length, 7);
  for (const s of summaries) {
   assert.equal(s.role, "coder"); assert.equal(s.profile, "typescript"); assert.ok(s.taskId);
   assert.equal("nativeUsage" in s, false); assert.equal("report" in s, false);
  }
 } finally { await f.runtime.shutdown(); }
});

test("terminal waits durably claim once, release cache, and allow historical collection after retirement", async () => {
 const f = setup();
 try {
  const run = f.bound.start(input, f.context);
  await tick(); f.finish.get(run.runId)!();
  await f.runtime.wait(f.owner, run.runId, 1000);
  const results = await Promise.all([1, 2].map(i => f.bound.wait(f.context, run.runId, 0, {collectionId: `c${i}`, toolCallId: `t${i}`})));
  assert.equal(results.filter(r => r.collection?.kind === "first").length, 1);
  assert.equal(results.filter(r => r.collection && "nativeUsage" in r.collection).length, 1);
  assert.equal(f.runtime.list(f.owner).length, 0);
  assert.equal(f.session.list().length, 0);
  assert.equal(f.bound.status(f.context, run.runId)[0].reportAvailable, true);
  await f.runtime.retire(f.owner);
  await assert.rejects(f.bound.wait(f.context, run.runId, 0, {collectionId: "old", toolCallId: "old"}), /unavailable/);
  const next = f.session.bind(f.runtime.activate());
  const repeat = await next.wait(f.context, run.runId, 0, {collectionId: "new", toolCallId: "new"});
  assert.equal(repeat.collection?.kind, "informational");
 } finally { await f.runtime.shutdown(); }
});

test("controls route exact answers/updates and cancel only the target, including historical terminals", async () => {
 const f = setup();
 try {
  const a = f.bound.start(input, f.context), b = f.bound.start(input, f.context);
  await tick();
  const update = await f.bound.send(f.context, a.runId, "scope update");
  assert.equal(update.disposition, "queued-for-start"); assert.ok(update.updateId);
  let received = "";
  const question = f.calls[0].onQuestion!("Which?", new AbortController().signal).then(answer => { received = answer ?? ""; });
  await tick();
  const q = f.bound.status(f.context, a.runId)[0].question!;
  await assert.rejects(f.bound.send(f.context, a.runId, "wrong", "wrong"));
  const answer = await f.bound.send(f.context, a.runId, "yes", q.id);
  assert.equal(answer.disposition, "accepted-not-delivered");
  await question; assert.equal(received, "yes");
  await f.bound.cancel(f.context, a.runId);
  assert.equal(f.calls[1].signal!.aborted, false);
  await f.bound.wait(f.context, a.runId, 0, {collectionId: "a", toolCallId: "a"});
  await f.runtime.retire(f.owner);
  const next = f.session.bind(f.runtime.activate());
  await next.cancel(f.context, a.runId);
  await assert.rejects(next.send(f.context, b.runId, "no"));
 } finally { await f.runtime.shutdown(); }
});

test("wait budgets bound observers without cancelling work and sibling questions wake waits", async () => {
 const f = setup();
 const abort = new AbortController();
 try {
  const a = f.bound.start(input, f.context), b = f.bound.start(input, f.context);
  const collection = {collectionId: "wait", toolCallId: "wait"};
  await assert.rejects(f.bound.wait(f.context, a.runId, 60001, collection), /timeout/i);
  const waits = Array.from({length: 32}, () => f.bound.wait(f.context, a.runId, 60000, collection, abort.signal));
  await assert.rejects(f.bound.wait(f.context, a.runId, 0, collection), /waiter/i);
  abort.abort();
  assert.ok((await Promise.all(waits)).every(w => w.reason === "aborted"));
  assert.equal((await f.bound.wait(f.context, a.runId, 0, collection)).reason, "timeout");
  await tick();
  const question = f.calls[1].onQuestion!("Sibling?", new AbortController().signal).catch(() => "cancelled");
  const wake = await f.bound.wait(f.context, a.runId, undefined, collection);
  assert.equal(wake.reason, "question");
  assert.equal(wake.runs.find(r => r.runId === b.runId)?.question?.text, "Sibling?");
  assert.ok(f.calls.every(c => !c.signal!.aborted));
  await f.runtime.shutdown(); await question;
 } finally { abort.abort(); await f.runtime.shutdown(); }
});

test("claim fences context reentry during journal reads and after append without returning usage", async () => {
 for (const event of ["entries", "after"]) {
  const f = setup(); let current = true;
  const ctx = {...f.context, isContextCurrent: () => current};
  try {
   const run = f.bound.start(input, ctx);
   await tick(); f.finish.get(run.runId)!(); await f.runtime.wait(f.owner, run.runId, 1000);
   let reads = 0;
   f.journal.hook = (e, data) => {
    if (event === "entries" && e === "entries" && ++reads === 1) current = false;
    if (event === "after" && e === "after" && data.kind === "collected") current = false;
   };
   await assert.rejects(f.bound.wait(ctx, run.runId, 0, {collectionId: "c", toolCallId: "t"}), /unavailable/);
   f.journal.hook = undefined;
   assert.equal(f.journal.history.filter(e => e.data.kind === "collected").length, event === "after" ? 1 : 0);
  } finally { await f.runtime.shutdown(); }
 }
});

test("initial signal fences admission through commit but never owns the admitted child", async () => {
 for (const phase of ["before", "reserve", "post-reserve", "returned"]) {
  const f = setup(), abort = new AbortController();
  try {
   let admitted = false;
   f.journal.hook = (event, data) => {
    if (event === "after" && data.kind === "admitted") { admitted = true; if (phase === "reserve") abort.abort(); }
   };
   const ctx = {...f.context, getBranch() {
    if (admitted && phase === "post-reserve") abort.abort();
    return [];
   }};
   if (phase === "before") abort.abort();
   if (phase !== "returned") {
    assert.throws(() => f.bound.start(input, ctx, abort.signal));
    await tick(); assert.equal(f.calls.length, 0);
   } else {
    const run = f.bound.start(input, ctx, abort.signal);
    abort.abort(); await tick();
    assert.equal(f.calls[0].signal!.aborted, false);
    await f.bound.cancel(ctx, run.runId);
   }
  } finally { f.journal.hook = undefined; await f.runtime.shutdown(); }
 }
});

test("captures receiver-dependent guard functions once and never reads caller observation", async () => {
 const f = setup();
 try {
  let validates = 0, currents = 0;
  const ctx: GuildBackgroundContext = {
   ...f.context,
   get validateCurrent() {
    assert.equal(++validates, 1);
    return function(this: GuildBackgroundContext) { assert.equal(this, ctx); return true; };
   },
   get isContextCurrent() {
    assert.equal(++currents, 1);
    return function(this: GuildBackgroundContext) { assert.equal(this, ctx); return true; };
   },
   getBranch() { assert.equal(this, ctx); return []; },
   get observation(): never { throw new Error("Untrusted observer must not be read"); },
  };
  f.bound.start(input, ctx);
  await tick(); assert.equal(f.calls.length, 1);
 } finally { await f.runtime.shutdown(); }
});

test("restored interrupted observations collect explicitly without reconstructing execution", async () => {
 const journal = new Journal();
 journal.append({version: 1, kind: "admitted", sessionId: "s", runId: "lost", taskId: "task",
  role: "writer", profile: "general"});
 const f = setup(journal);
 try {
  assert.equal(f.session.inspect("lost")?.interrupted, true);
  assert.equal(f.session.list().length, 1);
  assert.equal(f.calls.length, 0); assert.equal(journal.history.length, 1);
  const result = await f.bound.wait(f.context, "lost", 0, {collectionId: "restore", toolCallId: "restore"});
  assert.equal(result.reason, "terminal");
  assert.equal(result.collection?.kind, "first");
  assert.equal(result.collection && "nativeUsage" in result.collection, false);
  assert.equal(result.runs[0].status, "cancelled");
  assert.equal(result.runs[0].reportAvailable, true);
  assert.equal(f.session.list().length, 0); assert.equal(f.calls.length, 0);
 } finally { await f.runtime.shutdown(); }
});

test("retirement publishes all observations independently of the owner and manual reads never activate", async () => {
 const f = setup();
 const runs = Array.from({length: 4}, () => f.bound.start(input, f.context));
 await tick();
 assert.equal(f.runtime.planParticipant.tryAcquire({}).kind, "busy");
 await f.runtime.retire(f.owner);
 assert.equal(f.runtime.isCurrent(f.owner), false);
 assert.equal(f.session.list().length, 4);
 for (const run of runs) assert.equal(f.session.inspect(run.runId)?.report?.status, "cancelled");
 assert.throws(() => f.bound.status(f.context), /unavailable/);
 const next = f.session.bind(f.runtime.activate());
 const queued = await next.wait(f.context, runs[3].runId, 0, {collectionId: "queued", toolCallId: "queued"});
 assert.equal(queued.collection?.kind, "first");
 assert.equal(queued.collection && "nativeUsage" in queued.collection, false);
 await f.runtime.shutdown();
});

test("publication faults retain observations, fail closed, and join all cleanup without awaiting fault notification", async () => {
 let faults = 0;
 const f = setup(new Journal(), () => { faults++; return new Promise(() => {}); });
 try {
  const runs = Array.from({length: 4}, () => f.bound.start(input, f.context));
  await tick();
  f.journal.hook = (event, data) => { if (event === "before" && data.kind === "terminal") throw Error("disk fault"); };
  f.finish.get(runs[0].runId)!();
  await f.runtime.wait(f.owner, runs[0].runId, 1000);
  await assert.rejects(f.runtime.shutdown(), AggregateError);
  f.journal.hook = undefined;
  assert.ok(faults > 0);
  assert.ok(f.calls.every(c => c.signal!.aborted));
  for (const run of runs) assert.ok(f.session.inspect(run.runId)?.report);
  assert.throws(() => f.bound.start(input, f.context));
 } finally { f.journal.hook = undefined; await f.runtime.shutdown().catch(() => {}); }
});

test("ledger capacity remains sixteen across retired owners and scope changes hide observations", async () => {
 const f = setup();
 try {
  const ids: string[] = [];
  for (let i = 0; i < 16; i++) {
   const run = f.bound.start({...input, role: "reviewer", profile: "general"}, {...f.context, thinkingLevel: "high", projectTrusted: true});
   ids.push(run.runId); await tick();
   f.finish.get(run.runId)!(); await f.runtime.wait(f.owner, run.runId, 1000);
  }
  await f.runtime.retire(f.owner);
  const next = f.session.bind(f.runtime.activate());
  assert.throws(() => next.start(input, f.context), /capacity/);
  assert.equal(next.status(f.context).length, 16);
  const origin = f.journal.current;
  for (const patch of [{sessionId: "other"}, {branchEntryIds: []}]) {
   f.journal.current = {...origin, ...patch};
   assert.deepEqual(next.status(f.context), []);
   assert.equal(f.session.inspect(ids[0]), undefined);
   assert.throws(() => next.status(f.context, ids[0]), /unavailable/);
   await assert.rejects(next.wait(f.context, ids[0], 0, {collectionId: "wrong", toolCallId: "wrong"}));
  }
  f.journal.current = origin;
  await next.wait(f.context, ids[0], 0, {collectionId: "free", toolCallId: "free"});
  const run = next.start(input, f.context);
  assert.ok(run.runId);
  assert.ok(f.calls.slice(0, 16).every(c => c.role === "reviewer" && c.thinkingLevel === "high" && c.projectTrusted));
 } finally { await f.runtime.shutdown(); }
});

test("send exposes queued/handled dispositions and rejects asynchronous responses after retirement", async () => {
 for (const disposition of ["queued", "handled"] as const) {
  const f = setup();
  try {
   const run = f.bound.start(input, f.context); await tick();
   f.calls[0].onReady!({sendUpdate: async () => disposition});
   assert.equal((await f.bound.send(f.context, run.runId, "update")).disposition, disposition);
   let finish!: (value: "handled") => void;
   // A separate child owns a delayed transport call.
   const other = f.bound.start(input, f.context); await tick();
   f.calls[1].onReady!({sendUpdate: () => new Promise(resolve => { finish = resolve; })});
   const pending = f.bound.send(f.context, other.runId, "late");
   const retiring = f.runtime.retire(f.owner); finish("handled");
   await assert.rejects(pending); await retiring;
  } finally { await f.runtime.shutdown(); }
 }
});

test("explicit invalid run identities never widen a lookup into a list", async () => {
 const f = setup();
 try {
  f.bound.start(input, f.context);
  for (const id of ["", " ", "\0", "x".repeat(257), null] as any[]) {
   assert.throws(() => f.bound.status(f.context, id), /unavailable/);
   await assert.rejects(f.bound.cancel(f.context, id), /unavailable/);
   await assert.rejects(f.bound.wait(f.context, id, 0, {collectionId: "c", toolCallId: "t"}), /unavailable/);
  }
  await assert.rejects(f.bound.cancel(f.context, undefined as any), /unavailable/);
  await assert.rejects(f.bound.wait(f.context, undefined as any, 0, {collectionId: "c", toolCallId: "t"}), /unavailable/);
 } finally { await f.runtime.shutdown(); }
});

// Review-fix list: publication must settle before claim; failed pre-schedule
// reservations must become collectable without launching or inventing usage.
test("terminal publication microtask waits for settlement before claiming or releasing capacity", async () => {
 const f = setup();
 try {
  const run = f.bound.start(input, f.context);
  await tick();
  let observed!: Promise<Awaited<ReturnType<typeof f.bound.wait>>>;
  f.journal.hook = (event, data) => {
   if (event === "after" && data.kind === "terminal") queueMicrotask(() => {
    observed = f.bound.wait(f.context, run.runId, 0, {collectionId: "race", toolCallId: "race"});
    assert.equal(f.journal.history.filter(e => e.data.kind === "collected").length, 0);
    assert.equal(f.runtime.list(f.owner).length, 1);
   });
  };
  f.finish.get(run.runId)!();
  await tick();
  const first = await observed;
  assert.equal(first.collection?.kind, "first");
  assert.deepEqual(first.collection && "nativeUsage" in first.collection && first.collection.nativeUsage, usage);
  const repeat = await f.bound.wait(f.context, run.runId, 0, {collectionId: "repeat", toolCallId: "repeat"});
  assert.equal(repeat.collection?.kind, "informational");
  assert.equal(f.runtime.list(f.owner).length, 0);
 } finally { await f.runtime.shutdown(); }
});

test("never-scheduled reservations are cancelled and collectable in the same service across sixteen replacements", async () => {
 for (const phase of ["post-reserve-abort", "later-preSchedule"]) {
  const f = setup();
  try {
   for (let i = 0; i < 17; i++) {
    const abort = new AbortController();
    let admitted = false;
    const rejection = new Error("late preSchedule rejection");
    f.journal.hook = (event, data) => {
     if (event === "after" && data.kind === "admitted") {
      admitted = true;
      if (phase === "post-reserve-abort") abort.abort(rejection);
     }
    };
    const ctx = {...f.context, getBranch() { if (admitted && phase === "later-preSchedule") throw rejection; return []; }};
    assert.throws(() => f.bound.start(input, ctx, abort.signal), error => error === rejection);
    f.journal.hook = undefined;
    const id = f.journal.history.filter(e => e.data.kind === "admitted").at(-1).data.runId;
    assert.equal(f.session.inspect(id)?.report?.status, "cancelled");
    const collected = await f.bound.wait(f.context, id, 0, {collectionId: `${phase}-${i}`, toolCallId: `${phase}-${i}`});
    assert.equal(collected.collection?.kind, "first");
    assert.equal(collected.collection && "nativeUsage" in collected.collection, false);
    assert.equal(collected.collection && "report" in collected.collection && collected.collection.report?.usageKnown, false);
    assert.equal(f.journal.history.filter(e => e.data.kind === "terminal" && e.data.runId === id).length, 1);
    assert.equal(f.runtime.list(f.owner).length, 0);
   }
   await tick(); assert.equal(f.calls.length, 0);
   const replacement = f.bound.start(input, f.context);
   await tick(); assert.equal(f.calls.length, 1);
   await f.bound.cancel(f.context, replacement.runId);
  } finally { f.journal.hook = undefined; await f.runtime.shutdown(); }
 }
});

test("rejected reservation publication faults retain unknown usage and never append on a changed scope", async () => {
 for (const mode of ["write-failure", "scope-change"]) {
  let faults = 0;
  const f = setup(new Journal(), () => { faults++; return new Promise(() => {}); });
  const abort = new AbortController(), rejection = new Error("reject admission");
  let admitted = false, terminalWrites = 0;
  try {
   f.journal.hook = (event, data) => {
    if (event === "after" && data.kind === "admitted") { admitted = true; abort.abort(rejection); }
    if (event === "before" && data.kind === "terminal") { terminalWrites++; throw new Error("write failed"); }
   };
   const ctx = {...f.context, isContextCurrent() {
    if (admitted && mode === "scope-change") f.journal.current = {...f.journal.current, epoch: {}};
    return true;
   }};
   // Scope rotation occurs after reserve has returned, in the service's final check.
   if (mode === "scope-change") {
    f.journal.hook = (event, data) => {
     if (event === "after" && data.kind === "admitted") admitted = true;
     if (event === "before" && data.kind === "terminal") terminalWrites++;
    };
    ctx.isContextCurrent = () => {
     if (admitted) { f.journal.current = {...f.journal.current, epoch: {}}; throw rejection; }
     return true;
    };
   }
   assert.throws(() => f.bound.start(input, ctx, abort.signal), error => error === rejection);
   f.journal.hook = undefined;
   const id = f.journal.history[0].data.runId;
   assert.equal(f.session.inspect(id)?.report?.usageKnown, false);
   assert.equal(f.session.inspect(id)?.report?.status, "cancelled");
   assert.equal(terminalWrites, mode === "write-failure" ? 1 : 0);
   assert.equal(faults, 1);
   assert.throws(() => f.bound.start(input, f.context), /unavailable/);
   await assert.rejects(f.bound.wait(f.context, id, 0, {collectionId: "fault", toolCallId: "fault"}), /unavailable/);
   await tick(); assert.equal(f.calls.length, 0);
  } finally { f.journal.hook = undefined; await f.runtime.shutdown(); }
 }
});
