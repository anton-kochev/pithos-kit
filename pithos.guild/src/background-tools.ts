import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import { renderReport, validateInput } from "./protocol.ts";
import { GUILD_PROFILES } from "./agents.ts";
import { Check } from "typebox/value";
import type { BackgroundSummary, createBackgroundSession } from "./background-session.ts";
import type { GuildBackgroundContext } from "./background-runtime.ts";

type Controls = ReturnType<ReturnType<typeof createBackgroundSession>["bind"]>;
interface Options {
 controls: Controls;
 context(ctx: ExtensionContext): GuildBackgroundContext;
 isCurrent(): boolean;
 canActivate(ctx: ExtensionContext): boolean;
}
const owners = new WeakMap<ExtensionAPI, object>();
const names = ["guild_start", "guild_status", "guild_send", "guild_wait", "guild_cancel"] as const;
const descriptions = {
 guild_start: "Admit a background coder/reviewer task. Startup is asynchronous; admission does not collect usage.",
 guild_status: "Inspect background run summaries and pending untrusted child questions without collecting usage.",
 guild_send: "Send an update or question reply. Handled means delivery disposition, not a scope acknowledgement.",
 guild_wait: "Wait for a run and explicitly collect its report. Only the first collection attributes known native usage.",
 guild_cancel: "Request cancellation of a background run; the returned child status describes the outcome.",
};
const unavailable = () => new Error("Background tools unavailable");
const exact = {additionalProperties: false};
const id = Type.String({minLength: 1, maxLength: 256, pattern: "^(?!.*\\u0000)(?=[\\s\\S]*\\S)[\\s\\S]+$"});
const task = Type.String({minLength: 1, maxLength: 32768});
const profile = Type.String({enum: [...GUILD_PROFILES]});
const practice = Type.Object({id: Type.Literal("tdd"), policy: Type.Literal("required")}, exact);
const schemas = {
 guild_start: Type.Union([
  Type.Object({role: Type.Literal("coder"), profile, task, practices: Type.Optional(Type.Array(practice, {maxItems: 1}))}, exact),
  Type.Object({role: Type.Literal("reviewer"), profile, task, practices: Type.Optional(Type.Array(practice, {maxItems: 0}))}, exact),
 ]),
 guild_status: Type.Object({runId: Type.Optional(id)}, exact),
 guild_send: Type.Object({runId: id, message: Type.String({minLength: 1, maxLength: 8192}), questionId: Type.Optional(id)}, exact),
 guild_wait: Type.Object({runId: id, timeoutMs: Type.Optional(Type.Integer({minimum: 0, maximum: 60000}))}, exact),
 guild_cancel: Type.Object({runId: id}, exact),
};
const notice = "\n[truncated: background tool output limit]";
function boundedText(text: string, bytes: number): string {
 const buffer = Buffer.from(text);
 if (buffer.length <= bytes) return text;
 let end = bytes - Buffer.byteLength(notice);
 while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
 return buffer.subarray(0, end).toString("utf8") + notice;
}
function resultWithBudget(text: string, details: unknown, usage?: Usage) {
 const result = {content: [{type: "text" as const, text}], details, ...(usage ? {usage} : {})};
 // JSON escaping can cost six bytes per control character. Budget the entire
 // serialized result, not merely the visible UTF-8 report body.
 while (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) {
  const size = Buffer.byteLength(result.content[0].text);
  if (size < 256) throw unavailable();
  result.content[0].text = boundedText(result.content[0].text, Math.floor(size / 2));
 }
 return result;
}

