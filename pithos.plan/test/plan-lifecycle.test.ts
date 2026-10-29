import assert from "node:assert/strict";
import { createEventBus, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	generatePlanPath,
	resolveAvailablePlanPath,
	PlanPublicationConflictError,
	verifyPlanFileDigest,
} from "../extensions/plan-files.ts";
import type { PlanNameCompletionTransport } from "../extensions/plan-session-name.ts";
import { createRequire } from "node:module";
// Guild uses parameter properties; load its test-only boundary with its own runner.
const guildRequire = createRequire(new URL("../../pithos.guild/package.json", import.meta.url));
const { tsImport } = await import(guildRequire.resolve("tsx/esm/api"));
const { BackgroundRunRegistry } = await tsImport("../../pithos.guild/src/background-runs.ts", import.meta.url);
import { discoverPlan } from "../../pithos.guild/src/plan-coordination.ts";
import planTheme from "../extensions/plan-theme.ts";
import { commandHarness } from "./command-harness.ts";

const PLAN_EXTENSION_PATH = fileURLToPath(new URL("../extensions/plan-theme.ts", import.meta.url));

type Entry = Record<string, any>;

function parentLinkedBranch(entries: Entry[], leaf: Entry | undefined = entries.at(-1)): Entry[] {
	const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: Entry[] = [];
	const seen = new Set<string>();
	let current = leaf;
	while (current) {
		if (typeof current.id !== "string" || seen.has(current.id)) {
			throw new Error("Test session entries must form an acyclic parent-linked branch.");
		}
		seen.add(current.id);
		branch.push(current);
		current = typeof current.parentId === "string" ? entriesById.get(current.parentId) : undefined;
	}
	return branch.reverse();
}

function builtin(name: string, pathFormat: "legacy" | "current" = "legacy") {
	return {
		name,
		description: name,
		parameters: {},
		promptGuidelines: [],
		sourceInfo: {
			source: "builtin",
			path: pathFormat === "legacy" ? `<builtin:${name}>` : `builtin:${name}`,
			scope: "user",
			origin: "top-level",
		},
	};
}

function createHarness(options: {
	cwd: string;
	builtinPathFormat?: "legacy" | "current";
	sessionId?: string;
	sessionFile?: string;
	entries?: Entry[];
	branch?: Entry[];
	hasUI?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	confirm?: (
		title: string,
		message: string,
		options?: { signal?: AbortSignal },
	) => Promise<boolean>;
	select?: (
		title: string,
		choices: string[],
		options?: { signal?: AbortSignal },
	) => Promise<string | undefined>;
	signal?: AbortSignal;
	hasPendingMessages?: () => boolean;
	isIdle?: () => boolean;
	sessionName?: string;
	namingCompletion?: PlanNameCompletionTransport;
	verifyPlanFileDigest?: typeof verifyPlanFileDigest;
	generatePlanPath?: typeof generatePlanPath;
	resolveAvailablePlanPath?: typeof resolveAvailablePlanPath;
	setSessionName?: (name: string) => void;
	setActiveTools?: () => void;
	appendEntry?: () => void;
	afterAppendEntry?: () => void;
}): any {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
	const allEntries = options.entries ?? [];
	let branchEntries = options.branch ?? allEntries;
	const appended: Entry[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const allTools: any[] = ["read", "grep", "find", "ls", "write", "edit", "bash"]
		.map((name) => builtin(name, options.builtinPathFormat));
	let activeTools = allTools.map((tool) => tool.name);
	const registeredTools = new Map<string, any>();
	let sessionName = options.sessionName;
	const sessionNameChanges: string[] = [];
	const themeChanges: string[] = [];
	let abortCount = 0;
	let nextEntry = allEntries.length + 1;
	const currentParentId = () => {
		const leaf = branchEntries.at(-1);
		return typeof leaf?.id === "string" ? leaf.id : null;
	};
	const appendSessionInfo = (name: string) => {
		const entry = {
			type: "session_info", id: `entry-${nextEntry++}`, parentId: currentParentId(),
			timestamp: new Date().toISOString(), name,
		};
		allEntries.push(entry);
		if (branchEntries !== allEntries) branchEntries.push(entry);
		sessionName = name;
	};
	if (sessionName !== undefined) appendSessionInfo(sessionName);
	const routing = commandHarness(handlers);
	const pi = {
		events: createEventBus(),
		registerCommand: routing.registerCommand,
		sendUserMessage: routing.sendUserMessage,
		on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
			handlers.set(name, name === "before_agent_start" ? routing.wrapStart(handler) : handler);
		},
		appendEntry(customType: string, data: unknown) {
			options.appendEntry?.();
			const entry = {
				type: "custom",
				id: `entry-${nextEntry++}`,
				parentId: currentParentId(),
				timestamp: new Date().toISOString(),
				customType,
				data,
			};
			allEntries.push(entry);
			if (branchEntries !== allEntries) branchEntries.push(entry);
			appended.push(entry);
			// Pi 1.4 emits entry_appended only after appendCustomEntry advances the
			// leaf and persists synchronously. Reentrant observers must see that entry;
			// appendEntry above remains a separate pre-write failure injector.
			options.afterAppendEntry?.();
		},
		sendMessage() {},
		getActiveTools: () => [...activeTools],
		getAllTools: () => allTools,
		setActiveTools(names: string[]) {
			activeTools = [...names];
			options.setActiveTools?.();
		},
		registerTool(tool: any) {
			registeredTools.set(tool.name, tool);
			allTools.push({
				...tool,
				sourceInfo: { source: "package", path: PLAN_EXTENSION_PATH, scope: "user", origin: "package" },
			});
		},
		setSessionName(name: string) {
			options.setSessionName?.(name);
			appendSessionInfo(name);
			sessionNameChanges.push(name);
		},
		getSessionName: () => sessionName,
	};
	const uiTheme = {
		name: "dark",
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
		underline: (text: string) => text,
		fg: (_color: string, text: string) => text,
	};
	const ctx = {
		cwd: options.cwd,
		mode: options.mode ?? "rpc",
		hasUI: options.hasUI ?? true,
		signal: options.signal,
	scopedModels: [],
	modelRegistry: {
		getAvailable: () => [{ provider: "test", id: "cheap", reasoning: false, input: ["text"], maxTokens: 128, cost: { input: 0, output: 0 } }],
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "mock-key" }),
	},
		isIdle: options.isIdle ?? (() => true),
		// Exercise Pi 0.83's live ExtensionContext queue contract without synthesizing an input event.
		hasPendingMessages: options.hasPendingMessages ?? (() => false),
		abort() {
			abortCount += 1;
		},
		sessionManager: {
			getSessionId: () => options.sessionId ?? "session-a",
			getSessionFile: () => options.sessionFile ?? join(options.cwd, "session.jsonl"),
			getEntries: () => allEntries,
			getBranch: () => branchEntries,
		},
		ui: {
			theme: uiTheme,
			addAutocompleteProvider() {},
			getTheme: (name: string) => ({ name }),
			setTheme: (theme: { name?: string }) => {
				if (theme.name) {
					uiTheme.name = theme.name;
					themeChanges.push(theme.name);
				}
				return { success: true };
			},
			setFooter() {},
			setStatus() {},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			confirm: options.confirm ?? (async () => false),
			select: options.select ?? (async () => undefined),
		},
	};
	planTheme(pi as never, {
		verifyPlanFileDigest: options.verifyPlanFileDigest,
		generatePlanPath: options.generatePlanPath,
		resolveAvailablePlanPath: options.resolveAvailablePlanPath,
		namingCompletion: options.namingCompletion ?? (async () => { throw new Error("mock: naming unavailable"); }),
	} as never);
	return {
		routing,
		events: pi.events,
		handlers,
		ctx,
		allEntries,
		appended,
		notifications,
		registeredTools,
		getActiveTools: () => activeTools,
		setActiveTools: pi.setActiveTools,
		setBranch(entries: Entry[]) {
			branchEntries = entries;
		},
		getSessionName: () => sessionName,
		rename(name: string) {
			appendSessionInfo(name);
			return handlers.get("session_info_changed")?.({ type: "session_info_changed", name }, ctx);
		},
		sessionNameChanges,
		getThemeName: () => uiTheme.name,
		themeChanges,
		getAbortCount: () => abortCount,
		recordToolResult(toolName: string, details: unknown, isError = false) {
			const entry = {
				type: "message",
				id: `entry-${nextEntry++}`,
				parentId: currentParentId(),
				timestamp: new Date().toISOString(),
				message: { role: "toolResult", toolName, details, isError },
			};
			allEntries.push(entry);
			if (branchEntries !== allEntries) branchEntries.push(entry);
			return entry;
		},
	};
}

async function occupyFileMutationQueue(absolutePath: string): Promise<{
	release: () => void;
	done: Promise<void>;
}> {
	const started = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const done = withFileMutationQueue(absolutePath, async () => {
		started.resolve();
		await gate.promise;
	});
	await started.promise;
	return { release: gate.resolve, done };
}

async function assertOperationWaitsForQueue(operation: Promise<unknown>): Promise<void> {
	const status = await Promise.race([
		operation.then(
			() => "settled" as const,
			() => "settled" as const,
		),
		new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 50)),
	]);
	assert.equal(status, "waiting");
}

async function assertOperationSettlesPromptly<T>(operation: Promise<T>): Promise<T> {
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		const outcome = await Promise.race([
			operation.then((value) => ({ status: "settled" as const, value })),
			new Promise<{ status: "timeout" }>((resolve) => {
				timeoutHandle = setTimeout(() => resolve({ status: "timeout" }), 250);
			}),
		]);
		assert.equal(outcome.status, "settled", "The signal-aware UI operation remained pending after supersession.");
		if (outcome.status !== "settled") throw new Error("Unreachable timeout result.");
		return outcome.value;
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}

