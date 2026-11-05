import assert from "node:assert/strict";
import { test } from "node:test";
import { createSemanticInterruptBinding } from "../src/semantic-interrupt.ts";

function assertUnavailable(result: ReturnType<typeof createSemanticInterruptBinding>, reason: string) {
 assert.ok(result.cleanup instanceof Promise);
 assert.deepEqual(result, { kind: "unavailable", reason, cleanup: result.cleanup });
}

const callbacks = { onInterrupt() {}, onRetire() {}, onError() {} };
const context = (capability: unknown) => ({ mode: "tui", hasUI: true, ui: { semanticInterrupt: capability } });

test("qualifies only the versioned TUI capability and preserves its receiver", () => {
 const capability = Object.freeze({
  protocol: "pi-semantic-interrupt-v1",
  subscribe() { assert.equal(this, capability); return () => {}; },
 });
 const bound = createSemanticInterruptBinding(Object.freeze(context(capability)), callbacks);
 assert.equal(bound.kind, "bound");
 if (bound.kind === "bound") { assert.equal(bound.binding.isActive(), true); bound.binding.dispose(); }
 for (const value of [null, {}, { mode: "tui", hasUI: true, ui: { onInterrupt() {} } },
  context({ ...capability, protocol: "future" }), context({ ...capability, subscribe: 1 }),
  { ...context(capability), mode: "rpc" }, { ...context(capability), hasUI: false },
  { ...context(capability), hasUI: 1 },
  new Proxy({}, { get() { throw new Error("private host detail"); } }),
  context(new Proxy({}, { get() { throw new Error("private host detail"); } })),
 ]) {
  assertUnavailable(createSemanticInterruptBinding(value, callbacks), "unsupported-capability");
 }
});

test("interrupt, retirement and manual disposal fence before callouts and clean once", () => {
 for (const event of ["interrupt", "ui-reset", "ui-stop", "runner-rebind", "runner-invalidate", "manual"] as const) {
  let interrupt!: () => void;
  let retire!: (reason: "ui-reset") => void;
  let cleaned = 0;
  const seen: string[] = [];
  const result = createSemanticInterruptBinding(context({ protocol: "pi-semantic-interrupt-v1", subscribe(i: typeof interrupt, r: typeof retire) {
   interrupt = i; retire = r;
   return () => { cleaned++; interrupt(); retire("ui-reset"); };
  } }), {
   onInterrupt() { assert.equal(binding.isActive(), false); seen.push("interrupt"); binding.dispose(); },
   onRetire(reason) { assert.equal(binding.isActive(), false); seen.push(reason); binding.dispose(); },
   onError() { assert.fail("unexpected fault"); },
  });
  assert.equal(result.kind, "bound");
  if (result.kind !== "bound") continue;
  const binding = result.binding;
  if (event === "manual") binding.dispose();
  else if (event === "interrupt") interrupt();
  else (retire as (reason: string) => void)(event);
  interrupt(); retire("ui-reset"); binding.dispose();
  assert.equal(binding.isActive(), false);
  assert.equal(cleaned, 1);
  assert.deepEqual(seen, event === "manual" ? [] : [event]);
 }
});

test("registration commits only a live subscription and fences failed providers", () => {
 for (const event of ["interrupt", "retire", "throw", "malformed"] as const) {
  let interrupt!: () => void;
  let retire!: (reason: "ui-stop") => void;
  let cleaned = 0;
  const seen: string[] = [];
  const result = createSemanticInterruptBinding(context({ protocol: "pi-semantic-interrupt-v1", subscribe(i: typeof interrupt, r: typeof retire) {
   interrupt = i; retire = r;
   if (event === "interrupt") i();
   if (event === "retire") r("ui-stop");
   if (event === "throw") throw new Error("secret");
   if (event === "malformed") return undefined;
   return () => { cleaned++; i(); r("ui-stop"); };
  } }), { onInterrupt() { seen.push("interrupt"); }, onRetire(reason) { seen.push(reason); }, onError() {} });
  assertUnavailable(result, event === "throw" || event === "malformed" ? "registration-failed" : "retired-during-registration");
  interrupt(); retire("ui-stop");
  assert.deepEqual(seen, event === "interrupt" ? ["interrupt"] : event === "retire" ? ["ui-stop"] : []);
  assert.equal(cleaned, event === "interrupt" || event === "retire" ? 1 : 0);
 }
});

