import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { it } from "node:test";
import { BackgroundRunRegistry } from "../src/background-runs.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const input = { role: "coder", profile: "typescript", task: "Implement" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it("copies canonical input, owns unique IDs, and runs three jobs with a fourth queued", async () => {
  const gates = Array.from({ length: 4 }, () => deferred());
  const seen: string[] = [];
  const registry = new BackgroundRunRegistry(async (request) => {
    seen.push(request.input.task);
    await gates[seen.length - 1].promise;
    return { status: "completed", value: request.input.task };
  });
  const original = { ...input };
  const runs = Array.from({ length: 4 }, () => registry.start(original));
  original.task = "mutated";
  assert.deepEqual(seen, ["Implement", "Implement", "Implement"]);
  assert.equal(runs[3].status, "queued");
  assert.equal(new Set(runs.map(run => run.id)).size, 4);
  assert.throws(() => registry.start({ ...input, role: "architect" }), /role/i);
  assert.throws(() => registry.start({ member: "typescript-coder", task: "x" }), /canonical/i);
  assert.throws(() => registry.start({ ...input, task: "\0" }), /task/i);
  assert.ok(Object.isFrozen(registry.status(runs[0].id)));
  gates[0].resolve();
  await tick();
  assert.equal(seen[3], "Implement");
  gates.forEach(gate => gate.resolve());
  await tick();
  assert.equal(registry.status(runs[0].id).status, "completed");
  await registry.shutdown();
});

it("keeps simultaneous questions in original operations and wakes waits for any owned question", async () => {
  const begin = deferred();
  const answers: string[] = [];
  const registry = new BackgroundRunRegistry(async ({ input, ask }) => {
    await begin.promise;
    const answer = await ask(input.task);
    answers.push(`${input.task}:${answer}`);
    return { answer };
  });
  const a = registry.start(input);
  const b = registry.start({ ...input, task: "Review" });
  const waiting = registry.wait(a.id, 1000);
  begin.resolve();
  const event = await waiting;
  assert.equal(event.reason, "question");
  const qa = registry.status(a.id).question!;
  const qb = registry.status(b.id).question!;
  assert.notEqual(qa.id, qb.id);
  assert.throws(() => registry.reply(a.id, qb.id, "wrong"), /question/i);
  assert.throws(() => registry.reply(b.id, qb.id, "\0"), /text/i);
  registry.reply(b.id, qb.id, "second");
  registry.reply(a.id, qa.id, "first");
  assert.throws(() => registry.reply(a.id, qa.id, "duplicate"), /question/i);
  assert.equal((await registry.wait(a.id, 1000)).reason, "terminal");
  assert.deepEqual(answers, ["Review:second", "Implement:first"]);
  const gate = deferred();
  const other = new BackgroundRunRegistry(async () => { await gate.promise; });
  const target = other.start(input);
  const controller = new AbortController();
  const aborted = other.wait(target.id, 1000, controller.signal);
  controller.abort();
  assert.equal((await aborted).reason, "aborted");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal((await other.wait(target.id, 1)).reason, "timeout");
  assert.equal(other.status(target.id).status, "running");
  gate.resolve();
  await other.shutdown();
  await registry.shutdown();
});

it("cancels queued/awaiting runs without releasing slots until cleanup and closes shutdown atomically", async () => {
  const cleanup = deferred();
  let starts = 0;
  const registry = new BackgroundRunRegistry(async ({ ask }) => {
    starts++;
    try { await ask("Continue?"); } finally { await cleanup.promise; }
    return { status: "completed" };
  });
  const runs = Array.from({ length: 4 }, () => registry.start(input));
  const question = registry.status(runs[0].id).question!;
  registry.cancel(runs[3].id);
  registry.cancel(runs[0].id);
  assert.equal(registry.status(runs[0].id).status, "stopping");
  assert.throws(() => registry.reply(runs[0].id, question.id, "late"), /question/);
  await tick();
  assert.equal(registry.status(runs[3].id).status, "cancelled");
  assert.equal(starts, 3);
  let drained = false;
  const shutdown = registry.shutdown().then(() => { drained = true; });
  assert.throws(() => registry.start(input), /shut down/);
  await tick();
  assert.equal(drained, false);
  cleanup.resolve();
  await shutdown;
  assert.equal(starts, 3);
  assert.ok(registry.list().every(run => run.status === "cancelled"));
});