async function withHarness(
	options: Omit<Parameters<typeof createHarness>[0], "cwd">,
	run: (harness: ReturnType<typeof createHarness>) => Promise<void>,
): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-plan-lifecycle-"));
	try {
		await run(createHarness({ cwd, ...options }));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

async function input(
	harness: ReturnType<typeof createHarness>,
	text: string,
	streamingBehavior?: "steer" | "followUp",
) {
	return inputWithContext(harness, harness.ctx, text, streamingBehavior);
}

async function inputWithContext(
	harness: ReturnType<typeof createHarness>,
	ctx: any,
	text: string,
	streamingBehavior?: "steer" | "followUp",
) {
	return harness.routing.route(ctx, text, streamingBehavior);
}

function createReplacementContext(
	harness: ReturnType<typeof createHarness>,
	sessionId: string,
): any {
	const current = harness.ctx;
	const cwd = current.cwd;
	return {
		...current,
		sessionManager: {
			...current.sessionManager,
			getSessionId: () => sessionId,
			getSessionFile: () => join(cwd, `${sessionId}.jsonl`),
		},
		ui: { ...current.ui },
	};
}

function makeContextStale(ctx: any): string[] {
	const accesses: string[] = [];
	for (const property of [
		"cwd",
		"mode",
		"hasUI",
		"signal",
		"isIdle",
		"hasPendingMessages",
		"sessionManager",
		"ui",
	] as const) {
		Object.defineProperty(ctx, property, {
			configurable: true,
			get() {
				accesses.push(property);
				throw new Error(`Stale context access: ${property}`);
			},
		});
	}
	return accesses;
}

async function checkpointPlan(
	harness: ReturnType<typeof createHarness>,
	content: string,
	expectedRevision: number,
) {
	const result = await harness.registeredTools.get("update_plan_draft").execute(
		`checkpoint-${expectedRevision + 1}`,
		{ content, expectedRevision },
		undefined,
		undefined,
		harness.ctx,
	);
	harness.recordToolResult("update_plan_draft", result.details);
	return result;
}

async function startLifecycleCommand(
	harness: ReturnType<typeof createHarness>,
	command: "/plan save" | "/plan exit",
) {
	const commandResult = await input(harness, command);
	assert.equal(commandResult.action, "dispatched");
	await harness.handlers.get("before_agent_start")?.(
		{
			type: "before_agent_start",
			prompt: commandResult.text,
			systemPrompt: "base",
			systemPromptOptions: {},
		},
		harness.ctx,
	);
	return commandResult;
}

async function endUserMessage(
	harness: ReturnType<typeof createHarness>,
	text: string,
): Promise<void> {
	await harness.handlers.get("message_end")?.(
		{
			type: "message_end",
			message: {
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			},
		},
		harness.ctx,
	);
}

async function publishLatest(
	harness: ReturnType<typeof createHarness>,
	revision: number,
	command: "/plan save" | "/plan exit" = "/plan save",
	settle = true,
) {
	await startLifecycleCommand(harness, command);
	const call = {
		type: "tool_call",
		toolCallId: `publish-${revision}`,
		toolName: "create_plan",
		input: { revision },
	};
	const gate = await harness.handlers.get("tool_call")?.(call, harness.ctx);
	assert.equal(gate?.block, undefined);
	const publication = await harness.registeredTools.get("create_plan").execute(
		call.toolCallId,
		call.input,
		undefined,
		undefined,
		harness.ctx,
	);
	harness.recordToolResult("create_plan", publication.details);
	await harness.handlers.get("tool_result")?.(
		{ ...call, type: "tool_result", details: publication.details, isError: false },
		harness.ctx,
	);
	if (settle) {
		await harness.handlers.get("agent_settled")?.(
			{ type: "agent_settled" },
			harness.ctx,
		);
	}
	return publication;
}

describe("Plan session lifecycle", () => {
	it("infers from the first approved published Goal plan in background, survives Plan exit, and never replays on results or updates", async () => {
		const response = Promise.withResolvers<{ stopReason: string; content: Array<{ type: string; text: string }> }>();
		let calls = 0;
		const content = "# Goal\r\nHighlight the selected Guild row, preserving contrast.\r\n";
		await withHarness({
			confirm: async () => true,
			select: async () => "Create plan",
			sessionName: "neon-pager-reboot",
			namingCompletion: async (_model, context) => {
				calls += 1;
				assert.equal(JSON.parse(context.messages[0].content[0].text).publishedPlan, content);
				return response.promise;
			},
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, content, 0);
			assert.equal(calls, 0);
			const publication = await assertOperationSettlesPromptly(publishLatest(harness, 1, "/plan exit"));
			assert.equal(await readFile(join(harness.ctx.cwd, publication.details.path), "utf8"), content);
			assert.equal(harness.appended.at(-1)?.data.active, false);
			assert.equal(harness.getSessionName(), "neon-pager-reboot");
			assert.equal(calls, 1);
			assert.equal(harness.appended.some((entry: Entry) => entry.data.completedPublication?.sessionName), false);
			response.resolve({ stopReason: "stop", content: [{ type: "text", text: "guild-selected-row-highlight" }] });
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(harness.sessionNameChanges, ["guild-selected-row-highlight"]);
			await harness.rename("manual-authoritative-name");
			await harness.handlers.get("agent_settled")?.({ type: "agent_settled" }, harness.ctx);
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Goal\nChange Guild row styling again.\n", 1);
			await publishLatest(harness, 2);
			assert.equal(calls, 1);
			assert.equal(harness.getSessionName(), "manual-authoritative-name");
		});
	});

	it("cancels pending Plan inference on lifecycle invalidation without allowing late names into another session", async () => {
		for (const event of ["session_shutdown", "session_start", "session_tree", "rename"]) {
			let signal: AbortSignal | undefined;
			let calls = 0;
			const response = Promise.withResolvers<{ stopReason: string; content: Array<{ type: string; text: string }> }>();
			await withHarness({
				confirm: async () => true,
				sessionName: "existing-session-name",
				namingCompletion: async (_model, _context, options) => {
					calls += 1;
					signal = options.signal as AbortSignal;
					return response.promise;
				},
			}, async (harness) => {
				await input(harness, "/plan");
				await checkpointPlan(harness, "# Goal\nHighlight Guild selected rows.", 0);
				assert.equal(calls, 0);
				await publishLatest(harness, 1);
				assert.equal(calls, 1);
				if (event === "rename") await harness.rename("manual-session-name");
				else await harness.handlers.get(event)?.({ type: event, reason: event === "session_start" ? "resume" : "new" }, harness.ctx);
				assert.equal(signal?.aborted, true, event);
				response.resolve({ stopReason: "stop", content: [{ type: "text", text: "guild-selected-row-highlight" }] });
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.deepEqual(harness.sessionNameChanges, [], event);
				assert.equal(harness.getSessionName(), event === "rename" ? "manual-session-name" : "existing-session-name");
				assert.equal(calls, 1);
			});
		}
	});

	it("never resurrects legacy generated names or starts inference when reconciling completed or digest-verified crash publications", async () => {
		for (const command of ["/plan save", "/plan exit"] as const) {
			await withHarness({ confirm: async () => true, select: async () => "Create plan" }, async (original) => {
				await input(original, "/plan");
				await checkpointPlan(original, "# Goal\nHighlight selected Guild rows.\n", 0);
				await publishLatest(original, 1, command, false);
				const approvalIndex = original.allEntries.findLastIndex((entry: Entry) => entry.data?.approval);
				assert.ok(approvalIndex >= 0);
				const approvedEntries = structuredClone(original.allEntries.slice(0, approvalIndex + 1));
				const completedEntries = structuredClone(original.allEntries);
				const completed = completedEntries.findLast((entry: Entry) => entry.data?.completedPublication);
				completed.data.completedPublication.sessionName = "stale-generated-name";
				for (const entries of [completedEntries, approvedEntries]) {
					let calls = 0;
					const resumed = createHarness({
						cwd: original.ctx.cwd, entries: structuredClone(entries), sessionName: "manual-authoritative-name",
						namingCompletion: async () => { calls += 1; return { stopReason: "stop", content: [{ type: "text", text: "guild-selected-row-highlight" }] }; },
					});
					await resumed.handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, resumed.ctx);
					await resumed.handlers.get("agent_settled")?.({ type: "agent_settled" }, resumed.ctx);
					assert.equal(resumed.getSessionName(), "manual-authoritative-name");
					assert.deepEqual(resumed.sessionNameChanges, []);
					assert.equal(calls, 0);
					assert.equal(resumed.appended.at(-1)?.data.active, command === "/plan save");
					await resumed.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, resumed.ctx);
					assert.equal(calls, 0);
					assert.equal(resumed.getSessionName(), "manual-authoritative-name");
				}
			});
		}
	});

	for (const builtinPathFormat of ["legacy", "current"] as const) {
		it(`exposes and admits local read tools with ${builtinPathFormat} source paths, while blocking mutation`, async () => {
			await withHarness({ builtinPathFormat }, async (harness) => {
				const normalTools = [...harness.getActiveTools()];
				await input(harness, "/plan");
				for (const name of ["read", "grep", "find", "ls"]) {
					assert.ok(harness.getActiveTools().includes(name), `${name} must be exposed`);
					assert.equal(await harness.handlers.get("tool_call")?.({
						type: "tool_call", toolCallId: `test-${name}`, toolName: name, input: {},
					}, harness.ctx), undefined, `${name} must be admitted`);
				}
				for (const name of ["write", "edit", "bash"]) {
					assert.equal(harness.getActiveTools().includes(name), false);
					const result = await harness.handlers.get("tool_call")?.({
						type: "tool_call", toolCallId: `test-${name}`, toolName: name, input: {},
					}, harness.ctx);
					assert.equal(result?.block, true);
				}
				await input(harness, "/plan exit");
				assert.deepEqual(harness.getActiveTools(), normalTools);
			});
		});
	}

	it("restores the exact pre-Plan selection when /tree replays Plan tools on an exited branch", async () => {
		await withHarness({}, async (harness) => {
			const normalTools = ["read", "bash"];
			harness.setActiveTools(normalTools);
			await input(harness, "/plan");
			const planTools = [...harness.getActiveTools()];
			await input(harness, "/plan exit");
			const exitedBranch = [...harness.allEntries];

			harness.setBranch([]);
			harness.setActiveTools(normalTools);
			await harness.handlers.get("session_tree")?.(
				{ type: "session_tree", oldLeafId: "exited", newLeafId: "before-plan" },
				harness.ctx,
			);
			harness.setBranch(exitedBranch);
			// Pi 1.x restores the transcript's tools before emitting session_tree.
			// No model request after exit has yet declared the restored normal tools.
			harness.setActiveTools(planTools);
			await harness.handlers.get("session_tree")?.(
				{ type: "session_tree", oldLeafId: "before-plan", newLeafId: "exited" },
				harness.ctx,
			);

			assert.equal(harness.appended.at(-1)?.data.active, false);
			assert.deepEqual(harness.getActiveTools(), normalTools);
			assert.equal(await harness.handlers.get("tool_call")?.({
				type: "tool_call", toolCallId: "history", toolName: "bash", input: { command: "git log -1" },
			}, harness.ctx), undefined);
			assert.equal(await harness.handlers.get("user_bash")?.({
				type: "user_bash", command: "gh --version",
			}, harness.ctx), undefined);

			await input(harness, "/plan");
			assert.equal(harness.getActiveTools().includes("bash"), false);
			await input(harness, "/plan exit");
			assert.deepEqual(harness.getActiveTools(), normalTools, "re-entry must not capture a poisoned snapshot");
		});
	});

	it("uses the selected exited branch's tools rather than an active sibling's snapshot", async () => {
		for (const [exitedTools, siblingTools] of [
			[["read", "bash"], ["read"]],
			[["read"], ["read", "bash"]],
		]) {
			await withHarness({}, async (harness) => {
				harness.setActiveTools(exitedTools);
				await input(harness, "/plan");
				const planTools = [...harness.getActiveTools()];
				await input(harness, "/plan exit");
				const exitedBranch = [...harness.allEntries];

				harness.setBranch([]);
				harness.setActiveTools(siblingTools);
				await harness.handlers.get("session_tree")?.({ type: "session_tree" }, harness.ctx);
				await input(harness, "/plan");
				harness.setBranch(exitedBranch);
				harness.setActiveTools(planTools);
				await harness.handlers.get("session_tree")?.({ type: "session_tree" }, harness.ctx);

				assert.equal(harness.appended.at(-1)?.data.active, false);
				assert.deepEqual(harness.getActiveTools(), exitedTools);
			});
		}
	});

	it("preserves non-Plan incoming tool selections when reconciling an exited branch", async () => {
		for (const incomingTools of [["read", "edit"], [], ["read", "grep", "find", "ls"]]) {
			await withHarness({}, async (harness) => {
				harness.setActiveTools(["read", "bash"]);
				await input(harness, "/plan");
				await input(harness, "/plan exit");
				const exitedBranch = [...harness.allEntries];
				await input(harness, "/plan");

				harness.setBranch(exitedBranch);
				harness.setActiveTools(incomingTools);
				await harness.handlers.get("session_tree")?.({ type: "session_tree" }, harness.ctx);
				assert.deepEqual(harness.getActiveTools(), incomingTools);

				await harness.handlers.get("session_start")?.(
					{ type: "session_start", reason: "reload" }, harness.ctx,
				);
				assert.deepEqual(harness.getActiveTools(), incomingTools);
			});
		}
	});

	it("creates one stable session-owned identity on bare /plan and treats re-entry while active as a no-op", async () => {
		await withHarness({}, async (harness) => {
			const first = await input(harness, "/plan");
			const state = harness.appended.at(-1)?.data;
			const entriesAfterFirst = harness.appended.length;
			const second = await input(harness, "/plan");

			assert.deepEqual(first, { action: "handled" });
			assert.equal(state.version, 1);
			assert.equal(state.active, true);
			assert.equal(state.ownerSessionId, "session-a");
			assert.match(state.planId, /^[0-9a-f-]{36}$/u);
			assert.match(
				state.candidatePath,
				/^\.pi\/plans\/\d{4}-\d{2}-\d{2}-\d{6}-plan-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.md$/u,
			);
			assert.equal(state.publicationState, "unpublished");
			assert.deepEqual(second, { action: "handled" });
			assert.equal(harness.appended.length, entriesAfterFirst);
			assert.match(harness.notifications.at(-1)?.message ?? "", /already active/i);
			assert.deepEqual(harness.getActiveTools(), [
				"read",
				"grep",
				"find",
				"ls",
				"update_plan_draft",
				"create_plan",
			]);
		});
	});

	it("abandons a queued /plan activation superseded by /plan exit without changing lifecycle state", async () => {
		await withHarness({ mode: "tui" }, async (harness) => {
			const normalTools = harness.getActiveTools();
			const enterPromise = input(harness, "/plan");
			const exitResult = await input(harness, "/plan exit");
			const enterResult = await enterPromise;

			assert.deepEqual(enterResult, { action: "handled" });
			assert.deepEqual(exitResult, { action: "handled" });
			assert.equal(harness.appended.length, 0);
			assert.deepEqual(harness.getActiveTools(), normalTools);
			assert.equal(harness.getThemeName(), "dark");
			assert.deepEqual(harness.themeChanges, []);
		});
	});

	it("abandons /plan after async path generation when a normal prompt supersedes activation", async () => {
		let pathGenerationCalls = 0;
		let releasePathGeneration: ((path: string) => void) | undefined;
		const generatedPath = ".pi/plans/2026-01-02-030405-deferred.md";
		const deferredPath = new Promise<string>((resolve) => {
			releasePathGeneration = resolve;
		});

		await withHarness({
			mode: "tui",
			generatePlanPath: async () => {
				pathGenerationCalls += 1;
				return deferredPath;
			},
		}, async (harness) => {
			const normalTools = harness.getActiveTools();
			const enterPromise = input(harness, "/plan");
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(pathGenerationCalls, 1);
				assert.deepEqual(
					await input(harness, "A newer normal prompt"),
					{ action: "continue" },
				);
				releasePathGeneration?.(generatedPath);
				assert.deepEqual(await enterPromise, { action: "handled" });

				assert.equal(harness.appended.length, 0);
				assert.deepEqual(harness.getActiveTools(), normalTools);
				assert.equal(harness.getThemeName(), "dark");
				assert.deepEqual(harness.themeChanges, []);
			} finally {
				releasePathGeneration?.(generatedPath);
				await enterPromise;
			}
		});
	});

	it("abandons /plan after a custom agent turn starts and settles during async path generation", async () => {
		let releasePathGeneration: ((path: string) => void) | undefined;
		const generatedPath = ".pi/plans/2026-01-02-030405-custom-turn.md";
		const pathGenerationStarted = Promise.withResolvers<void>();
		const deferredPath = new Promise<string>((resolve) => {
			releasePathGeneration = resolve;
		});

		await withHarness({
			mode: "tui",
			generatePlanPath: async () => {
				pathGenerationStarted.resolve();
				return deferredPath;
			},
		}, async (harness) => {
			const normalTools = harness.getActiveTools();
			const enterPromise = input(harness, "/plan");
			try {
				await pathGenerationStarted.promise;
				await harness.handlers.get("agent_start")?.(
					{ type: "agent_start" },
					harness.ctx,
				);
				await harness.handlers.get("agent_settled")?.(
					{ type: "agent_settled" },
					harness.ctx,
				);
				releasePathGeneration?.(generatedPath);
				assert.deepEqual(await enterPromise, { action: "handled" });

				assert.equal(harness.appended.length, 0);
				assert.deepEqual(harness.getActiveTools(), normalTools);
				assert.equal(harness.getThemeName(), "dark");
				assert.deepEqual(harness.themeChanges, []);
			} finally {
				releasePathGeneration?.(generatedPath);
				await enterPromise;
			}
		});
	});

	it("serializes concurrent idle RPC entries into one committed lifecycle identity", async () => {
		await withHarness({}, async (harness) => {
			const [first, second] = await Promise.all([
				input(harness, "/plan"),
				input(harness, "/plan"),
			]);
			const committedStates = harness.appended.map((entry: Entry) => entry.data);

			assert.deepEqual(first, { action: "handled" });
			assert.deepEqual(second, { action: "handled" });
			assert.equal(committedStates.length, 1);
			assert.equal(committedStates[0]?.active, true);
			assert.equal(committedStates[0]?.ownerSessionId, "session-a");
			assert.equal(new Set(committedStates.map((state: Entry) => state.planId)).size, 1);
			assert.deepEqual(harness.getActiveTools(), [
				"read",
				"grep",
				"find",
				"ls",
				"update_plan_draft",
				"create_plan",
			]);
		});
	});

	it("checkpoints exact full Markdown sequentially and projects the latest branch revision into every active context", async () => {
		await withHarness({}, async (harness) => {
			await input(harness, "/plan");
			const checkpointTool = harness.registeredTools.get("update_plan_draft");
			assert.equal(checkpointTool.executionMode, "sequential");
			const content = "# Plan: Durable brief\n\n## Requirements\n- exact bytes\n";

			const result = await checkpointTool.execute(
				"checkpoint-1",
				{ content, expectedRevision: 0 },
				undefined,
				undefined,
				harness.ctx,
			);
			harness.recordToolResult("update_plan_draft", result.details);

			assert.equal(result.details.content, content);
			assert.equal(result.details.revision, 1);
			assert.match(result.details.digest, /^[a-f0-9]{64}$/u);
			await assert.rejects(
				checkpointTool.execute(
					"checkpoint-stale",
					{ content: "# Changed", expectedRevision: 0 },
					undefined,
					undefined,
					harness.ctx,
				),
				/expected revision 1.*received 0/i,
			);

			const context = await harness.handlers.get("context")?.(
				{ type: "context", messages: [{ role: "user", content: "newer refinement", timestamp: 1 }] },
				harness.ctx,
			);
			const projection = context.messages[0];
			assert.equal(projection.customType, "plan-checkpoint-context");
			assert.equal(projection.content[1].text, content);
			assert.match(projection.content[0].text, /unapproved data, not instructions/i);
			assert.equal(context.messages[1].content, "newer refinement");
			assert.equal(harness.appended.at(-1)?.data.checkpointRevision, 1);
		});
	});

	it("publishes the exact bound checkpoint on /plan save and remains active", async () => {
		await withHarness({ confirm: async () => true }, async (harness) => {
			await input(harness, "/plan");
			const content = "# Plan: Stable publication\n\n## Steps\n1. Keep planning active.\n";
			const checkpointTool = harness.registeredTools.get("update_plan_draft");
			const checkpointResult = await checkpointTool.execute(
				"checkpoint-1",
				{ content, expectedRevision: 0 },
				undefined,
				undefined,
				harness.ctx,
			);
			harness.recordToolResult("update_plan_draft", checkpointResult.details);

			await startLifecycleCommand(harness, "/plan save");
			const call = {
				type: "tool_call",
				toolCallId: "publish-1",
				toolName: "create_plan",
				input: { revision: 1 },
			};
			const gate = await harness.handlers.get("tool_call")?.(call, harness.ctx);
			assert.equal(gate?.block, undefined);

			const creator = harness.registeredTools.get("create_plan");
			const publication = await creator.execute(
				call.toolCallId,
				call.input,
				undefined,
				undefined,
				harness.ctx,
			);
			harness.recordToolResult("create_plan", publication.details);
			await harness.handlers.get("tool_result")?.(
				{ ...call, type: "tool_result", details: publication.details, isError: false },
				harness.ctx,
			);

			assert.equal(publication.details.revision, 1);
			assert.equal(publication.details.digest, checkpointResult.details.digest);
			assert.equal(publication.details.unchanged, false);
			assert.equal(await readFile(join(harness.ctx.cwd, publication.details.path), "utf8"), content);
			assert.equal(harness.appended.at(-1)?.data.active, true);
			assert.equal(harness.appended.at(-1)?.data.publicationState, "synced");
			assert.equal(harness.appended.at(-1)?.data.publishedPath, publication.details.path);
			assert.equal(harness.getSessionName(), undefined);
			assert.deepEqual(harness.sessionNameChanges, []);
			assert.deepEqual(harness.getActiveTools(), [
				"read", "grep", "find", "ls", "update_plan_draft", "create_plan",
			]);

			const before = await lstat(join(harness.ctx.cwd, publication.details.path));
			const unchangedSave = await input(harness, "/plan save");
			const after = await lstat(join(harness.ctx.cwd, publication.details.path));
			assert.deepEqual(unchangedSave, { action: "handled" });
			assert.equal(after.ino, before.ino);
			assert.match(harness.notifications.at(-1)?.message ?? "", /already synced.*no write/i);
		});
	});

	it("keeps first publication successful and path-stable when session naming initially fails", async () => {
		let namingAttempts = 0;
		await withHarness({
			confirm: async () => true,
			namingCompletion: async () => ({ stopReason: "stop", content: [{ type: "text", text: "naming-failure-revision-one" }] }),
			setSessionName: () => {
				namingAttempts += 1;
				if (namingAttempts === 1) throw new Error("simulated session naming failure");
			},
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Naming failure revision one\n", 0);

			const first = await publishLatest(harness, 1);
			assert.equal(harness.appended.at(-1)?.data.publishedPath, first.details.path);
			assert.equal(harness.appended.at(-1)?.data.publishedRevision, 1);
			assert.equal(harness.getSessionName(), undefined);

			await checkpointPlan(harness, "# Plan: Naming failure revision two\n", 1);
			const second = await publishLatest(harness, 2);
			const planDirectory = dirname(join(harness.ctx.cwd, first.details.path));

			assert.equal(second.details.path, first.details.path);
			assert.equal(harness.appended.at(-1)?.data.publishedPath, first.details.path);
			assert.equal(harness.appended.at(-1)?.data.publishedRevision, 2);
			assert.equal(namingAttempts, 1);
			assert.deepEqual(
				(await readdir(planDirectory)).filter((name) => name.endsWith(".md")),
				[first.details.path.split("/").at(-1)],
			);
			assert.equal(
				await readFile(join(harness.ctx.cwd, first.details.path), "utf8"),
				"# Plan: Naming failure revision two\n",
			);
		});
	});

	it("discards a deferred stale already-synced save result after a concurrent checkpoint publication", async () => {
		let deferNextVerification = false;
		let verificationDeferred = false;
		let deferredDigest: string | undefined;
		let markVerificationStarted: (() => void) | undefined;
		let rejectVerification: ((error: Error) => void) | undefined;
		const verificationStarted = new Promise<void>((resolve) => {
			markVerificationStarted = resolve;
		});
		const deferredVerification = new Promise<void>((_resolve, reject) => {
			rejectVerification = reject;
		});

		await withHarness({
			confirm: async () => true,
			verifyPlanFileDigest: async (cwd, planPath, expectedDigest) => {
				if (deferNextVerification) {
					deferNextVerification = false;
					verificationDeferred = true;
					deferredDigest = expectedDigest;
					markVerificationStarted?.();
					return deferredVerification;
				}
				return verifyPlanFileDigest(cwd, planPath, expectedDigest);
			},
		}, async (harness) => {
			let staleSavePromise: ReturnType<typeof input> | undefined;
			try {
				await input(harness, "/plan");
				await checkpointPlan(harness, "# Plan: Synced save revision one\n", 0);
				const firstPublication = await publishLatest(harness, 1);

				deferNextVerification = true;
				staleSavePromise = input(harness, "/plan save");
				await verificationStarted;
				assert.equal(deferredDigest, firstPublication.details.digest);

				const currentContent = "# Plan: Synced save revision two\n";
				await checkpointPlan(harness, currentContent, 1);
				const currentPublication = await publishLatest(harness, 2);
				const entriesAfterCurrentPublication = harness.appended.length;
				const feedbackAfterCurrentPublication = harness.notifications.length;

				rejectVerification?.(new PlanPublicationConflictError(
					"Stale already-synced save verification observed the replaced publication.",
				));
				assert.deepEqual(await staleSavePromise, { action: "handled" });

				assert.equal(harness.appended.length, entriesAfterCurrentPublication);
				assert.equal(harness.notifications.length, feedbackAfterCurrentPublication);
				assert.match(harness.notifications.at(-1)?.message ?? "", /published.*remains active/i);
				assert.equal(harness.appended.at(-1)?.data.publishedRevision, 2);
				assert.equal(harness.appended.at(-1)?.data.publishedDigest, currentPublication.details.digest);
				assert.equal(harness.appended.at(-1)?.data.checkpointRevision, 2);
				assert.equal(harness.appended.at(-1)?.data.publicationState, "synced");
				assert.equal(
					await readFile(join(harness.ctx.cwd, currentPublication.details.path), "utf8"),
					currentContent,
				);
			} finally {
				if (verificationDeferred) {
					rejectVerification?.(new Error("Test cleanup released deferred save verification."));
				}
				await staleSavePromise?.catch(() => undefined);
			}
		});
	});

	it("reports an on-disk publication conflict from /plan status without starting an agent turn", async () => {
		await withHarness({ confirm: async () => true }, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Conflict status\n", 0);
			const publication = await publishLatest(harness, 1);
			await writeFile(join(harness.ctx.cwd, publication.details.path), "external bytes");

			const result = await input(harness, "/plan status");

			assert.deepEqual(result, { action: "handled" });
			assert.match(harness.notifications.at(-1)?.message ?? "", /active.*revision 1.*conflict/i);
			assert.equal(harness.notifications.at(-1)?.level, "warning");
			assert.equal(harness.appended.at(-1)?.data.publicationState, "conflict");
			assert.equal(await readFile(join(harness.ctx.cwd, publication.details.path), "utf8"), "external bytes");
		});
	});

	it("discards a deferred stale status conflict after a concurrent update publishes the current checkpoint", async () => {
		let deferNextVerification = false;
		let verificationDeferred = false;
		let deferredDigest: string | undefined;
		let markVerificationStarted: (() => void) | undefined;
		let rejectVerification: ((error: Error) => void) | undefined;
		const verificationStarted = new Promise<void>((resolve) => {
			markVerificationStarted = resolve;
		});
		const deferredVerification = new Promise<void>((_resolve, reject) => {
			rejectVerification = reject;
		});

		await withHarness({
			confirm: async () => true,
			verifyPlanFileDigest: async (cwd, planPath, expectedDigest) => {
				if (deferNextVerification) {
					deferNextVerification = false;
					verificationDeferred = true;
					deferredDigest = expectedDigest;
					markVerificationStarted?.();
					return deferredVerification;
				}
				return verifyPlanFileDigest(cwd, planPath, expectedDigest);
			},
		}, async (harness) => {
			let statusPromise: ReturnType<typeof input> | undefined;
			try {
				await input(harness, "/plan");
				await checkpointPlan(harness, "# Plan: Concurrent status revision one\n", 0);
				const firstPublication = await publishLatest(harness, 1);
				const currentContent = "# Plan: Concurrent status revision two\n";
				await checkpointPlan(harness, currentContent, 1);

				deferNextVerification = true;
				statusPromise = input(harness, "/plan status");
				await verificationStarted;
				assert.equal(deferredDigest, firstPublication.details.digest);

				const currentPublication = await publishLatest(harness, 2);
				const entriesAfterCurrentPublication = harness.appended.length;
				rejectVerification?.(new PlanPublicationConflictError(
					"Published plan conflict from the old inode and digest after concurrent replacement.",
				));
				const result = await statusPromise;

				assert.deepEqual(result, { action: "handled" });
				assert.match(harness.notifications.at(-1)?.message ?? "", /active.*revision 2.*synced/i);
				assert.equal(harness.notifications.at(-1)?.level, "info");
				assert.equal(harness.appended.at(-1)?.data.publishedRevision, 2);
				assert.equal(harness.appended.at(-1)?.data.publishedDigest, currentPublication.details.digest);
				assert.equal(harness.appended.at(-1)?.data.checkpointRevision, 2);
				assert.equal(harness.appended.at(-1)?.data.publicationState, "synced");
				assert.equal(
					harness.appended
						.slice(entriesAfterCurrentPublication)
						.some((entry: Entry) => entry.data.publicationState === "conflict"),
					false,
				);
				assert.equal(
					await readFile(join(harness.ctx.cwd, currentPublication.details.path), "utf8"),
					currentContent,
				);
			} finally {
				if (verificationDeferred) {
					rejectVerification?.(new Error("Test cleanup released deferred status verification."));
				}
				await statusPromise?.catch(() => undefined);
			}
		});
	});

	it("discards a deferred status verification after session shutdown without touching replacement context", async () => {
		const verificationStarted = Promise.withResolvers<void>();
		const verification = Promise.withResolvers<void>();
		let deferVerification = false;
		await withHarness({
			confirm: async () => true,
			verifyPlanFileDigest: async (...args) => {
				if (deferVerification) {
					deferVerification = false;
					verificationStarted.resolve();
					return verification.promise;
				}
				return verifyPlanFileDigest(...args);
			},
		}, async (harness) => {
			let oldStatus: ReturnType<typeof input> | undefined;
			try {
				await input(harness, "/plan");
				await checkpointPlan(harness, "# Plan: Old deferred status\n", 0);
				await publishLatest(harness, 1);

				deferVerification = true;
				oldStatus = input(harness, "/plan status");
				await verificationStarted.promise;

				const observed = observeEntryCoordination(harness);
				const replacement = createHarness({ cwd: harness.ctx.cwd, sessionId: "session-after-status" });
				const replacementCtx = replacement.ctx;
				await harness.handlers.get("session_shutdown")?.(
					{ type: "session_shutdown", reason: "new" },
					harness.ctx,
				);
				const entriesBeforeReplacement = harness.appended.length;
				const staleContextAccesses = makeContextStale(harness.ctx);
				await replacement.handlers.get("session_start")?.(
					{ type: "session_start", reason: "new", previousSessionFile: "old-session.jsonl" },
					replacementCtx,
				);
				await inputWithContext(replacement, replacementCtx, "/plan");
				const lastPersistedState = replacement.appended.at(-1)?.data;
				assert.equal(lastPersistedState?.active, true);
				assert.notEqual(lastPersistedState.planId, harness.appended.at(-1)?.data.planId);
				const replacementTools = [...replacement.getActiveTools()];
				assert.equal(replacementTools.includes("create_plan"), true);
				assert.equal(replacementTools.includes("write"), false);
				const replacementCoordination = observeEntryCoordination(replacement);
				const entriesAfterReplacement = replacement.appended.length;

				verification.reject(new PlanPublicationConflictError("Old session status conflict."));
				assert.deepEqual(await oldStatus, { action: "handled" });

				assert.deepEqual(staleContextAccesses, []);
				assert.equal(replacement.appended.length, entriesAfterReplacement);
				assert.equal(replacement.appended.at(-1)?.data, lastPersistedState);
				assert.equal(lastPersistedState.active, true);
				assert.deepEqual(replacement.getActiveTools(), replacementTools);
				assert.equal(replacementCoordination.provider.inspect().phase, "active");
				// The outgoing callback must not append to its abandoned session either.
				assert.equal(harness.appended.length, entriesBeforeReplacement);
				assert.equal(observed.provider.inspect().phase, "disposed");
				assert.equal(observed.released(), 0);
			} finally {
				verification.reject(new Error("Test cleanup released deferred status verification."));
				await oldStatus?.catch(() => undefined);
			}
		});
	});

	it("discards a deferred publication preflight after session shutdown without mutating replacement state", async () => {
		const verificationStarted = Promise.withResolvers<void>();
		const verification = Promise.withResolvers<void>();
		let deferVerification = false;
		await withHarness({
			confirm: async () => true,
			verifyPlanFileDigest: async (...args) => {
				if (deferVerification) {
					deferVerification = false;
					verificationStarted.resolve();
					return verification.promise;
				}
				return verifyPlanFileDigest(...args);
			},
		}, async (harness) => {
			let oldPreflight: Promise<unknown> | undefined;
			try {
				await input(harness, "/plan");
				await checkpointPlan(harness, "# Plan: Old publication revision one\n", 0);
				await publishLatest(harness, 1);
				await checkpointPlan(harness, "# Plan: Old publication revision two\n", 1);
				await startLifecycleCommand(harness, "/plan save");

				deferVerification = true;
				oldPreflight = harness.handlers.get("tool_call")?.(
					{
						type: "tool_call",
						toolCallId: "old-session-publication-preflight",
						toolName: "create_plan",
						input: { revision: 2 },
					},
					harness.ctx,
				);
				await verificationStarted.promise;

				const observed = observeEntryCoordination(harness);
				const replacement = createHarness({ cwd: harness.ctx.cwd, sessionId: "session-after-preflight" });
				const replacementCtx = replacement.ctx;
				await harness.handlers.get("session_shutdown")?.(
					{ type: "session_shutdown", reason: "resume", targetSessionFile: "replacement.jsonl" },
					harness.ctx,
				);
				const entriesBeforeReplacement = harness.appended.length;
				const staleContextAccesses = makeContextStale(harness.ctx);
				await replacement.handlers.get("session_start")?.(
					{ type: "session_start", reason: "resume", previousSessionFile: "old-session.jsonl" },
					replacementCtx,
				);
				await inputWithContext(replacement, replacementCtx, "/plan");
				const lastPersistedState = replacement.appended.at(-1)?.data;
				assert.equal(lastPersistedState?.active, true);
				assert.notEqual(lastPersistedState.planId, harness.appended.at(-1)?.data.planId);
				const replacementTools = [...replacement.getActiveTools()];
				assert.equal(replacementTools.includes("create_plan"), true);
				assert.equal(replacementTools.includes("write"), false);
				const replacementCoordination = observeEntryCoordination(replacement);
				const entriesAfterReplacement = replacement.appended.length;

				verification.reject(new PlanPublicationConflictError("Old publication baseline conflict."));
				const gate = await oldPreflight as { block?: boolean; reason?: string } | undefined;

				assert.equal(gate?.block, true);
				assert.match(gate?.reason ?? "", /superseded|session/i);
				assert.deepEqual(staleContextAccesses, []);
				assert.equal(replacement.appended.length, entriesAfterReplacement);
				assert.equal(replacement.appended.at(-1)?.data, lastPersistedState);
				assert.equal(lastPersistedState.active, true);
				assert.deepEqual(replacement.getActiveTools(), replacementTools);
				assert.equal(replacementCoordination.provider.inspect().phase, "active");
				// The outgoing callback must not append to its abandoned session either.
				assert.equal(harness.appended.length, entriesBeforeReplacement);
				assert.equal(observed.provider.inspect().phase, "disposed");
				assert.equal(observed.released(), 0);
			} finally {
				verification.reject(new Error("Test cleanup released deferred publication preflight."));
				await oldPreflight?.catch(() => undefined);
			}
		});
	});

	it("exits immediately when the published plan is unchanged and restores the same checkpoint on re-entry", async () => {
		await withHarness({ confirm: async () => true }, async (harness) => {
			const normalTools = harness.getActiveTools();
			await input(harness, "/plan");
			const identity = harness.appended.at(-1)?.data.planId;
			const content = "# Plan: Immediate synced exit\n";
			await checkpointPlan(harness, content, 0);
			const publication = await publishLatest(harness, 1);

			const result = await input(harness, "/plan exit");

			assert.deepEqual(result, { action: "handled" });
			assert.equal(harness.appended.at(-1)?.data.active, false);
			assert.equal(harness.appended.at(-1)?.data.planId, identity);
			assert.equal(harness.appended.at(-1)?.data.checkpointRevision, 1);
			assert.equal(harness.appended.at(-1)?.data.publishedPath, publication.details.path);
			assert.deepEqual(harness.getActiveTools(), normalTools);
			assert.match(harness.notifications.at(-1)?.message ?? "", /unchanged.*exited/i);

			const restored = await input(harness, "/plan");
			assert.deepEqual(restored, { action: "handled" });
			assert.equal(harness.appended.at(-1)?.data.planId, identity);
			assert.equal(harness.appended.at(-1)?.data.checkpointRevision, 1);
			const context = await harness.handlers.get("context")?.(
				{ type: "context", messages: [] },
				harness.ctx,
			);
			assert.equal(context.messages.at(-1).content[1].text, content);
		});
	});

	it("keeps Plan mode active when queued input is present after the synced-exit verification", async () => {
		let pendingMessages = false;
		await withHarness({
			confirm: async () => true,
			hasPendingMessages: () => pendingMessages,
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Pending synced exit\n", 0);
			await publishLatest(harness, 1);
			pendingMessages = true;

			const result = await input(harness, "/plan exit");

			assert.deepEqual(result, { action: "handled" });
			assert.equal(harness.appended.at(-1)?.data.active, true);
			assert.equal(harness.getActiveTools().includes("create_plan"), true);
			assert.match(harness.notifications.at(-1)?.message ?? "", /pending|newer input|superseded/i);
		});
	});

	it("does not persist a stale synced-exit conflict after another RPC prompt starts", async () => {
		let agentIdle = true;
		let deferVerification = false;
		let markVerificationStarted: (() => void) | undefined;
		let rejectVerification: ((error: Error) => void) | undefined;
		let selectionAttempts = 0;
		const verificationStarted = new Promise<void>((resolve) => {
			markVerificationStarted = resolve;
		});
		const deferredVerification = new Promise<void>((_resolve, reject) => {
			rejectVerification = reject;
		});
		await withHarness({
			confirm: async () => true,
			isIdle: () => agentIdle,
			select: async () => {
				selectionAttempts += 1;
				return "Continue planning";
			},
			verifyPlanFileDigest: async (...args) => {
				if (deferVerification) {
					deferVerification = false;
					markVerificationStarted?.();
					return deferredVerification;
				}
				return verifyPlanFileDigest(...args);
			},
		}, async (harness) => {
			let exitPromise: ReturnType<typeof input> | undefined;
			try {
				await input(harness, "/plan");
				await checkpointPlan(harness, "# Plan: Concurrent synced verification\n", 0);
				await publishLatest(harness, 1);
				const entriesBeforeExit = harness.appended.length;

				deferVerification = true;
				exitPromise = input(harness, "/plan exit");
				await verificationStarted;
				assert.deepEqual(
					await input(harness, "Concurrent RPC prompt during verification"),
					{ action: "continue" },
				);
				agentIdle = false;
				rejectVerification?.(new PlanPublicationConflictError(
					"Stale verification observed superseded on-disk bytes.",
				));
				assert.deepEqual(await exitPromise, { action: "handled" });

				assert.equal(harness.appended.at(-1)?.data.active, true);
				assert.equal(harness.getActiveTools().includes("create_plan"), true);
				assert.equal(harness.getActiveTools().includes("write"), false);
				assert.equal(selectionAttempts, 0);
				assert.equal(
					harness.appended
						.slice(entriesBeforeExit)
						.some((entry: Entry) => entry.data.publicationState === "conflict"),
					false,
				);
			} finally {
				rejectVerification?.(new Error("Test cleanup released deferred exit verification."));
				await exitPromise?.catch(() => undefined);
			}
		});
	});

	it("does not persist a stale dirty-exit preflight conflict after another RPC prompt starts", async () => {
		let agentIdle = true;
		let deferVerification = false;
		let markVerificationStarted: (() => void) | undefined;
		let rejectVerification: ((error: Error) => void) | undefined;
		let selectionAttempts = 0;
		const verificationStarted = new Promise<void>((resolve) => {
			markVerificationStarted = resolve;
		});
		const deferredVerification = new Promise<void>((_resolve, reject) => {
			rejectVerification = reject;
		});
		await withHarness({
			confirm: async () => true,
			isIdle: () => agentIdle,
			select: async () => {
				selectionAttempts += 1;
				return "Continue planning";
			},
			verifyPlanFileDigest: async (...args) => {
				if (deferVerification) {
					deferVerification = false;
					markVerificationStarted?.();
					return deferredVerification;
				}
				return verifyPlanFileDigest(...args);
			},
		}, async (harness) => {
			let exitPromise: ReturnType<typeof input> | undefined;
			try {
				await input(harness, "/plan");
				await checkpointPlan(harness, "# Plan: Dirty preflight revision one\n", 0);
				await publishLatest(harness, 1);
				await checkpointPlan(harness, "# Plan: Dirty preflight revision two\n", 1);
				const entriesBeforeExit = harness.appended.length;

				deferVerification = true;
				exitPromise = input(harness, "/plan exit");
				await verificationStarted;
				assert.deepEqual(
					await input(harness, "Concurrent RPC prompt during dirty preflight"),
					{ action: "continue" },
				);
				agentIdle = false;
				rejectVerification?.(new PlanPublicationConflictError(
					"Stale dirty preflight observed superseded on-disk bytes.",
				));
				assert.deepEqual(await exitPromise, { action: "handled" });

				assert.equal(harness.appended.at(-1)?.data.active, true);
				assert.equal(harness.getActiveTools().includes("create_plan"), true);
				assert.equal(selectionAttempts, 0);
				assert.equal(
					harness.appended
						.slice(entriesBeforeExit)
						.some((entry: Entry) => entry.data.publicationState === "conflict"),
					false,
				);
			} finally {
				rejectVerification?.(new Error("Test cleanup released deferred dirty preflight."));
				await exitPromise?.catch(() => undefined);
			}
		});
	});

	it("gives a forked physical session a new identity and candidate path instead of inheriting ownership", async () => {
		await withHarness({}, async (parent) => {
			await input(parent, "/plan");
			const parentState = parent.appended.at(-1)?.data;
			const child = createHarness({
				cwd: parent.ctx.cwd,
				sessionId: "session-fork",
				sessionFile: join(parent.ctx.cwd, "fork.jsonl"),
				entries: [...parent.allEntries],
			});

			await child.handlers.get("session_start")?.(
				{ type: "session_start", reason: "fork" },
				child.ctx,
			);
			assert.equal(child.getActiveTools().includes("create_plan"), false);
			assert.match(child.notifications.at(-1)?.message ?? "", /foreign session.*not inherited/i);

			await input(child, "/plan");
			const childState = child.appended.at(-1)?.data;
			assert.equal(childState.ownerSessionId, "session-fork");
			assert.notEqual(childState.planId, parentState.planId);
			assert.notEqual(childState.candidatePath, parentState.candidatePath);
		});
	});

	it("restores only the selected branch checkpoint on /tree and never leaks sibling content", async () => {
		await withHarness({}, async (harness) => {
			await input(harness, "/plan");
			const initialStateEntry = harness.allEntries[0];
			await checkpointPlan(harness, "# Plan: Branch A\n\nA-only decision.\n", 0);
			const branchA = [...harness.allEntries];

			const branchB = [initialStateEntry];
			harness.setBranch(branchB);
			await harness.handlers.get("session_tree")?.(
				{ type: "session_tree", oldLeafId: "a", newLeafId: "b" },
				harness.ctx,
			);
			await checkpointPlan(harness, "# Plan: Branch B\n\nB-only decision.\n", 0);

			const branchBContext = await harness.handlers.get("context")?.(
				{ type: "context", messages: [] },
				harness.ctx,
			);
			assert.equal(branchBContext.messages.at(-1).content[1].text, "# Plan: Branch B\n\nB-only decision.\n");
			assert.doesNotMatch(JSON.stringify(branchBContext.messages.at(-1)), /A-only decision/);

			harness.setBranch(branchA);
			await harness.handlers.get("session_tree")?.(
				{ type: "session_tree", oldLeafId: "b", newLeafId: "a" },
				harness.ctx,
			);
			const branchAContext = await harness.handlers.get("context")?.(
				{ type: "context", messages: [] },
				harness.ctx,
			);
			assert.equal(branchAContext.messages.at(-1).content[1].text, "# Plan: Branch A\n\nA-only decision.\n");
			assert.doesNotMatch(JSON.stringify(branchAContext.messages.at(-1)), /B-only decision/);
		});
	});

	it("supersedes an RPC publication approval awaiting on another branch before /tree reconciliation", async () => {
		const approvalStarted = Promise.withResolvers<void>();
		const approvalDecision = Promise.withResolvers<boolean>();
		let confirmationCalls = 0;
		await withHarness({
			confirm: async () => {
				confirmationCalls += 1;
				approvalStarted.resolve();
				return approvalDecision.promise;
			},
		}, async (harness) => {
			try {
				await input(harness, "/plan");
				const initialStateEntry = harness.allEntries[0];
				const content = "# Plan: Awaiting approval sibling checkpoint\n";
				await checkpointPlan(harness, content, 0);
				const branchA = [...harness.ctx.sessionManager.getBranch()];

				harness.setBranch([initialStateEntry]);
				await harness.handlers.get("session_tree")?.(
					{ type: "session_tree", oldLeafId: "approval-a", newLeafId: "approval-b-root" },
					harness.ctx,
				);
				await checkpointPlan(harness, content, 0);
				const branchB = [...harness.ctx.sessionManager.getBranch()];

				harness.setBranch(branchA);
				await harness.handlers.get("session_tree")?.(
					{ type: "session_tree", oldLeafId: "approval-b", newLeafId: "approval-a" },
					harness.ctx,
				);
				await startLifecycleCommand(harness, "/plan save");
				const oldApproval = harness.handlers.get("tool_call")?.(
					{
						type: "tool_call",
						toolCallId: "approval-on-branch-a",
						toolName: "create_plan",
						input: { revision: 1 },
					},
					harness.ctx,
				);
				await approvalStarted.promise;

				harness.setBranch(branchB);
				await harness.handlers.get("session_tree")?.(
					{ type: "session_tree", oldLeafId: "approval-a", newLeafId: "approval-b" },
					harness.ctx,
				);
				approvalDecision.resolve(true);
				const stale = await oldApproval;

				assert.equal(stale?.block, true);
				assert.match(stale?.reason ?? "", /superseded/i);
				assert.equal(harness.appended.at(-1)?.data.active, true);
				assert.equal(harness.appended.at(-1)?.data.approval, undefined);
				assert.equal(confirmationCalls, 1);
				assert.equal((await harness.handlers.get("tool_call")?.(
					{
						type: "tool_call",
						toolCallId: "read-after-tree-approval",
						toolName: "read",
						input: { path: "README.md" },
					},
					harness.ctx,
				))?.block, undefined);
			} finally {
				approvalDecision.resolve(false);
			}
		});
	});

	it("aborts and does not bind a direct exit chooser approval after /tree", async () => {
		const chooserStarted = Promise.withResolvers<void>();
		const chooserDecision = Promise.withResolvers<string | undefined>();
		let chooserSignal: AbortSignal | undefined;
		await withHarness({
			select: async (_title, _choices, options) => {
				chooserSignal = options?.signal;
				chooserStarted.resolve();
				return chooserDecision.promise;
			},
			confirm: async () => true,
		}, async (harness) => {
			try {
				await input(harness, "/plan");
				const initialStateEntry = harness.allEntries[0];
				const content = "# Plan: Identical sibling checkpoint\n";
				await checkpointPlan(harness, content, 0);
				const branchA = [...harness.ctx.sessionManager.getBranch()];

				harness.setBranch([initialStateEntry]);
				await harness.handlers.get("session_tree")?.(
					{ type: "session_tree", oldLeafId: "branch-a", newLeafId: "branch-b-root" },
					harness.ctx,
				);
				await checkpointPlan(harness, content, 0);
				const branchB = [...harness.ctx.sessionManager.getBranch()];

				harness.setBranch(branchA);
				await harness.handlers.get("session_tree")?.(
					{ type: "session_tree", oldLeafId: "branch-b", newLeafId: "branch-a" },
					harness.ctx,
				);
				const exitPromise = input(harness, "/plan exit");
				await chooserStarted.promise;

				harness.setBranch(branchB);
				await harness.handlers.get("session_tree")?.(
					{ type: "session_tree", oldLeafId: "branch-a", newLeafId: "branch-b" },
					harness.ctx,
				);
				assert.equal(chooserSignal?.aborted, true);
				chooserDecision.resolve("Create plan");
				const result = await exitPromise;

				assert.deepEqual(result, { action: "handled" });
				assert.equal(harness.appended.at(-1)?.data.active, true);
				assert.equal(harness.appended.at(-1)?.data.approval, undefined);
				assert.equal(harness.getActiveTools().includes("create_plan"), true);
				assert.equal(harness.getActiveTools().includes("write"), false);
			} finally {
				chooserDecision.resolve(undefined);
			}
		});
	});

	it("invalidates an awaiting direct exit chooser across session shutdown and /new", async () => {
		const chooserStarted = Promise.withResolvers<void>();
		const chooserDecision = Promise.withResolvers<string | undefined>();
		let chooserSignal: AbortSignal | undefined;
		await withHarness({
			select: async (_title, _choices, options) => {
				chooserSignal = options?.signal;
				chooserStarted.resolve();
				return chooserDecision.promise;
			},
		}, async (harness) => {
			let oldExit: ReturnType<typeof input> | undefined;
			try {
				await input(harness, "/plan");
				await checkpointPlan(harness, "# Plan: Old session direct chooser\n", 0);
				oldExit = input(harness, "/plan exit");
				await chooserStarted.promise;

				const observed = observeEntryCoordination(harness);
				const replacement = createHarness({ cwd: harness.ctx.cwd, sessionId: "session-new" });
				const replacementCtx = replacement.ctx;
				await harness.handlers.get("session_shutdown")?.(
					{ type: "session_shutdown", reason: "new" },
					harness.ctx,
				);
				const entriesBeforeReplacement = harness.appended.length;
				const staleContextAccesses = makeContextStale(harness.ctx);
				await replacement.handlers.get("session_start")?.(
					{ type: "session_start", reason: "new", previousSessionFile: "old-session.jsonl" },
					replacementCtx,
				);
				assert.deepEqual(
					await inputWithContext(replacement, replacementCtx, "/plan"),
					{ action: "handled" },
				);
				const lastPersistedState = replacement.appended.at(-1)?.data;
				assert.equal(lastPersistedState?.active, true);
				assert.notEqual(lastPersistedState.planId, harness.appended.at(-1)?.data.planId);
				const replacementTools = [...replacement.getActiveTools()];
				assert.equal(replacementTools.includes("create_plan"), true);
				assert.equal(replacementTools.includes("write"), false);
				const replacementCoordination = observeEntryCoordination(replacement);
				const entriesAfterReplacement = replacement.appended.length;

				chooserDecision.resolve("Exit without publishing");
				assert.deepEqual(await oldExit, { action: "handled" });

				assert.equal(chooserSignal?.aborted, true);
				assert.deepEqual(staleContextAccesses, []);
				assert.equal(replacement.appended.length, entriesAfterReplacement);
				assert.equal(replacement.appended.at(-1)?.data, lastPersistedState);
				assert.equal(lastPersistedState.active, true);
				assert.deepEqual(replacement.getActiveTools(), replacementTools);
				assert.equal(replacementCoordination.provider.inspect().phase, "active");
				// The outgoing callback must not append to its abandoned session either.
				assert.equal(harness.appended.length, entriesBeforeReplacement);
				assert.equal(observed.provider.inspect().phase, "disposed");
				assert.equal(observed.released(), 0);
				assert.equal(harness.getActiveTools().includes("create_plan"), false);
				assert.equal(harness.getActiveTools().includes("write"), true);
			} finally {
				chooserDecision.resolve(undefined);
				await oldExit?.catch(() => undefined);
			}
		});
	});

	it("offers direct unpublished exit before any agent turn and preserves the restorable checkpoint", async () => {
		let chooserCalls = 0;
		await withHarness({
			select: async () => {
				chooserCalls += 1;
				return undefined;
			},
		}, async (harness) => {
			await input(harness, "/plan");
			const identity = harness.appended.at(-1)?.data.planId;
			const content = "# Plan: Direct unpublished exit\n";
			await checkpointPlan(harness, content, 0);

			const result = await input(harness, "/plan exit");

			assert.deepEqual(result, { action: "handled" });
			assert.equal(chooserCalls, 1);
			assert.equal(harness.appended.at(-1)?.data.active, false);
			assert.equal(harness.appended.at(-1)?.data.planId, identity);
			assert.equal(harness.appended.at(-1)?.data.checkpointRevision, 1);
			assert.equal(harness.appended.at(-1)?.data.publishedPath, undefined);
			assert.equal(harness.getAbortCount(), 0);

			await input(harness, "/plan");
			const context = await harness.handlers.get("context")?.(
				{ type: "context", messages: [] },
				harness.ctx,
			);
			assert.equal(context.messages.at(-1).content[1].text, content);
		});
	});

	it("falls back to direct safe exit when the exit chooser cannot be opened", async () => {
		await withHarness({
			select: async () => {
				throw new Error("simulated UI transport failure");
			},
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Chooser failure fallback\n", 0);

			const result = await input(harness, "/plan exit");

			assert.deepEqual(result, { action: "handled" });
			assert.equal(harness.appended.at(-1)?.data.active, false);
			assert.equal(harness.appended.at(-1)?.data.checkpointRevision, 1);
			assert.equal(harness.getAbortCount(), 0);
		});
	});

	it("exits directly from the no-checkpoint chooser without starting an agent", async () => {
		let chooserCalls = 0;
		await withHarness({
			select: async () => {
				chooserCalls += 1;
				return undefined;
			},
		}, async (harness) => {
			await input(harness, "/plan");
			const identity = harness.appended.at(-1)?.data.planId;

			const result = await input(harness, "/plan exit");

			assert.deepEqual(result, { action: "handled" });
			assert.equal(chooserCalls, 1);
			assert.equal(harness.appended.at(-1)?.data.active, false);
			assert.equal(harness.appended.at(-1)?.data.planId, identity);
			assert.equal(harness.appended.at(-1)?.data.checkpointRevision, undefined);
			assert.equal(harness.getAbortCount(), 0);
		});
	});

	it("keeps Plan active when another RPC prompt starts while the no-checkpoint exit chooser is open", async () => {
		let agentIdle = true;
		let markSelectionStarted: (() => void) | undefined;
		let resolveSelection: ((choice: string | undefined) => void) | undefined;
		const selectionStarted = new Promise<void>((resolve) => {
			markSelectionStarted = resolve;
		});
		const selection = new Promise<string | undefined>((resolve) => {
			resolveSelection = resolve;
		});
		await withHarness({
			isIdle: () => agentIdle,
			select: async () => {
				markSelectionStarted?.();
				return selection;
			},
		}, async (harness) => {
			try {
				await input(harness, "/plan");
				const exitPromise = input(harness, "/plan exit");
				await selectionStarted;

				assert.deepEqual(
					await input(harness, "Concurrent RPC prompt without a checkpoint"),
					{ action: "continue" },
				);
				agentIdle = false;
				resolveSelection?.("Exit without publishing");
				assert.deepEqual(await exitPromise, { action: "handled" });

				assert.equal(harness.appended.at(-1)?.data.active, true);
				assert.equal(harness.getActiveTools().includes("create_plan"), true);
				assert.equal(harness.getActiveTools().includes("write"), false);
			} finally {
				resolveSelection?.(undefined);
			}
		});
	});

	it("finalizes from the no-checkpoint chooser and avoids reentrant settled fallbacks", async () => {
		let chooserCalls = 0;
		let markFallbackStarted: (() => void) | undefined;
		let resolveFallback: ((choice: string | undefined) => void) | undefined;
		const fallbackStarted = new Promise<void>((resolve) => {
			markFallbackStarted = resolve;
		});
		const fallbackChoice = new Promise<string | undefined>((resolve) => {
			resolveFallback = resolve;
		});
		await withHarness({
			select: async (_title, choices) => {
				chooserCalls += 1;
				if (choices.includes("Finalize before exit")) return "Finalize before exit";
				markFallbackStarted?.();
				return fallbackChoice;
			},
		}, async (harness) => {
			try {
				await input(harness, "/plan");
				const lifecycle = await input(harness, "/plan exit");
				assert.equal(lifecycle.action, "dispatched");
				assert.equal(harness.appended.at(-1)?.data.approval, undefined);
				await harness.handlers.get("before_agent_start")?.(
					{
						type: "before_agent_start",
						prompt: lifecycle.text,
						systemPrompt: "base",
						systemPromptOptions: {},
					},
					harness.ctx,
				);

				const firstSettled = harness.handlers.get("agent_settled")?.(
					{ type: "agent_settled" },
					harness.ctx,
				);
				await fallbackStarted;
				await harness.handlers.get("agent_settled")?.(
					{ type: "agent_settled" },
					harness.ctx,
				);
				assert.equal(chooserCalls, 2);

				resolveFallback?.("Continue planning");
				await firstSettled;
				assert.equal(harness.appended.at(-1)?.data.active, true);
				assert.equal(harness.getAbortCount(), 0);
			} finally {
				resolveFallback?.(undefined);
			}
		});
	});

	it("reuses direct exact exit approval when finalization leaves the checkpoint unchanged", async () => {
		let chooserCalls = 0;
		const reviewMessages: string[] = [];
		await withHarness({
			select: async () => {
				chooserCalls += 1;
				return "Create plan";
			},
			confirm: async (_title, message) => {
				reviewMessages.push(message);
				return true;
			},
		}, async (harness) => {
			await input(harness, "/plan");
			const checkpointResult = await checkpointPlan(
				harness,
				"# Plan: Reuse direct exact approval\n",
				0,
			);

			const lifecycle = await input(harness, "/plan exit");

			assert.equal(lifecycle.action, "dispatched");
			const approved = harness.appended.at(-1)?.data.approval;
			assert.deepEqual(approved, {
				action: "exit",
				kind: "create",
				revision: 1,
				digest: checkpointResult.details.digest,
				path: harness.appended.at(-1)?.data.candidatePath,
			});
			assert.equal(chooserCalls, 1);
			assert.equal(reviewMessages.length, 1);
			assert.match(reviewMessages[0] ?? "", /Reuse direct exact approval/);

			await harness.handlers.get("before_agent_start")?.(
				{
					type: "before_agent_start",
					prompt: lifecycle.text,
					systemPrompt: "base",
					systemPromptOptions: {},
				},
				harness.ctx,
			);
			const gate = await harness.handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolCallId: "reuse-direct-exit-approval",
					toolName: "create_plan",
					input: { revision: 1 },
				},
				harness.ctx,
			);

			assert.equal(gate?.block, undefined);
			assert.equal(chooserCalls, 1);
			assert.equal(reviewMessages.length, 1);
		});
	});

	it("verifies and binds the exact update baseline before direct exit approval", async () => {
		let verificationCalls = 0;
		let chooserCalls = 0;
		let confirmationCalls = 0;
		await withHarness({
			verifyPlanFileDigest: async (...args) => {
				verificationCalls += 1;
				return verifyPlanFileDigest(...args);
			},
			select: async () => {
				chooserCalls += 1;
				assert.equal(verificationCalls, 1);
				return "Update plan";
			},
			confirm: async () => {
				confirmationCalls += 1;
				return true;
			},
		}, async (harness) => {
			await input(harness, "/plan");
			const firstCheckpoint = await checkpointPlan(harness, "# Plan: Update baseline one\n", 0);
			const firstPublication = await publishLatest(harness, 1);
			const secondCheckpoint = await checkpointPlan(
				harness,
				"# Plan: Update baseline two\n\nExact changed bytes.\n",
				1,
			);

			const lifecycle = await input(harness, "/plan exit");

			assert.equal(lifecycle.action, "dispatched");
			assert.equal(chooserCalls, 1);
			assert.equal(verificationCalls, 1);
			assert.equal(confirmationCalls, 2);
			assert.deepEqual(harness.appended.at(-1)?.data.approval, {
				action: "exit",
				kind: "update",
				revision: 2,
				digest: secondCheckpoint.details.digest,
				path: firstPublication.details.path,
				expectedPublishedDigest: firstCheckpoint.details.digest,
			});

			await harness.handlers.get("before_agent_start")?.(
				{
					type: "before_agent_start",
					prompt: lifecycle.text,
					systemPrompt: "base",
					systemPromptOptions: {},
				},
				harness.ctx,
			);
			const gate = await harness.handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolCallId: "reuse-direct-update-approval",
					toolName: "create_plan",
					input: { revision: 2 },
				},
				harness.ctx,
			);
			assert.equal(gate?.block, undefined);
			assert.equal(verificationCalls, 2);
			assert.equal(chooserCalls, 1);
			assert.equal(confirmationCalls, 2);
		});
	});

	it("resolves a first-create collision before direct exact exit approval", async () => {
		const reviewMessages: string[] = [];
		await withHarness({
			select: async () => "Create plan",
			confirm: async (_title, message) => {
				reviewMessages.push(message);
				return true;
			},
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Direct collision resolution\n", 0);
			const originalPath = harness.appended.at(-1)?.data.candidatePath;
			await mkdir(dirname(join(harness.ctx.cwd, originalPath)), { recursive: true });
			await writeFile(join(harness.ctx.cwd, originalPath), "existing plan");

			const lifecycle = await input(harness, "/plan exit");

			const approvedPath = harness.appended.at(-1)?.data.approval?.path;
			assert.equal(lifecycle.action, "dispatched");
			assert.notEqual(approvedPath, originalPath);
			assert.equal(harness.appended.at(-1)?.data.candidatePath, approvedPath);
			assert.match(
				reviewMessages[0] ?? "",
				new RegExp(String(approvedPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			);
			assert.equal(await readFile(join(harness.ctx.cwd, originalPath), "utf8"), "existing plan");
		});
	});

	it("requires exact-content reapproval when exit finalization checkpoints a new revision", async () => {
		let chooserCalls = 0;
		const reviewMessages: string[] = [];
		await withHarness({
			select: async () => {
				chooserCalls += 1;
				return "Create plan";
			},
			confirm: async (_title, message) => {
				reviewMessages.push(message);
				return true;
			},
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Direct approval revision one\n", 0);
			const lifecycle = await input(harness, "/plan exit");
			assert.equal(lifecycle.action, "dispatched");
			assert.equal(harness.appended.at(-1)?.data.approval?.revision, 1);
			await harness.handlers.get("before_agent_start")?.(
				{
					type: "before_agent_start",
					prompt: lifecycle.text,
					systemPrompt: "base",
					systemPromptOptions: {},
				},
				harness.ctx,
			);

			const changedContent = "# Plan: Reapproved revision two\n\nMaterial finalization change.\n";
			const changed = await checkpointPlan(harness, changedContent, 1);
			assert.equal(harness.appended.at(-1)?.data.approval, undefined);
			const gate = await harness.handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolCallId: "reapprove-changed-exit",
					toolName: "create_plan",
					input: { revision: 2 },
				},
				harness.ctx,
			);

			assert.equal(gate?.block, undefined);
			assert.equal(chooserCalls, 2);
			assert.equal(reviewMessages.length, 2);
			assert.doesNotMatch(reviewMessages[0] ?? "", /Material finalization change/);
			assert.match(reviewMessages[1] ?? "", /Material finalization change/);
			assert.equal(harness.appended.at(-1)?.data.approval?.revision, 2);
			assert.equal(harness.appended.at(-1)?.data.approval?.digest, changed.details.digest);
		});
	});

	it("offers direct exit again after model/auth preflight fails before before_agent_start", async () => {
		let chooserCalls = 0;
		await withHarness({
			select: async () => {
				chooserCalls += 1;
				return chooserCalls === 1 ? "Create plan" : undefined;
			},
			confirm: async () => true,
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Preflight-independent exit\n", 0);

			const attemptedFinalization = await input(harness, "/plan exit");
			assert.equal(attemptedFinalization.action, "dispatched");
			assert.ok(harness.appended.at(-1)?.data.approval);

			// Simulate model/auth preflight failure: Pi emits neither before_agent_start nor agent_settled.
			const repeatedExit = await input(harness, "/plan exit");

			assert.deepEqual(repeatedExit, { action: "handled" });
			assert.equal(chooserCalls, 2);
			assert.equal(harness.appended.at(-1)?.data.active, false);
			assert.equal(harness.appended.at(-1)?.data.approval, undefined);
			assert.equal(harness.getAbortCount(), 0);
		});
	});

	it("offers direct safe exit when an exit-finalization run settles without create_plan", async () => {
		const chooserOptions: string[][] = [];
		await withHarness({
			select: async (_title, choices) => {
				chooserOptions.push(choices);
				return chooserOptions.length === 1 ? "Create plan" : undefined;
			},
			confirm: async () => true,
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Settled exit fallback\n", 0);
			const lifecycle = await input(harness, "/plan exit");
			assert.equal(lifecycle.action, "dispatched");
			await harness.handlers.get("before_agent_start")?.(
				{
					type: "before_agent_start",
					prompt: lifecycle.text,
					systemPrompt: "base",
					systemPromptOptions: {},
				},
				harness.ctx,
			);

			await harness.handlers.get("agent_settled")?.(
				{ type: "agent_settled" },
				harness.ctx,
			);

			assert.deepEqual(chooserOptions[1], [
				"Exit without publishing",
				"Continue planning",
			]);
			assert.equal(harness.appended.at(-1)?.data.active, false);
			assert.equal(harness.appended.at(-1)?.data.checkpointRevision, 1);
			assert.equal(harness.appended.at(-1)?.data.approval, undefined);
			assert.equal(harness.getAbortCount(), 0);
		});
	});

	it("invalidates an awaiting settled fallback across session shutdown and switch", async () => {
		const fallbackStarted = Promise.withResolvers<void>();
		const fallbackDecision = Promise.withResolvers<string | undefined>();
		let fallbackSignal: AbortSignal | undefined;
		await withHarness({
			select: async (_title, choices, options) => {
				if (choices.includes("Finalize before exit")) return "Finalize before exit";
				fallbackSignal = options?.signal;
				fallbackStarted.resolve();
				return fallbackDecision.promise;
			},
		}, async (harness) => {
			let settlement: Promise<unknown> | undefined;
			try {
				await input(harness, "/plan");
				const lifecycle = await input(harness, "/plan exit");
				assert.equal(lifecycle.action, "dispatched");
				await harness.handlers.get("before_agent_start")?.(
					{
						type: "before_agent_start",
						prompt: lifecycle.text,
						systemPrompt: "base",
						systemPromptOptions: {},
					},
					harness.ctx,
				);
				settlement = harness.handlers.get("agent_settled")?.(
					{ type: "agent_settled" },
					harness.ctx,
				);
				await fallbackStarted.promise;

				const observed = observeEntryCoordination(harness);
				const replacement = createHarness({ cwd: harness.ctx.cwd, sessionId: "session-switched" });
				const replacementCtx = replacement.ctx;
				await harness.handlers.get("session_shutdown")?.(
					{ type: "session_shutdown", reason: "resume", targetSessionFile: "replacement.jsonl" },
					harness.ctx,
				);
				const entriesBeforeReplacement = harness.appended.length;
				const staleContextAccesses = makeContextStale(harness.ctx);
				await replacement.handlers.get("session_start")?.(
					{ type: "session_start", reason: "resume", previousSessionFile: "old-session.jsonl" },
					replacementCtx,
				);
				assert.deepEqual(
					await inputWithContext(replacement, replacementCtx, "/plan"),
					{ action: "handled" },
				);
				const lastPersistedState = replacement.appended.at(-1)?.data;
				assert.equal(lastPersistedState?.active, true);
				assert.notEqual(lastPersistedState.planId, harness.appended.at(-1)?.data.planId);
				const replacementTools = [...replacement.getActiveTools()];
				assert.equal(replacementTools.includes("create_plan"), true);
				assert.equal(replacementTools.includes("write"), false);
				const replacementCoordination = observeEntryCoordination(replacement);
				const entriesAfterReplacement = replacement.appended.length;

				fallbackDecision.resolve("Exit without publishing");
				await settlement;

				assert.equal(fallbackSignal?.aborted, true);
				assert.deepEqual(staleContextAccesses, []);
				assert.equal(replacement.appended.length, entriesAfterReplacement);
				assert.equal(replacement.appended.at(-1)?.data, lastPersistedState);
				assert.equal(lastPersistedState.active, true);
				assert.deepEqual(replacement.getActiveTools(), replacementTools);
				assert.equal(replacementCoordination.provider.inspect().phase, "active");
				// The outgoing callback must not append to its abandoned session either.
				assert.equal(harness.appended.length, entriesBeforeReplacement);
				assert.equal(observed.provider.inspect().phase, "disposed");
				assert.equal(observed.released(), 0);
				assert.equal(harness.getActiveTools().includes("create_plan"), false);
				assert.equal(harness.getActiveTools().includes("write"), true);
			} finally {
				fallbackDecision.resolve(undefined);
				await settlement?.catch(() => undefined);
			}
		});
	});

	it("does not apply a settled fallback decision to a sibling branch after /tree", async () => {
		const fallbackStarted = Promise.withResolvers<void>();
		const fallbackDecision = Promise.withResolvers<string | undefined>();
		await withHarness({
			select: async (_title, choices) => {
				if (choices.includes("Finalize before exit")) return "Finalize before exit";
				fallbackStarted.resolve();
				return fallbackDecision.promise;
			},
		}, async (harness) => {
			try {
				await input(harness, "/plan");
				const initialStateEntry = harness.allEntries[0];

				harness.setBranch([initialStateEntry]);
				await harness.handlers.get("session_tree")?.(
					{ type: "session_tree", oldLeafId: "root", newLeafId: "fallback-branch-b" },
					harness.ctx,
				);
				const branchB = [...harness.ctx.sessionManager.getBranch()];

				harness.setBranch([initialStateEntry]);
				await harness.handlers.get("session_tree")?.(
					{ type: "session_tree", oldLeafId: "fallback-branch-b", newLeafId: "fallback-branch-a" },
					harness.ctx,
				);
				const lifecycle = await input(harness, "/plan exit");
				assert.equal(lifecycle.action, "dispatched");
				await harness.handlers.get("before_agent_start")?.(
					{
						type: "before_agent_start",
						prompt: lifecycle.text,
						systemPrompt: "base",
						systemPromptOptions: {},
					},
					harness.ctx,
				);
				const settlement = harness.handlers.get("agent_settled")?.(
					{ type: "agent_settled" },
					harness.ctx,
				);
				await fallbackStarted.promise;

				harness.setBranch(branchB);
				await harness.handlers.get("session_tree")?.(
					{ type: "session_tree", oldLeafId: "fallback-branch-a", newLeafId: "fallback-branch-b" },
					harness.ctx,
				);
				fallbackDecision.resolve("Exit without publishing");
				await settlement;

				assert.equal(harness.appended.at(-1)?.data.active, true);
				assert.equal(harness.appended.at(-1)?.data.approval, undefined);
				assert.equal(harness.getActiveTools().includes("create_plan"), true);
				assert.equal(harness.getActiveTools().includes("write"), false);
			} finally {
				fallbackDecision.resolve(undefined);
			}
		});
	});

	it("aborts a signal-aware settled fallback when a non-lifecycle agent turn supersedes it", async () => {
		let agentIdle = true;
		const fallbackStarted = Promise.withResolvers<void>();
		let fallbackSignal: AbortSignal | undefined;
		await withHarness({
			confirm: async () => true,
			isIdle: () => agentIdle,
			select: async (_title, choices, options) => {
				if (choices.includes("Create plan")) return "Create plan";
				fallbackSignal = options?.signal;
				assert.ok(fallbackSignal);
				fallbackStarted.resolve();
				return new Promise<string | undefined>((resolve) => {
					const finish = () => resolve(undefined);
					if (fallbackSignal?.aborted) queueMicrotask(finish);
					else fallbackSignal?.addEventListener("abort", finish, { once: true });
				});
			},
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Superseded settled fallback\n", 0);
			const lifecycle = await input(harness, "/plan exit");
			assert.equal(lifecycle.action, "dispatched");
			await harness.handlers.get("before_agent_start")?.(
				{
					type: "before_agent_start",
					prompt: lifecycle.text,
					systemPrompt: "base",
					systemPromptOptions: {},
				},
				harness.ctx,
			);

			const fallbackPromise = harness.handlers.get("agent_settled")?.(
				{ type: "agent_settled" },
				harness.ctx,
			);
			assert.ok(fallbackPromise);
			await fallbackStarted.promise;
			agentIdle = false;
			await harness.handlers.get("agent_start")?.(
				{ type: "agent_start" },
				harness.ctx,
			);
			agentIdle = true;

			await assertOperationSettlesPromptly(fallbackPromise);
			assert.equal(fallbackSignal.aborted, true);
			assert.deepEqual(await input(harness, "/plan status"), { action: "handled" });
			assert.equal(harness.appended.at(-1)?.data.active, true);
			assert.equal(harness.appended.at(-1)?.data.approval, undefined);
			assert.equal(harness.getActiveTools().includes("create_plan"), true);
			assert.equal(harness.getActiveTools().includes("write"), false);
			assert.equal(harness.getAbortCount(), 0);
		});
	});

	it("uses Exit without publishing as the dirty-plan default and preserves the restorable checkpoint", async () => {
		await withHarness({ confirm: async () => true }, async (harness) => {
			await input(harness, "/plan");
			const firstContent = "# Plan: Published revision\n";
			await checkpointPlan(harness, firstContent, 0);
			const publication = await publishLatest(harness, 1);
			const dirtyContent = "# Plan: Unpublished revision\n\nMaterial change.\n";
			await checkpointPlan(harness, dirtyContent, 1);

			const result = await input(harness, "/plan exit");

			assert.deepEqual(result, { action: "handled" });
			assert.equal(harness.getAbortCount(), 0);
			assert.equal(harness.appended.at(-1)?.data.active, false);
			assert.equal(harness.appended.at(-1)?.data.checkpointRevision, 2);
			assert.equal(await readFile(join(harness.ctx.cwd, publication.details.path), "utf8"), firstContent);

			await input(harness, "/plan");
			const context = await harness.handlers.get("context")?.(
				{ type: "context", messages: [] },
				harness.ctx,
			);
			assert.equal(context.messages.at(-1).content[1].text, dirtyContent);
		});
	});

	it("blocks /plan save after a queued RPC user message is delivered with an empty live queue", async () => {
		let pendingMessages = false;
		let confirmationAttempts = 0;
		await withHarness({
			confirm: async () => {
				confirmationAttempts += 1;
				return true;
			},
			hasPendingMessages: () => pendingMessages,
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Stale queued save\n", 0);
			const lifecycle = await startLifecycleCommand(harness, "/plan save");
			await endUserMessage(harness, lifecycle.text);

			pendingMessages = true;
			assert.equal(harness.ctx.hasPendingMessages(), true);
			pendingMessages = false;
			assert.equal(harness.ctx.hasPendingMessages(), false);
			await endUserMessage(harness, "Queued RPC refinement delivered without input");

			const gate = await harness.handlers.get("tool_call")?.({
				type: "tool_call",
				toolCallId: "stale-queued-save",
				toolName: "create_plan",
				input: { revision: 1 },
			}, harness.ctx);

			assert.equal(gate?.block, true);
			assert.match(gate?.reason ?? "", /\/plan save or \/plan exit|superseded/i);
			assert.equal(confirmationAttempts, 0);
			assert.equal(harness.appended.at(-1)?.data.active, true);
		});
	});

	it("blocks /plan exit after a queued extension user message is delivered with an empty live queue", async () => {
		let pendingMessages = false;
		let selectionAttempts = 0;
		await withHarness({
			select: async () => {
				selectionAttempts += 1;
				return "Create plan";
			},
			confirm: async () => true,
			hasPendingMessages: () => pendingMessages,
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Stale queued exit\n", 0);
			const lifecycle = await startLifecycleCommand(harness, "/plan exit");
			await endUserMessage(harness, lifecycle.text);

			pendingMessages = true;
			assert.equal(harness.ctx.hasPendingMessages(), true);
			pendingMessages = false;
			assert.equal(harness.ctx.hasPendingMessages(), false);
			await endUserMessage(harness, "Queued extension refinement delivered without input");

			const gate = await harness.handlers.get("tool_call")?.({
				type: "tool_call",
				toolCallId: "stale-queued-exit",
				toolName: "create_plan",
				input: { revision: 1 },
			}, harness.ctx);

			assert.equal(gate?.block, true);
			assert.match(gate?.reason ?? "", /\/plan save or \/plan exit|superseded/i);
			assert.equal(selectionAttempts, 1);
			assert.equal(harness.appended.at(-1)?.data.approval, undefined);
			assert.equal(harness.appended.at(-1)?.data.active, true);
			assert.equal(harness.getAbortCount(), 0);
		});
	});

	it("exempts only the first exact lifecycle user message from superseding authorization", async () => {
		await withHarness({ hasUI: false }, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Single lifecycle exemption\n", 0);
			const lifecycle = await startLifecycleCommand(harness, "/plan save");

			await endUserMessage(harness, lifecycle.text);
			const retained = await harness.handlers.get("tool_call")?.({
				type: "tool_call",
				toolCallId: "first-lifecycle-message",
				toolName: "create_plan",
				input: { revision: 1 },
			}, harness.ctx);
			assert.equal(retained?.block, true);
			assert.match(retained?.reason ?? "", /Interactive UI.*required/i);

			await endUserMessage(harness, lifecycle.text);
			const superseded = await harness.handlers.get("tool_call")?.({
				type: "tool_call",
				toolCallId: "repeated-lifecycle-message",
				toolName: "create_plan",
				input: { revision: 1 },
			}, harness.ctx);
			assert.equal(superseded?.block, true);
			assert.match(superseded?.reason ?? "", /Use \/plan save or \/plan exit/i);
			assert.equal(harness.appended.at(-1)?.data.active, true);
		});
	});

	it("blocks a save publication when queued input is present after asynchronous preflight", async () => {
		let confirmationAttempts = 0;
		await withHarness({
			confirm: async () => {
				confirmationAttempts += 1;
				return true;
			},
			hasPendingMessages: () => true,
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Superseded save preflight\n", 0);
			await startLifecycleCommand(harness, "/plan save");

			const gate = await harness.handlers.get("tool_call")?.({
				type: "tool_call",
				toolCallId: "superseded-save-preflight",
				toolName: "create_plan",
				input: { revision: 1 },
			}, harness.ctx);

			assert.equal(gate?.block, true);
			assert.match(gate?.reason ?? "", /newer user input.*superseded/i);
			assert.equal(confirmationAttempts, 0);
			assert.equal(harness.appended.at(-1)?.data.active, true);
		});
	});

	it("does not start exit finalization when queued input is present after direct preflight", async () => {
		let chooserAttempts = 0;
		await withHarness({
			select: async () => {
				chooserAttempts += 1;
				return "Create plan";
			},
			confirm: async () => true,
			hasPendingMessages: () => true,
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Superseded preflight\n", 0);

			const result = await input(harness, "/plan exit");

			assert.deepEqual(result, { action: "handled" });
			assert.equal(chooserAttempts, 0);
			assert.equal(harness.appended.at(-1)?.data.approval, undefined);
			assert.equal(harness.appended.at(-1)?.data.active, true);
			assert.equal(harness.getAbortCount(), 0);
		});
	});

	it("aborts a signal-aware direct exit chooser when a newer RPC prompt arrives", async () => {
		const selectionStarted = Promise.withResolvers<void>();
		let selectionSignal: AbortSignal | undefined;
		await withHarness({
			confirm: async () => true,
			select: async (_title, _choices, options) => {
				selectionSignal = options?.signal;
				assert.ok(selectionSignal);
				selectionStarted.resolve();
				return new Promise<string | undefined>((resolve) => {
					const finish = () => resolve(undefined);
					if (selectionSignal?.aborted) queueMicrotask(finish);
					else selectionSignal?.addEventListener("abort", finish, { once: true });
				});
			},
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Concurrent direct exit\n", 0);
			const exitPromise = input(harness, "/plan exit");
			await selectionStarted.promise;

			assert.deepEqual(
				await input(harness, "Concurrent RPC refinement"),
				{ action: "continue" },
			);
			const result = await assertOperationSettlesPromptly(exitPromise);

			assert.equal(selectionSignal.aborted, true);
			assert.deepEqual(result, { action: "handled" });
			assert.equal(harness.appended.at(-1)?.data.active, true);
			assert.equal(harness.appended.at(-1)?.data.approval, undefined);
			assert.equal(harness.getActiveTools().includes("create_plan"), true);
			assert.equal(harness.getActiveTools().includes("write"), false);
			assert.match(harness.notifications.at(-1)?.message ?? "", /newer input|superseded|active/i);
		});
	});

	it("keeps Plan active when a custom agent turn starts and settles while the direct exit chooser is open", async () => {
		let agentIdle = true;
		let markSelectionStarted: (() => void) | undefined;
		let resolveSelection: ((choice: string | undefined) => void) | undefined;
		const selectionStarted = new Promise<void>((resolve) => {
			markSelectionStarted = resolve;
		});
		const selection = new Promise<string | undefined>((resolve) => {
			resolveSelection = resolve;
		});
		await withHarness({
			isIdle: () => agentIdle,
			hasPendingMessages: () => false,
			select: async () => {
				markSelectionStarted?.();
				return selection;
			},
		}, async (harness) => {
			try {
				await input(harness, "/plan");
				await checkpointPlan(harness, "# Plan: Extension chooser supersession\n", 0);
				const exitPromise = input(harness, "/plan exit");
				await selectionStarted;

				assert.equal(harness.ctx.hasPendingMessages(), false);
				agentIdle = false;
				await harness.handlers.get("agent_start")?.(
					{ type: "agent_start" },
					harness.ctx,
				);
				agentIdle = true;
				await harness.handlers.get("agent_settled")?.(
					{ type: "agent_settled" },
					harness.ctx,
				);
				assert.equal(harness.ctx.hasPendingMessages(), false);

				resolveSelection?.("Exit without publishing");
				assert.deepEqual(await exitPromise, { action: "handled" });
				assert.equal(harness.appended.at(-1)?.data.active, true);
				assert.equal(harness.getActiveTools().includes("create_plan"), true);
				assert.equal(harness.getActiveTools().includes("write"), false);
				assert.match(harness.notifications.at(-1)?.message ?? "", /newer input|superseded|active/i);
			} finally {
				resolveSelection?.(undefined);
			}
		});
	});

	it("rechecks queued input before direct Exit without publishing deactivates Plan mode", async () => {
		let pendingMessages = false;
		let markSelectionStarted: (() => void) | undefined;
		let resolveSelection: ((choice: string | undefined) => void) | undefined;
		const selectionStarted = new Promise<void>((resolve) => {
			markSelectionStarted = resolve;
		});
		const selection = new Promise<string | undefined>((resolve) => {
			resolveSelection = resolve;
		});
		await withHarness({
			select: async () => {
				markSelectionStarted?.();
				return selection;
			},
			hasPendingMessages: () => pendingMessages,
		}, async (harness) => {
			try {
				await input(harness, "/plan");
				await checkpointPlan(harness, "# Plan: Preserve for queued input\n", 0);
				const exitPromise = input(harness, "/plan exit");
				await selectionStarted;

				pendingMessages = true;
				resolveSelection?.("Exit without publishing");
				const result = await exitPromise;

				assert.deepEqual(result, { action: "handled" });
				assert.equal(harness.appended.at(-1)?.data.active, true);
				assert.equal(harness.appended.at(-1)?.data.approval, undefined);
				assert.equal(harness.getAbortCount(), 0);
			} finally {
				resolveSelection?.(undefined);
			}
		});
	});

	it("does not bind direct exit approval when an RPC follow-up queues during confirmation", async () => {
		let pendingMessages = false;
		let markConfirmationStarted: (() => void) | undefined;
		let resolveConfirmation: ((approved: boolean) => void) | undefined;
		const confirmationStarted = new Promise<void>((resolve) => {
			markConfirmationStarted = resolve;
		});
		const confirmation = new Promise<boolean>((resolve) => {
			resolveConfirmation = resolve;
		});
		await withHarness({
			select: async () => "Create plan",
			confirm: async () => {
				markConfirmationStarted?.();
				return confirmation;
			},
			hasPendingMessages: () => pendingMessages,
		}, async (harness) => {
			try {
				await input(harness, "/plan");
				await checkpointPlan(harness, "# Plan: Superseded confirmation\n", 0);
				const exitPromise = input(harness, "/plan exit");
				await confirmationStarted;

				pendingMessages = true;
				resolveConfirmation?.(true);
				const result = await exitPromise;

				assert.deepEqual(result, { action: "handled" });
				assert.equal(harness.appended.at(-1)?.data.active, true);
				assert.equal(harness.appended.at(-1)?.data.approval, undefined);
				assert.equal(harness.getAbortCount(), 0);
			} finally {
				resolveConfirmation?.(false);
			}
		});
	});

	it("combines the RPC abort signal with package lifecycle cancellation and releases authorization", async () => {
		const controller = new AbortController();
		const approvalStarted = Promise.withResolvers<void>();
		let receivedSignal: AbortSignal | undefined;
		let confirmationCalls = 0;
		await withHarness({
			signal: controller.signal,
			confirm: async (_title, _message, options) => {
				confirmationCalls += 1;
				receivedSignal = options?.signal;
				approvalStarted.resolve();
				if (!options?.signal) throw new Error("RPC approval did not receive an abort signal.");
				return new Promise<boolean>((_resolve, reject) => {
					const rejectAbort = () => reject(options.signal?.reason);
					if (options.signal.aborted) rejectAbort();
					else options.signal.addEventListener("abort", rejectAbort, { once: true });
				});
			},
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Abort RPC approval\n", 0);
			await startLifecycleCommand(harness, "/plan save");
			const approval = harness.handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolCallId: "abort-rpc-approval",
					toolName: "create_plan",
					input: { revision: 1 },
				},
				harness.ctx,
			);
			await approvalStarted.promise;
			controller.abort();
			const blocked = await approval;

			assert.notEqual(receivedSignal, controller.signal);
			assert.equal(receivedSignal?.aborted, true);
			assert.equal(blocked?.block, true);
			assert.match(blocked?.reason ?? "", /approval failed/i);
			assert.equal(harness.appended.at(-1)?.data.active, true);
			assert.equal(harness.appended.at(-1)?.data.approval, undefined);

			harness.ctx.signal = new AbortController().signal;
			const staleAuthorization = await harness.handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolCallId: "after-aborted-rpc-approval",
					toolName: "create_plan",
					input: { revision: 1 },
				},
				harness.ctx,
			);
			assert.equal(staleAuthorization?.block, true);
			assert.match(staleAuthorization?.reason ?? "", /Use \/plan save or \/plan exit/i);
			assert.equal(confirmationCalls, 1);

			const readAfterAbort = await harness.handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolCallId: "read-after-aborted-rpc-approval",
					toolName: "read",
					input: { path: "README.md" },
				},
				harness.ctx,
			);
			assert.equal(readAfterAbort?.block, undefined);
		});
	});

	it("does not create a plan or exit when create_plan is aborted in the mutation queue", async () => {
		await withHarness({
			select: async () => "Create plan",
			confirm: async () => true,
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Abort queued create publication\n", 0);
			await startLifecycleCommand(harness, "/plan exit");
			const call = {
				type: "tool_call",
				toolCallId: "abort-queued-create",
				toolName: "create_plan",
				input: { revision: 1 },
			};
			assert.equal((await harness.handlers.get("tool_call")?.(call, harness.ctx))?.block, undefined);
			const candidatePath = harness.appended.at(-1)?.data.candidatePath;
			assert.equal(typeof candidatePath, "string");
			const absolutePath = join(harness.ctx.cwd, candidatePath);
			await mkdir(dirname(absolutePath), { recursive: true });
			const occupied = await occupyFileMutationQueue(absolutePath);
			const controller = new AbortController();
			const execution = harness.registeredTools.get("create_plan").execute(
				call.toolCallId,
				call.input,
				controller.signal,
				undefined,
				harness.ctx,
			);

			try {
				await assertOperationWaitsForQueue(execution);
				controller.abort();
			} finally {
				occupied.release();
				await occupied.done;
			}

			await assert.rejects(execution, { name: "AbortError" });
			await harness.handlers.get("tool_result")?.(
				{ ...call, type: "tool_result", isError: true },
				harness.ctx,
			);
			await assert.rejects(readFile(absolutePath, "utf8"), { code: "ENOENT" });
			assert.deepEqual(
				(await readdir(dirname(absolutePath))).filter((name) => name.endsWith(".tmp")),
				[],
			);
			assert.equal(harness.appended.at(-1)?.data.active, true);
			assert.equal(harness.appended.at(-1)?.data.publishedPath, undefined);
			assert.equal(harness.appended.at(-1)?.data.completedPublication, undefined);
			assert.equal(harness.getAbortCount(), 0);
		});
	});

	it("does not update a plan or exit when create_plan is aborted in the mutation queue", async () => {
		await withHarness({
			select: async () => "Update plan",
			confirm: async () => true,
		}, async (harness) => {
			await input(harness, "/plan");
			const publishedContent = "# Plan: Abort queued update revision one\n";
			await checkpointPlan(harness, publishedContent, 0);
			const firstPublication = await publishLatest(harness, 1);
			await checkpointPlan(
				harness,
				"# Plan: Abort queued update revision two\n",
				1,
			);
			await startLifecycleCommand(harness, "/plan exit");
			const call = {
				type: "tool_call",
				toolCallId: "abort-queued-update",
				toolName: "create_plan",
				input: { revision: 2 },
			};
			assert.equal((await harness.handlers.get("tool_call")?.(call, harness.ctx))?.block, undefined);
			const absolutePath = join(harness.ctx.cwd, firstPublication.details.path);
			const occupied = await occupyFileMutationQueue(absolutePath);
			const controller = new AbortController();
			const execution = harness.registeredTools.get("create_plan").execute(
				call.toolCallId,
				call.input,
				controller.signal,
				undefined,
				harness.ctx,
			);

			try {
				await assertOperationWaitsForQueue(execution);
				controller.abort();
			} finally {
				occupied.release();
				await occupied.done;
			}

			await assert.rejects(execution, { name: "AbortError" });
			await harness.handlers.get("tool_result")?.(
				{ ...call, type: "tool_result", isError: true },
				harness.ctx,
			);
			assert.equal(await readFile(absolutePath, "utf8"), publishedContent);
			assert.deepEqual(
				(await readdir(dirname(absolutePath))).filter((name) => name.endsWith(".tmp")),
				[],
			);
			assert.equal(harness.appended.at(-1)?.data.active, true);
			assert.equal(harness.appended.at(-1)?.data.publishedRevision, 1);
			assert.equal(harness.appended.at(-1)?.data.checkpointRevision, 2);
			assert.equal(harness.appended.at(-1)?.data.completedPublication, undefined);
			assert.equal(harness.getAbortCount(), 0);
		});
	});

	it("converts an approved exit to a durable save when an extension follow-up queues during a deferred write", async () => {
		let pendingMessages = false;
		await withHarness({
			select: async () => "Create plan",
			confirm: async () => true,
			hasPendingMessages: () => pendingMessages,
		}, async (harness) => {
			await input(harness, "/plan");
			const content = "# Plan: Superseded during write\n";
			await checkpointPlan(harness, content, 0);
			await startLifecycleCommand(harness, "/plan exit");
			const call = {
				type: "tool_call",
				toolCallId: "superseded-write",
				toolName: "create_plan",
				input: { revision: 1 },
			};
			assert.equal((await harness.handlers.get("tool_call")?.(call, harness.ctx))?.block, undefined);
			const candidatePath = harness.appended.at(-1)?.data.candidatePath;
			assert.equal(typeof candidatePath, "string");

			let markQueueHeld: (() => void) | undefined;
			let releaseQueue: (() => void) | undefined;
			const queueHeld = new Promise<void>((resolve) => {
				markQueueHeld = resolve;
			});
			const queueRelease = new Promise<void>((resolve) => {
				releaseQueue = resolve;
			});
			const heldMutation = withFileMutationQueue(
				join(harness.ctx.cwd, candidatePath),
				async () => {
					markQueueHeld?.();
					await queueRelease;
				},
			);
			await queueHeld;
			let execution: Promise<{
				terminate?: boolean;
				details: { path: string };
			}> | undefined;

			try {
				execution = harness.registeredTools.get("create_plan").execute(
					call.toolCallId,
					call.input,
					undefined,
					undefined,
					harness.ctx,
				);
				pendingMessages = true;

				releaseQueue?.();
				await heldMutation;
				const publication = await execution;
				assert.equal(publication.terminate, undefined);
				assert.equal(harness.appended.at(-1)?.data.completedPublication?.action, "save");
				assert.equal(await readFile(join(harness.ctx.cwd, publication.details.path), "utf8"), content);

				const resumed = createHarness({
					cwd: harness.ctx.cwd,
					sessionId: "session-a",
					sessionFile: join(harness.ctx.cwd, "session.jsonl"),
					entries: [...harness.allEntries],
				});
				await resumed.handlers.get("session_start")?.(
					{ type: "session_start", reason: "resume" },
					resumed.ctx,
				);
				assert.equal(resumed.appended.at(-1)?.data.active, true);
				assert.equal(resumed.appended.at(-1)?.data.completedPublication, undefined);

				await harness.handlers.get("tool_result")?.(
					{ ...call, type: "tool_result", details: publication.details, isError: false },
					harness.ctx,
				);
				assert.equal(harness.appended.at(-1)?.data.active, true);
				assert.equal(harness.getAbortCount(), 0);
				const nextTurn = await harness.handlers.get("before_agent_start")?.(
					{
						type: "before_agent_start",
						prompt: "Queue a newer Plan refinement",
						systemPrompt: "base",
						systemPromptOptions: {},
					},
					harness.ctx,
				);
				assert.match(nextTurn?.systemPrompt ?? "", /Plan mode is active/i);
			} finally {
				releaseQueue?.();
				await heldMutation;
				await execution?.catch(() => undefined);
			}
		});
	});

	it("persistently rewrites a completed exit when a queued follow-up appears before tool_result", async () => {
		let pendingMessages = false;
		await withHarness({
			select: async () => "Create plan",
			confirm: async () => true,
			hasPendingMessages: () => pendingMessages,
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Superseded after execute\n", 0);
			await startLifecycleCommand(harness, "/plan exit");
			const call = {
				type: "tool_call",
				toolCallId: "superseded-after-execute",
				toolName: "create_plan",
				input: { revision: 1 },
			};
			assert.equal((await harness.handlers.get("tool_call")?.(call, harness.ctx))?.block, undefined);
			const publication = await harness.registeredTools.get("create_plan").execute(
				call.toolCallId,
				call.input,
				undefined,
				undefined,
				harness.ctx,
			);
			assert.equal(publication.terminate, true);
			assert.equal(harness.appended.at(-1)?.data.completedPublication?.action, "exit");

			pendingMessages = true;
			await harness.handlers.get("tool_result")?.(
				{ ...call, type: "tool_result", details: publication.details, isError: false },
				harness.ctx,
			);

			assert.equal(
				harness.appended.some((entry: Entry) => entry.data.completedPublication?.action === "save"),
				true,
			);
			assert.equal(harness.appended.at(-1)?.data.active, true);
			assert.equal(harness.getAbortCount(), 0);

			const resumed = createHarness({
				cwd: harness.ctx.cwd,
				sessionId: "session-a",
				sessionFile: join(harness.ctx.cwd, "session.jsonl"),
				entries: [...harness.allEntries],
				hasPendingMessages: () => pendingMessages,
			});
			await resumed.handlers.get("session_start")?.(
				{ type: "session_start", reason: "resume" },
				resumed.ctx,
			);
			assert.equal(resumed.getActiveTools().includes("create_plan"), true);
		});
	});

	it("defers in-run Exit without publishing and keeps Plan active for a delivered custom continuation", async () => {
		let chooserCalls = 0;
		await withHarness({
			select: async () => {
				chooserCalls += 1;
				return chooserCalls === 1 ? "Create plan" : "Exit without publishing";
			},
			confirm: async () => true,
			hasPendingMessages: () => false,
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Deferred unpublished exit revision one\n", 0);
			const lifecycle = await input(harness, "/plan exit");
			assert.equal(lifecycle.action, "dispatched");
			await harness.handlers.get("before_agent_start")?.(
				{
					type: "before_agent_start",
					prompt: lifecycle.text,
					systemPrompt: "base",
					systemPromptOptions: {},
				},
				harness.ctx,
			);
			await checkpointPlan(harness, "# Plan: Deferred unpublished exit revision two\n", 1);

			const gate = await harness.handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolCallId: "deferred-exit-without-publication",
					toolName: "create_plan",
					input: { revision: 2 },
				},
				harness.ctx,
			);

			assert.equal(gate?.block, true);
			assert.equal(gate?.terminate, undefined);
			assert.equal(harness.appended.at(-1)?.data.active, true);
			assert.equal(harness.getAbortCount(), 0);
			assert.equal(harness.getActiveTools().includes("create_plan"), true);
			assert.equal(harness.getActiveTools().includes("write"), false);

			const sameBatchRead = await harness.handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolCallId: "same-batch-read-after-deferred-exit",
					toolName: "read",
					input: { path: "README.md" },
				},
				harness.ctx,
			);
			assert.equal(sameBatchRead?.block, true);
			assert.equal(sameBatchRead?.terminate, undefined);
			assert.match(sameBatchRead?.reason ?? "", /pending agent settlement/i);

			await harness.handlers.get("message_end")?.(
				{
					type: "message_end",
					message: {
						role: "custom",
						customType: "queued-unpublished-exit-regression",
						content: "Continue under Plan enforcement",
						display: false,
						timestamp: Date.now(),
					},
				},
				harness.ctx,
			);
			for (const trustedTool of [
				{
					type: "tool_call",
					toolCallId: "queued-read-after-deferred-exit",
					toolName: "read",
					input: { path: "README.md" },
				},
				{
					type: "tool_call",
					toolCallId: "queued-checkpoint-after-deferred-exit",
					toolName: "update_plan_draft",
					input: { content: "# Plan: Allowed queued revision\n", expectedRevision: 2 },
				},
			]) {
				assert.equal(
					(await harness.handlers.get("tool_call")?.(trustedTool, harness.ctx))?.block,
					undefined,
					trustedTool.toolName,
				);
			}

			await harness.handlers.get("agent_settled")?.(
				{ type: "agent_settled" },
				harness.ctx,
			);

			assert.equal(harness.appended.at(-1)?.data.active, true);
			assert.equal(harness.appended.at(-1)?.data.approval, undefined);
			assert.equal(harness.getActiveTools().includes("create_plan"), true);
			assert.equal(harness.getActiveTools().includes("write"), false);
			assert.equal(harness.getAbortCount(), 0);
		});
	});

	it("blocks every sibling tool while a completed exit settles and restores Plan tools after queued delivery", async () => {
		await withHarness({
			select: async () => "Create plan",
			confirm: async () => true,
			hasPendingMessages: () => false,
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Settlement barrier revision one\n", 0);
			await startLifecycleCommand(harness, "/plan exit");
			const publicationCall = {
				type: "tool_call",
				toolCallId: "settlement-barrier-publication",
				toolName: "create_plan",
				input: { revision: 1 },
			};
			assert.equal(
				(await harness.handlers.get("tool_call")?.(publicationCall, harness.ctx))?.block,
				undefined,
			);
			const publication = await harness.registeredTools.get("create_plan").execute(
				publicationCall.toolCallId,
				publicationCall.input,
				undefined,
				undefined,
				harness.ctx,
			);
			await harness.handlers.get("tool_result")?.(
				{ ...publicationCall, type: "tool_result", details: publication.details, isError: false },
				harness.ctx,
			);

			for (const sibling of [
				{
					type: "tool_call",
					toolCallId: "settlement-barrier-checkpoint",
					toolName: "update_plan_draft",
					input: { content: "# Plan: Blocked revision two\n", expectedRevision: 1 },
				},
				{
					type: "tool_call",
					toolCallId: "settlement-barrier-read",
					toolName: "read",
					input: { path: "README.md" },
				},
			]) {
				const blocked = await harness.handlers.get("tool_call")?.(sibling, harness.ctx);
				assert.equal(blocked?.block, true);
				assert.match(blocked?.reason ?? "", /settling/i);
			}

			await harness.handlers.get("message_end")?.(
				{
					type: "message_end",
					message: {
						role: "custom",
						customType: "settlement-barrier-continuation",
						content: "Continue planning",
						display: false,
						timestamp: Date.now(),
					},
				},
				harness.ctx,
			);

			assert.equal(harness.appended.at(-1)?.data.completedPublication?.action, "save");
			assert.equal((await harness.handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolCallId: "settlement-barrier-read-after-delivery",
					toolName: "read",
					input: { path: "README.md" },
				},
				harness.ctx,
			))?.block, undefined);
			assert.equal((await harness.handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolCallId: "settlement-barrier-checkpoint-after-delivery",
					toolName: "update_plan_draft",
					input: { content: "# Plan: Allowed revision two\n", expectedRevision: 1 },
				},
				harness.ctx,
			))?.block, undefined);
		});
	});

	it("durably converts a completed exit to save when a custom queued message is delivered before settlement", async () => {
		await withHarness({
			select: async () => "Create plan",
			confirm: async () => true,
			hasPendingMessages: () => false,
		}, async (harness) => {
			await input(harness, "/plan");
			const content = "# Plan: Custom queue survives exit publication\n";
			await checkpointPlan(harness, content, 0);
			await startLifecycleCommand(harness, "/plan exit");
			const call = {
				type: "tool_call",
				toolCallId: "custom-queue-after-exit",
				toolName: "create_plan",
				input: { revision: 1 },
			};
			assert.equal((await harness.handlers.get("tool_call")?.(call, harness.ctx))?.block, undefined);
			const publication = await harness.registeredTools.get("create_plan").execute(
				call.toolCallId,
				call.input,
				undefined,
				undefined,
				harness.ctx,
			);
			await harness.handlers.get("tool_result")?.(
				{ ...call, type: "tool_result", details: publication.details, isError: false },
				harness.ctx,
			);
			assert.equal(publication.terminate, true);
			assert.equal(harness.appended.at(-1)?.data.completedPublication?.action, "exit");
			assert.equal(harness.ctx.hasPendingMessages(), false);

			await harness.handlers.get("message_end")?.(
				{
					type: "message_end",
					message: {
						role: "custom",
						customType: "queued-regression",
						content: "A custom follow-up invisible to hasPendingMessages",
						display: false,
						timestamp: Date.now(),
					},
				},
				harness.ctx,
			);

			assert.equal(harness.appended.at(-1)?.data.active, true);
			assert.equal(harness.appended.at(-1)?.data.completedPublication?.action, "save");
			const projected = await harness.handlers.get("context")?.(
				{
					type: "context",
					messages: [{ role: "custom", customType: "queued-regression", content: "queued", display: false }],
				},
				harness.ctx,
			);
			assert.equal(projected.messages[0].customType, "plan-checkpoint-context");
			assert.equal(projected.messages[0].content[1].text, content);
			assert.equal(harness.getActiveTools().includes("create_plan"), true);
			assert.equal(harness.getActiveTools().includes("write"), false);

			await harness.handlers.get("agent_settled")?.(
				{ type: "agent_settled" },
				harness.ctx,
			);
			assert.equal(harness.appended.at(-1)?.data.active, true);
			assert.equal(harness.appended.at(-1)?.data.completedPublication, undefined);
			assert.equal(harness.getAbortCount(), 0);
		});
	});

	it("migrates an active legacy session into a fresh session-owned identity with approval revoked", async () => {
		await withHarness({}, async (base) => {
			const legacyEntry = {
				type: "custom",
				customType: "plan-theme-state",
				data: {
					active: true,
					planPath: ".pi/plans/legacy.md",
					approvedContentDigest: "a".repeat(64),
				},
			};
			const harness = createHarness({
				cwd: base.ctx.cwd,
				sessionId: "legacy-session",
				entries: [legacyEntry],
			});

			await harness.handlers.get("session_start")?.(
				{ type: "session_start", reason: "resume" },
				harness.ctx,
			);

			const migrated = harness.appended.at(-1)?.data;
			assert.equal(migrated.version, 1);
			assert.equal(migrated.active, true);
			assert.equal(migrated.ownerSessionId, "legacy-session");
			assert.equal(migrated.approval, undefined);
			assert.notEqual(migrated.candidatePath, ".pi/plans/legacy.md");
			assert.deepEqual(harness.getActiveTools(), [
				"read", "grep", "find", "ls", "update_plan_draft", "create_plan",
			]);
			assert.match(harness.notifications.at(-1)?.message ?? "", /legacy.*migrated.*approval.*revoked/i);
		});
	});

	it("keeps active legacy migration fail-closed when its .pi parent is unsafe", async () => {
		await withHarness({}, async (base) => {
			await writeFile(join(base.ctx.cwd, ".pi"), "not a directory");
			const legacyEntry = {
				type: "custom",
				customType: "plan-theme-state",
				data: { active: true, planPath: ".pi/plans/legacy.md" },
			};
			const harness = createHarness({
				cwd: base.ctx.cwd,
				sessionId: "legacy-session",
				entries: [legacyEntry],
			});

			await harness.handlers.get("session_start")?.(
				{ type: "session_start", reason: "resume" },
				harness.ctx,
			);

			assert.equal(harness.appended.length, 0);
			assert.equal(harness.getActiveTools().includes("create_plan"), false);
			assert.equal(harness.getActiveTools().includes("update_plan_draft"), false);
			assert.equal(harness.notifications.at(-1)?.level, "error");
			assert.match(harness.notifications.at(-1)?.message ?? "", /not activated safely.*\.pi.*safe directory/i);
		});
	});

	it("recovers a first publication completed just before process restart from its digest-bound approval", async () => {
		await withHarness({ confirm: async () => true }, async (original) => {
			await input(original, "/plan");
			const content = "# Plan: Crash-safe publication recovery\n";
			const checkpointResult = await checkpointPlan(original, content, 0);
			await startLifecycleCommand(original, "/plan save");
			const call = {
				type: "tool_call",
				toolCallId: "approved-before-crash",
				toolName: "create_plan",
				input: { revision: 1 },
			};
			const gate = await original.handlers.get("tool_call")?.(call, original.ctx);
			assert.equal(gate?.block, undefined);
			const approvedState = original.appended.at(-1)?.data;
			assert.equal(approvedState.approval.digest, checkpointResult.details.digest);
			const absolutePath = join(original.ctx.cwd, approvedState.candidatePath);
			await mkdir(dirname(absolutePath), { recursive: true });
			await writeFile(absolutePath, content);

			const resumed = createHarness({
				cwd: original.ctx.cwd,
				sessionId: "session-a",
				sessionFile: join(original.ctx.cwd, "session.jsonl"),
				entries: [...original.allEntries],
			});
			await resumed.handlers.get("session_start")?.(
				{ type: "session_start", reason: "resume" },
				resumed.ctx,
			);

			const recovered = resumed.appended.at(-1)?.data;
			assert.equal(recovered.publishedPath, approvedState.candidatePath);
			assert.equal(recovered.publishedDigest, checkpointResult.details.digest);
			assert.equal(recovered.publishedRevision, 1);
			assert.equal(recovered.publicationState, "synced");
			assert.equal(recovered.approval, undefined);
			assert.equal(await readFile(absolutePath, "utf8"), content);
			assert.match(resumed.notifications.at(-1)?.message ?? "", /recovered.*publication/i);
		});
	});

	it("keeps a session with multiple logical identities fail-closed instead of creating a third plan", async () => {
		await withHarness({}, async (base) => {
			const makeState = (planId: string, candidatePath: string) => ({
				type: "custom",
				customType: "plan-theme-state",
				data: {
					version: 1,
					active: true,
					ownerSessionId: "session-a",
					planId,
					candidatePath,
					publicationState: "unpublished",
				},
			});
			const harness = createHarness({
				cwd: base.ctx.cwd,
				entries: [
					makeState("plan-a", ".pi/plans/2026-09-01-120000-plan-a.md"),
					makeState("plan-b", ".pi/plans/2026-09-01-120001-plan-b.md"),
				],
			});
			await harness.handlers.get("session_start")?.(
				{ type: "session_start", reason: "resume" },
				harness.ctx,
			);
			const entriesBefore = harness.allEntries.length;

			assert.deepEqual(await input(harness, "/plan"), { action: "handled" });
			assert.equal(harness.allEntries.length, entriesBefore);
			assert.equal(harness.getActiveTools().includes("create_plan"), false);
			assert.match(harness.notifications.at(-1)?.message ?? "", /inconsistent.*disabled/i);
		});
	});

	it("updates one stable path and refuses a digest race between approval and atomic replacement", async () => {
		await withHarness({ confirm: async () => true }, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Revision one\n", 0);
			const first = await publishLatest(harness, 1);
			await checkpointPlan(harness, "# Plan: Revision two\n", 1);
			const second = await publishLatest(harness, 2);

			assert.equal(second.details.path, first.details.path);
			assert.equal(second.details.unchanged, false);
			assert.equal(
				await readFile(join(harness.ctx.cwd, first.details.path), "utf8"),
				"# Plan: Revision two\n",
			);

			await checkpointPlan(harness, "# Plan: Revision three\n", 2);
			await startLifecycleCommand(harness, "/plan save");
			const call = {
				type: "tool_call",
				toolCallId: "publish-race",
				toolName: "create_plan",
				input: { revision: 3 },
			};
			const gate = await harness.handlers.get("tool_call")?.(call, harness.ctx);
			assert.equal(gate?.block, undefined);
			await writeFile(join(harness.ctx.cwd, first.details.path), "external race");

			await assert.rejects(
				harness.registeredTools.get("create_plan").execute(
					call.toolCallId,
					call.input,
					undefined,
					undefined,
					harness.ctx,
				),
				/on-disk bytes changed.*not overwritten/i,
			);
			assert.equal(await readFile(join(harness.ctx.cwd, first.details.path), "utf8"), "external race");
			assert.equal(harness.appended.at(-1)?.data.publicationState, "conflict");
			assert.equal(harness.appended.at(-1)?.data.active, true);
		});
	});

	it("never reuses persisted approval to publish when interactive UI is unavailable", async () => {
		await withHarness({ confirm: async () => true }, async (original) => {
			await input(original, "/plan");
			await checkpointPlan(original, "# Plan: UI-bound approval\n", 0);
			await startLifecycleCommand(original, "/plan save");
			const approvedCall = {
				type: "tool_call",
				toolCallId: "approve-only",
				toolName: "create_plan",
				input: { revision: 1 },
			};
			assert.equal(
				(await original.handlers.get("tool_call")?.(approvedCall, original.ctx))?.block,
				undefined,
			);

			const resumed = createHarness({
				cwd: original.ctx.cwd,
				sessionId: "session-a",
				sessionFile: join(original.ctx.cwd, "session.jsonl"),
				entries: [...original.allEntries],
				hasUI: false,
				mode: "print",
			});
			await resumed.handlers.get("session_start")?.(
				{ type: "session_start", reason: "resume" },
				resumed.ctx,
			);
			await startLifecycleCommand(resumed, "/plan save");
			const result = await resumed.handlers.get("tool_call")?.(
				{ ...approvedCall, toolCallId: "no-ui-retry" },
				resumed.ctx,
			);

			assert.equal(result?.block, true);
			assert.match(result?.reason ?? "", /interactive UI.*required/i);
			assert.equal(resumed.appended.at(-1)?.data.active ?? true, true);
		});
	});

	it("clears stale exact-content approval on /tree before restoring the selected branch", async () => {
		let confirmations = 0;
		await withHarness({
			confirm: async () => {
				confirmations += 1;
				return true;
			},
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Tree approval\n", 0);
			await startLifecycleCommand(harness, "/plan save");
			const first = await harness.handlers.get("tool_call")?.(
				{ type: "tool_call", toolCallId: "before-tree", toolName: "create_plan", input: { revision: 1 } },
				harness.ctx,
			);
			assert.equal(first?.block, undefined);
			assert.ok(harness.appended.at(-1)?.data.approval);

			await harness.handlers.get("session_tree")?.(
				{ type: "session_tree", oldLeafId: "old", newLeafId: "new" },
				harness.ctx,
			);
			assert.equal(harness.appended.at(-1)?.data.approval, undefined);

			await startLifecycleCommand(harness, "/plan save");
			const second = await harness.handlers.get("tool_call")?.(
				{ type: "tool_call", toolCallId: "after-tree", toolName: "create_plan", input: { revision: 1 } },
				harness.ctx,
			);
			assert.equal(second?.block, undefined);
			assert.equal(confirmations, 2);
		});
	});

	it("anchors approval clearing on the selected parent-linked branch so reopen cannot restore a later stale approval", async () => {
		await withHarness({ confirm: async () => true }, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Parent-linked approval branch\n", 0);
			const selectedLeaf = harness.allEntries.find(
				(entry: Entry) =>
					entry.type === "message" &&
					entry.message?.role === "toolResult" &&
					entry.message.toolName === "update_plan_draft",
			);
			assert.ok(selectedLeaf);

			await startLifecycleCommand(harness, "/plan save");
			const approved = await harness.handlers.get("tool_call")?.(
				{ type: "tool_call", toolCallId: "old-approval", toolName: "create_plan", input: { revision: 1 } },
				harness.ctx,
			);
			assert.equal(approved?.block, undefined);
			assert.ok(harness.allEntries.at(-1)?.data?.approval);

			harness.setBranch(parentLinkedBranch(harness.allEntries, selectedLeaf));
			await harness.handlers.get("session_tree")?.(
				{ type: "session_tree", oldLeafId: "old-approval", newLeafId: selectedLeaf.id },
				harness.ctx,
			);

			const reopenedEntries = [...harness.allEntries];
			const physicalLeaf = reopenedEntries.at(-1);
			assert.equal(physicalLeaf?.parentId, selectedLeaf.id);
			assert.equal(physicalLeaf?.data?.approval, undefined);

			let reopenedConfirmations = 0;
			const reopened = createHarness({
				cwd: harness.ctx.cwd,
				sessionId: "session-a",
				sessionFile: join(harness.ctx.cwd, "session.jsonl"),
				entries: reopenedEntries,
				branch: parentLinkedBranch(reopenedEntries),
				confirm: async () => {
					reopenedConfirmations += 1;
					return true;
				},
			});
			await reopened.handlers.get("session_start")?.(
				{ type: "session_start", reason: "resume" },
				reopened.ctx,
			);
			await startLifecycleCommand(reopened, "/plan save");
			const reopenedGate = await reopened.handlers.get("tool_call")?.(
				{ type: "tool_call", toolCallId: "reopened-approval", toolName: "create_plan", input: { revision: 1 } },
				reopened.ctx,
			);

			assert.equal(reopenedGate?.block, undefined);
			assert.equal(reopenedConfirmations, 1);
		});
	});

	it("downgrades a completed exit when a newer dirty checkpoint exists at settlement", async () => {
		await withHarness({
			confirm: async () => true,
			select: async () => "Create plan",
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Published settlement revision one\n", 0);
			await publishLatest(harness, 1, "/plan exit", false);

			const newerCheckpoint = await harness.registeredTools.get("update_plan_draft").execute(
				"settlement-mismatch-checkpoint",
				{
					content: "# Plan: Dirty settlement revision two\n",
					expectedRevision: 1,
				},
				undefined,
				undefined,
				harness.ctx,
			);
			harness.recordToolResult("update_plan_draft", newerCheckpoint.details);
			assert.equal(harness.appended.at(-1)?.data.completedPublication?.action, "exit");
			assert.equal(harness.appended.at(-1)?.data.publicationState, "dirty");
			const entriesBeforeSettlement = harness.appended.length;

			await harness.handlers.get("agent_settled")?.(
				{ type: "agent_settled" },
				harness.ctx,
			);

			const settled = harness.appended.at(-1)?.data;
			assert.equal(settled.active, true);
			assert.equal(settled.publicationState, "dirty");
			assert.equal(settled.checkpointRevision, 2);
			assert.equal(settled.completedPublication, undefined);
			assert.equal(
				harness.appended
					.slice(entriesBeforeSettlement)
					.some((entry: Entry) => entry.data.completedPublication?.action === "save"),
				true,
			);
			assert.equal(harness.getActiveTools().includes("create_plan"), true);
			assert.equal(harness.getActiveTools().includes("write"), false);
		});
	});

	it("keeps Plan enforced after successful exit publication and deactivates only at settlement", async () => {
		await withHarness({
			confirm: async () => true,
			select: async () => "Update plan",
		}, async (harness) => {
			const normalTools = harness.getActiveTools();
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Plan: Exit revision one\n", 0);
			const first = await publishLatest(harness, 1);
			const finalContent = "# Plan: Exit revision two\n";
			await checkpointPlan(harness, finalContent, 1);

			const publication = await publishLatest(harness, 2, "/plan exit", false);

			assert.equal(publication.terminate, true);
			assert.equal(harness.getAbortCount(), 0);
			assert.equal(publication.details.path, first.details.path);
			assert.equal(await readFile(join(harness.ctx.cwd, first.details.path), "utf8"), finalContent);
			assert.equal(harness.appended.at(-1)?.data.active, true);
			assert.equal(harness.appended.at(-1)?.data.completedPublication?.action, "exit");
			assert.equal(harness.getActiveTools().includes("create_plan"), true);
			assert.equal(harness.getActiveTools().includes("write"), false);

			await harness.handlers.get("agent_settled")?.(
				{ type: "agent_settled" },
				harness.ctx,
			);

			assert.equal(harness.appended.at(-1)?.data.active, false);
			assert.equal(harness.appended.at(-1)?.data.completedPublication, undefined);
			assert.deepEqual(harness.getActiveTools(), normalTools);
			assert.match(harness.notifications.at(-1)?.message ?? "", /published.*exited/i);
		});
	});

	it("preserves the current name for /plan save after a restart between write and tool result", async () => {
		await withHarness({ confirm: async () => true }, async (original) => {
			await input(original, "/plan");
			const content = "# Plan: Crash-safe saved name\n";
			await checkpointPlan(original, content, 0);
			await startLifecycleCommand(original, "/plan save");
			const call = {
				type: "tool_call",
				toolCallId: "save-before-result",
				toolName: "create_plan",
				input: { revision: 1 },
			};
			assert.equal((await original.handlers.get("tool_call")?.(call, original.ctx))?.block, undefined);
			const publication = await original.registeredTools.get("create_plan").execute(
				call.toolCallId,
				call.input,
				undefined,
				undefined,
				original.ctx,
			);

			const resumed = createHarness({
				cwd: original.ctx.cwd,
				sessionId: "session-a",
				sessionFile: join(original.ctx.cwd, "session.jsonl"),
				entries: [...original.allEntries],
			});
			await resumed.handlers.get("session_start")?.(
				{ type: "session_start", reason: "resume" },
				resumed.ctx,
			);

			const reconciled = resumed.appended.at(-1)?.data;
			assert.equal(reconciled.active, true);
			assert.equal(reconciled.publishedPath, publication.details.path);
			assert.equal(reconciled.completedPublication, undefined);
			assert.equal(resumed.getSessionName(), undefined);
			assert.deepEqual(resumed.sessionNameChanges, []);

			const alreadyNamed = createHarness({
				cwd: original.ctx.cwd,
				sessionId: "session-a",
				sessionFile: join(original.ctx.cwd, "session.jsonl"),
				entries: [...original.allEntries],
				sessionName: "crash-safe-saved-name",
			});
			await alreadyNamed.handlers.get("session_start")?.(
				{ type: "session_start", reason: "resume" },
				alreadyNamed.ctx,
			);
			assert.equal(alreadyNamed.getSessionName(), "crash-safe-saved-name");
			assert.deepEqual(alreadyNamed.sessionNameChanges, []);
		});
	});

	it("keeps Plan active when a restarted completed exit has a newer branch checkpoint", async () => {
		await withHarness({
			confirm: async () => true,
			select: async () => "Create plan",
		}, async (original) => {
			await input(original, "/plan");
			await checkpointPlan(original, "# Plan: Restart publication revision one\n", 0);
			await publishLatest(original, 1, "/plan exit", false);
			const newerCheckpoint = await original.registeredTools.get("update_plan_draft").execute(
				"restart-mismatch-checkpoint",
				{
					content: "# Plan: Restart dirty revision two\n",
					expectedRevision: 1,
				},
				undefined,
				undefined,
				original.ctx,
			);
			original.recordToolResult("update_plan_draft", newerCheckpoint.details);
			const latestStateEntry = [...original.allEntries].reverse().find(
				(entry: Entry) => entry.type === "custom" && entry.customType === "plan-theme-state",
			);
			assert.ok(latestStateEntry);
			original.allEntries.push({
				...latestStateEntry,
				id: "inactive-restart-mismatch",
				parentId: original.allEntries.at(-1)?.id,
				timestamp: new Date().toISOString(),
				data: { ...latestStateEntry.data, active: false },
			});

			const resumed = createHarness({
				cwd: original.ctx.cwd,
				sessionId: "session-a",
				sessionFile: join(original.ctx.cwd, "session.jsonl"),
				entries: [...original.allEntries],
			});
			await resumed.handlers.get("session_start")?.(
				{ type: "session_start", reason: "resume" },
				resumed.ctx,
			);

			const reconciled = resumed.appended.at(-1)?.data;
			assert.equal(reconciled.active, true);
			assert.equal(reconciled.publicationState, "dirty");
			assert.equal(reconciled.checkpointRevision, 2);
			assert.equal(reconciled.completedPublication, undefined);
			assert.equal(
				resumed.appended.some((entry: Entry) => entry.data.completedPublication?.action === "save"),
				true,
			);
			assert.equal(resumed.getActiveTools().includes("create_plan"), true);
			assert.equal(resumed.getActiveTools().includes("write"), false);
			assert.match(resumed.notifications.at(-1)?.message ?? "", /no longer matches.*active/i);
		});
	});

	it("preserves a persisted publication conflict across restart and checkpoint refresh", async () => {
		await withHarness({ confirm: async () => true }, async (original) => {
			await input(original, "/plan");
			await checkpointPlan(original, "# Plan: Persisted conflict revision one\n", 0);
			const publication = await publishLatest(original, 1);
			await writeFile(join(original.ctx.cwd, publication.details.path), "external conflict bytes");
			await input(original, "/plan status");
			assert.equal(original.appended.at(-1)?.data.publicationState, "conflict");

			const resumed = createHarness({
				cwd: original.ctx.cwd,
				sessionId: "session-a",
				sessionFile: join(original.ctx.cwd, "session.jsonl"),
				entries: [...original.allEntries],
			});
			await resumed.handlers.get("session_start")?.(
				{ type: "session_start", reason: "resume" },
				resumed.ctx,
			);
			const nextCheckpoint = await resumed.registeredTools.get("update_plan_draft").execute(
				"checkpoint-after-persisted-conflict",
				{
					content: "# Plan: Persisted conflict revision two\n",
					expectedRevision: 1,
				},
				undefined,
				undefined,
				resumed.ctx,
			);
			resumed.recordToolResult("update_plan_draft", nextCheckpoint.details);

			assert.equal(resumed.appended.at(-1)?.data.publicationState, "conflict");
			assert.equal(resumed.appended.at(-1)?.data.checkpointRevision, 2);
			assert.equal(resumed.appended.at(-1)?.data.active, true);
		});
	});

	it("keeps Plan active when a completed exit publication changes externally before restart reconciliation", async () => {
		await withHarness({
			confirm: async () => true,
			select: async () => "Create plan",
		}, async (original) => {
			await input(original, "/plan");
			await checkpointPlan(original, "# Plan: Restarted external conflict\n", 0);
			await startLifecycleCommand(original, "/plan exit");
			const call = {
				type: "tool_call",
				toolCallId: "exit-before-external-change",
				toolName: "create_plan",
				input: { revision: 1 },
			};
			assert.equal((await original.handlers.get("tool_call")?.(call, original.ctx))?.block, undefined);
			const publication = await original.registeredTools.get("create_plan").execute(
				call.toolCallId,
				call.input,
				undefined,
				undefined,
				original.ctx,
			);
			const absolutePath = join(original.ctx.cwd, publication.details.path);
			await writeFile(absolutePath, "external bytes after publication");

			const resumed = createHarness({
				cwd: original.ctx.cwd,
				sessionId: "session-a",
				sessionFile: join(original.ctx.cwd, "session.jsonl"),
				entries: [...original.allEntries],
			});
			await resumed.handlers.get("session_start")?.(
				{ type: "session_start", reason: "resume" },
				resumed.ctx,
			);

			const reconciled = resumed.appended.at(-1)?.data;
			assert.equal(reconciled.active, true);
			assert.equal(reconciled.publicationState, "conflict");
			assert.equal(reconciled.completedPublication, undefined);
			assert.equal(
				resumed.appended.some((entry: Entry) => entry.data.completedPublication?.action === "save"),
				true,
			);
			assert.equal(resumed.getActiveTools().includes("create_plan"), true);
			assert.equal(resumed.getActiveTools().includes("write"), false);
			assert.equal(await readFile(absolutePath, "utf8"), "external bytes after publication");
			assert.match(resumed.notifications.at(-1)?.message ?? "", /verification|conflict|changed.*active/i);
		});
	});

	it("finishes an already-persisted /plan exit transition and restores tools/theme from a restricted restart", async () => {
		await withHarness({
			mode: "tui",
			confirm: async () => true,
			select: async () => "Create plan",
		}, async (original) => {
			const normalTools = ["read", "bash"];
			original.setActiveTools(normalTools);
			await input(original, "/plan");
			const planTools = [...original.getActiveTools()];
			await checkpointPlan(original, "# Plan: Restarted exit completion\n", 0);
			// Use the harness's RPC approval dialogs; activation captured the TUI theme.
			original.ctx.mode = "rpc";
			await startLifecycleCommand(original, "/plan exit");
			const call = {
				type: "tool_call",
				toolCallId: "exit-before-result",
				toolName: "create_plan",
				input: { revision: 1 },
			};
			assert.equal((await original.handlers.get("tool_call")?.(call, original.ctx))?.block, undefined);
			const publication = await original.registeredTools.get("create_plan").execute(
				call.toolCallId,
				call.input,
				undefined,
				undefined,
				original.ctx,
			);

			const resumed = createHarness({
				cwd: original.ctx.cwd,
				sessionId: "session-a",
				sessionFile: join(original.ctx.cwd, "session.jsonl"),
				entries: [...original.allEntries],
				mode: "tui",
			});
			resumed.setActiveTools(planTools);
			resumed.ctx.ui.setTheme({ name: "plan" });
			await resumed.handlers.get("session_start")?.(
				{ type: "session_start", reason: "resume" },
				resumed.ctx,
			);

			const reconciled = resumed.appended.at(-1)?.data;
			assert.equal(reconciled.active, false);
			assert.equal(reconciled.publishedPath, publication.details.path);
			assert.deepEqual(resumed.getActiveTools(), normalTools);
			assert.equal(resumed.getThemeName(), "dark");
			assert.equal(reconciled.completedPublication, undefined);
			assert.equal(resumed.getActiveTools().includes("create_plan"), false);
			assert.equal(resumed.getSessionName(), undefined);
			assert.deepEqual(resumed.sessionNameChanges, []);
			assert.match(resumed.notifications.at(-1)?.message ?? "", /completed.*exit.*restart/i);
		});
	});
});


