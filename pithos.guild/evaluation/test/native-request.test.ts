import assert from "node:assert/strict";
import { test } from "node:test";
import { guardFinalPayload, installNativeRequestGate } from "../src/native-request.ts";

const pricing = { version: 1 as const, model: "test/fake", api: "test-api", serviceTier: "base" as const,
  cost: { input: 1000000, output: 1000000, cacheRead: 1000000, cacheWrite: 1000000 } };
const model = { provider: "test", id: "fake", api: "test-api", cost: pricing.cost, baseUrl: "https://example.com" };
const message = { role: "assistant", provider: "test", model: "fake", api: "test-api", responseId: "resp-test", stopReason: "stop",
  usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 13, cost: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, total: 13 } } };
const completion = { type: "response.completed", response: { id: "resp-test", status: "completed", service_tier: "default",
  usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 } } } };

const expected = { model: "gpt-6-astra", thinking: "high" };
const payload = () => ({ model: expected.model, reasoning: { effort: "high" }, input: [{ text: "unretained-prompt" }] });

test("checks the final SDK payload after callback mutation or replacement without retaining content", async () => {
  const records: unknown[] = [];
  const original = payload();
  const wrapped = guardFinalPayload(async body => { (body as any).extra = true; }, expected, r => records.push(r));
  assert.deepEqual(await wrapped(original), { ...original, extra: true });
  assert.equal((original as any).extra, true);
  assert.deepEqual(records, [{ model: expected.model, thinking: "high", serviceTier: "omitted" }]);
  assert.doesNotMatch(JSON.stringify(records), /unretained|input|extra/);
  const replacement = payload();
  const observed = await guardFinalPayload(() => replacement, expected, () => {})(original);
  assert.deepEqual(observed, replacement); assert.notEqual(observed, replacement);
  await assert.rejects(guardFinalPayload(body => { (body as any).service_tier = "priority"; }, expected, () => {})(payload()), /Final request policy mismatch/);
});

for (const field of ["instructions", "tools", "input"]) test(`payload callback cannot replace SDK-supplied ${field}`, async () => {
  for (const replacement of [false, true]) {
    let reports = 0;
    const body = { ...payload(), instructions: "SDK instructions", tools: [{ type: "function", name: "read" }],
      input: [{ type: "function_call_output", call_id: "child-1", output: "original result" }] };
    const callback = (value: any) => {
      const changed = replacement ? structuredClone(value) : value;
      changed[field] = field === "instructions" ? "unapproved instructions" : [];
      return replacement ? changed : undefined;
    };
    await assert.rejects(guardFinalPayload(callback, expected, () => { reports++; })(body), /Final request policy mismatch/);
    assert.equal(reports, 0);
  }
});

test("candidate content rejects unreviewed outbound fields before reporting", async () => {
  for (const extra of [{ extra: "private-detail" }, { authorization: "private-detail" }, { metadata: { harmless: "private-detail" } }]) {
    let reports = 0;
    const body = { ...payload(), instructions: "Instructions", tools: [], input: [], ...extra };
    await assert.rejects(guardFinalPayload(undefined, expected, () => { reports++; }, () => { reports++; })(body),
      { message: "Final request observation failed" });
    assert.equal(reports, 0);
  }
});

test("candidate schema rejects materialized extras on input and callback replacement without echoing them", async () => {
  const clean = () => ({ ...payload(), instructions: "Instructions", tools: [], input: [] });
  for (const mode of ["input", "mutation", "replacement"]) {
    let reports = 0, callbacks = 0;
    const unsafe = () => ({ ...clean(), credentials: "synthetic-private-detail" });
    const initial = mode === "input" ? { toJSON: unsafe } : clean();
    const callback = (body: any) => {
      callbacks++;
      if (mode === "mutation") Object.defineProperty(body, "headers", { enumerable: true, get: () => ({ Authorization: "synthetic-private-detail" }) });
      if (mode === "replacement") return { toJSON: unsafe };
    };
    await assert.rejects(guardFinalPayload(callback, expected, () => { reports++; }, () => { reports++; })(initial),
      { message: "Final request observation failed" });
    assert.equal(reports, 0); assert.equal(callbacks, mode === "input" ? 0 : 1);
  }
});

