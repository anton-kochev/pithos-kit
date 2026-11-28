import assert from "node:assert/strict";
import { mkdtemp, realpath, readdir, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { rm } from "node:fs/promises";
import telos from "../src/telos";
import { captureTaskSession, runSessionOperation } from "../src/session-store";

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
async function directory() {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "telos-extension-")));
	directories.push(cwd);
	return cwd;
}
function harness() {
	let command: any;
	let tool: any;
	const events = new Map<string, (...args: any[]) => any>();
	telos({
		registerCommand: (_name: string, value: any) => { command = value; },
		registerTool: (value: any) => { tool = value; },
		on: (event: string, handler: any) => { events.set(event, handler); },
	} as any);
	return { command, tool, events };
}
function context(cwd: string, id: string, sessionFile?: string) {
	return {
		cwd, hasUI: false, mode: "json",
		sessionManager: { getSessionId: () => id, getSessionFile: () => sessionFile },
		ui: { notify: () => {} },
	};
}

function withFooter(ctx: ReturnType<typeof context>, fg = (_color: string, text: string) => text) {
	const statuses = new Map<string, string>();
	return { ...ctx, hasUI: true, mode: "tui", statuses, ui: {
		...ctx.ui,
		theme: { fg },
		setStatus(key: string, text?: string) {
			if (text === undefined) statuses.delete(key);
			else statuses.set(key, text);
		},
	} };
}

