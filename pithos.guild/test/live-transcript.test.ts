import assert from "node:assert/strict";
import { it } from "node:test";
import { LiveTranscriptStore } from "../src/live-transcript.ts";

const run = (id = "r") => ({ id, role: "coder", profile: "typescript", task: "task", phase: "queued" as const, startedAt: 1 });

it("live transcript lifecycle provides immutable snapshots and isolated subscriptions", () => {
  const store = new LiveTranscriptStore();
  let calls = 0;
  store.subscribe(() => { throw new Error("observer"); });
  const unsubscribe = store.subscribe(() => { calls++; });
  store.start(run());
  const first = store.get("r")!;
  assert.equal(store.get("r"), first);
  assert.ok(Object.isFrozen(first));
  store.updatePhase("r", "running");
  assert.equal(first.phase, "queued");
  store.finish("r", "failed", "diagnostic");
  assert.equal(store.get("r")!.diagnostic, "diagnostic");
  assert.equal(store.list().active.length, 0);
  assert.equal(store.list().recent.length, 1);
  assert.equal(calls, 3);
  unsubscribe();
  store.dispose();
  store.start(run("later"));
  assert.equal(store.list().recent.length, 0);
  assert.equal(store.get("later"), undefined);
  assert.equal(calls, 3);
});

it("live transcript reconciles deltas, updated snapshots and final assistant content", () => {
  const store = new LiveTranscriptStore();
  store.start(run());
  store.ingest("r", { type: "message_start", message: { role: "assistant" } });
  store.ingest("r", { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "par" } });
  assert.equal(store.get("r")!.entries[0].content, "par");
  store.ingest("r", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } });
  store.ingest("r", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }] } });
  store.ingest("r", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }] } });
  assert.deepEqual(store.get("r")!.entries.map(e => e.content), ["final"]);
  const firstId = store.get("r")!.entries[0].id;
  store.ingest("r", { type: "message_start", message: { role: "assistant" } });
  store.ingest("r", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "next" } });
  assert.notEqual(store.get("r")!.entries[1].id, firstId);
});

it("live transcript represents tool calls and duplicate results once", () => {
  const store = new LiveTranscriptStore();
  store.start(run());
  store.ingest("r", { type: "message_start", message: { role: "assistant" } });
  store.ingest("r", { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }] } });
  store.ingest("r", { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a" } });
  store.ingest("r", { type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text: "partial" }] } });
  assert.equal(store.get("r")!.entries[0].content, "partial");
  store.ingest("r", { type: "tool_execution_end", toolCallId: "t1", isError: false, result: { content: [{ type: "text", text: "done" }, { type: "image", data: "secret binary" }], details: { secret: "metadata" } } });
  store.ingest("r", { type: "message_end", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "done" }, { type: "image", data: "secret binary" }], isError: false } });
  const entries = store.get("r")!.entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "completed");
  assert.equal(entries[0].args, '{"path":"a"}');
  assert.equal(entries[0].content, "done\n[unsupported image content]");
  assert.doesNotMatch(JSON.stringify(entries), /secret|metadata/);
});

it("live transcript sanitizes untrusted plain strings and ignores private or malformed events", () => {
  const store = new LiveTranscriptStore();
  const unsafe = "\x1b]52;c;secret\x07\x1b[31mOK\x1b[0m\x00\x85\u202e\u2066\n\t";
  store.start({ ...run(), task: unsafe });
  assert.equal(store.get("r")!.task, "OK\n\t");
  for (const event of [null, {}, { type: "guild_ready", content: unsafe },
    { type: "message_end", message: { role: "user", content: unsafe } },
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private" } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "private", signature: "private" }] } },
    { type: "tool_execution_start", toolCallId: {}, toolName: "bad" }]) store.ingest("r", event);
  assert.equal(store.get("r")!.entries.length, 0);
  store.ingest("r", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: unsafe }, { type: "toolCall", id: "safe", name: "read", arguments: { path: unsafe } }] } });
  assert.equal(store.get("r")!.entries[0].content, "OK\n\t");
  assert.doesNotMatch(store.get("r")!.entries[1].args!, /secret|202e|2066|001b|0000/);
  store.finish("r", "cancelled", unsafe);
  assert.equal(store.get("r")!.diagnostic, "OK\n\t");
});

