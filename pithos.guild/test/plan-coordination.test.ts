import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverPlan, type PlanBoundary } from "../src/plan-coordination.ts";
import { createPlanCoordinator } from "../../pithos.plan/extensions/plan-coordination.ts";

const silent = { emit() {} };
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
 assert.equal(discoverPlan(bus, { presence: "present", persisted: "inactive" }, participant).kind, "ready");
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