test("candidate schema closes nested records after callback materialization", async () => {
  const body = { ...payload(), instructions: "Instructions", tools: [{ type: "function", name: "read" }], input: [] };
  for (const change of [
    (v: any) => v.reasoning.authorization = "private-detail",
    (v: any) => v.tools[0].headers = { Authorization: "private-detail" },
    (v: any) => v.input.push({ role: "user", content: "ok", credential: "private-detail" }),
    (v: any) => v.tools[0].parameters = { type: "object", unexpected: "private-detail" },
  ]) {
    let reports = 0;
    await assert.rejects(guardFinalPayload(() => ({ toJSON() { const v = structuredClone(body); change(v); return v; } }),
      expected, () => { reports++; }, () => { reports++; })(structuredClone(body)), { message: "Final request observation failed" });
    assert.equal(reports, 0);
  }
});

test("candidate gate blocks active access material before callbacks, reports and transport", async () => {
  for (const location of ["instructions", "input", "key", "callback", "getter", "short", "missing"]) {
    const secret = location === "short" ? "a" : "synthetic-active-access-material", events: any[] = [];
    let calls = 0, callbacks = 0;
    const body: any = { model: "fake", reasoning: { effort: "high" }, instructions: "Instructions", tools: [],
      input: [{ role: "user", content: "Task" }] };
    if (location === "instructions") body.instructions = `prefix ${secret} suffix`;
    if (location === "input") body.input[0].content = `prefix ${secret} suffix`;
    if (location === "key") body.tools = [{ type: "function", name: "read", parameters: { type: "object", properties: { [secret]: { type: "string" } } } }];
    if (location === "getter") Object.defineProperty(body, "instructions", { enumerable: true, get: () => `prefix ${secret} suffix` });
    const provider = { async *streamSimple(_m: any, _c: any, options: any) {
      const final = await options.onPayload(body);
      await options.fetch("https://example.com", { body: JSON.stringify(final) });
      yield { type: "done", message };
    } };
    class Runtime { async prepareRequest(m: any, options: any) { return { model: m, provider, options }; } }
    const restore = installNativeRequestGate(Runtime, { pricing, thinking: "high", verifyContext() {}, report: e => events.push(e),
      requestContentEvidence: "candidate-native-v2", webSocketHost: {} });
    try {
      await assert.rejects(async () => {
        const prepared = await new Runtime().prepareRequest(model, { maxRetries: 0,
          apiKey: location === "missing" ? undefined : secret,
          onPayload() { callbacks++; if (location === "callback") return { toJSON: () => ({ ...body, instructions: `prefix ${secret} suffix` }) }; },
          fetch: async () => { calls++; return new Response(); } });
        for await (const _ of prepared.provider.streamSimple(model, {}, prepared.options)) {}
      }, /^(?:Error: )?(?:Native request preparation failed|Final request observation failed)$/);
      assert.equal(calls, 0);
      assert.equal(callbacks, location === "callback" ? 1 : 0);
      assert.equal(events.some(e => e.type === "payload" || e.type === "request_content"), false);
      assert.doesNotMatch(JSON.stringify(events), /synthetic-active-access-material/);
    } finally { restore(); }
  }
});

