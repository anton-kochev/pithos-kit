import assert from "node:assert/strict";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PLAN_EXTENSION_PATH = fileURLToPath(new URL("../extensions/plan-theme.ts", import.meta.url));
const QUEUED_CUSTOM_TYPE = "plan-custom-queue-regression";
const PLAN_CONTENT = "# Plan: Preserve custom continuation\n\n## Goal\nKeep Plan enforced for queued content.\n";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type TestAssistantMessage = {
	role: "assistant";
	content: Array<
		| { type: "text"; text: string }
		| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
	>;
	api: string;
	provider: string;
	model: string;
	usage: typeof EMPTY_USAGE;
	stopReason: "stop" | "toolUse";
	timestamp: number;
};

type ObservedContext = {
	systemPrompt?: string;
	messages: Array<{
		role: string;
		customType?: string;
		content?: unknown;
	}>;
	tools?: Array<{ name: string }>;
};

function assistantText(text: string): TestAssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "plan-test-api",
		provider: "plan-test-provider",
		model: "plan-test-model",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function assistantToolCall(
	id: string,
	name: string,
	arguments_: Record<string, unknown>,
): TestAssistantMessage {
	return {
		...assistantText(""),
		content: [{ type: "toolCall", id, name, arguments: arguments_ }],
		stopReason: "toolUse",
	};
}

function assistantToolCalls(
	calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): TestAssistantMessage {
	return {
		...assistantText(""),
		content: calls.map((call) => ({
			type: "toolCall" as const,
			id: call.id,
			name: call.name,
			arguments: call.arguments,
		})),
		stopReason: "toolUse",
	};
}

function responseStream(message: TestAssistantMessage) {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "done" as const, reason: message.stopReason, message };
		},
		async result() {
			return message;
		},
	};
}

function latestPlanState(sessionManager: SessionManager): Record<string, unknown> | undefined {
	return sessionManager.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "plan-theme-state")
		.at(-1)?.data as Record<string, unknown> | undefined;
}

async function lifecyclePrompt(session: Awaited<ReturnType<typeof createAgentSession>>["session"], text: string) {
	let unsubscribe = () => {};
	let timer: ReturnType<typeof setTimeout>;
	const settled = new Promise<void>((resolve, reject) => {
		timer = setTimeout(() => reject(new Error("Lifecycle dispatch did not settle")), 5000);
		unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_settled") resolve();
		});
	});
	try {
		await session.prompt(text);
		await settled;
	} finally {
		clearTimeout(timer!);
		unsubscribe();
	}
}

