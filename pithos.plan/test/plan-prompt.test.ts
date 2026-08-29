import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const planPrompt = readFileSync(resolve(import.meta.dirname, "../prompts/plan.md"), "utf8");

describe("Plan lifecycle prompt", () => {
	it("documents explicit command grammar and keeps task text in normal prompts", () => {
		assert.match(planPrompt, /\/plan save.*\/plan preview.*\/plan exit.*\/plan status/is);
		assert.match(planPrompt, /task and refinement text.*normal prompts/i);
		assert.doesNotMatch(planPrompt, /\/plan <task>/i);
		assert.match(planPrompt, /bare `?\/plan`?.*save\/finalize/i);
	});

	it("requires exact full sequential checkpoints after the first brief and material changes", () => {
		assert.match(planPrompt, /update_plan_draft/i);
		assert.match(planPrompt, /first coherent planning brief/i);
		assert.match(planPrompt, /every material change/i);
		assert.match(planPrompt, /complete.*Markdown snapshot/i);
		assert.match(planPrompt, /expectedRevision/i);
		assert.match(planPrompt, /wait for.*result.*revision/is);
	});

	it("publishes only explicit save or exit requests from the latest checkpoint revision", () => {
		assert.match(planPrompt, /Do not call `create_plan` during ordinary planning/i);
		assert.match(planPrompt, /\/plan save.*remain.*Plan mode/is);
		assert.match(planPrompt, /\/plan exit.*Exit without publishing.*safe default/is);
		assert.match(planPrompt, /create_plan.*latest checkpoint revision/is);
		assert.match(planPrompt, /exact-content.*path.*approval/is);
		assert.match(planPrompt, /cooperating Pi mutations.*file-mutation queue/is);
		assert.match(planPrompt, /not a linearizable cross-process\s+compare-and-swap/i);
		assert.match(planPrompt, /arbitrary external OS writers.*race/is);
	});

	it("preserves read-only and trusted-Web enforcement", () => {
		assert.match(planPrompt, /read, grep, find, and ls/i);
		assert.match(planPrompt, /web_search.*web_fetch/i);
		assert.match(planPrompt, /untrusted external data/i);
		assert.match(planPrompt, /other\s+custom tools.*blocked/i);
	});

	it("requires an outcome-focused title and structured planning brief", () => {
		assert.match(planPrompt, /title must concisely name the feature, bug, or outcome/i);
		assert.match(planPrompt, /## Requirements/);
		assert.match(planPrompt, /## Constraints/);
		assert.match(planPrompt, /## Decisions/);
		assert.match(planPrompt, /## Assumptions/);
		assert.match(planPrompt, /## Open questions/);
		assert.match(planPrompt, /## Plan/);
	});
});
