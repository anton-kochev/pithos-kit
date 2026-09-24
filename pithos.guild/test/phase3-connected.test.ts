import assert from "node:assert/strict";
import { it } from "node:test";
import { registerChildProtocol } from "../src/child-protocol.ts";
import { childTools, SUBMIT_TOOL } from "../src/protocol.ts";
import { ResultStream } from "../src/result-stream.ts";
import { buildTask, report } from "./protocol-fixtures.ts";

function connected() {
 const task = buildTask({role: "coder", profile: "general", task: "Work", practices: [{id: "tdd", policy: "required"}]});
 const stream = new ResultStream(task);
 const handlers = new Map<string, Function>();
 let tool: any;
 let aborted = false;
 const ctx = {mode: "json", abort: () => {aborted = true;}, signal: new AbortController().signal};
 registerChildProtocol({on: (name: string, fn: Function) => handlers.set(name, fn), registerTool: (t: any) => {tool = t;}, getActiveTools: () => childTools(task.role)} as any, task);
 const emit = (type: string, data: any = {}) => {
  const event = {type, ...data};
  const result = handlers.get(type)?.(event, ctx);
  stream.event(event);
  return result;
 };
 handlers.get("session_start")?.({}, ctx);
 const ready = handlers.get("before_agent_start")?.({systemPrompt: "base"}, ctx).message;
 stream.event({type: "message_end", message: {role: "custom", ...ready}});
 const blocked = {...report(task), taskOutcome: "blocked", blockers: ["Tests unavailable"], compliance: [{id: "tdd", policy: "required", status: "blocked", reason: "Cannot execute tests", cycles: [], limitations: ["No executed red"]}]};
 const submit = async (id: string, args: unknown) => {
  emit("message_end", {message: {role: "assistant", content: [{type: "toolCall", name: SUBMIT_TOOL, id, arguments: args}]}});
  emit("tool_execution_start", {toolName: SUBMIT_TOOL, toolCallId: id, args});
  let result: any;
  let isError = false;
  try { const prepared = tool.prepareArguments(args); result = await tool.execute(id, prepared, undefined, undefined, ctx); }
  catch (error) { result = {content: [{type: "text", text: String(error)}]}; isError = true; }
  emit("tool_execution_end", {toolName: SUBMIT_TOOL, toolCallId: id, result, isError});
  return isError;
 };
 return {task, blocked, stream, emit, submit, get aborted() {return aborted;}};
}
it("connects one malformed-compliance repair to a retained blocked non-error completion", async () => {
 const h = connected();
 assert.equal(await h.submit("bad", {...h.blocked, compliance: []}), true);
 assert.equal(h.aborted, false);
 h.emit("agent_start");
 assert.equal(await h.submit("repair", h.blocked), false);
 h.emit("agent_settled");
 assert.deepEqual(h.stream.finish(0, false), {status: "completed", report: h.blocked});
});
it("does not replenish compliance repair after prose correction or agent continuation", async () => {
 const h = connected();
 const repair = h.emit("agent_before_settle", {outcome: "completed", entries: []});
 h.emit("entry_appended", {entry: repair.entries[0]});
 h.emit("agent_start");
 assert.equal(await h.submit("bad", {...h.blocked, compliance: []}), true);
 assert.equal(h.aborted, true);
 assert.equal(h.stream.finish(0, false).status, "failed");
});
it("preserves cancellation/process/transport precedence over connected blocked reports", async () => {
 for (const failure of ["cancel", "exit", "transport"]) {
  const h = connected();
  assert.equal(await h.submit("valid", h.blocked), false);
  if (failure === "transport") h.stream.push(Buffer.from("invalid\n"), () => {});
  h.emit("agent_settled");
  assert.equal(h.stream.finish(failure === "exit" ? 1 : 0, failure === "cancel").status, failure === "cancel" ? "cancelled" : "failed");
 }
});
