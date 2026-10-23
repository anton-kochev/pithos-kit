import { childTools, hasIdentityMismatch, LIMITS, PROTOCOL, SUBMIT_TOOL, validateResult, type GuildReport, type GuildTask } from "./protocol.ts";

export interface GuildTerminal {
 status: "completed" | "failed" | "cancelled";
 report?: GuildReport;
 diagnostic?: string;
}

// agent_end and turn_end only repeat messages and tool results already streamed one by one.
// agent_end carries the whole child conversation, so long runs used to hit the line and stdout
// limits on it right after submitting. Pi serializes `type` first; skipped lines are never parsed.
const AGGREGATE_PREFIXES = [`{"type":"agent_end"`, `{"type":"turn_end"`].map(prefix => Buffer.from(prefix));
const EMPTY = Buffer.alloc(0);

/** True once the bytes seen so far prove an aggregate line; a shorter prefix stays undecided. */
function isAggregateLine(bytes: Buffer): boolean {
 return AGGREGATE_PREFIXES.some(prefix => bytes.length > prefix.length && bytes.subarray(0, prefix.length).equals(prefix)
  && (bytes[prefix.length] === 0x2c || bytes[prefix.length] === 0x7d));
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
 private buffer = EMPTY;
 /** Discarding the rest of an aggregate line until its newline. */
 private skipping = false;
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
   if (["error", "aborted", "length", "deferred"].includes(event.message.stopReason)) {
    const detail = typeof event.message.errorMessage === "string" ? event.message.errorMessage.trim() : "";
    this.fail(`Child terminal outcome: ${event.message.stopReason}${detail ? `: ${detail}` : ""}`);
   }
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
  let rest = chunk;
  while (rest.length) {
   const newline = rest.indexOf(10);
   const part = newline < 0 ? rest : rest.subarray(0, newline);
   rest = newline < 0 ? EMPTY : rest.subarray(newline + 1);
   if (!this.skipping) {
    this.buffer = Buffer.concat([this.buffer, part]);
    if (isAggregateLine(this.buffer)) { this.skipping = true; this.buffer = EMPTY; }
   }
   if (newline < 0) break;
   if (this.skipping) { this.skipping = false; continue; }
   const line = this.buffer;
   this.buffer = EMPTY;
   // Aggregates are excluded: the limit bounds the events the host actually parses.
   this.total += line.length + 1;
   if (this.total > LIMITS.stdout) { this.fail("Guild stdout byte limit exceeded"); return; }
   this.line(line, observe);
   if (this.failure) return;
  }
  if (this.buffer.length > LIMITS.line) { this.buffer = EMPTY; this.fail("Guild JSON line byte limit exceeded"); }
 }
 end(observe: (event: any) => void): void {
  if (this.buffer.length && !this.failure && !this.skipping) this.line(this.buffer, observe);
  this.buffer = EMPTY;
  this.skipping = false;
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
