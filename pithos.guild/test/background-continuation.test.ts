import assert from "node:assert/strict";
import { test } from "node:test";
import { createBackgroundContinuation } from "../src/background-continuation.ts";

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred<T>() {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>(done => { resolve = done; });
 return { promise, resolve };
}
const question = (runId: string, revision = 1) => ({
 kind: "question", runId, taskId: runId, role: "coder", profile: "typescript",
 revision, questionId: "q", textPreview: "Help?",
});
function fixture() {
 const epoch = {};
 let current = true;
 let idle = () => {};
 let opens = 0, closes = 0, revokes = 0;
 let busy = false;
 const accepted: { sequence: number; content: string }[] = [];
 const committed = deferred<"none" | "committed" | "unknown">();
 const finished = deferred<{ outcome: "completed" | "revoked" | "error"; commitState: "none" | "committed" | "unknown"; started: boolean }>();
 const closed = deferred<void>();
 const receipt = { committed: committed.promise, finished: finished.promise, started: Promise.resolve(false), revoke() { revokes++; } };
 const lease = {
  closed: closed.promise,
  close() { assert.equal(this, lease); closes++; closed.resolve(); },
  onIdle(callback: () => void) { assert.equal(this, lease); idle = callback; },
  tryAccept(sequence: number, content: string) {
   assert.equal(this, lease);
   if (busy) return { status: "busy" };
   accepted.push({ sequence, content });
   return { status: "accepted", receipt };
  },
 };
 const capability = { protocol: "pi-parent-continuation-v1", open() { assert.equal(this, capability); opens++; return lease; } };
 const options = { epoch, context: { parentContinuation: capability }, isCurrent: () => current,
  validateContextAndPlan: () => true, canDeliver: () => true };
 return { epoch, options, lease, receipt, capability, accepted, committed, finished, closed,
  idle: () => idle(), invalidate: () => { current = false; }, busy: (value: boolean) => { busy = value; },
  counts: () => ({ opens, closes, revokes }) };
}

test("coalesces three questions, acknowledging history rather than acceptance", async () => {
 const f = fixture();
 const adapter = createBackgroundContinuation(f.options);
 for (const id of ["a", "b", "c"]) adapter.observe(f.epoch, question(id));
 await tick();
 assert.equal(f.accepted.length, 1);
 assert.equal(JSON.parse(f.accepted[0].content).items.length, 3);
 f.idle(); await tick(); assert.equal(f.accepted.length, 1);
 f.committed.resolve("committed");
 f.finished.resolve({ outcome: "revoked", commitState: "committed", started: false });
 await tick(); f.idle(); await tick();
 assert.equal(f.accepted.length, 1);
 await adapter.close();
 assert.deepEqual(f.counts(), { opens: 1, closes: 1, revokes: 0 });
});

test("only a versioned live open qualifies; malformed resources are closed", async () => {
 for (const cap of [undefined, { protocol: "wrong", open() { throw Error("must not open"); } }]) {
  const f = fixture();
  const adapter = createBackgroundContinuation({ ...f.options, context: { parentContinuation: cap } });
  assert.equal(adapter.status, "unavailable");
  adapter.observe(f.epoch, question("a")); await tick();
  assert.equal(f.accepted.length, 0);
  await adapter.close();
 }
 const f = fixture();
 Object.defineProperty(f.lease, "tryAccept", { value: null });
 const adapter = createBackgroundContinuation(f.options);
 assert.equal(adapter.status, "unavailable");
 assert.equal(f.counts().closes, 1);
 await adapter.dispose();
});

test("busy waits for a fresh idle edge even when more observations arrive", async () => {
 const f = fixture(); let attempts = 0;
 const original = f.lease.tryAccept;
 f.lease.tryAccept = function (...args) { attempts++; return Reflect.apply(original, this, args); };
 f.busy(true);
 const adapter = createBackgroundContinuation(f.options);
 adapter.observe(f.epoch, question("a")); await tick();
 adapter.observe(f.epoch, question("b")); await tick();
 assert.equal(attempts, 1);
 f.busy(false); f.idle(); await tick();
 assert.equal(attempts, 2);
 assert.equal(JSON.parse(f.accepted[0].content).items.length, 2);
 await adapter.close();
});

