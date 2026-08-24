import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import planTheme from "../extensions/plan-theme.ts";

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

function createHarness(
	options: {
		confirm?: (title: string, message: string) => Promise<boolean>;
		themeSwitchSucceeds?: boolean;
		isIdle?: boolean;
		branchEntries?: any[];
		hasUI?: boolean;
		mode?: "tui" | "rpc" | "json" | "print";
		cwd?: string;
		sessionName?: string;
		webTools?: boolean;
	} = {},
) {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
	const branchEntries = options.branchEntries ?? [];
	const allTools = ["read", "grep", "find", "ls", "write", "edit", "bash"].map(builtin);
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
	let sessionName = options.sessionName;
	const sessionNames: string[] = [];
	const entries: Array<{ customType: string; data: any }> = [];
	const registeredTools = new Map<string, any>();
	const notifications: Array<{ message: string; level: string }> = [];
	const autocompleteFactories: unknown[] = [];
	const footerFactories: unknown[] = [];
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
			handlers.set(name, handler);
		},
		appendEntry(customType: string, data: any) {
			entries.push({ customType, data });
		},
		sendMessage() {},
		getActiveTools: () => [...activeTools],
		getAllTools: () => allTools,
		getSessionName: () => sessionName,
		setSessionName(name: string) {
			sessionName = name;
			sessionNames.push(name);
		},
		setActiveTools(toolNames: string[]) {
			activeTools = [...toolNames];
		},
		registerTool(tool: any) {
			registeredTools.set(tool.name, tool);
			allTools.push({
				...tool,
				sourceInfo: { source: "package", path: PLAN_THEME_PATH, scope: "user", origin: "package" },
			});
		},
	};
	const previewTheme = {
		name: "dark",
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
		underline: (text: string) => text,
		fg: (_color: string, text: string) => text,
	};
	const previewKeys: Record<string, string[]> = {
		"tui.select.confirm": ["enter"],
		"tui.select.cancel": ["escape", "ctrl+c"],
		"tui.select.up": ["up"],
		"tui.select.down": ["down"],
		"tui.select.pageUp": ["pageUp"],
		"tui.select.pageDown": ["pageDown"],
	};
	const previewKeybindings = {
		matches: (data: string, action: string) => previewKeys[action]?.includes(data) ?? false,
		getKeys: (action: string) => previewKeys[action] ?? [],
	};
	const ctx = {
		cwd: options.cwd ?? "/tmp/pi-plan-theme-test-project",
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		isIdle: () => options.isIdle ?? true,
		sessionManager: { getBranch: () => branchEntries },
		ui: {
			theme: previewTheme,
			addAutocompleteProvider(factory: unknown) {
				autocompleteFactories.push(factory);
			},
			getTheme: (name: string) => ({ name }),
			setTheme: () =>
				options.themeSwitchSucceeds === false
					? { success: false, error: "theme unavailable" }
					: { success: true },
			setFooter(factory: unknown) {
				footerFactories.push(factory);
			},
			setStatus() {},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			confirm: options.confirm ?? (async () => false),
			async custom(factory: any) {
				let selected: string | undefined;
				const component = factory(
					{ terminal: { rows: 24 }, requestRender() {} },
					previewTheme,
					previewKeybindings,
					(value: string) => {
						selected = value;
					},
				);
				const rendered = component.render(80).join("\n");
				if (!rendered.includes("Preview the plan")) {
					component.handleInput("enter");
					return selected;
				}
				const approved = await (options.confirm ?? (async () => false))(
					"Confirm plan creation",
					rendered,
				);
				if (approved) {
					component.handleInput("down");
					component.handleInput("down");
				}
				component.handleInput("enter");
				return selected;
			},
		},
	};
	planTheme(pi as never);
	return {
		handlers,
		ctx,
		entries,
		branchEntries,
		allTools,
		registeredTools,
		notifications,
		autocompleteFactories,
		footerFactories,
		sessionNames,
		getActiveTools: () => activeTools,
		setActiveTools: (toolNames: string[]) => pi.setActiveTools(toolNames),
	};
}

async function activatePlan(harness: ReturnType<typeof createHarness>) {
	await harness.handlers.get("input")?.(
		{ type: "input", source: "interactive", text: "/plan protect the project" },
		harness.ctx,
	);
}

