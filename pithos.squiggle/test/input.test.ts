import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerSquiggle } from "../extensions/index.ts";

type Corrector = (...args: any[]) => Promise<string | null>;

function createHarness(corrected: string | Corrector) {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
	let corrections = 0;
	registerSquiggle({
		on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
			handlers.set(name, handler);
		},
		registerCommand() {},
		appendEntry() {},
	} as never, async (...args: any[]) => {
		corrections += 1;
		return typeof corrected === "function" ? corrected(...args) : corrected;
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
		shutdown: () => handlers.get("session_shutdown")!({ reason: "reload" }, ctx),
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

	it("cancels an in-flight correction on shutdown, preserves the input, and clears the spinner", async () => {
		let receivedSignal: AbortSignal | undefined;
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const harness = createHarness(async (_input, _ctx, _config, _log, signal: AbortSignal) => {
			receivedSignal = signal;
			markStarted();
			return new Promise((resolve) => {
				signal.addEventListener("abort", () => resolve(null), { once: true });
			});
		});
		const pending = harness.handleInput({
			type: "input",
			source: "interactive",
			text: "Corected prompt",
		});
		await started;

		await harness.shutdown();

		assert.deepEqual(await pending, { action: "continue" });
		assert.equal(receivedSignal?.aborted, true);
		assert.equal(harness.statuses.at(-1), undefined);
	});
});