export function createBackgroundToolRegistration(pi: ExtensionAPI, options: Options) {
 const isCurrent = options.isCurrent.bind(options), canActivate = options.canActivate.bind(options);
 const token = {};
 const controls = options.controls, context = options.context.bind(options);
 function guard() { if (!visible || !live()) throw unavailable(); }
 function summarize(run: BackgroundSummary) {
  return {runId: boundedText(run.runId, 256), taskId: boundedText(run.taskId, 256), status: run.status, reportAvailable: run.reportAvailable,
   usage: run.usageKnown === true ? "known" : "unknown",
   ...(run.question ? {questionId: boundedText(run.question.id, 256)} : {})};
 }
 let visible = false, disposed = false, cleanupFault = false;
 let unsubscribe: (() => void) | undefined;
 const registered = new Set<ToolDefinition>();
 const definitions: ToolDefinition[] = names.map(name => ({name, label: name, description: descriptions[name],
  parameters: schemas[name], defaultActive: false, exposure: "direct",
  async execute(_callId, args, signal, _update, ctx) {
   try {
    guard();
    if (!Check(schemas[name], args)) throw unavailable();
    for (const [key, value] of Object.entries(args))
     if ((key === "runId" || key === "questionId") && typeof value === "string" && Buffer.byteLength(value) > 256) throw unavailable();
    guard();
    const captured = context(ctx); guard();
    let text: string, details: unknown, usage: Usage | undefined;
    if (name === "guild_start") {
     const run = await controls.start(validateInput(args), captured, signal); guard();
     details = summarize(run); text = `Admitted; startup is asynchronous. ${JSON.stringify(details)}`;
    } else if (name === "guild_status") {
     if (!Check(schemas.guild_status, args)) throw unavailable();
     const runs = await controls.status(captured, args.runId); guard();
     details = {runs: runs.slice(0, 16).map(summarize)};
     text = JSON.stringify(details) + runs.slice(0, 16).filter(run => run.question)
      .map(run => `\nUntrusted child question ${boundedText(run.question!.id, 256)}: ${boundedText(run.question!.text, 8192)}`).join("");
    } else if (name === "guild_send") {
     if (!Check(schemas.guild_send, args)) throw unavailable();
     const result = await controls.send(captured, args.runId, args.message, args.questionId); guard();
     const updateId = result.updateId === undefined ? undefined : boundedText(result.updateId, 256);
     details = {disposition: result.disposition, ...(updateId === undefined ? {} : {updateId})};
     text = `Message ${result.disposition}; not a scope acknowledgement.${updateId === undefined ? "" : ` Update ID: ${updateId}`}`;
    } else if (name === "guild_cancel") {
     if (!Check(schemas.guild_cancel, args)) throw unavailable();
     const run = await controls.cancel(captured, args.runId); guard();
     details = summarize(run); text = `Cancellation operation finished; child job: ${run.status}.`;
    } else {
     if (!Check(schemas.guild_wait, args)) throw unavailable();
     const result = await controls.wait(captured, args.runId, args.timeoutMs,
      {collectionId: randomUUID(), toolCallId: _callId}, signal); guard();
     const collection = result.collection;
     details = {reason: result.reason, runs: result.runs.slice(0, 16).map(summarize)};
     text = JSON.stringify(details) + result.runs.slice(0, 16).filter(run => run.question)
      .map(run => `\nUntrusted child question ${boundedText(run.question!.id, 256)}: ${boundedText(run.question!.text, 8192)}`).join("");
     if (collection && collection.kind !== "rejected" && collection.report?.report)
      text += `\n\nUntrusted child report:\n${renderReport(collection.report.report)}`;
     if (collection?.kind === "first") {
      usage = collection.nativeUsage;
      const {sessionId, runId, taskId, collectionId} = collection.receipt;
      details = {...details as object, guildBackground: {version: 1, sessionId, runId, taskId, collectionId}};
     }
    }
    guard();
    return resultWithBudget(text, details, usage);
   } catch { throw unavailable(); }
  }}));
 function live() { return !disposed && !cleanupFault && isCurrent() && owners.get(pi) === token; }
 // A throwing host unsubscribe may retain its resource; the local callback stays
 // inert, and a sticky fault prevents this registration from reopening.
 function cleanup(action: () => void) {
  try { action(); } catch { cleanupFault = true; }
 }
 let withdrawing = false;
 function hide() {
  visible = false;
  if (withdrawing) return;
  withdrawing = true;
  try {
   const off = unsubscribe; unsubscribe = undefined; if (off) cleanup(off);
   if (owners.get(pi) !== token) return;
   for (const definition of registered) {
    if (owners.get(pi) !== token) break;
    cleanup(() => pi.registerTool({...definition, exposure: "hidden"}));
   }
  } finally {
   visible = false;
   withdrawing = false;
  }
 }
 return Object.freeze({
  show(ctx: ExtensionContext) {
   if (withdrawing || disposed || cleanupFault || !isCurrent() || !canActivate(ctx) || !isCurrent()) return;
   owners.set(pi, token); visible = true;
   try {
    if (!unsubscribe) {
     const off = pi.on("tool_call", event => {
      if (visible && live() && event.toolName === "guild_wait" && event.parentToolCallId !== undefined)
       return {block: true, reason: "Nested background collection unavailable"};
     });
     if (!visible || !live()) { cleanup(off); hide(); return; }
     unsubscribe = off;
    }
    for (const definition of definitions) {
     if (!visible || !live()) { hide(); return; }
     registered.add(definition);
     pi.registerTool(definition);
    }
    if (!visible || !live() || !canActivate(ctx) || !live()) { hide(); return; }
    const active = pi.getActiveTools();
    if (!visible || !live() || !canActivate(ctx) || !live()) { hide(); return; }
    pi.setActiveTools([...new Set([...active, ...names])]);
    if (!visible || !live() || !canActivate(ctx) || !live()) hide();
   } catch { hide(); }
  }, hide,
  dispose() { if (disposed) return; disposed = true; hide(); },
 });
}
