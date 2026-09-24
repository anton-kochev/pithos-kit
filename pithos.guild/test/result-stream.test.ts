import assert from "node:assert/strict";
import { it } from "node:test";
import { ResultStream } from "../src/result-stream.ts";
import { childTools, SUBMIT_TOOL, LIMITS } from "../src/protocol.ts";
import { buildTask, report } from "./protocol-fixtures.ts";
export function streamFixture() {
 const task = buildTask({role: "coder", profile: "general", task: "Work"});
 const stream = new ResultStream(task);
 const ready = {type: "message_end", message: {role: "custom", customType: "guild-protocol-ready", details: {protocol: task.protocol, version: 2, runId: task.runId, taskId: task.taskId, tools: childTools(task.role)}}};
 const batch = {type: "message_end", message: {role: "assistant", content: [{type: "toolCall", name: SUBMIT_TOOL, id: "call", arguments: report(task)}]}};
 const start = {type: "tool_execution_start", toolName: SUBMIT_TOOL, toolCallId: "call", args: report(task)};
 const end = {type: "tool_execution_end", toolName: SUBMIT_TOOL, toolCallId: "call", isError: false, result: {details: report(task)}};
 return {task, stream, ready, batch, start, end};
}
it("requires finalized successful matching result, handshake, settlement and clean exit", () => {
 const h = streamFixture();
 for (const event of [h.ready, h.batch, h.start]) h.stream.event(event);
 assert.equal(h.stream.finish(0, false).status, "failed");
 const g = streamFixture();
 for (const event of [g.ready, g.batch, g.start, g.end, {type: "message_end", message: {role: "toolResult", toolName: SUBMIT_TOOL, toolCallId: "call", details: report(g.task)}}, {type: "agent_end"}, {type: "agent_settled"}]) g.stream.event(event);
 assert.equal(g.stream.finish(0, false).status, "completed");
});
it("valid result cannot mask errors, nonzero exit, cancellation or duplicate", () => {
 for (const failure of ["error", "duplicate", "exit", "cancel", "mixed", "late"]) {
  const h = streamFixture();
  for (const event of [h.ready, h.batch, h.start, h.end]) h.stream.event(event);
  if (failure === "error") h.stream.event({type: "message_end", message: {role: "assistant", stopReason: "error", errorMessage: "Provider failed", content: []}});
  if (failure === "duplicate") h.stream.event(h.end);
  if (failure === "mixed") h.stream.event({type: "tool_execution_start", toolName: "read", toolCallId: "sibling"});
  h.stream.event({type: "agent_settled"});
  if (failure === "late") h.stream.event(h.batch);
  assert.equal(h.stream.finish(failure === "exit" ? 2 : 0, failure === "cancel").status, failure === "cancel" ? "cancelled" : "failed", failure);
 }
});
it("bounds and decodes fragmented UTF-8 JSON and fails closed on malformed/oversized streams", () => {
 const h = streamFixture();
 const bytes = Buffer.from(JSON.stringify(h.ready) + "\n" + JSON.stringify({type: "message_end", message: {role: "assistant", content: [{type: "text", text: "🙂"}]}}) + "\n");
 const events: any[] = [];
 for (const byte of bytes) h.stream.push(Buffer.from([byte]), e => events.push(e));
 assert.equal(events[1].message.content[0].text, "🙂");
 h.stream.push(Buffer.from("x".repeat(LIMITS.line + 1)), () => {});
 assert.match(h.stream.failure ?? "", /limit/);
 const g = streamFixture();
 g.stream.push(Buffer.from("not JSON\n"), () => {});
 assert.match(g.stream.failure ?? "", /JSON/);
});

it("rejects reusing a failed submission call identity for the repaired submission", () => {
 const h = streamFixture();
 for (const event of [h.ready, h.batch, h.start, {...h.end, isError: true}]) h.stream.event(event);
 for (const event of [h.batch, h.start, h.end, {type: "agent_settled"}]) h.stream.event(event);
 assert.equal(h.stream.finish(0, false).status, "failed");
});
it("does not ignore late finalized sibling tool events after submission", () => {
 const h = streamFixture();
 for (const event of [h.ready, h.batch, h.start, h.end, {type: "tool_execution_end", toolName: "read", toolCallId: "late", isError: false, result: {}}, {type: "agent_settled"}]) h.stream.event(event);
 assert.equal(h.stream.finish(0, false).status, "failed");
});
it("rejects wrong version already present in assistant submission even if execution args differ", () => {
 const h = streamFixture();
 h.stream.event(h.ready);
 h.stream.event({...h.batch, message: {...h.batch.message, content: [{type: "toolCall", name: SUBMIT_TOOL, id: "call", arguments: {...report(h.task), version: 1}}]}});
 assert.match(h.stream.failure ?? "", /identity/);
});
it("never repairs a present wrong protocol or version in submission arguments", () => {
 for (const patch of [{protocol: "guild/1"}, {version: 1}, {version: "2"}]) {
  const h = streamFixture();
  for (const event of [h.ready, h.batch, {...h.start, args: {...report(h.task), ...patch}}]) h.stream.event(event);
  assert.match(h.stream.failure ?? "", /identity/);
 }
});
