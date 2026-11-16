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
 onRetire?(): void;
 onFault?(): void;
}
const owners = new WeakMap<ExtensionAPI, object>();
const names = ["guild_start", "guild_status", "guild_send", "guild_wait", "guild_cancel"] as const;
const descriptions = {
 guild_start: "Delegate a scoped task to any supported Guild role/profile in the background. Returns run IDs without waiting for completion; admission does not collect usage.",
 guild_status: "Inspect background run summaries and pending untrusted child questions without collecting usage.",
 guild_send: "Send an update or question reply. Handled means delivery disposition, not a scope acknowledgement.",
 guild_wait: "Collect an available report without waiting by default. Set timeoutMs explicitly only when dependent work needs a bounded wait. Only the first collection attributes known native usage.",
 guild_cancel: "Request cancellation of a background run; the returned child status describes the outcome.",
};
const guidelines: Record<typeof names[number], string[]> = {
 guild_start: [
  "Prefer guild_start over blocking guild_handover whenever guild_start is available, including explorer, architect, coder, reviewer, and writer tasks.",
  "After guild_start, continue independent work or finish your turn so the user can send another request while children run. Do not poll guild_status or immediately loop on guild_wait; wait only when your next step actually depends on the result.",
  "Give guild_start a self-contained task with scope, acceptance criteria, and relevant repository instructions; children do not inherit this conversation. Coordinate non-overlapping edits between the parent and children: all share the working directory, with no file locks or worktree isolation.",
  "For guild_start writer/general, supply audience, purpose, format, tone, length, local source material, an explicit output path, and acceptance criteria. Research in the parent; writer has no shell or web tools. Background children can ask the parent for missing context through guild_ask_parent.",
  "For guild_start reviewer, supply the original requirement preferably verbatim, user constraints and decisions with provenance separately from implementer assumptions, exact scope and comparison, optional plan/rationale, and actual verification evidence and limitations. Use explicit local file paths and instruct the child to read those files; omit secrets. Reviewers independently challenge plan and implementation. Close essential context gaps and request another review; never present a limited review as complete.",
  "A guild_start admission or completion notice is not verified success. Collect the terminal report with guild_wait and verify child claims before treating work as complete. Automatic notices require qualified parent continuation; do not promise an automatic follow-up when it is unavailable.",
 ],
 guild_status: ["Use guild_status for an explicit progress check or recovery, not a polling loop that keeps the parent busy."],
 guild_send: ["Use guild_send with the exact currently pending questionId to answer a child question; an ordinary update is not a reply or a scope acknowledgment."],
 guild_wait: ["Use guild_wait with timeoutMs: 0 after a terminal notice to collect the report and usage. A positive timeoutMs holds the parent tool call open; use it only for an actual dependency or an explicit user request to wait."],
 guild_cancel: ["Use guild_cancel for explicit cancellation. Finishing your turn or handling another user request does not require cancelling background children."],
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
  Type.Object({role: Type.String({enum: ["explorer", "architect", "reviewer"]}), profile, task, practices: Type.Optional(Type.Array(practice, {maxItems: 0}))}, exact),
  Type.Object({role: Type.Literal("writer"), profile: Type.Literal("general"), task, practices: Type.Optional(Type.Array(practice, {maxItems: 0}))}, exact),
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
 type Handle = {
  protocol: "pi-atomic-owned-tools-v1";
  isActive(): boolean;
  update(batch: readonly {definition: ToolDefinition; activation: "activate" | "deactivate"}[]): {status: string};
  dispose(): {status: string};
 };
 let handle: Handle | undefined;
 let showing = false, providerRetired = false, revision = 0;
 const definitions: ToolDefinition[] = names.map(name => ({name, label: name, description: descriptions[name],
  promptSnippet: descriptions[name], promptGuidelines: guidelines[name],
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
     const result = await controls.wait(captured, args.runId, args.timeoutMs ?? 0,
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
 function local() { return isCurrent() && !disposed && !cleanupFault && owners.get(pi) === token; }
 function live() {
  const intent = revision;
  if (!local() || !handle) return false;
  const owned = handle;
  try { return owned.isActive() === true && local() && revision === intent; }
  catch { if (operationCurrent(owned, intent)) fault(); return false; }
 }
 function notify(callback: (() => void) | undefined) {
  try { void Promise.resolve(callback?.()).catch(() => {}); } catch { /* Local fences already closed. */ }
 }
 function fault() {
  visible = false;
  if (cleanupFault) return;
  cleanupFault = true;
  notify(options.onFault?.bind(options));
 }
 // A throwing unsubscribe may retain its resource; its callback stays inert.
 function cleanup(action: () => void) { try { action(); } catch { fault(); } }
 function detach() {
  const off = unsubscribe; unsubscribe = undefined;
  if (off) cleanup(off);
 }
 function retired() {
  providerRetired = true;
  if (disposed) return;
  disposed = true; visible = false; handle = undefined;
  notify(options.onRetire?.bind(options));
  detach();
 }
 function cleanupCurrent(owned: Handle | undefined) {
  return !providerRetired && owners.get(pi) === token && handle === owned;
 }
 function operationCurrent(owned: Handle | undefined, intent: number) {
  return cleanupCurrent(owned) && revision === intent;
 }
 let withdrawing = false, pendingDisposal = false;
 function withdraw(dispose: boolean) {
  if (dispose) pendingDisposal = true;
  revision++;
  visible = false;
  if (withdrawing) return;
  withdrawing = true;
  dispose = pendingDisposal; pendingDisposal = false;
  const owned = handle;
  try {
   detach();
   if (!owned || owners.get(pi) !== token) return;
   // Provider retirement is final: never issue writes through an old handle.
   if (owned.isActive() !== true || handle !== owned || owners.get(pi) !== token) return;
   dispose = dispose || pendingDisposal;
   if (dispose) pendingDisposal = false;
   const result = dispose ? owned.dispose() : owned.update(definitions.map(definition => ({
    definition: {...definition, exposure: "hidden"}, activation: "deactivate" as const,
   })));
   // Local intent changes cannot make a failed release safe; only lost ownership can.
   if (result?.status !== "committed" && cleanupCurrent(owned)) fault();
   if (dispose && result?.status === "committed" && handle === owned) handle = undefined;
  } catch { if (cleanupCurrent(owned)) fault(); }
  finally {
   visible = false; withdrawing = false;
   if (pendingDisposal) {
    pendingDisposal = false;
    if (owned && !providerRetired && handle === owned && owners.get(pi) === token) withdraw(true);
   }
  }
 }
 function hide() { withdraw(false); }
 return Object.freeze({
  show(ctx: ExtensionContext) {
   if (withdrawing || showing || disposed || cleanupFault) return;
   showing = true;
   const intent = revision;
   const eligible = () => local() && revision === intent;
   let owned = handle;
   try {
    if (!isCurrent() || !canActivate(ctx) || !isCurrent()) return;
    const capability = (pi as unknown as {atomicOwnedTools?: {protocol?: unknown; bind?: unknown}}).atomicOwnedTools;
    if (capability?.protocol !== "pi-atomic-owned-tools-v1") return;
    const bind = capability.bind;
    if (typeof bind !== "function") return;
    if (!isCurrent() || disposed || cleanupFault || revision !== intent) return;
    owners.set(pi, token);
    // Install the nested-wait preclaim fence before acquiring a provider claim.
    if (!unsubscribe) {
     const off = pi.on("tool_call", event => {
      if (visible && live() && event.toolName === "guild_wait" && event.parentToolCallId !== undefined)
       return {block: true, reason: "Nested background collection unavailable"};
     });
     if (typeof off !== "function") { fault(); return; }
     if (!eligible()) { cleanup(off); return; }
     unsubscribe = off;
    }
    if (!eligible() || !canActivate(ctx) || !eligible()) { hide(); return; }
    if (!handle) {
     const candidate = Reflect.apply(bind, capability, [names, retired]) as Handle;
     if (providerRetired) return;
     let accepted = false;
     let release: Handle["dispose"] | undefined;
     try {
      // Acquire cleanup before qualification: even a malformed return owns a resource.
      const dispose = candidate?.dispose;
      if (typeof dispose === "function") {
       let released = false;
       release = () => {
        if (released) return {status: "aborted"};
        // A failed release may retain the claim, but must not be retried by reentry.
        released = true;
        return Reflect.apply(dispose, candidate, []);
       };
      }
      const protocol = candidate?.protocol;
      const active = candidate?.isActive, update = candidate?.update;
      if (providerRetired || owners.get(pi) !== token) return;
      if (protocol !== "pi-atomic-owned-tools-v1" || typeof active !== "function"
       || typeof update !== "function" || !release) throw unavailable();
      if (!eligible()) return;
      handle = {protocol, isActive: () => Reflect.apply(active, candidate, []),
       update: batch => Reflect.apply(update, candidate, [batch]), dispose: release};
      owned = handle;
      accepted = true;
     } finally {
      // Never clean a replacement or a provider-retired claim, including getter reentry.
      if (!accepted && release && cleanupCurrent(owned)) {
       // This closure releases exactly the returned candidate, even if bind changed intent.
       try {
        const result = release();
        if (result?.status !== "committed" && cleanupCurrent(owned)) fault();
       } catch { if (cleanupCurrent(owned)) fault(); }
      }
     }
    }
    if (!eligible() || !live() || !canActivate(ctx) || !eligible() || !live()) { hide(); return; }
    owned = handle!;
    const result = owned.update(definitions.map(definition => ({definition, activation: "activate" as const})));
    if (result?.status !== "committed") { if (operationCurrent(owned, intent)) fault(); hide(); return; }
    if (!eligible() || !live() || handle !== owned || !canActivate(ctx) || !eligible() || !live()) { hide(); return; }
    visible = true;
   } catch { if (operationCurrent(owned, intent)) fault(); hide(); }
   finally { showing = false; }
  }, hide,
  isActive: () => visible && live(),
  dispose() { if (disposed) return; disposed = true; withdraw(true); },
 });
}