describe("plan mode enforcement", () => {
	it("intercepts Plan --help/-h before prompt expansion", async () => {
		for (const alias of ["--help", "-h"]) {
			const harness = createHarness();
			const normalTools = harness.getActiveTools();

			const result = await harness.handlers.get("input")?.(
				{ type: "input", source: "interactive", text: `/plan ${alias}` },
				harness.ctx,
			);

			assert.deepEqual(result, { action: "handled" });
			assert.equal(harness.notifications.length, 1);
			assert.equal(harness.notifications[0]?.level, "info");
			assert.match(harness.notifications[0]?.message ?? "", /Usage: \/plan \[task \| exit \| cancel \| --help\]/);
			assert.match(harness.notifications[0]?.message ?? "", /no argument.*finalize/i);
			assert.match(harness.notifications[0]?.message ?? "", /--help, -h/);
			assert.match(harness.notifications[0]?.message ?? "", /exit.*without creating/i);
			assert.match(harness.notifications[0]?.message ?? "", /cancel.*alias/i);
			assert.equal(harness.entries.length, 0);
			assert.deepEqual(harness.getActiveTools(), normalTools);
		}
	});

	it("registers Plan argument autocomplete in the TUI", async () => {
		const harness = createHarness();

		await harness.handlers.get("session_start")?.({ type: "session_start" }, harness.ctx);

		assert.equal(harness.autocompleteFactories.length, 1);
	});

	it("does not intercept native skill input", async () => {
		for (const command of ["/skill:tdd task context", "/skill:conventional-commit instructions"]) {
			const harness = createHarness();
			const result = await harness.handlers.get("input")?.(
				{ type: "input", source: "interactive", text: command },
				harness.ctx,
			);

			assert.deepEqual(result, { action: "continue" });
			assert.equal(harness.notifications.length, 0);
		}
	});

	it("keeps the canonical session name visible in the active Plan footer", async () => {
		const harness = createHarness({ sessionName: "neon-grunge-reboot" });

		await activatePlan(harness);

		const footerFactory = harness.footerFactories.at(-1) as ((...args: any[]) => any) | undefined;
		assert.ok(footerFactory);
		const footer = footerFactory(
			{ requestRender: () => {} },
			{ fg: (_color: string, text: string) => text },
			undefined,
		);
		assert.equal(footer.render(80)[0], "● planning · neon-grunge-reboot");
		footer.dispose();
	});

	it("refuses to activate Plan mode while another agent turn is running", async () => {
		const harness = createHarness();

		const result = await harness.handlers.get("input")?.(
			{
				type: "input",
				source: "interactive",
				text: "/plan protect the project",
				streamingBehavior: "steer",
			},
			harness.ctx,
		);

		assert.deepEqual(result, { action: "handled" });
		assert.equal(harness.entries.some((entry) => entry.data.active), false);
		assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "write", "edit", "bash"]);
	});

	it("fails closed when the runtime reports a busy agent without streaming metadata", async () => {
		const harness = createHarness({ isIdle: false });

		const result = await harness.handlers.get("input")?.(
			{ type: "input", source: "interactive", text: "/plan protect the project" },
			harness.ctx,
		);

		assert.deepEqual(result, { action: "handled" });
		assert.equal(harness.entries.some((entry) => entry.data.active), false);
	});

	it("exits active Plan mode without creating a plan through explicit command aliases", async () => {
		for (const command of ["/plan exit", "/plan cancel"]) {
			const harness = createHarness();
			const normalTools = harness.getActiveTools();
			await activatePlan(harness);

			const result = await harness.handlers.get("input")?.(
				{ type: "input", source: "interactive", text: command },
				harness.ctx,
			);

			assert.deepEqual(result, { action: "handled" });
			assert.equal(harness.entries.at(-1)?.data.active, false);
			assert.equal(harness.entries.at(-1)?.data.cancelled, true);
			assert.deepEqual(harness.getActiveTools(), normalTools);
			assert.match(harness.notifications.at(-1)?.message ?? "", /exited Plan mode.*no plan.*created/i);
		}
	});

	it("does not start a new plan when an exit alias is used outside Plan mode", async () => {
		for (const command of ["/plan exit", "/plan cancel"]) {
			const harness = createHarness();
			const normalTools = harness.getActiveTools();

			const result = await harness.handlers.get("input")?.(
				{ type: "input", source: "interactive", text: command },
				harness.ctx,
			);

			assert.deepEqual(result, { action: "handled" });
			assert.equal(harness.entries.length, 0);
			assert.deepEqual(harness.getActiveTools(), normalTools);
			assert.match(harness.notifications.at(-1)?.message ?? "", /Plan mode is not active/i);
		}
	});

	it("keeps the internal plan creator hidden outside Plan mode", async () => {
		const harness = createHarness();
		harness.setActiveTools([...harness.getActiveTools(), "create_plan"]);

		await harness.handlers.get("session_start")?.({ type: "session_start" }, harness.ctx);

		assert.equal(harness.getActiveTools().includes("create_plan"), false);
	});

	it("restores normal tools when switching from Plan mode to an inactive session", async () => {
		const harness = createHarness();
		const normalTools = harness.getActiveTools();
		await activatePlan(harness);

		await harness.handlers.get("session_start")?.({ type: "session_start" }, harness.ctx);

		assert.deepEqual(harness.getActiveTools(), normalTools);
	});

	it("restores active Plan mode from the current session branch", async () => {
		const harness = createHarness({
			branchEntries: [
			{
				type: "custom",
				customType: "plan-theme-state",
				data: { active: true, planPath: ".pi/plans/restored.md", previousThemeName: "dark" },
			},
		],
		});

		await harness.handlers.get("session_start")?.({ type: "session_start" }, harness.ctx);
		const result = await harness.handlers.get("tool_call")?.(
			{ type: "tool_call", toolCallId: "write-source", toolName: "write", input: { path: "src/app.ts" } },
			harness.ctx,
		);

		assert.equal(result?.block, true);
		assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "create_plan"]);
	});

	it("revokes legacy blanket save authorization and confirms the restored draft", async () => {
		let confirmations = 0;
		const harness = createHarness({
			confirm: async () => {
				confirmations += 1;
				return false;
			},
			branchEntries: [
				{
					type: "custom",
					customType: "plan-theme-state",
					data: {
						active: true,
						planPath: ".pi/plans/2026-08-09-230000-restored.md",
						previousThemeName: "dark",
						saveAuthorized: true,
					},
				},
			],
		});
		harness.setActiveTools([...harness.getActiveTools(), "create_plan"]);
		await harness.handlers.get("session_start")?.({ type: "session_start" }, harness.ctx);
		const call = {
			type: "tool_call",
			toolCallId: "create-restored-plan",
			toolName: "create_plan",
			input: { content: "# Restored plan" },
		};

		const result = await harness.handlers.get("tool_call")?.(call, harness.ctx);

		assert.equal(result?.block, true);
		assert.equal(confirmations, 1);
		assert.equal(harness.getActiveTools().includes("create_plan"), true);
	});

	it("restores prior tools and content-bound authorization with an active Plan session", async () => {
		let confirmations = 0;
		const content = "# Restored plan";
		const approvedContentDigest = createHash("sha256").update(content).digest("hex");
		const harness = createHarness({
			confirm: async () => {
				confirmations += 1;
				return false;
			},
			branchEntries: [
			{
				type: "custom",
				customType: "plan-theme-state",
				data: {
					active: true,
					planPath: ".pi/plans/restored.md",
					previousThemeName: "dark",
					previousToolNames: ["read", "bash"],
					approvedContentDigest,
				},
			},
		],
		});
		await harness.handlers.get("session_start")?.({ type: "session_start" }, harness.ctx);
		const call = {
			type: "tool_call",
			toolCallId: "create-restored-plan",
			toolName: "create_plan",
			input: { content },
		};

		const result = await harness.handlers.get("tool_call")?.(call, harness.ctx);
		await harness.handlers.get("tool_result")?.({ ...call, type: "tool_result", isError: false }, harness.ctx);

		assert.equal(result?.block, undefined);
		assert.equal(confirmations, 0);
		assert.deepEqual(harness.getActiveTools(), ["read", "bash"]);
	});

	it("blocks restored content-bound approval when interactive UI is unavailable", async () => {
		let confirmations = 0;
		const content = "# Restored plan";
		const approvedContentDigest = createHash("sha256").update(content).digest("hex");
		const harness = createHarness({
			hasUI: false,
			confirm: async () => {
				confirmations += 1;
				return true;
			},
			branchEntries: [
				{
					type: "custom",
					customType: "plan-theme-state",
					data: {
						active: true,
						planPath: ".pi/plans/restored.md",
						previousThemeName: "dark",
						approvedContentDigest,
					},
				},
			],
		});
		await harness.handlers.get("session_start")?.({ type: "session_start" }, harness.ctx);

		const result = await harness.handlers.get("tool_call")?.(
			{
				type: "tool_call",
				toolCallId: "create-restored-plan",
				toolName: "create_plan",
				input: { content },
			},
			harness.ctx,
		);

		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /interactive approval/i);
		assert.equal(confirmations, 0);
	});

	it("remains enforced when switching to the Plan theme fails", async () => {
		const harness = createHarness({ themeSwitchSucceeds: false });
		await activatePlan(harness);

		const result = await harness.handlers.get("tool_call")?.(
			{ type: "tool_call", toolCallId: "write-source", toolName: "write", input: { path: "src/app.ts" } },
			harness.ctx,
		);

		assert.equal(result?.block, true);
		assert.equal(harness.entries.at(-1)?.data.active, true);
		assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "create_plan"]);
	});

	it("hides mutating and custom tools while retaining the controlled plan writer", async () => {
		const harness = createHarness();
		await activatePlan(harness);

		assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "create_plan"]);
	});

	it("retains and permits provenance-verified Web tools while planning", async () => {
		const harness = createHarness({ webTools: true });
		await activatePlan(harness);

		assert.deepEqual(harness.getActiveTools(), [
			"read", "grep", "find", "ls", "web_search", "web_fetch", "create_plan",
		]);
		for (const toolName of ["web_search", "web_fetch"]) {
			const result = await harness.handlers.get("tool_call")?.(
				{ type: "tool_call", toolCallId: toolName, toolName, input: {} },
				harness.ctx,
			);
			assert.equal(result?.block, undefined, toolName);
		}
	});

	it("blocks source-file writes while planning", async () => {
		const harness = createHarness();
		await activatePlan(harness);

		const result = await harness.handlers.get("tool_call")?.(
			{ type: "tool_call", toolCallId: "write-source", toolName: "write", input: { path: "src/app.ts" } },
			harness.ctx,
		);

		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /read-only/i);
	});

	it("asks before creating the plan and stays read-only when the user continues planning", async () => {
		const dialogs: Array<[string, string]> = [];
		const harness = createHarness({
			confirm: async (title, message) => {
				dialogs.push([title, message]);
				return false;
			},
		});
		await activatePlan(harness);
		const result = await harness.handlers.get("tool_call")?.(
			{
				type: "tool_call",
				toolCallId: "create-plan",
				toolName: "create_plan",
				input: { content: "# Plan" },
			},
			harness.ctx,
		);

		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /continue planning/i);
		assert.equal(dialogs.length, 1);
		assert.match(dialogs[0]?.join(" ") ?? "", /create.*plan/i);
		assert.equal(harness.entries.at(-1)?.data.active, true);
		assert.deepEqual(harness.sessionNames, []);
	});

	it("exits Plan mode, restores prior tools, and applies the contextual session name after an approved plan is written", async () => {
		const harness = createHarness({ confirm: async () => true, sessionName: "old-session-name" });
		const previousTools = harness.getActiveTools();
		await activatePlan(harness);
		const call = {
			type: "tool_call",
			toolCallId: "create-plan",
			toolName: "create_plan",
			input: { content: "# Plan: Protect project mutations" },
		};

		const result = await harness.handlers.get("tool_call")?.(call, harness.ctx);
		assert.equal(result?.block, undefined);
		await harness.handlers.get("tool_result")?.({ ...call, type: "tool_result", isError: false }, harness.ctx);

		assert.equal(harness.entries.at(-1)?.data.active, false);
		assert.deepEqual(harness.getActiveTools(), previousTools);
		assert.deepEqual(harness.sessionNames, ["protect-project-mutations"]);
	});

	it("resolves a known collision before exact-path confirmation", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-plan-theme-"));
		try {
			const dialogs: string[] = [];
			const harness = createHarness({
				confirm: async (_title, message) => {
					dialogs.push(message);
					return true;
				},
				cwd,
			});
			await activatePlan(harness);
			const generatedPath = harness.entries.at(-1)?.data.planPath as string;
			await mkdir(dirname(join(cwd, generatedPath)), { recursive: true });
			await writeFile(join(cwd, generatedPath), "existing plan");
			const call = {
				type: "tool_call",
				toolCallId: "create-plan",
				toolName: "create_plan",
				input: { content: "# New plan" },
			};
			await harness.handlers.get("tool_call")?.(call, harness.ctx);

			const tool = harness.registeredTools.get("create_plan");
			const result = await tool.execute(call.toolCallId, call.input, undefined, undefined, harness.ctx);

			assert.notEqual(result.details.path, generatedPath);
			assert.match(dialogs[0] ?? "", new RegExp(result.details.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.equal(await readFile(join(cwd, generatedPath), "utf8"), "existing plan");
			assert.equal(await readFile(join(cwd, result.details.path), "utf8"), "# New plan");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("revokes approval when the confirmed destination collides before publication", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-plan-theme-"));
		try {
			let confirmations = 0;
			const harness = createHarness({
				confirm: async () => {
					confirmations += 1;
					return true;
				},
				cwd,
			});
			await activatePlan(harness);
			const call = {
				type: "tool_call",
				toolCallId: "create-plan-1",
				toolName: "create_plan",
				input: { content: "# New plan" },
			};
			await harness.handlers.get("tool_call")?.(call, harness.ctx);
			const reviewedPath = harness.entries.at(-1)?.data.planPath as string;
			await mkdir(dirname(join(cwd, reviewedPath)), { recursive: true });
			await symlink("missing-racing-plan.md", join(cwd, reviewedPath));

			const tool = harness.registeredTools.get("create_plan");
			await assert.rejects(tool.execute(call.toolCallId, call.input, undefined, undefined, harness.ctx), {
				code: "EEXIST",
			});
			const nextPath = harness.entries.at(-1)?.data.planPath as string;
			assert.notEqual(nextPath, reviewedPath);
			assert.equal(harness.entries.at(-1)?.data.approvedContentDigest, undefined);

			const retry = await harness.handlers.get("tool_call")?.(
				{ ...call, toolCallId: "create-plan-2" },
				harness.ctx,
			);
			assert.equal(retry?.block, undefined);
			assert.equal(confirmations, 2);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps Plan mode active when interactive approval is unavailable", async () => {
		let confirmations = 0;
		const harness = createHarness({
			hasUI: false,
			confirm: async () => {
				confirmations += 1;
				return true;
			},
		});
		await activatePlan(harness);

		const result = await harness.handlers.get("input")?.(
			{ type: "input", source: "interactive", text: "/plan" },
			harness.ctx,
		);

		assert.deepEqual(result, { action: "handled" });
		assert.equal(confirmations, 0);
		assert.equal(harness.entries.at(-1)?.data.active, true);
	});

	it("re-running the Plan command defers its only approval to interactive confirmation", async () => {
		let confirmations = 0;
		const harness = createHarness({
			confirm: async () => {
				confirmations += 1;
				return true;
			},
		});
		await activatePlan(harness);
		const commandResult = await harness.handlers.get("input")?.(
			{ type: "input", source: "interactive", text: "/plan" },
			harness.ctx,
		);
		const writeResult = await harness.handlers.get("tool_call")?.(
			{ type: "tool_call", toolCallId: "create-plan", toolName: "create_plan", input: { content: "# Plan" } },
			harness.ctx,
		);

		assert.equal(commandResult?.action, "transform");
		assert.match(commandResult?.text ?? "", /creation succeeds, implement the saved plan/);
		assert.equal(writeResult?.block, undefined);
		assert.equal(confirmations, 1);
	});

	it("stays read-only without locking Plan mode when interactive confirmation fails", async () => {
		const harness = createHarness({
			confirm: async () => {
				throw new Error("dialog failed");
			},
		});
		await activatePlan(harness);

		const writeResult = await harness.handlers.get("tool_call")?.(
			{ type: "tool_call", toolCallId: "create-plan", toolName: "create_plan", input: { content: "# Plan" } },
			harness.ctx,
		);
		const readResult = await harness.handlers.get("tool_call")?.(
			{ type: "tool_call", toolCallId: "read-source", toolName: "read", input: { path: "README.md" } },
			harness.ctx,
		);

		assert.equal(writeResult?.block, true);
		assert.match(writeResult?.reason ?? "", /approval.*failed/i);
		assert.equal(readResult?.block, undefined);
	});

	it("uses one confirmation and blocks concurrent calls while approval is pending", async () => {
		let confirmations = 0;
		let resolveConfirmation: ((approved: boolean) => void) | undefined;
		const confirmation = new Promise<boolean>((resolve) => {
			resolveConfirmation = resolve;
		});
		const harness = createHarness({
			confirm: async () => {
				confirmations += 1;
				return confirmation;
			},
		});
		await activatePlan(harness);
		const first = harness.handlers.get("tool_call")?.(
			{ type: "tool_call", toolCallId: "create-plan-1", toolName: "create_plan", input: { content: "# Plan" } },
			harness.ctx,
		);
		await new Promise((resolve) => setImmediate(resolve));

		const sibling = harness.handlers.get("tool_call")?.(
			{ type: "tool_call", toolCallId: "create-plan-2", toolName: "create_plan", input: { content: "# Plan" } },
			harness.ctx,
		);
		for (let attempts = 0; attempts < 20 && confirmations === 0; attempts += 1) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		resolveConfirmation?.(true);

		assert.equal(confirmations, 1);
		assert.equal((await first)?.block, undefined);
		assert.equal((await sibling)?.block, true);
	});

	it("locks the approved plan-write arguments against later extension mutation", async () => {
		const harness = createHarness({ confirm: async () => true });
		await activatePlan(harness);
		const call = {
			type: "tool_call",
			toolCallId: "create-plan",
			toolName: "create_plan",
			input: { content: "# Plan" },
		};

		await harness.handlers.get("tool_call")?.(call, harness.ctx);

		assert.throws(() => {
			call.input.content = "mutated plan";
		}, TypeError);
		assert.equal(Reflect.set(call, "input", { content: "mutated plan" }), false);
		assert.equal(call.input.content, "# Plan");
	});

	it("blocks sibling tool calls while the approved plan write is in progress", async () => {
		const harness = createHarness({ confirm: async () => true });
		await activatePlan(harness);

		await harness.handlers.get("tool_call")?.(
			{ type: "tool_call", toolCallId: "create-plan-1", toolName: "create_plan", input: { content: "# Plan" } },
			harness.ctx,
		);
		const sibling = await harness.handlers.get("tool_call")?.(
			{ type: "tool_call", toolCallId: "create-plan-2", toolName: "create_plan", input: { content: "# Plan" } },
			harness.ctx,
		);

		assert.equal(sibling?.block, true);
		assert.match(sibling?.reason ?? "", /save.*in progress/i);
	});

	it("recovers from an interrupted plan write when the user continues planning", async () => {
		const decisions = [true, false];
		const harness = createHarness({ confirm: async () => decisions.shift() ?? false });
		await activatePlan(harness);
		await harness.handlers.get("tool_call")?.(
			{ type: "tool_call", toolCallId: "interrupted-write", toolName: "create_plan", input: { content: "# Plan" } },
			harness.ctx,
		);

		await harness.handlers.get("input")?.(
			{ type: "input", source: "interactive", text: "/plan" },
			harness.ctx,
		);
		const readResult = await harness.handlers.get("tool_call")?.(
			{ type: "tool_call", toolCallId: "read-after-interruption", toolName: "read", input: { path: "README.md" } },
			harness.ctx,
		);

		assert.equal(readResult?.block, undefined);
		assert.equal(harness.entries.at(-1)?.data.active, true);
		assert.equal(harness.entries.at(-1)?.data.approvedContentDigest, undefined);
		assert.deepEqual(harness.sessionNames, []);
	});

	it("stays in Plan mode and retains approval when the plan write fails", async () => {
		let confirmations = 0;
		const harness = createHarness({
			confirm: async () => {
				confirmations += 1;
				return true;
			},
		});
		await activatePlan(harness);
		const firstCall = {
			type: "tool_call",
			toolCallId: "create-plan-1",
			toolName: "create_plan",
			input: { content: "# Plan" },
		};

		await harness.handlers.get("tool_call")?.(firstCall, harness.ctx);
		await harness.handlers.get("tool_result")?.({ ...firstCall, type: "tool_result", isError: true }, harness.ctx);
		const retry = await harness.handlers.get("tool_call")?.(
			{ ...firstCall, toolCallId: "write-plan-2" },
			harness.ctx,
		);

		assert.equal(retry?.block, undefined);
		assert.equal(confirmations, 1);
		assert.equal(harness.entries.at(-1)?.data.active, true);
		assert.equal(
			harness.entries.at(-1)?.data.approvedContentDigest,
			createHash("sha256").update("# Plan").digest("hex"),
		);
		assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "create_plan"]);
		assert.deepEqual(harness.sessionNames, []);
	});

	it("requires another confirmation when a failed write is retried with changed content", async () => {
		let confirmations = 0;
		const decisions = [true, false];
		const harness = createHarness({
			confirm: async () => {
				confirmations += 1;
				return decisions.shift() ?? false;
			},
		});
		await activatePlan(harness);
		const firstCall = {
			type: "tool_call",
			toolCallId: "create-plan-1",
			toolName: "create_plan",
			input: { content: "# Plan: First draft" },
		};

		await harness.handlers.get("tool_call")?.(firstCall, harness.ctx);
		await harness.handlers.get("tool_result")?.({ ...firstCall, type: "tool_result", isError: true }, harness.ctx);
		const changedRetry = await harness.handlers.get("tool_call")?.(
			{
				...firstCall,
				toolCallId: "create-plan-2",
				input: { content: "# Plan: Changed draft" },
			},
			harness.ctx,
		);

		assert.equal(changedRetry?.block, true);
		assert.match(changedRetry?.reason ?? "", /continue planning/i);
		assert.equal(confirmations, 2);
		assert.equal(harness.entries.at(-1)?.data.approvedContentDigest, undefined);
	});

	it("blocks an overridden writer without asking it to create the plan", async () => {
		let confirmations = 0;
		const harness = createHarness({
			confirm: async () => {
				confirmations += 1;
				return true;
			},
		});
		const write = harness.allTools.find((tool) => tool.name === "write");
		assert.ok(write);
		write.sourceInfo.source = "package";
		write.sourceInfo.path = "/extensions/untrusted-write.ts";
		await activatePlan(harness);
		const planPath = harness.entries.at(-1)?.data.planPath;

		const result = await harness.handlers.get("tool_call")?.(
			{ type: "tool_call", toolCallId: "custom-write", toolName: "write", input: { path: planPath } },
			harness.ctx,
		);

		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /read-only/i);
		assert.equal(confirmations, 0);
	});

	it("blocks a custom tool that overrides a read-only built-in", async () => {
		const harness = createHarness();
		const read = harness.allTools.find((tool) => tool.name === "read");
		assert.ok(read);
		read.sourceInfo.source = "package";
		read.sourceInfo.path = "/extensions/untrusted-read.ts";
		await activatePlan(harness);

		const result = await harness.handlers.get("tool_call")?.(
			{ type: "tool_call", toolCallId: "custom-read", toolName: "read", input: { path: "README.md" } },
			harness.ctx,
		);

		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /read-only/i);
	});

	it("blocks user shell commands while planning", async () => {
		const harness = createHarness();
		await activatePlan(harness);

		const result = await harness.handlers.get("user_bash")?.(
			{ type: "user_bash", command: "rm -rf src", excludeFromContext: false, cwd: harness.ctx.cwd },
			harness.ctx,
		);

		assert.equal(result?.result?.exitCode, 126);
		assert.match(result?.result?.output ?? "", /Plan mode.*read-only/i);
	});

	it("blocks editing, shell execution, and custom tools while planning", async () => {
		const harness = createHarness();
		await activatePlan(harness);

		for (const [toolName, input] of [
			["edit", { path: "src/app.ts" }],
			["bash", { command: "rm -rf src" }],
			["guild_handover", { member: "csharp-coder", task: "edit the project" }],
		] as const) {
			const result = await harness.handlers.get("tool_call")?.(
				{ type: "tool_call", toolCallId: toolName, toolName, input },
				harness.ctx,
			);

			assert.equal(result?.block, true, `${toolName} should be blocked`);
			assert.match(result?.reason ?? "", /read-only/i);
		}
	});
});
