import assert from "node:assert/strict";
import { Socket, type SocketConnectOpts } from "node:net";
import { describe, it } from "node:test";
import web from "../src/web.ts";
import { createBrokerFixture } from "./broker-fixture.ts";

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
	const handlers = new Map<string, any>();
	web({
		on(event: string, handler: any) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		sendMessage(message: any) {
			messages.push(message);
		},
	} as never, { env: {}, ...dependencies } as never);
	return {
		commands, messages, tools,
		async start(cwd: string, trusted = true) {
			await handlers.get("session_start")?.({ reason: "startup" }, { cwd, isProjectTrusted: () => trusted });
		},
	};
}

async function startedHarness(dependencies: Record<string, unknown> = {}) {
	const harness = createHarness(dependencies);
	await harness.start("/unused-test-project", false);
	return harness;
}

const unixBrokerOnly = { skip: process.platform === "win32" };

describe("Pithos host web search", () => {
	it("uses the existing web_search wire contract and returns bounded Brave results", unixBrokerOnly, async (t) => {
		const broker = await createBrokerFixture(t, (request, socket) => {
			socket.end(JSON.stringify({
				ok: true,
				provider: "brave",
				results: [
					{ title: "bad scheme", url: "javascript:void(0)", description: "discard" },
					{ title: "credentials", url: "https://user:pass@example.com/", description: "discard" },
					{ title: "long link", url: `https://example.com/${"x".repeat(2_048)}`, description: "discard" },
					{ title: "<b>Pi</b> &amp; docs", url: "https://example.org", description: `left\u202eright\n${"😀".repeat(500)}`, extra: "discard" },
					{ title: "More", url: "https://example.net", description: "" },
				],
				ignored: (request as { token: string }).token,
			}) + "\n");
		});
		let keyReads = 0;
		const { commands, tools } = await startedHarness({
			env: {
				...broker.env,
				get BRAVE_SEARCH_API_KEY() { keyReads += 1; return "synthetic-brave-key"; },
				get KEENABLE_API_KEY() { keyReads += 1; return "synthetic-keenable-key"; },
			},
			search: async () => assert.fail("Pithos must not use standalone Brave"),
		});

		assert.deepEqual([...tools.keys()], ["web_search", "web_fetch"]);
		assert.deepEqual([...commands.keys()], ["web-setup"]);
		assert.equal(broker.accepted, 0);
		const tool = tools.get("web_search");
		assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["count", "query"]);
		assert.deepEqual(Object.keys(tools.get("web_fetch").parameters.properties), ["url"]);
		assert.equal(tool.parameters.additionalProperties, false);
		const result = await tool.execute("call", { query: "  pi docs  ", count: 1 });
		assert.equal(keyReads, 0);
		assert.deepEqual(broker.requests, [{
			version: 1, token: broker.env.PITHOS_WEB_SEARCH_TOKEN, operation: "search", query: "pi docs", count: 1,
		}]);
		assert.equal(result.details.provider, "brave");
		assert.equal(result.details.resultCount, 1);
		assert.equal(result.details.results[0].title, "Pi & docs");
		assert.equal(result.details.results[0].url, "https://example.org/");
		assert.match(result.details.results[0].description, /^left\[U\+202E\]right /);
		assert.ok(Buffer.byteLength(result.details.results[0].description, "utf8") <= 1_024);
		assert.doesNotMatch(JSON.stringify(result), /discard|synthetic-(?:brave|keenable)-key/);
		assert.ok(!JSON.stringify(result).includes(broker.env.PITHOS_WEB_SEARCH_TOKEN));
		assert.match(result.content[0].text, /^Brave Search results/);
		assert.match(result.content[0].text, /BEGIN UNTRUSTED WEB SEARCH RESULTS[\s\S]+END UNTRUSTED WEB SEARCH RESULTS/);
	});

	it("uses the fixed Docker Desktop hostname and accepts new host provider IDs", async (t) => {
		const broker = await createBrokerFixture(t, (_request, socket) => {
			socket.end(JSON.stringify({ ok: true, provider: "fixture-search", results: [] }) + "\n");
		}, "tcp");
		assert.ok(broker.port);
		const port = broker.port;
		const connect: (this: Socket, options: SocketConnectOpts) => Socket = Socket.prototype.connect;
		// Stand in for Docker Desktop DNS while still using a real loopback socket.
		const dial = t.mock.method(Socket.prototype, "connect", function(this: Socket, _endpoint: unknown) {
			return connect.call(this, { host: "127.0.0.1", port });
		});
		const { tools } = createHarness({ env: { ...broker.env, PITHOS_WEB_SEARCH_HOST: "not-the-broker.invalid" } });
		const result = await tools.get("web_search").execute("call", { query: "pi", count: 10 });
		assert.deepEqual(dial.mock.calls.map((call) => call.arguments), [[{ host: "host.docker.internal", port }]]);
		assert.deepEqual(broker.requests, [{
			version: 1, token: broker.env.PITHOS_WEB_SEARCH_TOKEN, operation: "search", query: "pi", count: 10,
		}]);
		assert.equal(result.details.provider, "fixture-search");
		assert.match(result.content[0].text, /^fixture-search.*results/i);
	});

	it("fails closed without even reading visible provider keys and leaves fetch available", unixBrokerOnly, async (t) => {
		const broker = await createBrokerFixture(t, (_request, socket) => socket.end());
		let keyReads = 0;
		let directCalls = 0;
		for (const override of [
			{ PITHOS_WEB_SEARCH_STATUS: "unconfigured" },
			{ PITHOS_WEB_SEARCH_STATUS: "unavailable" },
			{ PITHOS_WEB_SEARCH_STATUS: "" },
			{ PITHOS_WEB_SEARCH_STATUS: "malformed-status" },
			{ PITHOS_WEB_SEARCH_TOKEN: undefined },
			{ PITHOS_WEB_SEARCH_TOKEN: "AA".repeat(32) },
			{ PITHOS_WEB_SEARCH_SOCKET: undefined },
			{ PITHOS_WEB_SEARCH_SOCKET: "relative.sock" },
			{ PITHOS_WEB_SEARCH_PORT: "9876" },
			{ PITHOS_WEB_SEARCH_SOCKET: undefined, PITHOS_WEB_SEARCH_PORT: "1e3" },
			{ PITHOS_WEB_SEARCH_SOCKET: undefined, PITHOS_WEB_SEARCH_PORT: "65536" },
			{ PITHOS_WEB_SEARCH_SOCKET: `${broker.env.PITHOS_WEB_SEARCH_SOCKET}.missing` },
		]) {
			const { commands, messages, tools } = createHarness({
				env: {
					...broker.env,
					...override,
					get BRAVE_SEARCH_API_KEY() { keyReads += 1; return "synthetic-key"; },
					get KEENABLE_API_KEY() { keyReads += 1; return "synthetic-key"; },
				},
				search: async () => { directCalls += 1; return []; },
				fetchResource: async () => ({
					finalUrl: "https://example.com/", status: 200, contentType: "text/plain",
					body: "public page", bytes: 11, redirects: 0,
				}),
			});
			await commands.get("web-setup").handler("", { hasUI: false, mode: "json" });
			await assert.rejects(tools.get("web_search").execute("call", { query: "pi" }), /Pithos host web search.*(?:unavailable|not configured)/i);
			assert.equal(keyReads, 0);
			assert.equal(directCalls, 0);
			assert.equal(messages[0].details.configured, false);
			assert.match(messages[0].content, /\$HOME\/\.config\/pithos\/web\/\.env/);
			assert.match(messages[0].content, /PITHOS_WEB_SEARCH_PROVIDER=brave with BRAVE_SEARCH_API_KEY/);
			assert.match(messages[0].content, /PITHOS_WEB_SEARCH_PROVIDER=keenable with KEENABLE_API_KEY/);
			assert.match(messages[0].content, /restart Pithos/i);
			assert.doesNotMatch(messages[0].content, /export|keyless|synthetic-key|malformed-status|\.missing/);
			const fetched = await tools.get("web_fetch").execute("call", { url: "https://example.com" });
			assert.match(fetched.content[0].text, /public page/);
		}
		assert.equal(broker.accepted, 0);
	});

	it("checks Keenable readiness with only a status request and uses a default of five search results", unixBrokerOnly, async (t) => {
		const broker = await createBrokerFixture(t, (request, socket) => {
			const { operation } = request as { operation: string };
			socket.end(JSON.stringify(operation === "status"
				? { ok: true, provider: "keenable", message: "do-not-display" }
				: { ok: true, provider: "keenable", results: Array.from({ length: 8 }, (_, index) => ({
					title: `Page ${index}`, url: `https://example.com/${index}`, description: "An excerpt",
				})) }) + "\n");
		});
		const { commands, messages, tools } = createHarness({ env: broker.env });
		const setup = commands.get("web-setup");
		const ctx = { hasUI: false, mode: "json" };
		await setup.handler("--help", ctx);
		assert.match(messages[0].content, /Usage: \/web-setup/);
		assert.match(messages[0].content, /On the host.*\.env/);
		assert.doesNotMatch(messages[0].content, /export|keyless/);
		assert.equal(broker.accepted, 0);

		await setup.handler("", ctx);
		assert.deepEqual(broker.requests, [{ version: 1, token: broker.env.PITHOS_WEB_SEARCH_TOKEN, operation: "status" }]);
		assert.deepEqual(messages[1].details, { configured: true, offline: false, networkValidated: false, provider: "keenable" });
		assert.match(messages[1].content, /configured.*keenable/i);
		assert.match(messages[1].content, /not validated.*no search query/is);
		assert.doesNotMatch(messages[1].content, /do-not-display/);
		assert.ok(!JSON.stringify(messages).includes(broker.env.PITHOS_WEB_SEARCH_TOKEN));

		const result = await tools.get("web_search").execute("call", { query: "pi" });
		assert.deepEqual(broker.requests[1], { version: 1, token: broker.env.PITHOS_WEB_SEARCH_TOKEN, operation: "search", query: "pi" });
		assert.equal(result.details.provider, "keenable");
		assert.equal(result.details.results.length, 5);
		assert.match(result.content[0].text, /BEGIN UNTRUSTED WEB SEARCH RESULTS[\s\S]+An excerpt[\s\S]+END UNTRUSTED WEB SEARCH RESULTS/);
	});

	it("does not send invalid queries or counts to the broker", unixBrokerOnly, async (t) => {
		const broker = await createBrokerFixture(t, (_request, socket) => socket.end());
		const { tools } = createHarness({ env: broker.env });
		const search = tools.get("web_search");
		for (const count of [0, 11, 1.5]) {
			await assert.rejects(search.execute("call", { query: "pi", count }), /count must be an integer between 1 and 10/);
		}
		for (const [query, expected] of [["  ", /non-empty query/], ["x".repeat(501), /500 characters/], ["pi\nsearch", /control characters/]] as const) {
			await assert.rejects(search.execute("call", { query }), expected);
		}
		assert.equal(broker.accepted, 0);
	});

	it("disables both web tools and skips readiness checks for either offline signal", unixBrokerOnly, async (t) => {
		const broker = await createBrokerFixture(t, (_request, socket) => socket.end());
		let fetchCalls = 0;
		for (const override of [{ PITHOS_WEB_SEARCH_STATUS: "offline" }, { PI_OFFLINE: " yes " }]) {
			const { commands, messages, tools } = createHarness({
				env: { ...broker.env, ...override },
				fetchResource: async () => { fetchCalls += 1; throw new Error("unexpected fetch"); },
			});
			await commands.get("web-setup").handler("", { hasUI: false, mode: "json" });
			assert.equal(messages[0].details.offline, true);
			assert.match(messages[0].content, /web_search and web_fetch are disabled/);
			assert.match(messages[0].content, /restart Pithos in an online session/i);
			assert.match(tools.get("web_search").description, /unavailable.*(?:offline|PI_OFFLINE)/i);
			assert.match(tools.get("web_fetch").description, /unavailable.*(?:offline|PI_OFFLINE)/i);
			await assert.rejects(tools.get("web_search").execute("call", { query: "pi" }), /disabled.*(?:offline|PI_OFFLINE)/i);
			await assert.rejects(tools.get("web_fetch").execute("call", { url: "https://example.com" }), /disabled.*(?:offline|PI_OFFLINE)/i);
		}
		assert.equal(broker.accepted, 0);
		assert.equal(fetchCalls, 0);
	});

	it("maps only recognized broker error codes to safe guidance without retrying", unixBrokerOnly, async (t) => {
		const broker = await createBrokerFixture(t, (request, socket) => {
			const { query } = request as { query?: string };
			socket.end(JSON.stringify({
				ok: false, error: query ?? "unauthorized", message: "upstream-private-diagnostic",
				provider: "also-private", token: "do-not-display",
			}) + "\n");
		});
		let directCalls = 0;
		const { commands, messages, tools } = createHarness({
			env: { ...broker.env, BRAVE_SEARCH_API_KEY: "synthetic-key" },
			search: async () => { directCalls += 1; return []; },
		});
		const errorCases = [
			["credential_rejected", /rejected.*credential/i],
			["quota_exhausted", /insufficient funds.*quota/i],
			["rate_limited", /rate limit/i],
			["timeout", /timed out/i],
			["url_query", /URL-only.*web_fetch/i],
			["invalid_query", /invalid.*query/i],
			["invalid_request", /invalid.*request/i],
			["provider_unavailable", /provider.*unavailable/i],
			["invalid_response", /invalid response/i],
			["upstream_rejected", /provider rejected the request/i],
			["unavailable", /host web search.*unavailable/i],
			["offline", /host web search.*offline/i],
			["unauthorized", /did not authorize/i],
			["unknown-private-code", /invalid response/i],
			["constructor", /invalid response/i],
		] as const;
		const search = tools.get("web_search");
		for (const [code, expected] of errorCases) {
			await assert.rejects(search.execute("call", { query: code }), (error: Error) => {
				assert.match(error.message, expected);
				assert.doesNotMatch(error.message, /private|do-not-display|synthetic-key/);
				assert.equal(error.cause, undefined);
				return true;
			});
		}
		await commands.get("web-setup").handler("", { hasUI: false, mode: "json" });
		assert.equal(messages[0].details.configured, false);
		assert.match(messages[0].content, /did not authorize/i);
		assert.match(messages[0].content, /restart Pithos/i);
		assert.doesNotMatch(messages[0].content, /upstream-private-diagnostic|do-not-display/);
		assert.equal(directCalls, 0);
		assert.equal(broker.requests.length, errorCases.length + 1);
	});

	it("accepts only one complete bounded UTF-8 response frame", unixBrokerOnly, async (t) => {
		const good = JSON.stringify({ ok: true, provider: "brave", results: [] });
		const maxBytes = 64 * 1024;
		const replies: Record<string, string | Buffer> = {
			"two frames": `${good}\n${good}\n`,
			"no newline": good,
			"invalid JSON": '{"diagnostic":"do-not-display"\n',
			"invalid UTF-8": Buffer.concat([
				Buffer.from(`${good.slice(0, -1)},"message":"`), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n'),
			]),
			"bad provider": JSON.stringify({ ok: true, provider: "brave\ndo-not-display", results: [] }) + "\n",
			"bad results": JSON.stringify({ ok: true, provider: "brave", results: "do-not-display" }) + "\n",
			"oversized": JSON.stringify({ ok: true, provider: "brave", results: [], padding: "😀".repeat(maxBytes / 4) }) + "\n",
			"at limit": good + " ".repeat(maxBytes - Buffer.byteLength(good) - 1) + "\n",
		};
		const broker = await createBrokerFixture(t, (request, socket) => {
			const { query } = request as { query: string };
			const reply = Buffer.from(replies[query]);
			const split = Math.floor(reply.length / 2);
			socket.write(reply.subarray(0, split));
			setImmediate(() => socket.end(reply.subarray(split)));
		});
		const { tools } = createHarness({ env: broker.env });
		const search = tools.get("web_search");
		for (const query of Object.keys(replies).filter((key) => key !== "at limit")) {
			await assert.rejects(search.execute("call", { query }), (error: Error) => {
				assert.match(error.message, query === "oversized" ? /64 KiB limit/i : /invalid response/i);
				assert.doesNotMatch(error.message, /do-not-display/);
				assert.equal(error.cause, undefined);
				return true;
			}, query);
		}
		const result = await search.execute("call", { query: "at limit" });
		assert.equal(result.details.provider, "brave");
		assert.equal(result.details.resultCount, 0);
	});

	it("times out a stalled readiness probe and closes its socket", { ...unixBrokerOnly, timeout: 4_000 }, async (t) => {
		const closed = deferred<void>();
		const broker = await createBrokerFixture(t, (_request, socket) => {
			socket.once("close", () => closed.resolve());
		});
		const { commands, messages } = createHarness({ env: broker.env });
		await commands.get("web-setup").handler("", { hasUI: false, mode: "json" });
		assert.equal(messages[0].details.configured, false);
		assert.match(messages[0].content, /timed out/i);
		assert.deepEqual(broker.requests, [{ version: 1, token: broker.env.PITHOS_WEB_SEARCH_TOKEN, operation: "status" }]);
		await closed.promise;
	});

	it("cancels broker searches without leaving a socket and clears the TUI status", { ...unixBrokerOnly, timeout: 4_000 }, async (t) => {
		const received = deferred<void>();
		const closed = deferred<void>();
		const reply = JSON.stringify({ ok: true, provider: "brave", results: [] }) + "\n";
		const broker = await createBrokerFixture(t, (request, socket) => {
			if ((request as { query: string }).query === "not started") {
				socket.end(reply);
				return;
			}
			const fallback = setTimeout(() => socket.end(reply), 500);
			socket.once("close", () => { clearTimeout(fallback); closed.resolve(); });
			received.resolve();
		});
		const { tools } = createHarness({ env: broker.env });
		const search = tools.get("web_search");
		const abortReason = new Error("do-not-display");
		await assert.rejects(search.execute("pre", { query: "not started" }, AbortSignal.abort(abortReason)), /cancelled/i);
		assert.equal(broker.accepted, 0);

		const controller = new AbortController();
		controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
		let status: string | undefined;
		const execution = search.execute("call", { query: "waiting" }, controller.signal, undefined, {
			hasUI: true,
			mode: "tui",
			ui: {
				theme: { fg: (_color: string, text: string) => text },
				setStatus: (_key: string, value: string | undefined) => { status = value; },
			},
		});
		const rejected = assert.rejects(execution, (error: Error) => {
			assert.match(error.message, /cancelled/i);
			assert.doesNotMatch(error.message, /do-not-display/);
			assert.equal(error.cause, undefined);
			return true;
		});
		await received.promise;
		assert.match(status ?? "", /searching for waiting/i);
		controller.abort(abortReason);
		await rejected;
		await closed.promise;
		assert.equal(status, undefined);
	});
});