it("live transcript bounds per-run UTF-8 strings, streaming replacements, IDs and entry counts", () => {
  const store = new LiveTranscriptStore({ maxRunBytes: 700, maxEntries: 3, maxStringBytes: 160, maxTaskBytes: 80, maxIdBytes: 32 });
  store.start({ ...run(), task: "🙂".repeat(1000) });
  for (let index = 0; index < 20; index++) {
    store.ingest("r", { type: "message_start", message: { role: "assistant" } });
    store.ingest("r", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "🙂".repeat(1000) } });
    store.ingest("r", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final".repeat(1000) }] } });
    const snapshot = store.get("r")!;
    assert.ok(snapshot.retainedBytes <= 700);
    assert.ok(snapshot.entries.length <= 3);
    assert.ok(snapshot.entries.every(entry => Buffer.byteLength(entry.content) <= 160));
    assert.ok(!snapshot.task.includes("�"));
  }
  assert.ok(store.get("r")!.truncated);
  assert.ok(Buffer.byteLength(store.get("r")!.task) <= 80);
  store.ingest("r", { type: "tool_execution_start", toolCallId: "x".repeat(1000), args: { huge: "x".repeat(1000000) } });
  assert.ok(store.get("r")!.entries.every(entry => entry.id.length < 100));
  const last = store.get("r")!.entries.at(-1)!.id;
  store.ingest("r", { type: "message_start", message: { role: "assistant" } });
  store.ingest("r", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "new" } });
  assert.notEqual(store.get("r")!.entries.at(-1)!.id, last);
});

it("live transcript budgets all queued metadata and evicts recent runs with explicit omissions", () => {
  const store = new LiveTranscriptStore({ maxRuns: 4, maxTotalBytes: 600, maxRecentRuns: 2, maxRecentBytes: 200, maxTaskBytes: 80 });
  for (let index = 0; index < 30; index++) {
    store.start({ ...run(`r${index}`), task: "x".repeat(32768) });
    assert.ok(store.list().retainedBytes <= 600);
    assert.ok(store.list().active.length + store.list().recent.length <= 4);
  }
  assert.equal(store.get("r0"), undefined);
  assert.ok(store.list().omittedRuns > 0);
  for (const active of store.list().active) store.finish(active.id, "completed", "result");
  assert.ok(store.list().recent.length <= 2);
  assert.ok(store.list().recent.reduce((sum, snapshot) => sum + snapshot.retainedBytes, 0) <= 200);
  store.start({ ...run("z".repeat(10000)) });
  assert.equal(store.get("z".repeat(10000)), undefined);
  const tiny = new LiveTranscriptStore({ maxTotalBytes: 0, maxRunBytes: 0 });
  tiny.start(run());
  assert.equal(tiny.list().active.length, 0);
  assert.equal(tiny.list().omittedRuns, 1);
  const defaults = new LiveTranscriptStore();
  assert.equal(defaults.limits.maxRunBytes, 256 * 1024);
  assert.equal(defaults.limits.maxEntries, 500);
  assert.equal(defaults.limits.maxRecentRuns, 10);
  assert.equal(defaults.limits.maxRecentBytes, 2 * 1024 * 1024);
  assert.equal(defaults.limits.maxRuns, 64);
  assert.equal(defaults.limits.maxTotalBytes, 4 * 1024 * 1024);
});

it("live transcript treats message snapshots as authoritative and terminal runs as sealed", () => {
  const store = new LiveTranscriptStore();
  store.start(run());
  store.ingest("r", { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "start" }] } });
  assert.equal(store.get("r")!.entries[0].content, "start");
  store.ingest("r", { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "removed" } });
  store.ingest("r", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }, { type: "thinking", thinking: "hidden" }] } });
  assert.deepEqual(store.get("r")!.entries.map(entry => entry.content), ["final"]);
  const before = store.get("r");
  for (const event of [{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: -1, delta: "bad" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: "bad", delta: "bad" } }]) store.ingest("r", event);
  assert.equal(store.get("r"), before);
  store.finish("r", "completed");
  const terminal = store.get("r");
  store.updatePhase("r", "running");
  store.ingest("r", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "late" } });
  store.finish("r", "failed", "late");
  assert.equal(store.get("r"), terminal);
});

