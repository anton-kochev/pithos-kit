import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeTrace } from "../src/trace.ts";

const usage = { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, cost: { total: 0.1 }, totalTokens: 15 };
const end = { type: "message_end", message: { role: "assistant", model: "model", provider: "provider", stopReason: "stop", usage, content: [{ type: "text", text: "é" }] } };
const jsonl = (...events: unknown[]) => events.map(e => JSON.stringify(e)).join("\n") + "\n";
const pricing = { version: 1 as const, model: "provider/model", api: "test-api", serviceTier: "base" as const,
  cost: { input: 125000, output: 250000, cacheRead: 62500, cacheWrite: 500000 } };
const pricedEnd = { ...end, message: { ...end.message, api: pricing.api,
  usage: { ...usage, cost: { input: 1.25, output: 0.5, cacheRead: 0.1875, cacheWrite: 0, total: 1.9375 } } } };

test("optional frozen pricing rejects per-message category/API/model/count discrepancies, not just aggregate totals", () => {
  const valid = jsonl(pricedEnd, { type: "agent_end" });
  assert.equal(analyzeTrace(valid, undefined, pricing).complete, true);
  for (const mutate of [
    (m: any) => m.usage.cost.total = 0,
    (m: any) => { m.usage.cost.input += 0.25; m.usage.cost.output -= 0.25; },
    (m: any) => delete m.usage.cost.cacheWrite,
    (m: any) => m.usage.cost.unreviewedFee = 0,
    (m: any) => { m.usage.output = 0; m.usage.totalTokens = 13; m.usage.cost.output = 0; m.usage.cost.total = 1.4375; },
    (m: any) => { m.usage.input = m.usage.cacheRead = 0; m.usage.totalTokens = 2; m.usage.cost.input = m.usage.cost.cacheRead = 0; m.usage.cost.total = 0.5; },
    (m: any) => m.usage.totalTokens++,
    (m: any) => m.api = "other-api", (m: any) => m.model = "other-model",
    (m: any) => { for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) m.usage[key] = 0;
      for (const key of Object.keys(m.usage.cost)) m.usage.cost[key] = 0; },
  ]) {
    const changed = structuredClone(pricedEnd); mutate(changed.message);
    const raw = jsonl(changed, { type: "agent_end" });
    assert.equal(analyzeTrace(raw).complete, true, "legacy parsing is not retroactively repriced");
    const audited = analyzeTrace(raw, undefined, pricing);
    assert.equal(audited.complete, false);
    assert.equal(audited.totalObserved.cost, null);
    assert.ok(audited.issues.includes("pricing_mismatch"));
  }
  const earlier = structuredClone(pricedEnd); earlier.message.stopReason = "toolUse"; earlier.message.usage.cost.total = 0;
  assert.equal(analyzeTrace(jsonl(earlier, pricedEnd, { type: "agent_end" }), undefined, pricing).complete, false);
});

test("counts finalized parent messages once, not streamed or agent_end duplicates", () => {
  const result = analyzeTrace(jsonl({ type: "message_update", usage }, end, { type: "agent_end", messages: [end.message] }));
  assert.equal(result.parent.input, 10);
  assert.equal(result.parent.cost, 0.1);
  assert.equal(result.finalBytes, 2);
  assert.equal(result.complete, true);
  assert.equal(result.models[0], "provider/model");
});

test("does not certify an unfinished assistant attempt after an earlier final turn", () => {
  const raw = jsonl(end, { type: "message_start", message: { role: "assistant" } }, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } }, { type: "agent_end" });
  const result = analyzeTrace(raw);
  assert.equal(result.complete, false);
  assert.equal(result.parent.cost, 0.1);
  assert.equal(result.totalObserved.cost, null);
  assert.ok(result.issues.includes("unfinished_assistant_message"));
});

