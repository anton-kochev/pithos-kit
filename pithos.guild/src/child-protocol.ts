// Explicit child entry only. Never add this file to normal extension discovery.
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildTask, childTools, PROTOCOL, resultSchema, SUBMIT_TOOL, validateResult, type GuildTask } from "./protocol.ts";

export function registerChildProtocol(pi: ExtensionAPI, task: GuildTask): void {
 let accepted = false;
 let repairUsed = false;
 let violation: string | undefined;
 let soleCall: string | undefined;
 const invalidCalls = new Set<string>();
 const fail = (reason: string, ctx: ExtensionContext) => {
  violation ??= reason;
  // abort is supported in print/JSON mode; shutdown is not. Do not await from a hook.
  ctx.abort();
 };
 pi.on("session_start", (_event, ctx) => {
  const actual = pi.getActiveTools().slice().sort();
  if (ctx.mode !== "json" || JSON.stringify(actual) !== JSON.stringify(childTools(task.role).sort())) fail("Guild child tools unavailable", ctx);
 });
 pi.on("input", () => violation ? {action: "handled"} : undefined);
 pi.on("before_agent_start", (event, ctx) => {
  if (violation) { fail(violation, ctx); throw new Error(violation); }
  return {
   systemPrompt: `${event.systemPrompt}\n\nComplete only by calling ${SUBMIT_TOOL} as the sole tool call in its batch. Report honest limitations and unperformed checks. Never submit twice. Result strings are limited to 2048 UTF-8 bytes, lists to 32 items, total result to 48 KiB.\nHost task envelope: ${JSON.stringify(task)}`,
   message: {customType: "guild-protocol-ready", content: "Guild exact-completion protocol active.", display: false,
    details: {protocol: PROTOCOL, version: 1, runId: task.runId, taskId: task.taskId, tools: childTools(task.role)}},
  };
 });
 pi.on("message_end", (event, ctx) => {
  if (event.message.role !== "assistant") return;
  const calls = event.message.content.filter(part => part.type === "toolCall");
  soleCall = calls.length === 1 && calls[0].name === SUBMIT_TOOL ? calls[0].id : undefined;
  if ((repairUsed && !soleCall) || accepted || (calls.some(call => call.name === SUBMIT_TOOL) && !soleCall)) fail("Duplicate, mixed, or post-submission work", ctx);
 });
 pi.on("tool_call", (_event, ctx) => {
  if (violation || accepted || ctx.signal?.aborted) {
   fail(violation ?? "Post-submission tool call", ctx);
   return {block: true, reason: violation, terminate: true};
  }
 });
 pi.registerTool({
  name: SUBMIT_TOOL, label: "Submit Guild result",
  description: "Submit the final role report once, as the sole tool call in this batch. Claims are not host-verified.",
  parameters: resultSchema(task),
  // Pi may coerce schema values; our protocol rejects malformed raw arguments.
  prepareArguments: args => validateResult(args, task),
  async execute(id, params, signal, _update, ctx) {
   if (violation || accepted || signal?.aborted || id !== soleCall) {
    fail(violation ?? "Invalid submission batch or duplicate", ctx);
    throw new Error(violation);
   }
   // Identity mismatch is not a repairable formatting error.
   if (params.runId !== task.runId || params.taskId !== task.taskId || params.role !== task.role || params.profile !== task.profile) {
    fail("Guild result identity mismatch", ctx);
    throw new Error(violation);
   }
   const report = validateResult(params, task);
   accepted = true;
   return {content: [{type: "text", text: "Guild result recorded."}], details: report, terminate: true};
  },
 });
 // This event also sees Pi schema failures, which bypass tool_call and execute.
 pi.on("tool_execution_start", (event, ctx) => {
  if (violation || accepted) { fail(violation ?? "Post-submission execution", ctx); return; }
  if (event.toolName !== SUBMIT_TOOL) return;
  if (event.toolCallId !== soleCall) { fail("Submission must be sole batch call", ctx); return; }
  const args = event.args;
  if (args && typeof args === "object" && ["runId", "taskId", "role", "profile"].some(key => key in args && args[key] !== task[key as keyof GuildTask])) fail("Guild result identity mismatch", ctx);
 });
 pi.on("tool_execution_end", (event, ctx) => {
  if (event.toolName !== SUBMIT_TOOL || !event.isError || violation || invalidCalls.has(event.toolCallId)) return;
  invalidCalls.add(event.toolCallId);
  if (accepted || repairUsed) { fail("Guild repair budget exhausted", ctx); return; }
  repairUsed = true; // The tool error itself supplies the one corrective opportunity.
 });
 pi.on("agent_before_settle", (event, ctx) => {
  if (event.outcome !== "completed" || ctx.signal?.aborted || accepted || violation) return;
  if (repairUsed) { fail("Guild completion missing after repair", ctx); return; }
  repairUsed = true;
  return {entries: [...event.entries, {type: "custom_message", customType: "guild-result-repair", display: false,
   content: `No valid result was submitted. This is the only repair opportunity. Call ${SUBMIT_TOOL} now as the sole tool call, matching the host envelope and schema. State limitations honestly.`}], continue: true};
 });
}

export default function childProtocol(pi: ExtensionAPI): void {
 const file = process.env.GUILD_TASK_FILE;
 if (!file) throw new Error("Missing host Guild task file");
 const task = JSON.parse(readFileSync(file, "utf8")) as GuildTask;
 // Validate the host envelope without deriving scope from its text.
 buildTask(task);
 if (task.protocol !== PROTOCOL || task.version !== 1 || typeof task.taskId !== "string" || !task.taskId || task.taskId.length > 128) throw new Error("Invalid host Guild envelope");
 registerChildProtocol(pi, task);
}