it("bounds retained JSON results, preserves originals by copy, and requires once-only consumption before release", async () => {
  const result = { status: "completed", nested: { value: 1 } };
  const registry = new BackgroundRunRegistry(async () => result, { records: 1, resultBytes: 128 });
  const run = registry.start(input);
  assert.throws(() => registry.release(run.id), /consumed/);
  await registry.wait(run.id, 1000);
  assert.throws(() => registry.start(input), /capacity/);
  const collected = registry.collect(run.id);
  assert.equal(collected.claimed, true);
  assert.equal(registry.collect(run.id).claimed, false);
  result.nested.value = 2;
  assert.deepEqual(collected.snapshot.result, { status: "completed", nested: { value: 1 } });
  assert.ok(Object.isFrozen((collected.snapshot.result as typeof result).nested));
  registry.release(run.id);
  assert.throws(() => registry.status(run.id), /Unknown/);
  await registry.shutdown();
  const oversized = new BackgroundRunRegistry(() => ({ text: "界".repeat(100) }), { resultBytes: 128 });
  const big = oversized.start(input);
  await oversized.wait(big.id, 1000);
  assert.equal(oversized.status(big.id).status, "failed");
  assert.match(oversized.status(big.id).error!, /result/i);
  assert.equal(oversized.status(big.id).result, undefined);
  await oversized.shutdown();
});

it("enforces question budgets and deadlines even when an adapter catches or abandons ask", async () => {
  const registry = new BackgroundRunRegistry(async ({ ask, signal }) => {
    try { await ask("Continue?"); } catch { /* adapter cannot erase timeout failure */ }
    assert.equal(signal.aborted, true);
    return { status: "completed" };
  }, { questionTimeoutMs: 5, lifetimeMs: 1000 });
  const run = registry.start(input);
  await tick();
  // Waiting runs are actionable, so polling terminal uses an event-loop turn rather than wait.
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(registry.status(run.id).status, "failed");
  assert.match(registry.status(run.id).error!, /question.*timeout/i);
  await registry.shutdown();

  const budget = new BackgroundRunRegistry(async ({ ask }) => {
    for (let i = 0; i < 9; i++) {
      try { await ask(`Question ${i}`); } catch { return { status: "completed" }; }
    }
  });
  const many = budget.start(input);
  for (let i = 0; i < 8; i++) {
    const question = budget.status(many.id).question!;
    budget.reply(many.id, question.id, "yes");
    await tick();
  }
  assert.equal(budget.status(many.id).status, "failed");
  assert.match(budget.status(many.id).error!, /question.*limit/i);
  await budget.shutdown();

  const abandoned = new BackgroundRunRegistry(({ ask }) => { void ask("forgotten"); return {}; });
  const lost = abandoned.start(input);
  await tick();
  assert.equal(abandoned.status(lost.id).status, "failed");
  assert.equal(abandoned.status(lost.id).question, undefined);
  await abandoned.shutdown();

  const cleanup = deferred();
  const lifetime = new BackgroundRunRegistry(async () => { await cleanup.promise; return {}; }, { lifetimeMs: 5 });
  const expiring = lifetime.start(input);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(lifetime.status(expiring.id).status, "stopping");
  cleanup.resolve();
  await tick();
  assert.equal(lifetime.status(expiring.id).status, "failed");
  await lifetime.shutdown();
});

it("shares exclusive work with the queue and shutdown joins its owned cleanup", async () => {
  const exclusiveGate = deferred();
  const jobGate = deferred();
  let started = false;
  let exclusiveSignal!: AbortSignal;
  const registry = new BackgroundRunRegistry(async () => { started = true; await jobGate.promise; });
  const exclusive = registry.runExclusive(async signal => { exclusiveSignal = signal; await exclusiveGate.promise; return 42; });
  const run = registry.start(input);
  assert.equal(run.status, "queued");
  assert.equal(started, false);
  await assert.rejects(registry.runExclusive(() => 0), /background/i);
  exclusiveGate.resolve();
  assert.equal(await exclusive, 42);
  assert.equal(started, true);
  await assert.rejects(registry.runExclusive(() => 0), /background/i);
  jobGate.resolve();
  await registry.wait(run.id, 1000);
  const cleanup = deferred();
  const last = registry.runExclusive(async signal => { exclusiveSignal = signal; await cleanup.promise; });
  let joined = false;
  const shutdown = registry.shutdown().then(() => { joined = true; });
  assert.equal(exclusiveSignal.aborted, true);
  await tick();
  assert.equal(joined, false);
  await assert.rejects(registry.runExclusive(() => 0), /shut down/i);
  cleanup.resolve();
  await Promise.all([last, shutdown]);
});

