import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { calculateBaseCost } from "../src/pricing.ts";
import { validateSyntheticGuild } from "../src/offline-guild-evidence.ts";
const pricing = { version: 1 as const, model: "openai-codex/gpt-6-astra", api: "openai-codex-responses", serviceTier: "base" as const, cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } };
const tools = ["bash", "edit", "find", "grep", "ls", "read", "write"];
const task = "Synthetic offline transport fixture. No repository mutation is requested.";
function fixture() {
  const counts = { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 13 };
  const usage = { ...counts, cost: calculateBaseCost(pricing, counts) };
  const calls = ["explorer", "coder"].map(role => ({ type: "toolCall", id: `call-synthetic-${role}|fc-synthetic-${role}`, name: "guild_handover", arguments: { role, profile: "typescript", task } }));
  const message = (id: string, content: any[] = [{ type: "text", text: "Synthetic offline result" }]) => ({ role: "assistant", provider: "openai-codex", model: "gpt-6-astra", api: pricing.api, responseId: id, stopReason: content === calls ? "toolUse" : "stop", content, usage: structuredClone(usage) });
  const parentMessages = [message("resp-parent-1", calls), message("resp-parent-2")];
  const childMessages = [message("resp-child-33"), message("resp-child-34")];
  const childIds = [randomUUID(), randomUUID()];
  const spawn = childIds.map((childId, i) => ({ type: "child_spawn", childId, childPid: 33 + i }));
  function native(pid: number, target: string | null, messages: any[]) {
    const actor = target ? "child" : "parent";
    const context = { type: "context", model: pricing.model, thinking: "high", target, tools: target === "explorer/typescript" ? ["find", "grep", "ls", "read"] : target ? tools : [...tools, "guild_handover"].sort(), systemPromptDigest: "a".repeat(64) };
    const records: any[] = [{ type: "process_start", node: "v24.20.0", piVersion: "0.85.1" }, context];
    messages.forEach((m, index) => {
      if (!target && index === 1) records.push(...spawn);
      const requestId = randomUUID(), attemptId = randomUUID();
      records.push({ type: "request_start", requestId }, context, context,
        { type: "payload", requestId, final: { model: "gpt-6-astra", thinking: "high", serviceTier: "omitted" } },
        ...[{ type: "start" }, { type: "response", meter: { responseId: m.responseId, status: "completed", serviceTier: "default", input: 10, output: 3, total: 13, cacheRead: 2, cacheWrite: 1 } }, { type: "end", reason: "terminal" }].map(r => ({ type: "transport", requestId, record: { ...r, transport: "websocket", attemptId } })),
        { type: "request_end", requestId, complete: true });
    });
    records.push({ type: "process_end", exitCode: 0 });
    return records.map((r, sequence) => ({ version: 1, pid, ppid: target ? 25 : 7, actor, sequence, ...r }));
  }
  const parent: any[] = [{ type: "message_end", message: parentMessages[0] }];
  const observations: any[] = [{ version: 1, type: "observer_ready" }];
  calls.forEach((call, i) => {
    const childStdout = [{ type: "message_end", message: childMessages[i] }, { type: "agent_end" }, { type: "agent_settled" }];
    const identity = { version: 1, childId: childIds[i], runId: call.id, role: call.arguments.role, profile: "typescript" };
    observations.push({ ...identity, sequence: 0, type: "start" }, { ...identity, sequence: 1, type: "stdout", base64: Buffer.from(childStdout.map(r => JSON.stringify(r)).join("\n") + "\n").toString("base64") }, { ...identity, sequence: 2, type: "end", exitCode: 0, aborted: false });
    parent.push({ type: "tool_execution_start", toolName: call.name, toolCallId: call.id, args: call.arguments },
      { type: "tool_execution_end", toolName: call.name, toolCallId: call.id, isError: false, result: { content: [{ type: "text", text: "Synthetic offline result" }], details: { usage: { ...counts, cost: usage.cost.total, turns: 1, contextTokens: 13 } } } });
  });
  parent.push({ type: "message_end", message: parentMessages[1] }, { type: "agent_end" }, { type: "agent_settled" });
  observations.push({ version: 1, type: "observer_end" });
  return { outcome: { pid: 25, status: 0, signal: null, timedOut: false, limited: false, captureFailed: false }, parentPid: 7, isolation: { namespace: "net:[123]", uid: 501 }, parent,
    children: observations.map(r => JSON.stringify(r)).join("\n"), native: [native(25, null, parentMessages), native(33, "explorer/typescript", [childMessages[0]]), native(34, "coder/typescript", [childMessages[1]])],
    transports: [25, 33, 34].map(pid => ({ version: 1, pid, ppid: pid === 25 ? 7 : 25, namespace: "net:[123]", uid: 501, actor: pid === 25 ? "parent" : "child", stats: { version: 1, sockets: 1, sends: pid === 25 ? 2 : 1, fetches: 0, rejected: 0, ...(pid === 25 ? { handoffs: 2 } : {}) } })) };
}

