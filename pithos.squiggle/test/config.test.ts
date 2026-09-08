import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { registerSquiggle } from "../extensions/index.ts";
const CONFIG_DIR_NAME = ".pi";

// Behaviors: project-only save, exact model use, cancellation, unavailable auth,
// invalid files, headless use, reload, and visible environment overrides.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function harness(answers: Array<string | undefined> = ["test/nested/model — Test"]) {
	const cwd = mkdtempSync(join(tmpdir(), "squiggle-config-"));
	roots.push(cwd);
	const commands = new Map<string, any>();
	const events = new Map<string, any>();
	const entries: any[] = [];
	const notices: string[] = [];
	const prompts: string[][] = [];
	const configs: any[] = [];
	const model = { provider: "test", id: "nested/model", name: "Test" };
	const ctx = {
		cwd, hasUI: true,
		sessionManager: { getEntries: () => entries, getBranch: () => entries },
		modelRegistry: { getAvailable: () => [model], hasConfiguredAuth: () => true, find: () => model },
		ui: {
			select: async (_title: string, choices: string[]) => { prompts.push(choices); return answers.shift(); },
			notify: (text: string) => notices.push(text),
			setStatus() {}, theme: { fg: (_color: string, text: string) => text },
		},
	};
	registerSquiggle({
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: any) => events.set(name, handler),
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
	} as never, async (_text, _ctx, config) => { configs.push(config); return null; });
	return { ctx, entries, notices, prompts, configs,
		command: (args: string) => commands.get("squiggle").handler(args, ctx),
		input: () => events.get("input")({ source: "interactive", text: "hello" }, ctx),
		start: () => events.get("session_start")({ reason: "reload" }, ctx),
	};
}

it("opens the model picker directly, saves only to the project, and survives reload", async () => {
	const h = harness();
	await h.command("config");
	await h.start();
	await h.input();
	assert.equal(h.configs[0].model, "test/nested/model");
	assert.deepEqual(h.prompts, [["test/nested/model — Test"]]);
	assert.equal(h.notices.at(-1), "Saved test/nested/model. squiggle is on (test/nested/model).");
	assert.equal(h.entries.length, 0);
	assert.equal(JSON.parse(readFileSync(join(h.ctx.cwd, CONFIG_DIR_NAME, "squiggle.json"), "utf8")).model, "test/nested/model");
});

it("saves a project model without changing existing limits, mode or other fields", async () => {
	const h = harness();
	const path = join(h.ctx.cwd, CONFIG_DIR_NAME, "squiggle.json");
	mkdirSync(join(h.ctx.cwd, CONFIG_DIR_NAME));
	writeFileSync(path, JSON.stringify({ mode: "on", timeoutMs: 15000, maxInputChars: 123, extra: true }));
	await h.command("config");
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		mode: "on", timeoutMs: 15000, maxInputChars: 123, extra: true, model: "test/nested/model",
	});
	await h.input();
	assert.equal(h.configs[0].model, "test/nested/model");
	assert.equal(h.configs[0].timeoutMs, 15000);
});

it("ignores user and session model settings and reports environment overrides", async () => {
	const h = harness();
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousModel = process.env.SQUIGGLE_MODEL;
	process.env.PI_CODING_AGENT_DIR = join(h.ctx.cwd, "agent");
	delete process.env.SQUIGGLE_MODEL;
	try {
		mkdirSync(process.env.PI_CODING_AGENT_DIR);
		writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "squiggle.json"), JSON.stringify({ model: "user/model" }));
		h.entries.push({ type: "custom", customType: "squiggle-model", data: { model: "session/model" } });
		await h.start();
		await h.input();
		assert.equal(h.configs.at(-1).model, "openai-codex/gpt-5.4-mini");
		mkdirSync(join(h.ctx.cwd, CONFIG_DIR_NAME));
		writeFileSync(join(h.ctx.cwd, CONFIG_DIR_NAME, "squiggle.json"), JSON.stringify({ model: "project/model" }));
		await h.input();
		assert.equal(h.configs.at(-1).model, "project/model");
		process.env.SQUIGGLE_MODEL = "env/model";
		await h.input();
		assert.equal(h.configs.at(-1).model, "env/model");
		await h.command("config");
		assert.match(h.notices.at(-1)!, /Saved test\/nested\/model\./);
		assert.match(h.notices.at(-1)!, /env\/model.*SQUIGGLE_MODEL/);
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
		if (previousModel === undefined) delete process.env.SQUIGGLE_MODEL; else process.env.SQUIGGLE_MODEL = previousModel;
	}
});

it("cancelling the picker changes no session state or project files", async () => {
	const h = harness([undefined]);
	await h.command("config");
	assert.equal(h.entries.length, 0);
	assert.equal(existsSync(join(h.ctx.cwd, CONFIG_DIR_NAME)), false);
});

it("filters unauthenticated models and explains when none remain", async () => {
	const h = harness();
	h.ctx.modelRegistry.hasConfiguredAuth = () => false;
	await h.command("config");
	assert.equal(h.prompts.length, 0);
	assert.equal(h.entries.length, 0);
	assert.match(h.notices.at(-1)!, /No authenticated.*\/login/);
});

it("refuses to overwrite malformed project configuration", async () => {
	const h = harness();
	const path = join(h.ctx.cwd, CONFIG_DIR_NAME, "squiggle.json");
	mkdirSync(join(h.ctx.cwd, CONFIG_DIR_NAME));
	writeFileSync(path, "{broken");
	await h.command("config");
	assert.equal(readFileSync(path, "utf8"), "{broken");
	assert.equal(h.entries.length, 0);
	assert.match(h.notices.at(-1)!, /Could not save/);
});

it("does not open a picker without a UI", async (t) => {
	const output: string[] = [];
	t.mock.method(console, "log", (text: string) => output.push(text));
	const h = harness();
	h.ctx.hasUI = false;
	await h.command("config");
	assert.equal(h.prompts.length, 0);
	assert.equal(h.entries.length, 0);
	assert.match(output[0], /requires an interactive UI/);
});