it("never promotes runner failure/cancellation or a late successful return into registry completion", async () => {
  for (const status of ["failed", "cancelled"] as const) {
    const original = { status, diagnostic: "original runner result" };
    const registry = new BackgroundRunRegistry(() => original);
    const run = registry.start(input);
    await registry.wait(run.id, 1000);
    assert.equal(registry.status(run.id).status, status);
    assert.deepEqual(registry.collect(run.id).snapshot.result, original);
    await registry.shutdown();
  }
  const gate = deferred();
  const registry = new BackgroundRunRegistry(async () => { await gate.promise; return { status: "completed", usage: 123 }; });
  const run = registry.start(input);
  registry.cancel(run.id);
  gate.resolve();
  await registry.wait(run.id, 1000);
  assert.equal(registry.status(run.id).status, "cancelled");
  assert.deepEqual(registry.status(run.id).result, { status: "completed", usage: 123 });
  await registry.shutdown();
});

it("rejects lossy/non-JSON results rather than fabricating a changed original", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const result of [{ value: NaN }, { value: undefined }, { value: () => 1 }, new Date(), cyclic, 1n]) {
    const registry = new BackgroundRunRegistry(() => result);
    const run = registry.start(input);
    await registry.wait(run.id, 1000);
    assert.equal(registry.status(run.id).status, "failed");
    assert.equal(registry.status(run.id).result, undefined);
    await registry.shutdown();
  }
});

it("rejects hidden or custom array payload properties instead of silently dropping them", async () => {
  let getterReads = 0;
  const getter = Object.defineProperty({}, "value", { enumerable: true, get() { getterReads++; return "dynamic"; } });
  for (const result of [
    Object.assign([], { diagnostic: "retain me" }),
    Object.defineProperty({}, "diagnostic", { value: "retain me" }),
    { nested: Object.assign([1], { diagnostic: "retain me" }) },
    getter,
  ]) {
    const registry = new BackgroundRunRegistry(() => result);
    try {
      const run = registry.start(input);
      await registry.wait(run.id, 1000);
      assert.equal(registry.status(run.id).status, "failed");
      assert.equal(registry.status(run.id).result, undefined);
    } finally { await registry.shutdown(); }
  }
  assert.equal(getterReads, 0);
  const original = { items: [1, { text: "retained" }, null], plain: Object.assign(Object.create(null), { ok: true }) };
  const registry = new BackgroundRunRegistry(() => original);
  try {
    const run = registry.start(input);
    await registry.wait(run.id, 1000);
    assert.equal(registry.status(run.id).status, "completed");
    assert.deepEqual(registry.status(run.id).result, { items: [1, { text: "retained" }, null], plain: { ok: true } });
  } finally { await registry.shutdown(); }
});

it("rejects root and nested proxy results before inspecting their payload", async () => {
  let payloadTraps = 0;
  const proxy = () => new Proxy({ diagnostic: "retain me" }, {
    get(_target, key) {
      if (key === "then") return undefined;
      payloadTraps++;
      return undefined;
    },
    getPrototypeOf() { payloadTraps++; return Object.prototype; },
  });
  for (const result of [proxy(), { nested: proxy() }]) {
    const registry = new BackgroundRunRegistry(() => result);
    try {
      const run = registry.start(input);
      await registry.wait(run.id, 1000);
      assert.equal(registry.status(run.id).status, "failed");
      assert.equal(registry.status(run.id).result, undefined);
    } finally { await registry.shutdown(); }
  }
  assert.equal(payloadTraps, 0);
});

it("returns per-run cancellation cleanup to its caller without waiting for siblings", async (t) => {
  const cleanup = deferred();
  const sibling = deferred();
  let index = 0;
  const registry = new BackgroundRunRegistry(async () => {
    await (++index === 1 ? cleanup.promise : sibling.promise);
  });
  t.after(async () => { cleanup.resolve(); sibling.resolve(); await registry.shutdown(); });
  const first = registry.start(input);
  registry.start(input);
  let joined = false;
  const cancel = Promise.resolve(registry.cancel(first.id)).then(() => { joined = true; });
  await tick();
  assert.equal(joined, false);
  cleanup.resolve();
  await cancel;
  assert.equal(registry.status(first.id).status, "cancelled");
  assert.equal(registry.list()[1].status, "running");
  sibling.resolve();
  await registry.shutdown();
});

