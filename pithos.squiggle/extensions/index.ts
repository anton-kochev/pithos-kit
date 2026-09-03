import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SQUIGGLE_HELP = `Usage: /squiggle toggle

Toggle Squiggle on or off for the current session.

Options:
  --help, -h  Show this help`;

const SQUIGGLE_STATUS_HELP = `Usage: /squiggle-status

Show whether Squiggle is enabled and which correction model it uses.

Options:
  --help, -h  Show this help`;

export function registerSquiggle(
	pi: ExtensionAPI,
	correctPrompt: (input: string, ctx: ExtensionContext, config: SquiggleConfig) => Promise<string | null> = correctWithModel,
) {
	let runtimeMode: SquiggleConfig["mode"] | undefined;

	pi.on("session_start", async (_event, ctx) => {
		runtimeMode = restoreRuntimeMode(ctx);
	});

	pi.registerCommand("squiggle", {
		description: "Toggle squiggle on/off",
		handler: async (args, ctx) => {
			if (isHelpRequest(args)) return emitHelp(ctx, SQUIGGLE_HELP);

			const command = args.trim().toLowerCase();
			if (command !== "toggle") {
				ctx.ui.notify("Usage: /squiggle toggle", "warning");
				return;
			}

			const config = loadEffectiveConfig(ctx.cwd, runtimeMode);
			runtimeMode = config.mode === "on" ? "off" : "on";
			persistRuntimeMode(pi, runtimeMode);
			ctx.ui.notify(formatStatus(ctx, loadEffectiveConfig(ctx.cwd, runtimeMode)), "info");
		},
	});

	pi.registerCommand("squiggle-status", {
		description: "Show whether squiggle is loaded",
		handler: async (args, ctx) => {
			if (isHelpRequest(args)) return emitHelp(ctx, SQUIGGLE_STATUS_HELP);
			ctx.ui.notify(formatStatus(ctx, loadEffectiveConfig(ctx.cwd, runtimeMode)), "info");
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };

		const config = loadEffectiveConfig(ctx.cwd, runtimeMode);
		if (config.mode === "off") return { action: "continue" };
		if (!event.text.trim()) return { action: "continue" };

		const stopIndicator = startSquiggleIndicator(ctx);
		const corrected = await correctPrompt(event.text, ctx, config).finally(stopIndicator);
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

type SquiggleConfig = {
	mode: "on" | "off";
	model: string;
	maxInputChars: number;
};

async function correctWithModel(input: string, ctx: ExtensionContext, config: SquiggleConfig): Promise<string | null> {
	const model = selectCorrectionModel(ctx, config);
	if (!model) return null;
	if (input.length > config.maxInputChars) return null;

	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return null;

		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: input }],
			timestamp: Date.now(),
		};

		const response = await complete(
			model,
			{ systemPrompt: CORRECTION_PROMPT, messages: [userMessage] },
			{ apiKey: auth.apiKey, headers: auth.headers },
		);

		if (response.stopReason === "aborted") return null;

		return response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
	} catch {
		return null;
	}
}

function loadConfig(cwd: string): SquiggleConfig {
	const fileConfig = readConfigFile(cwd);
	return {
		mode: normalizeMode(process.env.SQUIGGLE_MODE ?? fileConfig.mode) ?? "on",
		model: process.env.SQUIGGLE_MODEL ?? fileConfig.model ?? DEFAULT_CORRECTION_MODEL,
		maxInputChars: normalizePositiveInt(process.env.SQUIGGLE_MAX_CHARS ?? fileConfig.maxInputChars) ?? DEFAULT_MAX_LLM_INPUT_CHARS,
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

function persistRuntimeMode(pi: ExtensionAPI, mode: SquiggleConfig["mode"]): void {
	pi.appendEntry("squiggle-mode", { mode });
}

function formatStatus(ctx: ExtensionContext, config: SquiggleConfig): string {
	return `squiggle is ${config.mode} (${formatModel(selectCorrectionModel(ctx, config))}).`;
}

function readConfigFile(cwd: string): Partial<SquiggleConfig> {
	const path = join(cwd, ".pi", "squiggle.json");
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return {
			mode: typeof parsed.mode === "string" ? normalizeMode(parsed.mode) : undefined,
			model: typeof parsed.model === "string" ? parsed.model : undefined,
			maxInputChars: normalizePositiveInt(parsed.maxInputChars),
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

function selectCorrectionModel(ctx: ExtensionContext, config: SquiggleConfig) {
	const configured = parseModelSpec(config.model);
	if (configured) {
		const model = ctx.modelRegistry.find(configured.provider, configured.model);
		if (model) return model;
	}
	return ctx.model;
}

function parseModelSpec(spec: string): { provider: string; model: string } | null {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) return null;
	return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

function formatModel(model: ReturnType<typeof selectCorrectionModel>): string {
	return model ? `${model.provider}/${model.id}` : "no model";
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
