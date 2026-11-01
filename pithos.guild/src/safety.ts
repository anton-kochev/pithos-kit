import type { PlanBoundary } from "./plan-coordination.ts";

export type PlanModeState = "active" | "inactive" | "indeterminate";
export type PlanIntegrationMode = "required" | "standalone";

/**
 * Internal expectation mapping only, not readiness or handover admission.
 * Required means the caller requires Plan, not that inventory observed it;
 * standalone is an explicit trusted caller assertion of absence, never silence.
 * Background admission captures the parent-process policy at factory construction;
 * this mapping itself never supplies a default or establishes caller trust.
 * Positive cooperation still requires discoverPlan's versioned handshake.
 */
export function planBoundaryFor(mode: PlanIntegrationMode, persisted: PlanModeState): PlanBoundary {
	return {
		presence: mode === "required" ? "present" : mode === "standalone" ? "absent" : "unknown",
		persisted: persisted === "inactive" ? "inactive" : persisted === "active" ? "active" : "unknown",
	};
}

export function planModeState(entries: readonly unknown[]): PlanModeState {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (candidate.type !== "custom" || candidate.customType !== "plan-theme-state") continue;
		if (!candidate.data || typeof candidate.data !== "object") return "indeterminate";
		const active = (candidate.data as { active?: unknown }).active;
		return typeof active === "boolean" ? (active ? "active" : "inactive") : "indeterminate";
	}
	return "inactive";
}

export interface GuildHandoverAdmissionContext {
	readonly sessionManager: {
		getBranch(): readonly unknown[];
	};
	isProjectTrusted(): boolean;
}

export interface GuildHandoverAdmission {
	readonly projectTrusted: boolean;
}

export function admitGuildHandover(context: GuildHandoverAdmissionContext): GuildHandoverAdmission {
	const state = planModeState(context.sessionManager.getBranch());
	if (state !== "inactive") {
		throw new Error(`Guild handover is unavailable because Plan mode is ${state}.`);
	}
	return Object.freeze({ projectTrusted: context.isProjectTrusted() });
}