test("detects duplicate finalized messages and does not silently count them twice", () => {
  const result = analyzeTrace(jsonl(end, end, { type: "agent_end" }));
  assert.equal(result.parent.input, 10);
  assert.equal(result.complete, false);
  assert.ok(result.issues.includes("duplicate_parent_message"));
});

test("does not accept a tool-use turn or aborted turn as a final completion", () => {
  for (const stopReason of ["toolUse", "aborted", "length"]) {
    const result = analyzeTrace(jsonl({ ...end, message: { ...end.message, stopReason } }, { type: "agent_end" }));
    assert.equal(result.complete, false);
    assert.ok(result.issues.includes("missing_terminal_stop"));
  }
});

test("retains child aggregates once and labels unobservable child raw evidence", () => {
  const child = { input: 20, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.2, turns: 2 };
  const start = { type: "tool_execution_start", toolName: "guild_handover", toolCallId: "c1", args: { role: "coder", profile: "typescript" } };
  const finish = { type: "tool_execution_end", toolName: "guild_handover", toolCallId: "c1", isError: false, result: { details: { usage: child }, content: [{ type: "text", text: "done" }] } };
  const result = analyzeTrace(jsonl(start, { type: "tool_execution_update", partialResult: finish.result }, finish, finish, end, { type: "agent_end" }));
  assert.equal(result.childReported.input, 20);
  assert.equal(result.totalReported.input, 30);
  assert.equal(result.handoffBytes, 4);
  assert.equal(result.delegations.length, 1);
  assert.equal(result.complete, false);
  assert.ok(result.issues.includes("child_raw_usage_unavailable"));
  assert.ok(result.issues.includes("duplicate_tool_completion"));
});

const callStart = { type: "tool_execution_start", toolName: "guild_handover", toolCallId: "c1", args: { role: "coder", profile: "typescript" } };
const callEnd = { type: "tool_execution_end", toolName: "guild_handover", toolCallId: "c1", result: { details: { usage: { ...usage, cost: usage.cost.total } }, content: [{ type: "text", text: "done" }] } };
const parentWithChild = jsonl(callStart, callEnd, end, { type: "agent_end" });
const childRecord = (sequence: number, payload: object) => ({ version: 1, childId: "child-1", runId: "c1", role: "coder", profile: "typescript", sequence, ...payload });
const rawChild = jsonl(end, { type: "agent_end", messages: [end.message] });
const observed = (...records: unknown[]) => jsonl({ version: 1, type: "observer_ready" }, ...records, { version: 1, type: "observer_end" });
const childRecords = [childRecord(0, { type: "start" }), childRecord(1, { type: "stdout", base64: Buffer.from(rawChild).toString("base64") }), childRecord(2, { type: "end", exitCode: 0, aborted: false })];

test("prices every raw child turn under the same policy without trusting handover aggregates", () => {
  const parent = jsonl(callStart, callEnd, pricedEnd, { type: "agent_end" });
  for (const wrong of [false, true]) {
    const message = structuredClone(pricedEnd);
    if (wrong) message.message.usage.cost.total = 0;
    const records = observed(childRecords[0], childRecord(1, { type: "stdout", base64: Buffer.from(jsonl(message, { type: "agent_end" })).toString("base64") }), childRecords[2]);
    const audited = analyzeTrace(parent, records, pricing);
    assert.equal(audited.complete, !wrong);
    assert.equal(audited.totalObserved.cost, wrong ? null : 3.875);
    if (wrong) assert.ok(audited.issues.includes("child_pricing_mismatch"));
  }
});

test("uses correlated raw child finalized events, not a second copy of aggregates", () => {
  const result = analyzeTrace(parentWithChild, observed(...childRecords));
  assert.equal(result.complete, true);
  assert.equal(result.childObserved.input, 10);
  assert.equal(result.childObserved.cost, 0.1);
  assert.equal(result.totalObserved.input, 20);
  assert.equal(result.totalObserved.cost, 0.2);
  assert.equal(result.childRuns[0].turns, 1);
});

