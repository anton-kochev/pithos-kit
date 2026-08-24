import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolvePublicUrl, type DnsLookup } from "../src/network-policy.ts";

function lookup(addresses: Array<{ address: string; family: 4 | 6 }>): DnsLookup {
	return async () => addresses;
}

describe("public URL policy", () => {
	it("accepts a normalized public HTTPS URL and pins its vetted DNS address", async () => {
		const resolved = await resolvePublicUrl(
			"https://Example.COM:443/docs?q=one#part",
			lookup([{ address: "93.184.216.34", family: 4 }]),
		);

		assert.equal(resolved.url.href, "https://example.com/docs?q=one#part");
		assert.deepEqual(resolved.addresses, [{ address: "93.184.216.34", family: 4 }]);
	});

	it("rejects localhost and private DNS answers", async () => {
		await assert.rejects(
			resolvePublicUrl("http://localhost/", lookup([{ address: "127.0.0.1", family: 4 }])),
			/public Internet host/i,
		);
		await assert.rejects(
			resolvePublicUrl("https://internal.example/", lookup([{ address: "10.0.0.2", family: 4 }])),
			/non-public address/i,
		);
	});

	it("rejects localhost names with a trailing DNS root dot before lookup", async () => {
		let lookups = 0;
		await assert.rejects(
			resolvePublicUrl("http://localhost./", async () => {
				lookups += 1;
				return [{ address: "93.184.216.34", family: 4 }];
			}),
			/public Internet host/i,
		);
		assert.equal(lookups, 0);
	});

	it("rejects unsupported schemes, URL credentials, unsafe lengths, and nonstandard ports", async () => {
		for (const [url, message] of [
			["file:///etc/passwd", /HTTP\(S\)/i],
			["https://user:secret@example.com/", /credentials/i],
			[`https://example.com/${"a".repeat(4_096)}`, /4096 characters/i],
			["https://example.com:8443/", /standard.*ports/i],
		] as const) {
			await assert.rejects(resolvePublicUrl(url, lookup([{ address: "93.184.216.34", family: 4 }])), message);
		}
	});

	it("rejects every literal non-public address class", async () => {
		for (const url of [
			"http://0.0.0.0/",
			"http://127.0.0.1/",
			"http://169.254.169.254/",
			"http://192.168.1.1/",
			"http://224.0.0.1/",
			"http://[::1]/",
			"http://[fe80::1]/",
			"http://[fc00::1]/",
			"http://[::ffff:127.0.0.1]/",
		]) {
			await assert.rejects(resolvePublicUrl(url), /non-public address/i, url);
		}
	});

	it("fails closed when DNS returns mixed public and private answers", async () => {
		await assert.rejects(
			resolvePublicUrl("https://mixed.example/", lookup([
				{ address: "93.184.216.34", family: 4 },
				{ address: "192.168.1.10", family: 4 },
			])),
			/non-public address/i,
		);
	});
});
