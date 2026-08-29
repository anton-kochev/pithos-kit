import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	confirmPlanCreation,
	confirmPlanExitFallback,
	confirmPlanExitWithoutCheckpoint,
	confirmPlanPublication,
} from "../extensions/plan-exit.ts";

const theme = {
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
	underline: (text: string) => text,
	fg: (_color: string, text: string) => text,
};

const defaultKeys: Record<string, string[]> = {
	"tui.select.confirm": ["enter"],
	"tui.select.cancel": ["escape", "ctrl+c"],
	"tui.select.up": ["up"],
	"tui.select.down": ["down"],
	"tui.select.pageUp": ["pageUp"],
	"tui.select.pageDown": ["pageDown"],
};

const keybindings = {
	matches: (data: string, action: string) => defaultKeys[action]?.includes(data) ?? false,
	getKeys: (action: string) => defaultKeys[action] ?? [],
};

function instantiate(factory: any) {
	let selected: unknown;
	const component = factory(
		{ terminal: { rows: 20 }, requestRender() {} },
		theme,
		keybindings,
		(value: unknown) => {
			selected = value;
		},
	);
	return { component, selected: () => selected };
}

describe("confirmPlanCreation", () => {
	it("includes the exact draft in RPC approval", async () => {
		const dialogs: Array<[string, string]> = [];
		const context = {
			mode: "rpc" as const,
			hasUI: true,
			ui: {
				confirm: async (title: string, message: string) => {
					dialogs.push([title, message]);
					return true;
				},
			},
		};
		const content = "# Plan: Preview drafts\n\nExact RPC draft.";

		const decision = await confirmPlanCreation(context, ".pi/plans/example.md", content);

		assert.equal(decision.action, "create");
		assert.equal(dialogs.length, 1);
		assert.match(dialogs[0]?.[0] ?? "", /review plan draft/i);
		assert.match(dialogs[0]?.[1] ?? "", /Target: `\.pi\/plans\/example\.md`/);
		assert.match(dialogs[0]?.[1] ?? "", /# Plan: Preview drafts\n\nExact RPC draft\./);
	});

	it("continues planning when RPC approval is declined", async () => {
		const decision = await confirmPlanCreation(
			{
				mode: "rpc",
				hasUI: true,
				ui: { confirm: async () => false },
			},
			".pi/plans/example.md",
			"# Plan: Keep planning",
		);

		assert.deepEqual(decision, { action: "continue" });
	});

	it("uses Continue planning as the safe TUI default", async () => {
		const decision = await confirmPlanCreation(
			{
				mode: "tui",
				hasUI: true,
				ui: {
					confirm: async () => {
						throw new Error("TUI confirmation must use the compact chooser");
					},
					custom: async (factory: any) => {
						const { component, selected } = instantiate(factory);
						component.handleInput("enter");
						return selected();
					},
				},
			},
			".pi/plans/example.md",
			"# Plan: Safe confirmation",
		);

		assert.deepEqual(decision, { action: "continue" });
	});

	it("creates directly without opening the preview", async () => {
		let customCalls = 0;
		const decision = await confirmPlanCreation(
			{
				mode: "tui",
				hasUI: true,
				ui: {
					confirm: async () => false,
					custom: async (factory: any) => {
						customCalls += 1;
						const { component, selected } = instantiate(factory);
						component.render(80);
						component.handleInput("down");
						component.handleInput("down");
						component.handleInput("enter");
						return selected();
					},
				},
			},
			".pi/plans/example.md",
			"# Plan: Direct creation",
		);

		assert.deepEqual(decision, { action: "create" });
		assert.equal(customCalls, 1);
	});

	it("returns from a review-only preview to the identical confirmation choices", async () => {
		const screens: string[] = [];
		let customCalls = 0;
		const decision = await confirmPlanCreation(
			{
				mode: "tui",
				hasUI: true,
				ui: {
					confirm: async () => false,
					custom: async (factory: any) => {
						const { component, selected } = instantiate(factory);
						const output = component.render(80).join("\n");
						screens.push(output);
						customCalls += 1;
						if (customCalls === 1) {
							component.handleInput("down");
							component.handleInput("enter");
						} else if (customCalls === 2) {
							assert.match(output, /Plan: Review then create/);
							assert.doesNotMatch(output, /Create plan and start implementation/);
							component.handleInput("enter");
						} else {
							component.handleInput("down");
							component.handleInput("down");
							component.handleInput("enter");
						}
						return selected();
					},
				},
			},
			".pi/plans/example.md",
			"# Plan: Review then create",
		);

		assert.deepEqual(decision, { action: "create" });
		assert.equal(customCalls, 3);
		assert.equal(screens[0], screens[2]);
	});

	it("continues safely when interactive UI is unavailable", async () => {
		const decision = await confirmPlanCreation(
			{
				mode: "print",
				hasUI: false,
				ui: { confirm: async () => true },
			},
			".pi/plans/example.md",
			"# Plan: No UI",
		);

		assert.deepEqual(decision, { action: "continue" });
	});
});

describe("confirmPlanExitWithoutCheckpoint", () => {
	it("keeps Plan active when abort dismisses the RPC no-checkpoint chooser", async () => {
		const controller = new AbortController();
		controller.abort();
		let receivedSignal: AbortSignal | undefined;
		const decision = await confirmPlanExitWithoutCheckpoint({
			mode: "rpc",
			hasUI: true,
			signal: controller.signal,
			ui: {
				confirm: async () => false,
				select: async (_title, _choices, options) => {
					receivedSignal = options?.signal;
					return undefined;
				},
			},
		});

		assert.equal(receivedSignal, controller.signal);
		assert.deepEqual(decision, { action: "continue" });
	});

	it("offers the minimal RPC chooser and treats dismissal as direct exit", async () => {
		const dialogs: Array<[string, string[]]> = [];
		const decision = await confirmPlanExitWithoutCheckpoint({
			mode: "rpc",
			hasUI: true,
			ui: {
				confirm: async () => false,
				select: async (title: string, choices: string[]) => {
					dialogs.push([title, choices]);
					return undefined;
				},
			},
		});

		assert.deepEqual(decision, { action: "exit" });
		assert.deepEqual(dialogs[0]?.[1], [
			"Exit without publishing",
			"Finalize before exit",
			"Continue planning",
		]);
	});

	it("supports TUI finalization/continue choices and exits safely without UI", async () => {
		let choice = "Finalize before exit";
		const context = {
			mode: "tui" as const,
			hasUI: true,
			ui: {
				confirm: async () => false,
				select: async () => choice,
			},
		};
		assert.deepEqual(await confirmPlanExitWithoutCheckpoint(context), { action: "finalize" });
		choice = "Continue planning";
		assert.deepEqual(await confirmPlanExitWithoutCheckpoint(context), { action: "continue" });
		assert.deepEqual(
			await confirmPlanExitWithoutCheckpoint({
				mode: "print",
				hasUI: false,
				ui: {
					confirm: async () => true,
					select: async () => {
						throw new Error("No-UI exit must not open a dialog");
					},
				},
			}),
			{ action: "exit" },
		);
	});
});

describe("confirmPlanExitFallback", () => {
	it("keeps Plan active when abort dismisses the settled RPC fallback", async () => {
		const controller = new AbortController();
		controller.abort();
		let receivedSignal: AbortSignal | undefined;
		const decision = await confirmPlanExitFallback({
			mode: "rpc",
			hasUI: true,
			signal: controller.signal,
			ui: {
				confirm: async () => false,
				select: async (_title, _choices, options) => {
					receivedSignal = options?.signal;
					return undefined;
				},
			},
		});

		assert.equal(receivedSignal, controller.signal);
		assert.deepEqual(decision, { action: "continue" });
	});

	it("uses safe direct exit when a finalization run settles without publication", async () => {
		const choicesSeen: string[][] = [];
		const decision = await confirmPlanExitFallback({
			mode: "rpc",
			hasUI: true,
			ui: {
				confirm: async () => false,
				select: async (_title: string, choices: string[]) => {
					choicesSeen.push(choices);
					return undefined;
				},
			},
		});

		assert.deepEqual(decision, { action: "exit" });
		assert.deepEqual(choicesSeen, [["Exit without publishing", "Continue planning"]]);
	});

	it("continues when selected and exits safely without UI", async () => {
		assert.deepEqual(
			await confirmPlanExitFallback({
				mode: "tui",
				hasUI: true,
				ui: {
					confirm: async () => false,
					select: async () => "Continue planning",
				},
			}),
			{ action: "continue" },
		);
		assert.deepEqual(
			await confirmPlanExitFallback({
				mode: "json",
				hasUI: false,
				ui: { confirm: async () => true },
			}),
			{ action: "exit" },
		);
	});
});

describe("confirmPlanPublication", () => {
	it("dismisses a package-owned TUI confirmation when its signal is aborted", async () => {
		const controller = new AbortController();
		const confirmationStarted = Promise.withResolvers<void>();
		const decisionPromise = confirmPlanPublication(
			{
				mode: "tui",
				hasUI: true,
				signal: controller.signal,
				ui: {
					confirm: async () => false,
					custom: async (factory: any) => new Promise((resolve) => {
						factory(
							{ terminal: { rows: 20 }, requestRender() {} },
							theme,
							keybindings,
							resolve,
						);
						confirmationStarted.resolve();
					}),
				},
			},
			".pi/plans/example.md",
			"# Plan: Abort TUI confirmation",
			{ workflow: "exit", kind: "create" },
		);
		await confirmationStarted.promise;

		controller.abort();

		assert.deepEqual(await decisionPromise, { action: "continue" });
	});

	it("keeps Plan active when an RPC exit chooser is dismissed by abort", async () => {
		const controller = new AbortController();
		controller.abort();
		let receivedSignal: AbortSignal | undefined;
		const decision = await confirmPlanPublication(
			{
				mode: "rpc",
				hasUI: true,
				signal: controller.signal,
				ui: {
					confirm: async () => false,
					select: async (_title, _choices, options) => {
						receivedSignal = options?.signal;
						return undefined;
					},
				},
			},
			".pi/plans/example.md",
			"# Plan: Abort exit chooser",
			{ workflow: "exit", kind: "create" },
		);

		assert.equal(receivedSignal, controller.signal);
		assert.deepEqual(decision, { action: "continue" });
	});

	it("preserves an explicit direct safe exit even if its signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const decision = await confirmPlanPublication(
			{
				mode: "rpc",
				hasUI: true,
				signal: controller.signal,
				ui: {
					confirm: async () => false,
					select: async () => "Exit without publishing",
				},
			},
			".pi/plans/example.md",
			"# Plan: Explicit safe exit",
			{ workflow: "exit", kind: "create" },
		);

		assert.deepEqual(decision, { action: "exit" });
	});

	it("threads one exact signal through the RPC exit chooser, preview, and approval", async () => {
		const controller = new AbortController();
		const receivedSignals: Array<AbortSignal | undefined> = [];
		let selections = 0;
		const decision = await confirmPlanPublication(
			{
				mode: "rpc",
				hasUI: true,
				signal: controller.signal,
				ui: {
					select: async (_title, _choices, options) => {
						receivedSignals.push(options?.signal);
						selections += 1;
						return selections === 1 ? "Preview the plan" : "Create plan";
					},
					confirm: async (_title, _message, options) => {
						receivedSignals.push(options?.signal);
						return true;
					},
				},
			},
			".pi/plans/example.md",
			"# Plan: Signal-bound preview",
			{ workflow: "exit", kind: "create" },
		);

		assert.deepEqual(decision, { action: "publish" });
		assert.deepEqual(receivedSignals, [
			controller.signal,
			controller.signal,
			controller.signal,
			controller.signal,
		]);
	});

	it("uses exit without publishing as the safe default without interactive UI", async () => {		const decision = await confirmPlanPublication(
			{
				mode: "print",
				hasUI: false,
				ui: { confirm: async () => true },
			},
			".pi/plans/example.md",
			"# Plan: Preserved draft",
			{ workflow: "exit", kind: "create" },
		);

		assert.deepEqual(decision, { action: "exit" });
	});

	it("uses exit without publishing as the safe TUI default", async () => {
		const decision = await confirmPlanPublication(
			{
				mode: "tui",
				hasUI: true,
				ui: {
					confirm: async () => true,
					custom: async (factory: any) => {
						const { component, selected } = instantiate(factory);
						component.render(80);
						component.handleInput("enter");
						return selected();
					},
				},
			},
			".pi/plans/example.md",
			"# Plan: Preserved draft",
			{ workflow: "exit", kind: "update" },
		);

		assert.deepEqual(decision, { action: "exit" });
	});

	it("binds an RPC update approval to the exact path and checkpoint bytes", async () => {
		const dialogs: Array<[string, string]> = [];
		const decision = await confirmPlanPublication(
			{
				mode: "rpc",
				hasUI: true,
				ui: {
					select: async () => "Update plan",
					confirm: async (title: string, message: string) => {
						dialogs.push([title, message]);
						return true;
					},
				},
			},
			".pi/plans/stable.md",
			"# Plan: Exact update\n\nChanged bytes.",
			{ workflow: "exit", kind: "update" },
		);

		assert.deepEqual(decision, { action: "publish" });
		assert.match(dialogs[0]?.[1] ?? "", /Target: `\.pi\/plans\/stable\.md`/);
		assert.match(dialogs[0]?.[1] ?? "", /# Plan: Exact update\n\nChanged bytes\./);
	});
});
