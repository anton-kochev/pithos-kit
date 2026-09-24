const PACKAGE_NAME = "@pithos-kit/guild";

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type PithosLogLevel = "debug" | "info" | "warn" | "error" | "off";
export type PithosLogger = ReturnType<typeof createPithosLogger>;

const LEVELS: Record<PithosLogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
	off: Number.POSITIVE_INFINITY,
};
const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_LENGTH = 20;
const MAX_OBJECT_KEYS = 30;
const MAX_DEPTH = 4;
const SECRET_KEY_RE = /(api[-_]?key|authorization|bearer|cookie|credential|header|password|secret|(^|[-_])token($|[-_]))/iu;

export function createPithosLogger(packageName = PACKAGE_NAME, env: NodeJS.ProcessEnv = process.env) {
	const level = normalizeLevel(env.PITHOS_LOG_LEVEL);
	const file = resolveLogFile(packageName, env);
	const enabled = level !== "off" && file !== undefined;

	function write(levelName: Exclude<PithosLogLevel, "off">, event: string, metadata?: Record<string, unknown>): void {
		if (!enabled || LEVELS[levelName] < LEVELS[level]) return;
		const entry = JSON.stringify({
			timestamp: new Date().toISOString(),
			level: levelName,
			package: packageName,
			event,
			...(metadata ? { metadata: sanitize(metadata) } : {}),
		}) + "\n";
		void mkdir(dirname(file), { recursive: true })
			.then(() => appendFile(file, entry, "utf8"))
			.catch(() => undefined);
	}

	return {
		enabled,
		level,
		file,
		debug: (event: string, metadata?: Record<string, unknown>) => write("debug", event, metadata),
		info: (event: string, metadata?: Record<string, unknown>) => write("info", event, metadata),
		warn: (event: string, metadata?: Record<string, unknown>) => write("warn", event, metadata),
		error: (event: string, metadata?: Record<string, unknown>) => write("error", event, metadata),
	};
}

export function errorMetadata(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			...("code" in error ? { code: (error as { code?: unknown }).code } : {}),
		};
	}
	return { message: String(error) };
}

export function modelMetadata(model: unknown): Record<string, unknown> | undefined {
	if (!model || typeof model !== "object") return undefined;
	const record = model as Record<string, unknown>;
	return {
		...(typeof record.provider === "string" ? { provider: record.provider } : {}),
		...(typeof record.id === "string" ? { model: record.id } : {}),
		...(typeof record.api === "string" ? { api: record.api } : {}),
	};
}

export function usageMetadata(usage: unknown): Record<string, unknown> | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const record = usage as Record<string, unknown>;
	const inputTokens = numberField(record, "inputTokens") ?? numberField(record, "input");
	const outputTokens = numberField(record, "outputTokens") ?? numberField(record, "output");
	const cacheReadTokens = numberField(record, "cacheReadTokens") ?? numberField(record, "cacheRead");
	const cacheWriteTokens = numberField(record, "cacheWriteTokens") ?? numberField(record, "cacheWrite");
	const totalTokens = numberField(record, "totalTokens") ?? sumNumbers(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
	const costValue = record.cost;
	const costUsd = numberField(record, "costUsd") ?? numberField(record, "spendUsd") ?? numberField(record, "cost")
		?? (costValue && typeof costValue === "object" ? numberField(costValue as Record<string, unknown>, "total") : undefined);
	const turns = numberField(record, "turns");
	const normalized = {
		...(inputTokens !== undefined ? { inputTokens } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
		...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
		...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
		...(totalTokens !== undefined ? { totalTokens } : {}),
		...(costUsd !== undefined ? { costUsd } : {}),
		...(turns !== undefined ? { turns } : {}),
		...(typeof record.source === "string" ? { source: record.source } : {}),
		...(typeof record.estimated === "boolean" ? { estimated: record.estimated } : {}),
	};
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeLevel(value: unknown): PithosLogLevel {
	return value === "debug" || value === "info" || value === "warn" || value === "error" || value === "off" ? value : "off";
}

function resolveLogFile(packageName: string, env: NodeJS.ProcessEnv): string | undefined {
	if (env.PITHOS_LOG_FILE?.trim()) return resolve(env.PITHOS_LOG_FILE);
	if (!env.PITHOS_LOG_DIR?.trim()) return undefined;
	const fileName = packageName.replace(/^@pithos-kit\//u, "pithos-").replace(/[^a-z0-9.-]+/giu, "-");
	return resolve(env.PITHOS_LOG_DIR, `${fileName}.jsonl`);
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sumNumbers(...values: Array<number | undefined>): number | undefined {
	let total = 0;
	let seen = false;
	for (const value of values) {
		if (value === undefined) continue;
		total += value;
		seen = true;
	}
	return seen ? total : undefined;
}

function sanitize(value: unknown, depth = 0, key = ""): unknown {
	if (SECRET_KEY_RE.test(key)) return "[redacted]";
	if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "string") return boundString(value);
	if (value instanceof Error) return sanitize(errorMetadata(value), depth, key);
	if (depth >= MAX_DEPTH) return "[truncated]";
	if (Array.isArray(value)) {
		const items = value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitize(item, depth + 1));
		if (value.length > MAX_ARRAY_LENGTH) items.push(`[${value.length - MAX_ARRAY_LENGTH} more items]`);
		return items;
	}
	if (typeof value === "object") {
		const result: Record<string, unknown> = {};
		const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
		for (const [entryKey, entryValue] of entries) result[entryKey] = sanitize(entryValue, depth + 1, entryKey);
		const extra = Object.keys(value as Record<string, unknown>).length - entries.length;
		if (extra > 0) result.__truncatedKeys = extra;
		return result;
	}
	return String(value);
}

function boundString(value: string): string {
	if (value.length <= MAX_STRING_LENGTH) return value;
	return `${value.slice(0, MAX_STRING_LENGTH)}…[${value.length - MAX_STRING_LENGTH} more chars]`;
}
