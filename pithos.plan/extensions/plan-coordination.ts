/** Internal v1 trusted-extension contract. Not a malicious-extension security boundary. */
export const PLAN_COORDINATION_CHANNEL = "pithos.plan.coordination";
export type PlanPhase = "initializing" | "inactive" | "entering" | "active" | "exiting" | "reconciling" | "blocked" | "disposed";
export interface PlanParticipant { readonly instance: object; tryAcquire(owner: object): unknown }
interface Hold { release(): unknown }
interface Entry { participant: PlanParticipant; hold?: Hold }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const synchronous = (value: unknown) => !object(value) || !("then" in value);

/**
 * Attachments last for this coordinator's lifetime: no detach can release protection.
 * Instance and generation objects are process-local capabilities, never persisted IDs.
 * Each acquisition gets a fresh owner identity so a stale release cannot affect renewal.
 * Busy/unavailable refusals are retryable; contract faults poison this instance permanently.
 * The owner, not this module, establishes that persisted state is truly inactive.
 */
export function createPlanCoordinator() {
 const instance = Object.freeze({});
 let generation = Object.freeze({});
 let phase: PlanPhase = "initializing";
 let operating = false;
 let poisoned = false;
 const participants = new Map<object, Entry>();
 const change = (next: PlanPhase) => {
  if (phase === "disposed") return { kind: "blocked" as const };
  phase = next; generation = Object.freeze({}); return { kind: "ok" as const };
 };
 const blocked = () => ({ kind: "blocked" as const });
 const fault = () => { poisoned = true; if (phase !== "disposed") change("blocked"); };
 function acquire(entry: Entry): boolean {
  try {
   const result = entry.participant.tryAcquire(Object.freeze({}));
   if (!object(result) || !synchronous(result)) throw Error("Not synchronous");
   if (result.kind === "busy" && Number.isSafeInteger(result.outstanding) && Number(result.outstanding) > 0) return false;
   if (result.kind === "unavailable" && typeof result.reason === "string" && result.reason.length) return false;
   if (result.kind !== "held" || !object(result.lease) || !synchronous(result.lease) || typeof result.lease.release !== "function") throw Error("Invalid hold");
   entry.hold = result.lease as unknown as Hold;
   return true;
  } catch { fault(); return false; }
 }
 function release(entry: Entry) {
  try {
   if (entry.hold && entry.hold.release() !== undefined) throw Error("Invalid synchronous release");
   entry.hold = undefined;
  } catch { fault(); }
 }
 function allowed() { return !operating && !poisoned && phase !== "disposed"; }
 function current(expected: unknown) { return allowed() && object(expected) && expected === generation; }
 const provider = Object.freeze({
  version: 1 as const, instance,
  // Participant callbacks can reenter discovery while acquisition/release is on-stack.
  inspect: () => Object.freeze({ instance, generation, phase: operating && phase === "inactive" ? "blocked" as const : phase }),
  attachParticipant(participant: PlanParticipant) {
   if (!allowed()) return blocked();
   operating = true;
   try {
    if (!object(participant) || !synchronous(participant) || !object(participant.instance) || typeof participant.tryAcquire !== "function") return blocked();
    const existing = participants.get(participant.instance);
    if (existing && existing.participant !== participant) return blocked();
    if (existing) return { kind: "attached" as const, instance, participant: participant.instance };
    const entry: Entry = { participant };
    if (phase !== "inactive" && !acquire(entry)) return blocked();
    participants.set(participant.instance, entry);
    if (poisoned) return blocked();
    return { kind: "attached" as const, instance, participant: participant.instance };
   } catch { fault(); return blocked(); }
   finally { operating = false; }
  },
 });
 return {
  provider,
  transition(expected: object, next: Exclude<PlanPhase, "inactive" | "disposed" | "initializing">) {
   if (!current(expected) || !["entering", "active", "exiting", "reconciling", "blocked"].includes(next)) return blocked();
   operating = true;
   try {
    const acquired: Entry[] = [];
    for (const entry of participants.values()) {
     if (entry.hold) continue;
     if (!acquire(entry)) {
      // Only retryable refusals may unwind; a fault must retain remaining protection.
      for (const prior of acquired) { if (poisoned || phase === "disposed") break; release(prior); }
      return blocked();
     }
     if (poisoned) return blocked();
     acquired.push(entry);
    }
    return change(next);
   } finally { operating = false; }
  },
  /** Caller must have completed tool/theme/state reconciliation before confirming. */
  confirmInactive(expected: object) {
   if (!current(expected)) return blocked();
   operating = true;
   try {
    for (const entry of participants.values()) { if (poisoned) break; release(entry); }
    return poisoned ? blocked() : change("inactive");
   } finally { operating = false; }
  },
  /** Fail closed: disposal deliberately retains holds; registry shutdown owns final cleanup. */
  dispose() { poisoned = true; change("disposed"); },
 };
}
