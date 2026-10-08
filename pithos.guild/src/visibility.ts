import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { GuildProfile, GuildRole } from "./agents";

export type GuildRunPhase = "queued" | "running";

interface ActiveGuildRunState {
	id: string;
	startedAt: number;
	turns?: number;
	task?: string;
}

export interface CanonicalActiveGuildRun extends ActiveGuildRunState {
	role: GuildRole;
	profile: GuildProfile;
	phase: GuildRunPhase;
	member?: string;
}

export interface LegacyActiveGuildRun extends ActiveGuildRunState {
	member: string;
	role?: GuildRole;
	profile?: never;
	phase?: GuildRunPhase;
}

export type ActiveGuildRun = CanonicalActiveGuildRun | LegacyActiveGuildRun;

interface TrackedGuildRun extends ActiveGuildRunState {
	identity: string;
	preview?: string;
	phase: GuildRunPhase;
}

export function taskPreview(task: string | undefined): string | undefined {
	if (!task) return undefined;
	const safe = stripTerminalSequences(task)
		.replace(/[\r\n\t]/g, " ")
		.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
		.replace(/\s+/g, " ").trim();
	return safe ? stripTerminalSequences(truncateToWidth(safe, 80, "…")) : undefined;
}

function elapsedTime(startedAt: number, now: number): string {
	let remainingSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
	const hours = Math.floor(remainingSeconds / 3600);
	remainingSeconds %= 3600;
	const minutes = Math.floor(remainingSeconds / 60);
	const seconds = remainingSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
	return parts.join(" ");
}

export class GuildRunTracker {
	private readonly runs = new Map<string, TrackedGuildRun>();

	get size(): number {
		return this.runs.size;
	}

	start(run: ActiveGuildRun): void {
		if (this.runs.has(run.id)) return;
		const identity = run.profile ? `${run.role}/${run.profile}` : run.member;
		this.runs.set(run.id, {
			id: run.id,
			identity,
			preview: taskPreview(run.task),
			phase: run.phase ?? "running",
			startedAt: run.startedAt,
			turns: run.turns,
		});
	}

	update(id: string, patch: { phase?: GuildRunPhase; turns?: number }): void {
		const current = this.runs.get(id);
		if (!current) return;
		this.runs.set(id, {
			...current,
			phase: patch.phase ?? current.phase,
			turns: patch.turns ?? current.turns,
		});
	}

	finish(id: string): void {
		this.runs.delete(id);
	}

	clear(): void {
		this.runs.clear();
	}

	formatLines(now = Date.now()): string[] {
		if (this.runs.size === 0) return [];
		const lines = [`Guild · ${this.runs.size} active`];
		for (const run of this.runs.values()) {
			const turns = run.turns ? ` · ${run.turns} turn${run.turns === 1 ? "" : "s"}` : "";
			lines.push(`⏳ ${run.identity} · ${run.phase} · ${elapsedTime(run.startedAt, now)}${turns}${run.preview ? ` · ${run.preview}` : ""}`);
		}
		return lines;
	}
}
