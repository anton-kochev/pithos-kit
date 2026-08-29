import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { createPlanArgumentAutocompleteProvider } from "../extensions/plan-autocomplete.ts";

function fallbackProvider() {
	let calls = 0;
	const provider: AutocompleteProvider = {
		async getSuggestions() {
			calls += 1;
			return { prefix: "fallback", items: [{ value: "fallback", label: "fallback" }] };
		},
		applyCompletion(lines) {
			return { lines, cursorLine: 0, cursorCol: 0 };
		},
		shouldTriggerFileCompletion() {
			return false;
		},
	};
	return { provider, getCalls: () => calls };
}

const options = { signal: new AbortController().signal } as never;

describe("Plan argument autocomplete", () => {
	it("offers concrete Plan arguments on explicit completion after the command", async () => {
		const fallback = fallbackProvider();
		const provider = createPlanArgumentAutocompleteProvider(fallback.provider);

		const suggestions = await provider.getSuggestions(["/plan "], 0, 6, options);

		assert.equal(suggestions?.prefix, "");
		assert.deepEqual(
			suggestions?.items.map((item) => item.value),
			["save", "preview", "exit", "status", "help", "--help", "-h"],
		);
		assert.equal(provider.shouldTriggerFileCompletion?.(["/plan "], 0, 6), true);
		assert.equal(fallback.getCalls(), 0);
	});

	it("supports a second Tab after completing the slash command", async () => {
		const base = new CombinedAutocompleteProvider([{ name: "plan", description: "Plan mode" }], process.cwd());
		const provider = createPlanArgumentAutocompleteProvider(base);
		const commandSuggestions = await provider.getSuggestions(["/plan"], 0, 5, options);
		const planCommand = commandSuggestions?.items.find((item) => item.value === "plan");
		assert.ok(planCommand);

		const completed = provider.applyCompletion(["/plan"], 0, 5, planCommand, commandSuggestions?.prefix ?? "");
		assert.equal(completed.lines[0], "/plan ");
		assert.equal(provider.shouldTriggerFileCompletion?.(completed.lines, 0, completed.cursorCol), true);

		const argumentSuggestions = await provider.getSuggestions(
			completed.lines,
			0,
			completed.cursorCol,
			options,
		);
		assert.deepEqual(
			argumentSuggestions?.items.map((item) => item.value),
			["save", "preview", "exit", "status", "help", "--help", "-h"],
		);
	});

	it("filters arguments by the text after /plan", async () => {
		const fallback = fallbackProvider();
		const provider = createPlanArgumentAutocompleteProvider(fallback.provider);

		const suggestions = await provider.getSuggestions(["/plan e"], 0, 7, options);

		assert.equal(suggestions?.prefix, "e");
		assert.deepEqual(suggestions?.items.map((item) => item.value), ["exit"]);
	});

	it("delegates unrelated and free-form task input to the existing provider", async () => {
		const fallback = fallbackProvider();
		const provider = createPlanArgumentAutocompleteProvider(fallback.provider);

		const unrelated = await provider.getSuggestions(["/other e"], 0, 8, options);
		const unknown = await provider.getSuggestions(["/plan implement"], 0, 15, options);

		assert.equal(unrelated?.prefix, "fallback");
		assert.equal(unknown?.prefix, "fallback");
		assert.equal(provider.shouldTriggerFileCompletion?.(["/other "], 0, 7), false);
		assert.equal(fallback.getCalls(), 2);
	});
});
