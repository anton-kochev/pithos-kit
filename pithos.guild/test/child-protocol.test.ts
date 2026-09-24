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
 const batch = (calls: Array<{type: string; name: string; id: string; arguments?: unknown}> = [{type: "toolCall", name: SUBMIT_TOOL, id: "call"}]) => emit("message_end", {message: {role: "assistant", content: calls}});
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

import childProtocol from "../src/child-protocol.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
it("loads only exact v2 bounded host files before registering child hooks", () => {
 const directory = mkdtempSync(join(tmpdir(), "guild-envelope-"));
 const file = join(directory, "task.json");
 const previous = process.env.GUILD_TASK_FILE;
 process.env.GUILD_TASK_FILE = file;
 let registrations = 0;
 const pi = {on: () => registrations++, registerTool: () => registrations++};
 const task = buildTask({role: "coder", profile: "general", task: "Work"});
 try {
  writeFileSync(file, JSON.stringify(task));
  assert.doesNotThrow(() => childProtocol(pi as any));
  assert.ok(registrations > 0);
  for (const content of ["x".repeat(48 * 1024 + 1), Buffer.from([0xc3, 0x28]), JSON.stringify({...task, extra: true}), JSON.stringify({...task, version: 1}), JSON.stringify({...task, practices: null})]) {
   registrations = 0;
   writeFileSync(file, content);
   if (typeof content === "string" && content[0] === "x") assert.throws(() => childProtocol(pi as any), /byte limit/);
   else assert.throws(() => childProtocol(pi as any));
   assert.equal(registrations, 0);
  }
 } finally {
  if (previous === undefined) delete process.env.GUILD_TASK_FILE; else process.env.GUILD_TASK_FILE = previous;
  rmSync(directory, {recursive: true, force: true});
 }
});
it("rejects wrong version already present in assistant submission even if execution args differ", () => {
 const h = harness();
 h.batch([{type: "toolCall", name: SUBMIT_TOOL, id: "call", arguments: {...report(h.task), version: 1}}]);
 assert.ok(h.aborted > 0);
});
it("treats present wrong protocol or version as fatal before schema repair", () => {
 for (const patch of [{protocol: "guild/1"}, {version: 1}, {version: "2"}]) {
  const h = harness();
  h.batch();
  h.emit("tool_execution_start", {toolName: SUBMIT_TOOL, toolCallId: "call", args: {...report(h.task), ...patch}});
  assert.ok(h.aborted > 0);
  assert.equal(h.emit("agent_before_settle", {outcome: "completed", entries: []}), undefined);
 }
});
it("instructs the child to report required TDD as claims without waivers", () => {
 const h = harness();
 const prompt = h.emit("before_agent_start", {systemPrompt: "base"}).systemPrompt;
 for (const field of ["taskOutcome", "compliance", "cycles", "limitations", "blocked", "same exact command", "preimplementation", "not host-certified", "Host role/tools/protocol"]) assert.ok(prompt.includes(field), field);
 assert.deepEqual({minimum: h.tool.parameters.properties.version.minimum, maximum: h.tool.parameters.properties.version.maximum}, {minimum: 2, maximum: 2});
 assert.doesNotMatch(JSON.stringify(h.tool.parameters), /"(?:anyOf|oneOf|const)"\s*:/);
 assert.ok(h.tool.parameters.required.includes("compliance"));
 assert.ok(h.tool.parameters.required.includes("taskOutcome"));
});
