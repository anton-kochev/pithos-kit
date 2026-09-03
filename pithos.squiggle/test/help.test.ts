import assert from "node:assert/strict";
import { describe, it } from "node:test";
import squiggle from "../extensions/index.ts";

function createHarness() {
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	squiggle({
		on() {},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
	} as never);

	const notifications: Array<{ message: string; level: string }> = [];
	const context = {
		cwd: "/project",
		hasUI: true,
		model: undefined,
		modelRegistry: { find: () => undefined },
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	};
	return { commands, context, notifications };
}

describe("Squiggle command help", () => {
	it("shows package-local help for /squiggle --help and -h without toggling", async () => {
		for (const alias of ["--help", "-h"]) {
			const harness = createHarness();
			await harness.commands.get("squiggle")!.handler(alias, harness.context);

			assert.equal(harness.notifications.length, 1);
			assert.equal(harness.notifications[0]?.level, "info");
			assert.match(harness.notifications[0]?.message ?? "", /Usage: \/squiggle toggle/);
			assert.match(harness.notifications[0]?.message ?? "", /--help, -h/);
		}
	});

	it("shows package-local help for /squiggle-status --help and -h", async () => {
		for (const alias of ["--help", "-h"]) {
			const harness = createHarness();
			await harness.commands.get("squiggle-status")!.handler(alias, harness.context);

			assert.equal(harness.notifications.length, 1);
			assert.equal(harness.notifications[0]?.level, "info");
			assert.match(harness.notifications[0]?.message ?? "", /Usage: \/squiggle-status/);
			assert.match(harness.notifications[0]?.message ?? "", /--help, -h/);
		}
	});
});
