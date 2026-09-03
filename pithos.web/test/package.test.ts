import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("Web package", () => {
	it("publishes the expected Pi package identity and entry point", async () => {
		const root = resolve(import.meta.dirname, "..");
		const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
		const extension = await import("../extensions/index.ts");

		assert.equal(manifest.name, "@pithos-kit/web");
		assert.equal(manifest.version, "0.2.0");
		assert.equal(manifest.engines.node, ">=22.19.0");
		assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.83.0");
		assert.equal(manifest.pithosKit.minimumPi, ">=0.83.0");
		assert.deepEqual(manifest.pi.extensions, ["./extensions"]);
		assert.deepEqual(manifest.pithosKit.commands, [{
			name: "web-setup",
			usage: "/web-setup [--help]",
			summary: "Check local Brave Search credential status and show secure setup guidance.",
		}]);
		assert.deepEqual(manifest.pithosKit.tools.map(({ name }: { name: string }) => name), ["web_search", "web_fetch"]);
		assert.deepEqual(manifest.pithosKit.configuration.map(({ key }: { key: string }) => key), [
			"BRAVE_SEARCH_API_KEY",
			"PI_OFFLINE",
		]);
		assert.ok(manifest.files.includes("src"));
		assert.ok(manifest.files.includes("extensions"));
		assert.ok(manifest.files.includes("LICENSE"));
		assert.equal(typeof extension.default, "function");
	});

	it("documents credentials, limits, safety, Plan use, and unsupported page classes", () => {
		const readme = readFileSync(resolve(import.meta.dirname, "../README.md"), "utf8");
		assert.match(readme, /BRAVE_SEARCH_API_KEY/);
		assert.match(readme, /\/web-setup/);
		assert.match(readme, /--help/);
		assert.match(readme, /https:\/\/api-dashboard\.search\.brave\.com\/register/);
		assert.match(readme, /https:\/\/api-dashboard\.search\.brave\.com\/app\/plans/);
		assert.match(readme, /https:\/\/api-dashboard\.search\.brave\.com\/app\/keys/);
		assert.match(readme, /Bash.*read -rsp/is);
		assert.match(readme, /zsh.*read -s/is);
		assert.match(readme, /fish.*read --silent/is);
		assert.match(readme, /PowerShell 7.*Read-Host.*-MaskInput/is);
		assert.match(readme, /export BRAVE_SEARCH_API_KEY/);
		assert.match(readme, /terminal stderr.*print mode/i);
		assert.match(readme, /restart Pi/i);
		assert.match(readme, /web_fetch.*(?:does not need|still works).*credential/is);
		assert.match(readme, /never paste.*(?:chat|tool arguments)/i);
		assert.match(readme, /401.*403.*inactive.*Search plan/is);
		assert.match(readme, /429.*quota.*rate limit/is);
		assert.match(readme, /PI_OFFLINE.*web_search.*web_fetch.*disabled/is);
		assert.match(readme, /public.*Internet/i);
		assert.match(readme, /private.*localhost/i);
		assert.match(readme, /untrusted.*instructions/i);
		assert.match(readme, /Plan mode/i);
		assert.match(readme, /JavaScript-rendered/i);
		assert.match(readme, /50KB.*2000 lines/is);
		assert.match(readme, /"@pithos-kit\/web": "npm:0\.2\.0"/);
	});

	it("is wired into repository documentation and trusted publishing", () => {
		const root = resolve(import.meta.dirname, "../..");
		const rootReadme = readFileSync(resolve(root, "README.md"), "utf8");
		const workflow = readFileSync(resolve(root, ".github/workflows/publish-pithos.web.yml"), "utf8");

		assert.match(rootReadme, /@pithos-kit\/web/);
		assert.match(workflow, /tags: \["pithos-kit\.web-v\*"\]/);
		assert.match(workflow, /working-directory: pithos\.web/);
		assert.match(workflow, /npm ci/);
		assert.match(workflow, /npm test/);
		assert.match(workflow, /npm run audit/);
		assert.match(workflow, /npm run typecheck/);
		assert.match(workflow, /npm pack --dry-run/);
		assert.match(workflow, /npm publish --provenance --access public/);
	});
});
