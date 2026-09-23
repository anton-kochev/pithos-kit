export type PlanModeState = "active" | "inactive" | "indeterminate";

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