test("every capability and delivery callout is fenced, returned stale resources are cleaned", async () => {
 for (const stage of ["capability", "protocol", "open-get", "open", "onIdle", "validate", "canDeliver", "accept", "receipt-get"]) {
  const f = fixture();
  if (stage === "capability") Object.defineProperty(f.options.context, "parentContinuation", { get() { f.invalidate(); return f.capability; } });
  if (stage === "protocol") Object.defineProperty(f.capability, "protocol", { get() { f.invalidate(); return "pi-parent-continuation-v1"; } });
  if (stage === "open-get") { const open = f.capability.open; Object.defineProperty(f.capability, "open", { get() { f.invalidate(); return open; } }); }
  if (stage === "open") { const open = f.capability.open; f.capability.open = function () { const lease = Reflect.apply(open, this, []); f.invalidate(); return lease; }; }
  if (stage === "onIdle") { const onIdle = f.lease.onIdle; f.lease.onIdle = function (cb) { Reflect.apply(onIdle, this, [cb]); f.invalidate(); }; }
  if (stage === "validate") f.options.validateContextAndPlan = () => { f.invalidate(); return true; };
  if (stage === "canDeliver") f.options.canDeliver = () => { f.invalidate(); return true; };
  if (stage === "accept") { const accept = f.lease.tryAccept; f.lease.tryAccept = function (...args) { const result = Reflect.apply(accept, this, args); f.invalidate(); return result; }; }
  if (stage === "receipt-get") Object.defineProperty(f.receipt, "committed", { get() { f.invalidate(); return f.committed.promise; } });
  const adapter = createBackgroundContinuation(f.options);
  adapter.observe(f.epoch, question("a")); await tick(); f.idle(); await tick();
  assert.equal(f.accepted.length, ["accept", "receipt-get"].includes(stage) ? 1 : 0, stage);
  assert.equal(f.counts().opens, ["capability", "protocol", "open-get"].includes(stage) ? 0 : 1, stage);
  if (f.counts().opens) assert.equal(f.counts().closes, 1, stage);
  if (["accept", "receipt-get"].includes(stage)) assert.equal(f.counts().revokes, 1, stage);
  await adapter.dispose();
 }
});

test("unknown persistence is suppressed with recovery status; sticky overflow is announced only once", async () => {
 const f = fixture(); const statuses: string[] = [];
 const adapter = createBackgroundContinuation({ ...f.options, onStatus: status => { statuses.push(status); } });
 for (let i = 0; i < 17; i++) adapter.observe(f.epoch, question(String(i)));
 await tick();
 assert.equal(JSON.parse(f.accepted[0].content).omitted, true);
 f.committed.resolve("unknown");
 f.finished.resolve({ outcome: "error", commitState: "unknown", started: false });
 await tick();
 assert.equal(adapter.status, "recovery-required");
 assert.deepEqual(statuses, ["available", "recovery-required"]);
 f.idle(); await tick();
 assert.equal(f.accepted.length, 2, "remaining retained items still deliver");
 assert.equal(JSON.parse(f.accepted[1].content).omitted, false);
 f.idle(); await tick(); f.idle(); await tick();
 assert.equal(f.accepted.length, 2, "no empty omitted-only loop");
 await adapter.close();
});

test("receipt shape faults fail closed instead of retrying an unprovable batch", async () => {
 const f = fixture();
 const adapter = createBackgroundContinuation(f.options);
 adapter.observe(f.epoch, question("a")); await tick();
 f.finished.resolve({ outcome: "invalid", commitState: "none", started: false } as never);
 await tick(); f.idle(); await tick();
 assert.equal(adapter.status, "unavailable");
 assert.equal(f.accepted.length, 1);
 assert.equal(f.counts().closes, 1);
 await adapter.close();
});

test("promise method getters cannot cause a post-fence subscription", async () => {
 const f = fixture(); let subscriptions = 0;
 Object.defineProperty(f.receipt, "committed", { value: { get then() {
  f.invalidate();
  return () => { subscriptions++; };
 } } });
 const adapter = createBackgroundContinuation(f.options);
 adapter.observe(f.epoch, question("a")); await tick();
 assert.equal(subscriptions, 0);
 assert.equal(f.counts().revokes, 1);
 assert.equal(f.counts().closes, 1);
 await adapter.close();
});

test("idle while in flight cannot bank permission to retry a revoked batch", async () => {
 const f = fixture(); const adapter = createBackgroundContinuation(f.options);
 adapter.observe(f.epoch, question("a")); await tick();
 f.idle();
 f.committed.resolve("none");
 f.finished.resolve({ outcome: "revoked", commitState: "none", started: false });
 await tick();
 adapter.observe(f.epoch, question("b")); await tick();
 assert.equal(f.accepted.length, 1);
 f.idle(); await tick();
 assert.equal(f.accepted.length, 2);
 assert.equal(f.accepted[1].sequence, 2);
 await adapter.close();
});

