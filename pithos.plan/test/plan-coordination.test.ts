import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlanCoordinator } from "../extensions/plan-coordination.ts";

test("phase changes require current generation and explicit inactive confirmation", () => {
 const c = createPlanCoordinator();
 const initial = c.provider.inspect();
 assert.equal(initial.phase, "initializing");
 assert.equal(c.confirmInactive(initial.generation).kind, "ok");
 assert.equal(c.transition(initial.generation, "active").kind, "blocked");
 for (const phase of ["entering", "active", "exiting", "reconciling", "blocked"] as const) {
  assert.equal(c.transition(c.provider.inspect().generation, phase).kind, "ok");
  assert.equal(c.provider.inspect().phase, phase);
 }
});

test("acquires all participants atomically, retains holds, and gates late attachment", () => {
 const c = createPlanCoordinator();
 c.confirmInactive(c.provider.inspect().generation);
 let holds = 0;
 const participant = () => ({ instance: {}, tryAcquire: () => { holds++; return { kind: "held", lease: { release() { holds--; } } }; } });
 assert.equal(c.provider.attachParticipant(participant()).kind, "attached");
 let busy = true;
 c.provider.attachParticipant({ instance: {}, tryAcquire: () => busy ? { kind: "busy", outstanding: 1 } : participant().tryAcquire() });
 assert.equal(c.transition(c.provider.inspect().generation, "entering").kind, "blocked");
 assert.equal(holds, 0);
 assert.equal(c.provider.inspect().phase, "inactive");
 busy = false;
 assert.equal(c.transition(c.provider.inspect().generation, "entering").kind, "ok");
 assert.equal(holds, 2);
 for (const phase of ["active", "exiting", "reconciling", "blocked"] as const) c.transition(c.provider.inspect().generation, phase);
 assert.equal(holds, 2);
 assert.equal(c.provider.attachParticipant({ instance: {}, tryAcquire: () => ({ kind: "busy", outstanding: 1 }) }).kind, "blocked");
 assert.equal(c.provider.attachParticipant(participant()).kind, "attached");
 assert.equal(holds, 3);
 c.confirmInactive(c.provider.inspect().generation);
 assert.equal(holds, 0);
});

test("invalid synchronous contracts and disposal cannot reopen state", () => {
 for (const result of [null, { kind: "held", lease: {} }, Promise.resolve({ kind: "busy" }), { kind: "unavailable", reason: "closed" }]) {
  const c = createPlanCoordinator();
  assert.equal(c.provider.attachParticipant({ instance: {}, tryAcquire: () => result }).kind, "blocked");
 }
 const c = createPlanCoordinator();
 assert.equal(c.provider.attachParticipant({ instance: {}, tryAcquire() { throw Error("fault"); } }).kind, "blocked");
 let releases = 0;
 const d = createPlanCoordinator();
 d.provider.attachParticipant({ instance: {}, tryAcquire: () => ({ kind: "held", lease: { release() { releases++; } } }) });
 const stale = d.provider.inspect().generation;
 d.dispose(); d.dispose();
 assert.equal(d.confirmInactive(stale).kind, "blocked");
 assert.equal(d.confirmInactive(d.provider.inspect().generation).kind, "blocked");
 assert.equal(d.transition(d.provider.inspect().generation, "active").kind, "blocked");
 assert.equal(d.provider.attachParticipant({ instance: {}, tryAcquire: () => { throw Error("must not call"); } }).kind, "blocked");
 assert.equal(releases, 0);
});

test("reentrant disposal during acquisition is terminal and keeps the acquired hold", () => {
 const c = createPlanCoordinator();
 c.confirmInactive(c.provider.inspect().generation);
 let releases = 0;
 c.provider.attachParticipant({ instance: {}, tryAcquire() {
  c.dispose();
  return { kind: "held", lease: { release() { releases++; } } };
 } });
 assert.equal(c.transition(c.provider.inspect().generation, "active").kind, "blocked");
 assert.equal(c.provider.inspect().phase, "disposed");
 assert.equal(c.confirmInactive(c.provider.inspect().generation).kind, "blocked");
 assert.equal(releases, 0);
});

