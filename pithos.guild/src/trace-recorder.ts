import { channel } from "node:diagnostics_channel";
import * as fs from "node:fs";
import * as path from "node:path";
import { errorMetadata } from "./logging.ts";

// Opt-in local recorder for child Pi transcripts, which children otherwise never persist.
// Files hold raw repository content and stay private to the user; nothing leaves the machine.

const TRACE_CHANNEL = "pithos.guild.child";
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export interface GuildTraceBinding {
	sessionDir: string;
	sessionId: string;
	sessionFile?: string;
	model?: string;
	thinkingLevel?: string;
}

export interface GuildTraceRecorder {
	/** Correlates a run with its parent session; returns an idempotent unbind. */
	bind(runId: string, binding: GuildTraceBinding): () => void;
	dispose(): void;
}

export interface GuildTraceRecorderOptions {
	env?: NodeJS.ProcessEnv;
	log?: { warn(event: string, metadata?: Record<string, unknown>): void };
	maxBytes?: number;
	now?: () => number;
}

interface ChildTrace {
	fd?: number;
	bytes: number;
	truncated: boolean;
	failed: boolean;
	pending: Buffer;
}

export function createGuildTraceRecorder(options: GuildTraceRecorderOptions = {}): GuildTraceRecorder | undefined {
	if ((options.env ?? process.env).PITHOS_GUILD_TRACE !== "1") return undefined;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const now = options.now ?? Date.now;
	const bindings = new Map<string, GuildTraceBinding>();
	const traces = new Map<string, ChildTrace>();
	const telemetry = channel(TRACE_CHANNEL);

	const fail = (trace: ChildTrace, childId: string, error: unknown) => {
		if (trace.failed) return;
		trace.failed = true;
		close(trace);
		options.log?.warn("trace.error", { childId, error: errorMetadata(error) });
	};

	const write = (trace: ChildTrace, childId: string, record: Record<string, unknown>, force = false) => {
		if (trace.failed || trace.fd === undefined || (trace.truncated && !force)) return;
		const line = Buffer.from(`${JSON.stringify(record)}\n`);
		try {
			if (!force && trace.bytes + line.length > maxBytes) {
				trace.truncated = true;
				const marker = Buffer.from(`${JSON.stringify({ kind: "truncated", maxBytes })}\n`);
				fs.writeSync(trace.fd, marker);
				trace.bytes += marker.length;
				return;
			}
			fs.writeSync(trace.fd, line);
			trace.bytes += line.length;
		} catch (error) {
			fail(trace, childId, error);
		}
	};

	const writeStdoutLine = (trace: ChildTrace, childId: string, raw: Buffer) => {
		const text = raw.toString("utf8");
		if (!text.trim()) return;
		let event: unknown;
		try {
			event = JSON.parse(text);
		} catch {
			write(trace, childId, { kind: "stdout", text });
			return;
		}
		// Each update repeats the whole partial message; message_end keeps the finalized one.
		if ((event as { type?: unknown } | null)?.type === "message_update") return;
		write(trace, childId, { kind: "event", event });
	};

	const onMessage = (message: unknown) => {
		const observation = message as Record<string, any>;
		if (observation?.version !== 1 || typeof observation.childId !== "string" || typeof observation.runId !== "string") return;
		const { childId, runId } = observation;
		if (observation.type === "start") {
			const binding = bindings.get(runId);
			if (!binding || traces.has(childId)) return;
			const trace: ChildTrace = { bytes: 0, truncated: false, failed: false, pending: Buffer.alloc(0) };
			traces.set(childId, trace);
			try {
				const directory = path.join(binding.sessionDir, "guild", binding.sessionId);
				fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
				trace.fd = fs.openSync(path.join(directory, `${childId}.jsonl`), "wx", 0o600);
			} catch (error) {
				fail(trace, childId, error);
				return;
			}
			write(trace, childId, {
				kind: "header", version: 1, runId, childId, role: observation.role, profile: observation.profile,
				parentSessionId: binding.sessionId,
				...(binding.sessionFile ? { parentSessionFile: binding.sessionFile } : {}),
				...(binding.model ? { parentModel: binding.model } : {}),
				...(binding.thinkingLevel ? { thinkingLevel: binding.thinkingLevel } : {}),
				startedAt: now(),
			});
			return;
		}
		const trace = traces.get(childId);
		if (!trace) return;
		if (observation.type === "stdout" && typeof observation.base64 === "string") {
			let pending = Buffer.concat([trace.pending, Buffer.from(observation.base64, "base64")]);
			for (let newline = pending.indexOf(0x0a); newline !== -1; newline = pending.indexOf(0x0a)) {
				writeStdoutLine(trace, childId, pending.subarray(0, newline));
				pending = pending.subarray(newline + 1);
			}
			trace.pending = pending.length > maxBytes ? Buffer.alloc(0) : pending;
		} else if (observation.type === "stderr" && typeof observation.base64 === "string") {
			write(trace, childId, { kind: "stderr", text: Buffer.from(observation.base64, "base64").toString("utf8") });
		} else if (observation.type === "end") {
			if (trace.pending.length) writeStdoutLine(trace, childId, trace.pending);
			write(trace, childId, {
				kind: "end", exitCode: observation.exitCode ?? null, aborted: observation.aborted === true,
				selectedSkills: Array.isArray(observation.selectedSkills) ? observation.selectedSkills : [], endedAt: now(),
			}, true);
			close(trace);
			traces.delete(childId);
		}
	};

	telemetry.subscribe(onMessage);
	return {
		bind(runId, binding) {
			bindings.set(runId, { ...binding });
			return () => { bindings.delete(runId); };
		},
		dispose() {
			telemetry.unsubscribe(onMessage);
			for (const trace of traces.values()) close(trace);
			traces.clear();
			bindings.clear();
		},
	};
}

function close(trace: ChildTrace): void {
	if (trace.fd === undefined) return;
	try {
		fs.closeSync(trace.fd);
	} catch {
		// Already closed or unusable; the trace is finished either way.
	}
	trace.fd = undefined;
}