test("retirement fences synchronously and returns a shared cleanup join without awaiting owned hooks", async () => {
 const f = fixture(); const drain = deferred<void>();
 Object.defineProperty(f.lease, "closed", { value: drain.promise });
 let callbackObserved = false;
 const original = f.lease.close;
 let adapter: ReturnType<typeof createBackgroundContinuation>;
 f.lease.close = function () {
  assert.equal(adapter.observe(f.epoch, question("late")), "wrong-epoch");
  void adapter.dispose(); // An owned hook must not await its own cleanup.
  callbackObserved = true;
  Reflect.apply(original, this, []);
 };
 adapter = createBackgroundContinuation({ ...f.options, onStatus() { throw Error("observer fault"); } });
 adapter.observe(f.epoch, question("a")); await tick();
 const join = adapter.close();
 assert.equal(callbackObserved, true);
 assert.equal(join, adapter.dispose());
 let joined = false; void join.then(() => { joined = true; });
 await tick(); assert.equal(joined, false);
 f.finished.resolve({ outcome: "revoked", commitState: "none", started: false });
 f.committed.resolve("none"); f.idle(); await tick();
 assert.equal(f.accepted.length, 1); assert.equal(f.counts().opens, 1);
 drain.resolve(); await join; assert.equal(f.counts().closes, 1);
});

test("finished historical commit suppresses replay before the committed promise arrives", async () => {
 const f = fixture(); const adapter = createBackgroundContinuation(f.options);
 adapter.observe(f.epoch, question("a")); await tick();
 f.finished.resolve({ outcome: "revoked", commitState: "committed", started: false });
 await tick(); f.idle(); await tick();
 adapter.observe(f.epoch, question("a", 2)); await tick();
 assert.equal(f.accepted.length, 1);
 f.committed.resolve("committed"); await tick(); f.idle(); await tick();
 assert.equal(f.accepted.length, 1);
 await adapter.close();
});

test("clear-question, state, wrong epochs and repeated notices never manufacture a wake", async () => {
 const f = fixture(); let validations = 0;
 const adapter = createBackgroundContinuation({ ...f.options, validateContextAndPlan() { validations++; return true; } });
 assert.equal(adapter.observe({}, question("foreign")), "wrong-epoch");
 adapter.observe(f.epoch, question("a"));
 adapter.observe(f.epoch, { ...question("a", 2), kind: "clear-question" });
 adapter.observe(f.epoch, { ...question("b"), kind: "state" });
 await tick(); f.idle(); await tick();
 assert.equal(f.accepted.length, 0); assert.equal(validations, 0);
 adapter.observe(f.epoch, question("c")); await tick();
 f.committed.resolve("committed"); f.finished.resolve({ outcome: "completed", commitState: "committed", started: true });
 await tick(); adapter.observe(f.epoch, question("c", 2)); f.idle(); await tick();
 assert.equal(f.accepted.length, 1);
 await adapter.close();
});

test("canonical validation can reject a reserved snapshot without consuming it", async () => {
 const f = fixture(); let allow = false;
 const adapter = createBackgroundContinuation({ ...f.options, canDeliver: batch => { assert.equal(batch.items[0].runId, "a"); return allow; } });
 adapter.observe(f.epoch, question("a")); await tick();
 assert.equal(f.accepted.length, 0);
 allow = true; f.idle(); await tick(); assert.equal(f.accepted.length, 1);
 await adapter.close();
});

test("large and small retained questions are fairly drained in bounded independent batches", async () => {
 const f = fixture(); const adapter = createBackgroundContinuation(f.options);
 for (let i = 0; i < 16; i++) adapter.observe(f.epoch, {
  ...question(`${i}-${"x".repeat(230)}`), taskId: "t".repeat(256), profile: "p".repeat(256),
  textPreview: i % 2 ? "small" : "界".repeat(512), taskPreview: "界".repeat(160),
 });
 await tick();
 f.committed.resolve("committed"); f.finished.resolve({ outcome: "completed", commitState: "committed", started: true });
 for (let i = 0; i < 16; i++) { await tick(); f.idle(); }
 await tick();
 const ids = f.accepted.flatMap(({ content }) => {
  assert.ok(Buffer.byteLength(content) <= 8192);
  const batch = JSON.parse(content);
  assert.ok(batch.items.length <= 8);
  assert.match(batch.instruction, /untrusted/);
  assert.ok(batch.items.every((item: { trust: string }) => item.trust === "raw-child-untrusted"));
  return batch.items.map((item: { runId: string }) => item.runId);
 });
 assert.equal(ids.length, 16); assert.equal(new Set(ids).size, 16);
 await adapter.close();
});

