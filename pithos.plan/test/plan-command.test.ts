import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLAN_COMMAND_HELP, parsePlanCommand } from "../extensions/plan-command.ts";

describe("parsePlanCommand", () => {
	it("accepts only the explicit Plan lifecycle grammar", () => {
		assert.deepEqual(parsePlanCommand("/plan"), { kind: "enter" });
		assert.deepEqual(parsePlanCommand(" /plan save "), { kind: "save" });
		assert.deepEqual(parsePlanCommand("/plan preview"), { kind: "preview" });
		assert.deepEqual(parsePlanCommand("/plan exit"), { kind: "exit" });
		assert.deepEqual(parsePlanCommand("/plan status"), { kind: "status" });
		for (const argument of ["help", "--help", "-h"]) {
			assert.deepEqual(parsePlanCommand(`/plan ${argument}`), { kind: "help" });
		}
	});

	it("rejects task text, bare-finalization aliases, and unknown subcommands with help", () => {
		for (const input of [
			"/plan implement auth",
			"/plan cancel",
			"/plan pause",
			"/plan save later",
			"/plan unknown",
		]) {
			assert.deepEqual(parsePlanCommand(input), {
				kind: "unknown",
				argument: input.slice("/plan".length).trim(),
			});
		}
		assert.match(PLAN_COMMAND_HELP, /\/plan \{save\|preview\|exit\|status\|help\}/);
		assert.match(PLAN_COMMAND_HELP, /Task and refinement text.*normal prompts/i);
	});

	it("ignores text that is not the Plan command", () => {
		assert.equal(parsePlanCommand("/planner"), undefined);
		assert.equal(parsePlanCommand("normal prompt"), undefined);
		assert.equal(parsePlanCommand("/skill:plan"), undefined);
	});
});
