import assert from "node:assert/strict";
import { test } from "node:test";
import { BackgroundRunRegistry } from "../src/background-runs.ts";
import { GuildExecutionAuthority } from "../src/execution-authority.ts";
import { createGuildBackgroundAdmission, readPersistedPlanState } from "../src/background-admission.ts";

const input = { role: "coder", profile: "typescript", task: "Implement" };
const context = { getBranch: () => [] };
const silent = { emit() {} };

test("captures exact parent policy once; silence requires explicit standalone", async () => {
 for (const value of [undefined, "required", "standalone", "", " ", "Required", " standalone", null, false, 1, {}]) {
  let reads = 0;
  let launches = 0;
  const authority = new GuildExecutionAuthority(() => new BackgroundRunRegistry(() => { launches++; }));
  const owner = authority.activate();
  const environment = { get PITHOS_GUILD_PLAN_MODE() { reads++; return value; } };
  const admission = createGuildBackgroundAdmission({ authority, bus: silent, parentEnvironment: environment });
  assert.ok(Object.isFrozen(admission));
  assert.equal(reads, 1);
  try {
   if (value === "standalone") {
    const run = admission.start(owner, input, context);
    await authority.wait(owner, run.id, 1000);
    assert.equal(launches, 1);
   } else {
    assert.throws(() => admission.start(owner, input, context));
    assert.deepEqual(authority.list(owner), []);
    assert.equal(launches, 0);
   }
   assert.equal(reads, 1);
  } finally { await authority.shutdown(); }
 }
});

test("captures throwing and mutable environments without disabling construction", async () => {
 const authority = new GuildExecutionAuthority(() => new BackgroundRunRegistry(() => {}));
 const owner = authority.activate();
 try {
  const broken = createGuildBackgroundAdmission({ authority, bus: silent, parentEnvironment: { get PITHOS_GUILD_PLAN_MODE() { throw Error("environment"); } } });
  assert.throws(() => broken.start(owner, input, context), /configuration/);
  const env = { PITHOS_GUILD_PLAN_MODE: "standalone" };
  const captured = createGuildBackgroundAdmission({ authority, bus: silent, parentEnvironment: env });
  env.PITHOS_GUILD_PLAN_MODE = "invalid";
  const run = captured.start(owner, input, context);
  await authority.wait(owner, run.id, 1000);
  const previous = process.env.PITHOS_GUILD_PLAN_MODE;
  try {
   process.env.PITHOS_GUILD_PLAN_MODE = "standalone";
   const defaults = createGuildBackgroundAdmission({ authority, bus: silent });
   process.env.PITHOS_GUILD_PLAN_MODE = "required";
   const next = defaults.start(owner, input, context);
   await authority.wait(owner, next.id, 1000);
  } finally {
   if (previous === undefined) delete process.env.PITHOS_GUILD_PLAN_MODE;
   else process.env.PITHOS_GUILD_PLAN_MODE = previous;
  }
 } finally { await authority.shutdown(); }
});

test("snapshots canonical input once before discovery and vetoes nested starts even if caught", async () => {
 let received: unknown;
 const authority = new GuildExecutionAuthority(() => new BackgroundRunRegistry(request => { received = request.input; }));
 const owner = authority.activate();
 let reads = 0;
 const raw = { ...input, get task() { reads++; return "original"; } };
 let discoveries = 0;
 const admission = createGuildBackgroundAdmission({ authority, parentEnvironment: { PITHOS_GUILD_PLAN_MODE: "standalone" }, bus: { emit() {
  discoveries++;
  Object.defineProperty(raw, "task", { value: "changed" });
 } } });
 try {
  const run = admission.start(owner, raw, context);
  await authority.wait(owner, run.id, 1000);
  assert.equal(reads, 1);
  assert.equal((received as typeof input).task, "original");
  for (const invalid of [{ member: "typescript-coder", task: "x" }, { ...input, mode: "standalone" }, { ...input, role: "explorer" }]) {
   assert.throws(() => admission.start(owner, invalid, context));
  }
  assert.equal(discoveries, 1);
  const nested = createGuildBackgroundAdmission({ authority, bus: silent, parentEnvironment: { PITHOS_GUILD_PLAN_MODE: "standalone" } });
  const count = authority.list(owner).length;
  assert.throws(() => nested.start(owner, { ...input, get task() {
   assert.throws(() => nested.start(owner, input, context), /reentr/i);
   return "outer";
  } }, context), /reentr/i);
  assert.equal(authority.list(owner).length, count);
 } finally { await authority.shutdown(); }
});