describe("Telos command/tool integration", () => {
	it("restores progress in the footer on resume and clears it on shutdown", async () => {
		const cwd = await directory();
		const ctx = withFooter(context(cwd, "saved", join(cwd, "saved.jsonl")), (color, text) => `<${color}>${text}</${color}>`);
		const session = captureTaskSession(ctx);
		for (const status of ["blocked", "todo", "in_progress", "done", "done", "archived"] as const) {
			await runSessionOperation(session, { action: "create", title: status, status });
		}
		const { events } = harness();
		await events.get("session_start")!({ reason: "resume" }, ctx);
		assert.equal(ctx.statuses.get("telos"), "Tasks · <muted>□ 1</muted> · <accent>▣ 1</accent> · <success>■ 2</success>");
		await events.get("session_shutdown")!({ reason: "new" }, ctx);
		assert.equal(ctx.statuses.has("telos"), false);
	});

	it("updates footer counts after tool and command changes and hides an empty checklist", async () => {
		const ctx = withFooter(context(await directory(), "memory"));
		const { command, tool, events } = harness();
		await events.get("session_start")!({ reason: "startup" }, ctx);
		assert.equal(ctx.statuses.has("telos"), false);

		const created = await tool.execute("create", { action: "create", title: "Write docs" }, undefined, undefined, ctx);
		const id = created.details.task.id;
		assert.equal(ctx.statuses.get("telos"), "Tasks · □ 1 · ▣ 0 · ■ 0");
		await command.handler(`block ${id}`, ctx);
		assert.equal(ctx.statuses.get("telos"), "Tasks · □ 0 · ▣ 0 · ■ 0");
		await command.handler(`status ${id} in_progress`, ctx);
		assert.equal(ctx.statuses.get("telos"), "Tasks · □ 0 · ▣ 1 · ■ 0");
		await tool.execute("finish", { action: "complete", id }, undefined, undefined, ctx);
		assert.equal(ctx.statuses.get("telos"), "Tasks · □ 0 · ▣ 0 · ■ 1");
		await command.handler(`archive ${id}`, ctx);
		assert.equal(ctx.statuses.has("telos"), false);
	});

	it("routes command and tool to the same session and labels memory-only results", async () => {
		const cwd = await directory();
		const { command, tool } = harness();
		const a = context(cwd, "a");
		const b = context(cwd, "b");
		const created = await command.handler('create "Session A task"', a);
		assert.match(created, /memory-only/);
		const listed = await tool.execute("call", { action: "list" }, undefined, undefined, a);
		assert.match(listed.content[0].text, /Session A task/);
		assert.match(listed.content[0].text, /memory-only/);
		const other = await tool.execute("other", { action: "list" }, undefined, undefined, b);
		assert.match(other.content[0].text, /No active tasks/);
		assert.doesNotMatch(other.content[0].text, /Session A task/);
		const plain = await command.handler("", a);
		assert.match(plain, /Session A task/);
		assert.deepEqual(await readdir(cwd), []);
	});

	it("preserves ephemeral tasks through reload but releases them on session replacement", async () => {
		const cwd = await directory();
		const { command, events } = harness();
		const ctx = context(cwd, "lifecycle");
		await command.handler('create "Retain for reload"', ctx);
		await events.get("session_shutdown")!({ reason: "reload" }, ctx);
		assert.match(await command.handler("list", ctx), /Retain for reload/);
		await events.get("session_shutdown")!({ reason: "new" }, ctx);
		assert.doesNotMatch(await command.handler("list", ctx), /Retain for reload/);
	});

	it("mounts the session snapshot, refreshes it while open, and closes on runtime shutdown", { timeout: 5000 }, async () => {
		const cwd = await directory();
		const { command, events } = harness();
		const ctx = withFooter(context(cwd, "live"));
		await events.get("session_start")!({ reason: "startup" }, ctx);
		const owner = captureTaskSession(ctx);
		const initial = await runSessionOperation(owner, { action: "create", title: "Before mount" });
		let component: any;
		let renders = 0;
		let mounted!: () => void;
		let rendered!: () => void;
		const mounting = new Promise<void>((resolve) => { mounted = resolve; });
		const rendering = new Promise<void>((resolve) => { rendered = resolve; });
		let footerAtMount: string | undefined;
		const interactive = { ...ctx, ui: {
			...ctx.ui,
			custom: async (factory: any) => {
				footerAtMount = ctx.statuses.get("telos");
				// A write between initial loading and mounting must be caught immediately.
				await runSessionOperation(owner, { action: "update", id: initial.task!.id, title: "After mount", status: "in_progress" });
				return new Promise<void>((done) => {
					component = factory({ requestRender: () => { renders++; rendered(); } }, { fg: (_: string, text: string) => text }, {}, done);
					assert.match(component.render(120).join("\n"), /Before mount/);
					mounted();
				});
			},
		} };
		const running = command.handler("", interactive);
		await mounting;
		await rendering;
		assert(component, "custom screen was mounted");
		assert.match(component.render(120).join("\n"), /After mount/);
		assert.equal(footerAtMount, "Tasks · □ 1 · ▣ 0 · ■ 0");
		assert.equal(ctx.statuses.get("telos"), "Tasks · □ 0 · ▣ 1 · ■ 0");
		assert.match(component.render(120).join("\n"), /Ephemeral session/);
		assert(events.has("session_shutdown"));
		await events.get("session_shutdown")!({ type: "session_shutdown", reason: "new" }, interactive);
		await running;
		const count = renders;
		component.updateTasks([]);
		assert.equal(renders, count, "disposed screen ignores late updates");
		assert.deepEqual(await readdir(cwd), []);
	});

	it("applies the configured visible count to the open task screen", async (t) => {
		const cwd = await directory();
		const { command } = harness();
		const ctx = context(cwd, "configured-view");
		const owner = captureTaskSession(ctx);
		for (let i = 0; i < 12; i++) await runSessionOperation(owner, { action: "create", title: `Task ${i}` });
		const fs = (await import("node:fs/promises")).default;
		const { syncBuiltinESMExports } = await import("node:module");
		const originalRead = fs.readFile;
		const mock = t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
			if (args[0] === join(cwd, ".pi", "telos.json")) return '{"visibleTaskCount":3}';
			return originalRead(...args);
		});
		syncBuiltinESMExports();
		let component: any;
		let mounted!: () => void;
		const mounting = new Promise<void>((resolve) => { mounted = resolve; });
		let running: Promise<unknown> | undefined;
		try {
			running = command.handler("", { ...ctx, hasUI: true, mode: "tui", ui: {
				notify: () => {},
				custom: (factory: any) => new Promise<void>((done) => {
					component = factory({ requestRender: () => {} }, { fg: (_: string, text: string) => text }, {}, done);
					mounted();
				}),
			} });
			await mounting;
			await new Promise<void>((resolve) => setImmediate(resolve));
			const lines = component.render(120);
			assert.equal(lines.filter((line: string) => line.includes("TSK-")).length, 3);
			assert(lines.join("\n").includes("1–3 of 12"));
		} finally {
			component?.handleInput("q");
			await running;
			mock.mock.restore();
			syncBuiltinESMExports();
		}
	});

	it("uses text output instead of a terminal screen for RPC clients", async () => {
		const cwd = await directory();
		const { command } = harness();
		const ctx = context(cwd, "rpc");
		await runSessionOperation(captureTaskSession(ctx), { action: "create", title: "RPC task" });
		let text = "";
		await command.handler("", { ...ctx, hasUI: true, mode: "rpc", ui: {
			notify: (value: string) => { text = value; },
			custom: () => { throw new Error("RPC cannot render custom terminal screens"); },
		} });
		assert.match(text, /RPC task/);
	});

	it("previews cleanup, requires confirmation, and never deletes without UI", async () => {
		const cwd = await directory();
		const sessionFile = join(cwd, "old-session.jsonl");
		await writeFile(sessionFile, JSON.stringify({ type: "session", id: "old", cwd }) + "\n");
		const old = captureTaskSession(context(cwd, "old", sessionFile));
		await runSessionOperation(old, { action: "create", title: "Orphan task" });
		await unlink(sessionFile);
		const { command, tool } = harness();
		const current = context(cwd, "current", join(cwd, "current.jsonl"));
		const noUI = await command.handler("cleanup", current);
		assert.match(noUI, /confirmation|interactive/i);
		assert.equal((await readdir(join(cwd, ".pi", "telos", "sessions"))).length, 1);
		let approved = false;
		let preview = "";
		const interactive = { ...current, hasUI: true, mode: "tui", ui: {
			notify: () => {},
			confirm: async (_title: string, message: string) => { preview = message; return approved; },
		} };
		await command.handler("cleanup", interactive);
		assert.match(preview, /old-session\.jsonl/);
		assert.match(preview, /moved|restore/i);
		assert.equal((await readdir(join(cwd, ".pi", "telos", "sessions"))).length, 1);
		approved = true;
		const result = await command.handler("cleanup", interactive);
		assert.match(result, /1 deleted/);
		assert.deepEqual(await readdir(join(cwd, ".pi", "telos", "sessions")), []);
		assert.equal(tool.parameters.properties.action.enum.includes("cleanup"), false);
	});
});