describe("factory coordination capability", () => {
	it("disposes before shutdown yields and never reopens on a reused session_start", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "plan-coordination-"));
		try {
			const harness = createHarness({ cwd });
			const discover = (events: any) => {
				const providers: any[] = [];
				events.emit("pithos.plan.coordination", { version: 1, reply: (provider: any) => { providers.push(provider); } });
				return providers;
			};
			const [provider] = discover(harness.events);
			await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
			const shutdown = harness.handlers.get("session_shutdown")({ reason: "reload" }, harness.ctx);
			assert.deepEqual(discover(harness.events), [], "shutdown must synchronously disable discovery");
			assert.equal(provider.inspect().phase, "disposed");
			assert.equal(provider.attachParticipant({ instance: {}, tryAcquire() { assert.fail("disposed provider must not acquire"); } }).kind, "blocked");
			await shutdown;
			await harness.handlers.get("session_start")({ reason: "switch" }, harness.ctx);
			assert.deepEqual(discover(harness.events), []);
			assert.equal(provider.inspect().phase, "disposed");
			const fresh = createHarness({ cwd });
			const [next] = discover(fresh.events);
			assert.notEqual(next.instance, provider.instance);
			assert.equal(next.inspect().phase, "initializing");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
	it("replies synchronously before session_start and opens readiness after clean reconciliation", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "plan-coordination-"));
		try {
			const harness = createHarness({ cwd });
			const providers: any[] = [];
			const reply = (provider: any) => { providers.push(provider); };
			for (const request of [null, undefined, 1, {}, { version: 2, reply }, { version: "1", reply }, { version: 1, reply: null }]) {
				harness.events.emit("pithos.plan.coordination", request);
			}
			assert.equal(providers.length, 0);
			harness.events.emit("pithos.plan.coordination", { version: 1, reply });
			assert.equal(providers.length, 1, "factory must advertise synchronously before session_start");
			const provider = providers[0];
			assert.equal(provider.version, 1);
			assert.equal(provider.inspect().phase, "initializing");
			await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
			await harness.handlers.get("session_tree")({}, harness.ctx);
			harness.events.emit("pithos.plan.coordination", { version: 1, reply });
			assert.equal(providers[1], provider);
			assert.equal(provider.inspect().phase, "inactive");
			let acquired = 0;
			let released = 0;
			assert.equal(provider.attachParticipant({
				instance: {},
				tryAcquire() {
					acquired += 1;
					return { kind: "held", lease: { release() { released += 1; } } };
				},
			}).kind, "attached");
			assert.equal(acquired, 0);
			assert.equal(released, 0);
			assert.equal(provider.inspect().phase, "inactive");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

function observeEntryCoordination(harness: any) {
	let provider: any;
	harness.events.emit("pithos.plan.coordination", { version: 1, reply(value: any) { provider = value; } });
	let released = 0;
	assert.equal(provider.attachParticipant({
		instance: {},
		tryAcquire() { return { kind: "held", lease: { release() { released += 1; } } }; },
	}).kind, "attached");
	return { provider, released: () => released };
}

describe("ordinary entry coordination", () => {
	it("enters synchronously and retains protection through successful persistence", async () => {
		const path = Promise.withResolvers<string>();
		await withHarness({ generatePlanPath: () => path.promise }, async (harness) => {
			const observed = observeEntryCoordination(harness);
			assert.equal(observed.provider.inspect().phase, "initializing");
			const entering = input(harness, "/plan");
			try {
				assert.equal(observed.provider.inspect().phase, "entering");
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(harness.appended.length, 0);
				assert.equal(observed.released(), 0);
			} finally { path.resolve(".pi/plans/entry.md"); await entering; }
			assert.equal(harness.appended.at(-1).data.active, true);
			assert.equal(observed.provider.inspect().phase, "active");
			assert.equal(observed.released(), 0);
		});
	});
});


describe("ordinary entry stale callbacks", () => {
	for (const event of ["input", "agent_start"]) {
		it(`rolls back owned partial activation after reentrant ${event} and permits retry`, async () => {
			let onTools: (() => void) | undefined;
			await withHarness({ mode: "tui", setActiveTools: () => onTools?.() }, async (harness) => {
				const observed = observeEntryCoordination(harness);
				const normalTools = [...harness.getActiveTools()];
				let footer: unknown;
				harness.ctx.ui.setFooter = (value: unknown) => { footer = value; };
				onTools = () => {
					onTools = undefined;
					void harness.handlers.get(event)({ text: "new task", source: "interactive" }, harness.ctx);
				};
				await input(harness, "/plan");
				assert.equal(harness.appended.length, 0);
				assert.deepEqual(harness.getActiveTools(), normalTools);
				assert.equal(harness.ctx.ui.theme.name, "dark");
				assert.equal(footer, undefined);
				assert.equal(observed.provider.inspect().phase, "inactive");
				assert.equal(observed.released(), 1);
				await input(harness, "/plan");
				assert.equal(harness.appended.at(-1)?.data.active, true);
				assert.equal(observed.provider.inspect().phase, "active");
				assert.deepEqual(harness.appended.at(-1).data.previousToolNames, normalTools);
			});
		});
	}
	it("does not persist or notify after tool application synchronously shuts down the session", async () => {
		let onTools: (() => void) | undefined;
		await withHarness({ mode: "tui", setActiveTools: () => onTools?.() }, async (harness) => {
			const observed = observeEntryCoordination(harness);
			const uiEffects: string[] = [];
			harness.ctx.ui.setFooter = () => { uiEffects.push("footer"); };
			harness.ctx.ui.setStatus = () => { uiEffects.push("status"); };
			let effectsAtShutdown: string[] = [];
			onTools = () => {
				onTools = undefined;
				void harness.handlers.get("session_shutdown")({ reason: "reload" }, harness.ctx);
				effectsAtShutdown = [...uiEffects];
			};
			await input(harness, "/plan");
			assert.deepEqual(uiEffects, effectsAtShutdown);
			assert.equal(harness.ctx.ui.theme.name, "dark");
			assert.equal(harness.appended.length, 0);
			assert.equal(harness.notifications.length, 0);
			assert.equal(observed.provider.inspect().phase, "disposed");
			assert.equal(observed.released(), 0);
		});
	});
});

describe("ordinary entry safety pins", () => {
	for (const supersede of ["queued-entry", "path-entry", "input", "agent_start", "session_tree", "session_shutdown"]) {
		it(`retains protection when superseded by ${supersede}`, async () => {
			const path = Promise.withResolvers<string>();
			let calls = 0;
			await withHarness({ generatePlanPath: () => ++calls === 1 ? path.promise : Promise.resolve(".pi/plans/newer.md") }, async (harness) => {
				const observed = observeEntryCoordination(harness);
				const normalTools = [...harness.getActiveTools()];
				const first = input(harness, "/plan");
				const firstGeneration = observed.provider.inspect().generation;
				let second: Promise<any> | undefined;
				try {
					if (supersede !== "queued-entry") await new Promise<void>((resolve) => setImmediate(resolve));
					if (supersede.endsWith("entry")) {
						second = input(harness, "/plan");
						assert.notEqual(observed.provider.inspect().generation, firstGeneration);
					} else if (supersede === "input") await input(harness, "new task");
					else await harness.handlers.get(supersede)({ reason: "reload" }, harness.ctx);
				} finally { path.resolve(".pi/plans/older.md"); await first; await second; }
				assert.equal(observed.released(), ["input", "agent_start", "session_tree"].includes(supersede) ? 1 : 0);
				if (second) {
					assert.equal(harness.appended.length, 1);
					assert.equal(observed.provider.inspect().phase, "active");
					if (supersede === "path-entry") assert.equal(harness.appended[0].data.candidatePath, ".pi/plans/newer.md");
				} else {
					assert.equal(harness.appended.length, 0);
					assert.deepEqual(harness.getActiveTools(), normalTools);
					assert.equal(harness.notifications.length, 0);
					assert.equal(observed.provider.inspect().phase, supersede === "session_shutdown" ? "disposed" : "inactive");
				}
			});
		});
	}
	for (const failure of ["path", "tools", "persistence"]) {
		it(`keeps protection after ${failure} failure`, async () => {
			let armed = false;
			const fail = () => { if (armed) throw new Error("entry failure"); };
			await withHarness({
				generatePlanPath: failure === "path" ? async () => { throw new Error("entry failure"); } : undefined,
				setActiveTools: failure === "tools" ? fail : undefined,
				appendEntry: failure === "persistence" ? fail : undefined,
			}, async (harness) => {
				const observed = observeEntryCoordination(harness);
				armed = true;
				await input(harness, "/plan");
				assert.equal(observed.provider.inspect().phase, failure === "path" ? "inactive" : "entering");
				assert.equal(observed.released(), failure === "path" ? 1 : 0);
				assert.equal(harness.appended.length, 0);
				assert.match(harness.notifications.at(-1).message, /not activated safely/);
			});
		});
	}
});

describe("ordinary exit coordination", () => {
	it("exposes exiting before restoring tools and releases holds after direct exit", async () => {
		let onTools: (() => void) | undefined;
		await withHarness({ setActiveTools: () => onTools?.() }, async (harness) => {
			const observed = observeEntryCoordination(harness);
			await input(harness, "/plan");
			const phases: string[] = [];
			onTools = () => { phases.push(observed.provider.inspect().phase); };
			await input(harness, "/plan exit");
			assert.deepEqual(phases, ["exiting"]);
			assert.equal(harness.appended.at(-1).data.active, false);
			assert.equal(observed.provider.inspect().phase, "inactive");
			assert.equal(observed.released(), 1);
		});
	});
});

describe("ordinary exit failure safety", () => {
	it("restores active tools after a partial tool failure and permits retry", async () => {
		let fail = false;
		await withHarness({ setActiveTools: () => { if (fail) { fail = false; throw new Error("exit tools failed"); } } }, async (harness) => {
			const observed = observeEntryCoordination(harness);
			await input(harness, "/plan");
			const planned = [...harness.getActiveTools()];
			fail = true;
			await input(harness, "/plan exit");
			assert.deepEqual(harness.getActiveTools(), planned);
			assert.equal(harness.appended.at(-1).data.active, true);
			assert.match(harness.notifications.at(-1).message, /not exited safely/i);
			assert.equal(observed.released(), 0);
			await input(harness, "/plan exit");
			assert.equal(harness.appended.at(-1).data.active, false);
		});
	});
});

describe("ordinary exit persistence boundary", () => {
	it("keeps read-only policy active inside persistence and rolls back a failed write", async () => {
		let onAppend: (() => void) | undefined;
		await withHarness({ appendEntry: () => onAppend?.() }, async (harness) => {
			await input(harness, "/plan");
			let shell: Promise<any> | undefined;
			onAppend = () => {
				onAppend = undefined;
				shell = harness.handlers.get("user_bash")({}, harness.ctx);
				throw new Error("exit persistence failed");
			};
			await input(harness, "/plan exit");
			assert.equal((await shell)?.result.exitCode, 126);
			assert.equal(harness.appended.at(-1).data.active, true);
			assert.equal(harness.getActiveTools().includes("bash"), false);
			assert.match(harness.notifications.at(-1).message, /not exited safely/i);
			await input(harness, "/plan exit");
			assert.equal(harness.appended.at(-1).data.active, false);
		});
	});
});

describe("ordinary exit supersession", () => {
	for (const boundary of ["tools", "getTheme", "theme", "footer", "status", "persist"]) {
		for (const event of ["input", "agent_start"]) {
			it(`stops old exit after ${event} at ${boundary}`, async () => {
				let hook: (() => void) | undefined;
				await withHarness({ mode: "tui", setActiveTools: () => { if (boundary === "tools") hook?.(); }, afterAppendEntry: () => { if (boundary === "persist") hook?.(); } }, async (harness) => {
					const observed = observeEntryCoordination(harness);
					await input(harness, "/plan");
					harness.ctx.ui.select = async () => "Exit without publishing";
					for (const [name, target] of [["getTheme", "getTheme"], ["setTheme", "theme"], ["setFooter", "footer"], ["setStatus", "status"]]) {
						const original = harness.ctx.ui[name];
						harness.ctx.ui[name] = (...args: any[]) => { const result = original(...args); if (boundary === target) hook?.(); return result; };
					}
					let superseding: Promise<any> | undefined;
					let fired = false;
					hook = () => {
						hook = undefined;
						fired = true;
						superseding = harness.handlers.get(event)({ text: "new task", source: "interactive", reason: "reload" }, harness.ctx);
					};
					const before = harness.notifications.length;
					await input(harness, "/plan exit");
					await superseding;
					assert.equal(fired, true);
					assert.equal(harness.notifications.slice(before).some((entry: any) => /exited Plan mode/i.test(entry.message)), false);
					assert.equal(observed.released(), 0);
					if (event === "input" || event === "agent_start") {
						assert.equal(harness.appended.at(-1).data.active, true);
						assert.equal(harness.getActiveTools().includes("bash"), false);
						await input(harness, "/plan exit");
						assert.equal(harness.appended.at(-1).data.active, false);
					}
				});
			});
		}
	}
});


describe("ordinary exit session supersession", () => {
	for (const boundary of ["tools", "getTheme", "theme", "footer", "status", "persist"]) {
		for (const event of ["session_tree", "session_shutdown"]) {
			it(`preserves reconstructed state and stops stale effects after ${event} at ${boundary}`, async () => {
				let hook: (() => void) | undefined;
				const effects: string[] = [];
				await withHarness({
					mode: "tui",
					setActiveTools: () => { effects.push("tools"); if (boundary === "tools") hook?.(); },
					afterAppendEntry: () => { effects.push("append"); if (boundary === "persist") hook?.(); },
				}, async (harness) => {
					const observed = observeEntryCoordination(harness);
					await input(harness, "/plan");
					const selectedBranch = [...harness.ctx.sessionManager.getBranch()];
					const planId = harness.appended.at(-1).data.planId;
					// Incoming tree UI is distinct so outgoing callbacks cannot hide among
					// reconciliation effects. Tools remain shared, as in the runtime.
					const incomingCtx = { ...harness.ctx, ui: { ...harness.ctx.ui } };
					harness.ctx.ui.select = async () => "Exit without publishing";
					for (const [name, target] of [["getTheme", "getTheme"], ["setTheme", "theme"], ["setFooter", "footer"], ["setStatus", "status"], ["notify", "notify"]]) {
						const original = harness.ctx.ui[name];
						harness.ctx.ui[name] = (...args: any[]) => {
							effects.push(name);
							const result = original(...args);
							if (boundary === target) hook?.();
							return result;
						};
					}
					let superseding: Promise<any> | undefined;
					let effectsAtSupersession: string[] | undefined;
					let activeAtAppendObservation: boolean | undefined;
					let replacement: any;
					let staleAccesses: string[] = [];
					hook = () => {
						hook = undefined;
						if (boundary === "persist") {
							activeAtAppendObservation = harness.appended.at(-1).data.active;
						}
						if (event === "session_tree") harness.setBranch([...selectedBranch]);
						superseding = harness.handlers.get(event)({ reason: "reload" }, event === "session_tree" ? incomingCtx : harness.ctx);
						if (event === "session_shutdown") {
							replacement = createHarness({ cwd: harness.ctx.cwd, mode: "tui", entries: [...harness.allEntries], branch: parentLinkedBranch(harness.allEntries) });
							staleAccesses = makeContextStale(harness.ctx);
						}
						effectsAtSupersession = [...effects];
					};
					await input(harness, "/plan exit");
					// Tree reconciliation finishes asynchronously; only its own UI/tools are allowed.
					const effectsAfterExit = [...effects];
					await superseding;
					assert.ok(effectsAtSupersession);
					if (boundary === "persist") assert.equal(activeAtAppendObservation, false, "append observation sees committed inactive record");
					assert.deepEqual(staleAccesses, []);
					assert.equal(observed.released(), 0);
					if (event === "session_shutdown") {
						assert.deepEqual(effectsAfterExit, effectsAtSupersession);
						assert.equal(observed.provider.inspect().phase, "disposed");
					} else {
						// Only incoming reconciliation may reapply tools after its await.
						assert.deepEqual(effects.slice(effectsAtSupersession.length), ["tools"]);
						assert.equal(harness.getActiveTools().includes("bash"), false);
						replacement = createHarness({ cwd: harness.ctx.cwd, mode: "tui", entries: [...harness.allEntries], branch: [...harness.ctx.sessionManager.getBranch()] });
					}
					const expectedActive = event === "session_tree" || boundary !== "persist";
					const durable = replacement.ctx.sessionManager.getBranch().filter((entry: any) => entry.customType === harness.appended[0].customType).at(-1).data;
					assert.equal(durable.active, expectedActive);
					assert.equal(durable.planId, planId);
					await replacement.handlers.get("session_start")({ reason: "reload" }, replacement.ctx);
					assert.equal(replacement.getActiveTools().includes("create_plan"), expectedActive);
					assert.equal(replacement.getActiveTools().includes("bash"), !expectedActive);
					assert.equal(replacement.ctx.ui.theme.name, expectedActive ? "plan" : "dark");
					assert.equal(harness.notifications.some((entry: any) => /exited Plan mode/i.test(entry.message)), false);
				});
			});
		}
	}
});

describe("reconciliation recovery fencing", () => {
	for (const reject of [false, true]) {
		it(`discards approval recovery after shutdown (${reject ? "reject" : "resolve"})`, async () => {
			await withHarness({ confirm: async () => true }, async (original) => {
				await input(original, "/plan");
				await checkpointPlan(original, "# Restart fence\n", 0);
				await startLifecycleCommand(original, "/plan save");
				await original.handlers.get("tool_call")({ type: "tool_call", toolCallId: "approved", toolName: "create_plan", input: { revision: 1 } }, original.ctx);
				const verification = Promise.withResolvers<void>();
				const started = Promise.withResolvers<void>();
				const resumed = createHarness({ cwd: original.ctx.cwd, entries: [...original.allEntries], mode: "tui",
					verifyPlanFileDigest: async () => { started.resolve(); return verification.promise; },
				});
				const observation = observeEntryCoordination(resumed);
				const pending = resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
				await started.promise;
				await resumed.handlers.get("session_shutdown")({ reason: "reload" }, resumed.ctx);
				const snapshot = { appended: resumed.appended.length, notifications: resumed.notifications.length, themes: [...resumed.themeChanges], tools: [...resumed.getActiveTools()] };
				if (reject) verification.reject(new Error("stale verification failure"));
				else verification.resolve();
				await pending;
				assert.deepEqual({ appended: resumed.appended.length, notifications: resumed.notifications.length, themes: resumed.themeChanges, tools: resumed.getActiveTools() }, snapshot);
				assert.equal(observation.provider.inspect().phase, "disposed");
				assert.equal(observation.released(), 0);
			});
		});
	}
});

describe("reconciliation transition barrier", () => {
	it("holds reconciling synchronously and refuses commands until recovery settles", async () => {
		await withHarness({ confirm: async () => true }, async (original) => {
			await input(original, "/plan");
			await checkpointPlan(original, "# Barrier\n", 0);
			await startLifecycleCommand(original, "/plan save");
			await original.handlers.get("tool_call")({ toolCallId: "approval", toolName: "create_plan", input: { revision: 1 } }, original.ctx);
			const verification = Promise.withResolvers<void>();
			const resumed = createHarness({ cwd: original.ctx.cwd, entries: [...original.allEntries], verifyPlanFileDigest: () => verification.promise });
			const observed = observeEntryCoordination(resumed);
			const pending = resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
			try {
				assert.equal(observed.provider.inspect().phase, "reconciling");
				await input(resumed, "/plan exit");
				assert.equal(resumed.appended.length, 0);
				assert.match(resumed.notifications.at(-1)?.message ?? "", /reconcil/i);
				assert.equal(observed.released(), 0);
			} finally { verification.resolve(); await pending; }
			assert.notEqual(observed.provider.inspect().phase, "inactive");
		});
	});
});

describe("completed recovery supersession", () => {
	for (const stage of ["approval", "baseline", "completed"] as const) {
		for (const supersede of ["shutdown", "tree"] as const) {
			for (const reject of [false, true]) {
				it(`${stage} verification ignores ${reject ? "rejection" : "success"} after ${supersede}`, async () => {
					await withHarness({ confirm: async () => true, select: async () => "Create plan" }, async (original) => {
						await input(original, "/plan");
						await checkpointPlan(original, "# Recovery\n", 0);
						if (stage === "baseline") {
							await startLifecycleCommand(original, "/plan save");
							await publishLatest(original, 1);
							await checkpointPlan(original, "# Updated recovery\n", 1);
						}
						const revision = stage === "baseline" ? 2 : 1;
						await startLifecycleCommand(original, stage === "completed" ? "/plan exit" : "/plan save");
						const call = { toolCallId: "recovery-approval", toolName: "create_plan", input: { revision } };
						assert.equal((await original.handlers.get("tool_call")(call, original.ctx))?.block, undefined);
						if (stage === "completed") await original.registeredTools.get("create_plan").execute(call.toolCallId, call.input, undefined, undefined, original.ctx);
						const verification = Promise.withResolvers<void>();
						const started = Promise.withResolvers<void>();
						let calls = 0;
						const resumed = createHarness({ cwd: original.ctx.cwd, entries: [...original.allEntries], mode: "tui", verifyPlanFileDigest: async () => {
							if (stage === "baseline" && ++calls === 1) throw new PlanPublicationConflictError("not updated");
							started.resolve(); return verification.promise;
						} });
						const observed = observeEntryCoordination(resumed);
						const pending = resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
						await started.promise;
						if (supersede === "shutdown") await resumed.handlers.get("session_shutdown")({ reason: "reload" }, resumed.ctx);
						else { resumed.setBranch([]); await resumed.handlers.get("session_tree")({}, resumed.ctx); }
						const releasesBeforeOutgoing = observed.released();
						const snapshot = { appended: resumed.appended.length, notifications: resumed.notifications.length, themes: [...resumed.themeChanges], tools: [...resumed.getActiveTools()] };
						let staleContextReads = 0;
						for (const key of ["cwd", "ui", "mode", "sessionManager"]) {
							const value = resumed.ctx[key];
							Object.defineProperty(resumed.ctx, key, { get() { staleContextReads += 1; return value; } });
						}
						if (reject) verification.reject(new Error("obsolete recovery error")); else verification.resolve();
						await pending;
						assert.equal(staleContextReads, 0);
						assert.deepEqual({ appended: resumed.appended.length, notifications: resumed.notifications.length, themes: resumed.themeChanges, tools: resumed.getActiveTools() }, snapshot);
						assert.equal(observed.released(), releasesBeforeOutgoing);
						assert.equal(observed.provider.inspect().phase, supersede === "tree" ? "inactive" : "disposed");
					});
				});
			}
		}
	}
});

describe("reconciliation reentrant callbacks", () => {
	for (const boundary of ["tools", "theme", "append"] as const) {
		it(`stops outgoing restoration when ${boundary} callback navigates to an empty branch`, async () => {
			await withHarness({ confirm: async () => true }, async (original) => {
				await input(original, "/plan");
				await checkpointPlan(original, "# Reentrant restore\n", 0);
				await startLifecycleCommand(original, "/plan save");
				await original.handlers.get("tool_call")({ toolCallId: "approval", toolName: "create_plan", input: { revision: 1 } }, original.ctx);
				let callback: (() => void) | undefined;
				const resumed = createHarness({ cwd: original.ctx.cwd, entries: [...original.allEntries], mode: "tui", verifyPlanFileDigest: async () => {},
					setActiveTools: () => { if (boundary === "tools") callback?.(); },
					afterAppendEntry: () => { if (boundary === "append") callback?.(); },
				});
				let nested: Promise<void> | undefined;
				callback = () => { callback = undefined; resumed.setBranch([]); nested = resumed.handlers.get("session_tree")({}, resumed.ctx); };
				const getTheme = resumed.ctx.ui.getTheme;
				if (boundary === "theme") resumed.ctx.ui.getTheme = (name: string) => { callback?.(); return getTheme(name); };
				const observed = observeEntryCoordination(resumed);
				await resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
				await nested;
				assert.equal(resumed.getThemeName(), "dark");
				assert.equal(resumed.getActiveTools().includes("create_plan"), false);
				if (boundary === "append") assert.equal(resumed.notifications.some((item: any) => /Recovered|Completed/.test(item.message)), false);
				assert.equal(observed.released(), 1);
			});
		});
	}
});

describe("legacy reconciliation ownership", () => {
	it("does not announce migration after its activation notification navigates away", async () => {
		await withHarness({}, async (base) => {
			const resumed = createHarness({ cwd: base.ctx.cwd, entries: [{ type: "custom", customType: "plan-theme-state", data: { active: true, planPath: ".pi/plans/legacy.md" } }] });
			const observed = observeEntryCoordination(resumed);
			const notify = resumed.ctx.ui.notify;
			let nested: Promise<void> | undefined;
			resumed.ctx.ui.notify = (message: string, level: string) => {
				notify(message, level);
				if (/Plan mode active/.test(message)) { resumed.setBranch([]); nested = resumed.handlers.get("session_tree")({}, resumed.ctx); }
			};
			await resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
			await nested;
			assert.equal(resumed.notifications.some((item: any) => /legacy.*migrated/i.test(item.message)), false);
			assert.equal(resumed.getActiveTools().includes("create_plan"), false);
			assert.equal(observed.released(), 1);
		});
	});
});

describe("completed exit restoration callbacks", () => {
	it("stops before persisting or notifying when restoration shuts down reentrantly", async () => {
		await withHarness({ confirm: async () => true, select: async () => "Create plan" }, async (original) => {
			await input(original, "/plan");
			await checkpointPlan(original, "# Exit restore\n", 0);
			await publishLatest(original, 1, "/plan exit", false);
			// Tool settlement clears completion, so retain the pre-result durable entry.
			const completionIndex = original.allEntries.findLastIndex((entry: any) => entry.data?.completedPublication?.action === "exit");
			let callback: (() => void) | undefined;
			const resumed = createHarness({ cwd: original.ctx.cwd, entries: original.allEntries.slice(0, completionIndex + 1), mode: "tui", verifyPlanFileDigest: async () => {}, setActiveTools: () => callback?.() });
			let snapshot: any;
			callback = () => {
				callback = undefined;
				void resumed.handlers.get("session_shutdown")({ reason: "reload" }, resumed.ctx);
				snapshot = { appended: resumed.appended.length, notifications: resumed.notifications.length, themes: [...resumed.themeChanges] };
			};
			await resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
			assert.ok(snapshot);
			assert.deepEqual({ appended: resumed.appended.length, notifications: resumed.notifications.length, themes: resumed.themeChanges }, snapshot);
		});
	});
});

describe("legacy deferred reconciliation", () => {
	for (const supersede of ["shutdown", "tree"] as const) {
		it(`retains holds and discards migration after ${supersede}`, async () => {
			await withHarness({}, async (base) => {
				const path = Promise.withResolvers<string>();
				const started = Promise.withResolvers<void>();
				const resumed = createHarness({ cwd: base.ctx.cwd, entries: [{ type: "custom", customType: "plan-theme-state", data: { active: true } }], generatePlanPath: () => { started.resolve(); return path.promise; } });
				const observed = observeEntryCoordination(resumed);
				const pending = resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
				await started.promise;
				if (supersede === "shutdown") await resumed.handlers.get("session_shutdown")({ reason: "reload" }, resumed.ctx);
				else { resumed.setBranch([]); await resumed.handlers.get("session_tree")({}, resumed.ctx); }
				const releasesBeforeOutgoing = observed.released();
				const snapshot = [...resumed.getActiveTools()];
				path.resolve(".pi/plans/stale-legacy.md");
				await pending;
				assert.equal(resumed.appended.length, 0);
				assert.equal(resumed.notifications.length, 0);
				assert.deepEqual(resumed.getActiveTools(), snapshot);
				assert.equal(observed.released(), releasesBeforeOutgoing);
				assert.equal(observed.provider.inspect().phase, supersede === "tree" ? "inactive" : "disposed");
			});
		});
	}
});

describe("completed conflict callback fencing", () => {
	it("stops conflict conversion when persistence navigates away", async () => {
		await withHarness({ confirm: async () => true, select: async () => "Create plan" }, async (original) => {
			await input(original, "/plan");
			await checkpointPlan(original, "# Conflict recovery\n", 0);
			await publishLatest(original, 1, "/plan exit", false);
			const completionIndex = original.allEntries.findLastIndex((entry: any) => entry.data?.completedPublication?.action === "exit");
			let callback: (() => void) | undefined;
			const resumed = createHarness({ cwd: original.ctx.cwd, entries: original.allEntries.slice(0, completionIndex + 1), verifyPlanFileDigest: async () => { throw new PlanPublicationConflictError("changed"); }, afterAppendEntry: () => callback?.() });
			let nested: Promise<void> | undefined;
			callback = () => { callback = undefined; resumed.setBranch([]); nested = resumed.handlers.get("session_tree")({}, resumed.ctx); };
			await resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
			await nested;
			assert.equal(resumed.notifications.length, 0);
			assert.equal(resumed.getActiveTools().includes("create_plan"), false);
		});
	});
});

describe("publication write ownership", () => {
	it("leaves a committed create recoverable after tree supersession without completing the replacement branch", async () => {
		await withHarness({ confirm: async () => true }, async (harness) => {
			await input(harness, "/plan");
			const content = "# Owned publication\n";
			await checkpointPlan(harness, content, 0);
			const incomingBranch = [...harness.allEntries];
			await startLifecycleCommand(harness, "/plan save");
			const call = { type: "tool_call", toolCallId: "owned-write", toolName: "create_plan", input: { revision: 1 } };
			assert.equal(await harness.handlers.get("tool_call")(call, harness.ctx), undefined);
			const approvedBranch = structuredClone(harness.allEntries);
			const path = harness.appended.at(-1).data.approval.path;
			const cwd = harness.ctx.cwd;
			const occupied = await occupyFileMutationQueue(join(cwd, path));
			const execution = harness.registeredTools.get("create_plan").execute(call.toolCallId, call.input, undefined, undefined, harness.ctx);
			const outcome = execution.then((value: any) => ({ value }), (error: Error) => ({ error }));
			try {
				await assertOperationWaitsForQueue(execution);
				harness.setBranch(incomingBranch);
				const incoming = createReplacementContext(harness, "session-a");
				await harness.handlers.get("session_tree")({}, incoming);
				const staleAccesses = makeContextStale(harness.ctx);
				const entries = structuredClone(harness.allEntries);
				const notifications = [...harness.notifications];
				const tools = [...harness.getActiveTools()];
				occupied.release();
				await occupied.done;
				const result = await outcome;
				assert.match(result.error?.message ?? "", /superseded.*file.*not.*undone/i);
				assert.deepEqual(harness.allEntries, entries);
				assert.deepEqual(harness.notifications, notifications);
				assert.deepEqual(harness.getActiveTools(), tools);
				assert.deepEqual(staleAccesses, []);
				assert.deepEqual(harness.sessionNameChanges, []);
				assert.equal(await readFile(join(cwd, path), "utf8"), content);
				const approvedDigest = approvedBranch.at(-1).data.approval.digest;
				const recovered = createHarness({ cwd, entries: approvedBranch });
				await recovered.handlers.get("session_start")({ reason: "resume" }, recovered.ctx);
				assert.equal(recovered.appended.at(-1).data.publishedDigest, approvedDigest);
			} finally {
				occupied.release();
				await occupied.done;
				await outcome;
			}
		});
	});
});

describe("publication collision ownership", () => {
	for (const lifecycle of ["tree", "shutdown"] as const) {
	for (const reject of [false, true]) {
	it(`discards collision resolution ${reject ? "rejection" : "success"} after ${lifecycle}`, async () => {
		const resolving = Promise.withResolvers<void>();
		const resolution = Promise.withResolvers<string>();
		let defer = false;
		await withHarness({
			confirm: async () => true,
			resolveAvailablePlanPath: async (cwd, path) => {
				if (!defer) return resolveAvailablePlanPath(cwd, path);
				resolving.resolve();
				return resolution.promise;
			},
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Collision\n", 0);
			await startLifecycleCommand(harness, "/plan save");
			const call = { type: "tool_call", toolCallId: "collision-write", toolName: "create_plan", input: { revision: 1 } };
			assert.equal(await harness.handlers.get("tool_call")(call, harness.ctx), undefined);
			const path = harness.appended.at(-1).data.approval.path;
			const cwd = harness.ctx.cwd;
			await mkdir(dirname(join(cwd, path)), { recursive: true });
			await writeFile(join(cwd, path), "external collision");
			defer = true;
			const execution = harness.registeredTools.get("create_plan").execute(call.toolCallId, call.input, undefined, undefined, harness.ctx);
			const outcome = execution.catch((error: Error) => error);
			await resolving.promise;
			await harness.handlers.get(lifecycle === "tree" ? "session_tree" : "session_shutdown")({ reason: "reload" }, harness.ctx);
			const staleAccesses = makeContextStale(harness.ctx);
			const entries = structuredClone(harness.allEntries);
			if (reject) resolution.reject(new Error("stale resolution error"));
			else resolution.resolve(".pi/plans/replacement.md");
			const error = await outcome;
			assert.match(error.message, /superseded/i);
			assert.deepEqual(harness.allEntries, entries);
			assert.deepEqual(staleAccesses, []);
			assert.equal(await readFile(join(cwd, path), "utf8"), "external collision");
		});
	});
	}
	}
});

describe("publication postappend ownership", () => {
	for (const action of ["save", "exit"] as const) {
	it(`does not report ${action} completion or name after shutdown from a durable publication observer`, async () => {
		let armed = false;
		let pendingChecks = 0;
		let shutdown: Promise<void> | undefined;
		let accesses: string[] = [];
		let harness: any;
		await withHarness({ confirm: async () => true, select: async () => "Create plan", hasPendingMessages: () => armed && action === "exit" && pendingChecks++ > 0, afterAppendEntry: () => {
			if (!armed) return;
			armed = false;
			shutdown = harness.handlers.get("session_shutdown")({ reason: "reload" }, harness.ctx);
			accesses = makeContextStale(harness.ctx);
		} }, async (current) => {
			harness = current;
			await input(harness, "/plan");
			const content = "# Postappend\n";
			await checkpointPlan(harness, content, 0);
			await startLifecycleCommand(harness, `/plan ${action}`);
			const call = { type: "tool_call", toolCallId: "postappend-write", toolName: "create_plan", input: { revision: 1 } };
			assert.equal(await harness.handlers.get("tool_call")(call, harness.ctx), undefined);
			const cwd = harness.ctx.cwd;
			const path = harness.appended.at(-1).data.approval.path;
			armed = true;
			await assert.rejects(harness.registeredTools.get("create_plan").execute(call.toolCallId, call.input, undefined, undefined, harness.ctx), /superseded/i);
			await shutdown;
			assert.deepEqual(accesses, []);
			assert.deepEqual(harness.sessionNameChanges, []);
			assert.equal(await readFile(join(cwd, path), "utf8"), content);
			if (action === "save") assert.equal(harness.appended.at(-1).data.completedPublication.path, path);
			else assert.equal(harness.appended.at(-1).data.completedPublication, undefined);
		});
	});
	}
});

describe("publication write ownership matrix", () => {
	for (const kind of ["create", "update"] as const) {
		for (const lifecycle of ["tree", "shutdown"] as const) {
			for (const reject of [false, true]) {
				it(`${kind} ${reject ? "rejection" : "resolution"} after ${lifecycle} is inert`, async () => {
					await withHarness({ confirm: async () => true }, async (harness) => {
						await input(harness, "/plan");
						await checkpointPlan(harness, "# Original\n", 0);
						if (kind === "update") {
							await publishLatest(harness, 1);
							await checkpointPlan(harness, "# Updated\n", 1);
						}
						const incomingBranch = [...harness.allEntries];
						await startLifecycleCommand(harness, "/plan save");
						const call = { type: "tool_call", toolCallId: "matrix-write", toolName: "create_plan", input: { revision: kind === "create" ? 1 : 2 } };
						assert.equal(await harness.handlers.get("tool_call")(call, harness.ctx), undefined);
						const approval = structuredClone(harness.appended.at(-1).data.approval);
						const cwd = harness.ctx.cwd;
						const absolutePath = join(cwd, approval.path);
						const occupied = await occupyFileMutationQueue(absolutePath);
						const controller = new AbortController();
						const execution = harness.registeredTools.get("create_plan").execute(call.toolCallId, call.input, controller.signal, undefined, harness.ctx);
						const outcome = execution.catch((error: Error) => error);
						try {
							await assertOperationWaitsForQueue(execution);
							let replacement: any;
							if (lifecycle === "tree") {
								harness.setBranch(incomingBranch);
								await harness.handlers.get("session_tree")({}, createReplacementContext(harness, "session-a"));
							} else {
								await harness.handlers.get("session_shutdown")({ reason: "new" }, harness.ctx);
								replacement = createHarness({ cwd, sessionId: "replacement" });
								await replacement.handlers.get("session_start")({ reason: "new" }, replacement.ctx);
								await input(replacement, "/plan");
							}
							const replacementEntries = structuredClone(replacement?.allEntries);
							const entries = structuredClone(harness.allEntries);
							const notifications = [...harness.notifications];
							const tools = [...harness.getActiveTools()];
							const stale = makeContextStale(harness.ctx);
							if (reject) {
								if (kind === "create") controller.abort();
								else await writeFile(absolutePath, "external conflict");
							}
							occupied.release();
							await occupied.done;
							assert.match((await outcome).message, /superseded/i);
							assert.deepEqual(stale, []);
							assert.deepEqual(harness.allEntries, entries);
							assert.deepEqual(harness.notifications, notifications);
							assert.deepEqual(harness.getActiveTools(), tools);
							assert.deepEqual(replacement?.allEntries, replacementEntries);
							if (!reject) assert.equal(await readFile(absolutePath, "utf8"), kind === "create" ? "# Original\n" : "# Updated\n");
							else if (kind === "update") assert.equal(await readFile(absolutePath, "utf8"), "external conflict");
							else await assert.rejects(readFile(absolutePath), { code: "ENOENT" });
						} finally {
							occupied.release();
							await occupied.done;
							await outcome;
						}
					});
				});
			}
		}
	}
});

describe("publication same-branch intent", () => {
	it("keeps a delivered newer input as save intent while the approved write completes", async () => {
		await withHarness({ confirm: async () => true, select: async () => "Create plan" }, async (harness) => {
			await input(harness, "/plan");
			const content = "# Same branch\n";
			await checkpointPlan(harness, content, 0);
			await startLifecycleCommand(harness, "/plan exit");
			const call = { type: "tool_call", toolCallId: "input-write", toolName: "create_plan", input: { revision: 1 } };
			assert.equal(await harness.handlers.get("tool_call")(call, harness.ctx), undefined);
			const path = harness.appended.at(-1).data.approval.path;
			const occupied = await occupyFileMutationQueue(join(harness.ctx.cwd, path));
			const execution = harness.registeredTools.get("create_plan").execute(call.toolCallId, call.input, undefined, undefined, harness.ctx);
			try {
				await assertOperationWaitsForQueue(execution);
				await input(harness, "newer user instructions");
				occupied.release();
				await occupied.done;
				const result = await execution;
				assert.equal(result.terminate, undefined);
				assert.equal(harness.appended.at(-1).data.completedPublication.action, "save");
				assert.equal(await readFile(join(harness.ctx.cwd, path), "utf8"), content);
				assert.equal(harness.getActiveTools().includes("bash"), false);
			} finally {
				occupied.release();
				await occupied.done;
				await execution.catch(() => undefined);
			}
		});
	});
});

describe("publication postappend input", () => {
	it("returns save semantics when input arrives from the completion observer", async () => {
		let armed = false;
		let newerInput: Promise<any> | undefined;
		let harness: any;
		await withHarness({ confirm: async () => true, select: async () => "Create plan", afterAppendEntry: () => {
			if (!armed) return;
			armed = false;
			newerInput = harness.handlers.get("input")({ source: "interactive", text: "continue planning" }, harness.ctx);
		} }, async (current) => {
			harness = current;
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Continue after publication\n", 0);
			await startLifecycleCommand(harness, "/plan exit");
			const call = { type: "tool_call", toolCallId: "postappend-input", toolName: "create_plan", input: { revision: 1 } };
			assert.equal(await harness.handlers.get("tool_call")(call, harness.ctx), undefined);
			armed = true;
			const result = await harness.registeredTools.get("create_plan").execute(call.toolCallId, call.input, undefined, undefined, harness.ctx);
			await newerInput;
			assert.equal(result.terminate, undefined);
			assert.equal(harness.appended.at(-1).data.completedPublication.action, "save");
			assert.equal(harness.getActiveTools().includes("bash"), false);
		});
	});
});

describe("recovery transition phases", () => {
	it("coordinates inactive mismatched completion before applying and persisting its downgrade", async () => {
		await withHarness({ confirm: async () => true, select: async () => "Create plan" }, async (original) => {
			await input(original, "/plan");
			await checkpointPlan(original, "# One\n", 0);
			await publishLatest(original, 1, "/plan exit", false);
			await checkpointPlan(original, "# Two\n", 1);
			const latest = original.allEntries.findLast((entry: any) => entry.data?.completedPublication);
			const entries = [...original.allEntries, { ...latest, id: "inactive-mismatch-phase", parentId: original.allEntries.at(-1).id, data: { ...latest.data, active: false } }];
			let observed: any;
			const phases: string[] = [];
			const resumed = createHarness({ cwd: original.ctx.cwd, entries,
				setActiveTools: () => phases.push(observed.provider.inspect().phase),
				appendEntry: () => phases.push(observed.provider.inspect().phase),
			});
			observed = observeEntryCoordination(resumed);
			await resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
			assert.equal(phases[0], "entering");
			assert.equal(observed.provider.inspect().phase, "active");
			assert.equal(observed.released(), 0);
			assert.equal(resumed.appended.filter((entry: any) => entry.data.completedPublication?.action === "save").length, 1);
			assert.equal(resumed.appended.at(-1).data.active, true);
		});
	});
});

async function withMismatchedRecovery(run: (original: any, entries: Entry[]) => Promise<void>): Promise<void> {
	await withHarness({ confirm: async () => true, select: async () => "Create plan" }, async (original) => {
		await input(original, "/plan");
		await checkpointPlan(original, "# One\n", 0);
		await publishLatest(original, 1, "/plan exit", false);
		await checkpointPlan(original, "# Two\n", 1);
		const latest = original.allEntries.findLast((entry: any) => entry.data?.completedPublication);
		const entries = [...original.allEntries, { ...latest, id: "inactive-recovery", parentId: original.allEntries.at(-1).id, data: { ...latest.data, active: false } }];
		await run(original, entries);
	});
}

describe("recovery downgrade failures", () => {
	for (const failure of ["tools", "persist"] as const) {
		it(`retains protection and completion when ${failure} fails`, async () => {
			await withMismatchedRecovery(async (original, entries) => {
				const fail = () => { throw new Error(`injected ${failure} failure`); };
				const resumed = createHarness({ cwd: original.ctx.cwd, entries,
					setActiveTools: failure === "tools" ? fail : undefined,
					appendEntry: failure === "persist" ? fail : undefined,
				});
				const observed = observeEntryCoordination(resumed);
				await resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
				assert.equal(observed.provider.inspect().phase, "entering");
				assert.equal(observed.released(), 0);
				assert.equal(resumed.appended.length, 0);
				assert.equal(entries.at(-1).data.completedPublication.action, "exit");
				assert.match(resumed.notifications.at(-1).message, /not recovered safely/);
				assert.equal(resumed.sessionNameChanges.length, 0);
			});
		});
	}
});

describe("settled downgrade ownership", () => {
	it("does not notify after shutdown from completion persistence", async () => {
		let harness: any;
		let armed = false;
		let writes = 0;
		let shutdown: Promise<void> | undefined;
		let notificationCount = 0;
		await withHarness({ confirm: async () => true, select: async () => "Create plan",
			afterAppendEntry: () => {
				if (!armed || ++writes !== 2) return;
				armed = false;
				shutdown = harness.handlers.get("session_shutdown")({ reason: "quit" }, harness.ctx);
				notificationCount = harness.notifications.length;
			},
		}, async (original) => {
			harness = original;
			await input(original, "/plan");
			await checkpointPlan(original, "# One\n", 0);
			await publishLatest(original, 1, "/plan exit", false);
			await checkpointPlan(original, "# Two\n", 1);
			const observed = observeEntryCoordination(original);
			armed = true;
			await original.handlers.get("agent_settled")({}, original.ctx);
			await shutdown;
			assert.equal(writes, 2);
			assert.equal(original.notifications.length, notificationCount);
			assert.equal(observed.provider.inspect().phase, "disposed");
			assert.equal(observed.released(), 0);
		});
	});
});

describe("tree downgrade protection", () => {
	it("finishes an already-active branch downgrade under active protection", async () => {
		await withMismatchedRecovery(async (original, entries) => {
			entries.at(-1).data.active = true;
			const resumed = createHarness({ cwd: original.ctx.cwd, entries });
			const observed = observeEntryCoordination(resumed);
			await resumed.handlers.get("session_tree")({}, resumed.ctx);
			assert.equal(observed.provider.inspect().phase, "active");
			assert.equal(observed.released(), 0);
			assert.equal(resumed.appended.filter((entry: any) => entry.data.completedPublication?.action === "save").length, 1);
			assert.equal(resumed.appended.at(-1).data.active, true);
			assert.equal(resumed.appended.at(-1).data.publicationState, "dirty");
			assert.equal(resumed.sessionNameChanges.length, 0);
		});
	});
});

describe("reentrant recovery ownership", () => {
	for (const event of ["session_shutdown", "session_tree"] as const) {
		it(`abandons the outgoing downgrade when tools trigger ${event}`, async () => {
			await withMismatchedRecovery(async (original, entries) => {
				let resumed: any;
				let armed = true;
				let replacement: Promise<void> | undefined;
				const exactExit = entries.find((entry: any) => entry.data?.completedPublication && entry.data.checkpointRevision === 1);
				resumed = createHarness({ cwd: original.ctx.cwd, entries,
					setActiveTools: () => {
						if (!armed) return;
						armed = false;
						if (event === "session_tree") resumed.setBranch(parentLinkedBranch(entries, exactExit));
						replacement = resumed.handlers.get(event)({ reason: "quit" }, resumed.ctx);
					},
				});
				const observed = observeEntryCoordination(resumed);
				await resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
				await replacement;
				assert.equal(resumed.appended.filter((entry: any) => entry.data.completedPublication?.action === "save").length, 0);
				assert.equal(resumed.notifications.some((entry: any) => /no longer matches/.test(entry.message)), false);
				assert.equal(observed.released(), event === "session_tree" ? 1 : 0);
				if (event === "session_shutdown") {
					assert.equal(resumed.appended.length, 0);
					assert.equal(observed.provider.inspect().phase, "disposed");
				} else {
					assert.equal(resumed.appended.at(-1).data.active, false);
					assert.equal(resumed.appended.at(-1).data.checkpointRevision, 1);
				}
			});
		});
	}
});

describe("disposed downgrade refusal", () => {
	it("does not consume a mismatched completion on a late settled event", async () => {
		await withHarness({ confirm: async () => true, select: async () => "Create plan" }, async (original) => {
			await input(original, "/plan");
			await checkpointPlan(original, "# One\n", 0);
			await publishLatest(original, 1, "/plan exit", false);
			await checkpointPlan(original, "# Two\n", 1);
			const observed = observeEntryCoordination(original);
			await original.handlers.get("session_shutdown")({ reason: "quit" }, original.ctx);
			const writes = original.appended.length;
			const notifications = original.notifications.length;
			await original.handlers.get("agent_settled")({}, original.ctx);
			assert.equal(original.appended.length, writes);
			assert.equal(original.notifications.length, notifications);
			assert.equal(observed.released(), 0);
		});
	});
});

describe("downgrade retry tool snapshot", () => {
	it("retains the pre-Plan tools after a failed persistence is retried", async () => {
		await withMismatchedRecovery(async (original, entries) => {
			let fail = true;
			const resumed = createHarness({ cwd: original.ctx.cwd, entries,
				appendEntry: () => { if (fail) throw new Error("retryable persistence failure"); },
			});
			const observed = observeEntryCoordination(resumed);
			await resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
			fail = false;
			await resumed.handlers.get("agent_settled")({}, resumed.ctx);
			assert.equal(observed.provider.inspect().phase, "active");
			assert.equal(resumed.appended.at(-1).data.previousToolNames.includes("write"), true);
			assert.equal(resumed.appended.filter((entry: any) => entry.data.completedPublication?.action === "save").length, 1);
			assert.equal(observed.released(), 0);
		});
	});
});

describe("exact-checkpoint downgrade retry", () => {
	for (const failure of ["tools", "persist"] as const) {
		it(`finishes the inactive exit downgrade after ${failure} fails`, async () => {
			await withHarness({ confirm: async () => true, select: async () => "Create plan" }, async (original) => {
				await input(original, "/plan");
				await checkpointPlan(original, "# Exact checkpoint\n", 0);
				await publishLatest(original, 1, "/plan exit", false);
				const latest = original.allEntries.findLast((entry: any) => entry.data?.completedPublication);
				const snapshot = [...latest.data.previousToolNames];
				const entries = [...original.allEntries, { ...latest, id: "inactive-exact-retry", parentId: original.allEntries.at(-1).id, data: { ...latest.data, active: false } }];
				let failing = true;
				const fail = () => { if (failing) throw new Error(`retryable ${failure} failure`); };
				const resumed = createHarness({ cwd: original.ctx.cwd, entries,
					setActiveTools: failure === "tools" ? fail : undefined,
					// This fixture's appendEntry injector fails before the durable append.
					appendEntry: failure === "persist" ? fail : undefined,
				});
				const observed = observeEntryCoordination(resumed);
				await resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
				assert.equal(observed.provider.inspect().phase, "entering");
				assert.equal(resumed.appended.length, 0);
				assert.equal(resumed.getActiveTools().includes("bash"), false);
				failing = false;
				await resumed.handlers.get("agent_settled")({}, resumed.ctx);
				assert.equal(observed.provider.inspect().phase, "active");
				assert.equal(observed.released(), 0);
				assert.equal(resumed.getActiveTools().includes("bash"), false);
				assert.equal(resumed.getActiveTools().includes("write"), false);
				assert.equal(resumed.appended.at(-1).data.active, true);
				assert.deepEqual(resumed.appended.at(-1).data.previousToolNames, snapshot);
				assert.equal(resumed.appended.filter((entry: any) => entry.data.completedPublication?.action === "save").length, 1);
				assert.equal(resumed.appended.some((entry: any) => entry.data.completedPublication?.action === "exit" || !entry.data.active), false);
				assert.equal(resumed.notifications.some((entry: any) => /exited Plan mode/.test(entry.message)), false);
				await resumed.handlers.get("agent_settled")({}, resumed.ctx);
				assert.equal(resumed.appended.filter((entry: any) => entry.data.completedPublication?.action === "save").length, 1);
			});
		});
	}
});

async function withExactExitRecovery(run: (original: any, entries: Entry[]) => Promise<void>) {
	await withHarness({ confirm: async () => true, select: async () => "Create plan" }, async (original) => {
		await input(original, "/plan");
		await checkpointPlan(original, "# Recovered exact exit\n", 0);
		await publishLatest(original, 1, "/plan exit", false);
		const index = original.allEntries.findLastIndex((entry: Entry) => entry.data?.completedPublication?.action === "exit");
		await run(original, structuredClone(original.allEntries.slice(0, index + 1)));
	});
}

describe("recovered exact exit coordination", () => {
	it("enters exiting before restoration and keeps active enforcement until the inactive append", async () => {
		await withExactExitRecovery(async (original, entries) => {
			let observed: any;
			const phases: string[] = [];
			let policy: Promise<any> | undefined;
			const resumed = createHarness({ cwd: original.ctx.cwd, entries, mode: "tui",
				setActiveTools: () => phases.push(observed.provider.inspect().phase),
				appendEntry: () => {
					phases.push(observed.provider.inspect().phase);
					policy = resumed.handlers.get("user_bash")({}, resumed.ctx);
				},
			});
			observed = observeEntryCoordination(resumed);
			await resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
			assert.ok(phases.length >= 2);
			assert.ok(phases.every((phase) => phase === "exiting"), phases.join(","));
			assert.equal((await policy)?.result.exitCode, 126);
			assert.equal(resumed.appended.at(-1).data.active, false);
			assert.equal(resumed.appended.at(-1).data.completedPublication, undefined);
			assert.equal(await resumed.handlers.get("user_bash")({}, resumed.ctx), undefined);
			assert.equal(observed.released(), 1);
		});
	});
});

describe("recovered exact exit failures", () => {
	for (const failure of ["tools", "theme", "persist", "observer"] as const) {
		it(`retains exact retry intent and protection after ${failure} failure`, async () => {
			await withExactExitRecovery(async (original, entries) => {
				entries.at(-1)!.data.previousThemeName = "dark";
				const tools = [...entries.at(-1)!.data.previousToolNames];
				let armed = true;
				const fail = () => { if (armed) throw new Error("injected exit failure"); };
				const resumed = createHarness({ cwd: original.ctx.cwd, entries, mode: "tui",
					setActiveTools: failure === "tools" ? fail : undefined,
					appendEntry: failure === "persist" ? fail : undefined,
					afterAppendEntry: failure === "observer" ? fail : undefined,
				});
				const setTheme = resumed.ctx.ui.setTheme;
				resumed.ctx.ui.setTheme = (theme: any) => failure === "theme" && armed && theme.name !== "plan"
					? { success: false, error: "injected theme refusal" } : setTheme(theme);
				const observed = observeEntryCoordination(resumed);
				await resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
				assert.equal((await resumed.handlers.get("user_bash")({}, resumed.ctx))?.result.exitCode, 126);
				assert.equal(observed.provider.inspect().phase, "exiting");
				assert.equal(observed.released(), 0);
				assert.equal(resumed.appended.length, failure === "observer" ? 1 : 0);
				assert.equal(resumed.notifications.some((item: any) => /Completed the already-published/.test(item.message)), false);
				await resumed.handlers.get("agent_settled")({}, resumed.ctx);
				assert.equal((await resumed.handlers.get("user_bash")({}, resumed.ctx))?.result.exitCode, 126);
				armed = false;
				// Retry the still-owned memory, including the completion left after an
				// observer threw *after* the inactive record became durable.
				await resumed.handlers.get("agent_settled")({}, resumed.ctx);
				assert.equal(resumed.appended.at(-1).data.active, false);
				assert.equal(resumed.appended.at(-1).data.completedPublication, undefined);
				assert.deepEqual(resumed.getActiveTools(), tools);
				assert.equal(resumed.appended.some((entry: Entry) => entry.data.completedPublication?.action === "save"), false);
				assert.equal(observed.released(), 1);
			});
		});
	}
});

describe("recovered exact exit callback supersession", () => {
	for (const stage of ["tools", "theme", "footer", "status", "append"] as const) {
		for (const event of ["session_shutdown", "session_tree"] as const) {
			it(`stops outgoing ${stage} continuation after ${event}`, async () => {
				await withExactExitRecovery(async (original, entries) => {
					entries.at(-1)!.data.previousThemeName = "dark";
					const incoming = parentLinkedBranch(entries, entries.find((entry: Entry) => entry.data?.active && !entry.data?.publishedDigest));
					let armed = true;
					let replacement: Promise<void> | undefined;
					let snapshot: any;
					let resumed: any;
					const capture = () => ({ writes: resumed.appended.length, notifications: resumed.notifications.length, themes: [...resumed.themeChanges] });
					const supersede = () => {
						if (!armed) return;
						armed = false;
						if (event === "session_tree") resumed.setBranch([...incoming]);
						replacement = resumed.handlers.get(event)({ reason: "quit" }, resumed.ctx);
						snapshot = capture();
					};
					resumed = createHarness({ cwd: original.ctx.cwd, entries, mode: "tui",
						setActiveTools: stage === "tools" ? supersede : undefined,
						afterAppendEntry: stage === "append" ? supersede : undefined,
					});
					for (const [name, selected] of [["setTheme", "theme"], ["setFooter", "footer"], ["setStatus", "status"]]) {
						const originalCallback = resumed.ctx.ui[name];
						resumed.ctx.ui[name] = (...args: any[]) => {
							const result = originalCallback(...args);
							if (stage === selected) supersede();
							return result;
						};
					}
					const observed = observeEntryCoordination(resumed);
					await resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
					await replacement;
					assert.ok(snapshot);
					assert.equal(resumed.notifications.some((item: any) => /Completed the already-published|not exited safely/.test(item.message)), false);
					assert.equal(observed.released(), 0);
					if (event === "session_shutdown") {
						assert.deepEqual(capture(), snapshot);
						assert.equal(observed.provider.inspect().phase, "disposed");
					} else {
						assert.equal(resumed.appended.at(-1).data.active, true);
						assert.equal(resumed.appended.at(-1).data.completedPublication, undefined);
						assert.equal(resumed.getActiveTools().includes("write"), false);
						assert.equal((await resumed.handlers.get("user_bash")({}, resumed.ctx))?.result.exitCode, 126);
					}
				});
			});
		}
	}
});

describe("recovered approval exit reporting", () => {
	it("does not claim exit before recovered deactivation succeeds", async () => {
		await withExactExitRecovery(async (original, entries) => {
			const data = entries.at(-1)!.data;
			data.approval = { ...data.completedPublication, kind: "create" };
			delete data.completedPublication;
			delete data.publishedPath;
			delete data.publishedRevision;
			delete data.publishedDigest;
			data.publicationState = "unpublished";
			const resumed = createHarness({ cwd: original.ctx.cwd, entries,
				setActiveTools: () => { throw new Error("restore unavailable"); },
			});
			const observed = observeEntryCoordination(resumed);
			await resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
			assert.equal((await resumed.handlers.get("user_bash")({}, resumed.ctx))?.result.exitCode, 126);
			assert.equal(resumed.notifications.some((item: any) => /kept Plan mode exited/.test(item.message)), false);
			assert.equal(resumed.appended.at(-1).data.completedPublication.action, "exit");
			assert.equal(observed.released(), 0);
		});
	});
});

describe("recovered exit intent lifetime", () => {
	for (const downgrade of ["checkpoint", "file conflict"] as const) {
		it(`allows a later deferred exit after ${downgrade} downgrade consumption`, async () => {
			await withExactExitRecovery(async (original, entries) => {
				let failing = true;
				const resumed = createHarness({ cwd: original.ctx.cwd, entries,
					setActiveTools: () => { if (failing) throw new Error("restore unavailable"); },
					select: async () => "Update plan",
					confirm: async () => true,
				});
				await resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
				assert.equal((await resumed.handlers.get("user_bash")({}, resumed.ctx))?.result.exitCode, 126);
				failing = false;
				const publishedPath = join(original.ctx.cwd, entries.at(-1)!.data.publishedPath);
				const publishedContent = await readFile(publishedPath, "utf8");
				if (downgrade === "checkpoint") await checkpointPlan(resumed, "# Superseding checkpoint\n", 1);
				else await writeFile(publishedPath, "external edit\n");
				await resumed.handlers.get("agent_settled")({}, resumed.ctx);
				assert.equal(resumed.appended.at(-1).data.completedPublication, undefined);
				assert.equal(resumed.appended.at(-1).data.active, true);

				if (downgrade === "file conflict") {
					assert.equal(await readFile(publishedPath, "utf8"), "external edit\n");
					await writeFile(publishedPath, publishedContent);
					await checkpointPlan(resumed, "# Superseding checkpoint\n", 1);
				}

				const lifecycle = await input(resumed, "/plan exit");
				assert.equal(lifecycle.action, "dispatched");
				await resumed.handlers.get("before_agent_start")({ prompt: lifecycle.text, systemPrompt: "base" }, resumed.ctx);
				await checkpointPlan(resumed, "# Final checkpoint\n", 2);
				resumed.ctx.ui.select = async () => "Exit without publishing";
				const gate = await resumed.handlers.get("tool_call")({ toolCallId: "later-exit", toolName: "create_plan", input: { revision: 3 } }, resumed.ctx);
				assert.match(gate.reason, /chose to exit/);
				assert.equal((await resumed.handlers.get("user_bash")({}, resumed.ctx))?.result.exitCode, 126);
				await resumed.handlers.get("agent_settled")({}, resumed.ctx);
				assert.equal(resumed.appended.at(-1).data.active, false);
				assert.equal(await resumed.handlers.get("user_bash")({}, resumed.ctx), undefined);
			});
		});
	}
});

describe("ordinary exit retry intent", () => {
	it("retains completed publication through a failed exit and retries settlement", async () => {
		let failRestore = false;
		await withHarness({
			confirm: async () => true,
			select: async () => "Create plan",
			setActiveTools: () => { if (failRestore) throw new Error("injected ordinary restoration failure"); },
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Retry ordinary exit\n", 0);
			await publishLatest(harness, 1, "/plan exit", false);
			failRestore = true;
			await harness.handlers.get("agent_settled")({}, harness.ctx);
			assert.equal((await harness.handlers.get("user_bash")({}, harness.ctx))?.result.exitCode, 126);
			failRestore = false;
			await harness.handlers.get("agent_settled")({}, harness.ctx);
			assert.equal(harness.appended.at(-1).data.active, false, "settlement must retry the retained completed exit");
			assert.equal(harness.appended.at(-1).data.completedPublication, undefined);
			assert.equal(harness.getActiveTools().includes("bash"), true);
		});
	});
});

describe("deferred exit retry intent", () => {
	it("retains exit without publication through a failed restoration", async () => {
		let failRestore = false;
		let choices = 0;
		await withHarness({
			confirm: async () => true,
			select: async () => ++choices === 1 ? "Create plan" : "Exit without publishing",
			setActiveTools: () => { if (failRestore) throw new Error("injected deferred restoration failure"); },
		}, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Initial checkpoint\n", 0);
			await startLifecycleCommand(harness, "/plan exit");
			await checkpointPlan(harness, "# Revised checkpoint\n", 1);
			const gate = await harness.handlers.get("tool_call")({
				type: "tool_call", toolCallId: "deferred-retry", toolName: "create_plan", input: { revision: 2 },
			}, harness.ctx);
			assert.equal(gate?.block, true);
			failRestore = true;
			await harness.handlers.get("agent_settled")({}, harness.ctx);
			assert.equal((await harness.handlers.get("user_bash")({}, harness.ctx))?.result.exitCode, 126);
			failRestore = false;
			await harness.handlers.get("agent_settled")({}, harness.ctx);
			assert.equal(harness.appended.at(-1).data.active, false, "settlement must retry the deferred exit");
			assert.equal(harness.appended.at(-1).data.publishedPath, undefined);
			assert.equal(choices, 2, "retry must not ask for another decision");
		});
	});
});

describe("factory publication drain", () => {
	for (const navigation of ["tree", "session"] as const) {
		it(`refuses commands on an inactive ${navigation} until the old publication drains`, async () => {
			await withHarness({ confirm: async () => true }, async (harness) => {
				const observed = observeEntryCoordination(harness);
				await input(harness, "/plan");
				await checkpointPlan(harness, "# Drain\n", 0);
				await startLifecycleCommand(harness, "/plan save");
				const call = { toolCallId: "drain", toolName: "create_plan", input: { revision: 1 } };
				assert.equal(await harness.handlers.get("tool_call")(call, harness.ctx), undefined);
				const path = harness.appended.at(-1).data.approval.path;
				const occupied = await occupyFileMutationQueue(join(harness.ctx.cwd, path));
				const execution = harness.registeredTools.get("create_plan").execute(call.toolCallId, call.input, undefined, undefined, harness.ctx);
				const outcome = execution.catch((error: Error) => error);
				try {
					await assertOperationWaitsForQueue(execution);
					harness.setBranch([]);
					const current = createReplacementContext(harness, navigation === "session" ? "session-b" : "session-a");
					await harness.handlers.get(navigation === "tree" ? "session_tree" : "session_start")({ reason: "new" }, current);
					const stale = makeContextStale(harness.ctx);
					const entries = harness.appended.length;
					await inputWithContext(harness, current, "/plan");
					assert.equal(harness.appended.length, entries, "publication drain must refuse activation on the incoming branch");
					assert.match(harness.notifications.at(-1).message, /publication.*progress/i);
					occupied.release();
					await occupied.done;
					assert.match((await outcome).message, /superseded/i);
					assert.notEqual(observed.provider.inspect().phase, "inactive", "old publication finally cannot release");
					assert.equal(observed.released(), 0);
					await inputWithContext(harness, current, "/plan status");
					assert.equal(observed.provider.inspect().phase, "inactive");
					assert.equal(observed.released(), 1);
					await inputWithContext(harness, current, "/plan");
					assert.equal(harness.appended.at(-1).data.active, true);
					assert.equal(harness.appended.at(-1).data.ownerSessionId, navigation === "session" ? "session-b" : "session-a");
					assert.deepEqual(stale, []);
				} finally {
					occupied.release();
					await occupied.done;
					await outcome;
				}
			});
		});
	}
});

describe("publication drain cleanup", () => {
	for (const kind of ["create", "update"] as const) {
		for (const reject of [false, true]) {
			it(`${kind} ${reject ? "failure" : "success"} drains before the next command`, async () => {
				await withHarness({ confirm: async () => true }, async (harness) => {
					await input(harness, "/plan");
					await checkpointPlan(harness, "# Original\n", 0);
					if (kind === "update") {
						await publishLatest(harness, 1);
						await checkpointPlan(harness, "# Updated\n", 1);
					}
					await startLifecycleCommand(harness, "/plan save");
					const call = { toolCallId: "cleanup", toolName: "create_plan", input: { revision: kind === "create" ? 1 : 2 } };
					assert.equal(await harness.handlers.get("tool_call")(call, harness.ctx), undefined);
					const path = join(harness.ctx.cwd, harness.appended.at(-1).data.approval.path);
					const occupied = await occupyFileMutationQueue(path);
					const controller = new AbortController();
					const execution = harness.registeredTools.get("create_plan").execute(call.toolCallId, call.input, controller.signal, undefined, harness.ctx);
					const outcome = execution.then(() => "success", () => "failure");
					try {
						await assertOperationWaitsForQueue(execution);
						await input(harness, "/plan status");
						assert.match(harness.notifications.at(-1).message, /publication.*progress/i);
						if (reject) {
							if (kind === "create") controller.abort();
							else await writeFile(path, "external conflict");
						}
						occupied.release();
						await occupied.done;
						assert.equal(await outcome, reject ? "failure" : "success");
						await input(harness, "/plan status");
						assert.match(harness.notifications.at(-1).message, /Plan status: active/);
					} finally {
						occupied.release();
						await occupied.done;
						await outcome;
					}
				});
			});
		}
	}
});

describe("publication drain lifecycle boundaries", () => {
	it("does not retry or touch a disposed context after shutdown and drain", async () => {
		await withHarness({ confirm: async () => true }, async (harness) => {
			await input(harness, "/plan");
			await checkpointPlan(harness, "# Shutdown drain\n", 0);
			await startLifecycleCommand(harness, "/plan save");
			const call = { toolCallId: "shutdown-drain", toolName: "create_plan", input: { revision: 1 } };
			assert.equal(await harness.handlers.get("tool_call")(call, harness.ctx), undefined);
			const occupied = await occupyFileMutationQueue(join(harness.ctx.cwd, harness.appended.at(-1).data.approval.path));
			const execution = harness.registeredTools.get("create_plan").execute(call.toolCallId, call.input, undefined, undefined, harness.ctx);
			const outcome = execution.catch((error: Error) => error);
			try {
				await assertOperationWaitsForQueue(execution);
				harness.setBranch([]);
				await harness.handlers.get("session_tree")({}, harness.ctx);
				await harness.handlers.get("session_shutdown")({ reason: "quit" }, harness.ctx);
				const stale = makeContextStale(harness.ctx);
				const entries = harness.appended.length;
				occupied.release();
				await occupied.done;
				assert.match((await outcome).message, /superseded/i);
				await inputWithContext(harness, { isIdle: () => true }, "/plan");
				assert.equal(harness.appended.length, entries);
				assert.deepEqual(stale, []);
			} finally {
				occupied.release();
				await occupied.done;
				await outcome;
			}
		});
	});
});

describe("entry rollback evidence", () => {
	it("retains active enforcement after an append observer throws and requires reconciliation", async () => {
		let fail = true;
		await withHarness({ afterAppendEntry: () => { if (fail) throw new Error("observer failed after append"); } }, async (harness) => {
			const observed = observeEntryCoordination(harness);
			await input(harness, "/plan");
			assert.equal(harness.appended.at(-1).data.active, true);
			assert.equal((await harness.handlers.get("user_bash")({}, harness.ctx))?.result.exitCode, 126);
			assert.match(harness.notifications.at(-1).message, /recovery needed/i);
			assert.doesNotMatch(harness.notifications.at(-1).message, /Normal tools and theme remain active/);
			assert.equal(observed.released(), 0);
			fail = false;
			await input(harness, "/plan");
			assert.equal(harness.appended.length, 1, "uncertain entry cannot mint another identity");
			await harness.handlers.get("session_start")({ reason: "resume" }, harness.ctx);
			assert.equal((await harness.handlers.get("user_bash")({}, harness.ctx))?.result.exitCode, 126);
		});
	});
});

describe("entry cleanup proof", () => {
	for (const failure of ["tools", "theme", "footer", "status"]) {
		it(`requires recovery when cancelled activation cannot restore ${failure}`, async () => {
			let onTools: (() => void) | undefined;
			await withHarness({ mode: "tui", setActiveTools: () => onTools?.() }, async (harness) => {
				const observed = observeEntryCoordination(harness);
				onTools = () => {
					onTools = failure === "tools" ? () => { throw new Error("restore tools failed"); } : undefined;
					if (failure === "theme") harness.ctx.ui.setTheme = () => ({ success: false });
					if (failure === "footer") harness.ctx.ui.setFooter = () => { throw new Error("footer failed"); };
					if (failure === "status") harness.ctx.ui.setStatus = () => { throw new Error("status failed"); };
					void harness.handlers.get("input")({ text: "new task", source: "interactive" }, harness.ctx);
				};
				await input(harness, "/plan");
				assert.match(harness.notifications.at(-1)?.message ?? "", /recovery needed/i);
				assert.equal(harness.appended.length, 0);
				assert.equal(observed.released(), 0);
				onTools = undefined;
				await input(harness, "/plan");
				assert.equal(harness.appended.length, 0, "failed cleanup cannot authorize a fresh entry");
			});
		});
	}
});

describe("entry append cancellation evidence", () => {
	it("reports recovery when an append observer cancels activation without throwing", async () => {
		let onAppend: (() => void) | undefined;
		await withHarness({ afterAppendEntry: () => onAppend?.() }, async (harness) => {
			const observed = observeEntryCoordination(harness);
			onAppend = () => {
				onAppend = undefined;
				void harness.handlers.get("input")({ text: "new task", source: "interactive" }, harness.ctx);
			};
			await input(harness, "/plan");
			assert.match(harness.notifications.at(-1)?.message ?? "", /recovery needed/i);
			assert.equal((await harness.handlers.get("user_bash")({}, harness.ctx))?.result.exitCode, 126);
			assert.equal(harness.appended.length, 1);
			assert.equal(observed.released(), 0);
			await input(harness, "/plan");
			assert.equal(harness.appended.length, 1);
		});
	});
});

// Acceptance list: startup attach; repeated entry/exit; busy refusal and drain;
// deferred entry/exit admission; stale owners and publication drain stay fenced.
describe("real registry inactivity finalization", () => {
	it("makes clean startup ready and attaches the real registry", async () => {
		await withHarness({}, async (harness) => {
			const registry = new BackgroundRunRegistry(async () => {});
			try {
				await harness.handlers.get("session_start")({}, harness.ctx);
				assert.equal(discoverPlan(harness.events, { presence: "present", persisted: "inactive" }, {
					instance: {}, tryAcquire: (owner: object) => registry.tryAcquirePlanHold(owner),
				}).kind, "ready");
				const run = registry.start({ role: "coder", profile: "typescript", task: "acceptance" });
				await registry.wait(run.id, 1000);
			} finally { await registry.shutdown(); }
		});
	});
});

it("real registry repeated entry and exit reacquires and releases", async () => {
	await withHarness({}, async (harness) => {
		const registry = new BackgroundRunRegistry(async () => {});
		const boundary = { presence: "present", persisted: "inactive" } as const;
		try {
			await harness.handlers.get("session_start")({}, harness.ctx);
			assert.equal(discoverPlan(harness.events, boundary, {
				instance: {}, tryAcquire: (owner: object) => registry.tryAcquirePlanHold(owner),
			}).kind, "ready");
			for (let i = 0; i < 2; i++) {
				await input(harness, "/plan");
				assert.throws(() => registry.start({ role: "coder", profile: "typescript", task: "blocked" }), /Plan hold/);
				await input(harness, "/plan exit");
				assert.equal(discoverPlan(harness.events, boundary).kind, "ready");
				const run = registry.start({ role: "coder", profile: "typescript", task: "released" });
				await registry.wait(run.id, 1000);
			}
		} finally { await registry.shutdown(); }
	});
});

it("clean path cancellation releases only its owning entry", async () => {
	const path = Promise.withResolvers<string>();
	await withHarness({ generatePlanPath: () => path.promise }, async (harness) => {
		const observed = observeEntryCoordination(harness);
		const entering = input(harness, "/plan");
		await new Promise<void>(resolve => setImmediate(resolve));
		await harness.handlers.get("input")({ text: "cancel", source: "interactive" }, harness.ctx);
		path.resolve(".pi/plans/cancelled.md");
		await entering;
		assert.equal(harness.appended.length, 0);
		assert.equal(observed.provider.inspect().phase, "inactive");
		assert.equal(observed.released(), 1);
	});
});

describe("real registry busy admission", () => {
	for (const status of ["running", "waiting", "stopping", "exclusive"] as const) {
		it(`refuses ${status} work before Plan mutation, then retries after drain`, async () => {
			let mutations = 0;
			await withHarness({
				generatePlanPath: async () => { mutations++; return ".pi/plans/registry.md"; },
				setActiveTools: () => { mutations++; }, appendEntry: () => { mutations++; },
			}, async (harness) => {
				const drain = Promise.withResolvers<void>();
				let signals = 0;
				const registry = new BackgroundRunRegistry(async ({ signal, ask }) => {
					signal.addEventListener("abort", () => { signals++; });
					if (status === "waiting") void ask("Continue?").catch(() => {});
					await drain.promise;
				});
				let exclusive: Promise<unknown> | undefined;
				try {
					await harness.handlers.get("session_start")({}, harness.ctx);
					assert.equal(discoverPlan(harness.events, { presence: "present", persisted: "inactive" }, {
						instance: {}, tryAcquire: (owner: object) => registry.tryAcquirePlanHold(owner),
					}).kind, "ready");
					const run = status === "exclusive" ? undefined : registry.start({ role: "coder", profile: "typescript", task: "busy" });
					if (status === "exclusive") exclusive = registry.runExclusive(() => drain.promise);
					await new Promise<void>(resolve => setImmediate(resolve));
					if (status === "stopping") void registry.cancel(run!.id);
					if (run) assert.equal(registry.status(run.id).status, status);
					const before = { mutations, signals, entries: harness.appended.length };
					await input(harness, "/plan");
					assert.deepEqual({ mutations, signals, entries: harness.appended.length }, before);
					assert.match(harness.notifications.at(-1)?.message ?? "", /busy|unavailable/i);
					if (status === "waiting") registry.reply(run!.id, registry.status(run!.id).question!.id, "Continue");
					drain.resolve();
					if (run) await registry.wait(run.id, 1000);
					await exclusive;
					await input(harness, "/plan");
					assert.equal(harness.appended.at(-1).data.active, true, "retained terminal records do not block entry");
					assert.throws(() => registry.start({ role: "coder", profile: "typescript", task: "held" }), /Plan hold/);
				} finally { drain.resolve(); await exclusive; await registry.shutdown(); }
			});
		});
	}
});

it("real registry blocks deferred path, active mode and exit persistence until outer completion", async () => {
	const path = Promise.withResolvers<string>();
	let onAppend: (() => void) | undefined;
	await withHarness({ generatePlanPath: () => path.promise, afterAppendEntry: () => onAppend?.() }, async harness => {
		const registry = new BackgroundRunRegistry(async () => {});
		const start = () => registry.start({ role: "coder", profile: "typescript", task: "admission" });
		try {
			await harness.handlers.get("session_start")({}, harness.ctx);
			assert.equal(discoverPlan(harness.events, { presence: "present", persisted: "inactive" }, {
				instance: {}, tryAcquire: (owner: object) => registry.tryAcquirePlanHold(owner),
			}).kind, "ready");
			const entry = input(harness, "/plan");
			assert.throws(start, /Plan hold/);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.throws(start, /Plan hold/);
			path.resolve(".pi/plans/held.md");
			await entry;
			assert.throws(start, /Plan hold/);
			let checked = false;
			onAppend = () => { checked = true; assert.throws(start, /Plan hold/); };
			await input(harness, "/plan exit");
			assert.equal(checked, true);
			const run = start();
			await registry.wait(run.id, 1000);
		} finally { path.resolve(".pi/plans/held.md"); await registry.shutdown(); }
	});
});

it("exit notification cannot release a newer real registry entry hold", async () => {
	await withHarness({}, async harness => {
		const registry = new BackgroundRunRegistry(async () => {});
		try {
			await harness.handlers.get("session_start")({}, harness.ctx);
			assert.equal(discoverPlan(harness.events, { presence: "present", persisted: "inactive" }, {
				instance: {}, tryAcquire: (owner: object) => registry.tryAcquirePlanHold(owner),
			}).kind, "ready");
			await input(harness, "/plan");
			let newer: Promise<unknown> | undefined;
			const notify = harness.ctx.ui.notify;
			harness.ctx.ui.notify = (message: string, level: string) => {
				notify(message, level);
				if (/Exited Plan mode/.test(message)) newer = input(harness, "/plan");
			};
			await input(harness, "/plan exit");
			assert.ok(newer);
			await newer;
			assert.throws(() => registry.start({ role: "coder", profile: "typescript", task: "stale" }), /Plan hold/);
			assert.equal(harness.appended.at(-1).data.active, true);
		} finally { await registry.shutdown(); }
	});
});

it("real registry stays protected across active and invalid owned restoration", async () => {
	await withHarness({}, async original => {
		await input(original, "/plan");
		for (const invalid of [false, true]) {
			const entries = structuredClone(original.allEntries);
			if (invalid) {
				const latest = entries.at(-1);
				entries.push({ ...latest, id: "conflicting-plan", parentId: latest.id, data: { ...latest.data, planId: "other-owned-plan" } });
			}
			const resumed = createHarness({ cwd: original.ctx.cwd, entries });
			const registry = new BackgroundRunRegistry(async () => {});
			let provider: any;
			resumed.events.emit("pithos.plan.coordination", { version: 1, reply(value: any) { provider = value; } });
			try {
				assert.equal(provider.attachParticipant({ instance: {}, tryAcquire: (owner: object) => registry.tryAcquirePlanHold(owner) }).kind, "attached");
				await resumed.handlers.get("session_start")({ reason: "resume" }, resumed.ctx);
				assert.equal(discoverPlan(resumed.events, { presence: "present", persisted: "inactive" }).kind, "blocked");
				if (!invalid) assert.equal(provider.inspect().phase, "active");
				assert.throws(() => registry.start({ role: "coder", profile: "typescript", task: "restore" }), /Plan hold/);
			} finally { await registry.shutdown(); }
		}
	});
});

describe("real registry theme cleanup proof", () => {
	it("refuses ordinary exit until the saved theme can be restored", async () => {
		await withHarness({ mode: "tui" }, async (harness) => {
			const registry = new BackgroundRunRegistry(async () => {});
			const boundary = { presence: "present", persisted: "inactive" } as const;
			try {
				await harness.handlers.get("session_start")({}, harness.ctx);
				assert.equal(discoverPlan(harness.events, boundary, {
					instance: {}, tryAcquire: (owner: object) => registry.tryAcquirePlanHold(owner),
				}).kind, "ready");
				harness.ctx.ui.theme.name = "saved-custom";
				const tools = [...harness.getActiveTools()];
				await input(harness, "/plan");
				const setTheme = harness.ctx.ui.setTheme;
				harness.ctx.ui.setTheme = (theme: any) => theme.name === "plan"
					? setTheme(theme) : { success: false, error: "restoration refused" };
				await input(harness, "/plan exit");
				assert.equal(discoverPlan(harness.events, boundary).kind, "blocked");
				assert.throws(() => registry.start({ role: "coder", profile: "typescript", task: "blocked" }), /Plan hold/);
				assert.equal(harness.ctx.ui.theme.name, "plan");
				assert.equal(harness.appended.some((entry: Entry) => entry.data.active === false), false);
				assert.equal(harness.appended.at(-1).data.previousThemeName, "saved-custom");
				assert.deepEqual(harness.appended.at(-1).data.previousToolNames, tools);
				assert.match(harness.notifications.at(-1).message, /not exited safely/);
				harness.ctx.ui.setTheme = setTheme;
				await input(harness, "/plan exit");
				assert.equal(harness.ctx.ui.theme.name, "saved-custom");
				assert.deepEqual(harness.getActiveTools(), tools);
				assert.equal(harness.appended.at(-1).data.active, false);
				assert.equal(discoverPlan(harness.events, boundary).kind, "ready");
				const run = registry.start({ role: "coder", profile: "typescript", task: "released" });
				await registry.wait(run.id, 1000);
			} finally { await registry.shutdown(); }
		});
	});
});

it("real registry retains outgoing theme on empty branch cleanup failure", async () => {
	await withHarness({ mode: "tui" }, async (harness) => {
		const registry = new BackgroundRunRegistry(async () => {});
		const boundary = { presence: "present", persisted: "inactive" } as const;
		try {
			await harness.handlers.get("session_start")({}, harness.ctx);
			assert.equal(discoverPlan(harness.events, boundary, {
				instance: {}, tryAcquire: (owner: object) => registry.tryAcquirePlanHold(owner),
			}).kind, "ready");
			harness.ctx.ui.theme.name = "outgoing-custom";
			const tools = [...harness.getActiveTools()];
			await input(harness, "/plan");
			const setTheme = harness.ctx.ui.setTheme;
			harness.ctx.ui.setTheme = (theme: any) => theme.name === "plan"
				? setTheme(theme) : { success: false, error: "restoration refused" };
			harness.setBranch([]);
			await assert.rejects(harness.handlers.get("session_tree")({}, harness.ctx), /theme restoration failed/);
			assert.equal(discoverPlan(harness.events, boundary).kind, "blocked");
			assert.throws(() => registry.start({ role: "coder", profile: "typescript", task: "blocked" }), /Plan hold/);
			assert.equal(harness.ctx.ui.theme.name, "plan");
			assert.equal(harness.appended.some((entry: Entry) => entry.data.active === false), false);
			assert.equal(harness.appended.at(-1).data.previousThemeName, "outgoing-custom");
			harness.ctx.ui.setTheme = setTheme;
			await harness.handlers.get("session_tree")({}, harness.ctx);
			assert.equal(harness.ctx.ui.theme.name, "outgoing-custom", "retry must use the outgoing snapshot, not fallback or empty incoming state");
			assert.deepEqual(harness.getActiveTools(), tools);
			assert.equal(discoverPlan(harness.events, boundary).kind, "ready");
			const run = registry.start({ role: "coder", profile: "typescript", task: "released" });
			await registry.wait(run.id, 1000);
		} finally { await registry.shutdown(); }
	});
});
