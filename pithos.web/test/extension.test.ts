import assert from "node:assert/strict";
import { describe, it } from "node:test";
import web from "../src/web.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

function createHarness(dependencies: Record<string, unknown> = {}) {
	const commands = new Map<string, any>();
	const messages: any[] = [];
	const tools = new Map<string, any>();
	web({
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		sendMessage(message: any) {
			messages.push(message);
		},
	} as never, dependencies as never);
	return { commands, messages, tools };
}

describe("Web extension", () => {
	it("registers both read-only tools without performing startup network I/O", () => {
		let calls = 0;
		const { tools } = createHarness({
			env: {},
			search: async () => { calls += 1; return []; },
			fetchResource: async () => { calls += 1; throw new Error("not expected"); },
		});

		assert.deepEqual([...tools.keys()], ["web_search", "web_fetch"]);
		assert.equal(calls, 0);
		for (const name of ["web_search", "web_fetch"]) {
			const tool = tools.get(name);
			assert.match(tool.description, /public web/i);
			assert.match(tool.promptGuidelines.join("\n"), /untrusted/i);
			assert.doesNotMatch(JSON.stringify(tool.parameters), /api.?key/i);
		}
	});

	it("describes web_search as unavailable and non-retriable when the Brave key is missing", () => {
		const { tools } = createHarness({ env: {} });
		const search = tools.get("web_search");
		const guidance = search.promptGuidelines.join("\n");

		assert.match(search.description, /unavailable/i);
		assert.match(search.description, /BRAVE_SEARCH_API_KEY/);
		assert.match(search.description, /\/web-setup/);
		assert.match(guidance, /do not (?:call|retry).*web_search/i);
		assert.match(guidance, /\/web-setup/);
		assert.match(guidance, /web_fetch.*(?:available|still works)/i);
	});

	it("registers /web-setup with secure local instructions when the Brave key is missing", async () => {
		let networkCalls = 0;
		const { commands } = createHarness({
			env: {},
			search: async () => { networkCalls += 1; return []; },
			fetchResource: async () => { networkCalls += 1; throw new Error("not expected"); },
		});
		const notices: string[] = [];

		await commands.get("web-setup").handler("", {
			hasUI: true,
			mode: "tui",
			ui: { notify: (message: string) => notices.push(message) },
		});

		assert.equal(networkCalls, 0);
		assert.match(notices.join("\n"), /BRAVE_SEARCH_API_KEY.*missing/is);
		assert.match(notices.join("\n"), /Bash.*read -rsp/is);
		assert.match(notices.join("\n"), /zsh.*read -s/is);
		assert.match(notices.join("\n"), /fish.*read --silent/is);
		assert.match(notices.join("\n"), /PowerShell 7.*Read-Host.*-MaskInput/is);
		assert.match(notices.join("\n"), /export BRAVE_SEARCH_API_KEY/);
		assert.doesNotMatch(notices.join("\n"), /(?:echo|Write-(?:Host|Output))[ \t]+[^\n]*BRAVE_SEARCH_API_KEY/i);
		assert.match(notices.join("\n"), /restart Pi/i);
		assert.match(notices.join("\n"), /https:\/\/api-dashboard\.search\.brave\.com\/register/);
		assert.match(notices.join("\n"), /https:\/\/api-dashboard\.search\.brave\.com\/app\/plans/);
		assert.match(notices.join("\n"), /https:\/\/api-dashboard\.search\.brave\.com\/app\/keys/);
		assert.match(notices.join("\n"), /never paste.*(?:chat|tool arguments)/i);
	});

	it("shows package-local /web-setup help without inspecting a remote service", async () => {
		let networkCalls = 0;
		const { commands } = createHarness({
			env: {},
			search: async () => { networkCalls += 1; return []; },
			fetchResource: async () => { networkCalls += 1; throw new Error("not expected"); },
		});
		const notices: string[] = [];

		await commands.get("web-setup").handler("--help", {
			hasUI: true,
			ui: { notify: (message: string) => notices.push(message) },
		});

		assert.equal(networkCalls, 0);
		assert.match(notices.join("\n"), /Usage: \/web-setup \[--help\]/);
		assert.match(notices.join("\n"), /local environment.*no network/i);
	});

	it("reports a configured Brave key from local presence without network validation or key disclosure", async () => {
		const secret = "sentinel-do-not-display";
		let networkCalls = 0;
		const { commands } = createHarness({
			env: { BRAVE_SEARCH_API_KEY: secret },
			search: async () => { networkCalls += 1; return []; },
			fetchResource: async () => { networkCalls += 1; throw new Error("not expected"); },
		});
		const notices: string[] = [];

		await commands.get("web-setup").handler("", {
			hasUI: true,
			mode: "rpc",
			ui: { notify: (message: string) => notices.push(message) },
		});

		const output = notices.join("\n");
		assert.equal(networkCalls, 0);
		assert.match(output, /BRAVE_SEARCH_API_KEY.*configured/is);
		assert.match(output, /no network request/i);
		assert.match(output, /web_search is available/i);
		assert.doesNotMatch(output, new RegExp(secret));
	});

	it("emits setup status through mode-appropriate print and JSON channels without exposing a key", async () => {
		for (const key of [undefined, "sentinel-do-not-display"]) {
			const writes: string[] = [];
			const env = key ? { BRAVE_SEARCH_API_KEY: key } : {};
			const printHarness = createHarness({
				env,
				writeOutput: (text: string) => writes.push(text),
			});
			await printHarness.commands.get("web-setup").handler("", {
				hasUI: false,
				mode: "print",
				ui: { notify: () => undefined },
			});
			assert.match(writes.join(""), key ? /BRAVE_SEARCH_API_KEY.*configured/is : /BRAVE_SEARCH_API_KEY.*missing/is);
			assert.doesNotMatch(writes.join(""), /sentinel-do-not-display/);

			const jsonHarness = createHarness({ env });
			await jsonHarness.commands.get("web-setup").handler("", {
				hasUI: false,
				mode: "json",
				ui: { notify: () => undefined },
			});
			assert.equal(jsonHarness.messages.length, 1);
			assert.equal(jsonHarness.messages[0].customType, "web-setup");
			assert.match(
				jsonHarness.messages[0].content,
				key ? /BRAVE_SEARCH_API_KEY.*configured/is : /BRAVE_SEARCH_API_KEY.*missing/is,
			);
			assert.doesNotMatch(JSON.stringify(jsonHarness.messages[0]), /sentinel-do-not-display/);
		}
	});

	it("marks both web tools unavailable in offline sessions with or without a key", async () => {
		for (const env of [
			{ PI_OFFLINE: "yes" },
			{ PI_OFFLINE: "yes", BRAVE_SEARCH_API_KEY: "sentinel-do-not-display" },
		]) {
			const { commands, tools } = createHarness({ env });
			const search = tools.get("web_search");
			assert.match(search.description, /PI_OFFLINE.*(?:disabled|unavailable)/i);
			assert.doesNotMatch(search.description, /web_fetch remains available/i);
			assert.match(search.promptGuidelines.join("\n"), /do not call.*web_search.*web_fetch/is);

			const notices: string[] = [];
			await commands.get("web-setup").handler("", {
				hasUI: true,
				mode: "tui",
				ui: { notify: (message: string) => notices.push(message) },
			});
			const output = notices.join("\n");
			assert.match(output, /PI_OFFLINE.*enabled/is);
			assert.match(output, /web_search and web_fetch.*disabled/is);
			assert.doesNotMatch(output, /web_search is available/i);
			assert.doesNotMatch(output, /web_fetch still works/i);
			assert.doesNotMatch(output, /sentinel-do-not-display/);
		}
	});

	it("explains secure setup when web_search has no Brave key without calling the search boundary", async () => {
		let calls = 0;
		const { tools } = createHarness({
			env: {},
			search: async () => { calls += 1; return []; },
		});

		await assert.rejects(
			tools.get("web_search").execute("call", { query: "pi" }),
			(error: Error) => {
				assert.match(error.message, /\/web-setup/);
				assert.match(error.message, /https:\/\/api-dashboard\.search\.brave\.com\/register/);
				assert.match(error.message, /https:\/\/api-dashboard\.search\.brave\.com\/app\/plans/);
				assert.match(error.message, /https:\/\/api-dashboard\.search\.brave\.com\/app\/keys/);
				assert.match(error.message, /restart Pi/i);
				assert.match(error.message, /web_fetch still works/i);
				assert.match(error.message, /never paste.*(?:chat|tool arguments)/i);
				return true;
			},
		);
		assert.equal(calls, 0);
	});

	it("keeps web_fetch usable without BRAVE_SEARCH_API_KEY", async () => {
		let calls = 0;
		const { tools } = createHarness({
			env: {},
			fetchResource: async () => {
				calls += 1;
				return {
					finalUrl: "https://example.com/",
					status: 200,
					contentType: "text/plain",
					body: "public page",
					bytes: 11,
					redirects: 0,
				};
			},
		});

		const result = await tools.get("web_fetch").execute("call", { url: "https://example.com/" });

		assert.equal(calls, 1);
		assert.match(result.content[0].text, /public page/);
	});

	it("shows a TUI searching indicator only while a web_search request is pending", async () => {
		const pending = deferred<any[]>();
		const statuses: Array<string | undefined> = [];
		let currentStatus: string | undefined;
		const { tools } = createHarness({
			env: { BRAVE_SEARCH_API_KEY: "super-secret-api-credential" },
			search: async () => pending.promise,
		});
		const execution = tools.get("web_search").execute(
			"call",
			{ query: "private query" },
			new AbortController().signal,
			undefined,
			{
				hasUI: true,
				mode: "tui",
				ui: {
					theme: { fg: (_color: string, text: string) => text },
					setStatus: (_key: string, value: string | undefined) => {
						currentStatus = value;
						statuses.push(value);
					},
				},
			},
		);

		assert.match(currentStatus ?? "", /searching for private query/i);
		assert.doesNotMatch(currentStatus ?? "", /super-secret-api-credential/i);
		pending.resolve([]);
		await execution;
		assert.equal(currentStatus, undefined);
		assert.equal(statuses.at(-1), undefined);
	});

	it("truncates long search text without splitting grapheme clusters in the TUI indicator", async () => {
		const pending = deferred<any[]>();
		const grapheme = "e\u0301";
		const query = `${grapheme.repeat(65)}DO-NOT-DISPLAY`;
		let currentStatus: string | undefined;
		const { tools } = createHarness({
			env: { BRAVE_SEARCH_API_KEY: "key" },
			search: async () => pending.promise,
		});
		const execution = tools.get("web_search").execute(
			"call",
			{ query },
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "tui",
				ui: {
					theme: { fg: (_color: string, text: string) => text },
					setStatus: (_key: string, value: string | undefined) => { currentStatus = value; },
				},
			},
		);

		assert.match(currentStatus ?? "", new RegExp(`searching for ${grapheme.repeat(64)}…$`, "u"));
		assert.doesNotMatch(currentStatus ?? "", /DO-NOT-DISPLAY/u);
		pending.resolve([]);
		await execution;
	});

	it("clears the searching indicator when a pending web_search is cancelled", async () => {
		const controller = new AbortController();
		let currentStatus: string | undefined;
		const { tools } = createHarness({
			env: { BRAVE_SEARCH_API_KEY: "key" },
			search: async (_query: string, options: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
				options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
			}),
		});
		const execution = tools.get("web_search").execute(
			"call",
			{ query: "pi" },
			controller.signal,
			undefined,
			{
				hasUI: true,
				mode: "tui",
				ui: {
					theme: { fg: (_color: string, text: string) => text },
					setStatus: (_key: string, value: string | undefined) => { currentStatus = value; },
				},
			},
		);

		assert.match(currentStatus ?? "", /searching for pi/i);
		controller.abort(new Error("cancelled"));
		await assert.rejects(execution, /cancelled/);
		assert.equal(currentStatus, undefined);
	});

	it("keeps the searching indicator until every parallel web_search request settles", async () => {
		const first = deferred<any[]>();
		const second = deferred<any[]>();
		let currentStatus: string | undefined;
		const { tools } = createHarness({
			env: { BRAVE_SEARCH_API_KEY: "key" },
			search: async (query: string) => query === "first" ? first.promise : second.promise,
		});
		const ctx = {
			hasUI: true,
			mode: "tui",
			ui: {
				theme: { fg: (_color: string, text: string) => text },
				setStatus: (_key: string, value: string | undefined) => { currentStatus = value; },
			},
		};
		const firstExecution = tools.get("web_search").execute("one", { query: "first" }, undefined, undefined, ctx);
		const secondExecution = tools.get("web_search").execute("two", { query: "second" }, undefined, undefined, ctx);

		assert.match(currentStatus ?? "", /searching for second/i);
		second.resolve([]);
		await secondExecution;
		assert.match(currentStatus ?? "", /searching for first/i);
		first.resolve([]);
		await firstExecution;
		assert.equal(currentStatus, undefined);
	});

	it("clears the searching indicator on failure and skips it before requests or outside the TUI", async () => {
		const statuses: Array<string | undefined> = [];
		let searchCalls = 0;
		const ctx = {
			hasUI: true,
			mode: "tui",
			ui: {
				theme: { fg: (_color: string, text: string) => text },
				setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			},
		};
		const failing = createHarness({
			env: { BRAVE_SEARCH_API_KEY: "key" },
			search: async () => {
				searchCalls += 1;
				throw new Error("provider failed");
			},
		});
		await assert.rejects(
			failing.tools.get("web_search").execute("call", { query: "pi" }, undefined, undefined, ctx),
			/provider failed/,
		);
		assert.equal(statuses.at(-1), undefined);
		const statusCountAfterRequest = statuses.length;

		const missing = createHarness({ env: {}, search: async () => { searchCalls += 1; return []; } });
		await assert.rejects(
			missing.tools.get("web_search").execute("call", { query: "pi" }, undefined, undefined, ctx),
			/BRAVE_SEARCH_API_KEY/,
		);
		const offline = createHarness({
			env: { BRAVE_SEARCH_API_KEY: "key", PI_OFFLINE: "1" },
			search: async () => { searchCalls += 1; return []; },
		});
		await assert.rejects(
			offline.tools.get("web_search").execute("call", { query: "pi" }, undefined, undefined, ctx),
			/PI_OFFLINE/,
		);
		await assert.rejects(
			failing.tools.get("web_search").execute("call", { query: "   " }, undefined, undefined, ctx),
			/non-empty query/,
		);
		await assert.rejects(
			failing.tools.get("web_search").execute("call", { query: "pi\u202e" }, undefined, undefined, ctx),
			/control characters/,
		);
		assert.equal(searchCalls, 1);
		assert.equal(statuses.length, statusCountAfterRequest);

		const noUiStatuses: Array<string | undefined> = [];
		const noUi = createHarness({ env: { BRAVE_SEARCH_API_KEY: "key" }, search: async () => [] });
		await noUi.tools.get("web_search").execute("call", { query: "pi" }, undefined, undefined, {
			hasUI: false,
			mode: "print",
			ui: { setStatus: (_key: string, value: string | undefined) => noUiStatuses.push(value) },
		});
		assert.deepEqual(noUiStatuses, []);
	});

	it("returns source-bearing Brave results inside an untrusted-content boundary", async () => {
		const { tools } = createHarness({
			env: { BRAVE_SEARCH_API_KEY: "key" },
			search: async () => [{
				title: "Pi docs",
				url: "https://pi.dev/docs",
				description: "Documentation",
			}],
		});

		const search = tools.get("web_search");
		assert.match(search.description, /Search the public web through the Brave Search API/);
		assert.doesNotMatch(search.description, /unavailable/i);
		assert.match(search.promptGuidelines.join("\n"), /Use web_search when current or external information/i);
		assert.doesNotMatch(search.promptGuidelines.join("\n"), /do not (?:call|retry)/i);

		const result = await search.execute(
			"call",
			{ query: "pi docs", count: 3 },
			new AbortController().signal,
		);

		assert.match(result.content[0].text, /BEGIN UNTRUSTED WEB SEARCH RESULTS/);
		assert.match(result.content[0].text, /Pi docs/);
		assert.match(result.content[0].text, /https:\/\/pi\.dev\/docs/);
		assert.match(result.content[0].text, /END UNTRUSTED WEB SEARCH RESULTS/);
		assert.deepEqual(result.details, {
			provider: "brave",
			query: "pi docs",
			resultCount: 1,
			results: [{ title: "Pi docs", url: "https://pi.dev/docs", description: "Documentation" }],
		});
	});

	it("keeps even adversarial search result fields below Pi's tool-output limit", async () => {
		const { tools } = createHarness({
			env: { BRAVE_SEARCH_API_KEY: "key" },
			search: async () => Array.from({ length: 10 }, (_, index) => ({
				title: `${index}-${"t".repeat(2_000)}`,
				url: `https://example.com/${"u".repeat(6_000)}`,
				description: "d".repeat(4_000),
			})),
		});

		const result = await tools.get("web_search").execute("call", { query: "large" }, new AbortController().signal);
		const output = result.content[0].text as string;
		assert.ok(Buffer.byteLength(output, "utf8") <= 50 * 1024);
		assert.match(output, /fields truncated/i);
		assert.match(output, /END UNTRUSTED WEB SEARCH RESULTS/);
	});

	it("keeps the complete fetched-page result within Pi's output limit", async () => {
		const { tools } = createHarness({
			fetchResource: async () => ({
				finalUrl: `https://example.com/${"u".repeat(20_000)}`,
				status: 200,
				contentType: "text/html",
				body: "unused",
				bytes: 2_000_000,
				redirects: 5,
			}),
			extractContent: () => ({
				text: "c".repeat(60_000),
				title: "t".repeat(20_000),
				mediaType: "text/html",
				truncated: true,
				omissions: ["HTML title exceeded the extraction budget"],
				totalBytes: 60_000,
				outputBytes: 60_000,
				totalLines: 1,
				outputLines: 1,
			}),
		});

		const result = await tools.get("web_fetch").execute("call", { url: "https://example.com" });
		const output = result.content[0].text as string;
		assert.ok(Buffer.byteLength(output, "utf8") <= 50 * 1024);
		assert.match(output, /Content truncated/i);
		assert.match(output, /HTML title exceeded the extraction budget/i);
		assert.match(output, /END UNTRUSTED WEB PAGE CONTENT/);
		assert.ok(result.details.omissions.includes("HTML title exceeded the extraction budget"));
	});

	it("renders structured HTML safety omissions outside a clipped page payload", async () => {
		const { tools } = createHarness({
			fetchResource: async () => ({
				finalUrl: "https://example.com/page",
				status: 200,
				contentType: "text/html",
				body: `<html><head><title>${"title".repeat(2_000)}</title></head><body>`
					+ `<a href="https://example.com/${"x".repeat(3_000)}">long link</a>`
					+ `<p>${"body ".repeat(20_000)}</p></body></html>`,
				bytes: 130_000,
				redirects: 0,
			}),
		});

		const result = await tools.get("web_fetch").execute("call", { url: "https://example.com/page" });
		const output = result.content[0].text as string;
		assert.ok(Buffer.byteLength(output, "utf8") <= 50 * 1024);
		assert.match(output, /HTML title exceeded the extraction budget/i);
		assert.match(output, /HTML link destination budget omitted links/i);
		assert.ok(output.lastIndexOf("Reasons:") > output.indexOf("END UNTRUSTED WEB PAGE CONTENT"));
	});

	it("formats fetched text, final-source metadata, and truncation details", async () => {
		const signal = new AbortController().signal;
		let receivedSignal: AbortSignal | undefined;
		const { tools } = createHarness({
			fetchResource: async (_url: string, options: { signal?: AbortSignal }) => {
				receivedSignal = options.signal;
				return {
					finalUrl: "https://example.com/final",
					status: 200,
					contentType: "text/plain",
					body: "page body",
					bytes: 9,
					redirects: 1,
				};
			},
			extractContent: () => ({
				text: "page body",
				title: "Example",
				mediaType: "text/plain",
				truncated: true,
				omissions: [],
				totalBytes: 100,
				outputBytes: 9,
				totalLines: 10,
				outputLines: 1,
			}),
		});

		const result = await tools.get("web_fetch").execute("call", { url: "https://example.com/start" }, signal);
		assert.equal(receivedSignal, signal);
		assert.match(result.content[0].text, /Source: https:\/\/example\.com\/final/);
		assert.match(result.content[0].text, /BEGIN UNTRUSTED WEB PAGE CONTENT/);
		assert.ok(
			result.content[0].text.indexOf("Title: Example") > result.content[0].text.indexOf("BEGIN UNTRUSTED WEB PAGE CONTENT"),
			"the untrusted page title must stay inside the content boundary",
		);
		assert.match(result.content[0].text, /Content truncated: 1 of 10 lines/);
		assert.equal(result.details.url, "https://example.com/final");
		assert.equal(result.details.truncated, true);
	});

	it("blocks both tools in offline mode without touching network boundaries", async () => {
		let calls = 0;
		const { tools } = createHarness({
			env: { PI_OFFLINE: "yes", BRAVE_SEARCH_API_KEY: "key" },
			search: async () => { calls += 1; return []; },
			fetchResource: async () => { calls += 1; throw new Error("unexpected"); },
		});

		await assert.rejects(tools.get("web_search").execute("call", { query: "pi" }), /PI_OFFLINE/);
		await assert.rejects(tools.get("web_fetch").execute("call", { url: "https://example.com" }), /PI_OFFLINE/);
		assert.equal(calls, 0);
	});
});
