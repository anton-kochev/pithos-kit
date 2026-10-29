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
/**
 * A snapshot, NOT an admission grant. Rediscover/revalidate immediately before admission.
 * Handlers must reply on-stack, as their final synchronous operation. A void bus that
 * swallows handler errors cannot reveal a throw after a valid reply. Late replies are inert.
 * Supplying a participant attaches it before readiness; omitting it is inspection only.
 */
export function discoverPlan(bus: CoordinationBus, boundary: PlanBoundary, participant?: { readonly instance: object; tryAcquire(owner: object): unknown }): PlanReadiness {
 let open = true;
 const replies: unknown[] = [];
 try {
  bus.emit(PLAN_COORDINATION_CHANNEL, { version: 1, reply(value) { if (open) replies.push(value); } });
 } catch { return { kind: "blocked", reason: "Discovery failed." }; }
 finally { open = false; }
 // Provider state cannot establish caller-owned persistence or inventory/provenance.
 if (!object(boundary) || boundary.persisted !== "inactive") return { kind: "blocked", reason: "Persisted state is not inactive." };
 if (!replies.length && boundary.presence === "absent") return { kind: "ready" };
 if (replies.length !== 1 || boundary.presence !== "present") return { kind: "blocked", reason: "Expected one synchronous provider." };
 try {
  const provider = replies[0];
  if (!object(provider) || "then" in provider || provider.version !== 1 || !object(provider.instance) || typeof provider.inspect !== "function" || typeof provider.attachParticipant !== "function") throw Error();
  const state = provider.inspect();
  if (!object(state) || "then" in state || state.instance !== provider.instance || !object(state.generation) || state.phase !== "inactive") throw Error();
  if (participant) {
   const attached = provider.attachParticipant(participant);
   if (!object(attached) || "then" in attached || attached.kind !== "attached" || attached.instance !== provider.instance || attached.participant !== participant.instance) throw Error();
   const current = provider.inspect();
   if (!object(current) || "then" in current || current.instance !== state.instance || current.generation !== state.generation || current.phase !== "inactive") throw Error();
  }
  return { kind: "ready", provider: provider as unknown as PlanProvider, generation: state.generation };
 } catch { return { kind: "blocked", reason: "Provider is incompatible or not inactive." }; }
}