const persisted = (active: unknown) => ({ type: "custom", customType: "plan-theme-state", data: { active } });
test("rejects unsafe relevant persistence without evaluating accessors or unrelated message contents", async () => {
 const authority = new GuildExecutionAuthority(() => new BackgroundRunRegistry(() => assert.fail("launch")));
 const owner = authority.activate();
 const admission = createGuildBackgroundAdmission({ authority, bus: silent, parentEnvironment: { PITHOS_GUILD_PLAN_MODE: "standalone" } });
 let getterCalls = 0;
 const accessor = { get active() { getterCalls++; return false; } };
 const unsafe: unknown[] = [null, {}, Promise.resolve([]), [persisted(true)], [persisted("false")],
  [{ ...persisted(false), data: accessor }], new Proxy([], {}), [new Proxy(persisted(false), {})],
  [{ get type() { getterCalls++; return "message"; } }],
  Object.assign([], { then() {} }), [{ ...persisted(false), data: new Proxy({ active: false }, {}) }]];
 try {
  for (const branch of unsafe) assert.throws(() => admission.start(owner, input, { getBranch: () => branch as unknown[] }));
  assert.throws(() => admission.start(owner, input, { getBranch() { throw Error("branch"); } }));
  assert.equal(getterCalls, 0);
  assert.deepEqual(authority.list(owner), []);
 } finally { await authority.shutdown(); }
});

test("rechecks persisted inactivity after discovery and ignores unrelated data payloads", async () => {
 let branch: unknown[] = [];
 const authority = new GuildExecutionAuthority(() => new BackgroundRunRegistry(() => {}));
 const owner = authority.activate();
 const admission = createGuildBackgroundAdmission({ authority, parentEnvironment: { PITHOS_GUILD_PLAN_MODE: "standalone" }, bus: { emit() { branch = [persisted(true)]; } } });
 try {
  assert.throws(() => admission.start(owner, input, { getBranch: () => branch }));
  assert.deepEqual(authority.list(owner), []);
  const safe = createGuildBackgroundAdmission({ authority, bus: silent, parentEnvironment: { PITHOS_GUILD_PLAN_MODE: "standalone" } });
  const run = safe.start(owner, input, { getBranch: () => [{ type: "message", get data() { return assert.fail("unrelated payload read"); } }, persisted(false)] });
  await authority.wait(owner, run.id, 1000);
 } finally { await authority.shutdown(); }
});

import { createPlanCoordinator } from "../../pithos.plan/extensions/plan-coordination.ts";
import type { CoordinationBus } from "../src/plan-coordination.ts";
function inactiveCoordinator() {
 const coordinator = createPlanCoordinator();
 coordinator.confirmInactive(coordinator.provider.inspect().generation);
 return coordinator;
}
test("required admission attaches the stable participant and rejects final generation drift", async () => {
 for (const drift of [false, true]) {
  const coordinator = inactiveCoordinator();
  const authority = new GuildExecutionAuthority(() => new BackgroundRunRegistry(() => {}));
  const owner = authority.activate();
  const admission = createGuildBackgroundAdmission({ authority, parentEnvironment: {}, bus: { emit(_channel, request) { request.reply(coordinator.provider); } } });
  let branches = 0;
  try {
   const ctx = { getBranch() {
    if (++branches === 2 && drift) coordinator.confirmInactive(coordinator.provider.inspect().generation);
    return [];
   } };
   if (drift) {
    assert.throws(() => admission.start(owner, input, ctx));
    assert.deepEqual(authority.list(owner), []);
   } else {
    const run = admission.start(owner, input, ctx);
    assert.equal(coordinator.transition(coordinator.provider.inspect().generation, "active").kind, "blocked");
    await authority.wait(owner, run.id, 1000);
    assert.equal(coordinator.transition(coordinator.provider.inspect().generation, "active").kind, "ok");
   }
  } finally { await authority.shutdown(); }
 }
});

