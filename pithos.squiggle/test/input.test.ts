import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerSquiggle } from "../extensions/index.ts";

function createHarness(corrected: string) {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
	let corrections = 0;
	registerSquiggle({
		on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
			handlers.set(name, handler);
		},
		registerCommand() {},
		appendEntry() {},
	} as never, async () => {
		corrections += 1;
		return corrected;
	});

	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const ctx = {
		cwd: "/project",
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
		},
	};

	return {
		handleInput: (event: any) => handlers.get("input")!(event, ctx),
		notifications,
		statuses,
		get corrections() {
			return corrections;
		},
	};
}

describe("Squiggle input transformation", () => {
	it("returns corrected interactive input to Pi instead of resubmitting it", async () => {
		const harness = createHarness("I will provide the OTP, and then you can proceed.");

		const result = await harness.handleInput({
			type: "input",
			source: "interactive",
			text: "I will give you the OTP, and you proceed.",
		});

		assert.deepEqual(result, {
			action: "transform",
			text: "I will provide the OTP, and then you can proceed.",
		});
		assert.equal(harness.corrections, 1);
		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.statuses.at(-1), undefined);
	});

	it("preserves the outer prompt's steering and follow-up delivery flow", async () => {
		for (const streamingBehavior of ["steer", "followUp"] as const) {
			const harness = createHarness("Corrected prompt");

			const result = await harness.handleInput({
				type: "input",
				source: "interactive",
				streamingBehavior,
				text: "Corected prompt",
			});

			assert.deepEqual(result, { action: "transform", text: "Corrected prompt" });
		}
	});

	it("does not process extension-originated input", async () => {
		const harness = createHarness("Corrected prompt");

		const result = await harness.handleInput({
			type: "input",
			source: "extension",
			text: "Corected prompt",
		});

		assert.deepEqual(result, { action: "continue" });
		assert.equal(harness.corrections, 0);
	});
});
