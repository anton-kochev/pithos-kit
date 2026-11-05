import { spawn } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASK_TOOL, BACKGROUND_CAPABILITY, buildTask, childTools, LIMITS, QUESTION_LIMITS, QuestionExchange, validateQuestionText, validateQuestionOutcome, renderReport, SUBMIT_TOOL } from "./protocol.ts";
import { ResultStream } from "./result-stream.ts";
import { loadGuildSkillCores } from "./resources.ts";
import { applyJsonEvent, createEmptyGuildRoleRunResult, getPiInvocation, snapshotRunResult, writeGuildRoleSystemPrompts, type GuildRoleRunResult, type RunGuildRoleOptions } from "./runner.ts";

export interface BackgroundControl { sendUpdate(text: string): Promise<"queued" | "handled"> }
export interface RunBackgroundGuildRoleOptions extends RunGuildRoleOptions {
 /** Host-bound task identity for internal composition; legacy callers allocate locally. */
 taskId?: string;
 /** Per-question cancellation is mandatory settlement control for composed adapters, not run cancellation. */
 onQuestion(question: string, questionSignal: AbortSignal): Promise<string | undefined>;
 onReady?: (control: BackgroundControl) => void;
}
interface Deadlines { command: number; handshake: number; run: number; question: number; eof: number; term: number; kill: number }
interface TestSeam {
 spawn?: typeof spawn;
 invocation?: (args: string[]) => {command: string; args: string[]};
 packageRoot?: string;
 limits?: Partial<Deadlines>;
}
const DEFAULTS: Deadlines = {command: 30_000, handshake: 60_000, run: 1_800_000, question: 300_000, eof: 5000, term: 3000, kill: 3000};
const childChannel = channel("pithos.guild.child");
type ChildObservation =
 | {type: "start"}
 | {type: "stdout" | "stderr"; base64: string}
 | {type: "end"; exitCode: number | null; aborted: boolean; selectedSkills: GuildRoleRunResult["selectedSkills"]};
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

export function runBackgroundGuildRole(options: RunBackgroundGuildRoleOptions): Promise<GuildRoleRunResult> {
 return run(options, {});
}
/** Offline fixtures and lifecycle fakes only; production uses the actual spawn and package. */
export function runBackgroundGuildRoleForTest(options: RunBackgroundGuildRoleOptions, seam: TestSeam): Promise<GuildRoleRunResult> {
 return run(options, seam);
}

async function run(options: RunBackgroundGuildRoleOptions, seam: TestSeam): Promise<GuildRoleRunResult> {
 const result = createEmptyGuildRoleRunResult(options.role, options.profile, options.task);
 result.runId = options.runId ?? randomUUID();
 result.taskId = options.taskId ?? randomUUID();
 result.model = options.model;
 result.usageKnown = false;
 result.usageFields = [];
 result.selectedSkills = [];
 // Capture identity before asynchronous setup; observations contain owned data only.
 const identity = {runId: result.runId, taskId: result.taskId, role: options.role, profile: options.profile};
 let childId: string | undefined;
 let sequence = 0;
 let settled = false;
 const publish = (event: ChildObservation) => {
  if (!childId || !childChannel.hasSubscribers) return;
  // diagnostics_channel subscribers must contain their own exceptions: Node rethrows
  // them on nextTick, outside a publisher's try/catch. Never install a global handler.
  childChannel.publish(freeze({version: 1, childId, ...identity, sequence: sequence++, ...event}));
 };
 let directory: string | undefined;
 let stream: ResultStream | undefined;
 try {
  const limits = {...DEFAULTS, ...seam.limits};
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error("Invalid background deadline");
  childTools(options.role, BACKGROUND_CAPABILITY);
  const task = buildTask({role: options.role, profile: options.profile, task: options.task, runId: result.runId, taskId: result.taskId, ...(options.practices === undefined ? {} : {practices: options.practices})});
  stream = new ResultStream(task, BACKGROUND_CAPABILITY);
  options.signal?.throwIfAborted();
  if (childChannel.hasSubscribers) {childId = randomUUID(); publish({type: "start"});}
  const cores = await loadGuildSkillCores(seam.packageRoot ?? packageRoot, task.role, task.practices);
  result.selectedSkills = cores.map(core => core.receipt);
  const prompts = await writeGuildRoleSystemPrompts(task.role, task.profile, cores);
  directory = prompts.directory;
  const taskFile = join(directory, "task.json");
  await fs.writeFile(taskFile, JSON.stringify(task), {mode: 0o600});
  const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", options.projectTrusted ? "--approve" : "--no-approve", "--tools", childTools(task.role, BACKGROUND_CAPABILITY).join(","), "--extension", fileURLToPath(new URL("./background-child-protocol.ts", import.meta.url))];
  if (options.model) args.push("--model", options.model);
  if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
  args.push("--system-prompt", prompts.baseSystemPromptFile, "--append-system-prompt", prompts.roleProfileSystemPromptFile);
  options.signal?.throwIfAborted();
  await transport(options, result, stream, taskFile, (seam.invocation ?? getPiInvocation)(args), limits, publish, seam.spawn);
  settled = true;
 } catch (error) {
  result.errorMessage = String(error).slice(0, 2048);
  stream?.fail(result.errorMessage);
 } finally {
  if (directory) await fs.rm(directory, {recursive: true, force: true}).catch(error => {
   result.errorMessage = `Guild cleanup failed: ${String(error).slice(0, 1024)}`;
   stream?.fail(result.errorMessage);
  });
  publish({type: "end", exitCode: settled ? result.exitCode : null, aborted: options.signal?.aborted === true,
   selectedSkills: structuredClone(result.selectedSkills)});
 }
 const terminal = stream?.finish(result.exitCode, options.signal?.aborted === true) ?? {status: options.signal?.aborted ? "cancelled" : "failed", diagnostic: result.errorMessage} as const;
 result.status = terminal.status;
 result.report = "report" in terminal ? terminal.report : undefined;
 result.output = result.report ? renderReport(result.report) : "";
 if (terminal.status !== "completed") result.errorMessage = terminal.diagnostic;
 return result;
}

