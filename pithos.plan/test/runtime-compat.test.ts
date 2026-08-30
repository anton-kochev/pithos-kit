import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
const RUNTIME_COMPAT_MODULE_URL = new URL("../extensions/runtime-compat.ts", import.meta.url).href;
const VENDORED_UNDICI_MODULE_URL = new URL(
	"../node_modules/@earendil-works/pi-coding-agent/node_modules/undici/index.js",
	import.meta.url,
).href;
const RUNTIME_PI_CONSUMER_MODULE_URLS = [
	new URL("../extensions/plan-files.ts", import.meta.url).href,
	new URL("../extensions/plan-confirmation.ts", import.meta.url).href,
	new URL("../extensions/plan-preview.ts", import.meta.url).href,
];

async function runIsolatedModuleScript(script: string): Promise<void> {
	await execFileAsync(process.execPath, ["--input-type=module", "--eval", script]);
}

async function runIsolatedBunScript(script: string): Promise<void> {
	await execFileAsync("bun", ["--eval", script]);
}

describe("runtime compatibility", () => {
	it("installs the missing worker_threads API before vendored undici initializes", async () => {
		await runIsolatedModuleScript(`
			import assert from "node:assert/strict";
			import workerThreads from "node:worker_threads";

			delete workerThreads.markAsUncloneable;
			await import(${JSON.stringify(RUNTIME_COMPAT_MODULE_URL)});

			assert.equal(typeof workerThreads.markAsUncloneable, "function");
			await import(${JSON.stringify(VENDORED_UNDICI_MODULE_URL)});
		`);
	});

	it("loads vendored undici under Bun when the host API is missing", { skip: !bunAvailable }, async () => {
		await runIsolatedBunScript(`
			import workerThreads from "node:worker_threads";

			delete workerThreads.markAsUncloneable;
			await import(${JSON.stringify(RUNTIME_COMPAT_MODULE_URL)});
			await import(${JSON.stringify(VENDORED_UNDICI_MODULE_URL)});
		`);
	});

	it("preserves the host worker_threads implementation", async () => {
		await runIsolatedModuleScript(`
			import assert from "node:assert/strict";
			import workerThreads from "node:worker_threads";

			const hostImplementation = workerThreads.markAsUncloneable;
			assert.equal(typeof hostImplementation, "function");

			await import(${JSON.stringify(RUNTIME_COMPAT_MODULE_URL)});

			assert.equal(workerThreads.markAsUncloneable, hostImplementation);
		`);
	});

	it("evaluates compatibility before every runtime Pi API consumer", async () => {
		for (const moduleUrl of RUNTIME_PI_CONSUMER_MODULE_URLS) {
			await runIsolatedModuleScript(`
				import workerThreads from "node:worker_threads";

				delete workerThreads.markAsUncloneable;
				await import(${JSON.stringify(moduleUrl)});
			`);
		}
	});
});
