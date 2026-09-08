import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import * as piRuntime from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPithosLogger, errorMetadata, modelMetadata, usageMetadata, type PithosLogger } from "./logging.ts";

// Older supported Pi releases do not export CONFIG_DIR_NAME.
const CONFIG_DIR_NAME = (piRuntime as { CONFIG_DIR_NAME?: string }).CONFIG_DIR_NAME ?? ".pi";

const SQUIGGLE_HELP = `Usage: /squiggle toggle
       /squiggle config

Toggle Squiggle on or off for the current session.
Configure an authenticated exact correction model for the project.
Model precedence: SQUIGGLE_MODEL > project > default.
Cancelling configuration makes no changes.

Options:
  --help, -h  Show this help`;

const SQUIGGLE_STATUS_HELP = `Usage: /squiggle-status

Show whether Squiggle is enabled and which correction model it uses.

Options:
  --help, -h  Show this help`;

export type SquiggleConfig = {
	mode: "on" | "off";
	model: string;
	modelScope?: "SQUIGGLE_MODEL" | "project" | "default";
	maxInputChars: number;
	timeoutMs: number;
};

export const DEFAULT_CORRECTION_TIMEOUT_MS = 10_000;
export const MIN_CORRECTION_TIMEOUT_MS = 1_000;
export const MAX_CORRECTION_TIMEOUT_MS = 60_000;

type CorrectPrompt = (
	input: string,
	ctx: ExtensionContext,
	config: SquiggleConfig,
	log?: PithosLogger,
	signal?: AbortSignal,
) => Promise<string | null>;

export function registerSquiggle(
	pi: ExtensionAPI,
	correctPrompt: CorrectPrompt = correctWithModel,
) {
	const log = createPithosLogger();
	log.info("extension.register");
	let runtimeMode: SquiggleConfig["mode"] | undefined;
	let correctionScope = new AbortController();
	const effectiveConfig = (cwd: string): SquiggleConfig => loadEffectiveConfig(cwd, runtimeMode);

	pi.on("session_start", async (event, ctx) => {
		correctionScope.abort();
		correctionScope = new AbortController();
		runtimeMode = restoreRuntimeMode(ctx);
		log.info("session.start", { reason: event.reason, sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), runtimeMode });
	});

	pi.on("session_shutdown", async () => {
		correctionScope.abort();
	});

	pi.registerCommand("squiggle", {
		description: "Toggle squiggle on/off or configure its correction model",
		getArgumentCompletions: (prefix) => ["toggle", "config", "--help"]
			.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			log.info("command.squiggle", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.(), args: args.trim() });
			if (isHelpRequest(args)) return emitHelp(ctx, SQUIGGLE_HELP);

			const command = args.trim().toLowerCase();
			if (command === "config") {
				const model = await chooseModel(ctx);
				if (!model) return;
				try {
					saveModel(join(ctx.cwd, CONFIG_DIR_NAME, "squiggle.json"), model);
				} catch {
					ctx.ui.notify("Could not save Squiggle configuration. Check the config file and its permissions.", "error");
					return;
				}
				const effective = effectiveConfig(ctx.cwd);
				ctx.ui.notify(`Saved ${model}. ${formatStatus(ctx, effective)}`,
					effective.model === model ? "info" : "warning");
				return;
			}
			if (command !== "toggle") {
				ctx.ui.notify("Usage: /squiggle toggle | config", "warning");
				return;
			}

			const config = loadEffectiveConfig(ctx.cwd, runtimeMode);
			runtimeMode = config.mode === "on" ? "off" : "on";
			if (runtimeMode === "off") {
				correctionScope.abort();
				correctionScope = new AbortController();
			}
			persistRuntimeMode(pi, runtimeMode);
			ctx.ui.notify(formatStatus(ctx, effectiveConfig(ctx.cwd)), "info");
		},
	});

	pi.registerCommand("squiggle-status", {
		description: "Show whether squiggle is loaded",
		handler: async (args, ctx) => {
			log.info("command.squiggle-status", { sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.() });
			if (isHelpRequest(args)) return emitHelp(ctx, SQUIGGLE_STATUS_HELP);
			ctx.ui.notify(formatStatus(ctx, effectiveConfig(ctx.cwd)), "info");
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };

		const config = effectiveConfig(ctx.cwd);
		if (config.mode === "off") return { action: "continue" };
		if (!event.text.trim()) return { action: "continue" };

		const stopIndicator = startSquiggleIndicator(ctx);
		const cancellationSignal = ctx.signal
			? AbortSignal.any([ctx.signal, correctionScope.signal])
			: correctionScope.signal;
		const corrected = await correctPrompt(event.text, ctx, config, log, cancellationSignal).finally(stopIndicator);
		if (!corrected || corrected === event.text) return { action: "continue" };

		if (ctx.hasUI) ctx.ui.notify(formatColoredDiff(event.text, corrected), "info");
		return { action: "transform", text: corrected };
	});
}