it("holds idle admission with independent idempotent owner leases", async () => {
  const registry = new BackgroundRunRegistry(() => undefined);
  const owner = {};
  const first = registry.tryAcquirePlanHold(owner);
  assert.equal(first.kind, "held");
  if (first.kind !== "held") return;
  const repeated = registry.tryAcquirePlanHold(owner);
  assert.equal(repeated.kind, "held");
  if (repeated.kind !== "held") return;
  assert.equal(repeated.lease, first.lease);
  const second = registry.tryAcquirePlanHold({});
  assert.equal(second.kind, "held");
  if (second.kind !== "held") return;
  assert.throws(() => registry.start(input), /plan.*hold/i);
  await assert.rejects(registry.runExclusive(() => assert.fail("held operation launched")), /plan.*hold/i);
  assert.throws(() => registry.reply("unknown", "unknown", "yes"), /plan.*hold/i);
  first.lease.release();
  first.lease.release();
  assert.throws(() => registry.start(input), /plan.*hold/i);
  const renewed = registry.tryAcquirePlanHold(owner);
  assert.equal(renewed.kind, "held");
  if (renewed.kind !== "held") return;
  assert.notEqual(renewed.lease, first.lease);
  second.lease.release();
  first.lease.release();
  assert.throws(() => registry.start(input), /plan.*hold/i);
  renewed.lease.release();
  const run = registry.start(input);
  await registry.wait(run.id, 1000);
  const terminal = registry.tryAcquirePlanHold(owner);
  assert.equal(terminal.kind, "held", "retained terminal results are idle");
  await registry.shutdown();
  if (terminal.kind === "held") terminal.lease.release();
  assert.equal(registry.tryAcquirePlanHold(owner).kind, "unavailable");
  assert.throws(() => registry.start(input), /shut down/i);
  assert.throws(() => registry.reply(run.id, "unknown", "yes"), /shut down/i);
  await assert.rejects(registry.runExclusive(() => undefined), /shut down/i);
  const replacement = new BackgroundRunRegistry(() => undefined);
  const replacementHold = replacement.tryAcquirePlanHold(owner);
  assert.equal(replacementHold.kind, "held");
  renewed.lease.release();
  assert.throws(() => replacement.start(input), /plan.*hold/i);
  await replacement.shutdown();
});

it("refuses holds without disturbing active, queued, waiting or stopping cleanup", async (t) => {
  const cleanup = deferred();
  const signals: AbortSignal[] = [];
  const registry = new BackgroundRunRegistry(async ({ ask, signal }) => {
    signals.push(signal);
    try { await ask("Continue?"); } finally { await cleanup.promise; }
  });
  t.after(async () => { cleanup.resolve(); await registry.shutdown(); });
  const owner = {};
  const runs = Array.from({ length: 4 }, () => registry.start(input));
  assert.equal(registry.status(runs[0].id).status, "waiting");
  assert.equal(registry.status(runs[3].id).status, "queued");
  const before = registry.list();
  assert.deepEqual(registry.tryAcquirePlanHold(owner), { kind: "busy", outstanding: 4 });
  assert.deepEqual(registry.list(), before);
  assert.ok(signals.every(signal => !signal.aborted));
  const question = registry.status(runs[0].id).question!;
  registry.reply(runs[0].id, question.id, "yes");
  assert.equal(registry.status(runs[0].id).status, "running");
  assert.deepEqual(registry.tryAcquirePlanHold(owner), { kind: "busy", outstanding: 4 });
  const joins = runs.map(run => registry.cancel(run.id));
  await tick();
  assert.equal(registry.status(runs[3].id).status, "cancelled");
  assert.equal(registry.status(runs[0].id).status, "stopping");
  assert.deepEqual(registry.tryAcquirePlanHold(owner), { kind: "busy", outstanding: 3 });
  cleanup.resolve();
  await Promise.all(joins);
  const held = registry.tryAcquirePlanHold(owner);
  assert.equal(held.kind, "held");
  assert.throws(() => registry.start(input), /plan.*hold/i);
  if (held.kind === "held") held.lease.release();
});

