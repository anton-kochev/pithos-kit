import assert from "node:assert/strict";
import { it } from "node:test";
import { getEventListeners } from "node:events";
import { BackgroundRunRegistry } from "../src/background-runs.ts";
import { GuildExecutionAuthority, type GuildOwner } from "../src/execution-authority.ts";

const input = { role: "coder", profile: "typescript", task: "Implement" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("uses opaque owners, rejects every stale facade call, and replaces only after actual drain", async (t) => {
  let factories = 0;
  const authority = new GuildExecutionAuthority(() => { factories++; return new BackgroundRunRegistry(() => {}); });
  const owner = authority.activate();
  assert.ok(Object.isFrozen(owner));
  const cleanup = deferred();
  t.after(async () => { cleanup.resolve(); await authority.shutdown(); });
  const running = authority.runExclusive(owner, async () => { await cleanup.promise; return "original"; });
  const queued = authority.runExclusive(owner, () => assert.fail("queued launch"));
  const rejected = assert.rejects(queued, /shut down/i);
  const retired = authority.retire(owner);
  assert.equal(authority.retire(owner), retired);
  assert.equal(authority.isCurrent(owner), false);
  assert.throws(() => authority.activate(), /retir/i);
  assert.equal(factories, 1);
  const hostile = new Proxy({}, { get() { assert.fail("owner properties read"); } }) as GuildOwner;
  for (const token of [owner, hostile, {} as GuildOwner]) {
    assert.throws(() => authority.start(token, input), /owner/i);
    assert.throws(() => authority.list(token), /owner/i);
    assert.throws(() => authority.status(token, "id"), /owner/i);
    assert.throws(() => authority.reply(token, "id", "q", "answer"), /owner/i);
    assert.throws(() => authority.collect(token, "id"), /owner/i);
    assert.throws(() => authority.release(token, "id"), /owner/i);
    assert.throws(() => authority.cancel(token, "id"), /owner/i);
    await assert.rejects(authority.wait(token, "id", 0), /owner/i);
    await assert.rejects(authority.runExclusive(token, () => {}), /owner/i);
  }
  cleanup.resolve();
  await retired;
  await rejected;
  assert.equal(await running, "original");
  assert.equal(factories, 1, "no automatic activation");
  const next = authority.activate();
  assert.notEqual(next, owner);
  assert.throws(() => authority.retire(owner), /owner/i);
  assert.equal(authority.isCurrent(next), true);
  await authority.shutdown();
  assert.throws(() => authority.activate(), /closed/i);
});

it("fails closed on invalid factory transfer and joins reentrant shutdown before publication", async () => {
  for (const make of [() => { throw Error("factory"); }, () => ({}), () => Promise.resolve({})]) {
    const a = new GuildExecutionAuthority(make as () => BackgroundRunRegistry);
    assert.throws(() => a.activate());
    assert.throws(() => a.activate(), /closed/);
    await a.shutdown();
  }
  const shared = new BackgroundRunRegistry(() => {});
  const first = new GuildExecutionAuthority(() => shared);
  const owner = first.activate();
  const second = new GuildExecutionAuthority(() => shared);
  assert.throws(() => second.activate(), /claimed|reuse/i);
  assert.equal(await first.runExclusive(owner, () => 42), 42);
  await second.shutdown();
  await first.retire(owner);
  assert.throws(() => first.activate(), /claimed|reuse/i);
  await first.shutdown();

  for (const kind of ["closed", "busy", "records"] as const) {
    const gate = deferred();
    const registry = new BackgroundRunRegistry(() => gate.promise);
    if (kind === "closed") await registry.shutdown();
    if (kind === "busy") registry.start(input);
    if (kind === "records") { gate.resolve(); const run = registry.start(input); await registry.wait(run.id, 1000); }
    const a = new GuildExecutionAuthority(() => registry);
    try {
      assert.throws(() => a.activate(), /fresh|idle|closed|record/i);
      assert.throws(() => registry.start(input), /shut down/);
    } finally { gate.resolve(); await a.shutdown(); }
  }

  let joined!: Promise<void>;
  let candidate!: BackgroundRunRegistry;
  const a: GuildExecutionAuthority = new GuildExecutionAuthority(() => {
    assert.throws(() => a.activate(), /activating/);
    joined = a.shutdown();
    assert.equal(a.shutdown(), joined);
    candidate = new BackgroundRunRegistry(() => {});
    return candidate;
  });
  assert.throws(() => a.activate(), /closed/);
  await joined;
  assert.throws(() => candidate.start(input), /shut down/);
  assert.throws(() => a.activate(), /closed/);
});

it("bridges stable multiowner Plan holds across empty periods and registry generations", async (t) => {
  const registries: BackgroundRunRegistry[] = [];
  let duringFactory: unknown;
  const a: GuildExecutionAuthority = new GuildExecutionAuthority(() => {
    duringFactory = a.planParticipant.tryAcquire({});
    const registry = new BackgroundRunRegistry(() => {});
    registries.push(registry);
    return registry;
  });
  const participant = a.planParticipant;
  assert.ok(Object.isFrozen(participant));
  assert.ok(Object.isFrozen(participant.instance));
  const planOwner = {};
  const first = participant.tryAcquire(planOwner);
  assert.equal(first.kind, "held");
  if (first.kind !== "held") return;
  assert.equal(participant.tryAcquire(planOwner).kind, "held");
  const repeat = participant.tryAcquire(planOwner);
  if (repeat.kind === "held") assert.equal(repeat.lease, first.lease);
  let owner = a.activate();
  assert.equal((duringFactory as {kind: string}).kind, "unavailable");
  assert.throws(() => registries[0].start(input), /Plan hold/);
  await assert.rejects(a.runExclusive(owner, () => {}), /Plan hold/);
  const second = participant.tryAcquire({});
  assert.equal(second.kind, "held");
  first.lease.release();
  const renewed = participant.tryAcquire(planOwner);
  assert.equal(renewed.kind, "held");
  first.lease.release();
  if (second.kind === "held") second.lease.release();
  assert.throws(() => a.start(owner, input), /Plan hold/);
  const retiring = a.retire(owner);
  assert.equal(participant.tryAcquire({}).kind, "unavailable");
  assert.equal(participant.tryAcquire(planOwner).kind, "held");
  await retiring;
  owner = a.activate();
  assert.equal(a.planParticipant, participant);
  assert.throws(() => registries[1].start(input), /Plan hold/);
  if (renewed.kind === "held") renewed.lease.release();
  const gate = deferred();
  t.after(async () => { gate.resolve(); await a.shutdown(); });
  const run = a.runExclusive(owner, () => gate.promise);
  assert.deepEqual(participant.tryAcquire({}), {kind: "busy", outstanding: 1});
  gate.resolve(); await run;
  const record = a.start(owner, input);
  await a.wait(owner, record.id, 1000);
  const terminalHold = participant.tryAcquire({});
  assert.equal(terminalHold.kind, "held");
  await a.cancel(owner, record.id);
  await a.shutdown();
  assert.equal(participant.tryAcquire(planOwner).kind, "unavailable");
  if (terminalHold.kind === "held") terminalHold.lease.release();
  assert.throws(() => registries[1].start(input), /shut down/);
});

it("wakes observational waits on retirement, rejects stale delivery, and preserves acquired cancel joins", async (t) => {
  const cleanup = deferred();
  let aborted = false;
  const a = new GuildExecutionAuthority(() => new BackgroundRunRegistry(async ({signal}) => {
    signal.addEventListener("abort", () => { aborted = true; }, {once: true});
    await cleanup.promise;
  }));
  t.after(async () => { cleanup.resolve(); await a.shutdown(); });
  const owner = a.activate();
  const run = a.start(owner, input);
  const caller = new AbortController();
  const observation = a.wait(owner, run.id, 10_000, caller.signal);
  caller.abort();
  assert.equal((await observation).reason, "aborted");
  assert.equal(aborted, false);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  const nextCaller = new AbortController();
  const waiting = a.wait(owner, run.id, 10_000, nextCaller.signal);
  const stale = assert.rejects(waiting, /owner/i);
  const cancel = a.cancel(owner, run.id);
  const retired = a.retire(owner);
  try {
    await Promise.race([stale, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error("wait did not wake promptly")), 100);
      void stale.finally(() => clearTimeout(timer));
    })]);
    assert.equal(getEventListeners(nextCaller.signal, "abort").length, 0);
    let settled = false;
    void cancel.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
  } finally { cleanup.resolve(); await cancel; await retired; }
  const next = a.activate();
  const completed = a.start(next, input);
  await a.wait(next, completed.id, 1000);
  const immediate = a.wait(next, completed.id, 0);
  const shutdown = a.shutdown();
  await assert.rejects(immediate, /owner/i);
  await shutdown;
});

