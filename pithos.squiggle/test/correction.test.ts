import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	correctWithModel,
	DEFAULT_CORRECTION_TIMEOUT_MS,
	MAX_CORRECTION_TIMEOUT_MS,
	MIN_CORRECTION_TIMEOUT_MS,
	normalizeTimeoutMs,
	type SquiggleConfig,
} from "../extensions/index.ts";

const model = { provider: "openai-codex", id: "gpt-5.4-mini", api: "openai-codex-responses" };
const usage = {
	input: 10,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const config: SquiggleConfig = {
	mode: "on",
	model: "openai-codex/gpt-5.4-mini",
	maxInputChars: 500,
	timeoutMs: DEFAULT_CORRECTION_TIMEOUT_MS,
};

function assistant(text: string, stopReason = "stop") {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		provider: model.provider,
		model: model.id,
		api: model.api,
		usage,
		timestamp: Date.now(),
	};
}

function createLogger() {
	const entries: Array<{ level: string; event: string; metadata?: Record<string, unknown> }> = [];
	const write = (level: string) => (event: string, metadata?: Record<string, unknown>) => {
		entries.push({ level, event, metadata });
	};
	return {
		entries,
		logger: {
			enabled: true,
			level: "debug",
			file: "/tmp/squiggle-test.log",
			debug: write("debug"),
			info: write("info"),
			warn: write("warn"),
			error: write("error"),
		},
	};
}

function createContext(getApiKeyAndHeaders = async (): Promise<unknown> => ({ ok: true, apiKey: "secret" })) {
	return {
		model: undefined,
		sessionManager: { getSessionId: () => "session-1" },
		modelRegistry: {
			find: () => model,
			getApiKeyAndHeaders,
		},
	};
}

