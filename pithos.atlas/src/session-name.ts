import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPithosLogger, errorMetadata, modelMetadata, usageMetadata } from "./logging.ts";
import { isOfflineEnvironment } from "./registry.ts";

const EIGHTIES_WORDS = [
	"Neon",
	"Arcade",
	"Synth",
	"Laser",
	"Turbo",
	"Cassette",
	"Boombox",
	"Electric",
	"Cosmic",
	"Chrome",
	"Radical",
	"Midnight",
	"Vector",
	"Analog",
	"Dayglow",
	"Keytar",
	"Moonlit",
	"Airbrush",
	"Powerballad",
	"Rollerskate",
] as const;

const NINETIES_WORDS = [
	"Grunge",
	"Flannel",
	"Pager",
	"Dialup",
	"Sitcom",
	"Mallrat",
	"Boyband",
	"Pixel",
	"Skater",
	"Raver",
	"Cyber",
	"Zine",
	"Chatroom",
	"Plaid",
	"Britpop",
	"Mixtape",
	"Scrunchie",
	"Skatepark",
	"Altrock",
	"Slacker",
] as const;

const NOUGHTIES_WORDS = [
	"Reboot",
	"Playlist",
	"Ringtone",
	"Mashup",
	"Avatar",
	"Weblog",
	"Upload",
	"Remix",
	"Podcast",
	"Broadband",
	"Profile",
	"Download",
	"Dashboard",
	"Feed",
	"Viral",
	"Webcam",
	"Flashdrive",
	"Soundtrack",
	"Blogosphere",
	"Screensaver",
] as const;

export type SessionNameIndexPicker = (size: number) => number;

export interface SessionNameModel {
	provider: string;
	id: string;
	reasoning: boolean;
	input: readonly string[];
	maxTokens: number;
	cost: {
		input: number;
		output: number;
		tiers?: Array<{
			inputTokensAbove: number;
			input: number;
			output: number;
		}>;
	};
}

interface SessionNameCompletionTransport {
	(
		model: unknown,
		context: {
			systemPrompt: string;
			messages: Array<{
				role: "user";
				content: Array<{ type: "text"; text: string }>;
				timestamp: number;
			}>;
		},
		options: Record<string, unknown>,
	): Promise<{
		stopReason: string;
		content: Array<{ type: string; text?: string }>;
		usage?: unknown;
	}>;
}

export interface ScopedSessionNameModel {
	model: SessionNameModel;
}

const GENERATED_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+){2,4}$/u;
const MAX_GENERATED_NAME_LENGTH = 64;
const SESSION_NAME_TIMEOUT_MS = 10_000;
const randomIndex: SessionNameIndexPicker = (size) => randomInt(size);

const scheduleSessionNameTimeout = (callback: () => void, timeoutMs: number): (() => void) => {
	const timer = setTimeout(callback, timeoutMs);
	timer.unref();
	return () => clearTimeout(timer);
};

export function validateGeneratedSessionName(value: string): string | undefined {
	const name = value.trim();
	return name.length <= MAX_GENERATED_NAME_LENGTH && GENERATED_NAME_RE.test(name) ? name : undefined;
}

export async function completeSyntheticSessionName(
	model: SessionNameModel,
	auth: { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> },
	signal: AbortSignal,
	runCompletion: SessionNameCompletionTransport = complete as unknown as SessionNameCompletionTransport,
): Promise<SessionNameCompletionResult> {
	const response = await runCompletion(
		model,
		{
			systemPrompt: "You create synthetic session names inspired by pop culture.",
			messages: [{
				role: "user",
				content: [{
					type: "text",
					text: "Return exactly one synthetic name made of 3 to 5 lowercase ASCII words joined by single hyphens. Blend imagery associated with 1980s, 1990s, and 2000s pop culture without using direct franchise, celebrity, or character names. Return no quotes, Markdown, punctuation outside the hyphens, or explanation.",
				}],
				timestamp: Date.now(),
			}],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			maxTokens: 32,
			temperature: 1,
			signal,
			cacheRetention: "none",
			maxRetries: 0,
			timeoutMs: SESSION_NAME_TIMEOUT_MS,
		},
	);
	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
	return { text, stopReason: response.stopReason, ...(response.usage ? { usage: response.usage } : {}) };
}

function estimatedSessionNameCost(model: SessionNameModel): number {
	const rates = model.cost.tiers
		?.filter((tier) => 128 > tier.inputTokensAbove)
		.sort((left, right) => right.inputTokensAbove - left.inputTokensAbove)[0]
		?? model.cost;
	return rates.input * 128 + rates.output * 32;
}

