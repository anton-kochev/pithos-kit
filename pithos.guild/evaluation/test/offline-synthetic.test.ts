import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { syntheticTransport } from "../src/offline-synthetic.ts";

const payload = JSON.stringify({ type: "response.create", model: "gpt-6-astra", reasoning: { effort: "high" } });
test("Guild synthetic parent emits two canonical handovers then one final turn on its cached socket", async () => {
  const transport = syntheticTransport({ actor: "guild-parent", identity: "parent-17" });
  const socket = new transport.WebSocket("wss://example.invalid");
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  const turn = (data = payload) => new Promise<any>(resolve => {
    const listener = (event: Event) => { const data = JSON.parse((event as MessageEvent).data); if (data.type === "response.completed") { socket.removeEventListener("message", listener); resolve(data.response); } };
    socket.addEventListener("message", listener); socket.send(data);
  });
  const first = await turn();
  assert.throws(() => socket.send(payload), /Synthetic payload mismatch/);
  const last = await turn(JSON.stringify({ ...JSON.parse(payload), input: ["explorer", "coder"].map(role => ({ type: "function_call_output", call_id: `call-synthetic-${role}`, output: "Synthetic offline result" })) }));
  assert.deepEqual(first.output.map((item: any) => [item.name, JSON.parse(item.arguments).role]), [["guild_handover", "explorer"], ["guild_handover", "coder"]]);
  assert.ok(first.output.every((item: any) => JSON.parse(item.arguments).profile === "typescript"));
  assert.notEqual(first.id, last.id); assert.equal(last.output[0].content[0].text, "Synthetic offline result");
  assert.throws(() => socket.send(payload), /Synthetic request limit/);
  assert.equal(transport.snapshot().sends, 2); assert.equal(transport.snapshot().handoffs, 2); socket.close();
});

test("Guild bootstrap rejects unrelated entrypoints without importing the SDK", () => {
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(resolve("evaluation/src/offline-guild-bootstrap.ts")).href, "-e", 'console.log("must-not-run")'], { env: {}, encoding: "utf8", timeout: 3000 });
  assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.match(result.stderr, /Synthetic Guild bootstrap rejected/);
});

test("synthetic bootstrap refuses a non-Pi entry before importing SDK code", () => {
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(resolve("evaluation/src/offline-bootstrap.ts")).href, "-e", 'console.log("must-not-run")'], { env: {}, encoding: "utf8", timeout: 3000 });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.match(result.stderr, /Synthetic bootstrap rejected/);
});

test("synthetic transport rejects malformed or policy-drifted serialized requests without responding", async () => {
  for (const data of ["{", "x".repeat(1024 * 1024 + 1), JSON.stringify({ type: "response.create", model: "other", reasoning: { effort: "high" } }),
    JSON.stringify({ type: "response.create", model: "gpt-6-astra", reasoning: { effort: "low" } }),
    JSON.stringify({ type: "response.create", model: "gpt-6-astra", reasoning: { effort: "high" }, service_tier: "priority" })]) {
    const transport = syntheticTransport(); const socket = new transport.WebSocket("wss://example.invalid");
    await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
    assert.throws(() => socket.send(data), /Synthetic payload mismatch/);
    assert.equal(transport.snapshot().sends, 0); assert.equal(transport.snapshot().rejected, 1);
    socket.close();
  }
});

test("synthetic transport serves one WebSocket turn, records no headers and refuses HTTP fallback", async () => {
  const transport = syntheticTransport();
  const socket = new transport.WebSocket("wss://example.invalid", { headers: { Authorization: "synthetic-secret" } } as any);
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  const events: any[] = [];
  const done = new Promise<void>(resolve => socket.addEventListener("message", event => {
    const data = JSON.parse((event as MessageEvent).data); events.push(data);
    if (data.type === "response.completed") resolve();
  }));
  socket.send(payload); await done;
  assert.equal(events.at(-1).response.usage.input_tokens, 10);
  assert.equal(events.at(-1).response.service_tier, "default");
  assert.deepEqual(transport.snapshot(), { version: 1, sockets: 1, sends: 1, fetches: 0, rejected: 0 });
  assert.doesNotMatch(JSON.stringify(transport.snapshot()), /synthetic-secret/);
  assert.throws(() => socket.send(payload), /Synthetic request limit/);
  await assert.rejects(transport.fetch("https://example.invalid"), /Synthetic HTTP fallback forbidden/);
  assert.equal(transport.snapshot().rejected, 1); assert.equal(transport.snapshot().fetches, 1);
  socket.close();
});