test("candidate v2 mode reports detached logical and outbound request content", async () => {
  const events: any[] = [], body = { model: "fake", reasoning: { effort: "high" }, instructions: "private instructions",
    tools: [{ type: "function", name: "read" }], input: [{ role: "user", content: "private task" }] };
  const provider = { async *streamSimple(_m: any, _c: any, options: any) {
    const final = await options.onPayload(body); await (await options.fetch("https://example.com", { body: JSON.stringify(final) })).text();
    yield { type: "done", message };
  } };
  class Runtime { async prepareRequest(m: any, options: any) { return { model: m, provider, options: { ...options,
    onPayload(value: any) { value.service_tier = "default"; } } }; } }
  const restore = installNativeRequestGate(Runtime, { pricing, thinking: "high", verifyContext: () => {}, report: e => events.push(e),
    requestContentEvidence: "candidate-native-v2", webSocketHost: {} });
  try {
    const prepared = await new Runtime().prepareRequest(model, { maxRetries: 0, apiKey: "synthetic-active-access-material",
      fetch: async () => new Response('data: ' + JSON.stringify(completion)) });
    for await (const _ of prepared.provider.streamSimple(model, {}, prepared.options)) {}
    const content = events.find(event => event.type === "request_content");
    assert.match(content.requestId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(content.logical, { instructions: body.instructions, tools: body.tools, input: body.input });
    assert.deepEqual(content.outbound, { ...body, service_tier: "default" });
    assert.ok(Object.isFrozen(content.logical)); assert.ok(Object.isFrozen(content.outbound));
    body.instructions = "changed after report"; body.input[0].content = "changed after report";
    assert.equal(content.logical.instructions, "private instructions"); assert.equal(content.logical.input[0].content, "private task");
  } finally { restore(); }
  const ordinary: any[] = [];
  const restoreOrdinary = installNativeRequestGate(Runtime, { pricing, thinking: "high", verifyContext: () => {}, report: e => ordinary.push(e), webSocketHost: {} });
  try {
    const prepared = await new Runtime().prepareRequest(model, { maxRetries: 0, fetch: async () => new Response('data: ' + JSON.stringify(completion)) });
    for await (const _ of prepared.provider.streamSimple(model, {}, prepared.options)) {}
    assert.equal(ordinary.some(event => event.type === "request_content"), false);
  } finally { restoreOrdinary(); }
});

test("guards the serialized payload, not a mutable pre-serialization view, and sanitizes failures", async () => {
  const body = { ...payload(), toJSON: () => ({ ...payload(), model: "wrong-model" }) };
  await assert.rejects(guardFinalPayload(undefined, expected, () => {})(body), /Final request policy mismatch/);
  for (const replacement of [null, [], { ...payload(), reasoning: { effort: "low" } }, { ...payload(), service_tier: "auto" }]) {
    await assert.rejects(guardFinalPayload(() => replacement, expected, () => {})(payload()), /Final request policy mismatch/);
  }
  await assert.rejects(guardFinalPayload(() => { throw Error("unretained-private-detail"); }, expected, () => {})(payload()), { message: "Final request observation failed" });
  await assert.rejects(guardFinalPayload(undefined, expected, () => { throw Error("unretained-private-detail"); })(payload()), { message: "Final request observation failed" });
});

test("bounds materialized request bytes before parsing or reporting content", async () => {
  let reports = 0;
  const body = { ...payload(), input: [{ text: "😀".repeat(262144) }] };
  await assert.rejects(guardFinalPayload(undefined, expected, () => { reports++; })(body), /Final request observation failed/);
  assert.equal(reports, 0);
});

test("blocks transport entry if the SDK bypasses the final-payload callback", async () => {
  let calls = 0;
  const events: any[] = [];
  const provider = { async *streamSimple(_m: any, _c: any, options: any) { await options.fetch("https://example.com"); yield { type: "done", message }; } };
  class Runtime { async prepareRequest(m: any, options: any) { return { model: m, provider, options }; } }
  const restore = installNativeRequestGate(Runtime, { pricing, thinking: "high", verifyContext: () => {}, report: e => events.push(e), webSocketHost: {} });
  try {
    const prepared = await new Runtime().prepareRequest(model, { maxRetries: 0, fetch: async () => { calls++; return new Response(); } });
    await assert.rejects(async () => { for await (const _ of prepared.provider.streamSimple(model, {}, prepared.options)) {} });
    assert.equal(calls, 0);
    assert.equal(events.at(-1).complete, false);
  } finally { restore(); }
});

test("closes error and unterminated streams, and exposes no result shortcut around reconciliation", async () => {
  for (const mode of ["error", "empty", "throw"]) {
    const events: any[] = [];
    const provider = { streamSimple() {
      if (mode === "throw") throw Error("private-provider-setup");
      return { result: async () => message, async *[Symbol.asyncIterator]() { if (mode === "error") yield { type: "error", error: message }; } };
    } };
    class Runtime { async prepareRequest(m: any, options: any) { return { model: m, provider, options }; } }
    const restore = installNativeRequestGate(Runtime, { pricing, thinking: "high", verifyContext: () => {}, report: e => events.push(e), webSocketHost: {} });
    try {
      const prepared = await new Runtime().prepareRequest(model, { maxRetries: 0 });
      if (mode === "throw") assert.throws(() => prepared.provider.streamSimple(), { message: "Native provider stream failed" });
      else {
        const source = prepared.provider.streamSimple() as any;
        assert.equal(source.result, undefined);
        if (mode === "empty") await assert.rejects(async () => { for await (const _ of source) {} }, /Missing native request completion/);
        else {
          const iterator = source[Symbol.asyncIterator]();
          assert.equal((await iterator.next()).value.type, "error");
          assert.equal(events.at(-1).complete, false);
          await iterator.return();
        }
      }
      assert.equal(events.at(-1).type, "request_end"); assert.equal(events.at(-1).complete, false);
    } finally { restore(); }
  }
});

test("sanitizes setup/report failures and blocks prepared model or retry drift", async () => {
  for (const mode of ["report", "context", "prepare", "model", "retry"]) {
    let preparations = 0;
    class Runtime { async prepareRequest(m: any, options: any) {
      preparations++;
      if (mode === "prepare") throw Error("unretained-prepare-detail");
      return { model: mode === "model" ? { ...m, id: "wrong" } : m, provider: {}, options };
    } }
    const original = Runtime.prototype.prepareRequest;
    const restore = installNativeRequestGate(Runtime, { pricing, thinking: "high", webSocketHost: {},
      verifyContext: () => { if (mode === "context") throw Error("unretained-context-detail"); },
      report: () => { if (mode === "report") throw Error("unretained-report-detail"); } });
    try {
      await assert.rejects(new Runtime().prepareRequest(model, { maxRetries: mode === "retry" ? 1 : 0 }), /Native request/);
      assert.equal(preparations, ["report", "context"].includes(mode) ? 0 : 1);
    } finally { restore(); }
    assert.equal(Runtime.prototype.prepareRequest, original);
  }
});

for (const changed of ["model", "instructions", "tools", "continuation"]) test(`HTTP rejects ${changed} changed after the payload callback`, async () => {
  let calls = 0;
  const events: any[] = [];
  const provider = { async *streamSimple(_m: any, _c: any, options: any) {
    const body = await options.onPayload({ model: "fake", reasoning: { effort: "high" }, instructions: "private-instructions",
      tools: [{ type: "function", name: "read" }], input: [{ type: "function_call_output", call_id: "child-1", output: "private-child-result" }] });
    if (changed === "model") body.model = "other";
    if (changed === "instructions") body.instructions = "replaced instructions";
    if (changed === "tools") body.tools = [];
    if (changed === "continuation") body.input[0].output = "replaced result";
    await (await options.fetch("https://example.com", { method: "POST", body: JSON.stringify(body) })).text();
    yield { type: "done", message };
  } };
  class Runtime { async prepareRequest(m: any, options: any) { return { model: m, provider, options }; } }
  const restore = installNativeRequestGate(Runtime, { pricing, thinking: "high", verifyContext: () => {}, report: e => events.push(e), webSocketHost: {} });
  try {
    const prepared = await new Runtime().prepareRequest(model, { maxRetries: 0,
      fetch: async () => { calls++; return new Response('data: ' + JSON.stringify(completion)); } });
    await assert.rejects(async () => { for await (const _ of prepared.provider.streamSimple(model, {}, prepared.options)) {} }, /Outbound request mismatch/);
    assert.equal(calls, 0); assert.equal(events.at(-1).complete, false);
    assert.doesNotMatch(JSON.stringify(events), /private-instructions|private-child-result|replaced result/);
  } finally { restore(); }
});

for (const mode of ["same", "continuation", "frame"]) test(`WebSocket outbound fidelity: ${mode}`, async () => {
  let sends = 0;
  const events: any[] = [];
  class Socket extends EventTarget {
    send(_data: unknown) { sends++; this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(completion) })); }
    close() {}
  }
  const host = { WebSocket: Socket as unknown as typeof WebSocket };
  const provider = { async *streamSimple(_m: any, _c: any, options: any) {
    const body = await options.onPayload({ model: "fake", reasoning: { effort: "high" }, instructions: "private-instructions",
      tools: [], input: [{ type: "function_call_output", call_id: "child-1", output: "private-child-result" }] });
    const socket = new host.WebSocket("wss://example.com");
    if (mode === "continuation") body.input[0].output = "substituted result";
    socket.send(JSON.stringify({ type: mode === "frame" ? "unknown.frame" : "response.create", ...body }));
    yield { type: "done", message };
  } };
  class Runtime { async prepareRequest(m: any, options: any) { return { model: m, provider, options }; } }
  const restore = installNativeRequestGate(Runtime, { pricing, thinking: "high", verifyContext: () => {}, report: e => events.push(e), webSocketHost: host });
  try {
    const prepared = await new Runtime().prepareRequest(model, { maxRetries: 0 });
    const consume = async () => { for await (const _ of prepared.provider.streamSimple(model, {}, prepared.options)) {} };
    if (mode === "same") await consume(); else await assert.rejects(consume(), /Outbound request mismatch/);
    assert.equal(sends, mode === "same" ? 1 : 0);
    assert.equal(events.at(-1).complete, mode === "same");
    assert.doesNotMatch(JSON.stringify(events), /private-instructions|private-child-result|substituted result/);
  } finally { restore(); }
});