test("faults are bounded, latched and reported without throwing or unhandled rejection", async () => {
 for (const failure of ["cleanup-throw", "cleanup-reject", "interrupt-throw", "interrupt-reject", "retire-reject", "observer-reject"] as const) {
  let interrupt!: () => void;
  let retire!: (reason: "ui-reset") => void;
  let cleaned = 0;
  let notified = 0;
  const faults: string[] = [];
  const secret = new Error("private detail");
  const result = createSemanticInterruptBinding(context({ protocol: "pi-semantic-interrupt-v1", subscribe(i: typeof interrupt, r: typeof retire) {
   interrupt = i; retire = r;
   return () => {
    cleaned++;
    if (failure === "cleanup-throw") throw secret;
    if (failure === "cleanup-reject") return Promise.reject(secret);
   };
  } }), {
   onInterrupt() {
    notified++;
    if (failure === "interrupt-throw" || failure === "observer-reject") throw secret;
    if (failure === "interrupt-reject") return Promise.reject(secret);
   },
   onRetire() { notified++; return Promise.reject(secret); },
   onError(reason) { faults.push(reason); if (failure === "observer-reject") return Promise.reject(secret); },
  });
  assert.equal(result.kind, "bound");
  if (result.kind !== "bound") continue;
  assert.equal(result.binding.getFault(), undefined);
  if (failure === "retire-reject") retire("ui-reset"); else interrupt();
  assert.equal(result.binding.isActive(), false);
  await new Promise<void>(resolve => setImmediate(resolve));
  const expected = failure.startsWith("cleanup") ? "cleanup-failed" : failure === "retire-reject" ? "retire-callback-failed" : "interrupt-callback-failed";
  assert.equal(result.binding.getFault(), expected);
  assert.deepEqual(faults, [expected]);
  assert.equal(notified, 1);
  result.binding.dispose(); interrupt(); retire("ui-reset");
  assert.equal(cleaned, 1);
 }
});

test("captures immutable callback identity and isolates a reentrantly created binding", async () => {
 const saved: Array<() => void | Promise<void>> = [];
 let releases = 0;
 const capability = { protocol: "pi-semantic-interrupt-v1", subscribe(i: () => void | Promise<void>) {
  saved.push(i);
  return () => { releases++; void saved[0](); };
 } };
 let oldCalls = 0;
 let newCalls = 0;
 let next: ReturnType<typeof createSemanticInterruptBinding> | undefined;
 const owner = {
  onInterrupt() {
   oldCalls++;
   next = createSemanticInterruptBinding(context(capability), { ...callbacks, onInterrupt() { newCalls++; } });
   return Promise.resolve();
  },
  onRetire() {}, onError() {},
 };
 const first = createSemanticInterruptBinding(context(capability), owner);
 owner.onInterrupt = () => { assert.fail("must not refresh the owner"); };
 assert.equal(first.kind, "bound");
 if (first.kind !== "bound") return;
 await saved[0]();
 assert.equal(oldCalls, 1);
 assert.equal(next?.kind, "bound");
 if (next?.kind !== "bound") return;
 first.binding.dispose(); await saved[0]();
 assert.equal(next.binding.isActive(), true);
 assert.equal(newCalls, 0);
 await saved[1]();
 assert.equal(newCalls, 1);
 assert.equal(releases, 2);
 assert.equal(next.binding.isActive(), false);
});