test("release failure stops further release and permanently blocks confirmation", () => {
 for (const mode of ["throw", "promise", "dispose", "malformed"] as const) {
  let releases = 0;
  const c = createPlanCoordinator();
  const fail = () => {
   if (mode === "throw") throw Error("release");
   if (mode === "promise") return Promise.resolve();
   if (mode === "malformed") return {};
   c.dispose();
  };
  c.provider.attachParticipant({ instance: {}, tryAcquire: () => ({ kind: "held", lease: { release: fail } }) });
  c.provider.attachParticipant({ instance: {}, tryAcquire: () => ({ kind: "held", lease: { release() { releases++; } } }) });
  assert.equal(c.confirmInactive(c.provider.inspect().generation).kind, "blocked");
  assert.equal(releases, 0);
  assert.equal(c.confirmInactive(c.provider.inspect().generation).kind, "blocked");
 }
});

test("inspection never advertises inactive during participant callbacks", () => {
 const c = createPlanCoordinator();
 c.confirmInactive(c.provider.inspect().generation);
 const phases: string[] = [];
 c.provider.attachParticipant({ instance: {}, tryAcquire() {
  phases.push(c.provider.inspect().phase);
  return { kind: "held", lease: { release() { phases.push(c.provider.inspect().phase); } } };
 } });
 c.transition(c.provider.inspect().generation, "active");
 c.confirmInactive(c.provider.inspect().generation);
 assert.ok(phases.every(phase => phase !== "inactive"));
 assert.equal(c.provider.inspect().phase, "inactive");
});

for (const mode of ["throw", "malformed", "rollback-throw", "rollback-malformed", "dispose"] as const) {
 test(`poisoned acquisition rollback retains remaining holds: ${mode}`, () => {
  const c = createPlanCoordinator();
  c.confirmInactive(c.provider.inspect().generation);
  const held = new Set<number>();
  const released: number[] = [];
  for (let id = 0; id < 3; id++) {
   c.provider.attachParticipant({ instance: {}, tryAcquire() {
    held.add(id);
    return { kind: "held", lease: { release() {
     released.push(id);
     if (id === 1 && mode === "rollback-throw") throw Error("release fault");
     if (id === 1 && mode === "rollback-malformed") return {};
     held.delete(id);
    } } };
   } });
  }
  c.provider.attachParticipant({ instance: {}, tryAcquire() {
   if (mode === "throw") throw Error("acquisition fault");
   if (mode === "malformed") return { kind: "held", lease: {} };
   if (mode === "dispose") c.dispose();
   return { kind: "busy", outstanding: 1 };
  } });
  assert.equal(c.transition(c.provider.inspect().generation, "entering").kind, "blocked");
  const rollback = mode.startsWith("rollback-");
  assert.deepEqual([...held], rollback ? [1, 2] : [0, 1, 2]);
  assert.deepEqual(released, rollback ? [0, 1] : []);
  assert.equal(c.provider.inspect().phase, mode === "dispose" ? "disposed" : "blocked");
  assert.equal(c.confirmInactive(c.provider.inspect().generation).kind, "blocked");
  assert.deepEqual([...held], rollback ? [1, 2] : [0, 1, 2]);
 });
}

for (const method of ["transition", "confirmInactive"] as const) {
 for (const invalid of ["undefined", "omitted", "null", "stale"] as const) {
  test(`mutation requires current object generation: ${method} ${invalid}`, () => {
   const c = createPlanCoordinator();
   const stale = c.provider.inspect().generation;
   let held = false;
   c.provider.attachParticipant({ instance: {}, tryAcquire() {
    held = true;
    return { kind: "held", lease: { release() { held = false; } } };
   } });
   c.transition(stale, "active");
   const before = c.provider.inspect();
   const expected = invalid === "null" ? null : invalid === "stale" ? stale : undefined;
   // Reflect exercises untyped callers, including truly omitted arguments.
   const args = invalid === "omitted" ? [] : method === "transition" ? [expected, "exiting"] : [expected];
   assert.equal(Reflect.apply(c[method], c, args).kind, "blocked");
   assert.deepEqual(c.provider.inspect(), before);
   assert.equal(held, true);
   assert.equal(c.confirmInactive(before.generation).kind, "ok");
   assert.equal(held, false);
  });
 }
}

test("invalid runtime phases leave active protection unchanged", () => {
 const c = createPlanCoordinator();
 let held = false;
 c.provider.attachParticipant({ instance: {}, tryAcquire() {
  held = true;
  return { kind: "held", lease: { release() { held = false; } } };
 } });
 c.transition(c.provider.inspect().generation, "active");
 const before = c.provider.inspect();
 for (const phase of [undefined, null, "inactive", "disposed", "initializing", "unknown", {}]) {
  assert.equal(Reflect.apply(c.transition, c, [before.generation, phase]).kind, "blocked");
  assert.deepEqual(c.provider.inspect(), before);
  assert.equal(held, true);
 }
});
