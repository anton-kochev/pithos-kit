import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// Repository-only report over real Pi sessions. Observational: it describes how Guild
// handovers behaved and what they cost, not whether main-only work would have been better.
// Unknown values stay undefined; they are never counted as zero.

const REWORK_ASSISTANT_TURNS = 5;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export interface HandoverTrace {
	file: string;
	rejectedSubmissions: number;
	exitCode?: number | null;
	truncated: boolean;
	/** Starting repository snapshot summary; complete snapshots can be replayed. */
	repoState?: { state?: string; head?: string; dirty?: boolean; complete?: boolean; error?: string };
}

export interface HandoverRecord {
	sessionId: string;
	file: string;
	startedAt: string;
	entry: "tool" | "direct";
	runId?: string;
	target: string;
	status: string;
	taskOutcome?: string;
	tdd?: string;
	durationMs?: number;
	turns?: number;
	childCost?: number;
	outputBytes?: number;
	/** Parent edited a path the coder reported changing, before the next user message. */
	rework?: boolean;
	trace?: HandoverTrace;
}

export interface ReportSummary {
	sessions: number;
	sessionsWithHandovers: number;
	handovers: number;
	byTarget: Record<string, number>;
	byEntry: Record<string, number>;
	byStatus: Record<string, number>;
	byTaskOutcome: Record<string, number>;
	byTdd: Record<string, number>;
	durationMs: { count: number; median?: number; p90?: number };
	/** Over sessions with handovers whose parent and child costs are all known. */
	cost: { parent?: number; child?: number; childShare?: number; includedSessions: number; excludedSessions: number };
	rework: { flagged: number; eligible: number };
	traces: { matched: number; rejectedSubmissions: number; replayable: number };
}

export interface SessionReport {
	handovers: HandoverRecord[];
	summary: ReportSummary;
}

export interface AnalyzeOptions {
	/** Inclusive lower bound compared against the session start timestamp, e.g. 2026-10-01. */
	since?: string;
}

type Json = Record<string, any>;

export function findSessionFiles(inputs: string[]): string[] {
	const files: string[] = [];
	const visit = (target: string) => {
		const stat = fs.statSync(target, { throwIfNoEntry: false });
		if (!stat) return;
		if (stat.isFile()) {
			if (target.endsWith(".jsonl")) files.push(target);
			return;
		}
		if (!stat.isDirectory()) return;
		for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
			// Child traces live under <session dir>/guild/ and are joined, not scanned as sessions.
			if (entry.isDirectory() && entry.name === "guild") continue;
			visit(path.join(target, entry.name));
		}
	};
	for (const input of inputs) visit(input);
	return files.sort();
}

export function analyzeSessions(files: string[], options: AnalyzeOptions = {}): SessionReport {
	const handovers: HandoverRecord[] = [];
	let sessions = 0;
	let sessionsWithHandovers = 0;
	let parentTotal = 0;
	let childTotal = 0;
	let includedSessions = 0;
	let excludedSessions = 0;

	for (const file of files) {
		const entries = readJsonl(file);
		const header = entries[0];
		if (header?.type !== "session" || typeof header.id !== "string") continue;
		const startedAt = typeof header.timestamp === "string" ? header.timestamp : "";
		if (options.since && startedAt < options.since) continue;
		sessions++;
		const session = analyzeSession(file, header, entries);
		if (!session.handovers.length) continue;
		sessionsWithHandovers++;
		handovers.push(...session.handovers);
		const childCosts = session.handovers.map(handover => handover.childCost);
		if (session.parentCost === undefined || childCosts.some(value => value === undefined)) {
			excludedSessions++;
			continue;
		}
		includedSessions++;
		parentTotal += session.parentCost;
		childTotal += childCosts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
	}

	const durations = handovers.map(handover => handover.durationMs).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
	const eligible = handovers.filter(handover => handover.rework !== undefined);
	const traced = handovers.filter(handover => handover.trace);
	const known = includedSessions > 0;
	return {
		handovers,
		summary: {
			sessions,
			sessionsWithHandovers,
			handovers: handovers.length,
			byTarget: countBy(handovers, handover => handover.target),
			byEntry: countBy(handovers, handover => handover.entry),
			byStatus: countBy(handovers, handover => handover.status),
			byTaskOutcome: countBy(handovers, handover => handover.taskOutcome),
			byTdd: countBy(handovers, handover => handover.tdd),
			durationMs: { count: durations.length, ...(durations.length ? { median: percentile(durations, 0.5), p90: percentile(durations, 0.9) } : {}) },
			cost: {
				...(known ? { parent: round(parentTotal), child: round(childTotal) } : {}),
				...(known && parentTotal + childTotal > 0 ? { childShare: childTotal / (parentTotal + childTotal) } : {}),
				includedSessions,
				excludedSessions,
			},
			rework: { flagged: eligible.filter(handover => handover.rework).length, eligible: eligible.length },
			traces: {
				matched: traced.length,
				rejectedSubmissions: traced.reduce((sum, handover) => sum + (handover.trace?.rejectedSubmissions ?? 0), 0),
				replayable: traced.filter(handover => handover.trace?.repoState?.complete === true && handover.trace.repoState.head).length,
			},
		},
	};
}