export function selectSessionNameModel<T extends SessionNameModel>(
	availableModels: readonly T[],
	scopedModels: readonly ScopedSessionNameModel[],
): T | undefined {
	const scopedKeys = new Set(scopedModels.map(({ model }) => `${model.provider}/${model.id}`));
	return availableModels
		.filter((model) => scopedKeys.size === 0 || scopedKeys.has(`${model.provider}/${model.id}`))
		.filter((model) => !model.reasoning && model.input.includes("text") && model.maxTokens >= 32)
		.sort((left, right) => {
			return estimatedSessionNameCost(left) - estimatedSessionNameCost(right)
				|| `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`);
		})[0];
}

export function generateSessionName(pickIndex: SessionNameIndexPicker = randomIndex): string {
	return [
		EIGHTIES_WORDS[pickIndex(EIGHTIES_WORDS.length)],
		NINETIES_WORDS[pickIndex(NINETIES_WORDS.length)],
		NOUGHTIES_WORDS[pickIndex(NOUGHTIES_WORDS.length)],
	].join("-").toLowerCase();
}

export interface SessionNameCompletionResult {
	text: string;
	stopReason: string;
	usage?: unknown;
}

export interface SessionNamingDependencies {
	generateFallback?: () => string;
	pathExists?: (path: string) => boolean;
	isOffline?: () => boolean;
	complete?: (
		model: SessionNameModel,
		auth: { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> },
		signal: AbortSignal,
	) => Promise<SessionNameCompletionResult>;
	scheduleTimeout?: (callback: () => void, timeoutMs: number) => () => void;
}

export function registerSessionNaming(
	pi: ExtensionAPI,
	dependencies: SessionNamingDependencies = {},
): void {
	const generateFallback = dependencies.generateFallback ?? generateSessionName;
	const pathExists = dependencies.pathExists ?? existsSync;
	const isOffline = dependencies.isOffline ?? isOfflineEnvironment;
	const completeName = dependencies.complete ?? completeSyntheticSessionName;
	const scheduleTimeout = dependencies.scheduleTimeout ?? scheduleSessionNameTimeout;
	const log = createPithosLogger();
	type PendingAttempt = { controller: AbortController; cancelTimeout: () => void };
	let eligible = false;
	let attempted = false;
	let pending: PendingAttempt | undefined;

	const settle = (attempt: PendingAttempt, name: string): void => {
		if (pending !== attempt) return;
		pending = undefined;
		attempt.cancelTimeout();
		if (!pi.getSessionName()) pi.setSessionName(name);
	};

	const cancelPending = (): void => {
		const attempt = pending;
		if (!attempt) return;
		pending = undefined;
		attempt.cancelTimeout();
		attempt.controller.abort();
	};

	const settlePendingFallback = (): void => {
		const attempt = pending;
		if (!attempt) return;
		attempt.controller.abort();
		settle(attempt, generateFallback());
	};

	pi.on("session_info_changed", cancelPending);
	pi.on("session_shutdown", settlePendingFallback);

	pi.on("session_start", (event, ctx) => {
		attempted = false;
		eligible = false;
		if (pi.getSessionName()) return;
		let freshStartup = false;
		if (event.reason === "startup") {
			const sessionFile = ctx.sessionManager.getSessionFile();
			freshStartup = sessionFile === undefined || !pathExists(sessionFile);
		}
		eligible = event.reason === "new" || event.reason === "fork" || freshStartup;
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "user" || !eligible || attempted || pi.getSessionName() || pending) return;
		attempted = true;
		if (isOffline()) {
			log.info("session_name.fallback", { reason: "offline" });
			pi.setSessionName(generateFallback());
			return;
		}

		const attempt: PendingAttempt = {
			controller: new AbortController(),
			cancelTimeout: () => {},
		};
		pending = attempt;
		attempt.cancelTimeout = scheduleTimeout(() => {
			attempt.controller.abort();
			settle(attempt, generateFallback());
		}, SESSION_NAME_TIMEOUT_MS);
		void (async () => {
			const started = Date.now();
			try {
				const model = selectSessionNameModel(
					ctx.modelRegistry.getAvailable(),
					ctx.scopedModels,
				);
				if (!model) {
					log.info("session_name.fallback", { reason: "no_model" });
					settle(attempt, generateFallback());
					return;
				}
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (pending !== attempt || attempt.controller.signal.aborted) return;
				if (!auth.ok) {
					log.warn("session_name.auth_unavailable", { ...modelMetadata(model), error: auth.error });
					settle(attempt, generateFallback());
					return;
				}
				const result = await completeName(model, auth, attempt.controller.signal);
				const generated = result.stopReason === "stop"
					? validateGeneratedSessionName(result.text)
					: undefined;
				log.info("session_name.complete", { durationMs: Date.now() - started, ...modelMetadata(model), stopReason: result.stopReason, accepted: generated !== undefined, usage: usageMetadata(result.usage) });
				settle(attempt, generated ?? generateFallback());
			} catch (error) {
				log.warn("session_name.error", { durationMs: Date.now() - started, error: errorMetadata(error) });
				settle(attempt, generateFallback());
			}
		})();
	});
}