it("counts an unbounded exclusive backlog before reentrant execution through failures and cleanup", async (t) => {
  const gate = deferred();
  const registry = new BackgroundRunRegistry(() => undefined);
  t.after(async () => { gate.resolve(); await registry.shutdown(); });
  const owner = {};
  let reentrant: ReturnType<BackgroundRunRegistry["tryAcquirePlanHold"]> | undefined;
  const active = registry.runExclusive(async () => {
    reentrant = registry.tryAcquirePlanHold(owner);
    await gate.promise;
  });
  assert.deepEqual(reentrant, { kind: "busy", outstanding: 1 });
  const order: number[] = [];
  const pending = Array.from({ length: 11 }, (_, index) => registry.runExclusive(() => { order.push(index); return index; }));
  const outcomes = Promise.allSettled(pending);
  await tick();
  assert.deepEqual(registry.tryAcquirePlanHold(owner), { kind: "busy", outstanding: 12 });
  const aborted = new AbortController();
  aborted.abort(new Error("pre-aborted"));
  await assert.rejects(registry.runExclusive(() => assert.fail("aborted launched"), aborted.signal), /pre-aborted/);
  assert.deepEqual(registry.tryAcquirePlanHold(owner), { kind: "busy", outstanding: 12 });
  gate.resolve();
  await active;
  assert.deepEqual(await outcomes, Array.from({ length: 11 }, (_, value) => ({ status: "fulfilled", value })));
  assert.deepEqual(order, Array.from({ length: 11 }, (_, index) => index));
  await assert.rejects(registry.runExclusive(() => { throw new Error("sync failure"); }), /sync failure/);
  await assert.rejects(registry.runExclusive(async () => { throw new Error("async failure"); }), /async failure/);
  const held = registry.tryAcquirePlanHold(owner);
  assert.equal(held.kind, "held", "all rejected and completed exclusive admissions were released");
  if (held.kind === "held") held.lease.release();
  assert.equal(await registry.runExclusive(() => 42), 42);

  const cleanup = deferred();
  t.after(() => cleanup.resolve());
  const last = registry.runExclusive(async signal => {
    signal.addEventListener("abort", () => {
      assert.equal(registry.tryAcquirePlanHold(owner).kind, "unavailable");
      assert.throws(() => registry.start(input), /shut down/i);
    });
    await cleanup.promise;
  });
  const queued = assert.rejects(registry.runExclusive(() => assert.fail("shutdown pending launched")), /shut down/i);
  const shutdown = registry.shutdown();
  cleanup.resolve();
  await Promise.all([last, queued, shutdown]);
  assert.equal(registry.tryAcquirePlanHold(owner).kind, "unavailable");
});

it("forwards synchronous exclusive phases under ownership before reentrant background admission", async (t) => {
  const gate = deferred();
  const phases: string[] = [];
  const holds: ReturnType<BackgroundRunRegistry["tryAcquirePlanHold"]>[] = [];
  const launched: string[] = [];
  const registry = new BackgroundRunRegistry(() => { launched.push("background"); });
  t.after(async () => { gate.resolve(); await registry.shutdown(); });
  let backgroundId: string | undefined;
  let refused: Promise<void> | undefined;
  const run = registry.runExclusive(async () => {
    launched.push("exclusive");
    holds.push(registry.tryAcquirePlanHold({}));
    await gate.promise;
    return 42;
  }, undefined, phase => {
    phases.push(phase);
    holds.push(registry.tryAcquirePlanHold({}));
    if (phase === "queued") {
      backgroundId = registry.start(input).id;
      refused = assert.rejects(registry.runExclusive(() => assert.fail("reentrant exclusive launched")), /background/i);
    }
    throw new Error("observer must not own settlement");
  });
  assert.deepEqual(phases, ["queued", "running"]);
  assert.deepEqual(holds, [
    { kind: "busy", outstanding: 1 },
    { kind: "busy", outstanding: 2 },
    { kind: "busy", outstanding: 2 },
  ]);
  assert.deepEqual(launched, ["exclusive"]);
  assert.equal(registry.status(backgroundId!).status, "queued");
  await refused;
  gate.resolve();
  assert.equal(await run, 42);
  assert.equal((await registry.wait(backgroundId!, 1000)).reason, "terminal");
  assert.deepEqual(launched, ["exclusive", "background"]);
  const held = registry.tryAcquirePlanHold({});
  assert.equal(held.kind, "held", "throwing observers must not leak exclusive ownership");
  if (held.kind === "held") held.lease.release();
});