function analyzeSession(file: string, header: Json, entries: Json[]) {
	const cwd = typeof header.cwd === "string" ? header.cwd : path.dirname(file);
	const traces = readTraces(path.join(path.dirname(file), "guild", header.id));
	const callArguments = new Map<string, Json>();
	const handovers: HandoverRecord[] = [];
	const directRuns = new Set<string>();
	let parentCost: number | undefined = 0;

	const addCost = (usage: unknown, required: boolean) => {
		const total = (usage as Json | undefined)?.cost?.total;
		if (isCount(total)) parentCost = parentCost === undefined ? undefined : parentCost + total;
		else if (required) parentCost = undefined;
	};

	entries.forEach((entry, index) => {
		if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") addCost(entry.usage, entry.type === "usage");
		const message = entry.type === "message" ? entry.message : undefined;
		if (message?.role === "assistant") {
			addCost(message.usage, true);
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (part?.type === "toolCall" && typeof part.id === "string") callArguments.set(part.id, part.arguments ?? {});
			}
		}
		if (message?.role === "toolResult" && message.toolName === "guild_handover") {
			const details: Json = isRecord(message.details) ? message.details : {};
			const args = callArguments.get(message.toolCallId) ?? {};
			const piUsage = message.usage?.cost?.total;
			handovers.push(record({
				file, header, details, args, entry: "tool", runId: details.runId ?? message.toolCallId,
				status: TERMINAL.has(details.status) ? details.status : message.isError ? "failed" : "unknown",
				childCost: isCount(piUsage) ? piUsage : detailsCost(details),
				outputBytes: textBytes(message.content),
				rework: rework(details, entries, index, cwd),
				traces,
			}));
		}
		const custom = entry.type === "custom_message" ? entry : message?.role === "custom" ? message : undefined;
		if (custom?.customType === "guild-handover" && isRecord(custom.details) && TERMINAL.has(custom.details.status)) {
			const details = custom.details;
			const runId = typeof details.runId === "string" ? details.runId : undefined;
			if (runId && directRuns.has(runId)) return;
			if (runId) directRuns.add(runId);
			handovers.push(record({
				file, header, details, args: {}, entry: "direct", runId, status: details.status,
				childCost: detailsCost(details), outputBytes: textBytes(custom.content),
				rework: rework(details, entries, index, cwd), traces,
			}));
		}
	});
	return { handovers, parentCost };
}

function record(input: {
	file: string; header: Json; details: Json; args: Json; entry: "tool" | "direct"; runId?: string; status: string;
	childCost?: number; outputBytes?: number; rework?: boolean; traces: Map<string, HandoverTrace>;
}): HandoverRecord {
	const { details, args } = input;
	const role = details.role ?? args.role;
	const profile = details.profile ?? args.profile;
	const target = typeof role === "string" && typeof profile === "string" ? `${role}/${profile}` : String(details.member ?? args.member ?? "unknown");
	const tdd = Array.isArray(details.report?.compliance) ? details.report.compliance.find((item: Json) => item?.id === "tdd")?.status : undefined;
	const trace = input.runId ? input.traces.get(input.runId) : undefined;
	const turns = details.usage?.turns;
	return omitUndefined({
		sessionId: input.header.id,
		file: input.file,
		startedAt: input.header.timestamp,
		entry: input.entry,
		runId: input.runId,
		target,
		status: input.status,
		taskOutcome: typeof details.taskOutcome === "string" ? details.taskOutcome : undefined,
		tdd: typeof tdd === "string" ? tdd : undefined,
		durationMs: isCount(details.elapsedMs) ? details.elapsedMs : undefined,
		turns: isCount(turns) && turns > 0 ? turns : undefined,
		childCost: input.childCost,
		outputBytes: input.outputBytes,
		rework: input.rework,
		trace,
	});
}

/** Current details declare known fields; legacy details only prove usage by reporting turns. */
function detailsCost(details: Json): number | undefined {
	const usage = details.usage;
	if (!isCount(usage?.cost)) return undefined;
	if (details.usageKnown === false) return undefined;
	if (details.usageKnown === true) return Array.isArray(details.usageFields) && details.usageFields.includes("cost") ? usage.cost : undefined;
	return isCount(usage.turns) && usage.turns > 0 ? usage.cost : undefined;
}

function rework(details: Json, entries: Json[], index: number, cwd: string): boolean | undefined {
	const changes = details.status === "completed" ? details.report?.payload?.changes : undefined;
	if (!Array.isArray(changes) || !changes.length) return undefined;
	const changed = new Set(changes.map((change: Json) => change?.path).filter((value: unknown) => typeof value === "string").map((value: string) => path.resolve(cwd, value)));
	let assistantTurns = 0;
	for (const entry of entries.slice(index + 1)) {
		const message = entry.type === "message" ? entry.message : undefined;
		if (message?.role === "user") break;
		if (message?.role !== "assistant") continue;
		if (++assistantTurns > REWORK_ASSISTANT_TURNS) break;
		for (const part of Array.isArray(message.content) ? message.content : []) {
			if (part?.type !== "toolCall" || (part.name !== "edit" && part.name !== "write")) continue;
			const target = part.arguments?.path;
			if (typeof target === "string" && changed.has(path.resolve(cwd, target))) return true;
		}
	}
	return false;
}

