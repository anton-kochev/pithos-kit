import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchBrave } from "../src/brave-search.ts";

describe("Brave Search client", () => {
	it("calls only the fixed Brave endpoint with an encoded query and credential header", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetcher: typeof fetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return new Response(JSON.stringify({
				web: {
					results: [
						{ title: "Pi docs", url: "https://pi.dev/docs?q=1", description: "Current documentation" },
					],
				},
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const results = await searchBrave("pi extensions & tools", {
			apiKey: "brave-secret",
			count: 50,
			fetch: fetcher,
		});

		assert.equal(calls.length, 1);
		const url = new URL(calls[0]!.url);
		assert.equal(url.origin + url.pathname, "https://api.search.brave.com/res/v1/web/search");
		assert.equal(url.searchParams.get("q"), "pi extensions & tools");
		assert.equal(url.searchParams.get("count"), "10");
		assert.equal(new Headers(calls[0]!.init?.headers).get("x-subscription-token"), "brave-secret");
		assert.deepEqual(results, [{
			title: "Pi docs",
			url: "https://pi.dev/docs?q=1",
			description: "Current documentation",
		}]);
	});

	it("turns Brave result decorations and entities into plain text", async () => {
		const results = await searchBrave("pi", {
			apiKey: "key",
			fetch: async () => new Response(JSON.stringify({
				web: { results: [{
					title: "<strong>Pi</strong> &amp; tools",
					url: "https://pi.dev/",
					description: "Build &lt;safe&gt; extensions",
				}] },
			}), { status: 200, headers: { "content-type": "application/json" } }),
		});

		assert.deepEqual(results, [{
			title: "Pi & tools",
			url: "https://pi.dev/",
			description: "Build <safe> extensions",
		}]);
	});

	it("renders Unicode direction controls visibly in result text", async () => {
		const results = await searchBrave("pi", {
			apiKey: "key",
			fetch: async () => new Response(JSON.stringify({
				web: { results: [{
					title: "safe\u202eevil",
					url: "https://pi.dev/",
					description: "left\u2066right\u2069",
				}] },
			}), { status: 200, headers: { "content-type": "application/json" } }),
		});

		assert.equal(results[0]?.title, "safe[U+202E]evil");
		assert.equal(results[0]?.description, "left[U+2066]right[U+2069]");
	});

	it("requires a bounded non-empty query and an API key before fetching", async () => {
		let calls = 0;
		const fetcher: typeof fetch = async () => {
			calls += 1;
			return new Response();
		};
		await assert.rejects(searchBrave("", { apiKey: "key", fetch: fetcher }), /non-empty query/i);
		await assert.rejects(searchBrave("x".repeat(501), { apiKey: "key", fetch: fetcher }), /500 characters/i);
		await assert.rejects(searchBrave("pi\u001b[31m", { apiKey: "key", fetch: fetcher }), /control characters/i);
		await assert.rejects(searchBrave("pi\u202e", { apiKey: "key", fetch: fetcher }), /control characters/i);
		await assert.rejects(searchBrave("pi", { fetch: fetcher }), /BRAVE_SEARCH_API_KEY/);
		assert.equal(calls, 0);
	});

	it("filters malformed and non-HTTP results and respects the requested result count", async () => {
		const results = await searchBrave("pi", {
			apiKey: "key",
			count: 2,
			fetch: async () => new Response(JSON.stringify({
				web: { results: [
					{ title: "", url: "https://empty.example/" },
					{ title: "FTP", url: "ftp://files.example/" },
					{ title: "One", url: "https://one.example/", description: "first" },
					{ title: "Two", url: "http://two.example/" },
					{ title: "Three", url: "https://three.example/" },
				] },
			}), { status: 200, headers: { "content-type": "application/json" } }),
		});

		assert.deepEqual(results.map(({ title }) => title), ["One", "Two"]);
	});

	it("bounds every persisted result field and skips unusably long source URLs", async () => {
		const results = await searchBrave("pi", {
			apiKey: "key",
			fetch: async () => new Response(JSON.stringify({
				web: { results: [
					{ title: "long URL", url: `https://example.com/${"u".repeat(2_100)}`, description: "skip" },
					{ title: "😀".repeat(200), url: "https://pi.dev/", description: "d".repeat(2_000) },
				] },
			}), { status: 200, headers: { "content-type": "application/json" } }),
		});

		assert.equal(results.length, 1);
		assert.ok(Buffer.byteLength(results[0]!.title, "utf8") <= 512);
		assert.ok(Buffer.byteLength(results[0]!.description, "utf8") <= 1_024);
		assert.ok(Buffer.byteLength(results[0]!.url, "utf8") <= 2_048);
	});

	it("maps Brave 401 and 403 responses to rejected-credential or inactive-plan guidance", async () => {
		for (const status of [401, 403]) {
			const secret = `secret-${status}`;
			const upstreamBody = `upstream-body-${status}`;
			await assert.rejects(
				searchBrave("pi", {
					apiKey: secret,
					fetch: async () => new Response(upstreamBody, { status }),
				}),
				(error: Error) => {
					assert.match(error.message, /rejected.*credential/i);
					assert.match(error.message, /inactive.*Search plan/i);
					assert.match(error.message, /https:\/\/api-dashboard\.search\.brave\.com\/app\/keys/);
					assert.match(error.message, /https:\/\/api-dashboard\.search\.brave\.com\/app\/plans/);
					assert.doesNotMatch(error.message, new RegExp(secret));
					assert.doesNotMatch(error.message, new RegExp(upstreamBody));
					return true;
				},
			);
		}
	});

	it("bounds JSON responses and sanitizes upstream failures", async () => {
		await assert.rejects(
			searchBrave("pi", {
				apiKey: "secret-key",
				maxResponseBytes: 5,
				fetch: async () => new Response("upstream secret", {
					status: 200,
					headers: { "content-type": "application/json", "content-length": "100" },
				}),
			}),
			/5-byte limit/i,
		);
		await assert.rejects(
			searchBrave("pi", {
				apiKey: "secret-key",
				fetch: async () => new Response("upstream secret", { status: 429 }),
			}),
			(error: Error) => /quota.*rate limit|rate limit.*quota/i.test(error.message)
				&& /https:\/\/api-dashboard\.search\.brave\.com\/app\/plans/.test(error.message)
				&& /wait|plan/i.test(error.message)
				&& !error.message.includes("secret-key")
				&& !error.message.includes("upstream secret"),
		);
	});

	it("applies timeouts even when the fetch implementation ignores its signal", async () => {
		await assert.rejects(
			searchBrave("pi", {
				apiKey: "key",
				fetch: async () => new Promise(() => {}),
				timeoutMs: 5,
			}),
			/timed out/i,
		);
	});
});
