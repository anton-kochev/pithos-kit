import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import atlas from "../extensions/index.ts";

function createHarness(dependencies: Record<string, unknown> = {}) {
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const messages: Array<{ message: any; options: any }> = [];
	const sessionNames: string[] = [];
	atlas({
		registerCommand(name: string, definition: any) { commands.set(name, definition); },
		registerTool(definition: any) { tools.set(definition.name, definition); },
		on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		sendMessage(message: any, options: any) { messages.push({ message, options }); },
		setSessionName(name: string) { sessionNames.push(name); },
		getSessionName() { return sessionNames.at(-1); },
		getCommands() { return []; },
		getAllTools() { return []; },
	} as never, dependencies as never);
	return { commands, tools, handlers, messages, sessionNames };
}

describe("Atlas extension", () => {
	it("installs the Atlas runtime footer during normal TUI startup", async () => {
		const { handlers } = createHarness();
		let footerFactory: unknown;
		const context = {
			mode: "tui",
			cwd: "/workspace/project",
			modelRegistry: { getAvailable: () => [] },
			scopedModels: [],
			model: { provider: "openai-codex", id: "gpt-5.6-sol" },
			thinkingLevel: "high",
			sessionManager: {
				getEntries: () => [],
				getBranch: () => [],
				getSessionFile: () => "/existing/session.jsonl",
			},
			ui: {
				setFooter(factory: unknown) { footerFactory = factory; },
			},
		};

		for (const handler of handlers.get("session_start") ?? []) {
			await handler({ reason: "startup" }, context);
		}

		assert.equal(typeof footerFactory, "function");
	});

	it("leaves a fresh session unnamed until the user sends its first message", async () => {
		const { handlers, sessionNames } = createHarness();
		const ctx = {
			modelRegistry: { getAvailable: () => [] },
			scopedModels: [],
			sessionManager: {
				getEntries: () => [
					{ type: "model_change" },
					{ type: "thinking_level_change" },
				],
				getSessionFile: () => "/does/not/exist/fresh.jsonl",
			},
		};

		for (const handler of handlers.get("session_start") ?? []) {
			await handler({ reason: "startup" }, ctx);
		}
		assert.deepEqual(sessionNames, []);

		for (const handler of handlers.get("message_start") ?? []) {
			await handler({ message: { role: "user" } }, ctx);
		}
		assert.equal(sessionNames.length, 1);
		assert.match(sessionNames[0] ?? "", /^[a-z0-9]+(?:-[a-z0-9]+){2,4}$/u);
	});

	it("renames the current session when the model is explicitly asked", async () => {
		const { tools, sessionNames } = createHarness();

		const result = await tools.get("rename_session").execute(
			"call",
			{ name: "deferred-session-naming" },
			undefined,
			undefined,
			{},
		);

		assert.deepEqual(sessionNames, ["deferred-session-naming"]);
		assert.equal(result.content[0].text, "Session renamed to: deferred-session-naming");
		assert.deepEqual(result.details, { name: "deferred-session-naming" });
		for (const invalidName of ["Deferred Session Naming", "   "]) {
			await assert.rejects(
				tools.get("rename_session").execute("call", { name: invalidName }, undefined, undefined, {}),
				/Session name must use lowercase kebab-case/,
			);
		}
		assert.deepEqual(sessionNames, ["deferred-session-naming"]);
	});

	it("canonicalizes names set through Pi's native rename paths", async () => {
		const { handlers, sessionNames } = createHarness();
		sessionNames.push("Native Session Name");

		for (const handler of handlers.get("session_info_changed") ?? []) {
			await handler({ name: "Native Session Name" }, {});
		}

		assert.equal(sessionNames.at(-1), "native-session-name");

		sessionNames.push("🔥");
		for (const handler of handlers.get("session_info_changed") ?? []) {
			await handler({ name: "🔥" }, {});
		}
		assert.equal(sessionNames.at(-1), "unnamed-session");

		const restored = createHarness();
		restored.sessionNames.push("Inherited Session Name");
		for (const handler of restored.handlers.get("session_start") ?? []) {
			await handler({ reason: "resume" }, { sessionManager: {} });
		}
		assert.equal(restored.sessionNames.at(-1), "inherited-session-name");
	});

	it("registers without network access and keeps pithos_info read-only", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => { throw new Error("unexpected startup network request"); };
		try {
			const { commands, tools } = createHarness();
			assert.deepEqual([...commands.keys()], ["pithos"]);
			assert.deepEqual([...tools.keys()], ["rename_session", "pithos_info"]);
			const schemaText = JSON.stringify(tools.get("pithos_info").parameters);
			assert.doesNotMatch(schemaText, /write|apply|manage|update/i);
			const result = await tools.get("pithos_info").execute("call", { action: "catalog" }, undefined, undefined, {
				cwd: "/project",
			} as never);
			assert.equal(result.details.packages.length, 12);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("reports configured toolchains through the read-only config tool", async () => {
		const directory = await mkdtemp(join(tmpdir(), "atlas-toolchains-"));
		await writeFile(join(directory, ".pithos"), "toolchains:\n  go: \"1.24.0\"\npi:\n  version: \"0.84.1\"\n");
		try {
			const { tools } = createHarness();
			const result = await tools.get("pithos_info").execute("call", { action: "config" }, undefined, undefined, {
				cwd: directory,
			} as never);
			assert.match(result.content[0].text, /Configured toolchains:\n  go: 1\.24\.0/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("includes bounded phase timings in doctor tool output", async () => {
		const previousOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
		try {
			const { tools } = createHarness();
			const result = await tools.get("pithos_info").execute("call", { action: "doctor" }, undefined, undefined, {
				cwd: "/does-not-exist",
			} as never);

			assert.match(result.content[0].text, /Doctor timing: total=\d+ms; config=\d+ms; registry=\d+ms; runtime=\d+ms/);
			assert.equal(result.content[0].text.length < 40_000, true);
		} finally {
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
		}
	});

	it("reports the failed doctor phase without exposing configuration contents", async () => {
		const directory = await mkdtemp(join(tmpdir(), "atlas-doctor-error-"));
		await writeFile(join(directory, ".pithos"), "secret-value: [");
		const previousOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
		try {
			const { tools } = createHarness();
			const result = await tools.get("pithos_info").execute("call", { action: "doctor" }, undefined, undefined, {
				cwd: directory,
			} as never);

			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /Doctor timing: total=\d+ms; config=failed \d+ms;/);
			assert.doesNotMatch(result.content[0].text, /secret-value/);
		} finally {
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("reports and explicitly applies the distributable footer patch", async () => {
		const patchCalls: string[] = [];
		const patchExpectations: unknown[] = [];
		const sourceDigest = "a".repeat(64);
		const { commands } = createHarness({
			activePiPackage: { root: "/opt/pi", version: "0.84.2" },
			runFooterPatch: async (operation: string, _root: string, _signal: AbortSignal | undefined, expectation: unknown) => {
				patchCalls.push(operation);
				patchExpectations.push(expectation);
				return {
					patch: "footer",
					action: operation,
					status: operation === "apply" ? "applied" : "available",
					changed: false,
					packageDir: "/opt/pi",
					version: "0.84.2",
					file: "/opt/pi/dist/modes/interactive/components/footer.js",
					sourceDigest,
					restartRequired: operation === "apply",
				};
			},
		});
		const notifications: Array<{ message: string; level?: string }> = [];
		const confirmations: Array<{ title: string; message: string }> = [];
		const context = {
			mode: "tui",
			hasUI: true,
			waitForIdle: async () => {},
			isIdle: () => true,
			sessionManager: { getBranch: () => [] },
			ui: {
				notify: (message: string, level?: string) => notifications.push({ message, level }),
				confirm: async (title: string, message: string) => {
					confirmations.push({ title, message });
					return true;
				},
			},
		};

		await commands.get("pithos").handler("patch footer status", context as never);
		assert.deepEqual(patchCalls, ["status"]);
		assert.match(notifications.at(-1)?.message ?? "", /Pi 0\.84\.2 built-in footer fallback patch: available/);
		assert.equal(confirmations.length, 0);

		await commands.get("pithos").handler("patch footer apply", context as never);
		assert.deepEqual(patchCalls, ["status", "status", "apply"]);
		assert.deepEqual(patchExpectations, [undefined, undefined, { version: "0.84.2", digest: sourceDigest }]);
		assert.match(confirmations[0]?.message ?? "", /\/opt\/pi\/dist\/modes\/interactive\/components\/footer\.js/);
		assert.match(confirmations[0]?.message ?? "", /Pi 0\.84\.2/);
		assert.match(notifications.at(-1)?.message ?? "", /Restart Pi/);
	});

	it("refuses footer mutation when Pi does not become idle", async () => {
		const patchCalls: string[] = [];
		const { commands } = createHarness({
			activePiPackage: { root: "/opt/pi", version: "0.84.2" },
			waitForIdleTimeoutMs: 5,
			runFooterPatch: async (operation: string) => {
				patchCalls.push(operation);
				throw new Error("should not run");
			},
		});
		const notifications: string[] = [];

		await commands.get("pithos").handler("patch footer apply", {
			mode: "tui",
			hasUI: true,
			waitForIdle: async () => new Promise(() => undefined),
			sessionManager: { getBranch: () => [] },
			ui: { notify: (message: string) => notifications.push(message) },
		} as never);

		assert.deepEqual(patchCalls, []);
		assert.match(notifications[0] ?? "", /waiting for Pi to become idle/);
		assert.match(notifications[0] ?? "", /no changes were made/i);
	});

	it("refuses footer mutation while Plan mode is active", async () => {
		const patchCalls: string[] = [];
		const { commands } = createHarness({
			activePiPackage: { root: "/opt/pi", version: "0.84.2" },
			runFooterPatch: async (operation: string) => {
				patchCalls.push(operation);
				throw new Error("should not run");
			},
		});
		const notifications: string[] = [];

		await commands.get("pithos").handler("patch footer remove", {
			mode: "tui",
			hasUI: true,
			waitForIdle: async () => {},
			sessionManager: {
				getBranch: () => [{ type: "custom", customType: "plan-theme-state", data: { active: true } }],
			},
			ui: { notify: (message: string) => notifications.push(message) },
		} as never);

		assert.deepEqual(patchCalls, []);
		assert.match(notifications[0] ?? "", /unavailable while Plan mode is active or indeterminate/);
	});

	it("offers a focused main menu with About, Doctor, Configure, and fallback patches", async () => {
		const { commands } = createHarness();
		const selections: Array<{ title: string; options: string[] }> = [];
		const notifications: string[] = [];
		await commands.get("pithos").handler("", {
			mode: "tui",
			hasUI: true,
			ui: {
				async select(title: string, options: string[]) {
					selections.push({ title, options });
					return "About";
				},
				notify: (message: string) => notifications.push(message),
			},
		} as never);

		assert.deepEqual(selections, [{ title: "Pithos Atlas", options: ["About", "Doctor", "Configure", "Fallback Patches"] }]);
		assert.match(notifications[0] ?? "", /Usage: \/pithos/);
	});

	it("opens a visible patch menu with the current footer state and available action", async () => {
		const selections: Array<{ title: string; options: string[] }> = [];
		const choices = ["Fallback Patches", "Back"];
		const sourceDigest = "a".repeat(64);
		const { commands } = createHarness({
			activePiPackage: { root: "/opt/pi", version: "0.84.2" },
			runFooterPatch: async () => ({
				patch: "footer",
				action: "status",
				status: "applied",
				changed: false,
				packageDir: "/opt/pi",
				version: "0.84.2",
				file: "/opt/pi/dist/modes/interactive/components/footer.js",
				sourceDigest,
				restartRequired: false,
			}),
		});

		await commands.get("pithos").handler("", {
			mode: "tui",
			hasUI: true,
			signal: undefined,
			ui: {
				async select(title: string, options: string[]) {
					selections.push({ title, options });
					return choices.shift();
				},
				notify() {},
			},
		} as never);

		assert.deepEqual(selections, [
			{ title: "Pithos Atlas", options: ["About", "Doctor", "Configure", "Fallback Patches"] },
			{ title: "Optional Footer Fallback", options: ["Built-in footer fallback · applied", "Remove built-in footer fallback", "Back"] },
		]);
	});

	it("refuses configuration outside a trusted TUI before reading or fetching", async () => {
		const { commands } = createHarness();
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (message?: unknown) => logs.push(String(message));
		try {
			await commands.get("pithos").handler("config", {
				mode: "print",
				hasUI: false,
				cwd: "/does-not-exist",
				isProjectTrusted: () => false,
				ui: { notify() {} },
			} as never);
		} finally {
			console.log = originalLog;
		}
		assert.deepEqual(logs, ["/pithos config requires a trusted interactive TUI."]);
	});

	it("refuses configuration when Pi does not become idle", async () => {
		const { commands } = createHarness({ waitForIdleTimeoutMs: 5 });
		const notifications: string[] = [];
		await commands.get("pithos").handler("config", {
			mode: "tui",
			hasUI: true,
			cwd: "/does-not-exist",
			isProjectTrusted: () => true,
			waitForIdle: async () => new Promise(() => undefined),
			sessionManager: { getBranch: () => [] },
			ui: { notify: (message: string) => notifications.push(message) },
		} as never);

		assert.match(notifications[0] ?? "", /waiting for Pi to become idle/);
		assert.match(notifications[0] ?? "", /no changes were made/i);
	});

	it("refuses configuration while Plan mode is active", async () => {
		const { commands } = createHarness();
		const notifications: string[] = [];
		let waited = 0;
		await commands.get("pithos").handler("config", {
			mode: "tui",
			hasUI: true,
			cwd: "/does-not-exist",
			isProjectTrusted: () => true,
			waitForIdle: async () => { waited += 1; },
			sessionManager: {
				getBranch: () => [{ type: "custom", customType: "plan-theme-state", data: { active: true } }],
			},
			ui: { notify: (message: string) => notifications.push(message) },
		} as never);
		assert.equal(waited, 1);
		assert.deepEqual(notifications, ["/pithos config is unavailable while Plan mode is active or indeterminate."]);
	});

	it("applies an explicitly confirmed interactive package selection", async () => {
		const directory = await mkdtemp(join(tmpdir(), "atlas-extension-"));
		const path = join(directory, ".pithos");
		await writeFile(path, "toolchains: {}\npi:\n  version: \"0.83.0\"\n");
		const previousOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
		try {
			const { commands } = createHarness();
			let packageMenuCount = 0;
			await commands.get("pithos").handler("config", {
				mode: "tui",
				hasUI: true,
				cwd: directory,
				isProjectTrusted: () => true,
				waitForIdle: async () => {},
				sessionManager: { getBranch: () => [] },
				ui: {
					notify() {},
					async select(title: string, options: string[]) {
						if (title === "Configure 1/3 · Pi version") return options[0];
						if (title === "Configure 2/3 · Toolchains") return "Continue";
						if (title === "Configure 3/3 · pithos-kit packages") {
							packageMenuCount += 1;
							return packageMenuCount === 1 ? options.find((option) => option.startsWith("◇ Atlas")) : "Review and Submit";
						}
						if (title === "Atlas version") return "0.1.0";
						if (title.startsWith("Review .pithos changes")) return "Yes";
						return undefined;
					},
					async input() { return undefined; },
				},
			} as never);
			assert.match(await readFile(path, "utf8"), /"@pithos-kit\/atlas": npm:0\.1\.0/);
		} finally {
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("shows cancellable progress while doctor gathers diagnostics", async () => {
		const previousOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
		try {
			const { commands } = createHarness();
			const notifications: string[] = [];
			let customCalls = 0;

			await commands.get("pithos").handler("doctor", {
				mode: "tui",
				hasUI: true,
				cwd: "/does-not-exist",
				ui: {
					notify: (message: string) => notifications.push(message),
					async custom() {
						customCalls += 1;
						return { cancelled: true };
					},
				},
			} as never);

			assert.equal(customCalls, 1);
			assert.equal(notifications.length, 1);
			assert.match(notifications[0] ?? "", /Doctor cancelled: total=\d+ms; config=pending; registry=pending; runtime=pending/);
		} finally {
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
		}
	});

	it("lists package-owned commands, tools, prompts, skills, themes, agents, and configuration", async () => {
		const { commands } = createHarness();
		const notifications: string[] = [];
		await commands.get("pithos").handler("packages", {
			mode: "tui",
			hasUI: true,
			ui: { notify: (message: string) => notifications.push(message) },
		} as never);

		assert.equal(notifications.length, 1);
		assert.match(notifications[0] ?? "", /commands: \/pithos/);
		assert.match(notifications[0] ?? "", /commands: \/guild, \/guild-handover, \/commit, \/skill:conventional-commit, \/skill:tdd/);
		assert.match(notifications[0] ?? "", /tools: guild_handover, create_commit \(internal\)/);
		assert.match(notifications[0] ?? "", /tools: rename_session, pithos_info/);
		assert.match(notifications[0] ?? "", /prompts: plan/);
		assert.doesNotMatch(notifications[0] ?? "", /srs-generator/);
		assert.match(notifications[0] ?? "", /skills: conventional-commit, tdd/);
		assert.match(notifications[0] ?? "", /themes: plan/);
		assert.match(notifications[0] ?? "", /agents: dotnet-architect/);
		assert.match(notifications[0] ?? "", /configuration: file \.pi\/aegis\.json/);
		assert.match(notifications[0] ?? "", /environment PITHOS_ATLAS_PI_PACKAGE_DIR/);
	});

	it("completes and documents every footer patch action", () => {
		const { commands } = createHarness();
		const command = commands.get("pithos");

		assert.deepEqual(
			command.getArgumentCompletions("patch footer ").map(({ value }: { value: string }) => value),
			["patch footer status", "patch footer apply", "patch footer remove"],
		);
		assert.match(command.description, /optional built-in fallback patches/);
	});

	it("shows the single Atlas help page", async () => {
		const { commands } = createHarness();
		const notifications: string[] = [];
		await commands.get("pithos").handler("help", {
			mode: "tui",
			hasUI: true,
			ui: { notify: (message: string) => notifications.push(message) },
		} as never);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /3–5-word session names/);
		assert.match(notifications[0], /Usage: \/pithos/);
		assert.match(notifications[0], /\/pithos patch footer status/);
		assert.match(notifications[0], /\/pithos patch footer apply/);
		assert.match(notifications[0], /\/pithos patch footer remove/);
		assert.doesNotMatch(notifications[0], /\/skill:tdd|TDD guidance/);
		assert.doesNotMatch(notifications[0], /\/commit|Conventional Commit/);
		assert.doesNotMatch(notifications[0], /\/pithos help </);
	});
});