test("provider conflicts, uncertain phases and faulty handshakes never reserve work", async () => {
 for (const mode of ["required", "standalone"]) {
  for (const kind of ["duplicate", "late", "incompatible", "thenable", "throw", "active", "initializing", "faulted", "generation", "attach-thenable", "state-accessor", "provider-accessor", "final-accessor", "identity"]) {
   const c = inactiveCoordinator();
   const authority = new GuildExecutionAuthority(() => new BackgroundRunRegistry(() => assert.fail("launch")));
   const owner = authority.activate();
   let inspections = 0;
   let provider: unknown = c.provider;
   if (kind === "active") c.transition(c.provider.inspect().generation, "active");
   if (kind === "initializing") provider = createPlanCoordinator().provider;
   if (kind === "faulted") { c.provider.attachParticipant({ instance: {}, tryAcquire() { throw Error("fault"); } }); c.transition(c.provider.inspect().generation, "active"); }
   if (kind === "incompatible") provider = { ...c.provider, version: 2 };
   if (kind === "thenable") provider = { ...c.provider, then() {} };
   if (kind === "provider-accessor") provider = { ...c.provider, get instance() { assert.fail("getter"); return {}; } };
   if (["generation", "attach-thenable"].includes(kind)) provider = { ...c.provider, attachParticipant(participant: Parameters<typeof c.provider.attachParticipant>[0]) {
    const attached = c.provider.attachParticipant(participant);
    if (kind === "generation") c.confirmInactive(c.provider.inspect().generation);
    return kind === "attach-thenable" ? Promise.resolve(attached) : attached;
   } };
   if (["state-accessor", "final-accessor", "identity"].includes(kind)) provider = { ...c.provider, inspect() {
    inspections++;
    if (kind === "identity") return { ...c.provider.inspect(), instance: {} };
    if (kind === "state-accessor" || inspections === 3) return { ...c.provider.inspect(), get phase() { assert.fail("getter"); return "inactive"; } };
    return c.provider.inspect();
   } };
   const bus: CoordinationBus = { emit(_channel, request) {
    if (kind === "late") { queueMicrotask(() => request.reply(provider)); return; }
    request.reply(provider);
    if (kind === "duplicate") request.reply(provider);
    if (kind === "throw") throw Error("dispatch");
   } };
   const admission = createGuildBackgroundAdmission({ authority, bus, parentEnvironment: { PITHOS_GUILD_PLAN_MODE: mode } });
   try {
    // Standalone with only a late reply is deliberately indistinguishable from silence.
    if (mode === "standalone" && kind === "late") continue;
    assert.throws(() => admission.start(owner, input, context), Error, `${mode}/${kind}`);
    assert.deepEqual(authority.list(owner), []);
   } finally { await authority.shutdown(); }
  }
 }
});

test("reentrant parent callbacks cannot bypass veto, holds, or owner invalidation", async () => {
 for (const stage of ["input", "branch", "emit", "inspect", "attach"] as const) {
  for (const action of ["nested", "hold", "retire", "shutdown", "active", "generation"] as const) {
   const c = inactiveCoordinator();
   const registry = new BackgroundRunRegistry(() => assert.fail("launch"));
   const authority = new GuildExecutionAuthority(() => registry);
   const owner = authority.activate();
   let acted = false;
   let admission: ReturnType<typeof createGuildBackgroundAdmission<undefined>>;
   let branch: unknown[] = [];
   const act = () => {
    if (acted) return;
    acted = true;
    if (action === "nested") assert.throws(() => admission.start(owner, input, context), /reentr/i);
    if (action === "hold") authority.planParticipant.tryAcquire({});
    if (action === "retire") void authority.retire(owner);
    if (action === "shutdown") void authority.shutdown();
    if (action === "active") { branch = [persisted(true)]; c.transition(c.provider.inspect().generation, "active"); }
    if (action === "generation") c.confirmInactive(c.provider.inspect().generation);
   };
   const provider = { ...c.provider,
    inspect() { const state = c.provider.inspect(); if (stage === "inspect") act(); return state; },
    attachParticipant(participant: Parameters<typeof c.provider.attachParticipant>[0]) { const result = c.provider.attachParticipant(participant); if (stage === "attach") act(); return result; },
   };
   admission = createGuildBackgroundAdmission({ authority, parentEnvironment: {}, bus: { emit(_channel, request) { if (stage === "emit") act(); request.reply(provider); } } });
   try {
    // A generation changed before the first handshake is its baseline, not drift.
    if (action === "generation" && ["input", "branch", "emit"].includes(stage)) continue;
    const raw = { ...input, get task() { if (stage === "input") act(); return input.task; } };
    assert.throws(() => admission.start(owner, raw, { getBranch() { if (stage === "branch") act(); return branch; } }), Error, `${stage}/${action}`);
    assert.deepEqual(registry.list(), [], `${stage}/${action}`);
   } finally { await authority.shutdown(); }
  }
 }
});