for (const mode of ["alternating", "throws"]) test(`HTTP checked body accessor: ${mode}`, async () => {
  let reads = 0, sent: unknown, expectedBody: string | undefined;
  const provider = { async *streamSimple(_m: any, _c: any, options: any) {
    const body = await options.onPayload({ model: "fake", reasoning: { effort: "high" } });
    expectedBody = JSON.stringify(body);
    await (await options.fetch("https://example.com", { method: "POST", get body() {
      if (mode === "throws") throw Error("private-init-body");
      return ++reads === 1 ? expectedBody : JSON.stringify({ ...body, model: "changed-after-check" });
    } })).text();
    yield { type: "done", message };
  } };
  class Runtime { async prepareRequest(m: any, options: any) { return { model: m, provider, options }; } }
  const restore = installNativeRequestGate(Runtime, { pricing, thinking: "high", verifyContext: () => {}, report: () => {}, webSocketHost: {} });
  try {
    const prepared = await new Runtime().prepareRequest(model, { maxRetries: 0,
      fetch: async (_url: any, init: any) => { sent = init.body; return new Response('data: ' + JSON.stringify(completion)); } });
    const consume = async () => { for await (const _ of prepared.provider.streamSimple(model, {}, prepared.options)) {} };
    if (mode === "throws") {
      await assert.rejects(consume(), { message: "Outbound request mismatch" });
      assert.equal(sent, undefined);
    } else {
      await consume(); assert.equal(sent, expectedBody); assert.equal(reads, 1);
    }
  } finally { restore(); }
});