it("latches joins before abort callbacks and stays terminal after unprovable drain", async (t) => {
  for (const failure of ["sync", "async"] as const) {
    class BrokenDrain extends BackgroundRunRegistry {
      override shutdown(): Promise<void> {
        if (failure === "sync") throw Error("cleanup failure");
        return Promise.reject(Error("cleanup failure"));
      }
    }
    const a = new GuildExecutionAuthority(() => new BrokenDrain(() => {}));
    const owner = a.activate();
    const join = a.retire(owner);
    await assert.rejects(join, /cleanup failure/);
    assert.equal(a.retire(owner), join);
    assert.throws(() => a.activate(), /closed/);
    await assert.rejects(a.shutdown(), /cleanup failure/);
  }
  const gate = deferred();
  const a = new GuildExecutionAuthority(() => new BackgroundRunRegistry(() => {}));
  t.after(async () => { gate.resolve(); await a.shutdown(); });
  const owner = a.activate();
  let reentered!: Promise<void>;
  let shutdown!: Promise<void>;
  const run = a.runExclusive(owner, async signal => {
    signal.addEventListener("abort", () => {
      reentered = a.retire(owner);
      shutdown = a.shutdown();
      assert.equal(a.shutdown(), shutdown);
    }, {once: true});
    await gate.promise;
    throw Error("original error");
  });
  const rejected = assert.rejects(run, /original error/);
  const retiring = a.retire(owner);
  assert.equal(reentered, retiring);
  assert.throws(() => a.activate(), /closed/);
  gate.resolve();
  await retiring; await shutdown; await rejected;
  assert.throws(() => a.activate(), /closed/);
});