it("releases exclusive ownership after synchronous phase cancellation without launching", async () => {
  for (const stopAt of ["queued", "running"]) {
    for (const stop of ["abort", "shutdown"]) {
      const registry = new BackgroundRunRegistry(() => undefined);
      const controller = new AbortController();
      const phases: string[] = [];
      const holds: ReturnType<BackgroundRunRegistry["tryAcquirePlanHold"]>[] = [];
      let launches = 0;
      let drain: Promise<void> | undefined;
      try {
        const run = registry.runExclusive(() => { launches++; }, controller.signal, phase => {
          phases.push(phase);
          holds.push(registry.tryAcquirePlanHold({}));
          if (phase !== stopAt) return;
          if (stop === "abort") controller.abort(new Error("phase cancellation"));
          else drain = registry.shutdown();
        });
        await assert.rejects(run, stop === "abort" ? /phase cancellation/ : /shut down/i);
        await drain;
        assert.equal(launches, 0);
        assert.deepEqual(phases, stopAt === "queued" ? ["queued"] : ["queued", "running"]);
        assert.ok(holds.every(hold => hold.kind === "busy" && hold.outstanding === 1));
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
        const hold = registry.tryAcquirePlanHold({});
        assert.equal(hold.kind, stop === "abort" ? "held" : "unavailable");
        if (hold.kind === "held") hold.lease.release();
      } finally { await registry.shutdown(); }
    }
  }
});

it("rechecks admission when input validation reentrantly acquires an idle hold", async (t) => {
  let starts = 0;
  const registry = new BackgroundRunRegistry(() => { starts++; });
  t.after(() => registry.shutdown());
  const owner = {};
  const value = { ...input, get task() {
    assert.equal(registry.tryAcquirePlanHold(owner).kind, "held");
    assert.throws(() => registry.start(input), /plan.*hold/i);
    return "Implement";
  } };
  assert.throws(() => registry.start(value), /plan.*hold/i);
  assert.equal(starts, 0);
  assert.deepEqual(registry.list(), []);
});

it("question lifetime cancellation fails only its pending invocation and detaches listeners", async () => {
  const first = new AbortController();
  const second = new AbortController();
  const cleanup = deferred();
  let rejected = false;
  const registry = new BackgroundRunRegistry(async ({ ask }) => {
    try {
      await ask("First?", first.signal);
      await ask("Second?", second.signal);
    } catch { rejected = true; }
    await cleanup.promise;
  });
  try {
    const run = registry.start(input);
    registry.reply(run.id, registry.status(run.id).question!.id, "yes");
    await tick();
    assert.equal(getEventListeners(first.signal, "abort").length, 0);
    first.abort();
    assert.equal(registry.status(run.id).status, "waiting");
    second.abort();
    await tick();
    assert.equal(rejected, true);
    assert.equal(registry.status(run.id).question, undefined);
    assert.equal(registry.status(run.id).status, "stopping");
    assert.equal(getEventListeners(second.signal, "abort").length, 0);
    cleanup.resolve();
    await tick();
    assert.equal(registry.status(run.id).status, "failed");
  } finally { cleanup.resolve(); await registry.shutdown(); }
});

it("already cancelled lifetimes and same-turn reply/cancellation races cannot strand questions", async () => {
  for (const order of ["already", "reply-first", "abort-first"] as const) {
    const lifetime = new AbortController();
    if (order === "already") lifetime.abort();
    let rejected = false;
    const registry = new BackgroundRunRegistry(async ({ ask }) => {
      try { await ask("Race?", lifetime.signal); } catch { rejected = true; }
    });
    try {
      const run = registry.start(input);
      const question = registry.status(run.id).question;
      if (order === "reply-first") {
        registry.reply(run.id, question!.id, "yes");
        lifetime.abort();
      } else if (order === "abort-first") {
        lifetime.abort();
        assert.throws(() => registry.reply(run.id, question!.id, "late"), /pending question/);
      }
      await tick();
      assert.equal(registry.status(run.id).question, undefined);
      assert.equal(registry.status(run.id).status, order === "reply-first" ? "completed" : "failed");
      assert.equal(rejected, order !== "reply-first");
      assert.equal(getEventListeners(lifetime.signal, "abort").length, 0);
    } finally { await registry.shutdown(); }
  }
});

