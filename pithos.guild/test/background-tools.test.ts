import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { LedgerRecord } from "../src/background-ledger.ts";
import { createBackgroundToolRegistration } from "../src/background-tools.ts";

function fixture(overrides: Partial<Parameters<typeof createBackgroundToolRegistration>[1]> = {}) {
 const definitions = new Map<string, ToolDefinition>();
 const hooks = new Set<(event: any) => unknown>();
 let active = ["read"], current = true, eligible = true;
 let onRegister = () => {}, onGet = () => {};
 const pi = {
  registerTool(tool: ToolDefinition) { definitions.set(tool.name, tool); onRegister(); },
  getActiveTools() { onGet(); return [...active]; },
  setActiveTools(names: string[]) { active = names; },
  on(_name: string, handler: (event: any) => unknown) { hooks.add(handler); return () => hooks.delete(handler); },
 } as unknown as ExtensionAPI;
 const options = {controls: {} as Parameters<typeof createBackgroundToolRegistration>[1]["controls"],
  context: () => { throw new Error("context not configured"); }, isCurrent: () => current, canActivate: () => eligible, ...overrides};
 const registration = createBackgroundToolRegistration(pi, options);
 return {pi, options, registration, definitions, hooks, ctx: {} as ExtensionContext,
  active: () => active, current: (v: boolean) => {current = v;}, eligible: (v: boolean) => {eligible = v;},
  onRegister: (fn: () => void) => {onRegister = fn;}, onGet: (fn: () => void) => {onGet = fn;}};
}
test("registration is lazy, qualified, direct and never adds tools while Plan denies activation", () => {
 const f = fixture();
 assert.equal(f.definitions.size, 0);
 f.current(false); f.registration.show(f.ctx); assert.equal(f.definitions.size, 0);
 f.current(true); f.eligible(false); f.registration.show(f.ctx); assert.equal(f.definitions.size, 0);
 f.eligible(true); f.registration.show(f.ctx);
 assert.equal(f.definitions.size, 5);
 for (const tool of f.definitions.values()) { assert.equal(tool.defaultActive, false); assert.equal(tool.exposure, "direct"); }
 assert.deepEqual(f.active(), ["read", "guild_start", "guild_status", "guild_send", "guild_wait", "guild_cancel"]);
 f.registration.hide(); f.registration.dispose();
 assert.equal(f.hooks.size, 0);
 for (const tool of f.definitions.values()) assert.equal(tool.exposure, "hidden");
});
test("retirement during host calls withdraws partial definitions; replacement survives old callbacks", async () => {
 for (const boundary of ["register", "get"] as const) {
  const f = fixture();
  if (boundary === "register") f.onRegister(() => f.current(false));
  else f.onGet(() => f.current(false));
  f.registration.show(f.ctx);
  assert.deepEqual(f.active(), ["read"]);
  for (const tool of f.definitions.values()) assert.equal(tool.exposure, "hidden");
 }
 const f = fixture(); f.registration.show(f.ctx);
 const old = f.definitions.get("guild_status")!;
 const next = createBackgroundToolRegistration(f.pi, f.options); next.show(f.ctx);
 f.registration.hide(); f.registration.dispose();
 assert.equal(f.definitions.get("guild_status")!.exposure, "direct");
 await assert.rejects(old.execute("call", {}, undefined, undefined, f.ctx as any), /unavailable/);
 next.dispose();
});
test("owned nested wait gate blocks before service claim and unsubscribes idempotently", async () => {
 const f = fixture(); f.registration.show(f.ctx); f.registration.show(f.ctx);
 assert.equal(f.hooks.size, 1);
 const hook = [...f.hooks][0];
 assert.deepEqual(hook({toolName: "guild_wait", parentToolCallId: ""}), {block: true, reason: "Nested background collection unavailable"});
 assert.equal(hook({toolName: "guild_wait"}), undefined);
 f.registration.hide(); assert.equal(f.hooks.size, 0);
 assert.equal(hook({toolName: "guild_wait", parentToolCallId: "p"}), undefined);
});
for (const boundary of ["unsubscribe", "hidden-register"] as const) {
 test(`withdrawal rejects same-registration show reentry from ${boundary}`, async () => {
  let calls = 0, reentered = false;
  const f = fixture({context: () => context, controls: {status: () => { calls++; return []; }} as any});
  const reenter = () => {
   if (reentered) return;
   reentered = true;
   f.registration.show(f.ctx);
  };
  if (boundary === "unsubscribe") {
   const on = f.pi.on.bind(f.pi);
   f.pi.on = ((name: any, handler: any) => {
    const off = on(name, handler);
    return () => { off(); reenter(); };
   }) as typeof f.pi.on;
  }
  f.registration.show(f.ctx);
  const cached = f.definitions.get("guild_status")!;
  if (boundary === "hidden-register") f.onRegister(reenter);
  f.registration.hide();
  assert.equal(reentered, true);
  assert.equal(f.hooks.size, 0, "withdrawal must not retain a reentrant hook");
  await assert.rejects(cached.execute("call", {}, undefined, undefined, f.ctx as any), /unavailable/);
  assert.equal(calls, 0);
  for (const tool of f.definitions.values()) assert.equal(tool.exposure, "hidden");
  f.registration.hide();
  f.registration.show(f.ctx);
  assert.equal(f.hooks.size, 1, "fresh activation after withdrawal remains possible");
  f.registration.dispose();
  assert.equal(f.hooks.size, 0);
 });
}
const summary = {sessionId: "session", runId: "run", taskId: "task", role: "coder", profile: "typescript", status: "queued", reportAvailable: false, interrupted: false} as const;
const context = {} as import("../src/background-runtime.ts").GuildBackgroundContext;
async function execute(f: ReturnType<typeof fixture>, name: string, args: unknown = {}) {
 return f.definitions.get(name)!.execute("call", args, undefined, undefined, f.ctx as any);
}
test("controls use captured context and report admission, reply/update disposition and cancellation separately", async () => {
 const calls: unknown[][] = [];
 const controls = {
  start: (...args: unknown[]) => {calls.push(args); return summary;},
  status: (...args: unknown[]) => {calls.push(args); return [summary];},
  send: async (...args: unknown[]) => {calls.push(args); return {disposition: args[3] ? "accepted-not-delivered" : "queued-for-start"};},
  cancel: async (...args: unknown[]) => {calls.push(args); return {...summary, status: "completed"};},
 } as unknown as Parameters<typeof createBackgroundToolRegistration>[1]["controls"];
 const f = fixture({controls, context: () => context}); f.registration.show(f.ctx);
 const start = await execute(f, "guild_start", {role: "coder", profile: "typescript", task: "work"});
 assert.match(JSON.stringify(start.content), /admitted.*asynchronous/i);
 assert.equal(calls[0][1], context);
 const status = await execute(f, "guild_status"); assert.equal(calls[1][0], context);
 assert.match(JSON.stringify((await execute(f, "guild_send", {runId: "run", message: "yes", questionId: "q"})).content), /accepted-not-delivered/);
 assert.match(JSON.stringify((await execute(f, "guild_send", {runId: "run", message: "update"})).content), /queued-for-start/);
 const cancel = await execute(f, "guild_cancel", {runId: "run"});
 assert.match(JSON.stringify(cancel.content), /Cancellation operation finished/);
 assert.match(JSON.stringify(cancel.content), /completed/);
 for (const result of [start, status, cancel]) { assert.equal(result.usage, undefined); assert.equal((result.details as any).guildBackground, undefined); }
 f.current(false);
 await assert.rejects(execute(f, "guild_status"), /unavailable/); assert.equal(calls.length, 5);
});
const usage = {input: 7, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2}};
const report = {protocol: "guild/2", version: 2, runId: "run", taskId: "task", role: "coder", profile: "typescript", taskOutcome: "succeeded", summary: "child claims", compliance: [], blockers: [], limitations: [], payload: {changes: [], verification: []}};
function first() {
 return {reason: "terminal", runs: [summary], collection: {kind: "first", report: {...summary, report}, nativeUsage: usage,
  receipt: {role: "coder", profile: "typescript", version: 1, sessionId: "session", runId: "run", taskId: "task", collectionId: "collection", toolCallId: "call", native: "claimed", originEntryId: "origin", kind: "collected"} satisfies Extract<LedgerRecord, {kind: "collected"}>}};
}
test("only first wait collection emits usage and exact receipt; stale awaited collection emits nothing", async () => {
 let result: any = first(), calls = 0;
 const f = fixture({context: () => context, controls: {wait: async (...args: unknown[]) => {
  calls++; assert.equal(args[0], context); assert.equal((args[3] as any).toolCallId, "call");
  assert.equal(typeof (args[3] as any).collectionId, "string"); return result;
 }} as any}); f.registration.show(f.ctx);
 const collected = await execute(f, "guild_wait", {runId: "run", timeoutMs: 0});
 assert.deepEqual(collected.usage, usage);
 assert.deepEqual((collected.details as any).guildBackground, {version: 1, sessionId: "session", runId: "run", taskId: "task", collectionId: "collection"});
 assert.match(JSON.stringify(collected.content), /child-reported claims \(not host-verified\)/);
 for (const next of [
  {reason: "terminal", runs: [summary], collection: {kind: "informational", report: first().collection.report}},
  ...["timeout", "question", "aborted"].map(reason => ({reason, runs: [summary]})),
 ]) {
  result = next; const value = await execute(f, "guild_wait", {runId: "run"});
  assert.equal(value.usage, undefined); assert.equal((value.details as any).guildBackground, undefined);
 }
 let resolve!: (value: any) => void;
 result = new Promise(r => {resolve = r;});
 const pending = execute(f, "guild_wait", {runId: "run"});
 f.current(false); resolve(first());
 await assert.rejects(pending, /unavailable/);
 assert.equal(calls, 6);
});
test("serialized result bounds escaped controls and multibyte reports while keeping summaries small and questions usable", async () => {
 const huge = ("🙂\u0001\n").repeat(30_000);
 const value = first(); value.collection.report.report = {...report, summary: huge};
 const f = fixture({context: () => context, controls: {
  wait: async () => value,
  status: () => [{...summary, question: {id: "question", text: huge}, usageKnown: false, usage: {input: 0}}],
 } as any}); f.registration.show(f.ctx);
 const result = await execute(f, "guild_wait", {runId: "run"});
 assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
 assert.match(JSON.stringify(result.content), /truncated/);
 assert.ok(!JSON.stringify(result).includes("\ufffd"));
 assert.ok(Buffer.byteLength(JSON.stringify(result.details)) < 2048);
 const status = await execute(f, "guild_status");
 assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 65536);
 assert.match(JSON.stringify(status.content), /question/);
 assert.match(JSON.stringify(status.content), /unknown/);
 assert.ok(!JSON.stringify(status.details).includes("input"));
});
test("errors are bounded and sanitized, and context reentry prevents service calls", async () => {
 let calls = 0;
 const f = fixture({context: () => {f.current(false); return context;}, controls: {status: () => {calls++; return [];}} as any});
 f.registration.show(f.ctx); await assert.rejects(execute(f, "guild_status"), /^Error: Background tools unavailable$/); assert.equal(calls, 0);
 const g = fixture({context: () => context, controls: {status: () => {throw new Error("secret".repeat(20000));}} as any});
 g.registration.show(g.ctx); await assert.rejects(execute(g, "guild_status"), /^Error: Background tools unavailable$/);
});
test("strict schemas allow only canonical coder/reviewer inputs, bounded identities and wait intervals", async () => {
 const {Check} = await import("typebox/value");
 let calls = 0;
 const f = fixture({context: () => context, controls: {start: () => {calls++; return summary;}} as any}); f.registration.show(f.ctx);
 const accepts = (name: string, args: unknown) => Check(f.definitions.get(name)!.parameters, args);
 for (const role of ["coder", "reviewer"]) assert.ok(accepts("guild_start", {role, profile: "typescript", task: "work"}));
 assert.ok(accepts("guild_start", {role: "coder", profile: "general", task: "work", practices: [{id: "tdd", policy: "required"}]}));
 for (const args of [
  {role: "writer", profile: "general", task: "work"}, {role: "coder", profile: "alias", task: "work"},
  {member: "typescript-coder", task: "work"}, {role: "coder", profile: "general", task: "work", extra: 1},
  {role: "reviewer", profile: "general", task: "work", practices: [{id: "tdd", policy: "required"}]},
 ]) { assert.equal(accepts("guild_start", args), false); await assert.rejects(execute(f, "guild_start", args), /unavailable/); }
 assert.equal(calls, 0);
 for (const runId of ["", " ", "\0", "x".repeat(257)]) assert.equal(accepts("guild_cancel", {runId}), false);
 assert.ok(accepts("guild_status", {}));
 assert.ok(accepts("guild_wait", {runId: "run", timeoutMs: 0}));
 assert.ok(accepts("guild_wait", {runId: "run", timeoutMs: 60000}));
 for (const timeoutMs of [-1, 60001, 1.5]) assert.equal(accepts("guild_wait", {runId: "run", timeoutMs}), false);
 assert.equal(accepts("guild_send", {runId: "run", message: "hi", questionId: ""}), false);
});

