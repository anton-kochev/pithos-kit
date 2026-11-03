import { BackgroundLedger, type BackgroundJournal, type LedgerIdentity, type Reservation, type CollectionResult } from "./background-ledger.ts";
import type { BackgroundTerminalResult } from "./background-result.ts";
import type { BackgroundSnapshot } from "./background-runs.ts";
import type { GuildBackgroundContext, GuildExecutionRuntime } from "./background-runtime.ts";
import type { GuildOwner } from "./execution-authority.ts";

export interface BackgroundSummary extends LedgerIdentity {
 status: BackgroundSnapshot["status"] | "interrupted";
 reportAvailable: boolean;
 interrupted: boolean;
 question?: BackgroundSnapshot["question"];
 usage?: BackgroundTerminalResult["usage"];
 usageKnown?: boolean;
}
export interface BackgroundSessionWait {
 reason: "terminal" | "question" | "timeout" | "aborted";
 runs: BackgroundSummary[];
 collection?: CollectionResult;
}
const unavailable = () => new Error("Background session unavailable");
function requireRunId(runId: string): void {
 if (typeof runId !== "string" || !runId.trim() || runId.includes("\0") || Buffer.byteLength(runId) > 256) throw unavailable();
}

/** Observation lifetime is the session, not any particular execution owner. */
export function createBackgroundSession({runtime, journal, onFault}: {
 runtime: GuildExecutionRuntime; journal: BackgroundJournal; onFault?: (reason: string) => unknown;
}) {
 // A collection's guard must also run after the ledger's own adapter reads,
 // not just before collect(): those reads can synchronously reenter the host.
 let claimFence: (() => void) | undefined;
 const ledger = new BackgroundLedger({
  scope() { const value = journal.scope(); claimFence?.(); return value; },
  entries() { const value = journal.entries(); claimFence?.(); return value; },
  append(data) { claimFence?.(); journal.append(data); claimFence?.(); },
 });
 ledger.restore();
 const owned = new Map<string, {owner: GuildOwner; identity: LedgerIdentity}>();
 let fault = false;
 let waiters = 0;
 function fail() {
  fault = true;
  // Notification must not join host retirement from inside terminal publication.
  try { void Promise.resolve(onFault?.("Background persistence fault")).catch(() => {}); } catch { /* Fault is already latched. */ }
 }
 function summary(identity: LedgerIdentity, report?: BackgroundTerminalResult, interrupted = false, live?: BackgroundSnapshot): BackgroundSummary {
  return {...identity, status: live?.status ?? report?.status ?? "interrupted", reportAvailable: !!report, interrupted,
   ...(live?.question ? {question: live.question} : {}),
   ...(report ? {usage: report.usage, usageKnown: report.usageKnown} : {})};
 }
 function bind(owner: GuildOwner) {
  function guard(context: GuildBackgroundContext) {
   const validate = context.validateCurrent, current = context.isContextCurrent;
   if (typeof validate !== "function" || typeof current !== "function") throw new Error("Required context guard pair missing");
   const final = () => {
    if (current.call(context) !== true || !runtime.isCurrent(owner)) throw unavailable();
   };
   if (!runtime.isCurrent(owner) || validate.call(context) !== true) throw unavailable();
   final();
   return {final, validate: () => validate.call(context), current: () => current.call(context)};
  }
  function summaries(runId?: string) {
   if (runId !== undefined) requireRunId(runId);
   const observations = ledger.list();
   if (runId && !observations.some(o => o.identity.runId === runId)) {
    const old = ledger.inspect(runId);
    if (!old?.report) throw unavailable();
    const scope = journal.scope();
    observations.push({identity: {sessionId: scope.sessionId, runId, taskId: old.report.taskId,
     role: old.report.role, profile: old.report.profile}, ...old});
   }
   const live = runtime.list(owner);
   return observations.filter(o => !runId || o.identity.runId === runId).slice(0, 16)
    .map(o => summary(o.identity, o.report, o.interrupted, live.find(r => r.id === o.identity.runId)));
  }
  return Object.freeze({
   start(input: unknown, context: GuildBackgroundContext, signal?: AbortSignal): BackgroundSummary {
    const check = guard(context);
    if (fault) throw unavailable();
    const scope = journal.scope();
    check.final();
    signal?.throwIfAborted();
    let reservation: {token: Reservation; identity: LedgerIdentity} | undefined;
    let committed = false;
    try {
     const getBranch = context.getBranch;
     const run = runtime.start(owner, input, {
      cwd: context.cwd, model: context.model, thinkingLevel: context.thinkingLevel, projectTrusted: context.projectTrusted,
      onEvent: context.onEvent, onUpdate: context.onUpdate,
      getBranch: () => getBranch.call(context), validateCurrent: check.validate,
      isContextCurrent: () => (committed || !signal?.aborted) && check.current(),
      observation: {
       capturedContext: {sessionId: scope.sessionId},
       reserve(admission) {
        signal?.throwIfAborted(); check.final();
        const identity = {sessionId: scope.sessionId, runId: admission.id, taskId: admission.taskId,
         role: admission.input.role, profile: admission.input.profile};
        const token = ledger.reserve(identity);
        reservation = {token, identity};
        signal?.throwIfAborted(); check.final();
        owned.set(admission.id, {owner, identity});
        return token;
       },
       onTerminal(observation) {
        try { ledger.observeTerminal(observation.token as Reservation, observation.result); }
        catch (error) { fail(); throw error; }
       },
      }});
     committed = true;
     check.final();
     return summary(owned.get(run.id)!.identity, undefined, false, run);
    } catch (error) {
     if (reservation && !committed) {
      const {token, identity} = reservation;
      // Synchronous start removes rejected pre-schedule records. Only absence
      // under the still-current owner proves no accepted child needs publication.
      if (runtime.isCurrent(owner) && !runtime.list(owner).some(r => r.id === identity.runId)) {
       owned.delete(identity.runId);
       const {sessionId: _sessionId, ...resultIdentity} = identity;
       try {
        ledger.observeTerminal(token, {...resultIdentity, status: "cancelled", exitCode: 130,
         usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0},
         usageKnown: false, usageFields: [], diagnostic: "Admission rejected before scheduling; execution is not resumed"});
       } catch { fail(); }
      } else if (!runtime.isCurrent(owner)) fail();
     }
     throw error;
    }
   },
   async send(context: GuildBackgroundContext, runId: string, message: string, questionId?: string) {
    const check = guard(context);
    requireRunId(runId);
    summaries(runId); check.final();
    if (fault || owned.get(runId)?.owner !== owner) throw unavailable();
    if (questionId !== undefined) {
     runtime.reply(owner, runId, questionId, message);
     check.final();
     return {disposition: "accepted-not-delivered" as const, questionId, updateId: undefined};
    }
    const result = await runtime.sendUpdate(owner, runId, message);
    check.final(); return result;
   },
   async cancel(context: GuildBackgroundContext, runId: string): Promise<BackgroundSummary> {
    const check = guard(context);
    requireRunId(runId);
    const initial = summaries(runId)[0];
    check.final();
    if (owned.get(runId)?.owner === owner && runtime.list(owner).some(r => r.id === runId)) {
     await runtime.cancel(owner, runId);
    } else if (!initial.reportAvailable && !initial.interrupted) throw unavailable();
    check.final();
    const result = summaries(runId)[0];
    check.final(); return result;
   },
   async wait(context: GuildBackgroundContext, runId: string, timeoutMs = 30_000,
    collection: {collectionId: string; toolCallId: string}, signal?: AbortSignal): Promise<BackgroundSessionWait> {
    const check = guard(context);
    requireRunId(runId);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw new RangeError("Invalid wait timeout");
    if (waiters >= 32) throw new Error("Background waiter capacity exceeded");
    waiters++;
    try {
     const initial = summaries(runId)[0];
     let reason: BackgroundSessionWait["reason"] = "terminal";
     // Publication precedes registry settlement. A durable report alone does not
     // permit a claim while the current owner's record still holds capacity.
     if (runtime.list(owner).some(r => r.id === runId) || !initial.reportAvailable && !initial.interrupted) {
      reason = (await runtime.wait(owner, runId, timeoutMs, signal)).reason;
     }
     check.final();
     const runs = reason === "question" ? summaries() : summaries(runId);
     check.final();
     if (signal?.aborted) return {reason: "aborted", runs};
     if (reason !== "terminal") return {reason, runs};
     if (fault) throw unavailable();
     const scope = journal.scope();
     signal?.throwIfAborted(); check.final();
     let result: CollectionResult;
     if (claimFence) throw unavailable();
     claimFence = () => { signal?.throwIfAborted(); check.final(); };
     try {
      result = ledger.collect({...collection, sessionId: scope.sessionId, epoch: scope.epoch,
       runId, taskId: runs[0].taskId});
     } catch (error) { fail(); throw error; }
     finally { claimFence = undefined; }
     check.final();
     if (result.kind !== "rejected") {
      if (runtime.list(owner).some(r => r.id === runId)) {
       runtime.collect(owner, runId); runtime.release(owner, runId);
      }
      owned.delete(runId);
     }
     if (result.kind !== "rejected" && result.report) {
      runs[0] = summary({sessionId: scope.sessionId, runId, taskId: result.report.taskId,
       role: result.report.role, profile: result.report.profile}, result.report);
     }
     check.final();
     return {reason, runs, collection: result};
    } finally { waiters--; }
   },
   status(context: GuildBackgroundContext, runId?: string): BackgroundSummary[] {
    const check = guard(context);
    const result = summaries(runId);
    check.final(); return result;
   },
  });
 }
 return Object.freeze({bind, inspect: (runId: string) => ledger.inspect(runId), list: () => ledger.list()});
}
