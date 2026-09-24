import assert from "node:assert/strict";
import { test } from "node:test";
import { responseMeter, observeFetch, observeWebSocket, verifyResponseMeters } from "../src/response-observer.ts";

const completion = { type: "response.completed", response: { id: "resp-synthetic", model: "gpt-6-astra", status: "completed", service_tier: "default",
  usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 } },
  output: [{ text: "must-not-be-retained" }], secret: "must-not-be-retained" } };

test("extracts only raw terminal metering metadata without filling absent provider fields", () => {
  assert.deepEqual(responseMeter(completion), { responseId: "resp-synthetic", model: "gpt-6-astra", status: "completed", serviceTier: "default",
    input: 10, output: 3, total: 13, cacheRead: 2, cacheWrite: 1 });
  const missing = { type: "response.done", response: { id: "resp-empty", status: "completed" } };
  assert.deepEqual(responseMeter(missing), { responseId: "resp-empty", model: null, status: "completed", serviceTier: null,
    input: null, output: null, total: null, cacheRead: null, cacheWrite: null });
  assert.equal(responseMeter({ type: "response.output_text.delta", delta: "must-not-be-retained" }), undefined);
});

test("preserves explicit zero counts but treats invalid or omitted category values as unknown", () => {
  for (const value of [undefined, null, -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "0"]) {
    const event = structuredClone(completion);
    (event.response.usage.input_tokens_details as any).cache_write_tokens = value;
    assert.equal(responseMeter(event)?.cacheWrite, null);
  }
  const zero = structuredClone(completion); zero.response.usage.input_tokens_details.cache_write_tokens = 0;
  assert.equal(responseMeter(zero)?.cacheWrite, 0);
});

test("observes consumed SSE bytes unchanged while retaining neither request data nor response text", async () => {
  const raw = 'data: {"type":"response.output_text.delta","delta":"é-must-not-be-retained"}\n\n'
    + 'data: ' + JSON.stringify(completion) + '\n\n';
  const bytes = new TextEncoder().encode(raw), records: any[] = [];
  const init = { method: "POST", headers: { Authorization: "must-not-be-retained" }, body: "must-not-be-retained" };
  const fetcher = observeFetch(async (url, options) => {
    assert.equal(url, "https://example.com/private-path-must-not-be-retained"); assert.equal(options, init);
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset < bytes.length) controller.enqueue(bytes.slice(offset, ++offset)); else controller.close();
    } }), { status: 200, headers: { "content-type": "text/event-stream", "secret": "must-not-be-retained" } });
  }, record => records.push(record));
  const response = await fetcher("https://example.com/private-path-must-not-be-retained", init);
  assert.equal(response.status, 200); assert.equal(response.headers.get("secret"), "must-not-be-retained");
  assert.equal(await response.text(), raw);
  assert.deepEqual(records.map(r => r.type), ["start", "response", "end"]);
  assert.equal(records[0].transport, "sse"); assert.equal(new Set(records.map(r => r.attemptId)).size, 1);
  assert.deepEqual(records[1].meter, responseMeter(completion));
  assert.equal(records[2].reason, "eof");
  assert.doesNotMatch(JSON.stringify(records), /must-not-be-retained|Authorization|delta/);
});

test("retains failed/cancelled fetch attempts and bounds malformed observation without retaining payloads", async () => {
  for (const raw of ['data: not-json-secret\n\n', 'data: ' + 'secret'.repeat(200000), 'data: ' + JSON.stringify(completion)]) {
    const records: any[] = [];
    const response = await observeFetch(async () => new Response(raw), r => records.push(r))("https://example.com");
    assert.equal(await response.text(), raw);
    assert.equal(records.at(-1).reason, "eof");
    assert.equal(records.some(r => r.type === "observation_error"), !raw.includes('"response.completed"'));
    assert.doesNotMatch(JSON.stringify(records), /not-json|secret/);
  }
  const records: any[] = [], failure = Error("unretained-transport-detail");
  await assert.rejects(observeFetch(async () => { throw failure; }, r => records.push(r))("https://example.com"), e => e === failure);
  assert.deepEqual(records.map(r => [r.type, r.reason]), [["start", undefined], ["end", "error"]]);
  assert.doesNotMatch(JSON.stringify(records), /unretained/);
  let cancelled = false;
  const stopped: any[] = [];
  const response = await observeFetch(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), r => stopped.push(r))("https://example.com");
  await response.body!.cancel();
  assert.equal(cancelled, true); assert.equal(stopped.at(-1).reason, "cancelled");
  const empty: any[] = [];
  assert.equal((await observeFetch(async () => new Response(null, { status: 204 }), r => empty.push(r))("https://example.com")).status, 204);
  assert.equal(empty.at(-1).reason, "no_body");
});

