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

describe("Telos command/tool integration", () => {
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
		const ctx = context(cwd, "live");
		const owner = captureTaskSession(ctx);
		const initial = await runSessionOperation(owner, { action: "create", title: "Before mount" });
		let component: any;
		let renders = 0;
		let mounted!: () => void;
		let rendered!: () => void;
		const mounting = new Promise<void>((resolve) => { mounted = resolve; });
		const rendering = new Promise<void>((resolve) => { rendered = resolve; });
		const interactive = { ...ctx, hasUI: true, mode: "tui", ui: {
			notify: () => {},
			custom: async (factory: any) => {
				// A write between initial loading and mounting must be caught immediately.
				await runSessionOperation(owner, { action: "update", id: initial.task!.id, title: "After mount" });
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
		assert.match(component.render(120).join("\n"), /Ephemeral session/);
		assert(events.has("session_shutdown"));
		await events.get("session_shutdown")!({ type: "session_shutdown", reason: "new" }, interactive);
		await running;
		const count = renders;
		component.updateTasks([]);
		assert.equal(renders, count, "disposed screen ignores late updates");
		assert.deepEqual(await readdir(cwd), []);
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
