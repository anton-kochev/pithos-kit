// Explicit child entry only. Never add this file to normal extension discovery.
import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { QuestionExchange, ASK_TOOL, BACKGROUND_CAPABILITY, QUESTION_LIMITS, questionSchema, validateQuestion, validateQuestionText, type QuestionOutcome, backgroundCapability, type BackgroundOptions, validateTask, LIMITS, childTools, hasIdentityMismatch, PROTOCOL, resultSchema, SUBMIT_TOOL, validateResult, type GuildTask } from "./protocol.ts";
import { GIT_READ_TOOL, registerGitReadTool } from "./git-read.ts";

export function registerChildProtocol(pi: ExtensionAPI, task: GuildTask, backgroundOptions?: BackgroundOptions): void {
 const capability = backgroundCapability(backgroundOptions);
 const tools = childTools(task.role, capability);
 if (tools.includes(GIT_READ_TOOL)) registerGitReadTool(pi);
 const questionAbort = new AbortController();
 let questionExecuting = false;
 const questions = capability ? new QuestionExchange() : undefined;
 let accepted = false;
 let repairUsed = false;
 let violation: string | undefined;
 let soleCall: string | undefined;
 const invalidCalls = new Set<string>();
 const fail = (reason: string, ctx: ExtensionContext) => {
  violation ??= reason;
  questionAbort.abort();
  // abort is supported in print/JSON mode; shutdown is not. Do not await from a hook.
  if (!capability || !ctx.signal?.aborted) ctx.abort();
 };
 pi.on("session_start", (_event, ctx) => {
  const actual = pi.getActiveTools().slice().sort();
  if (ctx.mode !== (capability ? "rpc" : "json") || (capability && !ctx.hasUI) || JSON.stringify(actual) !== JSON.stringify(tools.slice().sort())) fail("Guild child tools unavailable", ctx);
 });
 pi.on("input", () => violation ? {action: "handled"} : undefined);
 pi.on("before_agent_start", (event, ctx) => {
  if (violation) { fail(violation, ctx); throw new Error(violation); }
  const clarification = capability ? `\n\nBackground clarification capability: you may ask the parent for missing essential information through ${ASK_TOOL}, alone in its tool batch. This supersedes role and skill prohibitions on asking questions only for this parent channel; delegation remains prohibited. An unavailable answer is not permission to guess: report unresolved essential information as a blocker. All repository tool limits and final-report requirements remain in force.` : "";
  return {
   systemPrompt: `${event.systemPrompt}${clarification}\n\nComplete only by calling ${SUBMIT_TOOL} as the sole tool call in its batch. Report honest limitations and unperformed checks. Never submit twice. Result strings are limited to 2048 UTF-8 bytes, lists to 32 items, total result to 48 KiB.\nReport taskOutcome succeeded only with no blockers and all requested compliance satisfied; otherwise report blocked with at least one nonblank blocker. A completed review requesting changes is not itself blocked. Include compliance: [] when no practices were requested, otherwise exactly one matching record per request. Required TDD has no waiver or not-applicable: unavailable execution or missing meaningful preimplementation red means blocked, with a nonblank reason. Satisfied requires empty reason and 1..8 completed cycles; blocked permits 0..8. Each cycle identifies behavior and test, red expected-failure/nonzero exit and green passed/zero exit using the same exact command, observed diagnostics, and 1..4 nonblank evidence references per observation. Report incomplete attempts in reason/limitations/verification, never as completed cycles. Include explicit limitations. Claims are not host-certified execution; stream order cannot prove test-before-code inside bash. Host role/tools/protocol takes precedence over required practice, which takes precedence over general skill exceptions.\nHost task envelope: ${JSON.stringify(task)}`,
   message: {customType: "guild-protocol-ready", content: "Guild exact-completion protocol active.", display: false,
    details: {protocol: PROTOCOL, version: 2, runId: task.runId, taskId: task.taskId, tools, ...(capability ? {capability} : {})}},
  };
 });
 pi.on("message_end", (event, ctx) => {
  if (event.message.role !== "assistant") return;
  const calls = event.message.content.filter(part => part.type === "toolCall");
  try { questions?.batch(calls); } catch (error) { fail(String(error), ctx); }
  soleCall = calls.length === 1 && calls[0].name === SUBMIT_TOOL ? calls[0].id : undefined;
  if (calls.some(call => call.name === SUBMIT_TOOL && hasIdentityMismatch(call.arguments, task))) fail("Guild result identity mismatch", ctx);
  if ((repairUsed && !soleCall) || accepted || (calls.some(call => call.name === SUBMIT_TOOL) && !soleCall)) fail("Duplicate, mixed, or post-submission work", ctx);
 });
 pi.on("tool_call", (_event, ctx) => {
  if (violation || accepted || ctx.signal?.aborted) {
   fail(violation ?? "Post-submission tool call", ctx);
   return {block: true, reason: violation, terminate: true};
  }
 });
 if (capability) pi.registerTool({
  name: ASK_TOOL, label: "Ask Guild parent",
  description: "Ask a clarification alone in its batch (maximum 8 questions, each at most 8192 UTF-8 bytes). An unavailable answer must be reported honestly, never invented.",
  parameters: questionSchema,
  prepareArguments: validateQuestion,
  async execute(id, params, signal, _update, ctx) {
   const signals = [signal, ctx.signal, questionAbort.signal].filter((value): value is AbortSignal => value !== undefined);
   const requestSignal = AbortSignal.any(signals);
   let onAbort: (() => void) | undefined;
   try {
    if (violation || accepted || requestSignal.aborted || questionExecuting) throw new Error(violation ?? "Invalid or duplicate Guild question execution");
    questions!.assertStarted(id, params);
    const {question} = validateQuestion(params);
    questionExecuting = true;
    // Race as well as forwarding the signal: cancellation must not depend on a UI adapter settling.
    const cancelled = new Promise<never>((_resolve, reject) => {
     onAbort = () => reject(new Error("Guild question aborted"));
     requestSignal.addEventListener("abort", onAbort, {once: true});
    });
    const answer = await Promise.race([cancelled, ctx.ui.input(JSON.stringify({protocol: BACKGROUND_CAPABILITY, runId: task.runId, taskId: task.taskId, toolCallId: id, question}), undefined, {signal: requestSignal, timeout: QUESTION_LIMITS.timeout})]);
    if (requestSignal.aborted || violation) throw new Error("Guild question aborted");
    // Pi maps both dialog cancellation and its timeout to undefined; do not invent a distinction.
    const details: QuestionOutcome = answer === undefined ? {outcome: "unavailable", reason: "cancelled-or-timed-out"} : {outcome: "answered", answer: validateQuestionText(answer)};
    return {content: [{type: "text", text: JSON.stringify(details)}], details};
   } catch (error) { fail(String(error), ctx); throw error; }
   finally { if (onAbort) requestSignal.removeEventListener("abort", onAbort); }
  },
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
   if (params.protocol !== task.protocol || params.version !== task.version || params.runId !== task.runId || params.taskId !== task.taskId || params.role !== task.role || params.profile !== task.profile) {
    fail("Guild result identity mismatch", ctx);
    throw new Error(violation);
   }
   const report = validateResult(params, task);
   accepted = true;
   return {content: [{type: "text", text: "Guild result recorded."}], details: report, terminate: true};
  },
 });
 const guardQuestion = (event: {type: string; toolName?: string; toolCallId?: string}, ctx: ExtensionContext) => {
  if (capability && accepted && (event.type === "tool_execution_update" || (event.type === "tool_execution_end" && event.toolName !== SUBMIT_TOOL))) fail("Tool event after submission", ctx);
  try { questions?.guard(event); } catch (error) { fail(String(error), ctx); }
 };
 pi.on("tool_execution_update", (event, ctx) => guardQuestion(event, ctx));
 pi.on("agent_settled", (event, ctx) => guardQuestion(event, ctx));
 // This event also sees Pi schema failures, which bypass tool_call and execute.
 pi.on("tool_execution_start", (event, ctx) => {
  guardQuestion(event, ctx);
  if (violation || accepted) { fail(violation ?? "Post-submission execution", ctx); return; }
  if (event.toolName === ASK_TOOL && questions) {
   try { questions.start(event.toolCallId, event.args); } catch (error) { fail(String(error), ctx); }
   return;
  }
  if (event.toolName !== SUBMIT_TOOL) return;
  if (event.toolCallId !== soleCall) { fail("Submission must be sole batch call", ctx); return; }
  const args = event.args;
  if (hasIdentityMismatch(args, task)) fail("Guild result identity mismatch", ctx);
 });
 pi.on("tool_execution_end", (event, ctx) => {
  guardQuestion(event, ctx);
  if (event.toolName === ASK_TOOL && questions) {
   try { questions.end(event.toolCallId, event.isError, event.result.details); questionExecuting = false; } catch (error) { fail(String(error), ctx); }
   return;
  }
  if (event.toolName !== SUBMIT_TOOL || !event.isError || violation || invalidCalls.has(event.toolCallId)) return;
  invalidCalls.add(event.toolCallId);
  if (accepted || repairUsed) { fail("Guild repair budget exhausted", ctx); return; }
  repairUsed = true; // The tool error itself supplies the one corrective opportunity.
 });
 pi.on("agent_before_settle", (event, ctx) => {
  if (capability && event.outcome !== "completed") return;
  if (questions?.isPending) { fail("Guild question still pending at settlement", ctx); return; }
  if (event.outcome !== "completed" || ctx.signal?.aborted || accepted || violation) return;
  if (repairUsed) { fail("Guild completion missing after repair", ctx); return; }
  repairUsed = true;
  return {entries: [...event.entries, {type: "custom_message", customType: "guild-result-repair", display: false,
   content: `No valid result was submitted. This is the only repair opportunity. Call ${SUBMIT_TOOL} now as the sole tool call, matching the host envelope and schema. State limitations honestly.`}], continue: true};
 });
}

export function loadChildTask(): GuildTask {
 const file = process.env.GUILD_TASK_FILE;
 if (!file) throw new Error("Missing host Guild task file");
 const fd = openSync(file, "r");
 let task: GuildTask;
 try {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size > LIMITS.envelope) throw new Error("Guild task file byte limit or file type invalid");
  const bytes = Buffer.alloc(LIMITS.envelope + 1);
  let length = 0;
  while (length < bytes.length) {
   const count = readSync(fd, bytes, length, bytes.length - length, null);
   if (!count) break;
   length += count;
  }
  if (length > LIMITS.envelope) throw new Error("Guild task file byte limit exceeded");
  task = validateTask(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, length))));
 } finally { closeSync(fd); }
 return task;
}

export default function childProtocol(pi: ExtensionAPI): void {
 registerChildProtocol(pi, loadChildTask());
}
