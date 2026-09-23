import assert from "node:assert/strict";
import { it } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { registerChildProtocol } from "../src/child-protocol.ts";
import { ResultStream } from "../src/result-stream.ts";
import { childTools, SUBMIT_TOOL } from "../src/protocol.ts";
import { buildTask, report } from "./protocol-fixtures.ts";

// Provider-free seam follows Pi 0.87.0 source ordering: finalized assistant,
// execution_start, schema validation, tool_call/execute, execution_end, toolResult.
async function connected(scenario: "valid" | "invalid-repair" | "missing-repair" | "exhausted" | "identity" | "mixed" | "cancel") {
 const task = buildTask({role: "coder", profile: "typescript", task: "Work"});
 const stream = new ResultStream(task);
 const hooks = new Map<string, Function>();
 let tool: any;
 let aborted = false;
 const controller = new AbortController();
 const ctx = {mode: "json", signal: controller.signal, abort() {aborted = true; controller.abort();}};
 registerChildProtocol({on: (name: string, hook: Function) => hooks.set(name, hook), registerTool: (t: any) => {tool = t;}, getActiveTools: () => childTools(task.role)} as any, task);
 const emit = async (event: any) => {
  const proposal = await hooks.get(event.type)?.(event, ctx);
  stream.event(event);
  return proposal;
 };
 await hooks.get("session_start")!({}, ctx);
 const ready = await hooks.get("before_agent_start")!({systemPrompt: "base"}, ctx);
 await emit({type: "agent_start"});
 await emit({type: "message_end", message: {role: "custom", ...ready.message}});
 const submit = async (id: string, params: any, mixed = false) => {
  const call = {type: "toolCall" as const, id, name: SUBMIT_TOOL, arguments: params};
  await emit({type: "message_end", message: {role: "assistant", content: [call, ...(mixed ? [{type: "toolCall", id: "other", name: "read", arguments: {path: "x"}}] : [])]}});
  await emit({type: "tool_execution_start", toolCallId: id, toolName: SUBMIT_TOOL, args: params});
  let result: any, isError = false;
  try {
   const prepared = tool.prepareArguments(params);
   params = validateToolArguments(tool, {...call, arguments: prepared});
   const blocked = await hooks.get("tool_call")!({toolName: SUBMIT_TOOL, toolCallId: id, input: params}, ctx);
   if (blocked?.block || controller.signal.aborted) throw new Error("Blocked");
   result = await tool.execute(id, params, controller.signal, undefined, ctx);
  } catch {isError = true; result = {content: [{type: "text", text: "Correct the schema"}]};}
  await emit({type: "tool_execution_end", toolName: SUBMIT_TOOL, toolCallId: id, isError, result});
  await emit({type: "message_end", message: {role: "toolResult", toolName: SUBMIT_TOOL, toolCallId: id, isError, ...result}});
 };
 if (scenario === "missing-repair") {
  await emit({type: "message_end", message: {role: "assistant", content: [{type: "text", text: "Prose only"}]}});
  await emit({type: "agent_end"});
  const proposal = await hooks.get("agent_before_settle")!({outcome: "completed", entries: []}, ctx);
  assert.equal(proposal.continue, true);
  for (const entry of proposal.entries) stream.event({type: "entry_appended", entry});
  await emit({type: "agent_start"});
 }
 if (scenario === "invalid-repair" || scenario === "exhausted") {
  await submit("bad", {});
  await emit({type: "agent_start"}); // Must not reset the budget.
 }
 await submit("final", scenario === "exhausted" ? {} : {...report(task), ...(scenario === "identity" ? {taskId: "other"} : {})}, scenario === "mixed");
 await hooks.get("agent_before_settle")!({outcome: aborted ? "aborted" : "completed", entries: []}, ctx);
 await emit({type: "agent_end"});
 await emit({type: "agent_settled"});
 return stream.finish(0, scenario === "cancel");
}
for (const scenario of ["valid", "invalid-repair", "missing-repair", "exhausted", "identity", "mixed", "cancel"] as const) {
 it(`connects child hooks to independent parent result validation: ${scenario}`, async () => {
  const terminal = await connected(scenario);
  const expected = scenario === "cancel" ? "cancelled" : ["valid", "invalid-repair", "missing-repair"].includes(scenario) ? "completed" : "failed";
  assert.equal(terminal.status, expected, terminal.diagnostic);
 });
}
