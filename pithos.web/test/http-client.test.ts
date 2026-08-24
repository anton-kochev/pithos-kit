import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPinnedLookup, fetchPublicResource, type PublicRequestTransport } from "../src/http-client.ts";
import type { DnsLookup } from "../src/network-policy.ts";

const addresses: Record<string, { address: string; family: 4 | 6 }> = {
	"start.example": { address: "93.184.216.34", family: 4 },
	"final.example": { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
};

const lookup: DnsLookup = async (hostname) => {
	const address = addresses[hostname];
	if (!address) throw new Error(`unexpected lookup: ${hostname}`);
	return [address];
};

describe("public HTTP client", () => {
	it("adapts a pinned address to both Node single and all-address DNS callbacks", async () => {
		const pinned = createPinnedLookup({ address: "93.184.216.34", family: 4 });
		const single = await new Promise<unknown[]>((resolve, reject) => {
			pinned("example.com", { family: 0, hints: 0 }, ((error: Error | null, ...values: unknown[]) => {
				if (error) reject(error);
				else resolve(values);
			}) as never);
		});
		const all = await new Promise<unknown[]>((resolve, reject) => {
			pinned("example.com", { all: true, family: 0, hints: 0 }, ((error: Error | null, ...values: unknown[]) => {
				if (error) reject(error);
				else resolve(values);
			}) as never);
		});

		assert.deepEqual(single, ["93.184.216.34", 4]);
		assert.deepEqual(all, [[{ address: "93.184.216.34", family: 4 }]]);
	});

	it("pins vetted DNS addresses and revalidates a relative redirect", async () => {
		const calls: Array<{ url: string; address: string }> = [];
		const transport: PublicRequestTransport = async (url, address) => {
			calls.push({ url: url.href, address: address.address });
			if (url.hostname === "start.example") {
				return { response: new Response(null, { status: 302, headers: { location: "https://final.example/page" } }) };
			}
			return {
				response: new Response("Final page", {
					status: 200,
					headers: { "content-type": "text/plain; charset=utf-8" },
				}),
			};
		};

		const result = await fetchPublicResource("https://start.example/old", { lookup, transport });

		assert.deepEqual(calls, [
			{ url: "https://start.example/old", address: "93.184.216.34" },
			{ url: "https://final.example/page", address: "2606:2800:220:1:248:1893:25c8:1946" },
		]);
		assert.equal(result.finalUrl, "https://final.example/page");
		assert.equal(result.body, "Final page");
		assert.equal(result.contentType, "text/plain; charset=utf-8");
		assert.equal(result.redirects, 1);
	});

	it("applies the deadline while DNS resolution is still pending", async () => {
		const request = fetchPublicResource("https://pending.example/", {
			lookup: async () => new Promise(() => {}),
			timeoutMs: 5,
		});
		const guard = new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error("request remained pending after its deadline")), 100);
		});

		await assert.rejects(Promise.race([request, guard]), /timed out/i);
	});

	it("cancels a response body that stalls past the deadline", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const transport: PublicRequestTransport = async () => ({
			response: new Response(body, { status: 200, headers: { "content-type": "text/plain" } }),
		});

		await assert.rejects(
			fetchPublicResource("https://start.example/stalled", { lookup, transport, timeoutMs: 5 }),
			/timed out/i,
		);
		assert.equal(cancelled, true);
	});

	it("distinguishes caller cancellation from a timeout", async () => {
		const controller = new AbortController();
		const request = fetchPublicResource("https://start.example/", {
			lookup: async () => new Promise(() => {}),
			signal: controller.signal,
			timeoutMs: 1_000,
		});
		controller.abort();

		await assert.rejects(request, /cancelled/i);
	});

	it("rejects declared and streamed bodies beyond the byte limit", async () => {
		const declared: PublicRequestTransport = async () => ({
			response: new Response("secret body", {
				status: 200,
				headers: { "content-length": "100", "content-type": "text/plain" },
			}),
		});
		await assert.rejects(
			fetchPublicResource("https://start.example/large", { lookup, transport: declared, maxResponseBytes: 10 }),
			/10-byte download limit/i,
		);

		let cancelled = false;
		const streamed: PublicRequestTransport = async () => ({
			response: new Response(new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("123456"));
					controller.enqueue(new TextEncoder().encode("789012"));
				},
				cancel() {
					cancelled = true;
				},
			}), { status: 200, headers: { "content-type": "text/plain" } }),
		});
		await assert.rejects(
			fetchPublicResource("https://start.example/stream", { lookup, transport: streamed, maxResponseBytes: 10 }),
			/10-byte download limit/i,
		);
		assert.equal(cancelled, true);
	});

	it("decodes bounded text bytes using the declared web charset and BOM", async () => {
		const latin1: PublicRequestTransport = async () => ({
			response: new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
				status: 200,
				headers: { "content-type": "text/plain; charset=iso-8859-1" },
			}),
		});
		const latin1Result = await fetchPublicResource("https://start.example/latin1", { lookup, transport: latin1 });
		assert.equal(latin1Result.body, "café");

		const utf16: PublicRequestTransport = async () => ({
			response: new Response(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]), {
				status: 200,
				headers: { "content-type": "text/plain" },
			}),
		});
		const utf16Result = await fetchPublicResource("https://start.example/utf16", { lookup, transport: utf16 });
		assert.equal(utf16Result.body, "hi");
	});

	it("rejects an unsupported declared charset without returning corrupted text", async () => {
		const transport: PublicRequestTransport = async () => ({
			response: new Response(new Uint8Array([0x61]), {
				status: 200,
				headers: { "content-type": "text/plain; charset=x-unknown-encoding" },
			}),
		});

		await assert.rejects(
			fetchPublicResource("https://start.example/unknown", { lookup, transport }),
			/unsupported.*charset/i,
		);
	});

	it("does not expose an upstream error body", async () => {
		const transport: PublicRequestTransport = async () => ({
			response: new Response("upstream secret", { status: 503 }),
		});

		await assert.rejects(
			fetchPublicResource("https://start.example/failure", { lookup, transport }),
			(error: Error) => error.message === "Web server returned HTTP 503" && !error.message.includes("secret"),
		);
	});

	it("blocks redirects to non-public destinations before a second request", async () => {
		let calls = 0;
		const transport: PublicRequestTransport = async () => {
			calls += 1;
			return { response: new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }) };
		};

		await assert.rejects(
			fetchPublicResource("https://start.example/", { lookup, transport }),
			/non-public address/i,
		);
		assert.equal(calls, 1);
	});

	it("enforces the redirect limit", async () => {
		const transport: PublicRequestTransport = async (url) => ({
			response: new Response(null, {
				status: 302,
				headers: { location: `https://start.example/${url.pathname.length}` },
			}),
		});

		await assert.rejects(
			fetchPublicResource("https://start.example/", { lookup, transport, maxRedirects: 1 }),
			/exceeded 1 redirects/i,
		);
	});
});