test("manual and pending cleanup faults remain observable without retirement events", () => {
 for (const pending of [false, true]) {
  const events: string[] = [];
  const faults: string[] = [];
  let cleanupCount = 0;
  const result = createSemanticInterruptBinding(context({ protocol: "pi-semantic-interrupt-v1", subscribe(i: () => void) {
   if (pending) i();
   return () => { cleanupCount++; throw new Error("secret"); };
  } }), { onInterrupt() { events.push("interrupt"); }, onRetire() { events.push("retire"); }, onError(reason) { faults.push(reason); throw new Error("observer failure"); } });
  if (pending) assertUnavailable(result, "retired-during-registration");
  else {
   assert.equal(result.kind, "bound");
   if (result.kind !== "bound") continue;
   result.binding.dispose(); result.binding.dispose();
   assert.equal(result.binding.isActive(), false);
   assert.equal(result.binding.getFault(), "cleanup-failed");
  }
  assert.equal(cleanupCount, 1);
  assert.deepEqual(faults, ["cleanup-failed"]);
  assert.deepEqual(events, pending ? ["interrupt"] : []);
 }
});

test("host property traps fail closed and a throw after notification cannot revive a callback", () => {
 for (const value of [
  { mode: "tui", hasUI: true, get ui() { throw new Error("secret"); } },
  context({ protocol: "pi-semantic-interrupt-v1", get subscribe() { throw new Error("secret"); } }),
  { mode: "tui", hasUI: true, ui: { get semanticInterrupt() { throw new Error("secret"); } } },
 ]) assertUnavailable(createSemanticInterruptBinding(value, callbacks), "unsupported-capability");
 let saved!: () => void;
 let notifications = 0;
 const result = createSemanticInterruptBinding(context({ protocol: "pi-semantic-interrupt-v1", subscribe(i: () => void) {
  saved = i; i(); throw new Error("secret");
 } }), { ...callbacks, onInterrupt() { notifications++; } });
 assertUnavailable(result, "registration-failed");
 saved(); assert.equal(notifications, 1);
});

test("an invalid asynchronous registration result is observed but never qualifies", async () => {
 let saved!: () => void;
 let notifications = 0;
 const result = createSemanticInterruptBinding(context({ protocol: "pi-semantic-interrupt-v1", subscribe(i: () => void) {
  saved = i;
  return Promise.reject(new Error("private registration failure"));
 } }), { ...callbacks, onInterrupt() { notifications++; } });
 assertUnavailable(result, "registration-failed");
 saved();
 await new Promise<void>(resolve => setImmediate(resolve));
 assert.equal(notifications, 0);
});

for (const event of ["interrupt", "retire"] as const) {
 test(`${event} fences the external owner before host cleanup without awaiting it`, () => {
  let ownerLive = true;
  let interrupt!: () => void;
  let retire!: (reason: "ui-stop") => void;
  let cleaned = 0;
  let notified = 0;
  const outputs: string[] = [];
  const faults: string[] = [];
  const notify = () => {
   ownerLive = false;
   notified++;
   if (result.kind === "bound") result.binding.dispose();
   return new Promise<void>(() => {});
  };
  const result = createSemanticInterruptBinding(context({ protocol: "pi-semantic-interrupt-v1", subscribe(i: typeof interrupt, r: typeof retire) {
   interrupt = i; retire = r;
   return () => {
    cleaned++;
    if (ownerLive) outputs.push("stale continuation");
    interrupt(); retire("ui-stop");
   };
  } }), { onInterrupt: notify, onRetire: notify, onError(reason) { faults.push(reason); } });
  assert.equal(result.kind, "bound");
  if (result.kind !== "bound") return;
  if (event === "interrupt") interrupt(); else retire("ui-stop");
  interrupt(); retire("ui-stop"); result.binding.dispose();
  assert.deepEqual(outputs, []);
  assert.equal(cleaned, 1);
  assert.equal(notified, 1);
  assert.equal(result.binding.isActive(), false);
  assert.deepEqual(faults, []);
 });
}

