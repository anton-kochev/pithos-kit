import { childTools, hasIdentityMismatch, LIMITS, PROTOCOL, SUBMIT_TOOL, validateResult, type GuildReport, type GuildTask } from "./protocol.ts";

export interface GuildTerminal {
 status: "completed" | "failed" | "cancelled";
 report?: GuildReport;
 diagnostic?: string;
}

/** Bounded cooperative transport validation, not authentication of a hostile child. */
export class ResultStream {
 failure?: string;
 private ready = false;
 private settled = false;
 private report?: GuildReport;
 private soleCall?: string;
 private startedCall?: string;
 private readonly submissionIds = new Set<string>();
 private repairUsed = false;
 private total = 0;
 private buffer = Buffer.alloc(0);
 private terminal?: GuildTerminal;
 constructor(readonly task: GuildTask) {}
 fail(reason: string): void { if (!this.terminal) this.failure ??= reason.slice(0, 2048); }
 event(event: any): void {
  if (this.terminal) return;
  if (!event || typeof event.type !== "string") { this.fail("Invalid JSON event"); return; }
  if (this.settled) { this.fail("Event after final settlement"); return; }
  if (event.type === "error" || event.type === "extension_error") this.fail("Child process/provider/extension error");
  if (event.type === "entry_appended" && event.entry?.customType === "guild-result-repair") {
   if (this.repairUsed || this.report) this.fail("Guild repair budget exhausted");
   this.repairUsed = true;
  }
  if (event.type === "message_end" && event.message?.role === "custom" && event.message.customType === "guild-protocol-ready") {
   const d = event.message.details;
   if (this.ready || !d || Object.keys(d).sort().join() !== "protocol,runId,taskId,tools,version" || d.protocol !== PROTOCOL || d.version !== 2 || d.runId !== this.task.runId || d.taskId !== this.task.taskId || !Array.isArray(d.tools) || JSON.stringify(d.tools.slice().sort()) !== JSON.stringify(childTools(this.task.role).sort())) this.fail("Invalid Guild protocol handshake");
   else this.ready = true;
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
   if (!this.ready) this.fail("Missing Guild protocol handshake");
   if (["error", "aborted", "length", "deferred"].includes(event.message.stopReason)) this.fail(`Child terminal outcome: ${event.message.stopReason}`);
   if (this.report) this.fail("Assistant work after submission");
   const calls = Array.isArray(event.message.content) ? event.message.content.filter((p: any) => p?.type === "toolCall") : [];
   this.soleCall = calls.length === 1 && calls[0].name === SUBMIT_TOOL && typeof calls[0].id === "string" ? calls[0].id : undefined;
   if (this.repairUsed && !this.soleCall) this.fail("Guild repair requires sole submission on next response");
   if (calls.some((c: any) => c.name === SUBMIT_TOOL && hasIdentityMismatch(c.arguments, this.task))) this.fail("Guild result identity mismatch");
   if (calls.some((c: any) => c.name === SUBMIT_TOOL) && !this.soleCall) this.fail("Submission must be sole tool batch call");
  }
  if (event.type === "tool_execution_start") {
   if (!this.ready || this.report || !childTools(this.task.role).includes(event.toolName)) this.fail("Unexpected or post-submission tool execution");
   if (event.toolName === SUBMIT_TOOL) {
    if (!this.soleCall || event.toolCallId !== this.soleCall || this.startedCall || this.submissionIds.has(event.toolCallId)) this.fail("Uncorrelated or duplicate submission");
    if (this.submissionIds.size >= 2) this.fail("Guild submission attempt limit exceeded");
    if (!this.failure) this.submissionIds.add(event.toolCallId);
    this.startedCall = event.toolCallId;
    const args = event.args;
    if (hasIdentityMismatch(args, this.task)) this.fail("Guild result identity mismatch");
   }
  }
  if (this.report && (event.type === "tool_execution_update" || (event.type === "tool_execution_end" && event.toolName !== SUBMIT_TOOL))) this.fail("Tool event after submission");
  if (event.type === "tool_execution_end" && event.toolName === SUBMIT_TOOL) {
   if (!this.ready || this.report || !this.startedCall || event.toolCallId !== this.startedCall) { this.fail("Duplicate or uncorrelated submission result"); return; }
   this.startedCall = undefined;
   if (event.isError === true) {
    if (this.repairUsed) this.fail("Guild repair budget exhausted");
    this.repairUsed = true;
   } else if (event.isError === false) {
    try { this.report = validateResult(event.result?.details, this.task); }
    catch (error) { this.fail(error instanceof Error ? error.message : "Invalid Guild result"); }
   } else this.fail("Malformed submission result status");
  }
  // toolResult message_end is a second representation, never another submission.
  if (event.type === "agent_settled") this.settled = true;
 }
 push(chunk: Buffer, observe: (event: any) => void): void {
  if (this.terminal || this.failure) return;
  this.total += chunk.length;
  if (this.total > LIMITS.stdout) { this.fail("Guild stdout byte limit exceeded"); return; }
  this.buffer = Buffer.concat([this.buffer, chunk]);
  let newline: number;
  while ((newline = this.buffer.indexOf(10)) >= 0) {
   const line = this.buffer.subarray(0, newline);
   this.buffer = this.buffer.subarray(newline + 1);
   this.line(line, observe);
   if (this.failure) { this.buffer = Buffer.alloc(0); return; }
  }
  if (this.buffer.length > LIMITS.line) { this.buffer = Buffer.alloc(0); this.fail("Guild JSON line byte limit exceeded"); }
 }
 end(observe: (event: any) => void): void {
  if (this.buffer.length && !this.failure) this.line(this.buffer, observe);
  this.buffer = Buffer.alloc(0);
 }
 private line(line: Buffer, observe: (event: any) => void): void {
  if (line.length > LIMITS.line) { this.fail("Guild JSON line byte limit exceeded"); return; }
  if (!line.length) return;
  let event: any;
  try { event = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(line)); }
  catch { this.fail("Malformed Guild JSON stream"); return; }
  this.event(event);
  try { observe(event); } catch { /* observational callbacks cannot own transport */ }
 }
 finish(exitCode: number, cancelled: boolean): GuildTerminal {
  if (this.terminal) return this.terminal;
  if (cancelled) this.terminal = {status: "cancelled", diagnostic: "Guild handover cancelled"};
  else if (this.failure || exitCode !== 0 || !this.ready || !this.settled || !this.report) this.terminal = {status: "failed", diagnostic: this.failure ?? (exitCode !== 0 ? `Child exited with code ${exitCode}` : "Missing Guild handshake, result or final settlement")};
  else this.terminal = {status: "completed", report: this.report};
  return this.terminal;
 }
}