describe("Squiggle correction deadline and cancellation", () => {
	it("never substitutes the coding model when the exact correction model is unavailable", async () => {
		const context = { ...createContext(), model, modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret" }),
		} };
		let calls = 0;
		const result = await correctWithModel("text", context as never, config, createLogger().logger as never, undefined,
			(async () => { calls++; return assistant("Changed"); }) as never);
		assert.equal(calls, 0);
		assert.equal(result, null);
	});
	it("accepts only bounded timeout configuration", () => {
		assert.equal(normalizeTimeoutMs(MIN_CORRECTION_TIMEOUT_MS), MIN_CORRECTION_TIMEOUT_MS);
		assert.equal(normalizeTimeoutMs(String(DEFAULT_CORRECTION_TIMEOUT_MS)), DEFAULT_CORRECTION_TIMEOUT_MS);
		assert.equal(normalizeTimeoutMs(MAX_CORRECTION_TIMEOUT_MS), MAX_CORRECTION_TIMEOUT_MS);
		for (const invalid of [undefined, 0, MIN_CORRECTION_TIMEOUT_MS - 1, MAX_CORRECTION_TIMEOUT_MS + 1, 1.5, "10s"]) {
			assert.equal(normalizeTimeoutMs(invalid), undefined);
		}
	});

	it("uses the configured model and auth, forwards a request signal, and completes normally", async () => {
		let receivedModel: unknown;
		let receivedOptions: { apiKey?: string; headers?: unknown; signal: AbortSignal } | undefined;
		const context = createContext(async () => ({ ok: true, apiKey: "secret", headers: { "x-test": "header" } }));
		const completePrompt = async (selectedModel: unknown, _context: unknown, options: { apiKey?: string; headers?: unknown; signal: AbortSignal }) => {
			receivedModel = selectedModel;
			receivedOptions = options;
			return assistant("Corrected prompt");
		};
		const { logger, entries } = createLogger();

		const result = await correctWithModel("Corected prompt", context as never, config, logger as never, undefined, completePrompt as never);

		assert.equal(result, "Corrected prompt");
		assert.equal(receivedModel, model);
		assert.equal(receivedOptions?.apiKey, "secret");
		assert.deepEqual(receivedOptions?.headers, { "x-test": "header" });
		assert.equal(receivedOptions?.signal.aborted, false);
		assert.equal(entries.at(-1)?.event, "model.correct.complete");
	});

	it("times out promptly when authentication or the provider ignores cancellation", async () => {
		for (const stage of ["authentication", "completion"] as const) {
			let receivedSignal: AbortSignal | undefined;
			const context = createContext(stage === "authentication"
				? async () => new Promise(() => undefined)
				: undefined);
			const completePrompt = async (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
				receivedSignal = options.signal;
				return new Promise(() => undefined);
			};
			const { logger, entries } = createLogger();

			const result = await correctWithModel(
				"Corected prompt",
				context as never,
				{ ...config, timeoutMs: 5 },
				logger as never,
				undefined,
				completePrompt as never,
			);

			assert.equal(result, null, stage);
			assert.equal(entries.at(-1)?.event, "model.correct.timeout", stage);
			if (stage === "completion") assert.equal(receivedSignal?.aborted, true);
		}
	});

	it("reports timeout when the provider honors the deadline abort", async () => {
		for (const outcome of ["resolve-aborted", "reject-aborted"] as const) {
			const context = createContext();
			const completePrompt = async (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => new Promise((resolve, reject) => {
				options.signal.addEventListener(
					"abort",
					() => outcome === "resolve-aborted"
						? resolve(assistant("Partial", "aborted"))
						: reject(new DOMException("aborted", "AbortError")),
					{ once: true },
				);
			});
			const { logger, entries } = createLogger();

			assert.equal(await correctWithModel(
				"Corected prompt",
				context as never,
				{ ...config, timeoutMs: 5 },
				logger as never,
				undefined,
				completePrompt as never,
			), null, outcome);
			assert.equal(entries.at(-1)?.event, "model.correct.timeout", outcome);
		}
	});

	it("handles pre-existing and in-flight external cancellation without waiting for the deadline", async () => {
		const preAborted = new AbortController();
		preAborted.abort();
		let authenticated = false;
		let logged = createLogger();
		assert.equal(await correctWithModel(
			"Corected prompt",
			createContext(async () => {
				authenticated = true;
				return { ok: true, apiKey: "secret" };
			}) as never,
			config,
			logged.logger as never,
			preAborted.signal,
		), null);
		assert.equal(authenticated, false);
		assert.equal(logged.entries.at(-1)?.event, "model.correct.cancelled");

		const controller = new AbortController();
		let receivedSignal: AbortSignal | undefined;
		let markCompletionStarted!: () => void;
		const completionStarted = new Promise<void>((resolve) => {
			markCompletionStarted = resolve;
		});
		logged = createLogger();
		const completePrompt = async (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
			receivedSignal = options.signal;
			markCompletionStarted();
			return new Promise(() => undefined);
		};
		const pending = correctWithModel(
			"Corected prompt",
			createContext() as never,
			config,
			logged.logger as never,
			controller.signal,
			completePrompt as never,
		);
		await completionStarted;
		controller.abort();

		assert.equal(await pending, null);
		assert.equal(receivedSignal?.aborted, true);
		assert.equal(logged.entries.at(-1)?.event, "model.correct.cancelled");
	});

	it("logs genuine request errors separately from cancellation and timeout", async () => {
		const { logger, entries } = createLogger();
		const result = await correctWithModel(
			"Corected prompt",
			createContext() as never,
			config,
			logger as never,
			undefined,
			(async () => { throw new Error("network down"); }) as never,
		);

		assert.equal(result, null);
		assert.equal(entries.at(-1)?.event, "model.correct.error");
		assert.deepEqual(entries.at(-1)?.metadata?.error, { name: "Error", message: "network down" });
	});

	it("preserves usage when the model returns an aborted response", async () => {
		const { logger, entries } = createLogger();
		const result = await correctWithModel(
			"Corected prompt",
			createContext() as never,
			config,
			logger as never,
			undefined,
			(async () => assistant("Partial", "aborted")) as never,
		);

		assert.equal(result, null);
		assert.equal(entries.at(-1)?.event, "model.correct.aborted");
		assert.deepEqual(entries.at(-1)?.metadata?.usage, {
			inputTokens: 10,
			outputTokens: 2,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 12,
			costUsd: 0,
		});
	});
});