it("live transcript bounds tool arguments and results and never regresses a finalized tool", () => {
  const store = new LiveTranscriptStore({ maxStringBytes: 100, maxEntries: 5 });
  store.start(run());
  store.ingest("r", { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, "x".repeat(80)])) });
  assert.ok(store.get("r")!.truncated);
  assert.ok(Buffer.byteLength(store.get("r")!.entries[0].args!) <= 100);
  store.ingest("r", { type: "tool_execution_end", toolCallId: "a", isError: true, result: { content: [{ type: "text", text: "failed" }, { type: "audio", data: "private bytes" }] } });
  assert.equal(store.get("r")!.entries[0].content, "failed\n[unsupported audio content]");
  const done = store.get("r");
  store.ingest("r", { type: "tool_execution_update", toolCallId: "a", partialResult: { content: [{ type: "text", text: "late" }] } });
  store.ingest("r", { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { changed: true } });
  assert.equal(store.get("r"), done);
  store.ingest("r", { type: "tool_execution_end", toolCallId: "huge", result: { content: Array.from({ length: 20000 }, () => ({ type: "text", text: "🙂".repeat(100) })) } });
  assert.ok(store.get("r")!.entries.every(entry => Buffer.byteLength(entry.content) <= 100));
  assert.ok(Object.isFrozen(store.get("r")!.entries));
  assert.ok(Object.isFrozen(store.get("r")!.entries[0]));
  assert.throws(() => new LiveTranscriptStore({ maxRuns: -1 }), RangeError);
});

it("live transcript marks omitted assistant snapshots with a zero entry budget", () => {
  const store = new LiveTranscriptStore({ maxEntries: 0 });
  store.start(run());
  store.ingest("r", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "omitted" }] } });
  assert.equal(store.get("r")!.entries.length, 0);
  assert.equal(store.get("r")!.truncated, true);
});

it("live transcript keeps mixed text/tool order stable on duplicate final snapshots", () => {
  const store = new LiveTranscriptStore();
  store.start(run());
  store.ingest("r", { type: "message_start", message: { role: "assistant" } });
  store.ingest("r", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } });
  const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final" }, { type: "toolCall", id: "call", name: "read", arguments: {} }] } };
  store.ingest("r", event);
  const before = store.get("r")!;
  assert.deepEqual(before.entries.map(entry => entry.kind), ["text", "tool"]);
  store.ingest("r", event);
  assert.equal(store.get("r"), before);
});

it("normalizes every internal submission representation without retaining its envelope", () => {
  const store = new LiveTranscriptStore(); store.start(run());
  const args = {protocol: "guild/2", runId: "SECRET-RUN", taskId: "SECRET-TASK", compliance: [{secret: true}], payload: {secret: true}, summary: "Fixed\n\x1b[31m the inspector\x07"};
  const events = [
    {type: "message_end", message: {role: "assistant", content: [{type: "toolCall", id: "report", name: "guild_submit_result", arguments: args}]}},
    {type: "tool_execution_start", toolCallId: "report", toolName: "guild_submit_result", args},
    {type: "tool_execution_update", toolCallId: "report", partialResult: {content: [{type: "text", text: JSON.stringify(args)}]}},
    {type: "tool_execution_end", toolCallId: "report", result: {content: [{type: "text", text: JSON.stringify(args)}], details: {summary: "Updated summary"}}},
    {type: "message_end", message: {role: "toolResult", toolCallId: "report", toolName: "guild_submit_result", content: [{type: "text", text: JSON.stringify(args)}]}},
  ];
  for (const [index, event] of events.entries()) {
    store.ingest("r", event);
    const entries = store.get("r")!.entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].args, undefined);
    assert.match(entries[0].content, index >= 3 ? /Updated summary/ : /Fixed the inspector/);
    assert.doesNotMatch(JSON.stringify(entries), /protocol|SECRET|compliance|payload|taskId|runId|\\u001b|\\u0007/);
  }
  assert.match(store.get("r")!.entries[0].content, /Report submitted.*not host-validated/);
  assert.equal(store.get("r")!.phase, "queued");
  for (const type of ["tool_execution_start", "tool_execution_update", "tool_execution_end"]) {
    const isolated = new LiveTranscriptStore(); isolated.start(run());
    isolated.ingest("r", {type, toolCallId: "report", toolName: "guild_submit_result", result: {content: [{type: "text", text: JSON.stringify(args)}]}});
    assert.match(isolated.get("r")!.entries[0].content, /Report submission|Report submitted/);
    assert.doesNotMatch(JSON.stringify(isolated.get("r")!.entries), /SECRET|protocol|payload/);
  }
});