test("independent holds survive rejected starts in either mode and stale owners never read inputs", async () => {
 const authority = new GuildExecutionAuthority(() => new BackgroundRunRegistry(() => {}));
 const owner = authority.activate();
 const first = authority.planParticipant.tryAcquire({});
 const second = authority.planParticipant.tryAcquire({});
 assert.equal(first.kind, "held"); assert.equal(second.kind, "held");
 try {
  for (const mode of ["required", "standalone"]) {
   const c = inactiveCoordinator();
   const admission = createGuildBackgroundAdmission({ authority, parentEnvironment: { PITHOS_GUILD_PLAN_MODE: mode }, bus: mode === "required" ? { emit(_channel, request) { request.reply(c.provider); } } : silent });
   assert.throws(() => admission.start(owner, input, context), /hold/);
  }
  if (first.kind === "held") first.lease.release();
  const admission = createGuildBackgroundAdmission({ authority, parentEnvironment: { PITHOS_GUILD_PLAN_MODE: "standalone" }, bus: silent });
  assert.throws(() => admission.start(owner, input, context), /hold/);
  if (second.kind === "held") second.lease.release();
  const run = admission.start(owner, input, context);
  await authority.wait(owner, run.id, 1000);
  await authority.retire(owner);
  assert.throws(() => admission.start(owner, { get task() { return assert.fail("stale getter"); } }, context), /owner/);
 } finally { await authority.shutdown(); }
});

test("coordinator transitions stay busy through queued, running, waiting and stopping until cleanup", async () => {
 for (const state of ["queued", "running", "waiting", "stopping"] as const) {
  let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  let unblock!: () => void;
  const barrier = new Promise<void>(resolve => { unblock = resolve; });
  const authority = new GuildExecutionAuthority(() => new BackgroundRunRegistry(async ({ ask }) => {
   try { if (state === "waiting") await ask("Continue?"); }
   finally { await cleanup; }
  }));
  const owner = authority.activate();
  const c = inactiveCoordinator();
  const admission = createGuildBackgroundAdmission({ authority, parentEnvironment: {}, bus: { emit(_channel, request) { request.reply(c.provider); } } });
  let exclusive: Promise<unknown> | undefined;
  try {
   if (state === "queued") exclusive = authority.runExclusive(owner, () => barrier);
   const run = admission.start(owner, input, context);
   if (state === "stopping") void authority.cancel(owner, run.id);
   assert.equal(authority.status(owner, run.id).status, state);
   assert.equal(c.transition(c.provider.inspect().generation, "active").kind, "blocked", state);
   if (state === "waiting") authority.reply(owner, run.id, authority.status(owner, run.id).question!.id, "yes");
   unblock(); release();
   await exclusive;
   await authority.wait(owner, run.id, 1000);
   assert.equal(c.transition(c.provider.inspect().generation, "active").kind, "ok");
  } finally { unblock(); release(); await exclusive; await authority.shutdown(); }
 }
});

test("rejects hidden mode overrides and copies practices without caller array methods", async () => {
 const authority = new GuildExecutionAuthority(() => new BackgroundRunRegistry(() => {}));
 const owner = authority.activate();
 const admission = createGuildBackgroundAdmission({ authority, bus: silent, parentEnvironment: { PITHOS_GUILD_PLAN_MODE: "standalone" } });
 try {
  assert.throws(() => admission.start(owner, Object.defineProperty({ ...input }, "mode", { value: "standalone" }), context));
  let reads = 0;
  const practices = [{ get id() { reads++; return "tdd"; }, policy: "required" }];
  Object.defineProperty(practices, "map", { get() { return assert.fail("caller map invoked"); } });
  const run = admission.start(owner, { ...input, practices }, context);
  await authority.wait(owner, run.id, 1000);
  assert.equal(reads, 1);
 } finally { await authority.shutdown(); }
});


test("shared persisted reader reports inactivity without asserting provider absence", () => {
 assert.equal(readPersistedPlanState({getBranch: () => []}), "inactive");
 assert.equal(readPersistedPlanState({getBranch: () => [{type: "custom", customType: "plan-theme-state", data: {active: true}}]}), "active");
 assert.equal(readPersistedPlanState({getBranch: () => [{type: "custom", customType: "plan-theme-state", data: {active: "unknown"}}]}), "indeterminate");
 const entry = {type: "custom", customType: "plan-theme-state", get data() {return assert.fail("unsafe persisted getter executed");}};
 assert.throws(() => readPersistedPlanState({getBranch: () => [entry]}), /Unsafe persisted/);
 assert.throws(() => readPersistedPlanState({getBranch: () => new Proxy([], {})}), /Unsafe persisted/);
});
