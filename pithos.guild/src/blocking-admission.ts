import { readPersistedPlanState, type BackgroundAdmissionContext } from "./background-admission.ts";
import type { GuildExecutionRuntime } from "./background-runtime.ts";
import type { GuildOwner } from "./execution-authority.ts";
import { discoverBlockingPlan, revalidatePlan, type CoordinationBus } from "./plan-coordination.ts";

/** Registration-owned synchronous transaction; commit must reserve on this stack. */
export function createBlockingAdmission(runtime: Pick<GuildExecutionRuntime, "isCurrent" | "planParticipant">, bus: CoordinationBus) {
 let checking = false;
 let reentered = false;
 return function admit<T>(owner: GuildOwner, capture: () => BackgroundAdmissionContext, commit: () => T): T {
  if (checking) { reentered = true; throw new Error("Reentrant blocking admission."); }
  checking = true;
  reentered = false;
  try {
   if (!runtime.isCurrent(owner)) throw new Error("Invalid or stale Guild owner.");
   const context = capture();
   const persisted = readPersistedPlanState(context);
   if (persisted !== "inactive") throw new Error("Persisted Plan state is not inactive.");
   const readiness = discoverBlockingPlan(bus, persisted, runtime.planParticipant);
   if (readiness.kind === "blocked") throw new Error(`Blocking admission blocked: ${readiness.reason}`);
   if (readPersistedPlanState(context) !== "inactive") throw new Error("Persisted Plan state is not inactive.");
   if (!revalidatePlan(readiness)) throw new Error("Plan provider changed before admission.");
   if (reentered) throw new Error("Reentrant blocking admission.");
   if (!runtime.isCurrent(owner)) throw new Error("Invalid or stale Guild owner.");
  } finally { checking = false; }
  // The trusted commit may synchronously start the queued operation, which checks again.
  return commit();
 };
}