function observe(callback: (() => unknown) | undefined): void {
 try { void Promise.resolve(callback?.()).catch(() => {}); } catch { /* Observers never own execution. */ }
}
function freeze(value: any): any {
 if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
 return value;
}

async function transport(options: RunBackgroundGuildRoleOptions, result: GuildRoleRunResult, stream: ResultStream, taskFile: string, invocation: {command: string; args: string[]}, limits: Deadlines, publish: (event: ChildObservation) => void, spawnChild: typeof spawn = spawn): Promise<void> {
 await new Promise<void>(resolve => {
  const child = spawnChild(invocation.command, invocation.args, {cwd: options.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env: {...process.env, PI_SKIP_VERSION_CHECK: "1", GUILD_TASK_FILE: taskFile}});
  const timers = new Set<NodeJS.Timeout>();
  const later = (fn: () => void, ms: number) => {const timer = setTimeout(() => {timers.delete(timer); fn();}, ms); timers.add(timer); return timer;};
  const cancelTimer = (timer: NodeJS.Timeout) => {clearTimeout(timer); timers.delete(timer);};
  let closed = false, stopping = false, eof = false, ready = false, accepted = false, settled = false, submitted = false;
  let sequence = 0, writes = 0, total = 0, stderrBytes = 0, updates = 0;
  let publishedReady = false;
  let buffer = Buffer.alloc(0), skipping = false;
  const questions = new QuestionExchange();
  const uiIds = new Set<string>();
  type PendingQuestion = {lifetime: AbortController; toolCallId: string; uiId: string; answered: boolean; outcome?: ReturnType<typeof validateQuestionOutcome>; timer?: NodeJS.Timeout};
  let question: PendingQuestion | undefined;
  // QuestionExchange caps this history at eight distinct calls per run.
  const questionResults = new Map<string, {outcome: ReturnType<typeof validateQuestionOutcome>; seen: boolean}>();
  const missingQuestionResult = () => [...questionResults.values()].some(value => !value.seen);
  const checkQuestionContent = (content: any, outcome: ReturnType<typeof validateQuestionOutcome>) => {
   if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text" || typeof content[0].text !== "string"
    || JSON.stringify(validateQuestionOutcome(JSON.parse(content[0].text))) !== JSON.stringify(outcome)) throw new Error("Guild question content does not match supplied answer");
  };
  const pending = new Map<string, {type: string; timer: NodeJS.Timeout; accept: (data: any) => void; reject?: (error: Error) => void}>();
  const cancelRequests = () => {
   for (const command of pending.values()) {cancelTimer(command.timer); command.reject?.(new Error(stream.failure ?? "Guild transport closed"));}
   pending.clear();
  };
  const finish = (code: number | null) => {
   if (closed) return;
   closed = true;
   question?.lifetime.abort();
   result.exitCode = code ?? 1;
   if (missingQuestionResult()) stream.fail("Missing Guild question toolResult");
   if (buffer.length || skipping) stream.fail("Incomplete Guild JSONL record at EOF");
   if (pending.size) stream.fail("Child exited with pending RPC commands");
   cancelRequests();
   for (const timer of timers) clearTimeout(timer);
   timers.clear();
   options.signal?.removeEventListener("abort", abort);
   resolve();
  };
  const fail = (reason: string) => {stream.fail(reason); stop();};
  const stop = () => {
   if (closed || stopping) return;
   stopping = true;
   // Mark transport stopped before notifying adapters: abort listeners can reenter.
   question?.lifetime.abort();
   cancelRequests();
   child.stdin.destroy();
   child.kill("SIGTERM");
   later(() => {
    child.kill("SIGKILL");
    later(() => {
     // Deadlines are not exit evidence. Retain ownership until close, even if
     // an unkillable process or inherited descendant pipes keep it pending.
     stream.fail("Child did not close after SIGKILL deadline");
    }, limits.kill);
   }, limits.term);
  };
  const abort = () => {fail("Guild handover cancelled");};
  const write = (record: object) => {
   if (stopping || closed || eof) throw new Error("Guild transport is closed");
   if (writes >= 8) throw new Error("Guild stdin queue limit exceeded");
   const bytes = JSON.stringify(record) + "\n";
   if (Buffer.byteLength(bytes) > LIMITS.envelope) throw new Error("Guild stdin record byte limit exceeded");
   writes++;
   try {child.stdin.write(bytes, error => {writes--; if (error) fail(`Guild stdin error: ${error.message}`);});}
   catch (error) {writes--; throw error;}
  };
  const maybeEOF = () => {
   if (!settled || !accepted || pending.size || stopping || eof || closed) return;
   eof = true;
   child.stdin.end();
   later(() => fail("Guild EOF shutdown timeout"), limits.eof);
  };
  const request = (type: "prompt" | "clear_queue" | "steer", fields: object, accept: (data: any) => void, reject?: (error: Error) => void) => {
   if (pending.size >= 8) throw new Error("Guild RPC pending limit exceeded");
   const id = `${stream.task.taskId}:${++sequence}`;
   const timer = later(() => fail(`Guild RPC ${type} timeout`), limits.command);
   pending.set(id, {type, timer, accept, reject});
   try {write({id, type, ...fields});}
   catch (error) {pending.delete(id); cancelTimer(timer); throw error;}
  };
  const control: BackgroundControl = Object.freeze({sendUpdate(text: string): Promise<"queued" | "handled"> {
   const promise = new Promise<"queued" | "handled">((resolveUpdate, reject) => {
    if (!ready || !accepted || stopping || closed || submitted || settled || questions.isPending) {reject(new Error("Guild is not running or is waiting for a question")); return;}
    try {
     validateQuestionText(text);
     if (updates >= 32 || [...pending.values()].filter(command => command.type === "steer").length >= 2) throw new Error("Guild update limit exceeded");
     updates++;
     request("steer", {message: text}, data => {
      if (data?.disposition !== "queued" && data?.disposition !== "handled") {reject(new Error("Invalid Guild steer disposition")); throw new Error("Invalid Guild steer disposition");}
      resolveUpdate(data.disposition);
     }, reject);
    } catch (error) {reject(error);}
   });
   void promise.catch(() => {});
   return promise;
  }});
  const publishReady = () => {
   if (!publishedReady && ready && accepted && !submitted && !settled && !stopping) {
    publishedReady = true;
    observe(() => options.onReady?.(control));
   }
  };
  const handshake = later(() => fail("Guild handshake timeout"), limits.handshake);
  later(() => fail("Guild run timeout"), limits.run);
  const event = (value: any) => {
   if (value?.type === "response") {
    const command = pending.get(value.id);
    if (!command || value.command !== command.type || value.success !== true) throw new Error(`Invalid or failed Guild RPC response: ${value.error ?? value.command}`);
    pending.delete(value.id); cancelTimer(command.timer); command.accept(value.data); publishReady(); maybeEOF();
    return;
   }
   if (value?.type === "queue_update") {
    if (Object.keys(value).sort().join() !== "followUp,steering,type"
     || ![value.steering, value.followUp].every(queue => Array.isArray(queue) && queue.length <= 32
      && queue.every(text => typeof text === "string" && Buffer.byteLength(text) <= QUESTION_LIMITS.text))) throw new Error("Invalid Guild queue update");
    // RPC clear_queue emits bookkeeping even after agent_settled; it is not agent work.
    return;
   }
   if (value?.type === "extension_ui_request") {
    if (!ready || submitted || question || value.method !== "input" || typeof value.id !== "string" || !value.id.trim() || value.id.includes("\0") || Buffer.byteLength(value.id) > LIMITS.id || uiIds.has(value.id) || uiIds.size >= QUESTION_LIMITS.count
     || Object.keys(value).sort().join() !== "id,method,timeout,title,type" || value.timeout !== QUESTION_LIMITS.timeout || typeof value.title !== "string") throw new Error("Invalid Guild question UI request");
    const metadata = JSON.parse(value.title);
    if (!metadata || Object.keys(metadata).sort().join() !== "protocol,question,runId,taskId,toolCallId" || metadata.protocol !== BACKGROUND_CAPABILITY || metadata.runId !== stream.task.runId || metadata.taskId !== stream.task.taskId) throw new Error("Invalid Guild question UI identity");
    questions.assertStarted(metadata.toolCallId, {question: metadata.question});
    uiIds.add(value.id);
    const current: PendingQuestion = {lifetime: new AbortController(), toolCallId: metadata.toolCallId, uiId: value.id, answered: false};
    question = current;
    const answer = (text: string | undefined) => {
     if (closed || stopping || question !== current || current.answered) return;
     try {
      const outcome = text === undefined ? {outcome: "unavailable" as const, reason: "cancelled-or-timed-out" as const} : {outcome: "answered" as const, answer: validateQuestionText(text)};
      current.answered = true;
      current.outcome = outcome;
      if (current.timer) cancelTimer(current.timer);
      if (outcome.outcome === "unavailable") current.lifetime.abort();
      if (closed || stopping) return;
      write({type: "extension_ui_response", id: current.uiId, ...(outcome.outcome === "answered" ? {value: outcome.answer} : {cancelled: true})});
     } catch (error) {fail(String(error));}
    };
    current.timer = later(() => answer(undefined), limits.question);
    // Invoke before processing more child events so the callback can observe cancellation.
    // Never join it: a parent callback may ignore cancellation forever.
    void (async () => options.onQuestion(metadata.question, current.lifetime.signal))().then(answer, error => {
     if (!closed && !stopping && question === current && !current.answered) fail(`Guild question callback failed: ${String(error)}`);
    });
    return;
   }
   if (submitted && (["agent_start", "turn_start", "message_update"].includes(value?.type) || (value?.type === "message_start" && ["assistant", "user"].includes(value.message?.role)))) throw new Error("Guild work after submission");
   // Pi emits toolResult after execution_end and before the next assistant turn.
   if (missingQuestionResult() && (value.type === "agent_settled" || (value.type.startsWith("message_") && value.message?.role === "assistant") || value.type === "tool_execution_start")) throw new Error("Missing Guild question toolResult");
   if (value.type === "message_end" && value.message?.role === "toolResult" && (value.message.toolName === ASK_TOOL || questionResults.has(value.message.toolCallId))) {
    const message = value.message;
    const expected = questionResults.get(message.toolCallId);
    if (!expected || expected.seen || message.toolName !== ASK_TOOL || message.isError !== false
     || JSON.stringify(validateQuestionOutcome(message.details)) !== JSON.stringify(expected.outcome)) throw new Error("Guild question toolResult does not match supplied answer");
    checkQuestionContent(message.content, expected.outcome);
    expected.seen = true;
   }
   questions.guard(value);
   if (value?.type === "message_end" && value.message?.role === "assistant") questions.batch(Array.isArray(value.message.content) ? value.message.content.filter((part: any) => part?.type === "toolCall") : []);
   if (value?.type === "tool_execution_start" && value.toolName === ASK_TOOL) questions.start(value.toolCallId, value.args);
   if (value?.type === "tool_execution_end" && value.toolName === ASK_TOOL) {
    const outcome = validateQuestionOutcome(value.result?.details);
    if (!question?.answered || question.toolCallId !== value.toolCallId || JSON.stringify(outcome) !== JSON.stringify(question.outcome)) throw new Error("Guild question result does not match supplied answer");
    checkQuestionContent(value.result?.content, outcome);
    questionResults.set(value.toolCallId, {outcome, seen: false});
    questions.end(value.toolCallId, value.isError, outcome);
    question = undefined;
   }
   stream.event(value);
   applyJsonEvent(result, value);
   if (stream.failure) {stop(); return;}
   if (value.type === "message_end" && value.message?.customType === "guild-protocol-ready") {ready = true; cancelTimer(handshake); publishReady();}
   if (value.type === "tool_execution_end" && value.toolName === SUBMIT_TOOL && value.isError === false) {
    submitted = true;
    request("clear_queue", {}, () => {});
   }
   if (value.type === "agent_settled") {settled = true; if (!submitted) throw new Error("Guild settled without accepted report"); maybeEOF();}
   observe(() => options.onEvent?.(freeze(structuredClone(value))));
   observe(() => options.onUpdate?.(snapshotRunResult(result)));
  };
  // Inspect only a short prefix before retaining a line. Duplicate aggregates can be enormous.
  const aggregate = (bytes: Buffer) => ["{\"type\":\"agent_end\"", "{\"type\":\"turn_end\""].some(prefix => bytes.length > prefix.length && bytes.subarray(0, prefix.length).toString() === prefix && [44, 125].includes(bytes[prefix.length]));
  child.stdout.on("data", (chunk: Buffer) => {
   if (childChannel.hasSubscribers) publish({type: "stdout", base64: chunk.toString("base64")});
   if (closed || stopping) return;
   try {
    let rest = chunk;
    while (rest.length && !stopping) {
     const newline = rest.indexOf(10);
     const part = newline < 0 ? rest : rest.subarray(0, newline);
     rest = newline < 0 ? Buffer.alloc(0) : rest.subarray(newline + 1);
     if (!skipping) {
      const prefix = Buffer.concat([buffer.subarray(0, 32), part.subarray(0, 32)]).subarray(0, 32);
      if (aggregate(prefix)) {skipping = true; buffer = Buffer.alloc(0);}
      else {
       if (buffer.length + part.length > LIMITS.line) throw new Error("Guild JSON line byte limit exceeded");
       buffer = Buffer.concat([buffer, part]);
      }
     }
     if (newline < 0) break;
     if (skipping) {skipping = false; continue;}
     total += buffer.length + 1;
     if (total > LIMITS.stdout) throw new Error("Guild stdout byte limit exceeded");
     const line = buffer; buffer = Buffer.alloc(0);
     event(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(line)));
    }
   } catch (error) {fail(String(error));}
  });
  const stderrDecoder = new TextDecoder("utf-8", {fatal: true});
  child.stderr.on("data", (chunk: Buffer) => {
   if (childChannel.hasSubscribers) publish({type: "stderr", base64: chunk.toString("base64")});
   if (closed || stopping) return;
   stderrBytes += chunk.length;
   if (stderrBytes > LIMITS.stderr) {fail("Guild stderr byte limit exceeded"); return;}
   try {result.stderr += stderrDecoder.decode(chunk, {stream: true});} catch {fail("Invalid Guild stderr UTF-8");}
   if (/Extension error|Failed to load extension/i.test(result.stderr)) fail("Guild child extension failure");
  });
  child.stderr.on("end", () => {try {result.stderr += stderrDecoder.decode();} catch {fail("Invalid Guild stderr UTF-8");}});
  child.stdout.on("error", error => fail(`Guild stdout error: ${error.message}`));
  child.stderr.on("error", error => fail(`Guild stderr error: ${error.message}`));
  child.stdin.on("error", error => fail(`Guild stdin error: ${error.message}`));
  child.on("error", error => fail(error.message));
  child.on("close", finish);
  if (options.signal?.aborted) abort();
  else {
   options.signal?.addEventListener("abort", abort, {once: true});
   try {
    request("prompt", {message: `Task: ${options.task}`}, data => {
     if (data?.disposition !== "started") throw new Error("Guild initial prompt was not started");
     accepted = true;
    });
   } catch (error) {fail(String(error));}
  }
 });
}
