import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverPlan, type PlanBoundary } from "../src/plan-coordination.ts";
import { createPlanCoordinator } from "../../pithos.plan/extensions/plan-coordination.ts";
import { planBoundaryFor, planModeState } from "../src/safety.ts";

const silent = { emit() {} };

test("required integration needs a stable inactive handshake through attachment", () => {
 for (const change of ["none", "generation", "phase"] as const) {
  const c = createPlanCoordinator();
  c.confirmInactive(c.provider.inspect().generation);
  const before = c.provider.inspect();
  const provider = change === "none" ? c.provider : {
   ...c.provider,
   attachParticipant(participant: Parameters<typeof c.provider.attachParticipant>[0]) {
    const result = c.provider.attachParticipant(participant);
    if (change === "generation") c.confirmInactive(c.provider.inspect().generation);
    else c.transition(c.provider.inspect().generation, "active");
    return result;
   },
  };
  const participant = { instance: {}, tryAcquire: () => ({ kind: "held", lease: { release() {} } }) };
  const result = discoverPlan({ emit(_channel, request) { request.reply(provider); } }, planBoundaryFor("required", "inactive"), participant);
  assert.equal(result.kind, change === "none" ? "ready" : "blocked", change);
  if (result.kind === "ready") {
   assert.equal(result.provider, c.provider);
   assert.equal(result.provider?.instance, before.instance);
   assert.equal(result.generation, before.generation);
  }
 }
});

test("only explicit standalone integration permits silence with an empty Plan history", () => {
 const persisted = planModeState([]);
 assert.equal(persisted, "inactive");
 assert.equal(discoverPlan(silent, planBoundaryFor("required", persisted)).kind, "blocked");
 assert.deepEqual(discoverPlan(silent, planBoundaryFor("standalone", persisted)), { kind: "ready" });
});

test("standalone integration rejects every reply before inspection or attachment", () => {
 const c = createPlanCoordinator();
 c.confirmInactive(c.provider.inspect().generation);
 let inspections = 0;
 let attachments = 0;
 const provider = {
  ...c.provider,
  inspect() { inspections++; return c.provider.inspect(); },
  attachParticipant(participant: Parameters<typeof c.provider.attachParticipant>[0]) {
   attachments++;
   return c.provider.attachParticipant(participant);
  },
 };
 const participant = { instance: {}, tryAcquire: () => ({ kind: "held", lease: { release() {} } }) };
 const cases: [string, unknown[]][] = [
  ["compatible", [provider]],
  ["incompatible version", [{ ...provider, version: 2 }]],
  ["thenable", [{ ...provider, then() {} }]],
  ["null", [null]],
  ["undefined", [undefined]],
  ["malformed", [{}]],
  ["duplicate", [provider, provider]],
  ["mixed", [null, provider]],
 ];
 for (const [name, replies] of cases) {
  const result = discoverPlan({ emit(_channel, request) { replies.forEach(value => request.reply(value)); } }, planBoundaryFor("standalone", "inactive"), participant);
  assert.deepEqual({ kind: result.kind, inspections, attachments }, { kind: "blocked", inspections: 0, attachments: 0 }, name);
 }
});

test("integration boundary vetoes survive silence and a good inactive provider", () => {
 const cases: [string, PlanBoundary][] = [];
 for (const mode of ["required", "standalone"] as const) {
  for (const persisted of ["active", "indeterminate"] as const) {
   cases.push([`${mode}/${persisted}`, planBoundaryFor(mode, persisted)]);
  }
 }
 for (const mode of [undefined, null, "invalid", {}]) {
  cases.push([`invalid mode: ${String(mode)}`, Reflect.apply(planBoundaryFor, undefined, [mode, "inactive"])]);
 }
 for (const [name, boundary] of cases) {
  const c = createPlanCoordinator();
  c.confirmInactive(c.provider.inspect().generation);
  let inspections = 0;
  let acquisitions = 0;
  const provider = { ...c.provider, inspect() { inspections++; return c.provider.inspect(); } };
  const participant = { instance: {}, tryAcquire() { acquisitions++; return { kind: "held", lease: { release() {} } }; } };
  const bus = { emit(_channel: string, request: { reply(value: unknown): void }) { request.reply(provider); } };
  for (const source of [silent, bus]) {
   assert.equal(discoverPlan(source, boundary, participant).kind, "blocked", name);
  }
  assert.equal(inspections, 0, name);
  assert.equal(c.transition(c.provider.inspect().generation, "active").kind, "ok");
  assert.equal(acquisitions, 0, `${name}: must not attach a participant`);
 }
});

