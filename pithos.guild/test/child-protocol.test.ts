import assert from "node:assert/strict";
import { it } from "node:test";
import { registerChildProtocol } from "../src/child-protocol.ts";
import { childTools, SUBMIT_TOOL } from "../src/protocol.ts";
import { buildTask, report } from "./protocol-fixtures.ts";

function harness(tools?: string[]) {
 const task = buildTask({role: "coder", profile: "general", task: "Work"});
 const handlers = new Map<string, Function>();
 let tool: any;
 let aborted = 0;
 const ctx = {mode: "json", abort: () => { aborted++; }, signal: new AbortController().signal};
 const pi = {on: (name: string, handler: Function) => handlers.set(name, handler), registerTool: (value: any) => {tool = value;}, getActiveTools: () => tools ?? childTools(task.role)};
 registerChildProtocol(pi as any, task);
 const emit = (type: string, data: any = {}) => handlers.get(type)?.({type, ...data}, ctx);
 const batch = (calls = [{type: "toolCall", name: SUBMIT_TOOL, id: "call"}]) => emit("message_end", {message: {role: "assistant", content: calls}});
 return {task, emit, batch, ctx, get tool() {return tool;}, get aborted() {return aborted;}};
}
it("accepts a sole matching result and refuses duplicate or post-submission work", async () => {
 const h = harness();
 h.emit("session_start");
 assert.equal(h.emit("before_agent_start", {systemPrompt: "base"}).message.details.protocol, "guild/2");
 h.batch();
 const result = await h.tool.execute("call", report(h.task), undefined, undefined, h.ctx);
 assert.equal(result.terminate, true);
 assert.deepEqual(result.details, report(h.task));
 h.batch([{type: "toolCall", name: "read", id: "late"}]);
 assert.ok(h.aborted > 0);
 assert.equal(h.emit("tool_call", {toolName: "read"}).block, true);
});
it("shares one repair across schema failure and missing completion, without resetting at agent_start", () => {
 const h = harness();
 h.batch();
 h.emit("tool_execution_end", {toolName: SUBMIT_TOOL, toolCallId: "call", isError: true});
 h.emit("agent_start");
 assert.equal(h.emit("agent_before_settle", {outcome: "completed", entries: []}), undefined);
 assert.ok(h.aborted > 0);
});
it("repairs prose once with a context entry and rejects mixed submission batches", () => {
 const h = harness();
 const repair = h.emit("agent_before_settle", {outcome: "completed", entries: []});
 assert.equal(repair.continue, true);
 assert.equal(repair.entries[0].type, "custom_message");
 h.batch([{type: "toolCall", name: SUBMIT_TOOL, id: "call"}, {type: "toolCall", name: "read", id: "read"}]);
 assert.ok(h.aborted > 0);
});
it("limits repair to the next assistant response, not unlimited intervening work", () => {
 const h = harness();
 h.batch();
 h.emit("tool_execution_end", {toolName: SUBMIT_TOOL, toolCallId: "call", isError: true});
 h.batch([{type: "toolCall", name: "read", id: "repair-work"}]);
 assert.ok(h.aborted > 0);
 assert.equal(h.emit("tool_call", {toolName: "read"}).block, true);
});
it("handles input without starting work when startup effective tools are wrong", () => {
 for (const tools of [["read"], ["read", "guild_submit_result", "guild_handover"]]) {
  const h = harness(tools);
  h.emit("session_start");
  assert.equal(h.emit("input").action, "handled");
  assert.ok(h.aborted > 0);
 }
});
it("rejects raw type mismatches before Pi can coerce submission arguments", () => {
 const h = harness();
 assert.equal(typeof h.tool.prepareArguments, "function");
 assert.throws(() => h.tool.prepareArguments({...report(h.task), summary: 42}), /schema/);
 assert.deepEqual(h.tool.prepareArguments(report(h.task)), report(h.task));
});
