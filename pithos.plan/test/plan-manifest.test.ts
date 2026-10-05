import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// Registration contract: keep the lifecycle command; never export a second /plan prompt.
// An explicit empty Pi array also prevents filtered-package convention discovery.
describe("Plan package registration", () => {
	it("exports the Plan command without registering or advertising a prompt template", () => {
		assert.deepEqual(manifest.pi.prompts, [], "explicitly disable convention prompt discovery");
		assert.deepEqual(manifest.pithosKit.prompts, [], "Atlas must not advertise a Plan prompt");
		assert.equal(manifest.keywords.includes("pi-prompt-template"), false);
		assert.deepEqual(manifest.pi.extensions, ["./extensions/plan-theme.ts"]);
		assert.deepEqual(manifest.pithosKit.commands.map(({ name }: { name: string }) => name), ["plan"]);
	});
});