function readTraces(directory: string): Map<string, HandoverTrace> {
	const traces = new Map<string, HandoverTrace>();
	let names: string[] = [];
	try {
		names = fs.readdirSync(directory).filter(name => name.endsWith(".jsonl"));
	} catch {
		return traces;
	}
	for (const name of names) {
		const file = path.join(directory, name);
		const records = readJsonl(file);
		const runId = records[0]?.kind === "header" ? records[0].runId : undefined;
		if (typeof runId !== "string") continue;
		const end = records.find(item => item.kind === "end");
		const repoState = isRecord(records[0].repoState) ? records[0].repoState : undefined;
		traces.set(runId, {
			file,
			rejectedSubmissions: records.filter(item => item.kind === "event" && item.event?.type === "tool_execution_end"
				&& item.event.toolName === "guild_submit_result" && item.event.isError === true).length,
			...(end ? { exitCode: end.exitCode ?? null } : {}),
			truncated: records.some(item => item.kind === "truncated"),
			...(repoState ? { repoState } : {}),
		});
	}
	return traces;
}

export function formatReport(report: SessionReport): string {
	const { summary } = report;
	const lines: string[] = [];
	const row = (label: string, value: unknown) => lines.push(`  ${label.padEnd(24)}${value}`);
	const section = (title: string, counts: Record<string, number>) => {
		const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
		if (!keys.length) return;
		lines.push("", title);
		for (const key of keys) row(key, counts[key]);
	};
	lines.push("Guild session report (observational; no main-only comparison)", "");
	row("Sessions", summary.sessions);
	row("With handovers", summary.sessionsWithHandovers);
	row("Handovers", summary.handovers);
	section("By target", summary.byTarget);
	section("By entry", summary.byEntry);
	section("By status", summary.byStatus);
	section("Task outcome", summary.byTaskOutcome);
	section("TDD compliance (child-reported)", summary.byTdd);
	lines.push("", "Duration");
	row("Measured", summary.durationMs.count);
	if (summary.durationMs.median !== undefined) row("Median / p90", `${seconds(summary.durationMs.median)} / ${seconds(summary.durationMs.p90!)}`);
	lines.push("", "Cost (sessions with all costs known)");
	row("Included / excluded", `${summary.cost.includedSessions} / ${summary.cost.excludedSessions}`);
	if (summary.cost.parent !== undefined) row("Parent", money(summary.cost.parent));
	if (summary.cost.child !== undefined) row("Children", money(summary.cost.child));
	if (summary.cost.childShare !== undefined) row("Child share", `${(summary.cost.childShare * 100).toFixed(1)}%`);
	lines.push("", "Signals");
	row("Possible rework", `${summary.rework.flagged} of ${summary.rework.eligible} coder reports with changes`);
	row("Traces matched", summary.traces.matched);
	row("Rejected submissions", `${summary.traces.rejectedSubmissions} (traced runs only)`);
	row("Replayable", `${summary.traces.replayable} (complete starting snapshot)`);
	return `${lines.join("\n")}\n`;
}

function readJsonl(file: string): Json[] {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const records: Json[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line);
			if (isRecord(value)) records.push(value);
		} catch {
			// Partial trailing lines from interrupted writes are skipped.
		}
	}
	return records;
}

function countBy<T>(items: T[], key: (item: T) => string | undefined): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const item of items) {
		const value = key(item);
		if (value !== undefined) counts[value] = (counts[value] ?? 0) + 1;
	}
	return counts;
}

function percentile(sorted: number[], fraction: number): number {
	return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function textBytes(content: unknown): number | undefined {
	if (typeof content === "string") return Buffer.byteLength(content);
	if (!Array.isArray(content)) return undefined;
	return content.reduce((sum, part) => sum + (part?.type === "text" && typeof part.text === "string" ? Buffer.byteLength(part.text) : 0), 0);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function omitUndefined<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function round(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

function money(value: number): string {
	return `$${value.toFixed(2)}`;
}

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function parseArguments(argv: string[]) {
	const paths: string[] = [];
	let since: string | undefined;
	let json = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--json") json = true;
		else if (arg === "--since") since = argv[++index];
		else if (arg === "--help" || arg === "-h") return undefined;
		else paths.push(arg);
	}
	if (since !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(since)) throw new Error("--since expects YYYY-MM-DD");
	return { paths, since, json };
}

function main(argv: string[]): number {
	const parsed = parseArguments(argv);
	if (!parsed) {
		process.stdout.write("Usage: npm run report -- [session files or directories] [--since YYYY-MM-DD] [--json]\n");
		return 0;
	}
	const defaultRoot = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "sessions");
	const report = analyzeSessions(findSessionFiles(parsed.paths.length ? parsed.paths : [defaultRoot]), { since: parsed.since });
	process.stdout.write(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