test("host closure never reopens or sends from old callbacks", async () => {
 const f = fixture(); const adapter = createBackgroundContinuation(f.options);
 f.closed.resolve(); await tick();
 adapter.observe(f.epoch, question("a")); f.idle(); await tick();
 assert.equal(adapter.status, "closed"); assert.equal(f.accepted.length, 0);
 assert.equal(f.counts().opens, 1); await adapter.close();
});

test("captured method receivers do not inspect function.call getters", async () => {
 const f = fixture();
 for (const fn of [f.capability.open, f.lease.tryAccept, f.lease.onIdle, f.lease.close, f.receipt.revoke]) {
  Object.defineProperty(fn, "call", { get() { throw Error("function.call must not be read"); } });
 }
 const adapter = createBackgroundContinuation(f.options);
 adapter.observe(f.epoch, question("a")); await tick();
 assert.equal(f.accepted.length, 1); await adapter.close();
});

test("stale and invalid acceptance, malformed receipt, and closed-shape faults latch unavailable", async () => {
 for (const fault of ["stale", "invalid", "receipt", "closed"]) {
  const f = fixture();
  if (fault === "closed") Object.defineProperty(f.lease, "closed", { value: 42 });
  else if (fault === "receipt") Object.defineProperty(f.receipt, "finished", { value: null });
  else f.lease.tryAccept = () => ({ status: fault });
  const adapter = createBackgroundContinuation(f.options);
  adapter.observe(f.epoch, question("a")); await tick(); f.idle(); await tick();
  assert.equal(adapter.status, "unavailable", fault);
  assert.equal(f.counts().closes, 1, fault);
  assert.equal(f.counts().opens, 1, fault);
  await adapter.close();
 }
});

test("an unsafe next sequence latches unavailable before host acceptance", async t => {
 const f = fixture(); const adapter = createBackgroundContinuation(f.options);
 adapter.observe(f.epoch, question("a"));
 // Inject arithmetic refusal at the standard numeric validation boundary rather than
 // attempting MAX_SAFE_INTEGER deliveries or adding a production counter test seam.
 const safe = Number.isSafeInteger;
 const stub = t.mock.method(Number, "isSafeInteger", (value: unknown) => value === 1 ? false : safe(value));
 await tick(); stub.mock.restore();
 assert.equal(adapter.status, "unavailable");
 assert.equal(f.accepted.length, 0); await adapter.close();
});

test("consumer validation getters are fenced before invoking their returned methods", async () => {
 for (const key of ["validateContextAndPlan", "canDeliver"] as const) {
  const f = fixture(); let calls = 0;
  Object.defineProperty(f.options, key, { get() { f.invalidate(); return () => { calls++; return true; }; } });
  const adapter = createBackgroundContinuation(f.options);
  adapter.observe(f.epoch, question("a")); await tick();
  assert.equal(calls, 0, key);
  assert.equal(f.accepted.length, 0);
  assert.equal(f.counts().closes, 1); await adapter.close();
 }
});

test("Plan refuses acceptance and receipt getter reentry without cancellation, then closes immediately after finish", async () => {
 for (const stage of ["accept", "receipt"] as const) {
  const f = fixture();
  let adapter!: ReturnType<typeof createBackgroundContinuation>;
  const check = () => {
   assert.equal(adapter.hasInFlight, true);
   assert.equal(adapter.closeForPlan(), false);
   assert.equal(f.counts().closes, 0);
  };
  const accept = f.lease.tryAccept;
  f.lease.tryAccept = function (...args) {
   if (stage === "accept") check();
   const result = Reflect.apply(accept, this, args);
   if (stage === "receipt") Object.defineProperty(result, "receipt", { get() { check(); return f.receipt; } });
   return result;
  };
  adapter = createBackgroundContinuation(f.options);
  assert.equal(adapter.hasInFlight, false);
  adapter.observe(f.epoch, question("a")); await tick();
  assert.equal(f.accepted.length, 1);
  assert.equal(adapter.hasInFlight, true);
  assert.equal(adapter.closeForPlan(), false);
  f.committed.resolve("committed");
  f.finished.resolve({ outcome: "completed", commitState: "committed", started: true });
  await tick();
  assert.equal(adapter.hasInFlight, false);
  assert.equal(adapter.closeForPlan(), true);
  assert.equal(f.counts().closes, 1);
  assert.equal(adapter.close(), adapter.closed);
  f.idle(); adapter.observe(f.epoch, question("late")); await tick();
  assert.equal(f.accepted.length, 1);
  await adapter.closed;
 }
});

