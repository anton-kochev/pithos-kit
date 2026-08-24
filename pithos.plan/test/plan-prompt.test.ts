import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const planPrompt = readFileSync(resolve(import.meta.dirname, "../prompts/plan.md"), "utf8");

describe("Plan prompt approval workflow", () => {
	it("keeps command guidance concise now that arguments autocomplete", () => {
		assert.doesNotMatch(planPrompt, /argument-hint:/i);
		assert.match(planPrompt, /description:.*finalize.*exit/i);
	});

	it("requires an outcome-focused title suitable for contextual session naming", () => {
		assert.match(planPrompt, /title must concisely name the feature, bug, or outcome/i);
		assert.match(planPrompt, /avoid generic\s+titles/i);
	});

	it("permits only provenance-trusted Web research as a custom-tool exception", () => {
		assert.match(planPrompt, /web_search.*web_fetch/i);
		assert.match(planPrompt, /public web.*research/i);
		assert.match(planPrompt, /other custom tools.*blocked/i);
		assert.match(planPrompt, /untrusted external data/i);
	});

	it("uses one interactive gate with optional preview and a safe default", () => {
		assert.match(planPrompt, /interactive confirmation is the sole\s+final approval gate/i);
		assert.match(planPrompt, /call\s+`create_plan` immediately/i);
		assert.match(planPrompt, /Preview the plan.*optional/i);
		assert.match(planPrompt, /Create plan and start implementation.*without preview/i);
		assert.match(planPrompt, /Continue planning.*default/i);
	});

	it("does not request a separate conversational go-ahead", () => {
		assert.doesNotMatch(planPrompt, /explicitly say go ahead/i);
		assert.doesNotMatch(planPrompt, /without an explicit go-ahead/i);
		assert.doesNotMatch(planPrompt, /user has \*explicitly\* confirmed/i);
	});
});
