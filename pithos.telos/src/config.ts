import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type TelosConfig = { refreshIntervalMs: number; visibleTaskCount: number };

export const DEFAULT_VISIBLE_TASK_COUNT = 10;
export const DEFAULT_REFRESH_INTERVAL_MS = 1000;
export const CONFIG_CHECK_INTERVAL_MS = 1000;

export function configPath(cwd: string): string {
	return join(cwd, ".pi", "telos.json");
}

export async function loadTelosConfig(cwd: string): Promise<TelosConfig> {
	let text: string;
	try {
		text = await readFile(configPath(cwd), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS, visibleTaskCount: DEFAULT_VISIBLE_TASK_COUNT };
		}
		throw new Error("Unable to read Telos config");
	}
	return parseTelosConfig(text);
}

export function parseTelosConfig(text: string): TelosConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("Telos config must be valid JSON");
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("Telos config must be an object");
	}
	if (Object.keys(raw).some((key) => key !== "refreshIntervalMs" && key !== "visibleTaskCount")) {
		throw new Error("Telos config contains unknown settings");
	}
	const settings = raw as { refreshIntervalMs?: unknown; visibleTaskCount?: unknown };
	const interval = settings.refreshIntervalMs === undefined ? DEFAULT_REFRESH_INTERVAL_MS : settings.refreshIntervalMs;
	if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 250 || interval > 2147483647) {
		throw new Error("Telos config refreshIntervalMs must be an integer from 250 to 2147483647");
	}
	const count = settings.visibleTaskCount === undefined ? DEFAULT_VISIBLE_TASK_COUNT : settings.visibleTaskCount;
	if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
		throw new Error("Telos config visibleTaskCount must be a positive safe integer");
	}
	return { refreshIntervalMs: interval, visibleTaskCount: count };
}