export default function squiggle(pi: ExtensionAPI): void {
	registerSquiggle(pi);
}

function isHelpRequest(args: string): boolean {
	const normalized = args.trim();
	return normalized === "--help" || normalized === "-h";
}

function emitHelp(ctx: ExtensionCommandContext, text: string): void {
	if (ctx.hasUI) ctx.ui.notify(text, "info");
	else console.log(text);
}

const CORRECTION_PROMPT = `You are a conservative grammar and spelling corrector for user prompts sent to a coding assistant.

Task:
- Correct spelling, grammar, capitalization, and punctuation.
- Preserve the user's meaning, tone, language, and intent.
- Do not answer the prompt.
- Do not add explanations, quotes, prefixes, markdown fences, or alternatives.
- If the input is already acceptable, return it unchanged.
- Return only the corrected prompt text.`;

const DEFAULT_CORRECTION_MODEL = "openai-codex/gpt-5.4-mini";
const DEFAULT_MAX_LLM_INPUT_CHARS = 500;

type CorrectionInterruption = "cancelled" | "timeout";

class CorrectionInterruptedError extends Error {
	readonly kind: CorrectionInterruption;

	constructor(kind: CorrectionInterruption, timeoutMs?: number) {
		super(kind === "timeout" ? `Correction timed out after ${formatDuration(timeoutMs!)}.` : "Correction cancelled.");
		this.kind = kind;
	}
}

export async function correctWithModel(
	input: string,
	ctx: ExtensionContext,
	config: SquiggleConfig,
	log = createPithosLogger(),
	signal?: AbortSignal,
	completePrompt: typeof complete = complete,
): Promise<string | null> {
	const model = selectCorrectionModel(ctx, config);
	if (!model) return null;
	if (input.length > config.maxInputChars) return null;

	const started = Date.now();
	const sessionId = (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.();
	log.info("model.correct.start", { sessionId, inputChars: input.length, timeoutMs: config.timeoutMs, ...modelMetadata(model) });

	if (signal?.aborted) {
		log.warn("model.correct.cancelled", { sessionId, durationMs: Date.now() - started, inputChars: input.length, ...modelMetadata(model) });
		return null;
	}

	const requestController = new AbortController();
	let interruptionKind: CorrectionInterruption | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let removeAbort: (() => void) | undefined;
	const interruption = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			interruptionKind = "timeout";
			requestController.abort();
			reject(new CorrectionInterruptedError("timeout", config.timeoutMs));
		}, config.timeoutMs);
		const onAbort = () => {
			if (interruptionKind) return;
			interruptionKind = "cancelled";
			requestController.abort();
			reject(new CorrectionInterruptedError("cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		removeAbort = () => signal?.removeEventListener("abort", onAbort);
	});

	try {
		const auth = await Promise.race([
			ctx.modelRegistry.getApiKeyAndHeaders(model),
			interruption,
		]);
		if (!auth.ok || !auth.apiKey) {
			log.warn("model.correct.unavailable", { sessionId, durationMs: Date.now() - started, inputChars: input.length, ...modelMetadata(model) });
			return null;
		}

		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: input }],
			timestamp: Date.now(),
		};

		const response = await Promise.race([
			completePrompt(
				model,
				{ systemPrompt: CORRECTION_PROMPT, messages: [userMessage] },
				{ apiKey: auth.apiKey, headers: auth.headers, signal: requestController.signal },
			),
			interruption,
		]);

		if (response.stopReason === "aborted") {
			const metadata = { sessionId, durationMs: Date.now() - started, inputChars: input.length, ...modelMetadata(model), usage: usageMetadata(response.usage) };
			if (interruptionKind === "timeout") {
				log.warn("model.correct.timeout", { ...metadata, timeoutMs: config.timeoutMs });
			} else if (interruptionKind === "cancelled" || signal?.aborted) {
				log.warn("model.correct.cancelled", metadata);
			} else {
				log.warn("model.correct.aborted", metadata);
			}
			return null;
		}

		const corrected = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
		log.info("model.correct.complete", { sessionId, durationMs: Date.now() - started, inputChars: input.length, changed: corrected !== input, ...modelMetadata(model), usage: usageMetadata(response.usage) });
		return corrected;
	} catch (error) {
		if (interruptionKind === "timeout" || (error instanceof CorrectionInterruptedError && error.kind === "timeout")) {
			log.warn("model.correct.timeout", { sessionId, durationMs: Date.now() - started, inputChars: input.length, timeoutMs: config.timeoutMs, ...modelMetadata(model) });
		} else if (interruptionKind === "cancelled" || signal?.aborted || error instanceof CorrectionInterruptedError || (error instanceof Error && error.name === "AbortError")) {
			log.warn("model.correct.cancelled", { sessionId, durationMs: Date.now() - started, inputChars: input.length, ...modelMetadata(model) });
		} else {
			log.warn("model.correct.error", { sessionId, durationMs: Date.now() - started, inputChars: input.length, ...modelMetadata(model), error: errorMetadata(error) });
		}
		return null;
	} finally {
		if (timer) clearTimeout(timer);
		removeAbort?.();
	}
}