test("preserves fetch response metadata and source read failures", async () => {
  const original = new Response("server-error-body", { status: 503, statusText: "Unavailable" });
  Object.defineProperties(original, { url: { value: "https://example.com/final" }, redirected: { value: true }, type: { value: "basic" } });
  const records: any[] = [];
  const wrapped = await observeFetch(async () => original, r => records.push(r))("https://example.com/start");
  assert.equal(wrapped.url, original.url); assert.equal(wrapped.redirected, true); assert.equal(wrapped.type, "basic");
  assert.equal(wrapped.status, 503); assert.equal(wrapped.statusText, "Unavailable");
  assert.equal(await wrapped.text(), "server-error-body");
  assert.equal(records.filter(r => r.type === "response").length, 0);
  const failure = Error("unretained-read-detail"), failed: any[] = [];
  const response = await observeFetch(async () => new Response(new ReadableStream({ pull(controller) { controller.error(failure); } })), r => failed.push(r))("https://example.com");
  await assert.rejects(response.text(), e => e === failure);
  assert.equal(failed.at(-1).reason, "error");
});

test("preserves early metering before a later malformed frame and sanitizes observer failures", async () => {
  const records: any[] = [];
  const raw = 'data: ' + JSON.stringify(completion) + '\n\ndata: malformed-secret\n\n';
  const response = await observeFetch(async () => new Response(raw), r => records.push(r))("https://example.com");
  assert.equal(await response.text(), raw);
  assert.deepEqual(records.map(r => r.type), ["start", "response", "observation_error", "end"]);
  let calls = 0;
  await assert.rejects(observeFetch(async () => { calls++; return new Response(); }, () => { throw Error("private-callback-detail"); })("https://example.com"), { message: "Response observation failed" });
  assert.equal(calls, 0);
  const failing = await observeFetch(async () => new Response('data: ' + JSON.stringify(completion)), r => { if (r.type === "response") throw Error("private-callback-detail"); })("https://example.com");
  await assert.rejects(failing.text(), { message: "Response observation failed" });
});

const pricing = { version: 1 as const, model: "test/fake", api: "test-api", serviceTier: "base" as const,
  cost: { input: 1000000, output: 1000000, cacheRead: 1000000, cacheWrite: 1000000 } };
const message = { role: "assistant", provider: "test", model: "fake", api: "test-api", responseId: "resp-synthetic", stopReason: "stop",
  usage: { input: 7, output: 3, totalTokens: 13, cacheRead: 2, cacheWrite: 1, cost: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, total: 13 } } };

test("reconciles every raw transport attempt with a distinct completed assistant response and frozen base price", async () => {
  const records: any[] = [], meterCompletion = structuredClone(completion); meterCompletion.response.model = "fake";
  await (await observeFetch(async () => new Response('data: ' + JSON.stringify(meterCompletion)), r => records.push(r))("https://example.com")).text();
  assert.equal(verifyResponseMeters(records, [message], pricing), true);
  for (const change of [
    (r: any[]) => r.shift(), (r: any[]) => r.pop(), (r: any[]) => r.push(r[0]),
    (r: any[]) => r[1].meter.cacheWrite = null, (r: any[]) => r[1].meter.serviceTier = null,
    (r: any[]) => r[1].meter.serviceTier = "priority", (r: any[]) => r[1].meter.responseId = "other-response",
    (r: any[]) => r[1].meter.input = 2, (r: any[]) => r[1].meter.total = 14,
    (r: any[]) => r[1].meter.status = "incomplete", (r: any[]) => r[1].transport = "websocket",
    (r: any[]) => r[0].extra = true,
    (r: any[]) => r.forEach(record => record.attemptId = "-".repeat(36)),
    (r: any[]) => r.unshift({ ...r[0], attemptId: "00000000-0000-4000-8000-000000000000" }, { ...r[2], attemptId: "00000000-0000-4000-8000-000000000000", reason: "error" }),
  ]) {
    const changed = structuredClone(records); change(changed);
    assert.equal(verifyResponseMeters(changed, [message], pricing), false);
  }
  assert.equal(verifyResponseMeters(records, [{ ...message, role: "user" }], pricing), false);
  const cancelled = structuredClone(records); cancelled.at(-1).reason = "cancelled";
  assert.equal(verifyResponseMeters(cancelled, [message], pricing), true);
  assert.equal(verifyResponseMeters(cancelled, [{ ...message, stopReason: "aborted" }], pricing), false);
  assert.equal(verifyResponseMeters(records, [message, message], pricing), false);
  assert.equal(verifyResponseMeters(records, [{ ...message, stopReason: "aborted" }], pricing), false);
  assert.equal(verifyResponseMeters([], [], pricing), false);
});

