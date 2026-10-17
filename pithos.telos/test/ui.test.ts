import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { TaskListComponent } from "../src/ui";
import type { Task } from "../src/tasks";

const theme = {
	fg: (_name: string, value: string) => value,
} as Theme;

const labeledTheme = {
	fg: (name: string, value: string) => `<${name}>${value}</${name}>`,
} as Theme;

const tasks: Task[] = [
	makeTask("TSK-11111111", "First task"),
	makeTask("TSK-22222222", "Second task", { dependencies: ["TSK-11111111", "TSK-33333333"], notes: "private implementation notes" }),
	makeTask("TSK-33333333", "Third task"),
];

describe("interactive task list", () => {
	it("slides a ten-row viewport one row at a time and reports full-list progress", () => {
		const many = Array.from({ length: 24 }, (_, i) => makeTask(`TSK-${i}`, `Task ${i}`, {
			status: i < 7 ? "done" : i < 9 ? "blocked" : "todo",
		}));
		const component = new TaskListComponent(many, theme, () => {});
		assert.equal(taskRows(component).length, 10);
		assert(component.render(120).join("\n").includes("7/24 done · 2 blocked"));
		assert(component.render(120).join("\n").includes("1–10 of 24"));
		for (let i = 1; i < 24; i++) {
			component.handleInput("\u001b[B");
			const start = Math.max(0, i - 9);
			assert.deepEqual(taskRows(component).map((row) => row.match(/TSK-\d+/)![0]), many.slice(start, start + 10).map((task) => task.id));
			assert(taskRows(component).find((row) => row.startsWith("›"))!.includes(`TSK-${i} `));
		}
		const bottom = component.render(120);
		component.handleInput("\u001b[B");
		assert.strictEqual(component.render(120), bottom);
		component.handleInput("\r");
		component.handleInput(" ");
		assert.deepEqual(component.render(120), bottom);
		for (let i = 22; i >= 0; i--) {
			component.handleInput("\u001b[A");
			assert(taskRows(component).find((row) => row.startsWith("›"))!.includes(`TSK-${i} `));
			assert(component.render(120).join("\n").includes(`${Math.min(i, 14) + 1}–${Math.min(i, 14) + 10} of 24`));
		}
	});

	it("replaces snapshots preserving ID, details and viewport, and clamps removed selection", () => {
		let renders = 0;
		const many = Array.from({ length: 12 }, (_, i) => makeTask(`TSK-${i}`, `Task ${i}`));
		const component = new TaskListComponent(many, theme, () => {}, () => renders++);
		for (let i = 0; i < 10; i++) component.handleInput("\u001b[B");
		const before = component.render(120);
		component.updateTasks(many.map((task) => ({ ...task, dependencies: [...task.dependencies] })));
		assert.equal(renders, 10);
		assert.strictEqual(component.render(120), before);
		component.handleInput("\r");
		const changed = many.map((task, i) => i === 10 ? { ...task, title: "Refreshed", notes: "New notes", dependencies: [many[0].id] } : i === 0 ? { ...task, title: "New dependency", status: "done" as const } : task);
		component.updateTasks(changed);
		assert(component.render(120).includes("  Refreshed"));
		assert(component.render(120).includes("  New notes"));
		assert(component.render(120).includes("  ■ TSK-0  ●○○  New dependency"));
		component.handleInput(" ");
		assert(component.render(120).join("\n").includes("2–11 of 12"));
		component.handleInput("\r");
		component.updateTasks([changed[10], ...changed.filter((_, i) => i !== 10)]);
		assert(component.render(120).includes("  Refreshed"));
		component.handleInput(" ");
		assert(taskRows(component)[0].startsWith("› □ TSK-10 "));
		component.handleInput("\r");
		component.updateTasks(changed.filter((_, i) => i !== 10));
		assert(taskRows(component)[0].startsWith("› ■ TSK-0 "));
		assert(component.render(120).join("\n").includes("1–10 of 11"));
		for (let i = 0; i < 10; i++) component.handleInput("\u001b[B");
		component.handleInput("\r");
		component.updateTasks(many.slice(0, 10));
		assert.equal(taskRows(component).length, 10);
		assert(taskRows(component)[9].startsWith("› □ TSK-9 "));
		assert(!component.render(120).join("\n").includes("of 10"));
		component.updateTasks([]);
		assert.equal(taskRows(component).length, 0);
		assert(component.render(120).join("\n").includes("0/0 done · 0 blocked"));
		assert(!component.render(120).join("\n").includes("1–0"));
		component.handleInput("\r");
		component.handleInput("\u001b[B");
		component.updateTasks([many[0]]);
		assert(taskRows(component)[0].startsWith("›"));
	});

	it("renders independent warning recovery and ephemeral notice in list and details", () => {
		let renders = 0;
		const component = new TaskListComponent(tasks, theme, () => {}, () => renders++, { ephemeral: true });
		const notice = "Ephemeral session · tasks are lost on exit";
		assert(component.render(120).join("\n").includes(notice));
		component.setWarnings({ task: "Task read failed", config: "Config read failed" });
		assert.equal(renders, 1);
		for (const text of [notice, "Task read failed", "Config read failed"]) assert(component.render(120).join("\n").includes(text));
		const cached = component.render(120);
		component.setWarnings({ config: "Config read failed", task: "Task read failed" });
		assert.equal(renders, 1);
		assert.strictEqual(component.render(120), cached);
		component.handleInput("\r");
		for (const text of [notice, "Task read failed", "Config read failed"]) assert(component.render(120).join("\n").includes(text));
		component.setWarnings({ config: "Config read failed" });
		assert(!component.render(120).join("\n").includes("Task read failed"));
		assert(component.render(120).join("\n").includes("Config read failed"));
		component.setWarnings({ task: "Task read failed" });
		assert(!component.render(120).join("\n").includes("Config read failed"));
		assert(component.render(120).join("\n").includes("Task read failed"));
		component.setWarnings({});
		assert(!component.render(120).join("\n").includes("read failed"));
		assert(component.render(120).join("\n").includes(notice));
		const persistent = new TaskListComponent(tasks, theme, () => {});
		assert(!persistent.render(120).join("\n").includes(notice));
	});

	it("disposes once before every close shortcut and ignores late input and updates", () => {
		for (const closeKey of ["\u001b", "\u0003", "q"]) {
			const events: string[] = [];
			const component = new TaskListComponent(tasks, theme, () => events.push("close"), () => events.push("render"), { onDispose: () => events.push("dispose") });
			const before = component.render(120);
			component.handleInput(closeKey);
			assert.deepEqual(events, ["dispose", "close"]);
			component.dispose();
			component.updateTasks([]);
			component.setWarnings({ task: "Late error" });
			for (const key of ["\u001b[B", "\r", " ", "q"]) component.handleInput(key);
			assert.deepEqual(events, ["dispose", "close"]);
			assert.strictEqual(component.render(120), before);
		}
		const events: string[] = [];
		const component = new TaskListComponent(tasks, theme, () => events.push("close"), () => events.push("render"), { onDispose: () => events.push("dispose") });
		component.dispose();
		component.dispose();
		component.handleInput("q");
		assert.deepEqual(events, ["dispose"]);
	});

	it("fits narrow widths in both modes and invalidates cached output", () => {
		const component = new TaskListComponent([makeTask("TSK-wide", "界 title", { notes: "界 wide description with enough words to wrap" })], theme, () => {}, () => {}, { ephemeral: true });
		component.setWarnings({ task: "A long warning", config: "Configuration warning" });
		for (const key of ["", "\r"]) {
			if (key) component.handleInput(key);
			for (const width of [120, 38, 8, 2, 1, 0]) {
				const lines = component.render(width);
				assert(lines.every((line) => visibleWidth(line) <= width), `overflow at width ${width}`);
				assert.strictEqual(component.render(width), lines);
				component.invalidate();
				assert.notStrictEqual(component.render(width), lines);
				assert.deepEqual(component.render(width), lines);
			}
		}
	});

	it("points at the selected task with a chevron", () => {
		const component = new TaskListComponent(tasks, theme, () => {});

		assert.deepEqual(taskRows(component), [
			"› □ TSK-11111111 ●○○ First task",
			"  □ TSK-22222222 ●○○ Second task  ◂2",
			"  □ TSK-33333333 ●○○ Third task",
		]);
	});

	it("moves the chevron with up and down keys", () => {
		let renderRequests = 0;
		const component = new TaskListComponent(tasks, theme, () => {}, () => renderRequests++);

		component.handleInput("\u001b[B");
		assert.deepEqual(taskRows(component), [
			"  □ TSK-11111111 ●○○ First task",
			"› □ TSK-22222222 ●○○ Second task  ◂2",
			"  □ TSK-33333333 ●○○ Third task",
		]);

		component.handleInput("\u001b[A");
		assert.deepEqual(taskRows(component), [
			"› □ TSK-11111111 ●○○ First task",
			"  □ TSK-22222222 ●○○ Second task  ◂2",
			"  □ TSK-33333333 ●○○ Third task",
		]);
		assert.equal(renderRequests, 2);
	});

	it("does not move beyond the first or last task", () => {
		let renderRequests = 0;
		const component = new TaskListComponent(tasks, theme, () => {}, () => renderRequests++);

		component.handleInput("\u001b[A");
		component.handleInput("\u001b[B");
		component.handleInput("\u001b[B");
		component.handleInput("\u001b[B");

		assert.deepEqual(taskRows(component), [
			"  □ TSK-11111111 ●○○ First task",
			"  □ TSK-22222222 ●○○ Second task  ◂2",
			"› □ TSK-33333333 ●○○ Third task",
		]);
		assert.equal(renderRequests, 2);
	});

	it("opens the selected task details with enter", () => {
		let renderRequests = 0;
		const component = new TaskListComponent(tasks, theme, () => {}, () => renderRequests++);

		component.handleInput("\u001b[B");
		component.handleInput("\r");

		const lines = component.render(120);
		assert.equal(lines[1], `${"─".repeat(3)} TSK-22222222 ${"─".repeat(103)}`);
		assert(lines.includes("  Second task"));
		assert(lines.includes("  □ todo · ●○○ medium"));
		assert(lines.includes("  Description"));
		assert(lines.includes("  private implementation notes"));
		assert(lines.includes("  Dependencies"));
		assert(lines.includes("  □ TSK-11111111  ●○○  First task"));
		assert(lines.includes("  □ TSK-33333333  ●○○  Third task"));
		assert(lines.includes("  Created  2026-06-04 00:00 UTC"));
		assert(lines.includes("  Updated  2026-06-04 00:00 UTC"));
		assert.equal(lines.some((line) => line.includes("Metadata")), false);
		assert.equal(lines.some((line) => line.includes("First task") && line.startsWith("  □") && !line.includes("TSK-11111111")), false);
		assert.equal(renderRequests, 2);
	});

	it("omits empty description and dependency sections in details", () => {
		const component = new TaskListComponent(tasks, theme, () => {});

		component.handleInput("\r");

		const lines = component.render(120);
		assert.equal(lines[1], `${"─".repeat(3)} TSK-11111111 ${"─".repeat(103)}`);
		assert.equal(lines.some((line) => line.includes("Description")), false);
		assert.equal(lines.some((line) => line.includes("Dependencies")), false);
	});

	it("colors detail labels as muted", () => {
		const component = new TaskListComponent([tasks[1]], labeledTheme, () => {});

		component.handleInput("\r");

		const lines = component.render(160);
		assert(lines.includes("  <muted>Description</muted>"));
		assert(lines.includes("  <muted>Dependencies</muted>"));
		assert(lines.includes("  <muted>Created</muted>  2026-06-04 00:00 UTC"));
		assert(lines.includes("  <muted>Updated</muted>  2026-06-04 00:00 UTC"));
	});

	it("wraps long descriptions without truncating them", () => {
		const description = "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";
		const component = new TaskListComponent([makeTask("TSK-44444444", "Long task", { notes: description })], theme, () => {});

		component.handleInput("\r");

		const descriptionLines = sectionLines(component.render(38), "  Description");
		assert(descriptionLines.length > 1);
		assert.equal(descriptionLines.some((line) => line.includes("…")), false);
		assert.equal(descriptionLines.map((line) => line.trim()).join(" "), description);
	});

	it("returns from task details to the list with space", () => {
		const component = new TaskListComponent(tasks, theme, () => {});

		component.handleInput("\r");
		component.handleInput(" ");

		assert.deepEqual(taskRows(component), [
			"› □ TSK-11111111 ●○○ First task",
			"  □ TSK-22222222 ●○○ Second task  ◂2",
			"  □ TSK-33333333 ●○○ Third task",
		]);
	});
});

function taskRows(component: TaskListComponent): string[] {
	return component.render(120).filter((line) => line.includes("TSK-"));
}

function sectionLines(lines: string[], heading: string): string[] {
	const start = lines.indexOf(heading);
	assert.notEqual(start, -1);

	const result: string[] = [];
	for (let index = start + 1; index < lines.length; index++) {
		if (lines[index] === "") break;
		result.push(lines[index]);
	}
	return result;
}

function makeTask(id: string, title: string, overrides: Partial<Task> = {}): Task {
	return {
		id,
		title,
		status: "todo",
		priority: "medium",
		notes: "",
		dependencies: [],
		created: "2026-06-04T00:00:00.000Z",
		updated: "2026-06-04T00:00:00.000Z",
		...overrides,
	};
}