test("Guild acceptance reconciles each handover's usage rather than just matching the grand total", () => {
  const e = fixture(), ends = e.parent.filter(r => r.type === "tool_execution_end");
  ends[1].result.details.usage.cost += ends[0].result.details.usage.cost; ends[0].result.details.usage.cost = 0;
  assert.throws(() => validateSyntheticGuild(e, pricing), /Synthetic Guild evidence mismatch/);
});

test("Guild acceptance rejects overlapping child lifetimes despite individually complete traces", () => {
  const e = fixture(), rows = e.children.split("\n").map(line => JSON.parse(line));
  const second = rows.findIndex(r => r.type === "start" && r.role === "coder");
  const [start] = rows.splice(second, 1); rows.splice(2, 0, start);
  e.children = rows.map(r => JSON.stringify(r)).join("\n");
  assert.throws(() => validateSyntheticGuild(e, pricing), /Synthetic Guild evidence mismatch/);
});

test("Guild acceptance rejects unexecuted tool calls, contradictory totals and child tool activity", () => {
  for (const mutate of [
    (e: any) => e.parent[0].message.content[0].id = "unexecuted-call",
    (e: any) => e.parent.find((r: any) => r.type === "tool_execution_end").result.details.usage.cost = 0,
    (e: any) => e.parent.find((r: any) => r.type === "tool_execution_end").result.content[0].text = "invented report",
    (e: any) => { const rows = e.children.split("\n").map((line: string) => JSON.parse(line)); const r = rows.find((r: any) => r.type === "stdout"); r.base64 = Buffer.from(Buffer.from(r.base64, "base64").toString() + JSON.stringify({ type: "tool_execution_start", toolName: "bash" }) + "\n").toString("base64"); e.children = rows.map((r: any) => JSON.stringify(r)).join("\n"); },
  ]) { const e = fixture(); mutate(e); assert.throws(() => validateSyntheticGuild(e, pricing), /Synthetic Guild evidence mismatch/); }
});

test("Guild acceptance rejects missing, failed or unmatched native producers", () => {
  for (const mutate of [
    (e: any) => e.native.pop(), (e: any) => e.native.push(e.native[1]),
    (e: any) => e.native[1][0].ppid = 7,
    (e: any) => e.native[1].find((r: any) => r.type === "context").target = "coder/typescript",
    (e: any) => e.native[0].find((r: any) => r.type === "child_spawn").childPid = 999,
    (e: any) => e.native[2].find((r: any) => r.type === "request_end").complete = false,
    (e: any) => e.native[2].find((r: any) => r.type === "transport" && r.record.type === "response").record.meter.cacheWrite = null,
    (e: any) => e.transports[2].namespace = "net:[999]",
    (e: any) => e.transports[0].stats.fetches = 1,
    (e: any) => delete e.transports[0].stats.handoffs,
    (e: any) => e.outcome.timedOut = true,
  ]) { const e = fixture(); mutate(e); assert.throws(() => validateSyntheticGuild(e, pricing), /Synthetic Guild evidence mismatch/); }
});

test("Guild acceptance binds two actual child producers to their handovers and all four requests", () => {
  const result = validateSyntheticGuild(fixture(), pricing);
  assert.equal(result.requests, 4); assert.equal(result.processes, 3);
  assert.deepEqual(result.targets, ["explorer/typescript", "coder/typescript"]);
});
