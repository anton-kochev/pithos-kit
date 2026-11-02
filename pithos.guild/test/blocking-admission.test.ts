import assert from "node:assert/strict";
import { test } from "node:test";
import { createBlockingAdmission } from "../src/blocking-admission.ts";
import { createGuildBackgroundRuntime } from "../src/background-runtime.ts";
import { createPlanCoordinator } from "../../pithos.plan/extensions/plan-coordination.ts";

test("blocking transaction attaches before reservation and poisons caught nested admission", async () => {
 const coordinator = createPlanCoordinator();
 coordinator.confirmInactive(coordinator.provider.inspect().generation);
 const bus = { emit(_channel: string, request: { reply(value: unknown): void }) { request.reply(coordinator.provider); } };
 const runtime = createGuildBackgroundRuntime({ bus });
 const owner = runtime.activate();
 const admission = createBlockingAdmission(runtime, bus);
 const capture = () => ({ getBranch: () => [] });
 try {
  let launched = false;
  assert.throws(() => admission(owner, () => {
   assert.throws(() => admission(owner, capture, () => {}), /Reentrant/);
   return capture();
  }, () => { launched = true; }), /Reentrant/);
  assert.equal(launched, false);
  await admission(owner, capture, () => runtime.runExclusive(owner, () => {
   assert.equal(coordinator.transition(coordinator.provider.inspect().generation, "active").kind, "blocked");
  }));
  await runtime.retire(owner);
  const next = runtime.activate();
  assert.throws(() => admission(owner, capture, () => {}), /owner/i);
  admission(next, capture, () => {});
 } finally { await runtime.shutdown(); }
});

test("blocking transaction rejects persistence and original provider drift before commit", async () => {
 for (const drift of ["persistence", "unsafe", "generation", "phase", "method", "instance", "reentry"] as const) {
  const coordinator = createPlanCoordinator(); coordinator.confirmInactive(coordinator.provider.inspect().generation);
  const provider = {...coordinator.provider};
  const bus = {emit(_channel: string, request: {reply(value: unknown): void}) {request.reply(provider);}};
  const runtime = createGuildBackgroundRuntime({bus}); const owner = runtime.activate();
  const admit = createBlockingAdmission(runtime, bus); let reads = 0; let commits = 0;
  const context = {getBranch(): readonly unknown[] {
   assert.equal(this, context);
   if (++reads === 2) {
    if (drift === "persistence") return [{type: "custom", customType: "plan-theme-state", data: {active: true}}];
    if (drift === "unsafe") return new Proxy([], {});
    if (drift === "generation") coordinator.confirmInactive(coordinator.provider.inspect().generation);
    if (drift === "phase") coordinator.transition(coordinator.provider.inspect().generation, "active");
    if (drift === "method") provider.inspect = () => coordinator.provider.inspect();
    if (drift === "instance") provider.instance = {};
    if (drift === "reentry") assert.throws(() => admit(owner, () => context, () => {}), /Reentrant/);
   }
   return [];
  }};
  try {
   assert.throws(() => admit(owner, () => context, () => {commits++;}), /Plan|Reentrant/i, drift);
   assert.equal(commits, 0, drift);
  } finally {await runtime.shutdown();}
 }
});