test("discovery distinguishes explicit absence from silence and reports compatible phases", () => {
 for (const presence of ["absent", "present", "unknown"] as const) {
  for (const persisted of ["inactive", "active", "unknown"] as const) {
   assert.equal(discoverPlan(silent, { presence, persisted }).kind, presence === "absent" && persisted === "inactive" ? "ready" : "blocked");
  }
 }
 const c = createPlanCoordinator();
 const bus = { emit(_channel: string, request: { reply(value: unknown): void }) { request.reply(c.provider); } };
 assert.equal(discoverPlan(bus, { presence: "present", persisted: "inactive" }).kind, "blocked");
 c.confirmInactive(c.provider.inspect().generation);
 assert.equal(discoverPlan(bus, { presence: "present", persisted: "inactive" }).kind, "ready");
 c.transition(c.provider.inspect().generation, "active");
 assert.equal(discoverPlan(bus, { presence: "present", persisted: "inactive" }).kind, "blocked");
});

test("inactive providers cannot override rejected boundaries or attach participants", async t => {
 for (const presence of ["present", "unknown", "absent"] as const) {
  for (const persisted of ["inactive", "active", "unknown"] as const) {
   if (presence === "present" && persisted === "inactive") continue;
   await t.test(`${presence}/${persisted}`, () => {
    const c = createPlanCoordinator();
    c.confirmInactive(c.provider.inspect().generation);
    const bus = { emit(_channel: string, request: { reply(value: unknown): void }) { request.reply(c.provider); } };
    let acquisitions = 0;
    const participant = { instance: {}, tryAcquire() { acquisitions++; return { kind: "held", lease: { release() {} } }; } };
    const result = discoverPlan(bus, { presence, persisted }, participant);
    assert.equal(c.transition(c.provider.inspect().generation, "active").kind, "ok");
    assert.equal(acquisitions, 0, "rejected discovery must not leave a participant attached");
    assert.equal(result.kind, "blocked");
   });
  }
 }
});

test("malformed runtime boundaries fail closed with or without a provider", () => {
 for (const boundary of [null, undefined, {}, { presence: "present" }, { persisted: "inactive" }, { presence: "invalid", persisted: "inactive" }, { presence: "present", persisted: false }, { presence: "absent", persisted: "invalid" }]) {
  const c = createPlanCoordinator();
  c.confirmInactive(c.provider.inspect().generation);
  const bus = { emit(_channel: string, request: { reply(value: unknown): void }) { request.reply(c.provider); } };
  let acquisitions = 0;
  const participant = { instance: {}, tryAcquire() { acquisitions++; return { kind: "held", lease: { release() {} } }; } };
  for (const source of [silent, bus]) {
   assert.equal(discoverPlan(source, boundary as PlanBoundary, participant).kind, "blocked");
  }
  assert.equal(c.transition(c.provider.inspect().generation, "active").kind, "ok");
  assert.equal(acquisitions, 0);
 }
});

test("rejects duplicate, incompatible, throwing and thenable responders", () => {
 const c = createPlanCoordinator();
 c.confirmInactive(c.provider.inspect().generation);
 for (const value of [null, { ...c.provider, version: 2 }, { ...c.provider, then() {} }, { ...c.provider, inspect: () => ({ ...c.provider.inspect(), then() {} }) }, { ...c.provider, inspect() { throw Error("fault"); } }]) {
  assert.equal(discoverPlan({ emit(_channel, request) { request.reply(value); } }, { presence: "present", persisted: "inactive" }).kind, "blocked");
 }
 assert.equal(discoverPlan({ emit(_channel, request) { request.reply(c.provider); request.reply(c.provider); } }, { presence: "present", persisted: "inactive" }).kind, "blocked");
 assert.equal(discoverPlan({ emit(_channel, request) { request.reply(c.provider); throw Error("dispatch"); } }, { presence: "present", persisted: "inactive" }).kind, "blocked");
 // A response contradicting the caller's absence boundary cannot establish readiness.
 assert.equal(discoverPlan({ emit(_channel, request) { request.reply(c.provider); } }, { presence: "absent", persisted: "inactive" }).kind, "blocked");
});

