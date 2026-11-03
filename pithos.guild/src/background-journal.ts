import type { BackgroundJournal } from "./background-ledger.ts";

interface JournalContext {
 readonly sessionManager: {
  getSessionId(): string;
  getBranch(): readonly {id: string}[];
  getEntries(): readonly unknown[];
 };
}
interface JournalAPI { appendEntry(customType: string, data?: unknown): void }
interface JournalOptions {
 /** Pure local read (no host calls/state changes). Caller rotates on session/branch transitions, not leaf appends. */
 getEpoch(): object;
 /** Pure local policy read; must not call the host or change session state. */
 isWritable?(): boolean;
 /** Host identity check; may trigger lifecycle changes that the final policy fence must detect. */
 isCurrentSession?(): boolean;
}

/** Session observation only: execution retirement does not invalidate this journal. */
export function createBackgroundJournal(pi: JournalAPI, ctx: JournalContext, options: JournalOptions): BackgroundJournal {
 const unavailable = () => new Error("Background journal unavailable");
 let manager: JournalContext["sessionManager"];
 let sessionId: string;
 let getEpoch: JournalOptions["getEpoch"];
 let isWritable: JournalOptions["isWritable"];
 let isCurrentSession: JournalOptions["isCurrentSession"];
 try {
  // Resolve option accessors before capturing SDK identity, never within a final fence.
  getEpoch = options.getEpoch;
  isWritable = options.isWritable;
  isCurrentSession = options.isCurrentSession;
  manager = ctx.sessionManager;
  sessionId = manager.getSessionId();
  if (typeof sessionId !== "string" || !sessionId) throw unavailable();
 } catch { throw unavailable(); }
 function check() {
  // Host policy can call out; check the SDK invalidation getter after it returns.
  if ((isCurrentSession && Reflect.apply(isCurrentSession, options, []) !== true)
   || ctx.sessionManager !== manager || manager.getSessionId() !== sessionId
   || ctx.sessionManager !== manager || reentered) throw unavailable();
 }
 let busy = false;
 let reentered = false;
 function epoch() {
  const value = Reflect.apply(getEpoch, options, []);
  if (!value || typeof value !== "object") throw unavailable();
  return value;
 }
 function writable() {
  const value = isWritable ? Reflect.apply(isWritable, options, []) : true;
  if (typeof value !== "boolean") throw unavailable();
  return value;
 }
 function fence(before: object, canWrite: boolean) {
  // Finish host callouts first, then attest with trusted local policy reads.
  // Arbitrary side effects in those reads cannot be fenced by an endless check loop.
  check();
  if (epoch() !== before || writable() !== canWrite || reentered) throw unavailable();
 }
 function guarded<T>(body: (epoch: object, writable: boolean) => T): T {
  if (busy) { reentered = true; throw unavailable(); }
  busy = true; reentered = false;
  try {
   check();
   const before = epoch();
   const canWrite = writable();
   check();
   if (epoch() !== before || reentered) throw unavailable();
   const result = body(before, canWrite);
   check();
   if (epoch() !== before || writable() !== canWrite || reentered) throw unavailable();
   fence(before, canWrite);
   return result;
  } catch { throw unavailable(); }
  finally { busy = false; }
 }
 return {
  scope() { return guarded((epoch, writable) => {
   const branchEntryIds = manager.getBranch().map(entry => entry.id);
   if (typeof sessionId !== "string" || !sessionId || branchEntryIds.some(id => typeof id !== "string" || !id)) throw unavailable();
   return {sessionId, branchEntryIds, epoch, writable};
  }); },
  entries() { return guarded(() => manager.getEntries()); },
  append(data) { guarded((before, canWrite) => {
   if (!canWrite) throw unavailable();
   const appendEntry = pi.appendEntry;
   if (typeof appendEntry !== "function") throw unavailable();
   fence(before, canWrite);
   Reflect.apply(appendEntry, pi, ["pithos.guild.background.v1", data]);
  }); },
 };
}