test("cleanup joins a held raw disposer, not just invalidation", async () => {
 let finish!: () => void;
 const held = new Promise<void>(resolve => { finish = resolve; });
 const result = createSemanticInterruptBinding(context({ protocol: "pi-semantic-interrupt-v1", subscribe() {
  return () => held;
 } }), callbacks);
 assert.equal(result.kind, "bound");
 assert.ok(result.cleanup instanceof Promise);
 if (result.kind !== "bound") return;
 let settled = false;
 void result.cleanup.then(() => { settled = true; });
 await new Promise<void>(resolve => setImmediate(resolve));
 assert.equal(settled, false);
 result.binding.dispose();
 await new Promise<void>(resolve => setImmediate(resolve));
 assert.equal(settled, false);
 finish();
 await result.cleanup;
 assert.equal(settled, true);
});

test("invalid async registration joins and drains an eventual disposer without qualifying", async () => {
 let registered!: (value: () => Promise<void>) => void;
 let finish!: () => void;
 let cleaned = 0;
 let saved!: () => void;
 const held = new Promise<void>(resolve => { finish = resolve; });
 const result = createSemanticInterruptBinding(context({ protocol: "pi-semantic-interrupt-v1", subscribe(i: () => void) {
  saved = i;
  return new Promise<() => Promise<void>>(resolve => { registered = resolve; });
 } }), { ...callbacks, onInterrupt() { assert.fail("inactive callback"); } });
 assertUnavailable(result, "registration-failed");
 let settled = false;
 void result.cleanup.then(() => { settled = true; });
 await new Promise<void>(resolve => setImmediate(resolve));
 assert.equal(settled, false);
 registered(() => { cleaned++; return held; });
 await new Promise<void>(resolve => setImmediate(resolve));
 assert.equal(cleaned, 1);
 assert.equal(settled, false);
 saved(); finish();
 await result.cleanup;
 assert.equal(settled, true);
});

test("cleanup reports rejection before joining and excludes owner callback tails", async () => {
 for (const pending of [false, true]) {
  let reject!: (error: Error) => void;
  let saved!: () => void;
  let notified = 0;
  let cleaned = 0;
  const faults: string[] = [];
  const held = new Promise<void>((_, fail) => { reject = fail; });
  const result = createSemanticInterruptBinding(context({ protocol: "pi-semantic-interrupt-v1", subscribe(i: () => void) {
   saved = i;
   if (pending) i();
   return () => { cleaned++; assert.equal(notified, 1); return held; };
  } }), {
   ...callbacks,
   onInterrupt() { notified++; return new Promise<void>(() => {}); },
   onError(reason) { faults.push(reason); },
  });
  if (pending) assertUnavailable(result, "retired-during-registration");
  else { assert.equal(result.kind, "bound"); saved(); }
  let settled = false;
  void result.cleanup.then(() => {
   assert.deepEqual(faults, ["cleanup-failed"]);
   if (result.kind === "bound") assert.equal(result.binding.getFault(), "cleanup-failed");
   settled = true;
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(cleaned, 1);
  reject(new Error("private cleanup failure"));
  await result.cleanup;
  assert.equal(settled, true);
  saved();
  if (result.kind === "bound") result.binding.dispose();
  assert.equal(notified, 1);
  assert.equal(cleaned, 1);
 }
});

test("unsupported and throwing registration settle their local cleanup boundary", async () => {
 for (const value of [null, context({ protocol: "pi-semantic-interrupt-v1", subscribe() { throw new Error("private"); } }),
  context({ protocol: "pi-semantic-interrupt-v1", subscribe() { return Promise.reject(new Error("private")); } })]) {
  const result = createSemanticInterruptBinding(value, callbacks);
  assert.equal(result.kind, "unavailable");
  await result.cleanup;
 }
});
