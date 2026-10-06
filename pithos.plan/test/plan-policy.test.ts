import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isTrustedPlanReadTool, selectPlanModeTools } from "../extensions/plan-policy.ts";

function builtin(name: string) {
	return { name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } };
}

describe("selectPlanModeTools", () => {
	// Regression checklist: current and legacy built-in paths stay available;
	// execution uses the same trust rule; overrides and malformed paths stay blocked.
	it("preserves read-only built-ins with Pi's current builtin:name source paths", () => {
		const tools = ["read", "grep", "find", "ls", "write", "edit", "bash"].map((name) => ({
			name,
			sourceInfo: { source: "builtin", path: `builtin:${name}` },
		}));
		assert.deepEqual(selectPlanModeTools(tools, "/extensions/plan-theme.ts"), [
			"read", "grep", "find", "ls",
		]);
	});

	it("exposes only trusted read tools and the controlled plan writer", () => {
		const selected = selectPlanModeTools([
			builtin("read"),
			builtin("grep"),
			builtin("find"),
			builtin("ls"),
			builtin("write"),
			builtin("edit"),
			builtin("bash"),
			{ name: "update_plan_draft", sourceInfo: { source: "package", path: "/extensions/plan-theme.ts" } },
			{ name: "create_plan", sourceInfo: { source: "package", path: "/extensions/plan-theme.ts" } },
			{ name: "guild_handover", sourceInfo: { source: "package", path: "/extensions/guild.ts" } },
		], "/extensions/plan-theme.ts");

		assert.deepEqual(selected, ["read", "grep", "find", "ls", "update_plan_draft", "create_plan"]);
	});

	for (const path of ["<builtin:read>", "builtin:read"]) {
		it(`rejects custom overrides even when they claim the ${path} path`, () => {
			for (const source of ["sdk", "package", "builtin"]) {
				const tool = { name: "read", sourceInfo: { source, path } };
				// Only Pi's built-in source can authorize a synthetic built-in path.
				assert.equal(isTrustedPlanReadTool([tool], "read"), source === "builtin");
				const override = { name: "read", sourceInfo: { source: "package", path: "/override.ts" } };
				assert.equal(isTrustedPlanReadTool([tool, override], "read"), false);
				assert.deepEqual(selectPlanModeTools([tool, override], "/extensions/plan-theme.ts"), []);
			}
		});
	}

	it("rejects mismatched or malformed built-in paths for local read tools", () => {
		for (const path of ["builtin:write", "<builtin:write>", "builtin:read/extra", "<builtin:read", "/builtin:read"]) {
			const tool = { name: "read", sourceInfo: { source: "builtin", path } };
			assert.equal(isTrustedPlanReadTool([tool], "read"), false, path);
			assert.deepEqual(selectPlanModeTools([tool], "/extensions/plan-theme.ts"), [], path);
		}
	});

	it("fails closed when a trusted built-in or internal tool name has a duplicate override", () => {
		const selected = selectPlanModeTools([
			builtin("read"),
			{ name: "read", sourceInfo: { source: "package", path: "/untrusted/read.ts" } },
			{ name: "update_plan_draft", sourceInfo: { source: "package", path: "/extensions/plan-theme.ts" } },
			{ name: "update_plan_draft", sourceInfo: { source: "package", path: "/untrusted/checkpoint.ts" } },
			{ name: "create_plan", sourceInfo: { source: "package", path: "/extensions/plan-theme.ts" } },
			{ name: "create_plan", sourceInfo: { source: "package", path: "/untrusted/create.ts" } },
		], "/extensions/plan-theme.ts");

		assert.deepEqual(selected, []);
	});

	it("admits only Web tools rooted in the canonical @pithos-kit/web package", () => {
		const parent = mkdtempSync(join(tmpdir(), "plan-web-policy-"));
		const packageRoot = join(parent, "pithos.web");
		const extensions = join(packageRoot, "extensions");
		mkdirSync(extensions, { recursive: true });
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
			name: "@pithos-kit/web",
			pi: { extensions: ["./extensions"] },
		}));
		const extensionPath = join(extensions, "index.ts");
		writeFileSync(extensionPath, "export default () => {};\n");
		try {
			const localWebSearch = {
				name: "web_search",
				sourceInfo: {
					source: "../pithos.web",
					path: extensionPath,
					scope: "project",
					origin: "package",
					baseDir: packageRoot,
				},
			};
			const npmWebFetch = {
				name: "web_fetch",
				sourceInfo: {
					source: "npm:@pithos-kit/web@0.1.0",
					path: extensionPath,
					scope: "user",
					origin: "package",
					baseDir: packageRoot,
				},
			};
			assert.deepEqual(
				selectPlanModeTools([builtin("read"), localWebSearch, npmWebFetch], "/extensions/plan-theme.ts"),
				["read", "web_search", "web_fetch"],
			);

			assert.deepEqual(selectPlanModeTools([
				{
					...localWebSearch,
					sourceInfo: { ...localWebSearch.sourceInfo, source: "npm:@evil/spoof" },
				},
				{ name: "web_fetch", sourceInfo: { source: "sdk", path: "<sdk:web_fetch>" } },
			], "/extensions/plan-theme.ts"), []);

			const outsidePath = join(parent, "outside.ts");
			writeFileSync(outsidePath, "export default () => {};\n");
			assert.deepEqual(selectPlanModeTools([{
				...localWebSearch,
				sourceInfo: { ...localWebSearch.sourceInfo, path: outsidePath },
			}], "/extensions/plan-theme.ts"), []);

			writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
				name: "@evil/spoof",
				pi: { extensions: ["./extensions"] },
			}));
			assert.deepEqual(selectPlanModeTools([localWebSearch], "/extensions/plan-theme.ts"), []);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});
});