it("reserves final identity before launch under tentative Plan ownership", async () => {
  let reserved = "", launched = "";
  const registry = new BackgroundRunRegistry(request => { launched = request.id; assert.equal(launched, reserved); }, {}, {
    beforeSchedule(request) {
      reserved = request.id;
      assert.ok(Object.isFrozen(request));
      assert.ok(Object.isFrozen(request.input));
      assert.deepEqual(registry.tryAcquirePlanHold({}), { kind: "busy", outstanding: 1 });
      assert.equal(launched, "");
    },
  });
  const run = registry.start(input);
  assert.equal(reserved, run.id);
  await registry.shutdown();
});

it("vetoes reservation throws, shutdown and caught nested admission without leaks", async () => {
  for (const action of ["throw", "shutdown", "nested"] as const) {
    let launches = 0, calls = 0;
    let drain: Promise<void> | undefined;
    const registry = new BackgroundRunRegistry(() => { launches++; }, {}, {
      beforeSchedule() {
        if (++calls > 1) return;
        if (action === "throw") throw Error("reserve fault");
        if (action === "shutdown") drain = registry.shutdown();
        if (action === "nested") { try { registry.start(input); } catch {} }
      },
    });
    assert.throws(() => registry.start(input), /reserve fault|shut down|Reentrant/);
    assert.equal(launches, 0);
    assert.deepEqual(registry.list(), []);
    await drain;
    const hold = registry.tryAcquirePlanHold({});
    assert.equal(hold.kind, action === "shutdown" ? "unavailable" : "held");
    if (hold.kind === "held") hold.lease.release();
    await registry.shutdown();
  }
});

it("awaits terminal publication before releasing active capacity, Plan ownership or terminal waits", async () => {
  const cleanup = deferred(), publication = deferred();
  let launches = 0, observations = 0;
  const registry = new BackgroundRunRegistry(async () => { launches++; await cleanup.promise; return { value: 1 }; }, {}, {
    async onTerminal(snapshot) {
      observations++;
      assert.ok(Object.isFrozen(snapshot));
      assert.ok(Object.isFrozen(snapshot.result));
      await publication.promise;
    },
  });
  try {
    const runs = Array.from({ length: 4 }, () => registry.start(input));
    cleanup.resolve(); await tick();
    assert.equal(observations, 3);
    assert.equal(launches, 3);
    assert.deepEqual(registry.tryAcquirePlanHold({}), { kind: "busy", outstanding: 4 });
    assert.equal((await registry.wait(runs[0].id, 1)).reason, "timeout");
    assert.throws(() => registry.collect(runs[0].id), /terminal/);
    publication.resolve();
    await registry.wait(runs[3].id, 1000);
    assert.equal(launches, 4);
    assert.equal(observations, 4);
  } finally { cleanup.resolve(); publication.resolve(); await registry.shutdown(); }
});

it("joins all publications after a persistence fault and retains uncollectable child evidence", async () => {
  const cleanup = deferred(), publication = deferred();
  let launches = 0, observed = 0;
  const registry = new BackgroundRunRegistry(async () => { launches++; await cleanup.promise; return { status: "completed", childClaim: "success" }; }, {}, {
    async onTerminal() { if (++observed === 1) throw Error("journal unavailable"); await publication.promise; },
  });
  const runs = Array.from({ length: 4 }, () => registry.start(input));
  let settled = false;
  const shutdown = registry.shutdown();
  const outcome = shutdown.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  try {
    await tick(); // queued cancellation publishes without running
    assert.equal(observed, 1);
    assert.equal(launches, 3);
    cleanup.resolve(); await tick();
    assert.equal(observed, 4);
    assert.equal(settled, false);
    assert.throws(() => registry.collect(runs[3].id), /persistence/i);
    publication.resolve();
    const error = await outcome;
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.match(registry.status(runs[3].id).error!, /Terminal persistence fault/);
    assert.equal(registry.status(runs[0].id).status, "cancelled");
    assert.equal((registry.status(runs[0].id).result as any).childClaim, "success");
  } finally { cleanup.resolve(); publication.resolve(); await outcome; }
});