function formatDuration(timeoutMs: number): string {
	return timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000}s` : `${timeoutMs}ms`;
}

function loadConfig(cwd: string): SquiggleConfig {
	const fileConfig = readConfigFile(cwd);
	return {
		mode: normalizeMode(process.env.SQUIGGLE_MODE ?? fileConfig.mode) ?? "on",
		model: process.env.SQUIGGLE_MODEL ?? fileConfig.model ?? DEFAULT_CORRECTION_MODEL,
		modelScope: process.env.SQUIGGLE_MODEL !== undefined ? "SQUIGGLE_MODEL" : fileConfig.model !== undefined ? "project" : "default",
		maxInputChars: normalizePositiveInt(process.env.SQUIGGLE_MAX_CHARS ?? fileConfig.maxInputChars) ?? DEFAULT_MAX_LLM_INPUT_CHARS,
		timeoutMs: normalizeTimeoutMs(process.env.SQUIGGLE_TIMEOUT_MS ?? fileConfig.timeoutMs) ?? DEFAULT_CORRECTION_TIMEOUT_MS,
	};
}

function loadEffectiveConfig(cwd: string, runtimeMode: SquiggleConfig["mode"] | undefined): SquiggleConfig {
	const config = loadConfig(cwd);
	return { ...config, mode: runtimeMode ?? config.mode };
}

function restoreRuntimeMode(ctx: ExtensionContext): SquiggleConfig["mode"] | undefined {
	for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== "squiggle-mode") continue;
		const data = (entry as { data?: { mode?: unknown } }).data;
		return normalizeMode(data?.mode);
	}
	return undefined;
}

function saveModel(path: string, model: string): void {
	const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
	if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("Invalid config");
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	mkdirSync(dirname(path), { recursive: true });
	try {
		writeFileSync(temporaryPath, `${JSON.stringify({ ...current, model }, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

async function chooseModel(ctx: ExtensionCommandContext): Promise<string | undefined> {
	if (!ctx.hasUI) {
		emitHelp(ctx, "Squiggle configuration requires an interactive UI.");
		return;
	}
	const models = ctx.modelRegistry.getAvailable()
		.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model))
		.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
	if (!models.length) {
		ctx.ui.notify("No authenticated correction models are available. Configure a provider with /login first.", "error");
		return;
	}
	const choices = models.map((model) => `${model.provider}/${model.id} — ${model.name}`);
	const selected = await ctx.ui.select("Exact correction model", choices);
	const model = models[choices.indexOf(selected ?? "")];
	return model ? `${model.provider}/${model.id}` : undefined;
}

function persistRuntimeMode(pi: ExtensionAPI, mode: SquiggleConfig["mode"]): void {
	pi.appendEntry("squiggle-mode", { mode });
}

