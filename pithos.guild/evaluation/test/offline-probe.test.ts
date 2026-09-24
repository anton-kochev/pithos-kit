import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureScopedAuth } from "../src/scoped-auth-identity.ts";
import { validateSyntheticRun, runSyntheticProbe, syntheticProbeInvocation, syntheticProbeAuth } from "../src/offline-probe.ts";
import { calculateBaseCost } from "../src/pricing.ts";
test("future restricted probes construct a strictly scoped synthetic credential without runtime access", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "guild-probe-auth-test-"));
  try {
    const { auth, access } = syntheticProbeAuth(), file = join(root, "auth.json");
    await writeFile(file, auth, { mode: 0o600 });
    const identity = captureScopedAuth(file, 300000), stored = JSON.parse(auth)["openai-codex"];
    assert.equal(stored.access, access); assert.equal(stored.accountId, "synthetic-account");
    assert.equal(identity.expires, stored.expires);
    assert.equal(JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString()).exp * 1000, stored.expires);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const pricing = { version: 1 as const, model: "openai-codex/gpt-6-astra", api: "openai-codex-responses", serviceTier: "base" as const, cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } };
function evidence() {
  const requestId = "11111111-1111-1111-1111-111111111111", attemptId = "22222222-2222-2222-2222-222222222222";
  const usage = { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 13 };
  const message = { role: "assistant", provider: "openai-codex", model: "gpt-6-astra", api: pricing.api, responseId: "resp-synthetic-main", stopReason: "stop", content: [{ type: "text", text: "Synthetic offline result" }], usage: { ...usage, cost: calculateBaseCost(pricing, usage) } };
  const context = { type: "context", model: pricing.model, thinking: "high", target: null, systemPromptDigest: "a".repeat(64), tools: ["bash", "edit", "find", "grep", "ls", "read", "write"] };
  const events: any[] = [{ type: "process_start", piVersion: "0.85.1", node: "v24.20.0" }, context,
    { type: "request_start", requestId }, context, context,
    { type: "payload", requestId, final: { model: "gpt-6-astra", thinking: "high", serviceTier: "omitted" } },
    ...[{ type: "start" }, { type: "response", meter: { responseId: message.responseId, status: "completed", serviceTier: "default", input: 10, output: 3, total: 13, cacheRead: 2, cacheWrite: 1 } }, { type: "end", reason: "terminal" }].map(record => ({ type: "transport", requestId, record: { ...record, attemptId, transport: "websocket" } })),
    { type: "request_end", requestId, complete: true }, { type: "process_end", exitCode: 0 }];
  return { pid: 11, parentPid: 10, status: 0, signal: null, limited: false, timedOut: false, captureFailed: false, stats: { version: 1, sockets: 1, sends: 1, fetches: 0, rejected: 0 },
    stdout: [{ type: "message_end", message }, { type: "agent_settled" }], native: events.map((e, sequence) => ({ version: 1, pid: 11, ppid: 10, actor: "parent", sequence, ...e })) };
}
test("Guild probe invocation loads only the copied Guild extension and bounded synthetic bootstrap", () => {
  const guild = syntheticProbeInvocation("/evidence/synthetic-guild");
  assert.equal(guild.arm, "guild-available"); assert.equal(guild.guildRoot, "/harness/guild");
  assert.equal(guild.bootstrap, "/harness/offline-guild-bootstrap.ts");
  assert.ok(guild.args.includes("/harness/guild/extensions/index.ts"));
  assert.equal(guild.args[guild.args.indexOf("--tools") + 1], "read,write,edit,bash,grep,find,ls,guild_handover");
  const main = syntheticProbeInvocation("/evidence/synthetic");
  assert.equal(main.arm, "main-only"); assert.ok(!main.args.includes("-e"));
  assert.throws(() => syntheticProbeInvocation("/arbitrary"), /Synthetic probe admission failed/);
});

test("probe refuses arbitrary output locations before any runtime launch", async () => {
  await assert.rejects(runSyntheticProbe("/not-the-isolated-output"), /Synthetic probe admission failed/);
});

test("synthetic CLI acceptance requires matched raw request/response/process evidence, not exit zero", () => {
  assert.doesNotThrow(() => validateSyntheticRun(evidence(), pricing));
  for (const mutate of [
    (e: any) => e.status = 1, (e: any) => e.timedOut = true, (e: any) => e.stats.fetches = 1,
    (e: any) => e.stdout = [], (e: any) => e.native.pop(), (e: any) => e.native[0].pid = 99,
    (e: any) => e.native.find((r: any) => r.type === "request_end").complete = false,
    (e: any) => e.native.find((r: any) => r.type === "transport" && r.record.type === "response").record.meter.cacheWrite = null,
    (e: any) => e.stdout.push({ type: "tool_execution_start" }),
    (e: any) => e.stdout[0].message.content[0].type = "thinking",
    (e: any) => { for (const r of e.native.filter((r: any) => r.type === "transport")) { r.record.transport = "sse"; if (r.record.type === "end") r.record.reason = "eof"; } },
  ]) { const input = evidence(); mutate(input); assert.throws(() => validateSyntheticRun(input, pricing), /Synthetic CLI evidence mismatch/); }
});