for (const mode of ["reordered", "oversized", "invalid-utf8", "nonfinite"]) test(`HTTP serialized representation: ${mode}`, async () => {
  let sends = 0;
  const events: any[] = [];
  const provider = { async *streamSimple(_m: any, _c: any, options: any) {
    const body = await options.onPayload({ model: "fake", reasoning: { effort: "high" }, value: "\ud800", n: null });
    let serialized = JSON.stringify(Object.fromEntries(Object.entries(body).reverse()));
    if (mode === "oversized") serialized = serialized.padEnd(1024 * 1024 + 1, " ");
    if (mode === "nonfinite") serialized = serialized.replace('"n":null', '"n":1e400');
    if (mode === "invalid-utf8") serialized = serialized.replace("\\ud800", "\ud800");
    await (await options.fetch("https://example.com", { method: "POST", body: serialized })).text();
    yield { type: "done", message };
  } };
  class Runtime { async prepareRequest(m: any, options: any) { return { model: m, provider, options }; } }
  const restore = installNativeRequestGate(Runtime, { pricing, thinking: "high", verifyContext: () => {}, report: e => events.push(e), webSocketHost: {} });
  try {
    const prepared = await new Runtime().prepareRequest(model, { maxRetries: 0,
      fetch: async () => { sends++; return new Response('data: ' + JSON.stringify(completion)); } });
    const consume = async () => { for await (const _ of prepared.provider.streamSimple(model, {}, prepared.options)) {} };
    if (mode === "reordered") await consume(); else await assert.rejects(consume(), /Outbound request mismatch/);
    assert.equal(sends, mode === "reordered" ? 1 : 0);
    assert.equal(events.at(-1).complete, mode === "reordered");
  } finally { restore(); }
});

