import { types } from "node:util";

/** Kept structurally compatible with Plan without a runtime package dependency. */
export const PLAN_COORDINATION_CHANNEL = "pithos.plan.coordination";
export interface PlanProvider {
 readonly version: 1;
 readonly instance: object;
 inspect(): unknown;
 attachParticipant(participant: { readonly instance: object; tryAcquire(owner: object): unknown }): unknown;
}
export interface PlanBoundary {
 /** Supplied by a trusted caller; this module does not establish inventory/provenance. */
 presence: "absent" | "present" | "unknown";
 persisted: "inactive" | "active" | "unknown";
}
export interface CoordinationBus { emit(channel: string, request: { version: 1; reply(value: unknown): void }): void }
export type PlanReadiness = { kind: "ready"; provider?: PlanProvider; generation?: object } | { kind: "blocked"; reason: string };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
// Handshake fields must be own data, so final checks cannot execute caller getters.
function fields(value: unknown, keys: string[]): Record<string, unknown> {
 if (!object(value) || types.isProxy(value)) throw Error();
 const prototype = Object.getPrototypeOf(value);
 if ((prototype !== Object.prototype && prototype !== null) || "then" in value) throw Error();
 const result: Record<string, unknown> = {};
 for (const key of keys) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw Error();
  result[key] = descriptor.value;
 }
 return result;
}
function providerFields(value: unknown) {
 const data = fields(value, ["version", "instance", "inspect", "attachParticipant"]);
 if (data.version !== 1 || !object(data.instance) || typeof data.inspect !== "function" || typeof data.attachParticipant !== "function") throw Error();
 return data as { version: 1; instance: object; inspect: () => unknown; attachParticipant: (participant: unknown) => unknown };
}
function inactiveState(value: unknown, instance: object) {
 const data = fields(value, ["instance", "generation", "phase"]);
 if (data.instance !== instance || !object(data.generation) || data.phase !== "inactive") throw Error();
 return { instance, generation: data.generation };
}
const handshakes = new WeakMap<object, ReturnType<typeof providerFields>>();
/** Revalidate a discovery snapshot on-stack, without detaching coordinator protection. */
export function revalidatePlan(readiness: PlanReadiness): boolean {
 if (readiness.kind !== "ready") return false;
 if (!readiness.provider) return true;
 try {
  const original = handshakes.get(readiness);
  if (!original) return false;
  const matches = () => {
   const current = providerFields(readiness.provider);
   return current.instance === original.instance && current.inspect === original.inspect && current.attachParticipant === original.attachParticipant;
  };
  if (!matches()) return false;
  const state = inactiveState(original.inspect.call(readiness.provider), original.instance);
  return matches() && state.generation === readiness.generation;
 } catch { return false; }
}
/**
 * A snapshot, NOT an admission grant. Rediscover/revalidate immediately before admission.
 * Handlers must reply on-stack, as their final synchronous operation. A void bus that
 * swallows handler errors cannot reveal a throw after a valid reply. Late replies are inert.
 * Supplying a participant attaches it before readiness; omitting it is inspection only.
 */
export function discoverPlan(bus: CoordinationBus, boundary: PlanBoundary, participant?: { readonly instance: object; tryAcquire(owner: object): unknown }): PlanReadiness {
 return collectPlan(bus, boundary, participant);
}

/** Blocking-only compatibility: silence permits work, but does not prove Plan absence. */
export function discoverBlockingPlan(bus: CoordinationBus, persisted: unknown, participant: { readonly instance: object; tryAcquire(owner: object): unknown }): PlanReadiness {
 return collectPlan(bus, { persisted }, participant, "zero-or-one");
}

function collectPlan(bus: CoordinationBus, boundary: unknown, participant?: { readonly instance: object; tryAcquire(owner: object): unknown }, replyExpectation: "boundary" | "zero-or-one" = "boundary"): PlanReadiness {
 let open = true;
 const replies: unknown[] = [];
 try {
  bus.emit(PLAN_COORDINATION_CHANNEL, { version: 1, reply(value) { if (open) replies.push(value); } });
 } catch { return { kind: "blocked", reason: "Discovery failed." }; }
 finally { open = false; }
 // Provider state cannot establish caller-owned persistence or inventory/provenance.
 if (!object(boundary) || boundary.persisted !== "inactive") return { kind: "blocked", reason: "Persisted state is not inactive." };
 if (!replies.length && (replyExpectation === "zero-or-one" || boundary.presence === "absent")) return { kind: "ready" };
 if (replies.length !== 1 || (replyExpectation === "boundary" && boundary.presence !== "present")) return { kind: "blocked", reason: "Expected one synchronous provider." };
 try {
  const provider = replies[0];
  const data = providerFields(provider);
  const state = inactiveState(data.inspect.call(provider), data.instance);
  if (participant) {
   const attached = fields(data.attachParticipant.call(provider, participant), ["kind", "instance", "participant"]);
   if (attached.kind !== "attached" || attached.instance !== data.instance || attached.participant !== participant.instance) throw Error();
   const current = inactiveState(data.inspect.call(provider), data.instance);
   if (current.generation !== state.generation) throw Error();
  }
  const ready: PlanReadiness = { kind: "ready", provider: provider as PlanProvider, generation: state.generation };
  handshakes.set(ready, data);
  return ready;
 } catch { return { kind: "blocked", reason: "Provider is incompatible or not inactive." }; }
}
