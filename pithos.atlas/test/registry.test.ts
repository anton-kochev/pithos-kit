import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isOfflineEnvironment, RegistryClient } from "../src/registry.ts";

const registryManifest = {
	name: "@pithos-kit/example",
	version: "1.2.3",
	description: "An example package.",
	pi: { extensions: ["./extensions"] },
	pithosKit: {
		displayName: "Example",
		summary: "An example package.",
		minimumPi: ">=0.83.0",
		commands: [{ name: "example", usage: "/example [--help]", summary: "Run it." }],
		tools: [],
		prompts: [],
		skills: [],
		themes: [],
		agents: [],
		configuration: [],
	},
};

describe("npm registry client", () => {
	it("honors all supported PI_OFFLINE truthy values without fetching", async () => {
		for (const value of ["1", "true", "TRUE", "yes", " yes "]) {
			assert.equal(isOfflineEnvironment(value), true);
		}
		assert.equal(isOfflineEnvironment("0"), false);

		let calls = 0;
		const client = new RegistryClient({
			offline: true,
			fetch: async () => {
				calls += 1;
				return new Response();
			},
		});
		await assert.rejects(client.latest("@pithos-kit/example"), /PI_OFFLINE/);
		assert.equal(calls, 0);
	});

	it("aborts a registry request after the configured timeout", async () => {
		const fetcher: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
		});
		const client = new RegistryClient({ fetch: fetcher, timeoutMs: 5 });

		await assert.rejects(client.latest("@pithos-kit/example"), /Unable to reach/);
	});

	it("aborts a stalled response body after the configured timeout", async () => {
		let cancelled = false;
		const response = {
			ok: true,
			status: 200,
			headers: { get: () => null },
			body: {
				getReader: () => ({
					read: () => new Promise(() => undefined),
					cancel: async () => { cancelled = true; },
					releaseLock: () => {},
				}),
			},
		} as unknown as Response;
		const client = new RegistryClient({
			fetch: async () => response,
			timeoutMs: 5,
		});

		await assert.rejects(client.latest("@pithos-kit/example"), /Unable to read the npm registry response/);
		assert.equal(cancelled, true);
	});

	it("stops consuming an oversized response body", async () => {
		let pulls = 0;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				if (pulls === 1) controller.enqueue(new TextEncoder().encode("12345"));
				else controller.close();
			},
			cancel() { cancelled = true; },
		}, { highWaterMark: 0 });
		const client = new RegistryClient({
			fetch: async () => new Response(body, { status: 200 }),
			maxResponseBytes: 4,
		});

		await assert.rejects(client.latest("@pithos-kit/example"), /too large/);
		assert.equal(cancelled, true);
	});

	it("discovers only validated package names from the public scope search", async () => {
		const fetcher: typeof fetch = async () => new Response(JSON.stringify({
			objects: [
				{ package: { name: "@pithos-kit/zebra" } },
				{ package: { name: "third-party" } },
				{ package: { name: "@pithos-kit/alpha" } },
			],
		}), { status: 200 });
		const client = new RegistryClient({ fetch: fetcher });

		assert.deepEqual(await client.discover(), ["@pithos-kit/alpha", "@pithos-kit/zebra"]);
	});

	it("retrieves the latest published Pi version without treating Pi as a catalog package", async () => {
		const fetcher: typeof fetch = async () => new Response(JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			version: "0.90.0",
		}), { status: 200 });
		const client = new RegistryClient({ fetch: fetcher });

		assert.equal(await client.latestPiVersion(), "0.90.0");
	});

	it("returns validated versions from a package packument for compatibility selection", async () => {
		const older = { ...registryManifest, version: "1.0.0" };
		const newer = {
			...registryManifest,
			version: "2.0.0",
			pithosKit: { ...registryManifest.pithosKit, minimumPi: ">=0.90.0" },
		};
		const fetcher: typeof fetch = async () => new Response(JSON.stringify({
			name: "@pithos-kit/example",
			versions: { "1.0.0": older, "2.0.0": newer },
		}), { status: 200 });
		const client = new RegistryClient({ fetch: fetcher });

		assert.deepEqual((await client.versions("@pithos-kit/example")).map(({ version }) => version), ["2.0.0", "1.0.0"]);
	});

	it("fetches and caches validated latest package metadata", async () => {
		const urls: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			urls.push(String(input));
			return new Response(JSON.stringify(registryManifest), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const client = new RegistryClient({ fetch: fetcher, offline: false });

		const first = await client.latest("@pithos-kit/example");
		const second = await client.latest("@pithos-kit/example");
		const refreshed = await client.latest("@pithos-kit/example", { refresh: true });

		assert.equal(first.name, "@pithos-kit/example");
		assert.equal(second.version, "1.2.3");
		assert.equal(refreshed.version, "1.2.3");
		assert.deepEqual(urls, [
			"https://registry.npmjs.org/%40pithos-kit%2Fexample/latest",
			"https://registry.npmjs.org/%40pithos-kit%2Fexample/latest",
		]);
	});
});