describe("Web extension", () => {
	it("registers both read-only tools without performing startup network I/O", async () => {
		let calls = 0;
		const { tools } = await startedHarness({
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

	it("describes web_search as unavailable and non-retriable when the Brave key is missing", async () => {
		const { tools } = await startedHarness({ env: {} });
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
		const { commands } = await startedHarness({
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
		const { commands } = await startedHarness({
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
		const { commands } = await startedHarness({
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
			const printHarness = await startedHarness({
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

			const jsonHarness = await startedHarness({ env });
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
			const { commands, tools } = await startedHarness({ env });
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
		const { tools } = await startedHarness({
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
		const { tools } = await startedHarness({
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
		const { tools } = await startedHarness({
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
		const { tools } = await startedHarness({
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
		const { tools } = await startedHarness({
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
		const failing = await startedHarness({
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

		const missing = await startedHarness({ env: {}, search: async () => { searchCalls += 1; return []; } });
		await assert.rejects(
			missing.tools.get("web_search").execute("call", { query: "pi" }, undefined, undefined, ctx),
			/BRAVE_SEARCH_API_KEY/,
		);
		const offline = await startedHarness({
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
		const noUi = await startedHarness({ env: { BRAVE_SEARCH_API_KEY: "key" }, search: async () => [] });
		await noUi.tools.get("web_search").execute("call", { query: "pi" }, undefined, undefined, {
			hasUI: false,
			mode: "print",
			ui: { setStatus: (_key: string, value: string | undefined) => noUiStatuses.push(value) },
		});
		assert.deepEqual(noUiStatuses, []);
	});

	it("uses standalone Brave without a launch marker and frames results as untrusted", async () => {
		const signal = new AbortController().signal;
		const { tools } = await startedHarness({
			env: {
				BRAVE_SEARCH_API_KEY: "standalone-key",
				PITHOS_WEB_SEARCH_SOCKET: "/unused-without-launch-marker",
				get WEB_SEARCH_PROVIDER() { return assert.fail("provider selection belongs to the host"); },
				get KEENABLE_API_KEY() { return assert.fail("Pi must not read a Keenable key"); },
			},
			search: async (query: string, options: unknown) => {
				assert.equal(query, "pi docs");
				assert.deepEqual(options, { apiKey: "standalone-key", count: 3, signal });
				return [{ title: "Pi docs", url: "https://pi.dev/docs", description: "Documentation" }];
			},
		});

		const search = tools.get("web_search");
		assert.match(search.description, /Search the public web through the Brave Search API/);
		assert.doesNotMatch(search.description, /unavailable/i);
		assert.match(search.promptGuidelines.join("\n"), /Use web_search when current or external information/i);
		assert.doesNotMatch(search.promptGuidelines.join("\n"), /do not (?:call|retry)/i);

		const result = await search.execute(
			"call",
			{ query: "pi docs", count: 3 },
			signal,
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
		const { tools } = await startedHarness({
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
		const { tools } = await startedHarness({
			env: { PI_OFFLINE: "yes", BRAVE_SEARCH_API_KEY: "key" },
			search: async () => { calls += 1; return []; },
			fetchResource: async () => { calls += 1; throw new Error("unexpected"); },
		});

		await assert.rejects(tools.get("web_search").execute("call", { query: "pi" }), /PI_OFFLINE/);
		await assert.rejects(tools.get("web_fetch").execute("call", { url: "https://example.com" }), /PI_OFFLINE/);
		assert.equal(calls, 0);
	});
});
