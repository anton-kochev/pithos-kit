export const DOCTOR_PHASES = ["config", "registry", "runtime"] as const;

export type DoctorPhase = (typeof DOCTOR_PHASES)[number];
export type DoctorPhaseStatus = "pending" | "complete" | "failed";

export interface DoctorPhaseTiming {
	status: DoctorPhaseStatus;
	elapsedMs?: number;
}

export interface DoctorTimingSnapshot {
	totalMs: number;
	phases: Record<DoctorPhase, DoctorPhaseTiming>;
}

const boundedMilliseconds = (value: number): number =>
	Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));

export class DoctorTimingTracker {
	readonly #startedAt: number;
	readonly #now: () => number;
	readonly #phases: Record<DoctorPhase, DoctorPhaseTiming> = {
		config: { status: "pending" },
		registry: { status: "pending" },
		runtime: { status: "pending" },
	};
	onUpdate?: (snapshot: DoctorTimingSnapshot) => void;

	constructor(now: () => number = () => performance.now()) {
		this.#now = now;
		this.#startedAt = now();
	}

	async measure<T>(phase: DoctorPhase, operation: () => Promise<T>): Promise<T> {
		const startedAt = this.#now();
		this.onUpdate?.(this.snapshot());
		try {
			const result = await operation();
			this.#phases[phase] = { status: "complete", elapsedMs: boundedMilliseconds(this.#now() - startedAt) };
			this.onUpdate?.(this.snapshot());
			return result;
		} catch (error) {
			this.#phases[phase] = { status: "failed", elapsedMs: boundedMilliseconds(this.#now() - startedAt) };
			this.onUpdate?.(this.snapshot());
			throw error;
		}
	}

	snapshot(): DoctorTimingSnapshot {
		return {
			totalMs: boundedMilliseconds(this.#now() - this.#startedAt),
			phases: {
				config: { ...this.#phases.config },
				registry: { ...this.#phases.registry },
				runtime: { ...this.#phases.runtime },
			},
		};
	}
}

function formatPhase(timing: DoctorPhaseTiming): string {
	if (timing.status === "pending") return "pending";
	const elapsed = `${timing.elapsedMs ?? 0}ms`;
	return timing.status === "failed" ? `failed ${elapsed}` : elapsed;
}

export function formatDoctorTiming(label: "Doctor timing" | "Doctor cancelled", timing: DoctorTimingSnapshot): string {
	return `${label}: total=${timing.totalMs}ms; ${DOCTOR_PHASES.map((phase) => `${phase}=${formatPhase(timing.phases[phase])}`).join("; ")}`;
}

export function formatDoctorProgress(timing: DoctorTimingSnapshot): string {
	const pending = DOCTOR_PHASES.filter((phase) => timing.phases[phase].status === "pending");
	const completed = DOCTOR_PHASES.length - pending.length;
	return pending.length > 0
		? `Diagnosing Pithos (${completed}/${DOCTOR_PHASES.length} complete): waiting for ${pending.join(", ")} · ${timing.totalMs}ms`
		: `Diagnosing Pithos (${completed}/${DOCTOR_PHASES.length} complete) · ${timing.totalMs}ms`;
}
