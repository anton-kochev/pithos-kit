import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PlanConfirmation } from "../extensions/plan-confirmation.ts";

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
};

const defaultKeys: Record<string, string[]> = {
	"tui.select.confirm": ["enter"],
	"tui.select.cancel": ["escape", "ctrl+c"],
	"tui.select.up": ["up"],
	"tui.select.down": ["down"],
};

const keybindings = {
	matches: (data: string, action: string) => defaultKeys[action]?.includes(data) ?? false,
	getKeys: (action: string) => defaultKeys[action] ?? [],
};

function createConfirmation(
	decisions: string[] = [],
	renderRequests: string[] = [],
	options: {
		terminalRows?: number;
		bindings?: typeof keybindings;
		workflow?: "save" | "exit";
		publicationAction?: "Create plan" | "Update plan";
	} = {},
) {
	return new PlanConfirmation({
		planPath: ".pi/plans/example.md",
		terminalRows: () => options.terminalRows ?? 20,
		theme,
		keybindings: options.bindings ?? keybindings,
		workflow: options.workflow,
		publicationAction: options.publicationAction,
		onDecision: (decision) => decisions.push(decision),
		onRender: () => renderRequests.push("render"),
	});
}

describe("PlanConfirmation", () => {
	it("defaults to continuing Plan mode", () => {
		const decisions: string[] = [];
		const confirmation = createConfirmation(decisions);

		confirmation.handleInput("enter");

		assert.deepEqual(decisions, ["continue"]);
	});

	it("offers preview without approving the plan", () => {
		const decisions: string[] = [];
		const renderRequests: string[] = [];
		const confirmation = createConfirmation(decisions, renderRequests);
		confirmation.render(80);

		confirmation.handleInput("down");
		confirmation.handleInput("enter");

		assert.deepEqual(decisions, ["preview"]);
		assert.equal(renderRequests.length, 1);
	});

	it("allows direct creation without preview", () => {
		const decisions: string[] = [];
		const confirmation = createConfirmation(decisions);
		confirmation.render(80);

		confirmation.handleInput("down");
		confirmation.handleInput("down");
		confirmation.handleInput("enter");

		assert.deepEqual(decisions, ["create"]);
	});

	it("cannot create before an actionable confirmation has rendered", () => {
		const decisions: string[] = [];
		const confirmation = createConfirmation(decisions);

		confirmation.handleInput("down");
		confirmation.handleInput("down");
		confirmation.handleInput("enter");

		assert.deepEqual(decisions, ["continue"]);
	});

	it("treats cancellation as continuing Plan mode", () => {
		const decisions: string[] = [];
		const confirmation = createConfirmation(decisions);

		confirmation.handleInput("escape");

		assert.deepEqual(decisions, ["continue"]);
	});

	it("renders all choices and the target in a compact component", () => {
		const lines = createConfirmation().render(80);
		const output = lines.join("\n");

		assert.ok(lines.length <= 8, `expected at most 8 lines, received ${lines.length}`);
		assert.match(output, /Target: \.pi\/plans\/example\.md/);
		assert.match(output, /Continue planning/);
		assert.match(output, /Preview the plan/);
		assert.match(output, /Create plan/);
		assert.doesNotMatch(output, /start implementation/i);
	});

	it("reserves a footer row and fails safely when the target and choices cannot fit", () => {
		const decisions: string[] = [];
		const confirmation = createConfirmation(decisions, [], { terminalRows: 4 });

		confirmation.handleInput("down");
		confirmation.handleInput("down");
		confirmation.handleInput("enter");
		const lines = confirmation.render(80);

		assert.equal(lines.length, 3);
		assert.match(lines.join("\n"), /too short/i);
		assert.deepEqual(decisions, ["continue"]);
	});

	it("shows the target and every action in the smallest actionable layout", () => {
		const lines = createConfirmation([], [], { terminalRows: 5 }).render(80);
		const output = lines.join("\n");

		assert.equal(lines.length, 4);
		assert.match(output, /Target: \.pi\/plans\/example\.md/);
		assert.match(output, /Continue planning/);
		assert.match(output, /Preview the plan/);
		assert.match(output, /Create plan/);
	});

	it("never renders past extremely narrow terminal widths", () => {
		const confirmation = createConfirmation();

		for (const width of [1, 2]) {
			const lines = confirmation.render(width);
			assert.ok(lines.length <= 8, `confirmation exceeded available rows at width ${width}`);
			assert.equal(
				lines.every((line) => visibleWidth(line) <= width),
				true,
				`confirmation exceeded width ${width}`,
			);
		}
	});

	it("uses Exit without publishing as the exit chooser's safe default", () => {
		for (const key of ["enter", "escape"]) {
			const decisions: string[] = [];
			const confirmation = createConfirmation(decisions, [], {
				workflow: "exit",
				publicationAction: "Update plan",
			});
			confirmation.render(80);

			confirmation.handleInput(key);

			assert.deepEqual(decisions, ["exit"]);
		}
		const output = createConfirmation([], [], {
			workflow: "exit",
			publicationAction: "Update plan",
		}).render(80).join("\n");
		assert.match(output, /Exit without publishing/);
		assert.match(output, /Update plan/);
		assert.match(output, /Preview/);
		assert.match(output, /Continue planning/);
	});

	it("describes configured selection keys instead of hard-coded defaults", () => {
		const configured = {
			matches: keybindings.matches,
			getKeys: (action: string) => ({
				"tui.select.confirm": ["return"],
				"tui.select.cancel": ["q"],
				"tui.select.up": ["k"],
				"tui.select.down": ["j"],
			}[action] ?? []),
		};

		const output = createConfirmation([], [], { bindings: configured }).render(80).join("\n");
		const tinyOutput = createConfirmation([], [], {
			bindings: configured,
			terminalRows: 3,
		}).render(20).join("\n");

		assert.match(output, /k\/j choose.*return select.*q continue/i);
		assert.match(tinyOutput, /Return\/q/i);
		assert.doesNotMatch(tinyOutput, /Enter or Esc/i);
	});
});