it("observation pin: cancellation freezes after cleanup, not during runner cleanup", async () => {
  for (const cancelBeforeCleanup of [false, true]) {
    const cleanup = deferred(), publication = deferred();
    let signal!: AbortSignal, observed: string | undefined;
    const registry = new BackgroundRunRegistry(async request => { signal = request.signal; await cleanup.promise; return { status: "completed" }; }, {}, {
      async onTerminal(snapshot) { observed = snapshot.status; await publication.promise; },
    });
    try {
      const run = registry.start(input);
      let cancel: Promise<void> | undefined;
      if (cancelBeforeCleanup) cancel = registry.cancel(run.id);
      cleanup.resolve(); await tick();
      assert.equal(observed, cancelBeforeCleanup ? "cancelled" : "completed");
      cancel ??= registry.cancel(run.id);
      assert.equal(signal.aborted, cancelBeforeCleanup);
      assert.equal((await registry.wait(run.id, 1)).reason, "timeout");
      publication.resolve(); await cancel;
      assert.equal(registry.status(run.id).status, observed);
    } finally { cleanup.resolve(); publication.resolve(); await registry.shutdown(); }
  }
});

it("publication fault autonomously stops queued work and joins siblings", async () => {
  for (const queuedFault of [false, true]) {
    const cleanup = [deferred(), deferred(), deferred()], publication = deferred();
    const signals: AbortSignal[] = [], observed: string[] = [];
    let faultId = "";
    const registry = new BackgroundRunRegistry(async ({ signal }) => {
      const index = signals.push(signal) - 1;
      await cleanup[index]?.promise;
      return { child: "evidence" };
    }, {}, { async onTerminal(snapshot) {
      observed.push(snapshot.id);
      if (snapshot.id === faultId) throw Error("first persistence fault");
      await publication.promise;
    } });
    const runs = Array.from({ length: 4 }, () => registry.start(input));
    faultId = runs[queuedFault ? 3 : 0].id;
    let cancelled: Promise<unknown> | undefined;
    try {
      if (queuedFault) cancelled = registry.cancel(faultId).catch(error => error);
      else cleanup[0].resolve();
      await tick();
      assert.equal(signals.length, 3, "queued writer must never launch");
      assert.throws(() => registry.start(input), /shut down/);
      assert.ok(signals.slice(1).every(signal => signal.aborted));
      let joined = false;
      const outcome = registry.shutdown().catch(error => error).then(error => { joined = true; return error; });
      await tick();
      assert.equal(joined, false);
      cleanup.forEach(gate => gate.resolve());
      await tick();
      assert.equal(joined, false);
      assert.equal(observed.length, 4);
      assert.equal(new Set(observed).size, 4);
      publication.resolve();
      const error = await outcome;
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      assert.match(error.errors[0].message, /first persistence fault/);
      await cancelled;
    } finally {
      cleanup.forEach(gate => gate.resolve()); publication.resolve();
      await registry.shutdown().catch(() => {}); await cancelled;
    }
  }
});

it("queued cancellation retains pending capacity until publication finishes", async () => {
  const cleanup = deferred(), publication = deferred();
  let launches = 0, reservations = 0, observations = 0;
  const registry = new BackgroundRunRegistry(async () => { launches++; await cleanup.promise; }, {}, {
    beforeSchedule() { reservations++; },
    async onTerminal() { observations++; await publication.promise; },
  });
  try {
    const runs = Array.from({ length: 11 }, () => registry.start(input));
    const cancellations = runs.slice(3).flatMap(run => [registry.cancel(run.id), registry.cancel(run.id)]);
    await tick();
    assert.equal(observations, 8);
    assert.equal(launches, 3);
    assert.deepEqual(registry.tryAcquirePlanHold({}), { kind: "busy", outstanding: 11 });
    for (let i = 0; i < 20; i++) assert.throws(() => registry.start(input), /pending capacity/);
    assert.equal(reservations, 11);
    assert.equal(registry.list().length, 11);
    assert.equal((await registry.wait(runs[3].id, 1)).reason, "timeout");
    publication.resolve(); await Promise.all(cancellations);
    runs.slice(3).forEach(run => { registry.collect(run.id); registry.release(run.id); });
    const next = Array.from({ length: 8 }, () => registry.start(input));
    assert.ok(next.every(run => run.status === "queued"));
    assert.throws(() => registry.start(input), /pending capacity/);
    const shutdown = registry.shutdown();
    cleanup.resolve(); await shutdown;
    assert.equal(launches, 3);
    assert.equal(observations, 19);
  } finally { cleanup.resolve(); publication.resolve(); await registry.shutdown(); }
});
