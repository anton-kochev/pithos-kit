import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTasksCommand } from "../src/commands";

describe("/tasks command parser", () => {
	it("returns package-local help for --help and -h", () => {
		for (const alias of ["--help", "-h"]) {
			const parsed = parseTasksCommand(alias);
			assert.equal(parsed.type, "help");
			if (parsed.type !== "help") continue;
			assert.match(parsed.text, /Usage: \/tasks/);
			assert.match(parsed.text, /--help, -h/);
		}
	});

	it("parses create with options and quoted title", () => {
		assert.deepEqual(parseTasksCommand('create --priority high --notes "Needs care" --depends TSK-abc123ef,TSK-fed456ba "Build Telos"'), {
			type: "operation",
			operation: {
				action: "create",
				title: "Build Telos",
				priority: "high",
				notes: "Needs care",
				dependencies: ["TSK-abc123ef", "TSK-fed456ba"],
			},
		});
	});

	it("parses confirmed cleanup without accepting force or extra arguments", () => {
		assert.deepEqual(parseTasksCommand("cleanup"), { type: "cleanup" });
		for (const input of ["cleanup --force", "cleanup extra"]) {
			assert.equal(parseTasksCommand(input).type, "error");
		}
		assert.equal(parseTasksCommand("cleanup --help").type, "help");
	});

	it("parses list scopes", () => {
		assert.deepEqual(parseTasksCommand("list --archived"), {
			type: "operation",
			operation: { action: "list", scope: "archived" },
		});
		assert.deepEqual(parseTasksCommand("list --all"), {
			type: "operation",
			operation: { action: "list", scope: "all" },
		});
	});

	it("parses lifecycle shortcuts", () => {
		assert.deepEqual(parseTasksCommand("complete TSK-abc123ef"), {
			type: "operation",
			operation: { action: "complete", id: "TSK-abc123ef" },
		});
	});

	it("reports invalid command arguments", () => {
		const parsed = parseTasksCommand("update TSK-abc123ef --unknown value");
		assert.equal(parsed.type, "error");
		assert.match(parsed.message, /Unknown/);
	});
});