test("attaches the real registry before readiness and busy acquisition leaves work undisturbed", async () => {
 const { BackgroundRunRegistry } = await import("../src/background-runs.ts");
 const registry = new BackgroundRunRegistry(async () => {});
 const participant = { instance: {}, tryAcquire: (owner: object) => registry.tryAcquirePlanHold(owner) };
 const c = createPlanCoordinator();
 c.confirmInactive(c.provider.inspect().generation);
 const bus = { emit(_channel: string, request: { reply(value: unknown): void }) { request.reply(c.provider); } };
 assert.equal(discoverPlan(bus, planBoundaryFor("required", "inactive"), participant).kind, "ready");
 assert.equal(c.transition(c.provider.inspect().generation, "active").kind, "ok");
 assert.throws(() => registry.start({ role: "coder", profile: "typescript", task: "test" }), /Plan hold/);
 c.confirmInactive(c.provider.inspect().generation);
 const run = registry.start({ role: "coder", profile: "typescript", task: "test" });
 assert.equal(c.transition(c.provider.inspect().generation, "active").kind, "blocked");
 assert.notEqual(registry.status(run.id).status, "cancelled");
 await registry.shutdown();
 assert.equal(c.transition(c.provider.inspect().generation, "active").kind, "blocked");
});

test("async-safe EventEmitter handlers reply only on-stack and rediscovery is idempotent", async () => {
 const { EventEmitter } = await import("node:events");
 const emitter = new EventEmitter();
 const errors: unknown[] = [];
 const bus = { emit(channel: string, request: unknown) { emitter.emit(channel, request); } };
 const on = (handler: (request: any) => unknown) => emitter.on("pithos.plan.coordination", async request => { try { await handler(request); } catch (error) { errors.push(error); } });
 const boundary = { presence: "present", persisted: "inactive" } as const;
 const c = createPlanCoordinator();
 c.confirmInactive(c.provider.inspect().generation);
 on(async request => { await Promise.resolve(); request.reply(c.provider); });
 const late = discoverPlan(bus, boundary);
 await Promise.resolve();
 assert.equal(late.kind, "blocked");
 emitter.removeAllListeners();
 on(() => { throw Error("handler failure"); });
 assert.equal(discoverPlan(bus, boundary).kind, "blocked");
 assert.equal(errors.length, 1);
 emitter.removeAllListeners();
 on(request => request.reply(c.provider));
 const participant = { instance: {}, tryAcquire: () => ({ kind: "held", lease: { release() {} } }) };
 assert.equal(discoverPlan(bus, boundary, participant).kind, "ready");
 assert.equal(discoverPlan(bus, boundary, participant).kind, "ready");
 c.transition(c.provider.inspect().generation, "active");
 assert.equal(discoverPlan(bus, boundary, participant).kind, "blocked");
});

test("real coordinator attachment and disposal protect the stable authority across replacement", async () => {
 const { GuildExecutionAuthority } = await import("../src/execution-authority.ts");
 const { BackgroundRunRegistry } = await import("../src/background-runs.ts");
 const registries: InstanceType<typeof BackgroundRunRegistry<undefined>>[] = [];
 const authority = new GuildExecutionAuthority(() => {
  const registry = new BackgroundRunRegistry(() => {});
  registries.push(registry); return registry;
 });
 const participant = authority.planParticipant;
 const coordinator = createPlanCoordinator();
 try {
  assert.equal(coordinator.provider.attachParticipant(participant).kind, "attached");
  let owner = authority.activate();
  assert.throws(() => registries[0].start({role: "coder", profile: "general", task: "held"}), /Plan hold/);
  await authority.retire(owner);
  assert.equal(authority.planParticipant, participant);
  assert.equal(coordinator.provider.attachParticipant(participant).kind, "attached");
  owner = authority.activate();
  await assert.rejects(authority.runExclusive(owner, () => {}), /Plan hold/);
  assert.equal(coordinator.confirmInactive(coordinator.provider.inspect().generation).kind, "ok");
  assert.equal(await authority.runExclusive(owner, () => "idle"), "idle");
  assert.equal(coordinator.transition(coordinator.provider.inspect().generation, "active").kind, "ok");
  coordinator.dispose();
  await authority.retire(owner);
  owner = authority.activate();
  await assert.rejects(authority.runExclusive(owner, () => {}), /Plan hold/);
  assert.throws(() => registries[2].start({role: "reviewer", profile: "general", task: "disposed"}), /Plan hold/);
 } finally { await authority.shutdown(); }
});