for (const mode of ["early", "payload", "body", "accessor", "after-response"]) test(`caught ${mode} policy failure cannot resume through another wrapped send`, async () => {
  let sends = 0;
  const events: any[] = [];
  const provider = { async *streamSimple(_m: any, _c: any, options: any) {
    if (mode === "early") {
      try { await options.fetch("https://example.com", { body: "{}" }); } catch { /* simulated SDK recovery */ }
    }
    if (mode === "payload") {
      try { await options.onPayload({ model: "wrong", reasoning: { effort: "high" } }); } catch { /* simulated SDK recovery */ }
    }
    const body = await options.onPayload({ model: "fake", reasoning: { effort: "high" } });
    if (mode === "after-response") await (await options.fetch("https://example.com", { body: JSON.stringify(body) })).text();
    if (mode === "body" || mode === "accessor" || mode === "after-response") {
      try {
        await options.fetch("https://example.com", mode !== "accessor"
          ? { body: JSON.stringify({ ...body, model: "wrong" }) }
          : { get body() { throw Error("private-accessor"); } });
      } catch { /* simulated SDK recovery */ }
    }
    if (mode !== "after-response") await (await options.fetch("https://example.com", { method: "POST", body: JSON.stringify(body) })).text();
    yield { type: "done", message };
  } };
  class Runtime { async prepareRequest(m: any, options: any) { return { model: m, provider, options }; } }
  const restore = installNativeRequestGate(Runtime, { pricing, thinking: "high", verifyContext: () => {}, report: e => events.push(e), webSocketHost: {} });
  try {
    const prepared = await new Runtime().prepareRequest(model, { maxRetries: 0,
      fetch: async () => { sends++; return new Response('data: ' + JSON.stringify(completion)); } });
    await assert.rejects(async () => { for await (const _ of prepared.provider.streamSimple(model, {}, prepared.options)) {} });
    assert.equal(sends, mode === "after-response" ? 1 : 0); assert.equal(events.at(-1).complete, false);
  } finally { restore(); }
});

test("binds prepared SDK requests to final payloads and every transport attempt", async () => {
  let calls = 0, checks = 0;
  const events: any[] = [];
  const provider = { async *streamSimple(_model: any, _context: any, options: any) {
    const body = await options.onPayload({ model: "fake", reasoning: { effort: "high" } });
    await (await options.fetch("https://example.com", { method: "POST", body: JSON.stringify(body) })).text();
    yield { type: "done", message };
  } };
  class Runtime { async prepareRequest(m: any, options: any) { return { model: m, provider, options }; } }
  const config = { pricing, thinking: "high", verifyContext: () => { checks++; }, report: (e: any) => events.push(e), webSocketHost: {} };
  let disposed = false;
  const restore = installNativeRequestGate(Runtime, config);
  config.thinking = "low";
  try {
    const prepared = await new Runtime().prepareRequest(model, { maxRetries: 0, fetch: async () => { calls++; return new Response('data: ' + JSON.stringify(completion)); } });
    assert.throws(() => { restore(); disposed = true; }, /active native request/);
    for await (const event of prepared.provider.streamSimple(model, {}, prepared.options)) assert.equal(event.message, message);
    assert.equal(calls, 1); assert.equal(checks, 2);
    assert.deepEqual(events.map(e => e.type), ["request_start", "payload", "transport", "transport", "transport", "request_end"]);
    assert.equal(new Set(events.map(e => e.requestId)).size, 1);
    assert.equal(events.at(-1).complete, true);
    assert.equal(provider.streamSimple === prepared.provider.streamSimple, false);
  } finally { if (!disposed) restore(); }
});