test("represents a missing child's usage as unknown rather than zero", () => {
  const result = analyzeTrace(parentWithChild, observed());
  assert.equal(result.childObserved.cost, null);
  assert.equal(result.totalObserved.cost, null);
});

test("requires a complete observer lifecycle and a contiguous child stream for every handover", () => {
  const cases: [string, string][] = [
    [observed(), "missing_child_run"],
    [jsonl(...childRecords), "missing_child_observer_ready"],
    [jsonl({ version: 1, type: "observer_ready" }, ...childRecords), "missing_child_observer_end"],
    [observed(...childRecords.slice(0, 2)), "unfinished_child_run"],
    [observed(childRecords[0], childRecord(3, { type: "stdout", base64: Buffer.from(rawChild).toString("base64") }), childRecords[2]), "child_sequence_error"],
    [observed(childRecords[0], childRecords[1], childRecords[1], childRecords[2]), "child_sequence_error"],
    [observed(childRecords[1], childRecords[2]), "missing_child_start"],
    [observed(...childRecords.map(e => ({ ...e, runId: "other" }))), "unmatched_child_run"],
    [observed(...childRecords.map(e => ({ ...e, role: "reviewer" }))), "child_target_mismatch"],
    [observed(...childRecords, { version: 1, type: "observer_ready" }), "malformed_child_observation"],
  ];
  for (const [raw, expected] of cases) {
    const result = analyzeTrace(parentWithChild, raw);
    assert.equal(result.complete, false, expected);
    assert.equal(result.totalObserved.cost, null, expected);
    assert.ok(result.issues.includes(expected), `${expected}: ${result.issues}`);
  }
});

test("retains partial child usage but never certifies failed or corrupted child evidence", () => {
  const corrupt = (base64: unknown) => observed(childRecords[0], childRecord(1, { type: "stdout", base64 }), childRecords[2]);
  const cases: [string, string][] = [
    [observed(childRecords[0], childRecords[1], childRecord(2, { type: "end", exitCode: 1, aborted: false })), "child_process_error"],
    [observed(childRecords[0], childRecords[1], childRecord(2, { type: "end", exitCode: 0, aborted: true })), "child_aborted"],
    [observed(childRecords[0], childRecords[1], childRecord(2, { type: "end", exitCode: null, aborted: false })), "child_process_error"],
    [observed(childRecords[0], childRecords[1], childRecord(2, { type: "end" })), "malformed_child_observation"],
    [corrupt(null), "malformed_child_observation"],
    [corrupt("!"), "malformed_child_observation"],
    [corrupt(Buffer.concat([Buffer.from(rawChild), Buffer.from([0xff])]).toString("base64")), "invalid_child_utf8"],
    [corrupt(Buffer.from(jsonl(end, end, { type: "agent_end" })).toString("base64")), "child_duplicate_parent_message"],
    [corrupt(Buffer.from(jsonl({ ...end, message: { ...end.message, usage: undefined } }, { type: "agent_end" })).toString("base64")), "child_missing_parent_usage"],
  ];
  for (const [raw, expected] of cases) {
    const result = analyzeTrace(parentWithChild, raw);
    assert.equal(result.complete, false, expected);
    assert.equal(result.totalObserved.cost, null, expected);
    assert.ok(result.issues.includes(expected), `${expected}: ${result.issues}`);
  }
  const partial = analyzeTrace(parentWithChild, observed(...childRecords.slice(0, 2)));
  assert.equal(partial.childObserved.cost, 0.1);
});

test("does not invent usage or completion for partial, malformed, error or abandoned runs", () => {
  const result = analyzeTrace('not JSON\n' + jsonl({ type: "tool_execution_start", toolName: "guild_handover", toolCallId: "c1" }, { type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } }));
  assert.equal(result.complete, false);
  assert.equal(result.parent.cost, null);
  for (const issue of ["malformed_json", "missing_parent_usage", "missing_agent_end", "unfinished_handover", "provider_error"]) assert.ok(result.issues.includes(issue), issue);
});
