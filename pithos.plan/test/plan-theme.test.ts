import assert from "node:assert/strict";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import planTheme from "../extensions/plan-theme.ts";
import { commandHarness } from "./command-harness.ts";

const PLAN_THEME_PATH = fileURLToPath(new URL("../extensions/plan-theme.ts", import.meta.url));
const WEB_EXTENSION_PATH = fileURLToPath(new URL("../../pithos.web/extensions/index.ts", import.meta.url));
const WEB_PACKAGE_ROOT = dirname(dirname(WEB_EXTENSION_PATH));

function builtin(name: string) {
	return {
		name,
		description: name,
		parameters: {},
		promptGuidelines: [],
		sourceInfo: { source: "builtin", path: `<builtin:${name}>`, scope: "user", origin: "top-level" },
	};
}

async function createHarness(options: {
	hasUI?: boolean;
	sendUserMessageError?: Error;
	persisted?: boolean;
	isIdle?: boolean;
	themeSwitchSucceeds?: boolean;
	themeMethodsThrow?: boolean;
	webTools?: boolean;
	confirm?: (title: string, message: string) => Promise<boolean>;
	select?: (title: string, choices: string[]) => Promise<string | undefined>;
	hasPendingMessages?: () => boolean;
	mode?: "tui" | "rpc" | "json" | "print";
} = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-plan-enforcement-"));
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
	const entries: any[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const registeredTools = new Map<string, any>();
	const autocompleteFactories: unknown[] = [];
	const footerFactories: unknown[] = [];
	const allTools: any[] = ["read", "grep", "find", "ls", "write", "edit", "bash"].map(builtin);
	if (options.webTools) {
		for (const name of ["web_search", "web_fetch"]) {
			allTools.push({
				name,
				description: name,
				parameters: {},
				promptGuidelines: [],
				sourceInfo: {
					source: "../pithos.web",
					path: WEB_EXTENSION_PATH,
					scope: "project",
					origin: "package",
					baseDir: WEB_PACKAGE_ROOT,
				},
			});
		}
	}
	let activeTools = allTools.map((tool) => tool.name);
	let sessionName = "named-session";
	const routing = commandHarness(handlers);
	const pi = {
		registerCommand: routing.registerCommand,
		sendUserMessage(text: string) {
			if (options.sendUserMessageError) throw options.sendUserMessageError;
			routing.sendUserMessage(text);
		},
		on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
			handlers.set(name, name === "before_agent_start" ? routing.wrapStart(handler) : handler);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		getAllTools: () => allTools,
		registerTool(tool: any) {
			registeredTools.set(tool.name, tool);
			allTools.push({
				...tool,
				sourceInfo: { source: "package", path: PLAN_THEME_PATH, scope: "user", origin: "package" },
			});
		},
		getSessionName: () => sessionName,
		setSessionName(name: string) {
			sessionName = name;
		},
	};
	let themeName = "dark";
	const theme = {
		get name() {
			if (options.themeMethodsThrow) throw new Error("theme access unavailable");
			return themeName;
		},
		set name(name: string) {
			themeName = name;
		},
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
		underline: (text: string) => text,
		fg: (_color: string, text: string) => text,
	};
	const ctx = {
		cwd,
		mode: options.mode ?? "rpc",
		hasUI: options.hasUI ?? true,
		isIdle: () => options.isIdle ?? true,
		hasPendingMessages: options.hasPendingMessages ?? (() => false),
		abort() {},
		sessionManager: {
			getSessionId: () => "enforcement-session",
			getSessionFile: () => options.persisted === false ? undefined : join(cwd, "session.jsonl"),
			getEntries: () => entries,
			getBranch: () => entries,
		},
		ui: {
			theme,
			addAutocompleteProvider(factory: unknown) {
				autocompleteFactories.push(factory);
			},
			getTheme: (name: string) => {
				if (options.themeMethodsThrow) throw new Error("getTheme unavailable");
				return { name };
			},
			setTheme: (nextTheme: { name?: string }) => {
				if (options.themeMethodsThrow) throw new Error("setTheme unavailable");
				if (options.themeSwitchSucceeds === false) return { success: false, error: "unavailable" };
				if (nextTheme.name) theme.name = nextTheme.name;
				return { success: true };
			},
			setFooter(factory: unknown) {
				footerFactories.push(factory);
			},
			setStatus() {},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			confirm: options.confirm ?? (async () => false),
			select: options.select ?? (async () => undefined),
		},
	};
	planTheme(pi as never);
	return {
		routing,
		cwd,
		handlers,
		ctx,
		entries,
		notifications,
		registeredTools,
		allTools,
		autocompleteFactories,
		footerFactories,
		getActiveTools: () => activeTools,
		getThemeName: () => themeName,
		setThemeName: (name: string) => { themeName = name; },
		cleanup: () => rm(cwd, { recursive: true, force: true }),
	};
}

async function command(harness: Awaited<ReturnType<typeof createHarness>>, text: string, streamingBehavior?: string) {
	return harness.routing.route(harness.ctx, text, streamingBehavior);
}

async function enter(harness: Awaited<ReturnType<typeof createHarness>>) {
	return command(harness, "/plan");
}

async function beforeAgentStart(
	harness: Awaited<ReturnType<typeof createHarness>>,
	prompt: string,
) {
	return harness.handlers.get("before_agent_start")?.(
		{
			type: "before_agent_start",
			prompt,
			systemPrompt: "base",
			systemPromptOptions: {},
		},
		harness.ctx,
	);
}

async function startPlanCommand(
	harness: Awaited<ReturnType<typeof createHarness>>,
	text: "/plan save" | "/plan exit",
) {
	const result = await command(harness, text);
	assert.equal(result?.action, "dispatched");
	await beforeAgentStart(harness, result.text);
	return result;
}

function latestState(harness: Awaited<ReturnType<typeof createHarness>>) {
	return [...harness.entries].reverse().find((entry) => entry.type === "custom")?.data;
}

async function checkpoint(harness: Awaited<ReturnType<typeof createHarness>>, content = "# Plan: Enforcement\n") {
	const result = await harness.registeredTools.get("update_plan_draft").execute(
		"checkpoint-1",
		{ content, expectedRevision: 0 },
		undefined,
		undefined,
		harness.ctx,
	);
	harness.entries.push({
		type: "message",
		message: { role: "toolResult", toolName: "update_plan_draft", isError: false, details: result.details },
	});
	return result;
}

describe("Plan mode enforcement", { concurrency: false }, () => {
	it("keeps JSON mode stdout free of raw help, status, and entry feedback", async () => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const originalLog = console.log;
		const originalError = console.error;
		const harness = await createHarness({ hasUI: false, mode: "json" });
		console.log = (...values: unknown[]) => stdout.push(values.map(String).join(" "));
		console.error = (...values: unknown[]) => stderr.push(values.map(String).join(" "));
		try {
			assert.deepEqual(await command(harness, "/plan help"), { action: "handled" });
			assert.deepEqual(await command(harness, "/plan status"), { action: "handled" });
			assert.deepEqual(await enter(harness), { action: "handled" });

			assert.deepEqual(stdout, []);
			assert.match(stderr.join("\n"), /Usage:.*Plan status:.*Plan mode active/is);
		} finally {
			console.log = originalLog;
			console.error = originalError;
			await harness.cleanup();
		}
	});

	it("handles help and rejects free-form, pause, and cancel arguments without creating state", async () => {
		const harness = await createHarness();
		try {
			for (const help of ["help", "--help", "-h"]) {
				assert.deepEqual(await command(harness, `/plan ${help}`), { action: "handled" });
				assert.match(harness.notifications.at(-1)?.message ?? "", /\/plan \{save\|preview\|exit\|status\|help\}/);
			}
			for (const rejected of ["build auth", "pause", "cancel", "unknown"]) {
				assert.deepEqual(await command(harness, `/plan ${rejected}`), { action: "handled" });
				assert.equal(harness.notifications.at(-1)?.level, "error");
				assert.match(harness.notifications.at(-1)?.message ?? "", /Unknown.*Usage:/s);
			}
			assert.equal(harness.entries.length, 0);
		} finally {
			await harness.cleanup();
		}
	});

	it("handles symlinked and regular-file .pi parents without activating Plan state or tools", async () => {
		for (const parentKind of ["symlink", "file"] as const) {
			const harness = await createHarness();
			try {
				if (parentKind === "symlink") {
					const target = join(harness.cwd, "real-pi-parent");
					await mkdir(target);
					await symlink(target, join(harness.cwd, ".pi"), "dir");
				} else {
					await writeFile(join(harness.cwd, ".pi"), "not a directory");
				}

				assert.deepEqual(await enter(harness), { action: "handled" }, parentKind);
				assert.equal(harness.entries.length, 0, parentKind);
				assert.equal(harness.getActiveTools().includes("create_plan"), false, parentKind);
				assert.equal(harness.getActiveTools().includes("update_plan_draft"), false, parentKind);
				assert.equal(harness.getThemeName(), "dark", parentKind);
				assert.equal(harness.notifications.at(-1)?.level, "error", parentKind);
				assert.match(harness.notifications.at(-1)?.message ?? "", /Plan mode.*not activated.*safe/i);
			} finally {
				await harness.cleanup();
			}
		}
	});

	it("does not intercept unrelated skill input and refuses mode changes while busy", async () => {
		const harness = await createHarness({ isIdle: false });
		try {
			assert.deepEqual(await command(harness, "/skill:tdd test first"), { action: "continue" });
			assert.deepEqual(await command(harness, "/plan", "steer"), { action: "handled" });
			assert.equal(harness.entries.length, 0);
			assert.match(harness.notifications.at(-1)?.message ?? "", /current agent turn/i);
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps both internal tools hidden while inactive and registers autocomplete in TUI mode", async () => {
		const harness = await createHarness();
		try {
			harness.ctx.mode = "tui";
			await harness.handlers.get("session_start")?.(
				{ type: "session_start", reason: "startup" },
				harness.ctx,
			);
			assert.equal(harness.getActiveTools().includes("create_plan"), false);
			assert.equal(harness.getActiveTools().includes("update_plan_draft"), false);
			assert.equal(harness.autocompleteFactories.length, 1);
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps and reapplies the Plan theme across reload without replacing the pre-Plan theme", async () => {
		const harness = await createHarness({ mode: "tui" });
		try {
			await enter(harness);
			assert.equal(harness.getThemeName(), "plan");
			assert.equal(latestState(harness).previousThemeName, "dark");

			await harness.handlers.get("session_shutdown")?.(
				{ type: "session_shutdown", reason: "reload" },
				harness.ctx,
			);
			assert.equal(harness.getThemeName(), "plan", "reload cleanup must not flash back to the default theme");

			harness.setThemeName("dark");
			await harness.handlers.get("session_start")?.(
				{ type: "session_start", reason: "reload" },
				harness.ctx,
			);
			assert.equal(harness.getThemeName(), "plan");
			assert.equal(latestState(harness).previousThemeName, "dark");
		} finally {
			await harness.cleanup();
		}
	});

	it("enforces lifecycle state without accessing TUI themes in RPC, JSON, or print mode", async () => {
		const output: string[] = [];
		const originalLog = console.log;
		const originalError = console.error;
		console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
		console.error = (...values: unknown[]) => output.push(values.map(String).join(" "));
		try {
			for (const mode of ["rpc", "json", "print"] as const) {
				const harness = await createHarness({
					mode,
					hasUI: mode === "rpc",
					themeMethodsThrow: true,
				});
				try {
					assert.deepEqual(await enter(harness), { action: "handled" }, mode);
					assert.equal(latestState(harness).active, true, mode);
					assert.equal(harness.getActiveTools().includes("create_plan"), true, mode);

					await harness.handlers.get("session_shutdown")?.(
						{ type: "session_shutdown", reason: "reload" },
						harness.ctx,
					);
					await harness.handlers.get("session_start")?.(
						{ type: "session_start", reason: "reload" },
						harness.ctx,
					);
					assert.equal(latestState(harness).active, true, mode);
					assert.equal(harness.getActiveTools().includes("create_plan"), true, mode);

					await checkpoint(harness, `# Plan: ${mode} lifecycle\n`);
					assert.deepEqual(await command(harness, "/plan exit"), { action: "handled" });
					assert.equal(latestState(harness).active, false, mode);
					assert.equal(harness.getActiveTools().includes("create_plan"), false, mode);
					output.push(...harness.notifications.map(({ message }) => message));
				} finally {
					await harness.cleanup();
				}
			}
			assert.doesNotMatch(output.join("\n"), /theme/i);
		} finally {
			console.log = originalLog;
			console.error = originalError;
		}
	});

	it("enforces trusted tools even when the Plan theme cannot be applied", async () => {
		const harness = await createHarness({ themeSwitchSucceeds: false, webTools: true, mode: "tui" });
		try {
			await enter(harness);
			assert.deepEqual(harness.getActiveTools(), [
				"read", "grep", "find", "ls", "web_search", "web_fetch", "update_plan_draft", "create_plan",
			]);
			for (const toolName of ["read", "grep", "find", "ls", "web_search", "web_fetch", "update_plan_draft"]) {
				const result = await harness.handlers.get("tool_call")?.(
					{ type: "tool_call", toolCallId: toolName, toolName, input: {} },
					harness.ctx,
				);
				assert.equal(result?.block, undefined, toolName);
			}
			assert.equal(harness.entries.at(-1)?.data.active, true);
		} finally {
			await harness.cleanup();
		}
	});

	it("reinforces checkpoint structure and explicit publication intent on every active agent turn", async () => {
		const harness = await createHarness();
		try {
			await enter(harness);
			const first = await harness.handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", systemPrompt: "base" },
				harness.ctx,
			);
			assert.match(first.systemPrompt, /^base/);
			assert.match(first.systemPrompt, /explore.*before asking/i);
			assert.match(first.systemPrompt, /Requirements.*Constraints.*Decisions.*Assumptions.*Open questions.*Plan/s);
			assert.match(first.systemPrompt, /update_plan_draft.*expectedRevision 0/s);
			assert.match(first.systemPrompt, /Do not call create_plan during ordinary planning/i);
			assert.match(first.systemPrompt, /\/plan save.*\/plan exit/s);

			await checkpoint(harness);
			const next = await harness.handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", systemPrompt: "base" },
				harness.ctx,
			);
			assert.match(next.systemPrompt, /expectedRevision 1/);
		} finally {
			await harness.cleanup();
		}
	});

	it("blocks writes, shell, delegation, overridden reads, and user shell commands", async () => {
		const harness = await createHarness();
		try {
			await enter(harness);
			for (const [toolName, input] of [
				["write", { path: "src/app.ts" }],
				["edit", { path: "src/app.ts" }],
				["bash", { command: "rm -rf src" }],
				["guild_handover", { task: "mutate" }],
			] as const) {
				const result = await harness.handlers.get("tool_call")?.(
					{ type: "tool_call", toolCallId: toolName, toolName, input },
					harness.ctx,
				);
				assert.equal(result?.block, true, toolName);
				assert.match(result?.reason ?? "", /read-only/i);
			}
			const read = harness.allTools.find((tool: any) => tool.name === "read");
			read.sourceInfo = { source: "package", path: "/untrusted/read.ts" };
			const overridden = await harness.handlers.get("tool_call")?.(
				{ type: "tool_call", toolCallId: "override", toolName: "read", input: { path: "README.md" } },
				harness.ctx,
			);
			assert.equal(overridden?.block, true);

			const shell = await harness.handlers.get("user_bash")?.(
				{ type: "user_bash", command: "touch file", cwd: harness.cwd, excludeFromContext: false },
				harness.ctx,
			);
			assert.equal(shell?.result?.exitCode, 126);
		} finally {
			await harness.cleanup();
		}
	});

	it("requires explicit save/exit intent and blocks publication without UI", async () => {
		const harness = await createHarness({ hasUI: false });
		try {
			await enter(harness);
			await checkpoint(harness);
			const ordinary = await harness.handlers.get("tool_call")?.(
				{ type: "tool_call", toolCallId: "ordinary", toolName: "create_plan", input: { revision: 1 } },
				harness.ctx,
			);
			assert.equal(ordinary?.block, true);
			assert.match(ordinary?.reason ?? "", /\/plan save or \/plan exit/i);

			await startPlanCommand(harness, "/plan save");
			const noUi = await harness.handlers.get("tool_call")?.(
				{ type: "tool_call", toolCallId: "no-ui", toolName: "create_plan", input: { revision: 1 } },
				harness.ctx,
			);
			assert.equal(noUi?.block, true);
			assert.match(noUi?.reason ?? "", /Interactive UI.*exact-content/i);
			assert.equal(latestState(harness).active, true);
		} finally {
			await harness.cleanup();
		}
	});

	it("revokes a queued lifecycle request after preflight fails and later user input arrives", async () => {
		const harness = await createHarness();
		try {
			await enter(harness);
			await checkpoint(harness);
			const queued = await command(harness, "/plan save");
			assert.equal(queued?.action, "dispatched");

			// No before_agent_start or agent_settled follows a model/auth preflight failure.
			assert.deepEqual(await command(harness, "A new ordinary prompt"), { action: "continue" });
			await beforeAgentStart(harness, queued.text);
			const stale = await harness.handlers.get("tool_call")?.(
				{ type: "tool_call", toolCallId: "stale", toolName: "create_plan", input: { revision: 1 } },
				harness.ctx,
			);

			assert.equal(stale?.block, true);
			assert.match(stale?.reason ?? "", /Use \/plan save or \/plan exit/i);
			assert.equal(latestState(harness).approval, undefined);
		} finally {
			await harness.cleanup();
		}
	});

	it("clears exact exit approval and stays active when lifecycle dispatch throws", async () => {
		const harness = await createHarness({
			select: async () => "Create plan",
			confirm: async () => true,
			sendUserMessageError: new Error("Dispatch unavailable"),
		});
		try {
			await enter(harness);
			await checkpoint(harness);
			assert.deepEqual(await command(harness, "/plan exit"), { action: "handled" });
			assert.equal(latestState(harness).approval, undefined);
			assert.equal(latestState(harness).active, true);
			assert.match(harness.notifications.at(-1)?.message ?? "", /could not be dispatched.*Dispatch unavailable/i);
		} finally {
			await harness.cleanup();
		}
	});

	for (const timing of ["before startup", "during run"] as const) it(`revokes lifecycle authorization for an unrelated extension copying the exact prompt ${timing}`, async () => {
		const harness = await createHarness({ confirm: async () => true });
		try {
			await enter(harness);
			await checkpoint(harness);
			const dispatch = await command(harness, "/plan save");
			if (timing === "during run") await beforeAgentStart(harness, dispatch.text);
			assert.deepEqual(await harness.handlers.get("input")?.(
				{ type: "input", source: "extension", text: dispatch.text }, harness.ctx,
			), { action: "continue" });
			if (timing === "before startup") await beforeAgentStart(harness, dispatch.text);
			const blocked = await harness.handlers.get("tool_call")?.(
				{ type: "tool_call", toolCallId: "extension-spoof", toolName: "create_plan", input: { revision: 1 } }, harness.ctx,
			);
			assert.equal(blocked?.block, true);
			assert.match(blocked?.reason ?? "", /Use \/plan save or \/plan exit/i);
			assert.equal(latestState(harness).active, true);
		} finally {
			await harness.cleanup();
		}
	});

	it("activates queued authorization only for the exact dispatched prompt", async () => {
		const harness = await createHarness();
		try {
			await enter(harness);
			await checkpoint(harness);
			const queued = await command(harness, "/plan save");
			assert.equal(queued?.action, "dispatched");
			await beforeAgentStart(harness, `${queued.text}\nChanged by a later transform.`);

			const mismatched = await harness.handlers.get("tool_call")?.(
				{ type: "tool_call", toolCallId: "mismatched-prompt", toolName: "create_plan", input: { revision: 1 } },
				harness.ctx,
			);
			assert.equal(mismatched?.block, true);
			assert.match(mismatched?.reason ?? "", /Use \/plan save or \/plan exit/i);
		} finally {
			await harness.cleanup();
		}
	});

	it("revokes pending publication authorization when a user queues a continuation", async () => {
		const harness = await createHarness();
		try {
			await enter(harness);
			await checkpoint(harness);
			await startPlanCommand(harness, "/plan save");

			assert.deepEqual(
				await command(harness, "Refine the compatibility requirements", "followUp"),
				{ action: "continue" },
			);
			await harness.handlers.get("agent_end")?.(
				{ type: "agent_end", messages: [], willRetry: false },
				harness.ctx,
			);
			const stale = await harness.handlers.get("tool_call")?.(
				{ type: "tool_call", toolCallId: "queued-refinement", toolName: "create_plan", input: { revision: 1 } },
				harness.ctx,
			);

			assert.equal(stale?.block, true);
			assert.match(stale?.reason ?? "", /Use \/plan save or \/plan exit/i);
		} finally {
			await harness.cleanup();
		}
	});

	it("revokes pending action and stale approval before processing another command", async () => {
		const harness = await createHarness({ confirm: async () => true });
		try {
			await enter(harness);
			await checkpoint(harness);
			await startPlanCommand(harness, "/plan save");
			const call = {
				type: "tool_call",
				toolCallId: "stale-command-approval",
				toolName: "create_plan",
				input: { revision: 1 },
			};
			assert.equal((await harness.handlers.get("tool_call")?.(call, harness.ctx))?.block, undefined);
			await harness.handlers.get("tool_result")?.(
				{ ...call, type: "tool_result", isError: true },
				harness.ctx,
			);
			assert.ok(latestState(harness).approval);

			assert.deepEqual(await command(harness, "/plan status"), { action: "handled" });
			assert.equal(latestState(harness).approval, undefined);
			const stale = await harness.handlers.get("tool_call")?.(
				{ ...call, toolCallId: "after-other-command" },
				harness.ctx,
			);
			assert.equal(stale?.block, true);
			assert.match(stale?.reason ?? "", /Use \/plan save or \/plan exit/i);
		} finally {
			await harness.cleanup();
		}
	});

	it("finishes a save publication call that is already executing", async () => {
		const harness = await createHarness({ confirm: async () => true });
		let releaseQueue: (() => void) | undefined;
		let heldMutation: Promise<void> | undefined;
		let execution: Promise<{ details: { revision: number } }> | undefined;
		try {
			await enter(harness);
			await checkpoint(harness);
			await startPlanCommand(harness, "/plan save");
			const call = {
				type: "tool_call",
				toolCallId: "publication-in-progress",
				toolName: "create_plan",
				input: { revision: 1 },
			};
			assert.equal((await harness.handlers.get("tool_call")?.(call, harness.ctx))?.block, undefined);

			let markQueueHeld: (() => void) | undefined;
			const queueHeld = new Promise<void>((resolve) => {
				markQueueHeld = resolve;
			});
			const queueRelease = new Promise<void>((resolve) => {
				releaseQueue = resolve;
			});
			heldMutation = withFileMutationQueue(
				join(harness.cwd, latestState(harness).candidatePath),
				async () => {
					markQueueHeld?.();
					await queueRelease;
				},
			);
			await queueHeld;
			execution = harness.registeredTools.get("create_plan").execute(
				call.toolCallId,
				call.input,
				undefined,
				undefined,
				harness.ctx,
			);

			assert.deepEqual(
				await command(harness, "Queue a later refinement", "followUp"),
				{ action: "continue" },
			);
			releaseQueue?.();
			await heldMutation;
			const result = await execution;
			await harness.handlers.get("tool_result")?.(
				{ ...call, type: "tool_result", details: result.details, isError: false },
				harness.ctx,
			);

			assert.equal(result.details.revision, 1);
			assert.equal(latestState(harness).publicationState, "synced");
			assert.equal(latestState(harness).active, true);
		} finally {
			releaseQueue?.();
			await heldMutation;
			await execution?.catch(() => undefined);
			await harness.cleanup();
		}
	});

	it("retains lifecycle authorization across every automatic retry agent_start, then settles save and exit safely", async () => {
		for (const planCommand of ["/plan save", "/plan exit"] as const) {
			const harness = await createHarness(
				planCommand === "/plan exit"
					? { select: async () => "Create plan", confirm: async () => true }
					: {},
			);
			try {
				await enter(harness);
				await checkpoint(harness);
				await startPlanCommand(harness, planCommand);
				await harness.handlers.get("agent_start")?.(
					{ type: "agent_start" },
					harness.ctx,
				);
				for (let retry = 0; retry < 2; retry += 1) {
					await harness.handlers.get("agent_end")?.(
						{ type: "agent_end", messages: [], willRetry: true },
						harness.ctx,
					);
					await harness.handlers.get("agent_start")?.(
						{ type: "agent_start" },
						harness.ctx,
					);
				}

				harness.ctx.hasUI = false;
				const retained = await harness.handlers.get("tool_call")?.(
					{
						type: "tool_call",
						toolCallId: `${planCommand}-retry`,
						toolName: "create_plan",
						input: { revision: 1 },
					},
					harness.ctx,
				);
				assert.equal(retained?.block, true);
				assert.match(retained?.reason ?? "", /Interactive UI.*required/i);

				await harness.handlers.get("agent_settled")?.(
					{ type: "agent_settled" },
					harness.ctx,
				);
				harness.ctx.hasUI = true;
				if (planCommand === "/plan exit") {
					assert.equal(latestState(harness).active, false);
					assert.equal(latestState(harness).approval, undefined);
					assert.equal(harness.getActiveTools().includes("create_plan"), false);
					continue;
				}
				const cleared = await harness.handlers.get("tool_call")?.(
					{
						type: "tool_call",
						toolCallId: `${planCommand}-settled`,
						toolName: "create_plan",
						input: { revision: 1 },
					},
					harness.ctx,
				);
				assert.equal(cleared?.block, true);
				assert.match(cleared?.reason ?? "", /Use \/plan save or \/plan exit/i);
				assert.equal(latestState(harness).active, true);
			} finally {
				await harness.cleanup();
			}
		}
	});

	it("clears stale persisted approval when the dispatched agent run settles", async () => {
		const harness = await createHarness({ confirm: async () => true });
		try {
			await enter(harness);
			await checkpoint(harness);
			await startPlanCommand(harness, "/plan save");
			const call = {
				type: "tool_call",
				toolCallId: "approved-but-failed",
				toolName: "create_plan",
				input: { revision: 1 },
			};
			assert.equal((await harness.handlers.get("tool_call")?.(call, harness.ctx))?.block, undefined);
			assert.ok(latestState(harness).approval);
			await harness.handlers.get("tool_result")?.(
				{ ...call, type: "tool_result", isError: true },
				harness.ctx,
			);

			await harness.handlers.get("agent_settled")?.(
				{ type: "agent_settled" },
				harness.ctx,
			);

			assert.equal(latestState(harness).approval, undefined);
			const stale = await harness.handlers.get("tool_call")?.(
				{ ...call, toolCallId: "after-settled" },
				harness.ctx,
			);
			assert.equal(stale?.block, true);
			assert.match(stale?.reason ?? "", /Use \/plan save or \/plan exit/i);
		} finally {
			await harness.cleanup();
		}
	});

	it("serializes approval, composes with downstream tool_call mutation, and rejects the changed revision at execute", async () => {
		let confirmations = 0;
		let resolveConfirmation: ((value: boolean) => void) | undefined;
		let markConfirmationStarted: (() => void) | undefined;
		const confirmationStarted = new Promise<void>((resolve) => {
			markConfirmationStarted = resolve;
		});
		const waiting = new Promise<boolean>((resolve) => {
			resolveConfirmation = resolve;
		});
		const harness = await createHarness({
			confirm: async () => {
				confirmations += 1;
				markConfirmationStarted?.();
				return waiting;
			},
		});
		try {
			await enter(harness);
			await checkpoint(harness);
			await startPlanCommand(harness, "/plan save");
			const firstCall = {
				type: "tool_call",
				toolCallId: "publish-1",
				toolName: "create_plan",
				input: { revision: 1 },
			};
			const first = harness.handlers.get("tool_call")?.(firstCall, harness.ctx);
			await confirmationStarted;
			const sibling = await harness.handlers.get("tool_call")?.(
				{ type: "tool_call", toolCallId: "publish-2", toolName: "create_plan", input: { revision: 1 } },
				harness.ctx,
			);
			resolveConfirmation?.(true);

			assert.equal(confirmations, 1);
			assert.equal(sibling?.block, true);
			assert.match(sibling?.reason ?? "", /in progress/i);
			assert.equal((await first)?.block, undefined);
			const composedCall = firstCall as typeof firstCall & { downstreamMutationObserved?: boolean };
			assert.doesNotThrow(() => {
				composedCall.input.revision = 2;
				composedCall.downstreamMutationObserved = true;
			});
			assert.equal(composedCall.downstreamMutationObserved, true);
			await assert.rejects(
				harness.registeredTools.get("create_plan").execute(
					composedCall.toolCallId,
					composedCall.input,
					undefined,
					undefined,
					harness.ctx,
				),
				/not authorized.*checkpoint revision/i,
			);
			assert.equal(latestState(harness).active, true);
			assert.equal(latestState(harness).completedPublication, undefined);
		} finally {
			resolveConfirmation?.(false);
			await harness.cleanup();
		}
	});

	it("resolves first-publication collisions before exact-path approval", async () => {
		const dialogs: string[] = [];
		const harness = await createHarness({
			confirm: async (_title, message) => {
				dialogs.push(message);
				return true;
			},
		});
		try {
			await enter(harness);
			await checkpoint(harness, "# Plan: Collision\n");
			const originalPath = latestState(harness).candidatePath;
			await mkdir(dirname(join(harness.cwd, originalPath)), { recursive: true });
			await writeFile(join(harness.cwd, originalPath), "existing");
			await startPlanCommand(harness, "/plan save");
			const result = await harness.handlers.get("tool_call")?.(
				{ type: "tool_call", toolCallId: "collision", toolName: "create_plan", input: { revision: 1 } },
				harness.ctx,
			);
			const reviewedPath = latestState(harness).approval.path;

			assert.equal(result?.block, undefined);
			assert.notEqual(reviewedPath, originalPath);
			assert.match(dialogs[0] ?? "", new RegExp(reviewedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		} finally {
			await harness.cleanup();
		}
	});

	it("warns clearly for ephemeral sessions and includes persistence in status", async () => {
		const harness = await createHarness({ persisted: false });
		try {
			await enter(harness);
			assert.equal(harness.notifications.at(-1)?.level, "warning");
			assert.match(harness.notifications.at(-1)?.message ?? "", /ephemeral.*restart\/resume/i);
			assert.deepEqual(await command(harness, "/plan status"), { action: "handled" });
			assert.match(harness.notifications.at(-1)?.message ?? "", /session ephemeral/i);
		} finally {
			await harness.cleanup();
		}
	});

	it("shows the canonical session name in the active Plan footer", async () => {
		const harness = await createHarness();
		try {
			await enter(harness);
			const factory = harness.footerFactories.at(-1) as ((...args: any[]) => any) | undefined;
			assert.ok(factory);
			const footer = factory(
				{ requestRender() {} },
				{ fg: (_color: string, text: string) => text },
				undefined,
			);
			assert.equal(footer.render(80)[0], "● planning · named-session");
			footer.dispose();
		} finally {
			await harness.cleanup();
		}
	});
});
