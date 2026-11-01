import { types } from "node:util";
import { validateInput } from "./protocol.ts";
import type { BackgroundSnapshot, BackgroundContextArgs } from "./background-runs.ts";
import type { GuildExecutionAuthority, GuildOwner } from "./execution-authority.ts";
import { discoverPlan, revalidatePlan, type CoordinationBus } from "./plan-coordination.ts";
import { planBoundaryFor, planModeState, type PlanIntegrationMode } from "./safety.ts";

function copyFields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
 if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected canonical input.");
 const keys = Reflect.ownKeys(value);
 if (keys.some(key => typeof key !== "string" || !allowed.includes(key))) throw new Error("Invalid Guild object keys.");
 const copy: Record<string, unknown> = {};
 for (const key of keys as string[]) copy[key] = (value as Record<string, unknown>)[key];
 return copy;
}

// Persistence evidence only, never provider presence or work admission.
// Copy only fields used by the existing scanner; message bodies may be large or opaque.
export function readPersistedPlanState(context: BackgroundAdmissionContext) {
 const own = (value: object, key: PropertyKey): unknown => {
  if (types.isProxy(value)) throw new Error("Unsafe persisted Plan state.");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !("value" in descriptor)) throw new Error("Unsafe persisted Plan state.");
  return descriptor?.value;
 };
 const record = (value: object) => {
  if (types.isProxy(value)) throw new Error("Unsafe persisted Plan state.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Unsafe persisted Plan state.");
  if (Object.getOwnPropertyDescriptor(value, "then")) throw new Error("Unsafe persisted Plan state.");
 };
 const branch = context.getBranch();
 if (!Array.isArray(branch) || types.isProxy(branch) || Object.getPrototypeOf(branch) !== Array.prototype || Object.getOwnPropertyDescriptor(branch, "then")) throw new Error("Unsafe persisted Plan branch.");
 const snapshot: unknown[] = [];
 for (let index = 0; index < branch.length; index++) {
  const entry = own(branch, String(index));
  if (!entry || typeof entry !== "object") continue;
  record(entry);
  if (own(entry, "type") !== "custom" || own(entry, "customType") !== "plan-theme-state") continue;
  const data = own(entry, "data");
  if (!data || typeof data !== "object") throw new Error("Unsafe persisted Plan state.");
  record(data);
  snapshot.push({ type: "custom", customType: "plan-theme-state", data: { active: own(data, "active") } });
 }
 return planModeState(snapshot);
}

export interface BackgroundAdmissionContext { getBranch(): readonly unknown[] }
export function createGuildBackgroundAdmission<C = undefined>({ authority, bus, parentEnvironment = process.env, captureGuard }: {
 authority: GuildExecutionAuthority<C>;
 bus: CoordinationBus;
 parentEnvironment?: { readonly PITHOS_GUILD_PLAN_MODE?: unknown };
 /** Private composition latch; supply an own-data object, never caller context. */
 captureGuard?: { reentered: boolean };
}) {
 let mode: PlanIntegrationMode | undefined;
 try {
  const value = parentEnvironment.PITHOS_GUILD_PLAN_MODE;
  if (value === undefined || value === "required") mode = "required";
  else if (value === "standalone") mode = "standalone";
 } catch { /* Invalid parent configuration blocks background only. */ }
 let starting = false;
 let reentered = false;
 return Object.freeze({
  start(owner: GuildOwner, input: unknown, context: BackgroundAdmissionContext, ...binding: BackgroundContextArgs<C>): BackgroundSnapshot {
   if (starting) { reentered = true; throw new Error("Reentrant background admission."); }
   starting = true;
   reentered = false;
   try {
    if (!authority.isCurrent(owner)) throw new Error("Invalid or stale Guild owner.");
    if (!mode) throw new Error("Invalid background Plan configuration.");
    const copy = copyFields(input, ["role", "profile", "task", "practices"]);
    if (Array.isArray(copy.practices)) {
     const practices = copy.practices;
     const length = practices.length;
     if (length > 1) throw new Error("Invalid Guild practices.");
     copy.practices = length ? [copyFields(practices[0], ["id", "policy"])] : [];
    }
    const canonical = validateInput(copy);
    if (canonical.role !== "coder" && canonical.role !== "reviewer") throw new Error("Unsupported background role.");
    const readiness = discoverPlan(bus, planBoundaryFor(mode, readPersistedPlanState(context)), authority.planParticipant);
    if (readiness.kind === "blocked") throw new Error(`Background admission blocked: ${readiness.reason}`);
    if (readPersistedPlanState(context) !== "inactive") throw new Error("Persisted Plan state is not inactive.");
    if (!revalidatePlan(readiness)) throw new Error("Plan provider changed before admission.");
    if (reentered || captureGuard?.reentered) throw new Error("Reentrant background admission.");
    if (!authority.isCurrent(owner)) throw new Error("Invalid or stale Guild owner.");
    return authority.start(owner, canonical, ...binding);
   } finally { starting = false; }
  },
 });
}