test("retired and uncertain receipt resources remain owned until validated finish or lease cleanup", async () => {
 for (const fault of ["retired", "invalid-finish", "throw", "malformed", "stale-getter", "close-throw"] as const) {
  const f = fixture();
  f.lease.close = () => { if (fault === "close-throw") throw Error("close fault"); };
  if (fault === "throw") f.lease.tryAccept = () => { throw Error("uncertain accept"); };
  if (fault === "malformed") Object.defineProperty(f.receipt, "finished", { value: null });
  if (fault === "stale-getter") Object.defineProperty(f.receipt, "committed", { get() { f.invalidate(); return f.committed.promise; } });
  const adapter = createBackgroundContinuation(f.options);
  if (fault === "close-throw") {
   assert.equal(adapter.closeForPlan(), false);
   assert.equal(adapter.closeForPlan(), false);
  } else {
   adapter.observe(f.epoch, question("a")); await tick();
   const join = adapter.close();
   assert.equal(join, adapter.closed);
   assert.equal(adapter.hasInFlight, true, fault);
   assert.equal(adapter.closeForPlan(), false, fault);
   f.finished.resolve({ outcome: fault === "invalid-finish" ? "bad" : "revoked", commitState: "none", started: false } as never);
   await tick();
   assert.equal(adapter.hasInFlight, fault !== "retired", fault);
  }
  f.closed.resolve(); await adapter.closed; await tick();
  assert.equal(adapter.hasInFlight, false, fault);
 }
});

test("canonical stale pruning schedules valid siblings only on progress and never polls context failures", async () => {
 const f = fixture(); let validations = 0; let context = true;
 const adapter = createBackgroundContinuation({ ...f.options,
  validateContextAndPlan: () => context,
  canDeliver: batch => {
   validations++;
   const stale = batch.items.filter(item => item.kind === "question");
   return stale.length ? { stale } : true;
  },
 });
 for (let i = 0; i < 12; i++) adapter.observe(f.epoch, question(`stale-${i}`));
 adapter.observe(f.epoch, { ...question("done"), kind: "terminal", eventId: "done:terminal", status: "completed" });
 await tick();
 assert.equal(f.accepted.length, 1);
 assert.deepEqual(JSON.parse(f.accepted[0].content).items.map((item: {runId: string}) => item.runId), ["done"]);
 assert.ok(validations <= 4);
 await adapter.close();
 const g = fixture(); let checks = 0;
 const paused = createBackgroundContinuation({ ...g.options,
  validateContextAndPlan: () => { checks++; return context; },
  canDeliver: () => ({ stale: [] }),
 });
 context = false;
 paused.observe(g.epoch, question("keep")); await tick();
 assert.equal(checks, 1); assert.equal(g.accepted.length, 0);
 context = true; g.idle(); await tick();
 assert.equal(checks, 2); assert.equal(g.accepted.length, 0);
 await tick(); assert.equal(checks, 2, "zero progress must not schedule a retry");
 await paused.close();
});

test("acceptance method getters see occupancy before returning a resource-owning callout", async () => {
 const f = fixture();
 const adapter = createBackgroundContinuation(f.options);
 const accept = f.lease.tryAccept;
 let reads = 0;
 Object.defineProperty(f.lease, "tryAccept", { get() {
  reads++;
  assert.equal(adapter.hasInFlight, true);
  assert.equal(adapter.closeForPlan(), false);
  assert.equal(f.counts().closes, 0);
  return accept;
 } });
 adapter.observe(f.epoch, question("a")); await tick();
 assert.equal(reads, 1);
 assert.equal(f.accepted.length, 1);
 await adapter.close();
});

test("a faulty close handle cannot lose the opened lease cleanup join", async () => {
 const f = fixture();
 Object.defineProperty(f.lease, "close", { get() { throw Error("close getter fault"); } });
 const adapter = createBackgroundContinuation(f.options);
 assert.equal(adapter.status, "unavailable");
 assert.equal(adapter.hasInFlight, true, "opened resource has unproven cleanup");
 assert.equal(adapter.closeForPlan(), false);
 let joined = false;
 const join = adapter.close();
 void join.then(() => { joined = true; });
 await tick(); assert.equal(joined, false);
 f.closed.resolve(); await join;
 assert.equal(adapter.hasInFlight, false);
});