test("first collection with unavailable native usage still emits exact receipt correlation", async () => {
 const known = first();
 const {nativeUsage: _usage, ...collection} = known.collection;
 const value = {...known, collection: {...collection, receipt: {...collection.receipt, native: "unavailable"} satisfies Extract<LedgerRecord, {kind: "collected"}>}};
 const f = fixture({context: () => context, controls: {wait: async () => value} as any});
 f.registration.show(f.ctx);
 const result = await execute(f, "guild_wait", {runId: "run"});
 assert.equal(Object.hasOwn(result, "usage"), false);
 assert.deepEqual((result.details as any).guildBackground,
  {version: 1, sessionId: "session", runId: "run", taskId: "task", collectionId: "collection"});
});
for (const boundary of ["unsubscribe", "hidden-register"] as const) {
 test(`cleanup ${boundary} faults attempt every withdrawal, fence retained callbacks and prevent reopening`, async () => {
  const f = fixture();
  if (boundary === "unsubscribe") {
   const on = f.pi.on.bind(f.pi);
   f.pi.on = ((_name: string, handler: any) => {
    on("tool_call", handler);
    return () => {throw new Error("host unsubscribe failed");};
   }) as ExtensionAPI["on"];
  }
  f.registration.show(f.ctx);
  const originals = [...f.definitions.values()], hook = [...f.hooks][0];
  const attempted: string[] = [];
  const register = f.pi.registerTool.bind(f.pi);
  f.pi.registerTool = tool => {
   if (tool.exposure === "hidden") {
    attempted.push(tool.name);
    if (boundary === "hidden-register" && attempted.length === 1) throw new Error("host withdrawal failed");
   }
   register(tool);
  };
  assert.doesNotThrow(() => f.registration.hide());
  assert.deepEqual(attempted, originals.map(tool => tool.name));
  for (const tool of originals)
   await assert.rejects(tool.execute("call", {}, undefined, undefined, f.ctx as any), /unavailable/);
  assert.equal(hook({toolName: "guild_wait", parentToolCallId: "p"}), undefined);
  f.registration.show(f.ctx);
  assert.equal(hook({toolName: "guild_wait", parentToolCallId: "p"}), undefined);
  await assert.rejects(execute(f, "guild_status"), /unavailable/);
  assert.doesNotThrow(() => f.registration.dispose());
 });
}
test("send retains bounded stable update IDs without inventing IDs for replies", async () => {
 let updateId: string | undefined = "update-stable";
 const f = fixture({context: () => context, controls: {send: async () => ({disposition: "handled", updateId})} as any});
 f.registration.show(f.ctx);
 const result = await execute(f, "guild_send", {runId: "run", message: "update"});
 assert.equal((result.details as any).updateId, "update-stable");
 assert.match(JSON.stringify(result.content), /update-stable/);
 assert.match(JSON.stringify(result.content), /not a scope acknowledgement/);
 updateId = "🙂".repeat(1000);
 const bounded = await execute(f, "guild_send", {runId: "run", message: "update"});
 assert.ok(Buffer.byteLength((bounded.details as any).updateId) <= 256);
 assert.ok(!(bounded.details as any).updateId.includes("\ufffd"));
 updateId = undefined;
 const reply = await execute(f, "guild_send", {runId: "run", message: "reply", questionId: "q"});
 assert.equal(Object.hasOwn(reply.details as object, "updateId"), false);
});