function formatStatus(ctx: ExtensionContext, config: SquiggleConfig): string {
	const unavailable = selectCorrectionModel(ctx, config) ? "" : "; unavailable — run /squiggle config";
	const source = config.modelScope === "SQUIGGLE_MODEL" ? "; SQUIGGLE_MODEL" : "";
	return `squiggle is ${config.mode} (${config.model}${source}${unavailable}).`;
}

function readConfigFile(cwd: string): Partial<SquiggleConfig> {
	return readConfigPath(join(cwd, CONFIG_DIR_NAME, "squiggle.json"));
}

function readConfigPath(path: string): Partial<SquiggleConfig> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return {
			mode: typeof parsed.mode === "string" ? normalizeMode(parsed.mode) : undefined,
			model: typeof parsed.model === "string" ? parsed.model : undefined,
			maxInputChars: normalizePositiveInt(parsed.maxInputChars),
			timeoutMs: normalizeTimeoutMs(parsed.timeoutMs),
		};
	} catch {
		return {};
	}
}

function normalizeMode(value: unknown): SquiggleConfig["mode"] | undefined {
	return value === "on" || value === "off" ? value : undefined;
}

function normalizePositiveInt(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function normalizeTimeoutMs(value: unknown): number | undefined {
	const parsed = normalizePositiveInt(value);
	return parsed !== undefined && parsed >= MIN_CORRECTION_TIMEOUT_MS && parsed <= MAX_CORRECTION_TIMEOUT_MS
		? parsed
		: undefined;
}

function selectCorrectionModel(ctx: ExtensionContext, config: SquiggleConfig) {
	const configured = parseModelSpec(config.model);
	if (configured) {
		const model = ctx.modelRegistry.find(configured.provider, configured.model);
		if (model) return model;
	}
	return undefined;
}

function parseModelSpec(spec: string): { provider: string; model: string } | null {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) return null;
	return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

function startSquiggleIndicator(ctx: ExtensionContext): () => void {
	if (!ctx.hasUI) return () => {};

	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let frame = 0;
	let timer: ReturnType<typeof setInterval> | undefined;

	const render = () => {
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("squiggle", theme.fg("accent", frames[frame]!) + theme.fg("dim", " squiggling..."));
		frame = (frame + 1) % frames.length;
	};

	render();
	timer = setInterval(render, 120);

	return () => {
		if (timer) clearInterval(timer);
		ctx.ui.setStatus("squiggle", undefined);
	};
}

type DiffOp = {
	type: "same" | "add" | "remove";
	text: string;
};

function formatColoredDiff(before: string, after: string): string {
	const same = "\x1b[90;3m";
	const added = "\x1b[32;3m";
	const removed = "\x1b[31;3m";
	const reset = "\x1b[0m";

	return diffChars(before.trim(), after.trim())
		.map((op) => {
			if (op.type === "add") return `${added}${op.text}${reset}`;
			if (op.type === "remove") return `${removed}${op.text}${reset}`;
			return `${same}${op.text}${reset}`;
		})
		.join("");
}

function diffChars(before: string, after: string): DiffOp[] {
	const beforeChars = Array.from(before);
	const afterChars = Array.from(after);
	const rows = beforeChars.length + 1;
	const cols = afterChars.length + 1;
	const dp: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

	for (let i = beforeChars.length - 1; i >= 0; i--) {
		for (let j = afterChars.length - 1; j >= 0; j--) {
			dp[i]![j] = beforeChars[i] === afterChars[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
		}
	}

	const ops: DiffOp[] = [];
	let i = 0;
	let j = 0;
	while (i < beforeChars.length || j < afterChars.length) {
		if (i < beforeChars.length && j < afterChars.length && beforeChars[i] === afterChars[j]) {
			pushDiffOp(ops, "same", afterChars[j]!);
			i++;
			j++;
		} else if (j < afterChars.length && (i === beforeChars.length || dp[i]![j + 1]! > dp[i + 1]![j]!)) {
			pushDiffOp(ops, "add", afterChars[j]!);
			j++;
		} else if (i < beforeChars.length) {
			pushDiffOp(ops, "remove", beforeChars[i]!);
			i++;
		}
	}

	return ops;
}

function pushDiffOp(ops: DiffOp[], type: DiffOp["type"], text: string) {
	const last = ops.at(-1);
	if (last?.type === type) {
		last.text += text;
		return;
	}
	ops.push({ type, text });
}