it("retirement fences phase and input reentry and joins every nonterminal background state", async () => {
  for (const phase of ["queued", "running"] as const) {
    const a = new GuildExecutionAuthority(() => new BackgroundRunRegistry(() => {}));
    const owner = a.activate();
    let join: Promise<void> | undefined;
    let launches = 0;
    try {
      const run = a.runExclusive(owner, () => { launches++; }, undefined, observed => {
        if (observed === phase) join = a.retire(owner);
      });
      await assert.rejects(run, /shut down/);
      await join;
      assert.equal(launches, 0);
    } finally { await a.shutdown(); }
  }
  for (const action of ["retire", "hold"] as const) {
    const a = new GuildExecutionAuthority(() => new BackgroundRunRegistry(() => assert.fail("getter launched work")));
    const owner = a.activate();
    let join: Promise<void> | undefined;
    try {
      assert.throws(() => a.start(owner, { ...input, get task() {
        if (action === "retire") join = a.retire(owner);
        else assert.equal(a.planParticipant.tryAcquire({}).kind, "held");
        return "Reentrant input";
      } }), /shut down|Plan hold/);
      await join;
    } finally { await a.shutdown(); }
  }
  const cleanup = deferred();
  let launches = 0;
  let factories = 0;
  const a = new GuildExecutionAuthority(() => {
    factories++;
    return new BackgroundRunRegistry(async ({ ask }) => {
      launches++;
      try { if (launches === 1) await ask("Question?"); }
      finally { await cleanup.promise; }
    });
  });
  const owner = a.activate();
  let join: Promise<void> | undefined;
  try {
    const waiting = a.start(owner, input);
    const running = a.start(owner, input);
    const stopping = a.start(owner, input);
    const queued = a.start(owner, input);
    const cancel = a.cancel(owner, stopping.id);
    assert.deepEqual([waiting.id, running.id, stopping.id, queued.id].map(id => a.status(owner, id).status),
      ["waiting", "running", "stopping", "queued"]);
    assert.deepEqual(a.planParticipant.tryAcquire({}), { kind: "busy", outstanding: 4 });
    join = a.retire(owner);
    let settled = false;
    void join.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.throws(() => a.activate(), /retiring/);
    assert.equal(a.planParticipant.tryAcquire({}).kind, "unavailable");
    assert.equal(launches, 3);
    cleanup.resolve();
    await join;
    await cancel;
    assert.equal(launches, 3, "queued background work never launches");
    assert.equal(factories, 1);
    const next = a.activate();
    assert.equal(a.isCurrent(next), true);
  } finally { cleanup.resolve(); await join; await a.shutdown(); }
});

it("suppresses retained phase observations after replacement and drains transferred thenables", async () => {
  let observer: ((phase: "queued" | "running") => void) | undefined;
  class ObservedRegistry extends BackgroundRunRegistry {
    override runExclusive<T>(operation: (signal: AbortSignal) => T | PromiseLike<T>, signal?: AbortSignal,
      onPhase?: (phase: "queued" | "running") => void): Promise<T> {
      observer = onPhase;
      return super.runExclusive(operation, signal, onPhase);
    }
  }
  const a = new GuildExecutionAuthority(() => new ObservedRegistry(() => {}));
  try {
    const owner = a.activate();
    const phases: string[] = [];
    await a.runExclusive(owner, () => {}, undefined, phase => phases.push(phase));
    assert.deepEqual(phases, ["queued", "running"]);
    await a.retire(owner);
    const next = a.activate();
    observer?.("running");
    assert.deepEqual(phases, ["queued", "running"]);
    assert.equal(a.isCurrent(next), true);
  } finally { await a.shutdown(); }

  const candidate = Object.assign(new BackgroundRunRegistry(() => {}), { then() { assert.fail("thenable assimilated"); } });
  const invalid = new GuildExecutionAuthority(() => candidate);
  assert.throws(() => invalid.activate(), /thenable/);
  await invalid.shutdown();
  assert.throws(() => candidate.start(input), /shut down/);
  assert.throws(() => invalid.activate(), /closed/);
});