test("bounds whole SSE streams and rejects invalid UTF-8 without changing consumed bytes", async () => {
  const chunk = new TextEncoder().encode('data: ' + JSON.stringify({ type: "response.output_text.delta", delta: "a".repeat(512 * 1024) }) + '\n\n');
  let sent = 0;
  const records: any[] = [];
  const response = await observeFetch(async () => new Response(new ReadableStream({ pull(controller) {
    if (sent++ < 32) controller.enqueue(chunk); else controller.close();
  } })), r => records.push(r))("https://example.com");
  const reader = response.body!.getReader(); let received = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; assert.equal(next.value, chunk); received++; }
  assert.equal(received, 32); assert.equal(records.filter(r => r.type === "observation_error").length, 1);
  const invalid: any[] = [];
  const bad = await observeFetch(async () => new Response(new Uint8Array([0xff])), r => invalid.push(r))("https://example.com");
  assert.deepEqual(new Uint8Array(await bad.arrayBuffer()), new Uint8Array([0xff]));
  assert.equal(invalid.filter(r => r.type === "observation_error").length, 1);
});

class Socket extends EventTarget {
  static OPEN = 1;
  sent: unknown[] = [];
  constructor(...publicArgs: unknown[]) { super(); this.args = publicArgs; }
  args: unknown[];
  send(data: unknown) { this.sent.push(data); }
  close() { this.dispatchEvent(new Event("close")); }
  receive(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
}

test("observes WebSocket sends and cached reuse without changing frames or constructor arguments", () => {
  const records: any[] = [], Wrapped = observeWebSocket(Socket as any, r => records.push(r));
  const headers = { headers: { Authorization: "unretained-secret" } };
  const socket = new (Wrapped as any)("wss://example.com/private", headers) as Socket;
  assert.deepEqual(socket.args, ["wss://example.com/private", headers]);
  const incoming: unknown[] = []; socket.addEventListener("message", (event: any) => incoming.push(event.data));
  for (const value of [JSON.stringify(completion), new TextEncoder().encode(JSON.stringify(completion)).buffer]) {
    const outgoing = '{"type":"response.create","input":"unretained-secret"}';
    socket.send(outgoing); socket.receive(value);
    assert.equal(socket.sent.at(-1), outgoing); assert.equal(incoming.at(-1), value);
  }
  socket.close();
  assert.deepEqual(records.map(r => r.type), ["start", "response", "end", "start", "response", "end"]);
  assert.equal(new Set(records.map(r => r.attemptId)).size, 2);
  assert.ok(records.filter(r => r.type === "end").every(r => r.reason === "terminal"));
  assert.doesNotMatch(JSON.stringify(records), /unretained|Authorization|private/);
});

test("bounds whole WebSocket attempts and leaves sink failures incomplete without leaking errors", () => {
  const records: any[] = [], Wrapped = observeWebSocket(Socket as any, r => records.push(r));
  const socket = new (Wrapped as any)("wss://example.com") as Socket;
  socket.send("request");
  const chunk = JSON.stringify({ type: "response.output_text.delta", delta: "a".repeat(512 * 1024) });
  for (let i = 0; i < 32; i++) socket.receive(chunk);
  socket.receive(JSON.stringify(completion)); socket.close();
  assert.deepEqual(records.map(r => r.type), ["start", "observation_error", "end"]);
  const partial: any[] = [];
  const Failing = observeWebSocket(Socket as any, r => { if (r.type === "response") throw Error("private-sink-detail"); partial.push(r); });
  const failing = new (Failing as any)("wss://example.com") as Socket;
  failing.send("request"); failing.receive(JSON.stringify(completion));
  assert.deepEqual(partial.map(r => r.type), ["start"]);
  assert.equal(verifyResponseMeters(partial, [message], pricing), false);
  assert.doesNotMatch(JSON.stringify(partial), /private-sink-detail/);
});

test("retains WebSocket failures, malformed frames and overlapping sends without dropping attempts", () => {
  for (const failure of ["close", "error", "malformed", "oversized", "blob", "send", "overlap"]) {
    class Fallible extends Socket { override send(data: unknown) { if (failure === "send") throw Error("unretained-send-error"); super.send(data); } }
    const records: any[] = [], Wrapped = observeWebSocket(Fallible as any, r => records.push(r));
    const socket = new (Wrapped as any)("wss://example.com") as Socket;
    if (failure === "send") assert.throws(() => socket.send("request"), /unretained-send-error/);
    else {
      socket.send("request");
      if (failure === "error") socket.receive(JSON.stringify({ type: "error", message: "unretained-error" }));
      if (failure === "malformed") socket.receive("not-json-secret");
      if (failure === "oversized") socket.receive("s".repeat(1024 * 1024 + 1));
      if (failure === "blob") socket.receive(new Blob(["unsupported"]));
      if (failure === "overlap") assert.throws(() => socket.send("second"), /Overlapping WebSocket/);
      socket.close();
    }
    assert.equal(records[0].type, "start"); assert.equal(records.at(-1).type, "end", failure);
    assert.equal(records.filter(r => r.type === "start").length, 1);
    if (["malformed", "oversized", "blob", "overlap"].includes(failure)) assert.ok(records.some(r => r.type === "observation_error"), failure);
    assert.equal(records.some(r => r.type === "response"), false);
    assert.doesNotMatch(JSON.stringify(records), /unretained|secret|unsupported/);
  }
});