describe("Plan AgentSession queue integration", () => {
	it("delivers an invisible custom follow-up under Plan enforcement and converts exit completion to save", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-plan-agent-session-"));
		const agentDir = join(cwd, "agent");
		const queueExtensionPath = join(cwd, "queue-custom-message.mjs");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			queueExtensionPath,
			`export default function queueCustomMessage(pi) {
	pi.on("tool_result", (event) => {
		if (event.toolName !== "create_plan" || event.isError) return;
		pi.sendMessage({
			customType: ${JSON.stringify(QUEUED_CUSTOM_TYPE)},
			content: "Queued custom refinement",
			display: false,
		}, { deliverAs: "followUp", triggerTurn: true });
	});
}
`,
			"utf8",
		);

		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
		});
		let observedContinuationContext: ObservedContext | undefined;
		const responses: Array<
			| TestAssistantMessage
			| ((context: ObservedContext) => TestAssistantMessage)
		> = [
			assistantToolCall("checkpoint-call", "update_plan_draft", {
				content: PLAN_CONTENT,
				expectedRevision: 0,
			}),
			assistantText("Checkpoint recorded."),
			assistantToolCall("publish-call", "create_plan", { revision: 1 }),
			(context) => {
				observedContinuationContext = context;
				return assistantText("Processed queued custom refinement.");
			},
		];
		modelRuntime.registerProvider("plan-test-provider", {
			name: "Plan test provider",
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			api: "plan-test-api",
			models: [{
				id: "plan-test-model",
				name: "Plan test model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 4_096,
			}],
			streamSimple: (_model, context) => {
				const next = responses.shift();
				if (!next) throw new Error("No queued Plan integration response.");
				const message = typeof next === "function"
					? next(context as ObservedContext)
					: next;
				// The public coding-agent package does not re-export pi-ai's stream class;
				// this faithful stream implements the runtime protocol at that boundary.
				return responseStream(message) as never;
			},
		});
		const model = modelRuntime.getModel("plan-test-provider", "plan-test-model");
		assert.ok(model);

		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [queueExtensionPath, PLAN_EXTENSION_PATH],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Base test prompt.",
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			resourceLoader,
			sessionManager,
			settingsManager,
		});
		const extensionErrors: unknown[] = [];
		let abortCount = 0;
		let customMessageDelivered = false;
		let completedActionWhenCustomMessageDelivered: unknown;
		let toolsWhenCustomMessageDelivered: string[] = [];
		const unsubscribe = session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === QUEUED_CUSTOM_TYPE
			) {
				customMessageDelivered = true;
				const completedPublication = latestPlanState(sessionManager)?.completedPublication;
				completedActionWhenCustomMessageDelivered =
					typeof completedPublication === "object" && completedPublication !== null &&
					"action" in completedPublication
						? completedPublication.action
						: undefined;
				toolsWhenCustomMessageDelivered = session.getActiveToolNames();
			}
		});

		try {
			await session.bindExtensions({
				mode: "rpc",
				uiContext: {
					select: async (_title: string, choices: string[]) =>
						choices.find((choice) => choice === "Create plan"),
					confirm: async () => true,
					notify() {},
					setFooter() {},
					setStatus() {},
				} as never,
				onError: (error) => extensionErrors.push(error),
				abortHandler: () => {
					abortCount += 1;
					session.clearQueue();
					session.agent.abort();
				},
			});

			await session.prompt("/plan");
			assert.equal(latestPlanState(sessionManager)?.active, true);
			await session.prompt("Prepare an exact checkpoint.");
			assert.equal(latestPlanState(sessionManager)?.checkpointRevision, 1);

			await lifecyclePrompt(session, "/plan exit");

			assert.equal(customMessageDelivered, true);
			assert.equal(completedActionWhenCustomMessageDelivered, "save");
			assert.equal(abortCount, 0);
			assert.equal(responses.length, 0);
			assert.match(observedContinuationContext?.systemPrompt ?? "", /Read-only Plan mode is active/i);
			assert.match(
				JSON.stringify(observedContinuationContext?.messages ?? []),
				/Queued custom refinement/,
			);
			assert.equal(observedContinuationContext?.tools?.some((tool) => tool.name === "write"), false);
			assert.equal(observedContinuationContext?.tools?.some((tool) => tool.name === "create_plan"), true);
			assert.equal(toolsWhenCustomMessageDelivered.includes("write"), false);
			assert.equal(toolsWhenCustomMessageDelivered.includes("create_plan"), true);
			assert.equal(latestPlanState(sessionManager)?.active, true);
			assert.equal(latestPlanState(sessionManager)?.completedPublication, undefined);
			assert.equal(session.getActiveToolNames().includes("write"), false);
			assert.equal(session.getActiveToolNames().includes("create_plan"), true);
			assert.deepEqual(extensionErrors, []);
		} finally {
			unsubscribe();
			session.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	for (const action of ["save", "exit"] as const) it(`routes /plan ${action} before later input rewriting and publishes unchanged extension input`, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-plan-agent-session-"));
		const agentDir = join(cwd, "agent");
		const rewriterPath = join(cwd, "rewrite-input.mjs");
		const earlierInputPath = join(cwd, "earlier-input.mjs");
		await mkdir(agentDir, { recursive: true });
		await writeFile(earlierInputPath, `export default function(pi) { pi.on("input", async () => { await Promise.resolve(); }); }`);
		await writeFile(
			rewriterPath,
			`export default function rewrite(pi) {
 pi.on("input", (event) => {
  pi.appendEntry("rewriter-observation", { source: event.source, text: event.text });
  if (event.source === "extension") return { action: "continue" };
  return { action: "transform", text: "REWRITTEN: " + event.text };
 });
}
`,
			"utf8",
		);

		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
		});
		let publicationContext: ObservedContext | undefined;
		const responses: Array<
			| TestAssistantMessage
			| ((context: ObservedContext) => TestAssistantMessage)
		> = [
			assistantToolCall("checkpoint-call", "update_plan_draft", {
				content: PLAN_CONTENT,
				expectedRevision: 0,
			}),
			assistantText("Checkpoint recorded."),
			(context) => {
				publicationContext = context;
				return assistantToolCall("publish-call", "create_plan", { revision: 1 });
			},
			assistantText("Published."),
		];
		modelRuntime.registerProvider("plan-test-provider", {
			name: "Plan test provider",
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			api: "plan-test-api",
			models: [{
				id: "plan-test-model",
				name: "Plan test model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 4_096,
			}],
			streamSimple: (_model, context) => {
				const next = responses.shift();
				if (!next) throw new Error("No queued Plan integration response.");
				const message = typeof next === "function"
					? next(context as ObservedContext)
					: next;
				// The public coding-agent package does not re-export pi-ai's stream class;
				// this faithful stream implements the runtime protocol at that boundary.
				return responseStream(message) as never;
			},
		});
		const model = modelRuntime.getModel("plan-test-provider", "plan-test-model");
		assert.ok(model);

		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [earlierInputPath, PLAN_EXTENSION_PATH, rewriterPath],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Base test prompt.",
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			resourceLoader,
			sessionManager,
			settingsManager,
		});
		const extensionErrors: unknown[] = [];

		try {
			await session.bindExtensions({
				mode: "rpc",
				uiContext: {
					select: async (_title: string, choices: string[]) =>
						choices.find((choice) => choice === "Create plan"),
					confirm: async () => true,
					notify() {},
					setFooter() {},
					setStatus() {},
				} as never,
				onError: (error) => extensionErrors.push(error),
			});

			await session.prompt("/plan");
			assert.equal(latestPlanState(sessionManager)?.active, true);
			await session.prompt("Prepare an exact checkpoint.");
			assert.equal(latestPlanState(sessionManager)?.checkpointRevision, 1);

			await lifecyclePrompt(session, `/plan ${action}`);

			const observations = sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "rewriter-observation").map((entry) => entry.data as { source: string; text: string });
			assert.equal(observations.some((entry) => entry.text.startsWith("/plan")), false);
			const internal = observations.filter((entry) => entry.source === "extension");
			assert.equal(internal.length, 1);
			assert.match(internal[0].text, /^Finalize/);
			assert.equal(internal[0].text.includes("REWRITTEN"), false);
			assert.ok(observations.some((entry) => entry.source === "interactive" && entry.text === "Prepare an exact checkpoint."));
			const lastUser = publicationContext?.messages.filter((message) => message.role === "user").at(-1);
			assert.deepEqual(lastUser?.content, [{ type: "text", text: internal[0].text }]);
			const state = latestPlanState(sessionManager);
			assert.equal(state?.active, action === "save");
			assert.equal(typeof state?.publishedPath, "string");
			assert.equal(await readFile(join(cwd, state?.publishedPath as string), "utf8"), PLAN_CONTENT);

			assert.deepEqual(extensionErrors, []);
		} finally {
			session.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("blocks a checkpoint sibling after exit publication so no dirty revision is exited", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-plan-agent-session-sibling-"));
		const agentDir = join(cwd, "agent");
		await mkdir(agentDir, { recursive: true });
		const revisionOne = "# Plan: Sequential publication revision one\n\n## Goal\nPublish only this approved checkpoint.\n";
		const revisionTwo = "# Plan: Sequential publication revision two\n\n## Goal\nDo not exit with this unapproved checkpoint.\n";
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
		});
		const responses: TestAssistantMessage[] = [
			assistantToolCall("checkpoint-revision-1", "update_plan_draft", {
				content: revisionOne,
				expectedRevision: 0,
			}),
			assistantText("Checkpoint revision one recorded."),
			assistantToolCalls([
				{
					id: "publish-revision-1",
					name: "create_plan",
					arguments: { revision: 1 },
				},
				{
					id: "checkpoint-revision-2",
					name: "update_plan_draft",
					arguments: { content: revisionTwo, expectedRevision: 1 },
				},
			]),
			assistantText("Exit publication settled."),
		];
		modelRuntime.registerProvider("plan-test-provider", {
			name: "Plan test provider",
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			api: "plan-test-api",
			models: [{
				id: "plan-test-model",
				name: "Plan test model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 4_096,
			}],
			streamSimple: () => {
				const next = responses.shift();
				if (!next) throw new Error("No queued sequential Plan response.");
				return responseStream(next) as never;
			},
		});
		const model = modelRuntime.getModel("plan-test-provider", "plan-test-model");
		assert.ok(model);

		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [PLAN_EXTENSION_PATH],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Base test prompt.",
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			resourceLoader,
			sessionManager,
			settingsManager,
		});
		const extensionErrors: unknown[] = [];
		try {
			await session.bindExtensions({
				mode: "rpc",
				uiContext: {
					select: async (_title: string, choices: string[]) =>
						choices.find((choice) => choice === "Create plan"),
					confirm: async () => true,
					notify() {},
					setFooter() {},
					setStatus() {},
				} as never,
				onError: (error) => extensionErrors.push(error),
				abortHandler: () => {
					session.clearQueue();
					session.agent.abort();
				},
			});

			await session.prompt("/plan");
			await session.prompt("Prepare revision one for publication.");
			await lifecyclePrompt(session, "/plan exit");

			const blockedSibling = sessionManager.getEntries().find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === "checkpoint-revision-2",
			);
			assert.ok(blockedSibling?.type === "message" && blockedSibling.message.role === "toolResult");
			assert.equal(blockedSibling.message.isError, true);
			assert.match(JSON.stringify(blockedSibling.message.content), /settling/i);
			const successfulCheckpoints = sessionManager.getEntries().filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "update_plan_draft" &&
					!entry.message.isError,
			);
			assert.equal(successfulCheckpoints.length, 1);

			const finalState = latestPlanState(sessionManager);
			assert.equal(finalState?.active, false);
			assert.equal(finalState?.publicationState, "synced");
			assert.equal(finalState?.checkpointRevision, 1);
			assert.equal(finalState?.publishedRevision, 1);
			assert.equal(finalState?.completedPublication, undefined);
			assert.equal(responses.length, 0);
			assert.deepEqual(extensionErrors, []);
			assert.equal(typeof finalState?.publishedPath, "string");
			assert.equal(await readFile(join(cwd, finalState.publishedPath as string), "utf8"), revisionOne);
		} finally {
			session.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("allows a trusted read from a queued custom continuation after deferred exit without publication", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-plan-agent-session-deferred-exit-"));
		const agentDir = join(cwd, "agent");
		const queueExtensionPath = join(cwd, "queue-deferred-continuation.mjs");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(cwd, "README.md"), "trusted continuation read\n", "utf8");
		await writeFile(
			queueExtensionPath,
			`export default function queueDeferredContinuation(pi) {
	let queued = false;
	pi.on("message_end", (event) => {
		if (
			queued ||
			event.message.role !== "toolResult" ||
			event.message.toolName !== "create_plan" ||
			!event.message.isError
		) return;
		queued = true;
		pi.sendMessage({
			customType: ${JSON.stringify(QUEUED_CUSTOM_TYPE)},
			content: "Continue by reading the project under active Plan mode",
			display: false,
		}, { deliverAs: "steer", triggerTurn: true });
	});
}
`,
			"utf8",
		);

		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
		});
		const revisedContent = `${PLAN_CONTENT}\n## Revision\nKeep the queued continuation active.\n`;
		let observedContinuationContext: ObservedContext | undefined;
		const responses: Array<
			| TestAssistantMessage
			| ((context: ObservedContext) => TestAssistantMessage)
		> = [
			assistantToolCall("deferred-checkpoint-1", "update_plan_draft", {
				content: PLAN_CONTENT,
				expectedRevision: 0,
			}),
			assistantText("Initial checkpoint recorded."),
			assistantToolCall("deferred-checkpoint-2", "update_plan_draft", {
				content: revisedContent,
				expectedRevision: 1,
			}),
			assistantToolCall("deferred-publication", "create_plan", { revision: 2 }),
			(context) => {
				observedContinuationContext = context;
				return assistantToolCall("deferred-continuation-read", "read", { path: "README.md" });
			},
			assistantText("Queued continuation read completed."),
		];
		modelRuntime.registerProvider("plan-test-provider", {
			name: "Plan test provider",
			baseUrl: "http://localhost:0",
			apiKey: "test-key",
			api: "plan-test-api",
			models: [{
				id: "plan-test-model",
				name: "Plan test model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 4_096,
			}],
			streamSimple: (_model, context) => {
				const next = responses.shift();
				if (!next) throw new Error("No queued deferred-exit response.");
				const message = typeof next === "function"
					? next(context as ObservedContext)
					: next;
				return responseStream(message) as never;
			},
		});
		const model = modelRuntime.getModel("plan-test-provider", "plan-test-model");
		assert.ok(model);

		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [queueExtensionPath, PLAN_EXTENSION_PATH],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Base test prompt.",
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			resourceLoader,
			sessionManager,
			settingsManager,
		});
		const extensionErrors: unknown[] = [];
		let chooserCalls = 0;
		let customMessageDelivered = false;
		const unsubscribe = session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === QUEUED_CUSTOM_TYPE
			) {
				customMessageDelivered = true;
			}
		});

		try {
			await session.bindExtensions({
				mode: "rpc",
				uiContext: {
					select: async (_title: string, choices: string[]) => {
						chooserCalls += 1;
						return chooserCalls === 1
							? choices.find((choice) => choice === "Create plan")
							: choices.find((choice) => choice === "Exit without publishing");
					},
					confirm: async () => true,
					notify() {},
					setFooter() {},
					setStatus() {},
				} as never,
				onError: (error) => extensionErrors.push(error),
				abortHandler: () => {
					session.clearQueue();
					session.agent.abort();
				},
			});

			await session.prompt("/plan");
			await session.prompt("Prepare an exact checkpoint before exit.");
			await lifecyclePrompt(session, "/plan exit");

			const continuationRead = sessionManager.getEntries().find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === "deferred-continuation-read",
			);
			assert.ok(continuationRead?.type === "message" && continuationRead.message.role === "toolResult");
			assert.equal(continuationRead.message.isError, false);
			assert.match(JSON.stringify(continuationRead.message.content), /trusted continuation read/);
			assert.equal(customMessageDelivered, true);
			assert.equal(chooserCalls, 2);
			assert.match(observedContinuationContext?.systemPrompt ?? "", /Read-only Plan mode is active/i);
			assert.match(
				JSON.stringify(observedContinuationContext?.messages ?? []),
				/Continue by reading the project under active Plan mode/,
			);
			assert.equal(latestPlanState(sessionManager)?.active, true);
			assert.equal(latestPlanState(sessionManager)?.completedPublication, undefined);
			assert.equal(session.getActiveToolNames().includes("read"), true);
			assert.equal(session.getActiveToolNames().includes("write"), false);
			assert.equal(responses.length, 0);
			assert.deepEqual(extensionErrors, []);
		} finally {
			unsubscribe();
			session.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