test("handshake snapshots reject accessor and proxy fields without invoking them", () => {
 const c = createPlanCoordinator();
 c.confirmInactive(c.provider.inspect().generation);
 let reads = 0;
 for (const state of [
  { ...c.provider.inspect(), get phase() { reads++; return "inactive"; } },
  new Proxy(c.provider.inspect(), {}),
 ]) {
  const provider = { ...c.provider, inspect: () => state };
  assert.equal(discoverPlan({ emit(_channel, request) { request.reply(provider); } }, planBoundaryFor("required", "inactive")).kind, "blocked");
 }
 assert.equal(reads, 0);
});

test("handshake data rejects proxy prototypes before any inherited-property trap", () => {
 const c = createPlanCoordinator();
 c.confirmInactive(c.provider.inspect().generation);
 let traps = 0;
 const provider = Object.setPrototypeOf({ ...c.provider }, new Proxy({}, { has() { traps++; return false; } }));
 assert.equal(discoverPlan({ emit(_channel, request) { request.reply(provider); } }, planBoundaryFor("required", "inactive")).kind, "blocked");
 assert.equal(traps, 0);
});

test("blocking compatibility accepts silence but attaches the one live inactive coordinator", async () => {
 const { discoverBlockingPlan } = await import("../src/plan-coordination.ts");
 const c = createPlanCoordinator();
 c.confirmInactive(c.provider.inspect().generation);
 let acquisitions = 0;
 const participant = { instance: {}, tryAcquire() { acquisitions++; return { kind: "busy", outstanding: 1 }; } };
 assert.equal(discoverBlockingPlan(silent, "inactive", participant).kind, "ready");
 assert.equal(discoverBlockingPlan({ emit(_channel, request) { request.reply(c.provider); } }, "inactive", participant).kind, "ready");
 assert.equal(c.transition(c.provider.inspect().generation, "active").kind, "blocked");
 assert.equal(acquisitions, 1);
});

test("blocking discovery retains strict normalization for every nonready or ambiguous reply", async () => {
 const { discoverBlockingPlan } = await import("../src/plan-coordination.ts");
 const c = createPlanCoordinator(); c.confirmInactive(c.provider.inspect().generation);
 const participant = { instance: {}, tryAcquire: () => ({kind: "busy", outstanding: 1}) };
 const provider = c.provider;
 const invalid: unknown[] = [null, {}, {...provider, version: 2}, new Proxy(provider, {}), {...provider, then() {}},
  {...provider, get inspect() { return assert.fail("accessor must not run"); }},
  {...provider, inspect() {throw new Error("inspection failure");}}];
 for (const phase of ["initializing", "entering", "active", "reconciling", "exiting", "blocked", "disposed", "uncertain"]) {
  invalid.push({...provider, inspect: () => ({...provider.inspect(), phase})});
 }
 for (const replies of [...invalid.map(value => [value]), [provider, provider], [provider, null]]) {
  assert.equal(discoverBlockingPlan({emit(_channel, request) {replies.forEach(value => request.reply(value));}}, "inactive", participant).kind, "blocked");
 }
 assert.equal(discoverBlockingPlan({emit(_channel, request) {request.reply(provider); throw new Error("dispatch");}}, "inactive", participant).kind, "blocked");
 for (const persisted of ["active", "unknown", undefined]) {
  assert.equal(discoverBlockingPlan(silent, persisted, participant).kind, "blocked");
 }
});
